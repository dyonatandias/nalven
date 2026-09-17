import { randomUUID } from "node:crypto";
import type { Prisma } from "@/generated/tenant/client";
import { currentOrganization, tenantDb } from "@/db";
import { AuthError, authErrorResponse, currentUser } from "@/lib/auth";
import { LicenseDeniedError } from "@/lib/billing/license";
import { assertSameOrigin, CustomerInputError } from "@/lib/erp/customer-input";
import { purchaseOrderInput, PurchaseInputError } from "@/lib/erp/purchase-input";
import { purchaseOrderDetailInclude } from "@/lib/erp/purchase-receiving";
import { assertTenantWriteAccess } from "@/lib/tenant-access";
import { assertTenantPermission } from "@/lib/erp/permissions";
import { readPosJson } from "@/lib/erp/pos-http";
export const dynamic = "force-dynamic";
const NO_STORE = { "cache-control": "no-store" };

export async function GET(request: Request) {
  try {
    const organization = await currentOrganization();
    await assertTenantPermission(organization.id, "purchases.read");
    const db = await tenantDb(organization.id), parameters = new URL(request.url).searchParams;
    const page = Math.max(1, Number(parameters.get("page")) || 1), limit = Math.max(10, Math.min(100, Number(parameters.get("limit")) || 100));
    const search = (parameters.get("search") || "").trim().slice(0, 100), requestedStatus = parameters.get("status") || "";
    const where: Prisma.PurchaseOrderWhereInput = { ...(["draft", "ordered", "partially_received", "received", "cancelled"].includes(requestedStatus) ? { status: requestedStatus } : {}), ...(search ? { OR: [{ number: { contains: search, mode: "insensitive" } }, { supplier: { name: { contains: search, mode: "insensitive" } } }, { supplier: { tradeName: { contains: search, mode: "insensitive" } } }] } : {}) };
    const [items, filteredTotal, suppliers, products, counts, quotations] = await Promise.all([
      db.purchaseOrder.findMany({ where, include: purchaseOrderDetailInclude, orderBy: [{ createdAt: "desc" }, { id: "desc" }], skip: (page - 1) * limit, take: limit }),
      db.purchaseOrder.count({ where }),
      db.supplier.findMany({ where: { status: "active" }, select: { id: true, name: true, tradeName: true, document: true, paymentTerms: true }, orderBy: { name: "asc" } }),
      db.product.findMany({ where: { active: true, type: "product" }, select: { id: true, name: true, sku: true, unit: true, cost: true, stock: true }, orderBy: { name: "asc" } }),
      Promise.all([db.purchaseOrder.count(), db.purchaseOrder.count({ where: { status: "draft" } }), db.purchaseOrder.count({ where: { status: { in: ["ordered", "partially_received"] } } }), db.purchaseOrder.aggregate({ where: { status: { not: "cancelled" } }, _sum: { total: true } })]),
      db.purchaseQuotation.findMany({
        include: {
          purchaseOrder: { select: { id: true, number: true, status: true } },
          items: { include: { product: { select: { id: true, name: true, sku: true, unit: true } } }, orderBy: { id: "asc" } },
          offers: { include: { supplier: { select: { id: true, name: true, tradeName: true } }, items: { orderBy: { id: "asc" } } }, orderBy: [{ selected: "desc" }, { total: "asc" }] },
        },
        orderBy: [{ status: "asc" }, { createdAt: "desc" }],
        take: 100,
      }),
    ]);
    const now = new Date(); now.setUTCHours(0, 0, 0, 0);
    const warehouses = await db.warehouse.findMany({ where: { active: true, OR: [{ branchId: null }, { branch: { status: "active" } }] }, select: { id: true, name: true }, orderBy: { name: "asc" } });
    return Response.json({ items, suppliers, products, warehouses, quotations: quotations.map((item) => ({ ...item, isOverdue: item.status === "open" && Boolean(item.deadlineAt && item.deadlineAt < now) })), pagination: { page, limit, total: filteredTotal, pages: Math.max(1, Math.ceil(filteredTotal / limit)) }, summary: { total: counts[0], drafts: counts[1], awaitingReceipt: counts[2], committed: counts[3]._sum.total || 0, openQuotations: quotations.filter((item) => item.status === "open").length, overdueQuotations: quotations.filter((item) => item.status === "open" && item.deadlineAt && item.deadlineAt < now).length } }, { headers: NO_STORE });
  } catch (error) { return failure(error); }
}

export async function POST(request: Request) {
  try {
    assertSameOrigin(request);
    const organization = await currentOrganization();
    await assertTenantPermission(organization.id, "purchases.write");
    await assertTenantWriteAccess(organization.id);
    const user = await currentUser();
    const db = await tenantDb(organization.id);
    const body = await readPosJson(request, 300_000) as Record<string, unknown>;
    const correlationId = randomUUID();
    if (body.action === "quotation.create") {
      const title = quoteText(body.title, 2, 180, "Título da cotação inválido."),
        deadlineAt = quoteDate(body.deadlineAt, false), notes = quoteOptional(body.notes, 2_000),
        rows = Array.isArray(body.items) ? body.items : [];
      if (!rows.length || rows.length > 100) throw new PurchaseInputError("Adicione de 1 a 100 itens à cotação.");
      const items = rows.map((raw) => { const row = quoteRecord(raw); return { productId: quoteId(row.productId), quantity: quoteAmount(row.quantity, 0.0001, 1_000_000) }; });
      if (new Set(items.map((item) => item.productId)).size !== items.length) throw new PurchaseInputError("Cada produto pode aparecer somente uma vez na cotação.");
      const found = await db.product.count({ where: { id: { in: items.map((item) => item.productId) }, active: true, type: "product" } });
      if (found !== items.length) throw new PurchaseInputError("Um ou mais produtos da cotação não estão disponíveis.");
      const number = `COT-${new Date().getUTCFullYear()}-${randomUUID().slice(0, 8).toUpperCase()}`;
      const quotation = await db.$transaction(async (tx) => {
        const created = await tx.purchaseQuotation.create({ data: { number, title, deadlineAt, notes, createdBy: user?.name || "Usuário NALVEN", items: { create: items } }, include: { items: { include: { product: true } }, offers: true } });
        await tx.tenantAuditEvent.create({ data: { actorId: user?.id, action: "purchase_quotation.created", entityType: "purchase_quotation", entityId: String(created.id), correlationId, afterData: { number, itemCount: items.length, deadlineAt } } });
        return created;
      }, { isolationLevel: "Serializable" });
      return Response.json({ quotation, correlationId }, { status: 201, headers: NO_STORE });
    }
    if (body.action === "quotation.offer") {
      const quotationId = quoteId(body.quotationId), supplierId = quoteId(body.supplierId),
        leadTimeDays = Math.round(quoteAmount(body.leadTimeDays || 0, 0, 3_650)),
        freight = quoteAmount(body.freight || 0, 0, 100_000_000), discount = quoteAmount(body.discount || 0, 0, 100_000_000),
        paymentTerms = quoteOptional(body.paymentTerms, 200), notes = quoteOptional(body.notes, 1_000),
        rows = Array.isArray(body.items) ? body.items : [];
      const [quotation, supplier] = await Promise.all([
        db.purchaseQuotation.findUnique({ where: { id: quotationId }, include: { items: true } }),
        db.supplier.findFirst({ where: { id: supplierId, status: "active" }, select: { id: true } }),
      ]);
      if (!quotation || quotation.status !== "open") throw new PurchaseInputError("Cotação aberta não encontrada.");
      if (!supplier) throw new PurchaseInputError("Fornecedor ativo não encontrado.");
      const costs = rows.map((raw) => { const row = quoteRecord(raw); return { quotationItemId: quoteId(row.quotationItemId), unitCost: quoteAmount(row.unitCost, 0, 100_000_000) }; });
      if (costs.length !== quotation.items.length || new Set(costs.map((item) => item.quotationItemId)).size !== costs.length || costs.some((item) => !quotation.items.some((source) => source.id === item.quotationItemId)))
        throw new PurchaseInputError("Informe o custo de todos os itens da cotação.");
      const quantities = new Map(quotation.items.map((item) => [item.id, item.quantity])), subtotal = round(costs.reduce((sum, item) => sum + (quantities.get(item.quotationItemId) || 0) * item.unitCost, 0));
      if (discount > subtotal + freight) throw new PurchaseInputError("O desconto não pode superar a proposta.");
      const total = round(subtotal + freight - discount);
      const offer = await db.$transaction(async (tx) => {
        await tx.$queryRaw`SELECT id FROM purchase_quotations WHERE id = ${quotationId} FOR UPDATE`;
        if (await tx.purchaseQuotation.count({ where: { id: quotationId, status: "open" } }) !== 1) throw new PurchaseInputError("A cotação foi encerrada por outro usuário.");
        const created = await tx.purchaseQuotationOffer.create({ data: { quotationId, supplierId, subtotal, freight, discount, total, leadTimeDays, paymentTerms, notes, items: { create: costs.map((item) => ({ ...item, total: round((quantities.get(item.quotationItemId) || 0) * item.unitCost) })) } }, include: { supplier: true, items: true } });
        await tx.tenantAuditEvent.create({ data: { actorId: user?.id, action: "purchase_quotation.offer_added", entityType: "purchase_quotation", entityId: String(quotationId), correlationId, afterData: { offerId: created.id, supplierId, subtotal, freight, discount, total, leadTimeDays } } });
        return created;
      }, { isolationLevel: "Serializable" });
      return Response.json({ offer, correlationId }, { status: 201, headers: NO_STORE });
    }
    if (body.action === "quotation.select") {
      const offerId = quoteId(body.offerId), dueAt = quoteDate(body.dueAt, true)!;
      const order = await db.$transaction(async (tx) => {
        const offer = await tx.purchaseQuotationOffer.findUnique({ where: { id: offerId }, include: { supplier: true, quotation: { include: { items: true } }, items: true } });
        if (!offer) throw new PurchaseInputError("Proposta não encontrada.");
        await tx.$queryRaw`SELECT id FROM purchase_quotations WHERE id = ${offer.quotationId} FOR UPDATE`;
        const current = await tx.purchaseQuotation.findUniqueOrThrow({ where: { id: offer.quotationId }, select: { status: true, number: true } });
        if (current.status !== "open") throw new PurchaseInputError("Esta cotação já foi encerrada.");
        const costByItem = new Map(offer.items.map((item) => [item.quotationItemId, item.unitCost]));
        if (costByItem.size !== offer.quotation.items.length) throw new PurchaseInputError("A proposta está incompleta.");
        const expectedAt = new Date(); expectedAt.setUTCDate(expectedAt.getUTCDate() + offer.leadTimeDays);
        const number = `PC-${new Date().getUTCFullYear()}-${randomUUID().slice(0, 8).toUpperCase()}`;
        const created = await tx.purchaseOrder.create({ data: { number, supplierId: offer.supplierId, expectedAt, dueAt, subtotal: offer.subtotal, freight: offer.freight, discount: offer.discount, total: offer.total, notes: `Origem: cotação ${current.number}${offer.notes ? ` · ${offer.notes}` : ""}`, createdBy: user?.name || "Usuário NALVEN", items: { create: offer.quotation.items.map((item) => ({ productId: item.productId, quantity: item.quantity, unitCost: costByItem.get(item.id)!, total: round(item.quantity * costByItem.get(item.id)!) })) } }, include: { supplier: true, items: true, receipts: true } });
        await tx.purchaseQuotationOffer.update({ where: { id: offer.id }, data: { selected: true } });
        await tx.purchaseQuotation.update({ where: { id: offer.quotationId }, data: { status: "awarded", purchaseOrderId: created.id } });
        await tx.tenantAuditEvent.create({ data: { actorId: user?.id, action: "purchase_quotation.awarded", entityType: "purchase_quotation", entityId: String(offer.quotationId), correlationId, afterData: { offerId, purchaseOrderId: created.id, supplierId: offer.supplierId, total: offer.total } } });
        return created;
      }, { isolationLevel: "Serializable" });
      return Response.json({ order, correlationId }, { status: 201, headers: NO_STORE });
    }
    if (body.action === "quotation.cancel") {
      const quotationId = quoteId(body.quotationId);
      const quotation = await db.$transaction(async (tx) => {
        await tx.$queryRaw`SELECT id FROM purchase_quotations WHERE id = ${quotationId} FOR UPDATE`;
        const changed = await tx.purchaseQuotation.updateMany({ where: { id: quotationId, status: "open" }, data: { status: "cancelled" } });
        if (changed.count !== 1) throw new PurchaseInputError("Somente uma cotação aberta pode ser cancelada.");
        const updated = await tx.purchaseQuotation.findUniqueOrThrow({ where: { id: quotationId } });
        await tx.tenantAuditEvent.create({ data: { actorId: user?.id, action: "purchase_quotation.cancelled", entityType: "purchase_quotation", entityId: String(quotationId), correlationId, afterData: { status: "cancelled" } } });
        return updated;
      }, { isolationLevel: "Serializable" });
      return Response.json({ quotation, correlationId }, { headers: NO_STORE });
    }
    const input = purchaseOrderInput(body);
    const [supplier, products] = await Promise.all([db.supplier.findFirst({ where: { id: input.supplierId, status: "active" } }), db.product.findMany({ where: { id: { in: input.items.map(item => item.productId) }, active: true, type: "product" }, select: { id: true } })]);
    if (!supplier) throw new PurchaseInputError("Fornecedor ativo não encontrado.");
    if (products.length !== input.items.length) throw new PurchaseInputError("Um ou mais produtos não estão disponíveis.");
    const subtotal = round(input.items.reduce((sum, item) => sum + item.quantity * item.unitCost, 0));
    const total = round(subtotal + input.freight - input.discount);
    const number = `PC-${new Date().getUTCFullYear()}-${randomUUID().slice(0, 8).toUpperCase()}`;
    const order = await db.$transaction(async tx => {
      const created = await tx.purchaseOrder.create({ data: { number, supplierId: supplier.id, expectedAt: input.expectedAt, dueAt: input.dueAt, subtotal, freight: input.freight, discount: input.discount, total, notes: input.notes, createdBy: user?.name || "Usuário NALVEN", items: { create: input.items.map(item => ({ productId: item.productId, quantity: item.quantity, unitCost: item.unitCost, total: round(item.quantity * item.unitCost) })) } }, include: { supplier: { select: { id: true, name: true, tradeName: true } }, items: { include: { product: { select: { id: true, name: true, sku: true, unit: true } } } }, receipts: true } });
      await tx.tenantAuditEvent.create({ data: { actorId: user?.id, action: "purchase_order.created", entityType: "purchase_order", entityId: String(created.id), correlationId, afterData: { number, supplierId: supplier.id, total, itemCount: input.items.length, status: "draft" } } });
      return created;
    }, { isolationLevel: "Serializable" });
    return Response.json({ order, correlationId }, { status: 201, headers: NO_STORE });
  } catch (error) { return failure(error); }
}

function round(value: number) { return Math.round(value * 100) / 100; }
function quoteRecord(value: unknown) { if (!value || typeof value !== "object" || Array.isArray(value)) throw new PurchaseInputError("Dados da cotação inválidos."); return value as Record<string, unknown>; }
function quoteId(value: unknown) { const parsed = Number(value); if (!Number.isInteger(parsed) || parsed <= 0) throw new PurchaseInputError("Registro da cotação inválido."); return parsed; }
function quoteAmount(value: unknown, minimum: number, maximum: number) { const parsed = Number(value); if (!Number.isFinite(parsed) || parsed < minimum || parsed > maximum) throw new PurchaseInputError("Valor da cotação inválido."); return Math.round(parsed * 10_000) / 10_000; }
function quoteText(value: unknown, minimum: number, maximum: number, message: string) { const text = String(value || "").trim(); if (text.length < minimum || text.length > maximum) throw new PurchaseInputError(message); return text; }
function quoteOptional(value: unknown, maximum: number) { const text = String(value || "").trim(); if (text.length > maximum) throw new PurchaseInputError("Campo da cotação excede o limite."); return text || null; }
function quoteDate(value: unknown, required: boolean) { const text = String(value || "").trim(); if (!text) { if (required) throw new PurchaseInputError("Data da cotação inválida."); return null; } if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) throw new PurchaseInputError("Data da cotação inválida."); const date = new Date(`${text}T12:00:00.000Z`); if (Number.isNaN(date.getTime())) throw new PurchaseInputError("Data da cotação inválida."); return date; }
function failure(error: unknown) { if (error instanceof PurchaseInputError || error instanceof CustomerInputError) return Response.json({ error: error.message }, { status: error.message.includes("Origem") ? 403 : 400, headers: NO_STORE }); if (error instanceof LicenseDeniedError) return Response.json({ error: error.message }, { status: error.status, headers: NO_STORE }); if (error instanceof AuthError) return authErrorResponse(error); if (error && typeof error === "object" && "code" in error && (error.code === "P2002" || error.code === "P2034")) return Response.json({ error: error.code === "P2002" ? "Este fornecedor já possui proposta nesta cotação." : "Os dados foram alterados simultaneamente. Atualize e tente novamente." }, { status: 409, headers: NO_STORE }); console.error("purchases request failed", error instanceof Error ? error.name : "unknown"); return Response.json({ error: "Não foi possível consultar as compras." }, { status: 500, headers: NO_STORE }); }
