import { createHash, randomUUID } from "node:crypto";
import { currentOrganization, tenantDb } from "@/db";
import { Prisma } from "@/generated/tenant/client";
import { AuthError, authErrorResponse } from "@/lib/auth";
import { LicenseDeniedError } from "@/lib/billing/license";
import { assertSameOrigin, CustomerInputError } from "@/lib/erp/customer-input";
import { assertTenantPermission } from "@/lib/erp/permissions";
import { enqueueStatusNotifications } from "@/lib/erp/order-domain";
import {
  orderId,
  salesOrderInput,
  SalesOrderInputError,
} from "@/lib/erp/sales-order-input";
import { assertTenantWriteAccess } from "@/lib/tenant-access";
import { enqueueWebhook } from "@/lib/integrations/webhooks";
import { reserveOrderStock, type WorkflowOrder } from "@/lib/erp/order-stock";
import { HttpSecurityError, readJsonObject, unexpectedErrorResponse } from "@/lib/http-security";

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
  history: { orderBy: { createdAt: "asc" as const } },
  stockReservations: {
    where: { status: "active" },
    select: {
      id: true,
      orderItemId: true,
      warehouseId: true,
      productId: true,
      variationId: true,
      quantity: true,
      status: true,
    },
  },
};

export async function GET() {
  try {
    const organization = await currentOrganization();
    const access = await assertTenantPermission(organization.id, "orders.read");
    const db = await tenantDb(organization.id);
    const profile = await db.tenantUserProfile.findUnique({
      where: { userId: access.user.id },
      select: { id: true, activeBranchId: true },
    });
    if (!profile?.activeBranchId)
      throw new SalesOrderInputError("Selecione uma filial ativa.");
    const branchAccess = await db.branchUserAccess.findFirst({
      where: {
        branchId: profile.activeBranchId,
        userProfile: { userId: access.user.id },
      },
    });
    if (!branchAccess)
      throw new SalesOrderInputError("Você não possui acesso à filial ativa.");
    const [items, customers, productRows, settings, salespeople, branch] =
      await Promise.all([
        db.salesOrder.findMany({
          where: { branchId: profile.activeBranchId },
          include,
          orderBy: { createdAt: "desc" },
          take: 100,
        }),
        db.customer.findMany({
          where: { status: "active" },
          select: {
            id: true,
            name: true,
            tradeName: true,
            document: true,
            email: true,
            phone: true,
            addresses: { where: { primary: true }, take: 1 },
          },
          orderBy: { name: "asc" },
        }),
        db.product.findMany({
          where: {
            active: true,
            branchConfigurations: {
              some: {
                branchId: profile.activeBranchId,
                active: true,
                saleEnabled: true,
              },
            },
          },
          include: {
            branchConfigurations: {
              where: { branchId: profile.activeBranchId },
            },
            warehouseBalances: {
              where: { warehouse: { branchId: profile.activeBranchId } },
            },
          },
          orderBy: { name: "asc" },
        }),
        db.tenantSettings.findUnique({
          where: { id: 1 },
          select: {
            quoteValidityDays: true,
            maxDiscountPercent: true,
            defaultPaymentMethod: true,
            termsAndConditions: true,
          },
        }),
        db.tenantUserProfile.findMany({
          where: {
            status: "active",
            branchAccesses: {
              some: { branchId: profile.activeBranchId, canSell: true },
            },
          },
          select: { id: true, displayName: true, email: true },
          orderBy: { displayName: "asc" },
        }),
        db.branch.findUnique({
          where: { id: profile.activeBranchId },
          select: {
            id: true,
            code: true,
            name: true,
            defaultWarehouse: { select: { id: true, code: true, name: true } },
          },
        }),
      ]);
    const products = productRows.map(
      ({ branchConfigurations, warehouseBalances, ...product }) => ({
        id: product.id,
        name: product.name,
        sku: product.sku,
        unit: product.unit,
        price: branchConfigurations[0]?.priceOverride ?? product.price,
        stock: warehouseBalances.reduce(
          (sum, item) => sum + item.quantity - item.reservedQuantity,
          0,
        ),
        type: product.type,
      }),
    );
    return Response.json({
      items,
      customers,
      products,
      salespeople,
      branch,
      currentSalespersonProfileId: profile.id,
      settings: settings || {
        quoteValidityDays: 15,
        maxDiscountPercent: 20,
        defaultPaymentMethod: "Pix",
        termsAndConditions: null,
      },
      summary: {
        total: items.length,
        drafts: items.filter((item) => item.status === "draft").length,
        approved: items.filter((item) => item.status === "approved").length,
        completed: items
          .filter((item) => item.status === "completed")
          .reduce((sum, item) => sum + item.total, 0),
      },
    });
  } catch (error) {
    return failure(error);
  }
}

export async function POST(request: Request) {
  try {
    assertSameOrigin(request);
    const organization = await currentOrganization();
    const access = await assertTenantPermission(
      organization.id,
      "orders.write",
    );
    await assertTenantWriteAccess(organization.id);
    const db = await tenantDb(organization.id),
      body = await readJsonObject(request, 1_048_576),
      correlationId = randomUUID();
    const idempotencyKey =
      request.headers.get("idempotency-key")?.trim() || null;
    const requestHash = idempotencyKey
      ? createHash("sha256").update(JSON.stringify(body)).digest("hex")
      : null;
    if (
      idempotencyKey &&
      (idempotencyKey.length < 16 || idempotencyKey.length > 160)
    )
      throw new SalesOrderInputError("Chave de idempotência inválida.");
    const profile = await db.tenantUserProfile.findUnique({
      where: { userId: access.user.id },
      select: { id: true, activeBranchId: true },
    });
    if (!profile?.activeBranchId)
      throw new SalesOrderInputError("Selecione uma filial ativa.");
    const branchAccess = await db.branchUserAccess.findFirst({
      where: {
        branchId: profile.activeBranchId,
        userProfile: { userId: access.user.id },
      },
    });
    if (!branchAccess)
      throw new SalesOrderInputError("Você não possui acesso à filial ativa.");
    if (body.action === "create") {
      if (idempotencyKey) {
        const replay = await db.orderIdempotency.findUnique({
          where: { key: idempotencyKey },
          include: { salesOrder: { include } },
        });
        if (replay && replay.requestHash !== requestHash)
          return Response.json(
            {
              error:
                "A chave de idempotência já foi usada com dados diferentes.",
            },
            { status: 409 },
          );
        if (replay?.state === "completed" && replay.salesOrder)
          return Response.json(
            { order: replay.salesOrder, correlationId, replayed: true },
            { status: replay.responseStatus || 201 },
          );
        if (replay)
          return Response.json(
            { error: "A criação deste pedido ainda está em processamento." },
            { status: 409, headers: { "Retry-After": "3" } },
          );
      }
      if (!branchAccess.canSell)
        throw new SalesOrderInputError(
          "Você não possui permissão comercial nesta filial.",
        );
      const input = salesOrderInput(body),
        customer = input.customerId
          ? await db.customer.findFirst({
              where: { id: input.customerId, status: "active" },
            })
          : null;
      if (input.customerId && !customer)
        throw new SalesOrderInputError("Cliente ativo não encontrado.");
      const salesperson = input.salespersonProfileId
        ? await db.tenantUserProfile.findFirst({
            where: {
              id: input.salespersonProfileId,
              status: "active",
              branchAccesses: {
                some: { branchId: profile.activeBranchId, canSell: true },
              },
            },
          })
        : await db.tenantUserProfile.findUnique({ where: { id: profile.id } });
      if (!salesperson)
        throw new SalesOrderInputError(
          "Vendedor ativo e autorizado não encontrado.",
        );
      const requestedProductIds = [
        ...new Set(input.items.map((item) => item.productId)),
      ];
      const products = await db.product.findMany({
        where: {
          id: { in: requestedProductIds },
          active: true,
          branchConfigurations: {
            some: {
              branchId: profile.activeBranchId,
              active: true,
              saleEnabled: true,
            },
          },
        },
        include: {
          branchConfigurations: { where: { branchId: profile.activeBranchId } },
          variations: { where: { enabled: true } },
        },
      });
      if (products.length !== requestedProductIds.length)
        throw new SalesOrderInputError("Um dos produtos não está disponível.");
      const settings = await db.tenantSettings.findUnique({ where: { id: 1 } });
      if (!settings)
        throw new SalesOrderInputError(
          "Configurações da organização não inicializadas.",
        );
      const productById = new Map(
        products.map((product) => [product.id, product]),
      );
      const orderItems = input.items.map((item) => {
        const product = productById.get(item.productId)!,
          variation = item.variationId
            ? product.variations.find((row) => row.id === item.variationId)
            : null;
        if (item.variationId && !variation)
          throw new SalesOrderInputError(
            `A variação selecionada de ${product.name} não está disponível.`,
          );
        const productPrice =
            product.branchConfigurations[0]?.priceOverride ?? product.price,
          listPrice = variation?.regularPrice ?? productPrice,
          unitPrice = item.unitPrice,
          discount = Math.max(
            0,
            Math.round((listPrice - unitPrice) * item.quantity * 100) / 100,
          ),
          discountPercent =
            listPrice > 0
              ? Math.max(
                  0,
                  Math.round(((listPrice - unitPrice) / listPrice) * 10000) /
                    100,
                )
              : 0;
        return {
          productId: item.productId,
          variationId: variation?.id || null,
          itemType: "line_item",
          nameSnapshot: product.name,
          skuSnapshot: variation?.sku || product.sku,
          variationSnapshot: variation?.attributes || undefined,
          imageSnapshot: product.imageMediaId
            ? `/api/erp/library/${product.imageMediaId}/file`
            : null,
          description: item.description || product.description || product.name,
          quantity: item.quantity,
          listPrice,
          unitPrice,
          discount,
          discountPercent,
          notes: item.notes,
          total: Math.round(unitPrice * item.quantity * 100) / 100,
        };
      });
      const subtotal =
        Math.round(
          orderItems.reduce((sum, item) => sum + item.total, 0) * 100,
        ) / 100;
      const listSubtotal =
        Math.round(
          orderItems.reduce(
            (sum, item) => sum + item.listPrice * item.quantity,
            0,
          ) * 100,
        ) / 100;
      const discount =
        input.discountType === "percent"
          ? Math.round(subtotal * input.discountValue) / 100
          : input.discountValue;
      if (discount > subtotal)
        throw new SalesOrderInputError(
          "O desconto geral não pode superar o subtotal dos itens.",
        );
      const combinedDiscount = Math.max(0, listSubtotal - subtotal) + discount;
      if (
        listSubtotal > 0 &&
        (combinedDiscount / listSubtotal) * 100 > settings.maxDiscountPercent
      )
        throw new SalesOrderInputError(
          `O desconto combinado máximo permitido é ${settings.maxDiscountPercent}%.`,
        );
      const total = Math.max(
        0,
        Math.round((subtotal - discount + input.freightAmount) * 100) / 100,
      );
      const validUntil =
        input.kind === "quote" && !input.validUntil
          ? new Date(Date.now() + settings.quoteValidityDays * 86400000)
          : input.validUntil;
      const number = `${input.kind === "quote" ? "ORC" : "PED"}-${new Date().getUTCFullYear()}-${Date.now().toString().slice(-8)}`;
      const order = await db.$transaction(async (tx) => {
        if (idempotencyKey && requestHash)
          await tx.orderIdempotency.create({
            data: {
              key: idempotencyKey,
              requestHash,
              state: "processing",
              expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
            },
          });
        const customerName =
            customer?.tradeName ||
            customer?.name ||
            settings.defaultCustomerName,
          customerEmail = input.customerEmail || customer?.email || null,
          customerPhone = input.customerPhone || customer?.phone || null,
          customerDocument = customer?.document || null;
        const created = await tx.salesOrder.create({
          data: {
            number,
            branchId: profile.activeBranchId,
            kind: input.kind,
            origin:
              input.salesChannel === "marketplace" ? "marketplace" : "manual",
            customerId: input.customerId,
            customerName,
            customerDocument,
            customerEmail,
            customerPhone,
            contactName: input.contactName,
            salesChannel: input.salesChannel,
            salesperson: input.salesperson || salesperson.displayName,
            salespersonProfileId: salesperson.id,
            priority: input.priority,
            externalReference: input.externalReference,
            purchaseOrderNumber: input.purchaseOrderNumber,
            validUntil,
            expectedAt: input.expectedAt,
            subtotal,
            discount,
            discountType: input.discountType,
            discountValue: input.discountValue,
            freightAmount: input.freightAmount,
            freightType: input.freightType,
            shippingPending:
              input.freightType === "none" && input.deliveryType !== "pickup",
            total,
            paymentMethod: input.paymentMethod || settings.defaultPaymentMethod,
            paymentTitle: input.paymentMethod || settings.defaultPaymentMethod,
            paymentTerms: input.paymentTerms,
            paymentInstallments: input.paymentInstallments,
            firstDueDate: input.firstDueDate,
            deliveryType: input.deliveryType,
            deliveryZip: input.deliveryZip,
            deliveryStreet: input.deliveryStreet,
            deliveryNumber: input.deliveryNumber,
            deliveryComplement: input.deliveryComplement,
            deliveryDistrict: input.deliveryDistrict,
            deliveryCity: input.deliveryCity,
            deliveryState: input.deliveryState,
            notes: input.notes,
            internalNotes: input.internalNotes,
            termsAccepted: input.termsAccepted,
            createdBy: access.user.name,
            items: { create: orderItems },
            addresses: {
              create: [
                {
                  type: "billing",
                  firstName: customerName,
                  email: customerEmail,
                  phone: customerPhone,
                  document: customerDocument,
                },
                {
                  type: "shipping",
                  firstName: customerName,
                  email: customerEmail,
                  phone: customerPhone,
                  document: customerDocument,
                  zip: input.deliveryZip,
                  street: input.deliveryStreet,
                  number: input.deliveryNumber,
                  complement: input.deliveryComplement,
                  neighborhood: input.deliveryDistrict,
                  city: input.deliveryCity,
                  state: input.deliveryState,
                },
              ],
            },
            history: {
              create: {
                toStatus: "draft",
                actor: access.user.name,
                actorId: access.user.id,
                notes: "Orçamento/pedido criado com condições comerciais",
              },
            },
          },
          include,
        });
        await tx.tenantAuditEvent.create({
          data: {
            actorId: access.user.id,
            action: "sales_order.created",
            entityType: "sales_order",
            entityId: String(created.id),
            correlationId,
            afterData: {
              number,
              kind: created.kind,
              customerId: created.customerId,
              salespersonProfileId: salesperson.id,
              salesChannel: created.salesChannel,
              total: created.total,
              itemCount: created.items.length,
            },
          },
        });
        await enqueueWebhook(tx, "order.created", {
          id: created.id,
          number: created.number,
          status: created.status,
          total: created.total,
          occurred_at: new Date().toISOString(),
          correlation_id: correlationId,
        });
        if (idempotencyKey)
          await tx.orderIdempotency.update({
            where: { key: idempotencyKey },
            data: {
              state: "completed",
              salesOrderId: created.id,
              responseStatus: 201,
              responseBody: { orderId: created.id, number: created.number },
            },
          });
        return created;
      });
      return Response.json({ order, correlationId }, { status: 201 });
    }
    const id = orderId(body.orderId),
      before = await db.salesOrder.findFirst({
        where: { id, branchId: profile.activeBranchId },
        include,
      });
    if (!before)
      return Response.json(
        { error: "Orçamento ou pedido não encontrado." },
        { status: 404 },
      );
    if (body.action === "approve") {
      if (before.status !== "draft")
        throw new SalesOrderInputError(
          "Somente registros em rascunho podem ser aprovados.",
        );
      if (!branchAccess.canSell)
        throw new SalesOrderInputError(
          "Você não possui permissão comercial nesta filial.",
        );
      if (!before.branchId)
        throw new SalesOrderInputError(
          "O pedido não possui uma filial operacional vinculada.",
        );
      const order = await approve(
        db,
        { ...before, branchId: before.branchId },
        access.user,
        correlationId,
      );
      return Response.json({ order, correlationId });
    }
    if (body.action === "cancel") {
      if (
        !new Set([
          "draft",
          "approved",
          "pending",
          "processing",
          "on-hold",
          "preparing",
          "awaiting-shipping",
          "failed",
        ]).has(before.status)
      )
        throw new SalesOrderInputError(
          "Este registro não pode mais ser cancelado porque já entrou na expedição ou foi encerrado.",
        );
      const order = await cancel(db, before, access.user, correlationId);
      return Response.json({ order, correlationId });
    }
    if (body.action === "complete") {
      if (!before.branchId)
        throw new SalesOrderInputError(
          "O pedido não possui uma filial operacional vinculada.",
        );
      return await complete(
        db,
        { ...before, branchId: before.branchId },
        access.user,
        correlationId,
      );
    }
    throw new SalesOrderInputError("Ação comercial inválida.");
  } catch (error) {
    return failure(error);
  }
}

async function approve(
  db: Awaited<ReturnType<typeof tenantDb>>,
  before: WorkflowOrder,
  user: { id: string; name: string },
  correlationId: string,
) {
  const tenantSettings = await db.tenantSettings.findUnique({
    where: { id: 1 },
    select: { allowNegativeStock: true },
  });
  return db.$transaction(
    async (tx) => {
      const branch = await tx.branch.findUnique({
        where: { id: before.branchId },
        include: { settings: true, defaultWarehouse: true },
      });
      if (branch?.status !== "active" || !branch.defaultWarehouse?.active)
        throw new SalesOrderInputError(
          "A filial do pedido não possui depósito padrão ativo.",
        );
      if (branch.settings?.reserveStockOnOrder ?? true)
        await reserveOrderStock(
          tx,
          before,
          Boolean(tenantSettings?.allowNegativeStock),
        );
      const updated = await tx.salesOrder.update({
        where: { id: before.id },
        data: {
          kind: "order",
          status: "approved",
          approvedAt: new Date(),
          history: {
            create: {
              fromStatus: before.status,
              toStatus: "approved",
              actor: user.name,
              notes:
                branch.settings?.reserveStockOnOrder === false
                  ? "Aprovado sem reserva antecipada"
                  : "Estoque reservado por depósito",
            },
          },
        },
        include,
      });
      await enqueueStatusNotifications(tx, before.id, "approved");
      await tx.tenantAuditEvent.create({
        data: {
          actorId: user.id,
          action: "sales_order.approved",
          entityType: "sales_order",
          entityId: String(before.id),
          correlationId,
          beforeData: { status: before.status },
          afterData: {
            status: "approved",
            branchId: before.branchId,
            stockReserved: branch.settings?.reserveStockOnOrder !== false,
          },
        },
      });
      await enqueueWebhook(tx, "order.updated", {
        id: before.id,
        status: "approved",
        occurred_at: new Date().toISOString(),
        correlation_id: correlationId,
      });
      return updated;
    },
    { isolationLevel: "Serializable" },
  );
}

async function cancel(
  db: Awaited<ReturnType<typeof tenantDb>>,
  before: { id: number; status: string },
  user: { id: string; name: string },
  correlationId: string,
) {
  return db.$transaction(
    async (tx) => {
      await lockSalesOrderWithoutActivePosClaim(tx, before.id, before.status);
      const reservations = await tx.stockReservation.findMany({
        where: { salesOrderId: before.id, status: "active" },
      });
      for (const reservation of reservations) {
        const released = await tx.warehouseBalance.updateMany({
          where: {
            warehouseId: reservation.warehouseId,
            productId: reservation.productId,
            reservedQuantity: { gte: reservation.quantity },
          },
          data: { reservedQuantity: { decrement: reservation.quantity } },
        });
        if (!released.count)
          throw new SalesOrderInputError(
            "A reserva de estoque está inconsistente. Revise o saldo do depósito.",
          );
        if (reservation.variationId) {
          const variationReleased =
            await tx.warehouseVariationBalance.updateMany({
              where: {
                warehouseId: reservation.warehouseId,
                variationId: reservation.variationId,
                reservedQuantity: { gte: reservation.quantity },
              },
              data: { reservedQuantity: { decrement: reservation.quantity } },
            });
          if (!variationReleased.count)
            throw new SalesOrderInputError(
              "A reserva da variação está inconsistente. Revise o saldo do depósito.",
            );
        }
      }
      if (reservations.length)
        await tx.stockReservation.updateMany({
          where: { salesOrderId: before.id, status: "active" },
          data: { status: "released", releasedAt: new Date() },
        });
      const updated = await tx.salesOrder.update({
        where: { id: before.id },
        data: {
          status: "cancelled",
          history: {
            create: {
              fromStatus: before.status,
              toStatus: "cancelled",
              actor: user.name,
              notes: reservations.length
                ? "Reservas de estoque liberadas"
                : undefined,
            },
          },
        },
        include,
      });
      await enqueueStatusNotifications(tx, before.id, "cancelled");
      await tx.tenantAuditEvent.create({
        data: {
          actorId: user.id,
          action: "sales_order.cancelled",
          entityType: "sales_order",
          entityId: String(before.id),
          correlationId,
          beforeData: { status: before.status },
          afterData: {
            status: "cancelled",
            releasedReservations: reservations.length,
          },
        },
      });
      await enqueueWebhook(tx, "order.updated", {
        id: before.id,
        status: "cancelled",
        occurred_at: new Date().toISOString(),
        correlation_id: correlationId,
      });
      return updated;
    },
    { isolationLevel: "Serializable" },
  );
}

async function complete(
  db: Awaited<ReturnType<typeof tenantDb>>,
  before: WorkflowOrder,
  user: { id: string; name: string },
  correlationId: string,
) {
  if (
    !new Set([
      "approved",
      "processing",
      "on-hold",
      "preparing",
      "shipped",
      "out-delivery",
      "delivered",
    ]).has(before.status)
  )
    throw new SalesOrderInputError(
      "O pedido precisa estar aprovado ou em processamento antes de ser concluído.",
    );
  const settings = await db.tenantSettings.findUnique({
    where: { id: 1 },
    select: { allowNegativeStock: true },
  });
  const result = await db.$transaction(
    async (tx) => {
      await lockSalesOrderWithoutActivePosClaim(tx, before.id, before.status);
      const profile = await tx.tenantUserProfile.findUnique({
        where: { userId: user.id },
        select: { id: true },
      });
      const access = profile
        ? await tx.branchUserAccess.findUnique({
            where: {
              branchId_userProfileId: {
                branchId: before.branchId,
                userProfileId: profile.id,
              },
            },
          })
        : null;
      if (!access?.canSell)
        throw new SalesOrderInputError(
          "Você não possui permissão comercial nesta filial.",
        );
      const branch = await tx.branch.findUnique({
        where: { id: before.branchId },
        include: { defaultWarehouse: true },
      });
      const warehouse = branch?.defaultWarehouse;
      if (branch?.status !== "active" || !warehouse?.active)
        throw new SalesOrderInputError(
          "A filial do pedido não possui depósito padrão ativo.",
        );
      const source = { sourceType: "sales_order", sourceId: String(before.id) };
      const recordedSale = await tx.sale.findUnique({
        where: { sourceType_sourceId: source },
      });
      if (recordedSale) {
        const order = await tx.salesOrder.update({
          where: { id: before.id },
          data: {
            status: "completed",
            completedAt: new Date(),
            history: {
              create: {
                fromStatus: before.status,
                toStatus: "completed",
                actor: user.name,
                notes: "Venda e estoque já reconhecidos no despacho.",
              },
            },
          },
          include,
        });
        await enqueueStatusNotifications(tx, before.id, "completed");
        await tx.tenantAuditEvent.create({
          data: {
            actorId: user.id,
            action: "sales_order.completed",
            entityType: "sales_order",
            entityId: String(before.id),
            correlationId,
            beforeData: { status: before.status },
            afterData: {
              status: "completed",
              saleId: recordedSale.id,
              reusedFulfillment: true,
            },
          },
        });
        await enqueueWebhook(tx, "order.updated", {
          id: before.id,
          status: "completed",
          occurred_at: new Date().toISOString(),
          correlation_id: correlationId,
        });
        return { order, saleId: recordedSale.id };
      }
      await reserveOrderStock(
        tx,
        before,
        Boolean(settings?.allowNegativeStock),
      );
      const products = await tx.product.findMany({
        where: {
          id: { in: before.items.map((item) => item.productId) },
          active: true,
        },
      });
      const indexed = new Map(products.map((item) => [item.id, item]));
      const reservations = await tx.stockReservation.findMany({
        where: { salesOrderId: before.id, status: "active" },
        include: { warehouse: { select: { name: true } } },
      });
      const totalCents = Math.round(before.total * 100);
      const sale = await tx.sale.create({
        data: {
          saleNumber: `#${Date.now().toString().slice(-8)}`,
          branchId: warehouse.branchId,
          warehouseId: warehouse.id,
          customer: before.customerName,
          seller: before.salesperson || user.name,
          cashRegister: warehouse.name,
          paymentMethod: before.paymentMethod || "A definir",
          total: before.total,
          subtotalCents: totalCents,
          discountCents: 0,
          surchargeCents: 0,
          totalCents,
          changeCents: 0,
          ...source,
        },
      });
      for (const item of before.items) {
        const product = indexed.get(item.productId);
        if (!product)
          throw new SalesOrderInputError(
            `Produto indisponível: ${item.product.name}.`,
          );
        const unitPriceCents = Math.round(item.unitPrice * 100),
          lineTotalCents = Math.round(item.total * 100);
        await tx.saleItem.create({
          data: {
            saleId: sale.id,
            productId: item.productId,
            productName: product.name,
            quantity: item.quantity,
            unitPrice: item.unitPrice,
            total: item.total,
            unitPriceCents,
            grossCents: lineTotalCents,
            discountCents: 0,
            surchargeCents: 0,
            totalCents: lineTotalCents,
          },
        });
        if (product.type === "service") continue;
        const allocations = reservations.filter(
          (reservation) => reservation.orderItemId === item.id,
        );
        if (
          Math.abs(
            allocations.reduce(
              (sum, reservation) => sum + reservation.quantity,
              0,
            ) - item.quantity,
          ) > 0.0001
        )
          throw new SalesOrderInputError(
            `A reserva de ${product.name} está incompleta.`,
          );
        await tx.product.update({
          where: { id: product.id },
          data: { stock: { decrement: item.quantity } },
        });
        for (const reservation of allocations) {
          const [balance, variationBalance] = await Promise.all([
            tx.warehouseBalance.findUnique({
              where: {
                warehouseId_productId: {
                  warehouseId: reservation.warehouseId,
                  productId: product.id,
                },
              },
            }),
            reservation.variationId
              ? tx.warehouseVariationBalance.findUnique({
                  where: {
                    warehouseId_variationId: {
                      warehouseId: reservation.warehouseId,
                      variationId: reservation.variationId,
                    },
                  },
                })
              : null,
          ]);
          const authoritativeBalance = reservation.variationId
            ? variationBalance
            : balance;
          if (
            !balance ||
            !authoritativeBalance ||
            authoritativeBalance.reservedQuantity < reservation.quantity ||
            (!settings?.allowNegativeStock &&
              authoritativeBalance.quantity < reservation.quantity)
          )
            throw new SalesOrderInputError(
              `Saldo reservado inconsistente em ${reservation.warehouse.name} para ${product.name}.`,
            );
          await tx.warehouseBalance.update({
            where: { id: balance.id },
            data: {
              quantity: { decrement: reservation.quantity },
              reservedQuantity: { decrement: reservation.quantity },
            },
          });
          if (variationBalance)
            await tx.warehouseVariationBalance.update({
              where: { id: variationBalance.id },
              data: {
                quantity: { decrement: reservation.quantity },
                reservedQuantity: { decrement: reservation.quantity },
              },
            });
          await tx.stockMovement.create({
            data: {
              productId: product.id,
              variationId: reservation.variationId,
              warehouseId: reservation.warehouseId,
              type: "exit",
              quantity: reservation.quantity,
              previousStock: authoritativeBalance.quantity,
              currentStock:
                authoritativeBalance.quantity - reservation.quantity,
              note: `Pedido ${before.number}`,
              userName: user.name,
            },
          });
          await tx.warehouseLedgerEntry.create({
            data: {
              warehouseId: reservation.warehouseId,
              productId: product.id,
              variationId: reservation.variationId,
              type: "sale",
              quantity: -reservation.quantity,
              balanceBefore: authoritativeBalance.quantity,
              balanceAfter:
                authoritativeBalance.quantity - reservation.quantity,
              referenceType: "sales_order",
              referenceId: String(before.id),
              actor: user.name,
            },
          });
          await tx.stockReservation.update({
            where: { id: reservation.id },
            data: { status: "consumed", consumedAt: new Date() },
          });
        }
      }
      await tx.financialTitle.create({
        data: {
          type: "receivable",
          description: `Pedido ${before.number}`,
          customerId: before.customerId,
          documentNumber: before.number,
          sourceType: "sales_order",
          sourceId: String(before.id),
          amount: before.total,
          dueAt: before.firstDueDate || before.expectedAt || new Date(),
        },
      });
      const order = await tx.salesOrder.update({
        where: { id: before.id },
        data: {
          status: "completed",
          completedAt: new Date(),
          history: {
            create: {
              fromStatus: before.status,
              toStatus: "completed",
              actor: user.name,
            },
          },
        },
        include,
      });
      await enqueueStatusNotifications(tx, before.id, "completed");
      await tx.tenantAuditEvent.create({
        data: {
          actorId: user.id,
          action: "sales_order.completed",
          entityType: "sales_order",
          entityId: String(before.id),
          correlationId,
          beforeData: { status: before.status },
          afterData: {
            status: "completed",
            saleId: sale.id,
            warehouseId: warehouse.id,
            financialAmount: before.total,
          },
        },
      });
      await enqueueWebhook(tx, "order.updated", {
        id: before.id,
        status: "completed",
        occurred_at: new Date().toISOString(),
        correlation_id: correlationId,
      });
      return { order, saleId: sale.id };
    },
    { isolationLevel: "Serializable" },
  );
  return Response.json({ ...result, correlationId });
}

async function lockSalesOrderWithoutActivePosClaim(
  tx: Prisma.TransactionClient,
  salesOrderId: number,
  expectedStatus: string,
) {
  await tx.$queryRaw(
    Prisma.sql`SELECT "id" FROM "sales_orders" WHERE "id" = ${salesOrderId} FOR UPDATE`,
  );
  const [order, activeClaim] = await Promise.all([
    tx.salesOrder.findUnique({
      where: { id: salesOrderId },
      select: { status: true },
    }),
    tx.posOrderClaim.findFirst({
      where: { salesOrderId, state: "active" },
      select: { id: true },
    }),
  ]);
  if (!order || order.status !== expectedStatus)
    throw new SalesOrderInputError(
      "O pedido mudou durante a operação. Atualize antes de repetir.",
    );
  if (activeClaim)
    throw new SalesOrderInputError(
      "O pedido está reivindicado no PDV. Conclua ou libere o claim antes de cancelar ou completar.",
    );
}

function failure(error: unknown) {
  if (error instanceof HttpSecurityError) return authErrorResponse(error);
  if (
    error instanceof SalesOrderInputError ||
    error instanceof CustomerInputError
  )
    return Response.json(
      { error: error.message },
      {
        status: error.message.includes("reivindicado no PDV")
          ? 409
          : error.message.includes("Origem")
            ? 403
            : 400,
      },
    );
  if (error instanceof LicenseDeniedError)
    return Response.json({ error: error.message }, { status: error.status });
  if (
    error &&
    typeof error === "object" &&
    "code" in error &&
    error.code === "P2002"
  )
    return Response.json(
      { error: "A operação já foi processada ou possui número duplicado." },
      { status: 409 },
    );
  if (
    error instanceof Error &&
    error.message.includes("active pos_order_claim")
  )
    return Response.json(
      { error: "O pedido está reivindicado no PDV e não pode ser alterado." },
      { status: 409 },
    );
  if (error instanceof AuthError) return authErrorResponse(error);
  return unexpectedErrorResponse("erp.orders", error);
}
