import { randomUUID } from "node:crypto";
import type { Prisma } from "@/generated/tenant/client";
import { currentOrganization, tenantDb } from "@/db";
import { AuthError, authErrorResponse } from "@/lib/auth";
import { LicenseDeniedError } from "@/lib/billing/license";
import { assertSameOrigin, CustomerInputError } from "@/lib/erp/customer-input";
import { agingBuckets, cashForecast, effectiveStatus, financeSummary, remainingAmount } from "@/lib/erp/finance-control";
import { addFrequency, financialSeriesInput, financialTitleInput, FinanceInputError, splitAmount } from "@/lib/erp/finance-input";
import { assertTenantPermission } from "@/lib/erp/permissions";
import { assertTenantWriteAccess } from "@/lib/tenant-access";
import { HttpSecurityError, readJsonObject } from "@/lib/http-security";

export const dynamic = "force-dynamic";
const NO_STORE = { "cache-control": "private, no-store, max-age=0" };
const TITLE_INCLUDE = {
  customer: { select: { id: true, name: true, tradeName: true, document: true } },
  supplier: { select: { id: true, name: true, tradeName: true, document: true } },
  branch: { select: { id: true, code: true, name: true } },
  account: { select: { id: true, name: true, type: true } },
  costCenter: { select: { id: true, code: true, name: true } },
  settlements: { include: { account: { select: { id: true, name: true } } }, orderBy: { settledAt: "desc" as const } },
};

export async function GET(request: Request) {
  try {
    const organization = await currentOrganization();
    await assertTenantPermission(organization.id, "finance.read");
    const db = await tenantDb(organization.id);
    const params = new URL(request.url).searchParams;
    const page = boundedInteger(params.get("page"), 1, 100_000, 1);
    const pageSize = boundedInteger(params.get("pageSize"), 10, 100, 25);
    const type = allowed(params.get("type"), ["payable", "receivable"]);
    const status = allowed(params.get("status"), ["open", "partial", "paid", "cancelled", "overdue"]);
    const priority = allowed(params.get("priority"), ["low", "normal", "high", "urgent"]);
    const search = String(params.get("search") || "").trim().slice(0, 100);
    const branchId = optionalPositive(params.get("branchId"));
    const accountId = optionalPositive(params.get("accountId"));
    const costCenterId = optionalPositive(params.get("costCenterId"));
    const from = optionalQueryDate(params.get("from"));
    const to = optionalQueryDate(params.get("to"), true);
    const today = utcDay(new Date());
    const where: Prisma.FinancialTitleWhereInput = {
      ...(type ? { type } : {}),
      ...(priority ? { priority } : {}),
      ...(branchId ? { branchId } : {}),
      ...(accountId ? { accountId } : {}),
      ...(costCenterId ? { costCenterId } : {}),
      ...(status === "overdue" ? { status: { in: ["open", "partial"] }, dueAt: { lt: today, ...(from ? { gte: from } : {}), ...(to ? { lte: to } : {}) } }
        : { ...(status ? { status } : {}), ...((from || to) ? { dueAt: { ...(from ? { gte: from } : {}), ...(to ? { lte: to } : {}) } } : {}) }),
      ...(search ? { OR: [
        { description: { contains: search, mode: "insensitive" } },
        { documentNumber: { contains: search, mode: "insensitive" } },
        { category: { contains: search, mode: "insensitive" } },
        { customer: { is: { OR: [{ name: { contains: search, mode: "insensitive" } }, { tradeName: { contains: search, mode: "insensitive" } }] } } },
        { supplier: { is: { OR: [{ name: { contains: search, mode: "insensitive" } }, { tradeName: { contains: search, mode: "insensitive" } }] } } },
      ] } : {}),
    };
    const sort = allowed(params.get("sort"), ["due_asc", "due_desc", "amount_desc", "created_desc"]) || "due_asc";
    const orderBy: Prisma.FinancialTitleOrderByWithRelationInput[] = sort === "due_desc" ? [{ dueAt: "desc" }, { id: "desc" }]
      : sort === "amount_desc" ? [{ amount: "desc" }, { dueAt: "asc" }]
        : sort === "created_desc" ? [{ createdAt: "desc" }, { id: "desc" }]
          : [{ dueAt: "asc" }, { id: "desc" }];

    if (params.get("format") === "csv") {
      const rows = await db.financialTitle.findMany({ where, include: TITLE_INCLUDE, orderBy, take: 10_000 });
      return csvResponse(rows, today);
    }

    const [items, total, analyticsTitles, customers, suppliers, accounts, costCenters, branches] = await Promise.all([
      db.financialTitle.findMany({ where, include: TITLE_INCLUDE, orderBy, skip: (page - 1) * pageSize, take: pageSize }),
      db.financialTitle.count({ where }),
      db.financialTitle.findMany({ where, select: { type: true, status: true, amount: true, paidAmount: true, dueAt: true, category: true, customer: { select: { name: true, tradeName: true } }, supplier: { select: { name: true, tradeName: true } } }, orderBy: { dueAt: "asc" }, take: 20_000 }),
      db.customer.findMany({ where: { status: "active" }, select: { id: true, name: true, tradeName: true, document: true }, orderBy: { name: "asc" }, take: 500 }),
      db.supplier.findMany({ where: { status: "active" }, select: { id: true, name: true, tradeName: true, document: true }, orderBy: { name: "asc" }, take: 500 }),
      db.financialAccount.findMany({ where: { active: true }, select: { id: true, name: true, type: true, currentBalance: true }, orderBy: { name: "asc" } }),
      db.costCenter.findMany({ where: { active: true }, select: { id: true, name: true, code: true }, orderBy: { name: "asc" } }),
      db.branch.findMany({ where: { status: "active" }, select: { id: true, name: true, code: true, primary: true }, orderBy: [{ primary: "desc" }, { name: "asc" }] }),
    ]);
    const accountBalance = accounts.reduce((sum, account) => sum + account.currentBalance, 0);
    const summary = financeSummary(analyticsTitles, accountBalance, today);
    return Response.json({
      items: items.map((title) => ({ ...title, effectiveStatus: effectiveStatus(title, today), remainingAmount: remainingAmount(title) })),
      customers, suppliers, accounts, costCenters, branches,
      summary,
      aging: agingBuckets(analyticsTitles, today),
      forecast: cashForecast(analyticsTitles, accountBalance, today),
      breakdown: financialBreakdown(analyticsTitles),
      pagination: { page, pageSize, total, pages: Math.max(1, Math.ceil(total / pageSize)) },
      generatedAt: new Date().toISOString(),
    }, { headers: NO_STORE });
  } catch (error) {
    return failure(error, "consultar");
  }
}

export async function POST(request: Request) {
  try {
    assertSameOrigin(request);
    const organization = await currentOrganization();
    const access = await assertTenantPermission(organization.id, "finance.write");
    await assertTenantWriteAccess(organization.id);
    const body = await readJsonObject(request, 262_144);
    const input = financialTitleInput(body);
    const series = financialSeriesInput(body);
    const db = await tenantDb(organization.id);
    await validateReferences(db, input);
    const correlationId = randomUUID();
    const seriesKey = series.requestId || randomUUID();
    const sourceIds = Array.from({ length: series.count }, (_, index) => series.count === 1 ? seriesKey : `${seriesKey}:${index + 1}`);
    if (series.requestId) {
      const existing = await db.financialTitle.findMany({ where: { sourceType: "manual", sourceId: { in: sourceIds } }, include: TITLE_INCLUDE, orderBy: { installmentNumber: "asc" } });
      if (existing.length === series.count)
        return Response.json({ title: existing[0], titles: existing, correlationId: null, idempotent: true }, { headers: NO_STORE });
    }
    const amounts = series.mode === "installments" ? splitAmount(input.amount, series.count) : Array.from({ length: series.count }, () => input.amount);
    const titles = await db.$transaction(async (tx) => {
      const created = [];
      for (let index = 0; index < series.count; index += 1) {
        const installment = series.count > 1 ? { recurrenceKey: seriesKey, installmentNumber: index + 1, installmentCount: series.count } : {};
        created.push(await tx.financialTitle.create({
          data: {
            ...input,
            amount: amounts[index],
            dueAt: addFrequency(input.dueAt, series.frequency, index),
            competenceAt: input.competenceAt ? addFrequency(input.competenceAt, series.frequency, index) : null,
            description: series.count > 1 ? `${input.description} (${index + 1}/${series.count})` : input.description,
            sourceType: "manual",
            sourceId: sourceIds[index],
            ...installment,
          },
          include: TITLE_INCLUDE,
        }));
      }
      await tx.tenantAuditEvent.create({ data: {
        actorId: access.user.id, action: series.count > 1 ? "financial_title.series_created" : "financial_title.created",
        entityType: "financial_title", entityId: created.map((title) => title.id).join(","), correlationId,
        afterData: { type: input.type, total: amounts.reduce((sum, amount) => sum + amount, 0), count: series.count, mode: series.mode, frequency: series.frequency, ids: created.map((title) => title.id) },
      } });
      return created;
    }, { isolationLevel: "Serializable" });
    return Response.json({ title: titles[0], titles, correlationId }, { status: 201, headers: NO_STORE });
  } catch (error) {
    return failure(error, "criar");
  }
}

function financialBreakdown(titles: Array<{ type: string; status: string; amount: number; paidAmount: number; category: string | null; customer: { name: string; tradeName: string | null } | null; supplier: { name: string; tradeName: string | null } | null }>) {
  const open = titles.filter((title) => !["paid", "cancelled"].includes(title.status));
  const summarize = (key: "category" | "party") => {
    const map = new Map<string, { label: string; receivable: number; payable: number; count: number }>();
    for (const title of open) {
      const party = title.customer || title.supplier;
      const label = key === "category" ? title.category || "Sem categoria" : party?.tradeName || party?.name || "Sem vínculo";
      const row = map.get(label) || { label, receivable: 0, payable: 0, count: 0 };
      row[title.type === "receivable" ? "receivable" : "payable"] += remainingAmount(title);
      row.count += 1;
      map.set(label, row);
    }
    return [...map.values()].map((row) => ({ ...row, receivable: round(row.receivable), payable: round(row.payable), total: round(row.receivable + row.payable) })).sort((a, b) => b.total - a.total).slice(0, 8);
  };
  return { categories: summarize("category"), counterparties: summarize("party") };
}

async function validateReferences(db: Awaited<ReturnType<typeof tenantDb>>, input: ReturnType<typeof financialTitleInput>) {
  const [customer, supplier, branch, account, costCenter] = await Promise.all([
    input.customerId ? db.customer.findFirst({ where: { id: input.customerId, status: "active" }, select: { id: true } }) : true,
    input.supplierId ? db.supplier.findFirst({ where: { id: input.supplierId, status: "active" }, select: { id: true } }) : true,
    input.branchId ? db.branch.findFirst({ where: { id: input.branchId, status: "active" }, select: { id: true } }) : true,
    input.accountId ? db.financialAccount.findFirst({ where: { id: input.accountId, active: true }, select: { id: true } }) : true,
    input.costCenterId ? db.costCenter.findFirst({ where: { id: input.costCenterId, active: true }, select: { id: true } }) : true,
  ]);
  if (!customer) throw new FinanceInputError("Cliente ativo não encontrado.");
  if (!supplier) throw new FinanceInputError("Fornecedor ativo não encontrado.");
  if (!branch) throw new FinanceInputError("Filial ativa não encontrada.");
  if (!account) throw new FinanceInputError("Conta financeira ativa não encontrada.");
  if (!costCenter) throw new FinanceInputError("Centro de custo ativo não encontrado.");
}

function csvResponse(rows: Awaited<ReturnType<Awaited<ReturnType<typeof tenantDb>>["financialTitle"]["findMany"]>>, today: Date) {
  const columns = [["ID", "Tipo", "Status", "Descrição", "Documento", "Contraparte", "Emissão", "Vencimento", "Valor", "Liquidado", "Saldo", "Categoria", "Centro de custo", "Conta prevista", "Filial", "Prioridade"]];
  for (const raw of rows) {
    const title = raw as typeof raw & { customer?: { name: string; tradeName: string | null } | null; supplier?: { name: string; tradeName: string | null } | null; costCenter?: { name: string } | null; account?: { name: string } | null; branch?: { name: string } | null };
    const party = title.customer || title.supplier;
    columns.push([String(title.id), title.type, effectiveStatus(title, today), title.description, title.documentNumber || "", party?.tradeName || party?.name || "", title.issueAt.toISOString().slice(0, 10), title.dueAt.toISOString().slice(0, 10), title.amount.toFixed(2), title.paidAmount.toFixed(2), remainingAmount(title).toFixed(2), title.category || "", title.costCenter?.name || "", title.account?.name || "", title.branch?.name || "", title.priority]);
  }
  const csv = `\uFEFF${columns.map((row) => row.map(csvCell).join(";")).join("\r\n")}`;
  return new Response(csv, { headers: { ...NO_STORE, "content-type": "text/csv; charset=utf-8", "content-disposition": `attachment; filename="contas-pagar-receber-${new Date().toISOString().slice(0, 10)}.csv"` } });
}
function csvCell(value: string) { const safe = /^[=+\-@]/.test(value) ? `'${value}` : value; return `"${safe.replaceAll('"', '""')}"`; }
function boundedInteger(value: string | null, min: number, max: number, fallback: number) { const parsed = Number(value); return Number.isInteger(parsed) && parsed >= min && parsed <= max ? parsed : fallback; }
function optionalPositive(value: string | null) { if (!value) return null; const parsed = Number(value); if (!Number.isInteger(parsed) || parsed <= 0) throw new FinanceInputError("Filtro inválido."); return parsed; }
function allowed(value: string | null, values: string[]) { return value && values.includes(value) ? value : null; }
function optionalQueryDate(value: string | null, endOfDay = false) { if (!value) return null; if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new FinanceInputError("Período inválido."); const date = new Date(`${value}T${endOfDay ? "23:59:59.999" : "00:00:00.000"}Z`); if (Number.isNaN(date.valueOf())) throw new FinanceInputError("Período inválido."); return date; }
function utcDay(value: Date) { return new Date(Date.UTC(value.getUTCFullYear(), value.getUTCMonth(), value.getUTCDate())); }
function round(value: number) { return Math.round(value * 100) / 100; }
function failure(error: unknown, operation: string) {
  if (error instanceof HttpSecurityError) return authErrorResponse(error);
  if (error instanceof FinanceInputError || error instanceof CustomerInputError) return Response.json({ error: error.message }, { status: error.message.includes("Origem") ? 403 : 400, headers: NO_STORE });
  if (error instanceof LicenseDeniedError) return Response.json({ error: error.message }, { status: error.status, headers: NO_STORE });
  if (error instanceof AuthError) return authErrorResponse(error);
  if (error && typeof error === "object" && "code" in error && error.code === "P2002") return Response.json({ error: "Este lançamento já foi processado." }, { status: 409, headers: NO_STORE });
  console.error(`finance ${operation} failed`, error instanceof Error ? error.name : "unknown");
  return Response.json({ error: `Não foi possível ${operation} o financeiro.` }, { status: 500, headers: NO_STORE });
}
