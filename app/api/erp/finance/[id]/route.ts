import { randomUUID } from "node:crypto";
import { currentOrganization, tenantDb } from "@/db";
import { AuthError, authErrorResponse } from "@/lib/auth";
import { LicenseDeniedError } from "@/lib/billing/license";
import { assertSameOrigin, CustomerInputError } from "@/lib/erp/customer-input";
import { settlementCashAmount } from "@/lib/erp/finance-control";
import { financialTitleUpdateInput, FinanceInputError, rescheduleInput, reversalInput, settlementInput } from "@/lib/erp/finance-input";
import { assertTenantPermission } from "@/lib/erp/permissions";
import { assertTenantWriteAccess } from "@/lib/tenant-access";
import { HttpSecurityError, readJsonObject } from "@/lib/http-security";

export const dynamic = "force-dynamic";
const NO_STORE = { "cache-control": "private, no-store, max-age=0" };
const include = {
  customer: { select: { id: true, name: true, tradeName: true, document: true } },
  supplier: { select: { id: true, name: true, tradeName: true, document: true } },
  branch: { select: { id: true, code: true, name: true } },
  account: { select: { id: true, name: true, type: true } },
  costCenter: { select: { id: true, code: true, name: true } },
  settlements: { include: { account: { select: { id: true, name: true } } }, orderBy: { settledAt: "desc" as const } },
};

export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const organization = await currentOrganization();
    await assertTenantPermission(organization.id, "finance.read");
    const db = await tenantDb(organization.id);
    const id = positive((await params).id);
    const [title, events] = await Promise.all([
      db.financialTitle.findUnique({ where: { id }, include }),
      db.tenantAuditEvent.findMany({ where: { entityType: "financial_title", entityId: String(id) }, orderBy: { createdAt: "desc" }, take: 50 }),
    ]);
    if (!title) return Response.json({ error: "Título não encontrado." }, { status: 404, headers: NO_STORE });
    return Response.json({ title, events }, { headers: NO_STORE });
  } catch (error) {
    return failure(error);
  }
}

export async function PATCH(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    assertSameOrigin(request);
    const organization = await currentOrganization();
    const access = await assertTenantPermission(organization.id, "finance.write");
    await assertTenantWriteAccess(organization.id);
    const db = await tenantDb(organization.id);
    const id = positive((await params).id);
    const body = await readJsonObject(request, 262_144);
    const action = String(body.action || "");
    const correlationId = randomUUID();
    const result = await db.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM financial_titles WHERE id = ${id} FOR UPDATE`;
      const title = await tx.financialTitle.findUnique({ where: { id }, include });
      if (!title) throw new FinanceInputError("Título não encontrado.");

      if (action === "settle") {
        if (!["open", "partial"].includes(title.status)) throw new FinanceInputError("O título não está disponível para baixa.");
        const remaining = round(title.amount - title.paidAmount);
        const input = settlementInput(body, remaining);
        if (input.accountId) {
          const account = await tx.financialAccount.findFirst({ where: { id: input.accountId, active: true }, select: { id: true } });
          if (!account) throw new FinanceInputError("Conta financeira ativa não encontrada.");
        }
        const cashAmount = settlementCashAmount(title.type, input.amount, input.interest, input.fee);
        if (cashAmount <= 0) throw new FinanceInputError("A tarifa não pode consumir integralmente o recebimento.");
        const extinguished = round(input.amount + input.discount);
        const newPaidAmount = Math.min(title.amount, round(title.paidAmount + extinguished));
        const status = newPaidAmount >= title.amount ? "paid" : "partial";
        const settlement = await tx.financialSettlement.create({ data: { titleId: id, ...input, settledBy: access.user.name } });
        if (input.accountId) {
          const entryType = title.type === "receivable" ? "credit" : "debit";
          await tx.accountEntry.create({ data: { accountId: input.accountId, type: entryType, amount: cashAmount, description: `${title.type === "receivable" ? "Recebimento" : "Pagamento"}: ${title.description}`, sourceType: "financial_settlement", sourceId: String(settlement.id), occurredAt: input.occurredAt, createdBy: access.user.name } });
          await tx.financialAccount.update({ where: { id: input.accountId }, data: { currentBalance: { increment: entryType === "credit" ? cashAmount : -cashAmount } } });
        }
        const updated = await tx.financialTitle.update({ where: { id }, data: { paidAmount: newPaidAmount, status, paidAt: status === "paid" ? input.occurredAt : null }, include });
        await audit(tx, access.user.id, "financial_title.settled", id, correlationId, { status: title.status, paidAmount: title.paidAmount }, { status, paidAmount: newPaidAmount, settlementId: settlement.id, accountId: input.accountId, cashAmount });
        return { title: updated, settlement };
      }

      if (action === "reverse_settlement") {
        const input = reversalInput(body);
        await tx.$queryRaw`SELECT id FROM financial_settlements WHERE id = ${input.settlementId} FOR UPDATE`;
        const settlement = await tx.financialSettlement.findFirst({ where: { id: input.settlementId, titleId: id } });
        if (!settlement || settlement.status !== "posted") throw new FinanceInputError("Baixa ativa não encontrada.");
        const extinguished = round(settlement.amount + settlement.discount);
        const newPaidAmount = Math.max(0, round(title.paidAmount - extinguished));
        const newStatus = newPaidAmount > 0 ? "partial" : "open";
        const cashAmount = settlementCashAmount(title.type, settlement.amount, settlement.interest, settlement.fee);
        if (settlement.accountId) {
          const entryType = title.type === "receivable" ? "debit" : "credit";
          await tx.accountEntry.create({ data: { accountId: settlement.accountId, type: entryType, amount: cashAmount, description: `Estorno: ${title.description}`, sourceType: "financial_settlement_reversal", sourceId: String(settlement.id), occurredAt: new Date(), createdBy: access.user.name } });
          await tx.financialAccount.update({ where: { id: settlement.accountId }, data: { currentBalance: { increment: entryType === "credit" ? cashAmount : -cashAmount } } });
        }
        await tx.financialSettlement.update({ where: { id: settlement.id }, data: { status: "reversed", reversedAt: new Date(), reversedBy: access.user.name, reversalReason: input.reason } });
        const updated = await tx.financialTitle.update({ where: { id }, data: { paidAmount: newPaidAmount, status: newStatus, paidAt: null }, include });
        await audit(tx, access.user.id, "financial_title.settlement_reversed", id, correlationId, { status: title.status, paidAmount: title.paidAmount }, { status: newStatus, paidAmount: newPaidAmount, settlementId: settlement.id, reason: input.reason });
        return { title: updated, reversed: settlement.id };
      }

      if (action === "cancel") {
        const reason = requiredReason(body.reason);
        if (["cancelled", "paid"].includes(title.status) || title.settlements.some((settlement) => settlement.status === "posted"))
          throw new FinanceInputError("Título liquidado ou com baixas ativas não pode ser cancelado.");
        const updated = await tx.financialTitle.update({ where: { id }, data: { status: "cancelled", notes: appendNote(title.notes, `Cancelado: ${reason}`) }, include });
        await audit(tx, access.user.id, "financial_title.cancelled", id, correlationId, { status: title.status }, { status: "cancelled", reason });
        return { title: updated };
      }

      if (action === "reopen") {
        const reason = requiredReason(body.reason);
        if (title.status !== "cancelled") throw new FinanceInputError("Somente títulos cancelados podem ser reabertos.");
        const updated = await tx.financialTitle.update({ where: { id }, data: { status: title.paidAmount > 0 ? "partial" : "open", notes: appendNote(title.notes, `Reaberto: ${reason}`) }, include });
        await audit(tx, access.user.id, "financial_title.reopened", id, correlationId, { status: title.status }, { status: updated.status, reason });
        return { title: updated };
      }

      if (action === "reschedule") {
        if (["paid", "cancelled"].includes(title.status)) throw new FinanceInputError("Este título não pode ser reagendado.");
        const input = rescheduleInput(body);
        const updated = await tx.financialTitle.update({ where: { id }, data: { dueAt: input.dueAt, notes: appendNote(title.notes, `Reagendado: ${input.reason}`) }, include });
        await audit(tx, access.user.id, "financial_title.rescheduled", id, correlationId, { dueAt: title.dueAt }, { dueAt: input.dueAt, reason: input.reason });
        return { title: updated };
      }

      if (action === "update") {
        const input = financialTitleUpdateInput(body, title.paidAmount);
        if (title.settlements.some((settlement) => settlement.status === "posted") && input.type !== title.type)
          throw new FinanceInputError("O tipo não pode ser alterado após uma baixa.");
        await validateReferences(tx, input);
        const updated = await tx.financialTitle.update({ where: { id }, data: input, include });
        await audit(tx, access.user.id, "financial_title.updated", id, correlationId, snapshot(title), snapshot(updated));
        return { title: updated };
      }

      throw new FinanceInputError("Ação financeira inválida.");
    }, { isolationLevel: "Serializable" });
    return Response.json({ ...result, correlationId }, { headers: NO_STORE });
  } catch (error) {
    return failure(error);
  }
}

async function validateReferences(db: Parameters<Parameters<Awaited<ReturnType<typeof tenantDb>>["$transaction"]>[0]>[0], input: ReturnType<typeof financialTitleUpdateInput>) {
  const checks = await Promise.all([
    input.customerId ? db.customer.count({ where: { id: input.customerId, status: "active" } }) : 1,
    input.supplierId ? db.supplier.count({ where: { id: input.supplierId, status: "active" } }) : 1,
    input.branchId ? db.branch.count({ where: { id: input.branchId, status: "active" } }) : 1,
    input.accountId ? db.financialAccount.count({ where: { id: input.accountId, active: true } }) : 1,
    input.costCenterId ? db.costCenter.count({ where: { id: input.costCenterId, active: true } }) : 1,
  ]);
  if (checks.some((value) => !value)) throw new FinanceInputError("Um dos vínculos informados não está ativo.");
}
async function audit(db: Parameters<Parameters<Awaited<ReturnType<typeof tenantDb>>["$transaction"]>[0]>[0], actorId: string, action: string, id: number, correlationId: string, beforeData: object, afterData: object) {
  await db.tenantAuditEvent.create({ data: { actorId, action, entityType: "financial_title", entityId: String(id), correlationId, beforeData, afterData } });
}
function snapshot(title: { type: string; amount: number; paidAmount: number; dueAt: Date; status: string; accountId: number | null; costCenterId: number | null; branchId: number | null; priority: string }) {
  return { type: title.type, amount: title.amount, paidAmount: title.paidAmount, dueAt: title.dueAt, status: title.status, accountId: title.accountId, costCenterId: title.costCenterId, branchId: title.branchId, priority: title.priority };
}
function appendNote(current: string | null, note: string) { const line = `[${new Date().toISOString().slice(0, 10)}] ${note}`; return current ? `${current}\n${line}`.slice(0, 1000) : line; }
function requiredReason(value: unknown) { const reason = String(value || "").trim(); if (reason.length < 5 || reason.length > 500) throw new FinanceInputError("Informe um motivo com ao menos 5 caracteres."); return reason; }
function positive(value: string) { const id = Number(value); if (!Number.isInteger(id) || id <= 0) throw new FinanceInputError("Título inválido."); return id; }
function round(value: number) { return Math.round(value * 100) / 100; }
function failure(error: unknown) {
  if (error instanceof HttpSecurityError) return authErrorResponse(error);
  if (error instanceof FinanceInputError || error instanceof CustomerInputError) return Response.json({ error: error.message }, { status: error.message.includes("Origem") ? 403 : error.message.includes("não encontrado") ? 404 : 400, headers: NO_STORE });
  if (error instanceof LicenseDeniedError) return Response.json({ error: error.message }, { status: error.status, headers: NO_STORE });
  if (error instanceof AuthError) return authErrorResponse(error);
  if (error && typeof error === "object" && "code" in error && error.code === "P2002") return Response.json({ error: "Esta operação já foi registrada." }, { status: 409, headers: NO_STORE });
  if (error && typeof error === "object" && "code" in error && error.code === "P2034") return Response.json({ error: "O título foi alterado por outro usuário. Atualize e tente novamente." }, { status: 409, headers: NO_STORE });
  console.error("finance title operation failed", error instanceof Error ? error.name : "unknown");
  return Response.json({ error: "Não foi possível atualizar o título financeiro." }, { status: 500, headers: NO_STORE });
}
