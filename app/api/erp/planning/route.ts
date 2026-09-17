import { randomUUID } from "node:crypto";
import { Prisma } from "@/generated/tenant/client";
import { currentOrganization, tenantDb } from "@/db";
import { AuthError, authErrorResponse } from "@/lib/auth";
import { LicenseDeniedError } from "@/lib/billing/license";
import { assertSameOrigin, CustomerInputError } from "@/lib/erp/customer-input";
import { date, entityId, integer, optional, record, text } from "@/lib/erp/financial-operations-input";
import { allowedBudgetTransition, categoryKey, DRE_GROUPS, goalAchieved, goalProgress,
  parsePlanningQuery, PlanningControlError, planningCsv, planningSummary, suggestedDreGroup,
  type DreGroup, type PlanningMonth } from "@/lib/erp/planning-control";
import { assertTenantPermission } from "@/lib/erp/permissions";
import { PosHttpError, readPosJson } from "@/lib/erp/pos-http";
import { assertTenantWriteAccess } from "@/lib/tenant-access";

type Db = Awaited<ReturnType<typeof tenantDb>>;
type Tx = Prisma.TransactionClient;
const noStore = { "cache-control": "private, no-store, max-age=0", expires: "0", pragma: "no-cache" };
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  try {
    const organization = await currentOrganization();
    await assertTenantPermission(organization.id, "planning.read");
    const query = parsePlanningQuery(new URL(request.url).searchParams);
    const db = await tenantDb(organization.id);
    const start = new Date(Date.UTC(query.year, 0, 1)), end = new Date(Date.UTC(query.year + 1, 0, 1));
    const titleWhere: Prisma.FinancialTitleWhereInput = {
      status: { not: "cancelled" },
      ...(query.branchId ? { branchId: query.branchId } : {}),
      ...(query.costCenterId ? { costCenterId: query.costCenterId } : {}),
      ...(query.basis === "accrual" ? { OR: [
        { competenceAt: { gte: start, lt: end } }, { competenceAt: null, issueAt: { gte: start, lt: end } },
      ] } : { settlements: { some: { status: "posted", occurredAt: { gte: start, lt: end } } } }),
    };
    const [sales, titles, centers, budgets, goals, rules, branches] = await Promise.all([
      query.basis === "accrual" ? db.sale.findMany({
        where: { status: "completed", createdAt: { gte: start, lt: end }, ...(query.branchId ? { branchId: query.branchId } : {}),
          ...(query.costCenterId ? { costCenterId: query.costCenterId } : {}) },
        select: { id: true, saleNumber: true, totalCents: true, createdAt: true,
          branch: { select: { name: true } }, costCenter: { select: { name: true } },
          items: { select: { quantity: true, returnedQuantity: true,
            product: { select: { cost: true } } } } }, orderBy: { createdAt: "asc" },
      }) : [],
      db.financialTitle.findMany({ where: titleWhere, select: {
        id: true, type: true, description: true, amount: true, category: true, issueAt: true, competenceAt: true,
        branch: { select: { name: true } }, costCenter: { select: { name: true } },
        settlements: { where: { status: "posted", occurredAt: { gte: start, lt: end } },
          select: { id: true, amount: true, interest: true, discount: true, fee: true, occurredAt: true } },
      }, orderBy: [{ competenceAt: "asc" }, { issueAt: "asc" }] }),
      db.costCenter.findMany({ orderBy: [{ active: "desc" }, { name: "asc" }] }),
      db.budget.findMany({ where: { year: query.year, ...(query.budgetId ? { id: query.budgetId } : { scenario: query.scenario }) },
        include: { lines: { include: { costCenter: true }, orderBy: [{ costCenterId: "asc" }, { month: "asc" }] } },
        orderBy: [{ status: "asc" }, { updatedAt: "desc" }] }),
      db.businessGoal.findMany({ where: { startedAt: { lt: end }, dueAt: { gte: start } },
        include: { updates: { orderBy: { createdAt: "desc" }, take: 8 } }, orderBy: [{ status: "asc" }, { dueAt: "asc" }] }),
      db.dreCategoryRule.findMany({ where: { active: true }, orderBy: { categoryLabel: "asc" } }),
      db.branch.findMany({ where: { status: "active" }, select: { id: true, code: true, name: true },
        orderBy: [{ primary: "desc" }, { name: "asc" }] }),
    ]);
    const activeBudget = budgets.find((item) => item.status === "active") || budgets.find((item) => item.status === "approved") || budgets[0] || null;
    const ruleMap = new Map(rules.map((rule) => [rule.categoryKey, rule.dreGroup as DreGroup]));
    const months: PlanningMonth[] = Array.from({ length: 12 }, (_, index) => ({ month: index + 1,
      revenueCents: 0, deductionsCents: 0, cogsCents: 0, operatingExpenseCents: 0,
      financialResultCents: 0, incomeTaxCents: 0, resultCents: 0, budgetRevenueCents: 0,
      budgetCogsCents: 0, budgetExpenseCents: 0, budgetResultCents: 0 }));
    const details: Array<{ id: string; date: Date; description: string; source: string; group: DreGroup;
      amountCents: number; category: string; branch: string | null; costCenter: string | null }> = [];
    for (const sale of sales) {
      const month = months[sale.createdAt.getUTCMonth()];
      const cogsCents = Math.max(0, Math.round(sale.items.reduce((sum, item) =>
        sum + Math.max(0, item.quantity - item.returnedQuantity) * item.product.cost, 0) * 100));
      month.revenueCents += sale.totalCents; month.cogsCents += cogsCents;
      details.push({ id: `sale-${sale.id}`, date: sale.createdAt, description: `Venda ${sale.saleNumber}`,
        source: "Venda", group: "revenue", amountCents: sale.totalCents, category: "Vendas",
        branch: sale.branch?.name || null, costCenter: sale.costCenter?.name || null });
      if (cogsCents) details.push({ id: `sale-cogs-${sale.id}`, date: sale.createdAt,
        description: `CMV da venda ${sale.saleNumber}`, source: "Custo de produto", group: "cogs",
        amountCents: -cogsCents, category: "CMV", branch: sale.branch?.name || null,
        costCenter: sale.costCenter?.name || null });
    }
    const categoryStats = new Map<string, { key: string; label: string; group: DreGroup;
      inferred: boolean; amountCents: number; count: number }>();
    for (const title of titles) {
      const key = categoryKey(title.category), group = ruleMap.get(key) || suggestedDreGroup(title.category, title.type),
        inferred = !ruleMap.has(key), category = title.category || "Sem categoria";
      const values = query.basis === "cash" ? title.settlements.map((settlement) => ({ date: settlement.occurredAt,
        cents: Math.round((settlement.amount + settlement.interest - settlement.discount +
          (title.type === "receivable" ? -settlement.fee : settlement.fee)) * 100) }))
        : [{ date: title.competenceAt || title.issueAt, cents: Math.round(title.amount * 100) }];
      for (const value of values) {
        const month = months[value.date.getUTCMonth()]; applyActual(month, group, value.cents, title.type);
        const signed = group === "revenue" && title.type === "receivable" ? value.cents : -value.cents;
        details.push({ id: `title-${title.id}-${value.date.toISOString()}`, date: value.date, description: title.description,
          source: query.basis === "cash" ? "Liquidação" : "Título financeiro", group, amountCents: signed,
          category, branch: title.branch?.name || null, costCenter: title.costCenter?.name || null });
        const stat = categoryStats.get(key) || { key, label: category, group, inferred, amountCents: 0, count: 0 };
        stat.amountCents += value.cents; stat.count += 1; categoryStats.set(key, stat);
      }
    }
    if (activeBudget) for (const line of activeBudget.lines) {
      if (query.costCenterId && line.costCenterId !== query.costCenterId) continue;
      const month = months[line.month - 1]; month.budgetRevenueCents += line.revenueCents;
      month.budgetCogsCents += line.cogsCents; month.budgetExpenseCents += line.expenseCents;
    }
    for (const month of months) {
      month.resultCents = month.revenueCents - month.deductionsCents - month.cogsCents - month.operatingExpenseCents - month.financialResultCents - month.incomeTaxCents;
      month.budgetResultCents = month.budgetRevenueCents - month.budgetCogsCents - month.budgetExpenseCents;
    }
    if (query.format === "csv") return new Response(`\uFEFF${planningCsv(months, query.year)}`, { headers: { ...noStore,
      "content-type": "text/csv; charset=utf-8", "content-disposition": `attachment; filename="dre-orcado-realizado-${query.year}.csv"` } });
    const categories = [...categoryStats.values()].sort((left, right) => right.amountCents - left.amountCents);
    return Response.json({ generatedAt: new Date(), filters: query, months, summary: planningSummary(months, query.year),
      activeBudgetId: activeBudget?.id || null, budgets, centers, branches, categories, rules,
      goals: goals.map((goal) => ({ ...goal, progress: goalProgress(goal), achieved: goalAchieved(goal),
        overdue: goal.status === "active" && goal.dueAt < new Date() })),
      details: details.sort((left, right) => right.date.valueOf() - left.date.valueOf()).slice(0, 250),
      dataQuality: { inferredCategories: categories.filter((item) => item.inferred).length,
        uncategorizedEntries: categories.find((item) => item.key === "sem_categoria")?.count || 0,
        salesWithoutCostCenter: sales.filter((sale) => !sale.costCenter).length,
        budgetMonthCoverage: activeBudget ? new Set(activeBudget.lines.filter((line) => line.revenueCents || line.cogsCents || line.expenseCents).map((line) => line.month)).size : 0,
        budgetCenterCoverage: activeBudget ? new Set(activeBudget.lines.map((line) => line.costCenterId)).size : 0,
        activeCenters: centers.filter((center) => center.active).length },
    }, { headers: noStore });
  } catch (error) { return failure(error); }
}

export async function POST(request: Request) {
  try {
    assertSameOrigin(request);
    const organization = await currentOrganization();
    const access = await assertTenantPermission(organization.id, "planning.write");
    await assertTenantWriteAccess(organization.id);
    const body = record(await readPosJson(request, 262_144)), action = String(body.action || "");
    const db = await tenantDb(organization.id), correlationId = randomUUID();
    if (action === "center.create") {
      const name = text(body.name, "Nome", 100), code = normalizedCode(body.code || name);
      const center = await db.costCenter.create({ data: { name, code }, select: centerSelect });
      await audit(db, access.user.id, "cost_center.created", "cost_center", center.id, correlationId, null, center);
      return Response.json({ center, correlationId }, { status: 201, headers: noStore });
    }
    if (action === "center.update") {
      const id = entityId(body.id), name = text(body.name, "Nome", 100), code = normalizedCode(body.code || name);
      const before = await db.costCenter.findUnique({ where: { id }, select: centerSelect });
      if (!before) throw new PlanningControlError("Centro de custo não encontrado.", 404);
      const center = await db.costCenter.update({ where: { id }, data: { name, code, active: booleanValue(body.active) }, select: centerSelect });
      await audit(db, access.user.id, "cost_center.updated", "cost_center", id, correlationId, before, center);
      return Response.json({ center, correlationId }, { headers: noStore });
    }
    if (action === "budget.create") {
      const input = budgetInput(body); await assertCenters(db, input.lines.map((line) => line.costCenterId));
      const budget = await db.budget.create({ data: { name: input.name, year: input.year, scenario: input.scenario,
        notes: input.notes, createdBy: access.user.name, lines: { create: input.lines.map(lineData) } }, include: { lines: true } });
      await audit(db, access.user.id, "budget.created", "budget", budget.id, correlationId, null,
        { name: budget.name, year: budget.year, scenario: budget.scenario, lines: budget.lines.length });
      return Response.json({ budget, correlationId }, { status: 201, headers: noStore });
    }
    if (action === "budget.lines") {
      const id = entityId(body.id), rows = budgetLines(body.lines); await assertCenters(db, rows.map((line) => line.costCenterId));
      const budget = await db.$transaction(async (tx) => {
        await tx.$queryRaw(Prisma.sql`SELECT "id" FROM "budgets" WHERE "id"=${id} FOR UPDATE`);
        const before = await tx.budget.findUnique({ where: { id }, include: { lines: true } });
        if (!before) throw new PlanningControlError("Orçamento não encontrado.", 404);
        if (before.status !== "draft") throw new PlanningControlError("Somente orçamentos em rascunho podem ser alterados.", 409);
        for (const line of rows) await tx.budgetLine.upsert({ where: { budgetId_costCenterId_month: { budgetId: id,
          costCenterId: line.costCenterId, month: line.month } }, update: lineData(line), create: { budgetId: id, ...lineData(line) } });
        const updated = await tx.budget.update({ where: { id }, data: { version: { increment: 1 } }, include: { lines: true } });
        await audit(tx, access.user.id, "budget.lines_updated", "budget", id, correlationId,
          { version: before.version, lineCount: before.lines.length }, { version: updated.version, changedLines: rows.length });
        return updated;
      }, { isolationLevel: "Serializable" });
      return Response.json({ budget, correlationId }, { headers: noStore });
    }
    if (action === "budget.status") {
      const id = entityId(body.id), target = oneOf(body.status, ["draft", "approved", "active", "archived"]);
      const budget = await db.$transaction(async (tx) => {
        await tx.$queryRaw(Prisma.sql`SELECT "id" FROM "budgets" WHERE "id"=${id} FOR UPDATE`);
        const before = await tx.budget.findUnique({ where: { id }, include: { lines: true } });
        if (!before) throw new PlanningControlError("Orçamento não encontrado.", 404);
        if (!allowedBudgetTransition(before.status, target)) throw new PlanningControlError("Transição de orçamento não permitida.", 409);
        if (["approved", "active"].includes(target) && !before.lines.some((line) => line.revenueCents || line.cogsCents || line.expenseCents))
          throw new PlanningControlError("Preencha ao menos uma competência antes de aprovar.");
        if (target === "active") await tx.budget.updateMany({ where: { id: { not: id }, year: before.year,
          scenario: before.scenario, status: "active" }, data: { status: "archived", lockedAt: new Date() } });
        const updated = await tx.budget.update({ where: { id }, data: { status: target,
          approvedAt: target === "approved" || target === "active" ? before.approvedAt || new Date() : target === "draft" ? null : before.approvedAt,
          approvedBy: target === "approved" || target === "active" ? before.approvedBy || access.user.name : target === "draft" ? null : before.approvedBy,
          lockedAt: target === "active" || target === "archived" ? new Date() : null, version: { increment: 1 } } });
        await audit(tx, access.user.id, "budget.status_changed", "budget", id, correlationId,
          { status: before.status, version: before.version }, { status: updated.status, version: updated.version });
        return updated;
      }, { isolationLevel: "Serializable" });
      return Response.json({ budget, correlationId }, { headers: noStore });
    }
    if (action === "budget.clone") {
      const id = entityId(body.id), source = await db.budget.findUnique({ where: { id }, include: { lines: true } });
      if (!source) throw new PlanningControlError("Orçamento não encontrado.", 404);
      const name = text(body.name, "Nome", 120), year = integer(body.year, 2020, 2100),
        scenario = oneOf(body.scenario, ["base", "optimistic", "conservative"]);
      const budget = await db.budget.create({ data: { name, year, scenario, notes: optional(body.notes, 1000) || source.notes,
        createdBy: access.user.name, lines: { create: source.lines.map((line) => ({ costCenterId: line.costCenterId,
          month: line.month, revenueCents: line.revenueCents, cogsCents: line.cogsCents,
          expenseCents: line.expenseCents, revenue: line.revenueCents / 100, expense: line.expenseCents / 100, notes: line.notes })) } }, include: { lines: true } });
      await audit(db, access.user.id, "budget.cloned", "budget", budget.id, correlationId, null, { sourceId: id, name, year, scenario });
      return Response.json({ budget, correlationId }, { status: 201, headers: noStore });
    }
    if (action === "goal.create") {
      const input = goalInput(body);
      const goal = await db.businessGoal.create({ data: { ...input, createdBy: access.user.name,
        updates: { create: { value: input.current, note: "Valor inicial", createdBy: access.user.name } } }, include: { updates: true } });
      await audit(db, access.user.id, "business_goal.created", "business_goal", goal.id, correlationId, null,
        { title: goal.title, metric: goal.metric, target: goal.target, owner: goal.owner });
      return Response.json({ goal, correlationId }, { status: 201, headers: noStore });
    }
    if (action === "goal.progress") {
      const id = entityId(body.id), value = nonnegative(body.value, "Realizado"), note = optional(body.note, 500);
      const goal = await db.$transaction(async (tx) => {
        await tx.$queryRaw(Prisma.sql`SELECT "id" FROM "business_goals" WHERE "id"=${id} FOR UPDATE`);
        const before = await tx.businessGoal.findUnique({ where: { id } });
        if (!before) throw new PlanningControlError("Meta não encontrada.", 404);
        if (["cancelled", "achieved"].includes(before.status)) throw new PlanningControlError("Esta meta está encerrada.", 409);
        const achieved = goalAchieved({ ...before, current: value });
        await tx.businessGoalUpdate.create({ data: { goalId: id, value, note, createdBy: access.user.name } });
        const updated = await tx.businessGoal.update({ where: { id }, data: { current: value,
          status: achieved ? "achieved" : "active", completedAt: achieved ? new Date() : null },
          include: { updates: { orderBy: { createdAt: "desc" }, take: 8 } } });
        await audit(tx, access.user.id, "business_goal.progressed", "business_goal", id, correlationId,
          { current: before.current, status: before.status }, { current: value, status: updated.status, note });
        return updated;
      }, { isolationLevel: "Serializable" });
      return Response.json({ goal, correlationId }, { headers: noStore });
    }
    if (action === "goal.status") {
      const id = entityId(body.id), status = oneOf(body.status, ["active", "paused", "cancelled"]);
      const before = await db.businessGoal.findUnique({ where: { id } });
      if (!before) throw new PlanningControlError("Meta não encontrada.", 404);
      const goal = await db.businessGoal.update({ where: { id }, data: { status, completedAt: null } });
      await audit(db, access.user.id, "business_goal.status_changed", "business_goal", id, correlationId, { status: before.status }, { status });
      return Response.json({ goal, correlationId }, { headers: noStore });
    }
    if (action === "rule.upsert") {
      const categoryLabel = text(body.categoryLabel, "Categoria", 120), key = categoryKey(categoryLabel),
        dreGroup = oneOf(body.dreGroup, [...DRE_GROUPS]);
      const rule = await db.dreCategoryRule.upsert({ where: { categoryKey: key }, update: { categoryLabel, dreGroup, active: true },
        create: { categoryKey: key, categoryLabel, dreGroup, createdBy: access.user.name } });
      await audit(db, access.user.id, "dre_category_rule.saved", "dre_category_rule", rule.id, correlationId, null, { categoryLabel, dreGroup });
      return Response.json({ rule, correlationId }, { headers: noStore });
    }
    throw new PlanningControlError("Ação de planejamento inválida.");
  } catch (error) { return failure(error); }
}

function applyActual(month: PlanningMonth, group: DreGroup, cents: number, type: string) {
  if (group === "excluded") return;
  if (group === "revenue") { month.revenueCents += type === "receivable" ? cents : -cents; return; }
  const signed = type === "payable" ? cents : -cents;
  if (group === "deductions") month.deductionsCents += signed;
  if (group === "cogs") month.cogsCents += signed;
  if (group === "operating_expense") month.operatingExpenseCents += signed;
  if (group === "financial_result") month.financialResultCents += signed;
  if (group === "income_tax") month.incomeTaxCents += signed;
}
function budgetInput(body: Record<string, unknown>) { return { name: text(body.name, "Nome", 120),
  year: integer(body.year, 2020, 2100), scenario: oneOf(body.scenario, ["base", "optimistic", "conservative"]),
  notes: optional(body.notes, 1000), lines: budgetLines(body.lines) }; }
function budgetLines(value: unknown) {
  if (!Array.isArray(value) || !value.length || value.length > 600) throw new PlanningControlError("Informe de 1 a 600 competências do orçamento.");
  const unique = new Set<string>();
  return value.map((raw) => { const row = record(raw); const line = { costCenterId: entityId(row.costCenterId),
    month: integer(row.month, 1, 12), revenueCents: moneyCents(row.revenue), cogsCents: moneyCents(row.cogs),
    expenseCents: moneyCents(row.expense), notes: optional(row.notes, 300) };
    const key = `${line.costCenterId}:${line.month}`; if (unique.has(key)) throw new PlanningControlError("Há competências duplicadas no orçamento.");
    unique.add(key); return line; });
}
function lineData(line: ReturnType<typeof budgetLines>[number]) { return { ...line, revenue: line.revenueCents / 100, expense: line.expenseCents / 100 }; }
function goalInput(body: Record<string, unknown>) {
  const direction = oneOf(body.direction || "increase", ["increase", "decrease"]),
    baseline = nonnegative(body.baseline || 0, "Linha de base"), current = nonnegative(body.current ?? baseline, "Realizado"),
    target = nonnegative(body.target, "Alvo"), startedAt = date(body.startedAt), dueAt = date(body.dueAt);
  if (dueAt < startedAt) throw new PlanningControlError("O prazo deve ser posterior ao início.");
  if (direction === "increase" ? target <= baseline : target >= baseline) throw new PlanningControlError("O alvo precisa respeitar a direção e a linha de base.");
  return { title: text(body.title, "Meta", 160), metric: text(body.metric, "Indicador", 80),
    unit: oneOf(body.unit || "currency", ["currency", "percent", "number"]), direction, target, current, baseline,
    owner: optional(body.owner, 120), weight: integer(body.weight || 100, 1, 100), notes: optional(body.notes, 1000), startedAt, dueAt };
}
async function assertCenters(db: Db, ids: number[]) { const unique = [...new Set(ids)];
  const count = await db.costCenter.count({ where: { id: { in: unique }, active: true } });
  if (count !== unique.length) throw new PlanningControlError("Centro de custo inválido ou inativo."); }
function normalizedCode(value: unknown) { const code = String(value || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "")
  .toUpperCase().replace(/[^A-Z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 30);
  if (code.length < 2) throw new PlanningControlError("Código inválido."); return code; }
function moneyCents(value: unknown) { return Math.round(nonnegative(value || 0, "Valor") * 100); }
function nonnegative(value: unknown, label: string) { const number = Number(value);
  if (!Number.isFinite(number) || number < 0 || number > 1e12) throw new PlanningControlError(`${label} inválido.`);
  return Math.round(number * 100) / 100; }
function booleanValue(value: unknown) { if (value === true || value === "true" || value === "1") return true;
  if (value === false || value === "false" || value === "0") return false; throw new PlanningControlError("Estado inválido."); }
function oneOf<const T extends string>(value: unknown, allowed: T[]) { const parsed = String(value);
  if (!allowed.includes(parsed as T)) throw new PlanningControlError("Opção inválida."); return parsed as T; }
async function audit(db: Db | Tx, actorId: string, action: string, entityType: string, id: number,
  correlationId: string, beforeData: object | null, afterData: object) { await db.tenantAuditEvent.create({ data: {
    actorId, action, entityType, entityId: String(id), correlationId,
    beforeData: beforeData ? beforeData as Prisma.InputJsonObject : undefined, afterData: afterData as Prisma.InputJsonObject } }); }
const centerSelect = { id: true, name: true, code: true, active: true, createdAt: true } satisfies Prisma.CostCenterSelect;
function failure(error: unknown) {
  if (error instanceof PlanningControlError) return Response.json({ error: error.message }, { status: error.status, headers: noStore });
  if (error instanceof CustomerInputError) return Response.json({ error: error.message }, { status: error.message.includes("Origem") ? 403 : 400, headers: noStore });
  if (error instanceof PosHttpError) return Response.json({ error: error.message }, { status: error.status, headers: noStore });
  if (error instanceof LicenseDeniedError) return Response.json({ error: error.message }, { status: error.status, headers: noStore });
  if (error instanceof AuthError) return authErrorResponse(error);
  if (error && typeof error === "object" && "code" in error && error.code === "P2002") return Response.json({ error: "Já existe um registro com estes dados." }, { status: 409, headers: noStore });
  if (error && typeof error === "object" && "code" in error && error.code === "P2034") return Response.json({ error: "Os dados foram alterados por outra operação. Atualize e tente novamente." }, { status: 409, headers: noStore });
  console.error("Planning control center failed", error instanceof Error ? error.name : "unknown");
  return Response.json({ error: "Não foi possível processar o planejamento gerencial." }, { status: 500, headers: noStore });
}
