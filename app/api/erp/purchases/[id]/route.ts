import { randomUUID } from "node:crypto";
import { currentOrganization, tenantDb } from "@/db";
import { AuthError, authErrorResponse, currentUser } from "@/lib/auth";
import { LicenseDeniedError } from "@/lib/billing/license";
import { assertSameOrigin, CustomerInputError } from "@/lib/erp/customer-input";
import { PurchaseInputError } from "@/lib/erp/purchase-input";
import { receivePurchaseOrder, purchaseOrderDetailInclude } from "@/lib/erp/purchase-receiving";
import { ProductionInputError } from "@/lib/erp/production-input";
import { PosCommonStockError } from "@/lib/erp/pos-common-stock";
import { PosInventoryTrackingError } from "@/lib/erp/pos-inventory-tracking";
import { assertTenantWriteAccess } from "@/lib/tenant-access";
import { assertTenantPermission } from "@/lib/erp/permissions";
import { HttpSecurityError, readJsonObject } from "@/lib/http-security";
export const dynamic = "force-dynamic";
const NO_STORE = { "cache-control": "no-store" };

export async function PATCH(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    assertSameOrigin(request);
    const organization = await currentOrganization();
    await assertTenantPermission(organization.id, "purchases.write");
    await assertTenantWriteAccess(organization.id);
    const user = await currentUser();
    const db = await tenantDb(organization.id);
    const id = positive((await params).id);
    const body = await readJsonObject(request, 262_144);
    const order = await db.purchaseOrder.findUnique({ where: { id }, include: { supplier: true, items: { include: { product: true } } } });
    if (!order) return Response.json({ error: "Pedido de compra não encontrado." }, { status: 404 });
    const correlationId = randomUUID();
    if (body.action === "submit") {
      if (order.status !== "draft") throw new PurchaseInputError("Somente pedidos em rascunho podem ser enviados.");
      const updated = await db.$transaction(async tx => {
        await tx.$queryRaw`SELECT id FROM purchase_orders WHERE id = ${id} FOR UPDATE`;
        const changed = await tx.purchaseOrder.updateMany({ where: { id, status: "draft" }, data: { status: "ordered", orderedAt: new Date() } });
        if (changed.count !== 1) throw new PurchaseInputError("O pedido foi alterado por outro usuário. Atualize a página.");
        const result = await tx.purchaseOrder.findUniqueOrThrow({ where: { id }, include: fullInclude });
        await tx.tenantAuditEvent.create({ data: { actorId: user?.id, action: "purchase_order.submitted", entityType: "purchase_order", entityId: String(id), correlationId, beforeData: { status: order.status }, afterData: { status: "ordered" } } });
        return result;
      }, { isolationLevel: "Serializable" });
      return Response.json({ order: updated, correlationId });
    }
    if (body.action === "cancel") {
      if (!['draft','ordered'].includes(order.status) || order.items.some(item => item.receivedQuantity > 0)) throw new PurchaseInputError("Este pedido não pode mais ser cancelado.");
      const updated = await db.$transaction(async tx => {
        await tx.$queryRaw`SELECT id FROM purchase_orders WHERE id = ${id} FOR UPDATE`;
        const changed = await tx.purchaseOrder.updateMany({ where: { id, status: order.status, items: { none: { receivedQuantity: { gt: 0 } } } }, data: { status: "cancelled" } });
        if (changed.count !== 1) throw new PurchaseInputError("O pedido foi alterado ou recebeu itens. Atualize a página.");
        const result = await tx.purchaseOrder.findUniqueOrThrow({ where: { id }, include: fullInclude });
        await tx.tenantAuditEvent.create({ data: { actorId: user?.id, action: "purchase_order.cancelled", entityType: "purchase_order", entityId: String(id), correlationId, beforeData: { status: order.status }, afterData: { status: "cancelled" } } });
        return result;
      }, { isolationLevel: "Serializable" });
      return Response.json({ order: updated, correlationId });
    }
    if (body.action !== "receive") throw new PurchaseInputError("Ação de compra inválida.");
    await assertTenantPermission(organization.id, "inventory.write");
    if (!user) throw new AuthError(401);
    const profile = await db.tenantUserProfile.findUnique({ where: { userId: user.id }, include: { activeBranch: { include: { defaultWarehouse: true } } } });
    const warehouse = profile?.activeBranch?.defaultWarehouse || await db.warehouse.findFirst({ where: { primary: true, active: true } });
    const result = await receivePurchaseOrder(db, id, body, { id: user.id, name: user.name }, warehouse?.id ?? null);
    return Response.json(result, { headers: NO_STORE });
  } catch (error) { return failure(error); }
}

const fullInclude = purchaseOrderDetailInclude;
function positive(value: string) { const id = Number(value); if (!Number.isInteger(id) || id <= 0) throw new PurchaseInputError("Pedido inválido."); return id; }
function failure(error: unknown) { if (error instanceof HttpSecurityError) return authErrorResponse(error); if (error instanceof PurchaseInputError || error instanceof CustomerInputError || error instanceof ProductionInputError || error instanceof PosCommonStockError || error instanceof PosInventoryTrackingError) return Response.json({ error: error.message }, { status: error.message.includes("Origem") ? 403 : 400, headers: NO_STORE }); if (error instanceof LicenseDeniedError) return Response.json({ error: error.message }, { status: error.status, headers: NO_STORE }); if (error instanceof AuthError) return authErrorResponse(error); console.error("purchase mutation failed", error instanceof Error ? error.name : "unknown"); return Response.json({ error: "Não foi possível atualizar a compra." }, { status: 500, headers: NO_STORE }); }
