/* eslint-disable @typescript-eslint/no-explicit-any */
import { randomUUID } from "node:crypto";
import { currentOrganization, tenantDb } from "@/db";
import { AuthError, authErrorResponse } from "@/lib/auth";
import { LicenseDeniedError } from "@/lib/billing/license";
import { assertSameOrigin, CustomerInputError } from "@/lib/erp/customer-input";
import { assertTenantPermission } from "@/lib/erp/permissions";
import {
  serviceOrderId,
  serviceOrderInput,
  ServiceOrderInputError,
} from "@/lib/erp/service-order-input";
import { assertTenantWriteAccess } from "@/lib/tenant-access";
import { HttpSecurityError, readJsonObject } from "@/lib/http-security";
const include = {
  customer: { select: { id: true, name: true, tradeName: true } },
  items: {
    include: {
      product: {
        select: {
          id: true,
          name: true,
          sku: true,
          unit: true,
          stock: true,
          type: true,
        },
      },
    },
  },
  checklist: { orderBy: { id: "asc" as const } },
  history: { orderBy: { createdAt: "asc" as const } },
};
export const dynamic = "force-dynamic";
const NO_STORE = { "cache-control": "no-store" };
export async function GET(request: Request) {
  try {
    const org = await currentOrganization();
    await assertTenantPermission(org.id, "service-orders.read");
    const db = await tenantDb(org.id), parameters = new URL(request.url).searchParams,
      page = Math.max(1, Number(parameters.get("page")) || 1), limit = Math.max(10, Math.min(200, Number(parameters.get("limit")) || 100)),
      search = (parameters.get("search") || "").trim().slice(0, 100), requestedStatus = parameters.get("status") || "",
      where = { ...(["open", "in_progress", "completed", "cancelled"].includes(requestedStatus) ? { status: requestedStatus } : {}), ...(search ? { OR: [{ number: { contains: search, mode: "insensitive" as const } }, { customerName: { contains: search, mode: "insensitive" as const } }, { asset: { contains: search, mode: "insensitive" as const } }, { assetIdentifier: { contains: search, mode: "insensitive" as const } }] } : {}) },
      [items, total, customers, products, statusGroups] = await Promise.all([
        db.serviceOrder.findMany({
          where,
          include,
          orderBy: { createdAt: "desc" },
          skip: (page - 1) * limit,
          take: limit,
        }),
        db.serviceOrder.count({ where }),
        db.customer.findMany({
          where: { status: "active" },
          select: { id: true, name: true, tradeName: true, document: true },
          orderBy: { name: "asc" },
        }),
        db.product.findMany({
          where: { active: true },
          select: {
            id: true,
            name: true,
            sku: true,
            unit: true,
            price: true,
            stock: true,
            type: true,
          },
          orderBy: { name: "asc" },
        }),
        db.serviceOrder.groupBy({ by: ["status"], _count: { _all: true } }),
      ]);
    const counts = Object.fromEntries(statusGroups.map((item) => [item.status, item._count._all]));
    return Response.json({
      items,
      customers,
      products,
      pagination: { page, limit, total, pages: Math.max(1, Math.ceil(total / limit)) },
      summary: {
        total: statusGroups.reduce((sum, item) => sum + item._count._all, 0),
        open: counts.open || 0,
        inProgress: counts.in_progress || 0,
        completed: counts.completed || 0,
      },
    }, { headers: NO_STORE });
  } catch (e) {
    return fail(e);
  }
}
export async function POST(request: Request) {
  try {
    assertSameOrigin(request);
    const org = await currentOrganization(),
      access = await assertTenantPermission(org.id, "service-orders.write");
    await assertTenantWriteAccess(org.id);
    const db = await tenantDb(org.id),
      body = await readJsonObject(request, 1_048_576),
      correlationId = randomUUID();
    if (body.action === "create") {
      const input = serviceOrderInput(body),
        customer = await db.customer.findFirst({
          where: { id: input.customerId, status: "active" },
        });
      if (!customer)
        throw new ServiceOrderInputError("Cliente ativo não encontrado.");
      const products = await db.product.findMany({
        where: {
          id: { in: input.items.map((x) => x.productId) },
          active: true,
        },
      });
      if (products.length !== input.items.length)
        throw new ServiceOrderInputError("Um dos itens não está disponível.");
      const number = `OS-${new Date().getUTCFullYear()}-${randomUUID().slice(0, 8).toUpperCase()}`,
        order = await db.$transaction(async (tx) => {
          const created = await tx.serviceOrder.create({
            data: {
              ...input,
              number,
              customerName: customer.tradeName || customer.name,
              createdBy: access.user.name,
              items: { create: input.items },
              checklist: {
                create: (input.checklist.length
                  ? input.checklist
                  : [
                      "Conferir identificação do bem",
                      "Validar serviço com o cliente",
                    ]
                ).map((label) => ({ label })),
              },
              history: {
                create: { toStatus: "open", actor: access.user.name },
              },
            },
            include,
          });
          await tx.tenantAuditEvent.create({
            data: {
              actorId: access.user.id,
              action: "service_order.created",
              entityType: "service_order",
              entityId: String(created.id),
              correlationId,
              afterData: {
                number,
                total: created.total,
                customerId: created.customerId,
                itemCount: created.items.length,
              },
            },
          });
          return created;
        });
      return Response.json({ order, correlationId }, { status: 201 });
    }
    const id = serviceOrderId(body.orderId),
      before = await db.serviceOrder.findUnique({ where: { id }, include });
    if (!before)
      return Response.json(
        { error: "Ordem de serviço não encontrada." },
        { status: 404 },
      );
    if (body.action === "start") {
      if (before.status !== "open")
        throw new ServiceOrderInputError(
          "Somente uma OS aberta pode ser iniciada.",
        );
      return Response.json({
        order: await transition(
          db,
          before,
          "in_progress",
          access.user,
          correlationId,
          { startedAt: new Date() },
        ),
        correlationId,
      });
    }
    if (body.action === "cancel") {
      if (!["open", "in_progress"].includes(before.status))
        throw new ServiceOrderInputError("Esta OS não pode ser cancelada.");
      return Response.json({
        order: await transition(
          db,
          before,
          "cancelled",
          access.user,
          correlationId,
          {},
        ),
        correlationId,
      });
    }
    if (body.action === "checklist") {
      if (!["open", "in_progress"].includes(before.status))
        throw new ServiceOrderInputError("Checklist bloqueado neste estado.");
      const itemId = serviceOrderId(body.itemId),
        item = before.checklist.find((x) => x.id === itemId);
      if (!item)
        throw new ServiceOrderInputError("Item de checklist inválido.");
      const itemUpdated = await db.$transaction(async (tx) => {
        await tx.$queryRaw`SELECT id FROM service_checklist_items WHERE id = ${item.id} FOR UPDATE`;
        const current = await tx.serviceChecklistItem.findUniqueOrThrow({ where: { id: item.id } });
        const updated = await tx.serviceChecklistItem.update({ where: { id: item.id }, data: { completed: !current.completed } });
        await tx.tenantAuditEvent.create({ data: { actorId: access.user.id, action: updated.completed ? "service_order.checklist_completed" : "service_order.checklist_reopened", entityType: "service_order", entityId: String(id), correlationId, afterData: { checklistItemId: item.id, completed: updated.completed } } });
        return updated;
      }, { isolationLevel: "Serializable" });
      return Response.json({ item: itemUpdated, correlationId }, { headers: NO_STORE });
    }
    if (body.action === "details.update") {
      if (!["open", "in_progress"].includes(before.status))
        throw new ServiceOrderInputError("O atendimento não pode mais ser alterado.");
      const diagnosis = limitedText(body.diagnosis, 2_000),
        technician = limitedText(body.technician, 160),
        scheduledAt = body.scheduledAt ? new Date(String(body.scheduledAt)) : null;
      if (scheduledAt && Number.isNaN(scheduledAt.getTime()))
        throw new ServiceOrderInputError("Data de agendamento inválida.");
      const order = await db.$transaction(async (tx) => {
        await tx.$queryRaw`SELECT id FROM service_orders WHERE id = ${id} FOR UPDATE`;
        const current = await tx.serviceOrder.findUniqueOrThrow({ where: { id }, select: { status: true, diagnosis: true, technician: true, scheduledAt: true } });
        if (!["open", "in_progress"].includes(current.status))
          throw new ServiceOrderInputError("A ordem foi alterada por outro usuário. Atualize a página.");
        const updated = await tx.serviceOrder.update({ where: { id }, data: { diagnosis, technician, scheduledAt }, include });
        await tx.tenantAuditEvent.create({
          data: {
            actorId: access.user.id,
            action: "service_order.details_updated",
            entityType: "service_order",
            entityId: String(id),
            correlationId,
            beforeData: { diagnosis: current.diagnosis, technician: current.technician, scheduledAt: current.scheduledAt },
            afterData: { diagnosis, technician, scheduledAt },
          },
        });
        return updated;
      }, { isolationLevel: "Serializable" });
      return Response.json({ order, correlationId }, { headers: NO_STORE });
    }
    if (body.action === "complete")
      return await complete(db, before, access.user, correlationId);
    throw new ServiceOrderInputError("Ação de OS inválida.");
  } catch (e) {
    return fail(e);
  }
}
async function transition(
  db: Awaited<ReturnType<typeof tenantDb>>,
  before: { id: number; status: string },
  status: string,
  user: { id: string; name: string },
  correlationId: string,
  data: Record<string, unknown>,
) {
  return db.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM service_orders WHERE id = ${before.id} FOR UPDATE`;
    const changed = await tx.serviceOrder.updateMany({ where: { id: before.id, status: before.status }, data: { ...data, status } });
    if (changed.count !== 1) throw new ServiceOrderInputError("A ordem foi alterada por outro usuário. Atualize a página.");
    await tx.serviceOrderHistory.create({ data: { serviceOrderId: before.id, fromStatus: before.status, toStatus: status, actor: user.name } });
    const order = await tx.serviceOrder.findUniqueOrThrow({ where: { id: before.id }, include });
    await tx.tenantAuditEvent.create({
      data: {
        actorId: user.id,
        action: `service_order.${status}`,
        entityType: "service_order",
        entityId: String(before.id),
        correlationId,
        beforeData: { status: before.status },
        afterData: { status },
      },
    });
    return order;
  }, { isolationLevel: "Serializable" });
}
async function complete(
  db: Awaited<ReturnType<typeof tenantDb>>,
  before: any,
  user: { id: string; name: string },
  correlationId: string,
) {
  if (before.status !== "in_progress")
    throw new ServiceOrderInputError("Inicie a OS antes de concluí-la.");
  if (before.checklist.some((x: any) => x.required && !x.completed))
    throw new ServiceOrderInputError(
      "Conclua todos os itens obrigatórios do checklist.",
    );
  const result = await db.$transaction(
    async (tx) => {
      await tx.$queryRaw`SELECT id FROM service_orders WHERE id = ${before.id} FOR UPDATE`;
      const currentOrder = await tx.serviceOrder.findUniqueOrThrow({ where: { id: before.id }, select: { status: true } });
      if (currentOrder.status !== "in_progress") throw new ServiceOrderInputError("A ordem foi alterada por outro usuário. Atualize a página.");
      const profile = await tx.tenantUserProfile.findUnique({
          where: { userId: user.id },
          include: { activeBranch: { include: { defaultWarehouse: true } } },
        }),
        warehouse =
          profile?.activeBranch?.defaultWarehouse ||
          (await tx.warehouse.findFirst({
            where: { primary: true, active: true },
          }));
      if (!warehouse?.active)
        throw new ServiceOrderInputError(
          "A filial ativa não possui depósito padrão ativo.",
        );
      const products = await tx.product.findMany({
          where: {
            id: { in: before.items.map((x: any) => x.productId) },
            active: true,
          },
        }),
        indexed = new Map(products.map((x) => [x.id, x])),
        balances = await tx.warehouseBalance.findMany({
          where: {
            warehouseId: warehouse.id,
            productId: {
              in: products.filter((x) => x.type === "product").map((x) => x.id),
            },
          },
        }),
        balanceMap = new Map(balances.map((x) => [x.productId, x]));
      for (const item of before.items) {
        const p: any = indexed.get(item.productId);
        if (
          p.type === "product" &&
          ((balanceMap.get(p.id)?.quantity || 0) - (balanceMap.get(p.id)?.reservedQuantity || 0)) < item.quantity
        )
          throw new ServiceOrderInputError(
            `Saldo insuficiente em ${warehouse.name} para ${p.name}.`,
          );
      }
      const sale = await tx.sale.create({
        data: {
          saleNumber: `#OS-${randomUUID().slice(0, 8).toUpperCase()}`,
          branchId: warehouse.branchId,
          warehouseId: warehouse.id,
          customer: before.customerName,
          seller: user.name,
          cashRegister: warehouse.name,
          paymentMethod: "A definir",
          total: before.total,
          subtotalCents: Math.round(before.total * 100),
          discountCents: 0,
          surchargeCents: 0,
          totalCents: Math.round(before.total * 100),
          changeCents: 0,
          sourceType: "service_order",
          sourceId: String(before.id),
        },
      });
      for (const item of before.items) {
        const p: any = indexed.get(item.productId),
          b: any = balanceMap.get(item.productId);
        await tx.saleItem.create({
          data: {
            saleId: sale.id,
            productId: p.id,
            productName: p.name,
            quantity: item.quantity,
            unitPrice: item.unitPrice,
            total: item.total,
            unitPriceCents: Math.round(item.unitPrice * 100),
            grossCents: Math.round(item.total * 100),
            discountCents: 0,
            surchargeCents: 0,
            totalCents: Math.round(item.total * 100),
          },
        });
        if (p.type === "service") continue;
        await tx.product.update({
          where: { id: p.id },
          data: { stock: { decrement: item.quantity } },
        });
        await tx.warehouseBalance.update({
          where: { id: b.id },
          data: { quantity: { decrement: item.quantity } },
        });
        await tx.stockMovement.create({
          data: {
            productId: p.id,
            warehouseId: warehouse.id,
            type: "exit",
            quantity: item.quantity,
            previousStock: b.quantity,
            currentStock: b.quantity - item.quantity,
            note: `OS ${before.number}`,
            userName: user.name,
          },
        });
        await tx.warehouseLedgerEntry.create({
          data: {
            warehouseId: warehouse.id,
            productId: p.id,
            type: "service_order",
            quantity: -item.quantity,
            balanceBefore: b.quantity,
            balanceAfter: b.quantity - item.quantity,
            referenceType: "service_order",
            referenceId: String(before.id),
            actor: user.name,
          },
        });
      }
      await tx.financialTitle.create({
        data: {
          type: "receivable",
          description: `OS ${before.number}`,
          customerId: before.customerId,
          documentNumber: before.number,
          sourceType: "service_order",
          sourceId: String(before.id),
          amount: before.total,
          dueAt: new Date(),
        },
      });
      const order = await tx.serviceOrder.update({
        where: { id: before.id },
        data: {
          status: "completed",
          completedAt: new Date(),
          history: {
            create: {
              fromStatus: "in_progress",
              toStatus: "completed",
              actor: user.name,
            },
          },
        },
        include,
      });
      await tx.tenantAuditEvent.create({
        data: {
          actorId: user.id,
          action: "service_order.completed",
          entityType: "service_order",
          entityId: String(before.id),
          correlationId,
          afterData: {
            status: "completed",
            saleId: sale.id,
            warehouseId: warehouse.id,
            total: before.total,
          },
        },
      });
      return { order, saleId: sale.id };
    },
    { isolationLevel: "Serializable" },
  );
  return Response.json({ ...result, correlationId });
}
function fail(e: unknown) {
  if (e instanceof HttpSecurityError) return authErrorResponse(e);
  if (e instanceof ServiceOrderInputError || e instanceof CustomerInputError)
    return Response.json(
      { error: e.message },
      { status: e.message.includes("Origem") ? 403 : 400, headers: NO_STORE },
    );
  if (e instanceof LicenseDeniedError)
    return Response.json({ error: e.message }, { status: e.status, headers: NO_STORE });
  if (e instanceof AuthError) return authErrorResponse(e);
  if (e && typeof e === "object" && "code" in e && e.code === "P2034")
    return Response.json({ error: "A ordem foi alterada simultaneamente. Atualize e tente novamente." }, { status: 409, headers: NO_STORE });
  console.error("service-orders request failed", e instanceof Error ? e.name : "unknown");
  return Response.json({ error: "Não foi possível operar a OS." }, { status: 500, headers: NO_STORE });
}

function limitedText(value: unknown, maximum: number) {
  const text = String(value || "").trim();
  if (text.length > maximum) throw new ServiceOrderInputError("Campo excede o limite permitido.");
  return text || null;
}
