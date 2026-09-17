import { randomUUID } from "node:crypto";
import { currentOrganization, tenantDb } from "@/db";
import { AuthError, authErrorResponse, currentUser } from "@/lib/auth";
import { LicenseDeniedError } from "@/lib/billing/license";
import { assertSameOrigin, CustomerInputError } from "@/lib/erp/customer-input";
import { financialTitleInput, FinanceInputError, settlementInput } from "@/lib/erp/finance-input";
import { assertTenantPermission } from "@/lib/erp/permissions";
import { assertTenantWriteAccess } from "@/lib/tenant-access";
import { HttpSecurityError, readJsonObject } from "@/lib/http-security";

const SALE_STATUSES = ["completed", "cancelled", "refunded", "partially_refunded"];
const EXPENSE_STATUSES = ["open", "partial", "paid", "cancelled"];

export async function GET(request: Request) {
  try {
    const organization = await currentOrganization();
    await assertTenantPermission(organization.id, "sales.read");
    const user = await currentUser();
    if (!user) throw new AuthError(401);
    const db = await tenantDb(organization.id);
    const query = new URL(request.url).searchParams;
    const { start, end } = period(query.get("from"), query.get("to"));
    const search = String(query.get("search") || "").trim().slice(0, 100);
    const saleStatus = accepted(query.get("saleStatus"), SALE_STATUSES);
    const expenseStatus = accepted(query.get("expenseStatus"), EXPENSE_STATUSES);
    const profile = await db.tenantUserProfile.findUnique({ where: { userId: user.id }, select: { activeBranchId: true } });
    const branchId = profile?.activeBranchId || (await db.branch.findFirst({ where: { primary: true, status: "active" }, select: { id: true } }))?.id;
    if (!branchId) return Response.json({ error: "Selecione uma filial ativa para consultar as vendas." }, { status: 409 });

    const [branch, sales, expenses, suppliers] = await Promise.all([
      db.branch.findUnique({ where: { id: branchId }, select: { id: true, code: true, name: true } }),
      db.sale.findMany({
        where: { branchId, createdAt: { gte: start, lte: end }, ...(saleStatus ? { status: saleStatus } : {}), ...(search ? { OR: [{ saleNumber: { contains: search, mode: "insensitive" } }, { customer: { contains: search, mode: "insensitive" } }, { seller: { contains: search, mode: "insensitive" } }] } : {}) },
        include: { items: { select: { id: true, productName: true, skuSnapshot: true, quantity: true, unit: true, unitPriceCents: true, discountCents: true, totalCents: true, returnedQuantity: true } }, payments: { select: { id: true, method: true, status: true, amountCents: true, tenderedCents: true, changeCents: true, cardBrand: true, cardLastFour: true, installments: true } } },
        orderBy: [{ createdAt: "desc" }, { id: "desc" }], take: 500,
      }),
      db.financialTitle.findMany({
        where: { type: "payable", createdAt: { gte: start, lte: end }, ...(expenseStatus ? { status: expenseStatus } : {}), ...(search ? { OR: [{ description: { contains: search, mode: "insensitive" } }, { documentNumber: { contains: search, mode: "insensitive" } }, { supplier: { name: { contains: search, mode: "insensitive" } } }] } : {}) },
        include: { supplier: { select: { id: true, name: true, tradeName: true } }, settlements: { orderBy: { settledAt: "desc" } } },
        orderBy: [{ dueAt: "asc" }, { id: "desc" }], take: 500,
      }),
      db.supplier.findMany({ where: { status: "active" }, select: { id: true, name: true, tradeName: true }, orderBy: { name: "asc" } }),
    ]);
    const validSales = sales.filter(item => item.status !== "cancelled");
    const validExpenses = expenses.filter(item => item.status !== "cancelled");
    const grossSalesCents = validSales.reduce((sum, item) => sum + item.totalCents, 0);
    const expensesCents = validExpenses.reduce((sum, item) => sum + cents(item.amount), 0);
    const paidExpensesCents = validExpenses.reduce((sum, item) => sum + cents(item.paidAmount), 0);
    const overdueCents = validExpenses.filter(item => item.status !== "paid" && item.dueAt < dayStart(new Date())).reduce((sum, item) => sum + cents(item.amount - item.paidAmount), 0);
    return Response.json({
      branch, period: { from: ymd(start), to: ymd(end) }, sales, expenses, suppliers,
      summary: { grossSalesCents, salesCount: validSales.length, averageTicketCents: validSales.length ? Math.round(grossSalesCents / validSales.length) : 0, expensesCents, paidExpensesCents, overdueCents, netCents: grossSalesCents - expensesCents },
    });
  } catch (error) { return failure(error, "Não foi possível carregar vendas e despesas."); }
}

export async function POST(request: Request) {
  try {
    assertSameOrigin(request);
    const organization = await currentOrganization();
    await assertTenantPermission(organization.id, "sales.write");
    await assertTenantWriteAccess(organization.id);
    const user = await currentUser();
    const db = await tenantDb(organization.id);
    const body = await readJsonObject(request, 262_144);
    const action = String(body.action || "");
    if (action === "create_expense") {
      const input = financialTitleInput({ ...body, type: "payable" });
      if (input.supplierId && !await db.supplier.findFirst({ where: { id: input.supplierId, status: "active" } })) throw new FinanceInputError("Fornecedor ativo não encontrado.");
      const correlationId = randomUUID();
      const title = await db.$transaction(async tx => {
        const created = await tx.financialTitle.create({ data: { ...input, sourceType: "manual_expense", sourceId: randomUUID() }, include: { supplier: { select: { id: true, name: true, tradeName: true } }, settlements: true } });
        await tx.tenantAuditEvent.create({ data: { actorId: user?.id, action: "expense.created", entityType: "financial_title", entityId: String(created.id), correlationId, afterData: { amount: created.amount, dueAt: created.dueAt, description: created.description } } });
        return created;
      });
      return Response.json({ title, correlationId }, { status: 201 });
    }
    const id = positive(body.id);
    const title = await db.financialTitle.findFirst({ where: { id, type: "payable" }, include: { settlements: true } });
    if (!title) return Response.json({ error: "Despesa não encontrada." }, { status: 404 });
    const correlationId = randomUUID();
    if (action === "cancel_expense") {
      if (title.status === "paid" || title.status === "cancelled" || title.settlements.length) throw new FinanceInputError("Uma despesa paga ou com baixas não pode ser cancelada.");
      await db.$transaction(async tx => {
        await tx.financialTitle.update({ where: { id }, data: { status: "cancelled" } });
        await tx.tenantAuditEvent.create({ data: { actorId: user?.id, action: "expense.cancelled", entityType: "financial_title", entityId: String(id), correlationId, beforeData: { status: title.status }, afterData: { status: "cancelled" } } });
      });
      return Response.json({ ok: true, correlationId });
    }
    if (action !== "settle_expense" || !["open", "partial"].includes(title.status)) throw new FinanceInputError("Ação inválida ou despesa indisponível para baixa.");
    const remaining = round(title.amount - title.paidAmount);
    const input = settlementInput(body, remaining);
    const newPaidAmount = Math.min(title.amount, round(title.paidAmount + input.amount + input.discount));
    const status = newPaidAmount >= title.amount ? "paid" : "partial";
    await db.$transaction(async tx => {
      const settlement = await tx.financialSettlement.create({ data: { titleId: id, amount: input.amount, interest: input.interest, discount: input.discount, method: input.method, notes: input.notes, settledBy: user?.name || "Usuário NALVEN" } });
      await tx.financialTitle.update({ where: { id }, data: { paidAmount: newPaidAmount, status, ...(status === "paid" ? { paidAt: new Date() } : {}) } });
      await tx.tenantAuditEvent.create({ data: { actorId: user?.id, action: "expense.settled", entityType: "financial_title", entityId: String(id), correlationId, beforeData: { status: title.status, paidAmount: title.paidAmount }, afterData: { status, paidAmount: newPaidAmount, settlementId: settlement.id } } });
    }, { isolationLevel: "Serializable" });
    return Response.json({ ok: true, correlationId });
  } catch (error) { return failure(error, "Não foi possível salvar a despesa."); }
}

function period(from: string | null, to: string | null) { const now = new Date(); const fallbackFrom = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)); const start = parseDate(from, fallbackFrom, false); const end = parseDate(to, now, true); if (end < start || end.getTime() - start.getTime() > 366 * 86400000) throw new FinanceInputError("Selecione um período de até 366 dias."); return { start, end }; }
function parseDate(value: string | null, fallback: Date, end: boolean) { if (!value || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return end ? dayEnd(fallback) : dayStart(fallback); const date = new Date(`${value}T${end ? "23:59:59.999" : "00:00:00.000"}Z`); if (Number.isNaN(date.getTime())) throw new FinanceInputError("Período inválido."); return date; }
function accepted(value: string | null, options: string[]) { return value && options.includes(value) ? value : undefined; }
function positive(value: unknown) { const id = Number(value); if (!Number.isInteger(id) || id <= 0) throw new FinanceInputError("Despesa inválida."); return id; }
function cents(value: number) { return Math.round(value * 100); }
function round(value: number) { return Math.round(value * 100) / 100; }
function dayStart(value: Date) { const date = new Date(value); date.setUTCHours(0, 0, 0, 0); return date; }
function dayEnd(value: Date) { const date = new Date(value); date.setUTCHours(23, 59, 59, 999); return date; }
function ymd(value: Date) { return value.toISOString().slice(0, 10); }
function failure(error: unknown, fallback: string) { if (error instanceof HttpSecurityError) return authErrorResponse(error); if (error instanceof FinanceInputError || error instanceof CustomerInputError) return Response.json({ error: error.message }, { status: error.message.includes("Origem") ? 403 : 400 }); if (error instanceof LicenseDeniedError) return Response.json({ error: error.message }, { status: error.status }); if (error instanceof AuthError) return authErrorResponse(error); console.error("sales-expenses",{context:fallback,error:error instanceof Error?error.name:typeof error});return Response.json({ error: fallback }, { status: 500 }); }
