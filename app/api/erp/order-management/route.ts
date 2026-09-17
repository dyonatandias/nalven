import { randomUUID } from "node:crypto";
import { currentOrganization, tenantDb } from "@/db";
import type { Prisma } from "@/generated/tenant/client";
import { AuthError, authErrorResponse } from "@/lib/auth";
import { LicenseDeniedError } from "@/lib/billing/license";
import { assertSameOrigin } from "@/lib/erp/customer-input";
import { assertTenantPermission } from "@/lib/erp/permissions";
import {
  cleanText,
  csvCell,
  maskRecipient,
  ORDER_INCLUDE,
  OrderDomainError,
  resolveCarrier,
  safeAmount,
  safeId,
  safeUrl,
  transitionOrder,
  validStatus,
} from "@/lib/erp/order-domain";
import { assertTenantWriteAccess } from "@/lib/tenant-access";
import { decryptSecrets, IntegrationError, objectValue, persistentRateLimit, redact } from "@/lib/integrations/core";
import { safeRequest } from "@/lib/integrations/security";
import { HttpSecurityError, readJsonObject } from "@/lib/http-security";

const SORT_FIELDS = {
  date: "createdAt",
  id: "id",
  number: "number",
  status: "status",
  modified: "updatedAt",
  customer: "customerName",
  total: "total",
} as const;
const PAID_STATUSES = [
  "processing",
  "preparing",
  "shipped",
  "out-delivery",
  "delivered",
  "completed",
  "refunded",
];

async function context(permission: "orders.read" | "orders.write") {
  const organization = await currentOrganization();
  const access = await assertTenantPermission(organization.id, permission);
  const db = await tenantDb(organization.id);
  const profile = await db.tenantUserProfile.findUnique({
    where: { userId: access.user.id },
    select: { id: true, activeBranchId: true },
  });
  if (!profile?.activeBranchId)
    throw new OrderDomainError("Selecione uma filial ativa.");
  if (
    !(await db.branchUserAccess.findFirst({
      where: { branchId: profile.activeBranchId, userProfileId: profile.id },
    }))
  )
    throw new OrderDomainError("Você não possui acesso à filial ativa.", 403);
  return {
    organization,
    access,
    db,
    branchId: profile.activeBranchId,
    profileId: profile.id,
  };
}

export async function GET(request: Request) {
  try {
    const { organization, db, branchId, access } = await context("orders.read");
    const params = new URL(request.url).searchParams;
    await persistentRateLimit(
      db,
      `${access.user.id}:${params.get("format") === "csv" ? "export" : "search"}`,
      params.get("format") === "csv" ? 5 : 60,
      60,
    );
    const page = integer(
        params.get("page") || 1,
        1,
        Number.MAX_SAFE_INTEGER,
        "Página inválida.",
      ),
      perPage = integer(
        params.get("per_page") || 20,
        1,
        100,
        "Limite por página inválido.",
      );
    const sort = params.get("orderby") || "date",
      direction = params.get("order") === "asc" ? "asc" : "desc";
    if (!(sort in SORT_FIELDS))
      throw new OrderDomainError(
        `Ordenação inválida. Use: ${Object.keys(SORT_FIELDS).join(", ")}.`,
      );
    const after = dateParam(params.get("after")),
      before = dateParam(params.get("before"), true),
      search = cleanText(params.get("search"), 160);
    const statuses = (params.get("status") || "")
        .split(",")
        .map((item) => item.trim())
        .filter(Boolean),
      origin = cleanText(params.get("origin"), 40),
      paymentMethod = cleanText(params.get("payment_method"), 80),
      kind = cleanText(params.get("kind"), 20),
      customerId = params.get("customer_id")
        ? safeId(params.get("customer_id"), "Cliente")
        : null;
    const minimumTotal = optionalAmount(params.get("min_total")),
      maximumTotal = optionalAmount(params.get("max_total"));
    if (
      minimumTotal !== null &&
      maximumTotal !== null &&
      minimumTotal > maximumTotal
    )
      throw new OrderDomainError("O valor mínimo não pode superar o máximo.");
    const trash = params.get("trash") === "true",
      shippingPending = params.get("shipping_pending") === "true";
    const where: Prisma.SalesOrderWhereInput = {
      branchId,
      deletedAt: trash ? { not: null } : null,
      ...(statuses.length ? { status: { in: statuses } } : {}),
      ...(shippingPending ? { shippingPending: true } : {}),
      ...(origin ? { origin } : {}),
      ...(paymentMethod ? { paymentMethod } : {}),
      ...(kind ? { kind } : {}),
      ...(customerId ? { customerId } : {}),
      ...(minimumTotal !== null || maximumTotal !== null
        ? {
            total: {
              ...(minimumTotal !== null ? { gte: minimumTotal } : {}),
              ...(maximumTotal !== null ? { lte: maximumTotal } : {}),
            },
          }
        : {}),
      ...(after || before
        ? {
            createdAt: {
              ...(after ? { gte: after } : {}),
              ...(before ? { lte: before } : {}),
            },
          }
        : {}),
      ...(search
        ? {
            OR: [
              { number: { contains: search, mode: "insensitive" } },
              { customerName: { contains: search, mode: "insensitive" } },
              { customerEmail: { contains: search, mode: "insensitive" } },
              { customerPhone: { contains: search } },
              { customerDocument: { contains: search } },
            ],
          }
        : {}),
    };
    if (params.get("format") === "csv") return exportCsv(db, where);
    const revenueWhere: Prisma.SalesOrderWhereInput = {
      ...where,
      status: { in: PAID_STATUSES },
    };
    const [
      items,
      total,
      revenue,
      refunded,
      itemQuantity,
      statusesDefinition,
      carriers,
      customers,
      productRows,
      settings,
      returns,
      queue,
      integrationProviders,
      byStatus,
      byPayment,
      byState,
    ] = await Promise.all([
      db.salesOrder.findMany({
        where,
        include: ORDER_INCLUDE,
        orderBy: { [SORT_FIELDS[sort as keyof typeof SORT_FIELDS]]: direction },
        skip: (page - 1) * perPage,
        take: perPage,
      }),
      db.salesOrder.count({ where }),
      db.salesOrder.aggregate({
        where: revenueWhere,
        _sum: { total: true },
        _avg: { total: true },
      }),
      db.orderRefund.aggregate({
        where: { salesOrder: where },
        _sum: { amount: true },
      }),
      db.salesOrderItem.aggregate({
        where: { salesOrder: where },
        _sum: { quantity: true },
      }),
      db.orderStatusDefinition.findMany({ orderBy: { position: "asc" } }),
      db.shippingCarrier.findMany({
        where: { active: true },
        orderBy: { position: "asc" },
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
        take: 500,
      }),
      db.product.findMany({
        where: {
          active: true,
          branchConfigurations: {
            some: { branchId, active: true, saleEnabled: true },
          },
        },
        include: {
          branchConfigurations: { where: { branchId } },
          warehouseBalances: { where: { warehouse: { branchId } } },
          variations: {
            where: { enabled: true },
            orderBy: { menuOrder: "asc" },
          },
        },
        orderBy: { name: "asc" },
        take: 1000,
      }),
      db.orderNotificationSettings.findUnique({ where: { id: 1 } }),
      db.orderReturn.findMany({
        where: { salesOrder: { branchId } },
        include: {
          salesOrder: {
            select: { id: true, number: true, customerName: true },
          },
          items: true,
        },
        orderBy: { requestedAt: "desc" },
        take: 50,
      }),
      db.orderNotificationQueue.findMany({
        where: { salesOrder: { branchId } },
        include: {
          salesOrder: { select: { number: true, customerName: true } },
        },
        orderBy: { createdAt: "desc" },
        take: 50,
      }),
      db.integrationCredential.findMany({
        where: { enabled: true, providerId: "smtp" },
        select: { providerId: true, label: true, lastTestOk: true },
      }),
      db.salesOrder.groupBy({
        by: ["status"],
        where,
        _count: { _all: true },
        _sum: { total: true },
      }),
      db.salesOrder.groupBy({
        by: ["paymentMethod"],
        where,
        _count: { _all: true },
        _sum: { total: true },
      }),
      db.salesOrder.groupBy({
        by: ["deliveryState"],
        where,
        _count: { _all: true },
        _sum: { total: true },
      }),
    ]);
    const products = productRows.map(
      ({ branchConfigurations, warehouseBalances, ...product }) => ({
        ...product,
        price: branchConfigurations[0]?.priceOverride ?? product.price,
        availableStock: warehouseBalances.reduce(
          (sum, row) => sum + row.quantity - row.reservedQuantity,
          0,
        ),
      }),
    );
    return Response.json({
      organization: { slug: organization.slug, name: organization.name },
      items,
      statuses: statusesDefinition,
      carriers,
      customers,
      products,
      returns,
      queue,
      notificationSettings: settings,
      notificationProvider: {
        emailConfigured: integrationProviders.some(
          (item) => item.providerId === "smtp",
        ),
        providers: integrationProviders.map((item) => ({
          id: item.providerId,
          label: item.label,
          tested: item.lastTestOk,
        })),
      },
      pagination: {
        page,
        perPage,
        total,
        pages: Math.max(1, Math.ceil(total / perPage)),
      },
      summary: {
        total,
        revenue: revenue._sum.total || 0,
        averageTicket: revenue._avg.total || 0,
        refunded: refunded._sum.amount || 0,
        items: itemQuantity._sum.quantity || 0,
      },
      analytics: { byStatus, byPayment, byState },
    });
  } catch (error) {
    return failure(error);
  }
}

export async function POST(request: Request) {
  try {
    assertSameOrigin(request);
    const { organization, access, db, branchId } =
      await context("orders.write");
    await assertTenantWriteAccess(organization.id);
    const body = await readJsonObject(request, 1_048_576),
      action = cleanText(body.action, 60, true),
      correlationId = randomUUID();
    const actor = { id: access.user.id, name: access.user.name };
    if (action === "status") {
      const id = safeId(body.orderId),
        status = await validStatus(db, body.status),
        reason = cleanText(body.reason, 500);
      if (new Set(["approved", "completed", "cancelled"]).has(status))
        throw new OrderDomainError(
          "Use a ação operacional específica para aprovar, concluir ou cancelar; ela protege estoque, financeiro e auditoria.",
          422,
        );
      if (body.confirmRegression === true && !reason)
        throw new OrderDomainError(
          "Informe o motivo para confirmar uma regressão ou transição excepcional.",
          422,
        );
      const order = await db.$transaction(async (tx) => {
        const updated = await transitionOrder(
          tx,
          id,
          status,
          actor,
          reason,
          body.confirmRegression === true,
        );
        await tx.tenantAuditEvent.create({
          data: {
            actorId: actor.id,
            action: "sales_order.status_changed",
            entityType: "sales_order",
            entityId: String(id),
            correlationId,
            afterData: { status },
          },
        });
        return updated;
      });
      return Response.json({ order, correlationId });
    }
    if (action === "bulk-status") {
      const ids = idsValue(body.ids),
        status = await validStatus(db, body.status),
        reason = cleanText(body.reason, 500),
        failed: Array<{ id: number; error: string }> = [];
      let succeeded = 0;
      if (new Set(["approved", "completed", "cancelled"]).has(status))
        throw new OrderDomainError(
          "Aprovação, conclusão e cancelamento exigem processamento individual do estoque e financeiro.",
          422,
        );
      if (body.confirmRegression === true && !reason)
        throw new OrderDomainError(
          "Informe o motivo para confirmar regressões em lote.",
          422,
        );
      for (const id of ids) {
        try {
          await db.$transaction((tx) =>
            transitionOrder(
              tx,
              id,
              status,
              actor,
              reason,
              body.confirmRegression === true,
            ),
          );
          succeeded++;
        } catch (error) {
          failed.push({ id, error: error instanceof OrderDomainError ? error.message : "Falha ao alterar este pedido." });
        }
      }
      return Response.json({ requested: ids.length, succeeded, failed });
    }
    if (action === "trash" || action === "restore") {
      const ids = idsValue(body.ids),
        deletedAt = action === "trash" ? new Date() : null;
      const result = await db.salesOrder.updateMany({
        where: { id: { in: ids }, branchId },
        data: { deletedAt },
      });
      return Response.json({
        requested: ids.length,
        succeeded: result.count,
        failed: [],
      });
    }
    if (action === "delete-permanently") {
      if (body.confirmation !== "EXCLUIR")
        throw new OrderDomainError(
          'Digite "EXCLUIR" para confirmar a remoção permanente.',
        );
      const ids = idsValue(body.ids);
      const result = await db.salesOrder.deleteMany({
        where: { id: { in: ids }, branchId, deletedAt: { not: null } },
      });
      return Response.json({
        requested: ids.length,
        succeeded: result.count,
        failed: [],
      });
    }
    if (action === "notification-settings") {
      const settings = body.settings;
      if (!settings || typeof settings !== "object" || Array.isArray(settings))
        throw new OrderDomainError("Configurações de notificação inválidas.");
      if (JSON.stringify(settings).length > 100_000)
        throw new OrderDomainError(
          "As configurações de notificação excedem o limite permitido.",
          413,
        );
      const normalizedSettings = { ...(settings as Record<string, unknown>) };
      normalizedSettings.logRetentionDays = integer(
        normalizedSettings.logRetentionDays || 90,
        7,
        3650,
        "Retenção do log inválida.",
      );
      normalizedSettings.piiRetentionDays = integer(
        normalizedSettings.piiRetentionDays || 365,
        30,
        3650,
        "Retenção de dados pessoais inválida.",
      );
      if (
        normalizedSettings.dailySummary &&
        typeof normalizedSettings.dailySummary === "object" &&
        !Array.isArray(normalizedSettings.dailySummary)
      ) {
        const daily = normalizedSettings.dailySummary as Record<
          string,
          unknown
        >;
        normalizedSettings.dailySummary = {
          ...daily,
          hour: integer(daily.hour ?? 18, 0, 23, "Hora do resumo inválida."),
          timezone: timezone(daily.timezone),
          recipients: stringList(daily.recipients, 100, 320),
        };
      }
      const allowedStatuses = new Set(
        (
          await db.orderStatusDefinition.findMany({ select: { key: true } })
        ).map((item) => item.key),
      );
      normalizedSettings.matrix = normalizeMatrix(
        normalizedSettings.matrix,
        allowedStatuses,
      );
      normalizedSettings.policies = normalizePolicies(
        normalizedSettings.policies,
        allowedStatuses,
      );
      delete normalizedSettings.whatsappAdmin;
      delete normalizedSettings.whatsappCustomer;
      delete normalizedSettings.whatsappProvider;
      const saved = await db.orderNotificationSettings.upsert({
        where: { id: 1 },
        update: {
          enabled: body.enabled === true,
          settings: normalizedSettings as Prisma.InputJsonValue,
          updatedBy: actor.name,
        },
        create: {
          id: 1,
          enabled: body.enabled === true,
          settings: normalizedSettings as Prisma.InputJsonValue,
          updatedBy: actor.name,
        },
      });
      return Response.json({ settings: saved });
    }
    if (action === "status-save") {
      const key = cleanText(body.key, 60, true).toLowerCase();
      if (!/^[a-z0-9-]+$/.test(key))
        throw new OrderDomainError(
          "A chave aceita apenas letras, números e hífen.",
        );
      const existing = await db.orderStatusDefinition.findUnique({
        where: { key },
      });
      const data = {
        label: cleanText(body.label, 80, true),
        color: /^#[0-9a-f]{6}$/i.test(String(body.color))
          ? String(body.color)
          : "#64748b",
        icon: cleanText(body.icon, 50) || null,
        description: cleanText(body.description, 500) || null,
        position: integer(body.position || 500, 0, 10000, "Posição inválida."),
        emailTemplate: body.emailTemplate
          ? (body.emailTemplate as Prisma.InputJsonValue)
          : undefined,
      };
      const status = existing
        ? await db.orderStatusDefinition.update({ where: { key }, data })
        : await db.orderStatusDefinition.create({
            data: { key, ...data, native: false },
          });
      return Response.json({ status }, { status: existing ? 200 : 201 });
    }
    if (action === "status-delete") {
      const key = cleanText(body.key, 60, true),
        status = await db.orderStatusDefinition.findUnique({ where: { key } });
      if (!status) throw new OrderDomainError("Status não encontrado.", 404);
      if (status.native)
        throw new OrderDomainError(
          "Status nativos não podem ser excluídos.",
          422,
        );
      const used = await db.salesOrder.count({ where: { status: key } });
      if (used)
        throw new OrderDomainError(
          `Há ${used} pedido(s) usando este status. Migre-os antes de excluir.`,
          409,
        );
      await db.orderStatusDefinition.delete({ where: { key } });
      return Response.json({ ok: true });
    }
    if (action === "queue-retry" || action === "queue-cancel") {
      const queueId = safeId(body.queueId, "Item da fila"),
        state = action === "queue-retry" ? "pending" : "cancelled";
      const updated = await db.orderNotificationQueue.updateMany({
        where: { id: queueId, salesOrder: { branchId } },
        data: {
          state,
          nextAttemptAt: action === "queue-retry" ? new Date() : undefined,
          attempts: action === "queue-retry" ? 0 : undefined,
          claimedAt: null,
          lastError: null,
        },
      });
      if (!updated.count)
        throw new OrderDomainError("Item da fila não encontrado.", 404);
      return Response.json({ ok: true });
    }
    const orderId = safeId(body.orderId),
      order = await db.salesOrder.findFirst({
        where: { id: orderId, branchId, deletedAt: null },
        include: ORDER_INCLUDE,
      });
    if (!order) throw new OrderDomainError("Pedido não encontrado.", 404);
    if (action === "shipping-quote") {
      if (!order.deliveryZip)
        throw new OrderDomainError(
          "Informe o CEP de entrega antes de cotar o frete.",
          422,
        );
      const credential = await db.integrationCredential.findFirst({
          where: { providerId: "shipping", enabled: true },
          orderBy: [{ isDefault: "desc" }, { createdAt: "asc" }],
        }),
        integrationSettings = await db.integrationSettings.findUnique({
          where: { id: 1 },
        }),
        shippingSettings = objectValue(integrationSettings?.shipping),
        fallback = Number(
          shippingSettings.fallback_flat_rate ||
            (credential
              ? objectValue(credential.config).fallback_flat_rate
              : 0) ||
            0,
        );
      let responseData: Record<string, unknown> = {},
        provider = "manual-fallback";
      if (credential) {
        const config = objectValue(credential.config),
          secrets = decryptSecrets(credential.secretsCipherText),
          endpoint = `${String(config.base_url).replace(/\/$/, "")}/quotes`;
        const response = await safeRequest(endpoint, {
          method: "POST",
          timeoutMs: 15000,
          headers: {
            authorization: `Bearer ${secrets.token}`,
            "content-type": "application/json",
          },
          body: JSON.stringify({
            origin_postcode: config.origin_postcode,
            destination_postcode: order.deliveryZip,
            order_id: order.number,
            items: order.items.map((item) => ({
              sku: item.skuSnapshot,
              quantity: item.quantity,
              unit_price: item.unitPrice,
            })),
          }),
        });
        if (response.status < 200 || response.status >= 300)
          throw new OrderDomainError(
            `O provedor de frete recusou a cotação (HTTP ${response.status}).`,
            502,
          );
        try {
          responseData = objectValue(JSON.parse(response.body));
        } catch {
          throw new OrderDomainError(
            "O provedor de frete retornou uma resposta inválida.",
            502,
          );
        }
        provider = credential.label;
      }
      const rawQuotes = Array.isArray(responseData.quotes)
          ? responseData.quotes
          : Array.isArray(responseData.data)
            ? responseData.data
            : [],
        quotes = rawQuotes.map(objectValue).slice(0, 30);
      if (!quotes.length && fallback <= 0)
        throw new OrderDomainError(
          "Nenhum serviço de frete foi retornado e não há tarifa de continuidade configurada.",
          422,
        );
      const created = await db.$transaction(async (tx) => {
        await tx.orderShippingLabel.deleteMany({
          where: { salesOrderId: order.id, status: "quoted" },
        });
        const rows = quotes.length
          ? quotes
          : [
              {
                id: "fallback",
                name: "Tarifa de continuidade",
                company: "Configuração da organização",
                price: fallback,
              },
            ];
        const result = [];
        for (const quote of rows)
          result.push(
            await tx.orderShippingLabel.create({
              data: {
                salesOrderId: order.id,
                provider,
                serviceId: cleanText(quote.id ?? quote.service_id, 160) || null,
                serviceName:
                  cleanText(quote.name ?? quote.service_name, 160) ||
                  "Serviço de frete",
                carrier: cleanText(quote.company ?? quote.carrier, 160) || null,
                amount: safeAmount(
                  quote.price ?? quote.amount ?? fallback,
                  "Valor do frete",
                  true,
                ),
                quotation: redact(quote) as Prisma.InputJsonValue,
                createdBy: actor.name,
              },
            }),
          );
        return result;
      });
      return Response.json({ quotes: created }, { status: 201 });
    }
    if (action === "shipping-label-purchase") {
      const labelId = safeId(body.labelId, "Cotação"),
        label = await db.orderShippingLabel.findFirst({
          where: { id: labelId, salesOrderId: order.id, status: "quoted" },
        });
      if (!label)
        throw new OrderDomainError(
          "Cotação de frete não encontrada ou já processada.",
          404,
        );
      const credential = await db.integrationCredential.findFirst({
        where: { providerId: "shipping", enabled: true },
        orderBy: [{ isDefault: "desc" }, { createdAt: "asc" }],
      });
      if (!credential)
        throw new OrderDomainError(
          "Configure e teste o provedor de frete antes de comprar a etiqueta.",
          422,
        );
      const config = objectValue(credential.config),
        secrets = decryptSecrets(credential.secretsCipherText),
        response = await safeRequest(
          `${String(config.base_url).replace(/\/$/, "")}/labels`,
          {
            method: "POST",
            timeoutMs: 20000,
            headers: {
              authorization: `Bearer ${secrets.token}`,
              "content-type": "application/json",
            },
            body: JSON.stringify({
              order_id: order.number,
              service_id: label.serviceId,
              invoice: {
                number: cleanText(body.invoiceNumber, 80),
                key: cleanText(body.invoiceKey, 80),
                non_commercial: body.nonCommercial === true,
              },
              recipient: order.addresses.find(
                (item) => item.type === "shipping",
              ),
              items: order.items.map((item) => ({
                sku: item.skuSnapshot,
                name: item.nameSnapshot,
                quantity: item.quantity,
                unit_price: item.unitPrice,
              })),
            }),
          },
        );
      if (response.status < 200 || response.status >= 300)
        throw new OrderDomainError(
          `O provedor não concluiu a etiqueta (HTTP ${response.status}).`,
          502,
        );
      let remote: Record<string, unknown>;
      try {
        remote = objectValue(JSON.parse(response.body));
      } catch {
        throw new OrderDomainError(
          "Resposta inválida ao comprar a etiqueta.",
          502,
        );
      }
      const labelUrl = safeUrl(remote.label_url ?? remote.pdf_url),
        trackingUrl = safeUrl(remote.tracking_url),
        trackingCode = cleanText(remote.tracking_code, 160),
        externalId = cleanText(remote.id ?? remote.external_id, 160),
        protocol = cleanText(remote.protocol, 160);
      const saved = await db.$transaction(async (tx) => {
        const updated = await tx.orderShippingLabel.update({
          where: { id: label.id },
          data: {
            status: "purchased",
            statusLabel: "Etiqueta comprada",
            externalId: externalId || null,
            protocol: protocol || null,
            invoiceNumber: cleanText(body.invoiceNumber, 80) || null,
            invoiceKey: cleanText(body.invoiceKey, 80) || null,
            nonCommercial: body.nonCommercial === true,
            labelUrl,
            trackingCode: trackingCode || null,
            trackingUrl,
            rawData: redact(remote) as Prisma.InputJsonValue,
            purchasedAt: new Date(),
          },
        });
        if (labelUrl)
          await tx.orderDocument.create({
            data: {
              salesOrderId: order.id,
              type: "shipping_label",
              name: `Etiqueta ${order.number}`,
              externalUrl: labelUrl,
              mimeType: "application/pdf",
              createdBy: actor.name,
            },
          });
        if (trackingCode) {
          const tracking = await tx.orderTracking.upsert({
            where: { salesOrderId: order.id },
            update: {
              trackingNumber: trackingCode,
              carrier: label.carrier,
              trackingUrl,
            },
            create: {
              salesOrderId: order.id,
              trackingNumber: trackingCode,
              carrier: label.carrier,
              trackingUrl,
            },
          });
          await tx.orderTrackingEvent.create({
            data: {
              trackingId: tracking.id,
              status: "registered",
              description: "Rastreio recebido na emissão da etiqueta",
            },
          });
        }
        await tx.salesOrder.update({
          where: { id: order.id },
          data: { shippingPending: false },
        });
        await tx.orderNote.create({
          data: {
            salesOrderId: order.id,
            content: `Etiqueta comprada: ${label.serviceName || "serviço"} · ${label.amount.toLocaleString("pt-BR", { style: "currency", currency: "BRL" })}.`,
            author: "Sistema",
            authorType: "system",
          },
        });
        return updated;
      });
      return Response.json({ label: saved });
    }
    if (action === "shipping-label-cancel") {
      if (body.confirmation !== "CANCELAR")
        throw new OrderDomainError(
          'Digite "CANCELAR" para confirmar o cancelamento da etiqueta.',
        );
      const labelId = safeId(body.labelId, "Etiqueta"),
        label = await db.orderShippingLabel.findFirst({
          where: {
            id: labelId,
            salesOrderId: order.id,
            status: { in: ["purchased", "ready"] },
          },
        });
      if (!label)
        throw new OrderDomainError("Etiqueta ativa não encontrada.", 404);
      if (label.externalId) {
        const credential = await db.integrationCredential.findFirst({
          where: { providerId: "shipping", enabled: true },
          orderBy: [{ isDefault: "desc" }, { createdAt: "asc" }],
        });
        if (!credential)
          throw new OrderDomainError(
            "A credencial usada na compra precisa estar ativa para cancelar a etiqueta.",
            422,
          );
        const config = objectValue(credential.config),
          secrets = decryptSecrets(credential.secretsCipherText),
          response = await safeRequest(
            `${String(config.base_url).replace(/\/$/, "")}/labels/${encodeURIComponent(label.externalId)}/cancel`,
            {
              method: "POST",
              timeoutMs: 15000,
              headers: {
                authorization: `Bearer ${secrets.token}`,
                "content-type": "application/json",
              },
              body: "{}",
            },
          );
        if (response.status < 200 || response.status >= 300)
          throw new OrderDomainError(
            `O provedor recusou o cancelamento (HTTP ${response.status}).`,
            502,
          );
      }
      const saved = await db.orderShippingLabel.update({
        where: { id: label.id },
        data: {
          status: "cancelled",
          statusLabel: "Etiqueta cancelada",
          cancelledAt: new Date(),
        },
      });
      await db.orderNote.create({
        data: {
          salesOrderId: order.id,
          content: `Etiqueta ${label.protocol || label.id} cancelada por ${actor.name}.`,
          author: "Sistema",
          authorType: "system",
        },
      });
      return Response.json({ label: saved });
    }
    if (action === "note") {
      const content = cleanText(body.content, 10000, true),
        visible = body.customerVisible === true;
      const note = await db.$transaction(async (tx) => {
        const saved = await tx.orderNote.create({
          data: {
            salesOrderId: order.id,
            content,
            customerVisible: visible,
            author: actor.name,
            authorType: "user",
          },
        });
        if (visible && order.customerEmail)
          await tx.orderNotificationQueue.create({
            data: {
              salesOrderId: order.id,
              statusTrigger: `customer-note-${saved.id}`,
              channel: "email",
              recipientType: "customer",
              dedupKey: `order:${order.id}:note:${saved.id}:email:customer`,
              force: true,
              payload: { message: content },
            },
          });
        return saved;
      });
      return Response.json({ note }, { status: 201 });
    }
    if (action === "customer-link") {
      const customerId = safeId(body.customerId, "Cliente"),
        customer = await db.customer.findFirst({
          where: { id: customerId, status: "active" },
        });
      if (!customer)
        throw new OrderDomainError("Cliente ativo não encontrado.", 404);
      const updated = await db.$transaction(async (tx) => {
        const saved = await tx.salesOrder.update({
          where: { id: order.id },
          data: {
            customerId: customer.id,
            customerName: customer.tradeName || customer.name,
            customerDocument: customer.document,
            customerEmail: customer.email,
            customerPhone: customer.phone,
          },
          include: ORDER_INCLUDE,
        });
        await tx.orderNote.create({
          data: {
            salesOrderId: order.id,
            content: `Pedido vinculado ao cliente ${customer.tradeName || customer.name} por ${actor.name}.`,
            author: "Sistema",
            authorType: "system",
          },
        });
        return saved;
      });
      return Response.json({ order: updated });
    }
    if (action === "address") {
      const addressType = cleanText(body.addressType, 20, true);
      if (!new Set(["billing", "shipping"]).has(addressType))
        throw new OrderDomainError("Tipo de endereço inválido.");
      if (
        !body.address ||
        typeof body.address !== "object" ||
        Array.isArray(body.address)
      )
        throw new OrderDomainError("Endereço inválido.");
      const raw = body.address as Record<string, unknown>,
        allowed = new Set([
          "firstName",
          "lastName",
          "company",
          "email",
          "phone",
          "documentType",
          "document",
          "zip",
          "street",
          "number",
          "complement",
          "neighborhood",
          "city",
          "state",
          "country",
        ]),
        unknown = Object.keys(raw).filter((key) => !allowed.has(key));
      if (unknown.length)
        throw new OrderDomainError(
          `Campos de endereço não permitidos: ${unknown.join(", ")}.`,
        );
      const state = cleanText(raw.state, 2).toUpperCase();
      if (state && !/^[A-Z]{2}$/.test(state))
        throw new OrderDomainError("UF inválida.");
      const values = {
        firstName: cleanText(raw.firstName, 500) || null,
        lastName: cleanText(raw.lastName, 500) || null,
        company: cleanText(raw.company, 500) || null,
        email: cleanText(raw.email, 254).toLowerCase() || null,
        phone: cleanText(raw.phone, 40) || null,
        documentType: cleanText(raw.documentType, 10) || null,
        document: cleanText(raw.document, 30) || null,
        zip: cleanText(raw.zip, 12).replace(/\D/g, "") || null,
        street: cleanText(raw.street, 500) || null,
        number: cleanText(raw.number, 60) || null,
        complement: cleanText(raw.complement, 500) || null,
        neighborhood: cleanText(raw.neighborhood, 500) || null,
        city: cleanText(raw.city, 500) || null,
        state: state || null,
        country: cleanText(raw.country, 2).toUpperCase() || "BR",
      };
      const saved = await db.$transaction(async (tx) => {
        const before = await tx.orderAddress.findUnique({
          where: {
            salesOrderId_type: { salesOrderId: order.id, type: addressType },
          },
        });
        const address = await tx.orderAddress.upsert({
          where: {
            salesOrderId_type: { salesOrderId: order.id, type: addressType },
          },
          update: values,
          create: { salesOrderId: order.id, type: addressType, ...values },
        });
        if (addressType === "shipping")
          await tx.salesOrder.update({
            where: { id: order.id },
            data: {
              deliveryZip: values.zip,
              deliveryStreet: values.street,
              deliveryNumber: values.number,
              deliveryComplement: values.complement,
              deliveryDistrict: values.neighborhood,
              deliveryCity: values.city,
              deliveryState: values.state,
            },
          });
        if (body.syncCustomer === true && order.customerId)
          await tx.customerAddress.updateMany({
            where: { customerId: order.customerId, primary: true },
            data: {
              zip: values.zip,
              street: values.street,
              number: values.number,
              complement: values.complement,
              district: values.neighborhood,
              city: values.city,
              state: values.state,
            },
          });
        await tx.orderNote.create({
          data: {
            salesOrderId: order.id,
            content: `Endereço de ${addressType === "shipping" ? "entrega" : "cobrança"} atualizado por ${actor.name}. Antes: ${before?.street || "não informado"}, ${before?.number || "s/n"}. Depois: ${values.street || "não informado"}, ${values.number || "s/n"}.`,
            author: "Sistema",
            authorType: "system",
          },
        });
        return address;
      });
      return Response.json({ address: saved });
    }
    if (action === "tracking") {
      const code = cleanText(body.code, 160, true),
        carrierName = cleanText(body.carrier, 160),
        carriers = await db.shippingCarrier.findMany({
          where: { active: true },
        });
      const resolved = resolveCarrier(carriers, carrierName, code),
        carrierKey = resolved?.key || cleanText(body.carrierKey, 60) || null;
      const url =
        safeUrl(body.trackingUrl) ||
        (resolved?.urlTemplate
          ? resolved.urlTemplate.replace("{code}", encodeURIComponent(code))
          : null);
      const tracking = await db.$transaction(async (tx) => {
        const saved = await tx.orderTracking.upsert({
          where: { salesOrderId: order.id },
          update: {
            trackingNumber: code,
            carrier: carrierName || resolved?.label || null,
            carrierKey,
            trackingUrl: url,
            status: cleanText(body.status, 80) || null,
            statusLabel: cleanText(body.statusLabel, 160) || null,
          },
          create: {
            salesOrderId: order.id,
            trackingNumber: code,
            carrier: carrierName || resolved?.label || null,
            carrierKey,
            trackingUrl: url,
            status: cleanText(body.status, 80) || null,
            statusLabel: cleanText(body.statusLabel, 160) || null,
          },
          include: { events: true },
        });
        await tx.orderTrackingEvent.create({
          data: {
            trackingId: saved.id,
            status: "registered",
            description: `Rastreio ${code} registrado`,
            location: null,
          },
        });
        await tx.orderNote.create({
          data: {
            salesOrderId: order.id,
            content: `Rastreio adicionado: ${code}${saved.carrier ? ` — ${saved.carrier}` : ""}${url ? ` (${url})` : ""}`,
            author: "Sistema",
            authorType: "system",
          },
        });
        if (
          body.transition !== false &&
          new Set([
            "draft",
            "pending",
            "processing",
            "on-hold",
            "preparing",
            "approved",
          ]).has(order.status)
        )
          await transitionOrder(
            tx,
            order.id,
            "shipped",
            actor,
            "Rastreio registrado",
            true,
          );
        for (const option of [
          { channel: "email", enabled: body.notifyEmail !== false },
        ]) {
          const dedupKey = `order:${order.id}:status:shipped:${option.channel}:customer`;
          if (option.enabled)
            await tx.orderNotificationQueue.upsert({
              where: { dedupKey },
              update: {},
              create: {
                salesOrderId: order.id,
                statusTrigger: "shipped",
                channel: option.channel,
                recipientType: "customer",
                dedupKey,
              },
            });
          else
            await tx.orderNotificationQueue.deleteMany({
              where: { dedupKey, state: "pending" },
            });
        }
        return saved;
      });
      return Response.json({
        success: true,
        transitioned: order.status !== "shipped" && body.transition !== false,
        tracking,
      });
    }
    if (action === "refund") {
      if (!order.paidAt && !PAID_STATUSES.includes(order.status))
        throw new OrderDomainError(
          "Reembolso disponível apenas após confirmação do pagamento.",
          422,
        );
      const amount = safeAmount(body.amount, "Valor do reembolso"),
        balance = Math.round((order.total - order.refundedTotal) * 100) / 100;
      if (amount > balance)
        throw new OrderDomainError(
          `O saldo reembolsável é ${balance.toLocaleString("pt-BR", { style: "currency", currency: "BRL" })}.`,
          422,
        );
      const itemRows = Array.isArray(body.items)
        ? (body.items as Array<Record<string, unknown>>)
        : [];
      let gatewayRefundId: string | null = null;
      if (body.refundPayment === true) {
        const credential = await db.integrationCredential.findFirst({
          where: { providerId: "payment_gateway", enabled: true },
          orderBy: [{ isDefault: "desc" }, { createdAt: "asc" }],
        });
        if (!credential)
          throw new OrderDomainError(
            "Configure o gateway de pagamento antes de estornar a cobrança.",
            422,
          );
        const config = objectValue(credential.config),
          secrets = decryptSecrets(credential.secretsCipherText),
          reference =
            order.transactionId ||
            order.payments.find((item) => item.transactionId)?.transactionId ||
            order.number,
          response = await safeRequest(
            `${String(config.base_url).replace(/\/$/, "")}/refunds`,
            {
              method: "POST",
              timeoutMs: 20000,
              headers: {
                authorization: `Bearer ${secrets.access_token || secrets.client_secret}`,
                "content-type": "application/json",
              },
              body: JSON.stringify({
                transaction_id: reference,
                order_id: order.number,
                amount,
                reason: cleanText(body.reason, 500),
              }),
            },
          );
        if (response.status < 200 || response.status >= 300)
          throw new OrderDomainError(
            `O gateway recusou o estorno (HTTP ${response.status}).`,
            502,
          );
        try {
          const remote = objectValue(JSON.parse(response.body));
          gatewayRefundId =
            cleanText(remote.id ?? remote.refund_id, 200) || null;
        } catch {
          throw new OrderDomainError(
            "O gateway retornou uma resposta de estorno inválida.",
            502,
          );
        }
      }
      const refund = await db.$transaction(async (tx) => {
        const entries: Array<{
          orderItemId: number;
          quantity: number;
          amount: number;
        }> = [];
        for (const raw of itemRows) {
          const itemId = safeId(raw.orderItemId, "Item"),
            item = order.items.find((row) => row.id === itemId);
          if (!item)
            throw new OrderDomainError(
              "Item do reembolso não pertence ao pedido.",
            );
          const quantity = safeAmount(raw.quantity, "Quantidade");
          if (quantity > item.quantity - item.refundedQuantity)
            throw new OrderDomainError(
              `Quantidade reembolsável excedida para ${item.nameSnapshot}.`,
              422,
            );
          entries.push({
            orderItemId: item.id,
            quantity,
            amount: safeAmount(raw.amount, "Valor do item"),
          });
        }
        if (
          entries.length &&
          Math.abs(entries.reduce((sum, row) => sum + row.amount, 0) - amount) >
            0.01
        )
          throw new OrderDomainError(
            "A soma dos itens difere do valor do reembolso.",
            422,
          );
        if (body.restock === true && !entries.length)
          throw new OrderDomainError(
            "Selecione os itens e quantidades para devolver ao estoque.",
            422,
          );
        const created = await tx.orderRefund.create({
          data: {
            salesOrderId: order.id,
            amount,
            reason: cleanText(body.reason, 500) || null,
            mode: entries.length
              ? "items"
              : amount === balance
                ? "total"
                : "amount",
            gatewayRefundId,
            refundPayment: body.refundPayment === true,
            restock: body.restock === true,
            actor: actor.name,
            items: { create: entries },
          },
          include: { items: true },
        });
        for (const entry of entries)
          await tx.salesOrderItem.update({
            where: { id: entry.orderItemId },
            data: { refundedQuantity: { increment: entry.quantity } },
          });
        if (body.restock === true) {
          if (!order.branchId)
            throw new OrderDomainError(
              "O pedido não possui filial para receber a devolução.",
              422,
            );
          const branch = await tx.branch.findUnique({
            where: { id: order.branchId },
            include: { defaultWarehouse: true },
          });
          if (!branch?.defaultWarehouse?.active)
            throw new OrderDomainError(
              "Configure um depósito padrão ativo na filial.",
              422,
            );
          for (const entry of entries) {
            const item = order.items.find(
              (row) => row.id === entry.orderItemId,
            )!;
            if (item.product.type === "service") continue;
            const balanceRow = await tx.warehouseBalance.upsert({
              where: {
                warehouseId_productId: {
                  warehouseId: branch.defaultWarehouse.id,
                  productId: item.productId,
                },
              },
              create: {
                warehouseId: branch.defaultWarehouse.id,
                productId: item.productId,
                quantity: entry.quantity,
              },
              update: { quantity: { increment: entry.quantity } },
            });
            await tx.product.update({
              where: { id: item.productId },
              data: { stock: { increment: entry.quantity } },
            });
            await tx.stockMovement.create({
              data: {
                productId: item.productId,
                warehouseId: branch.defaultWarehouse.id,
                type: "return",
                quantity: entry.quantity,
                previousStock: balanceRow.quantity - entry.quantity,
                currentStock: balanceRow.quantity,
                note: `Reembolso do pedido ${order.number}`,
                userName: actor.name,
              },
            });
            await tx.warehouseLedgerEntry.create({
              data: {
                warehouseId: branch.defaultWarehouse.id,
                productId: item.productId,
                type: "return",
                quantity: entry.quantity,
                balanceBefore: balanceRow.quantity - entry.quantity,
                balanceAfter: balanceRow.quantity,
                referenceType: "order_refund",
                referenceId: String(created.id),
                actor: actor.name,
              },
            });
          }
        }
        const newTotal = Math.round((order.refundedTotal + amount) * 100) / 100;
        await tx.salesOrder.update({
          where: { id: order.id },
          data: { refundedTotal: newTotal },
        });
        await tx.orderNote.create({
          data: {
            salesOrderId: order.id,
            content: `Reembolso de ${amount.toLocaleString("pt-BR", { style: "currency", currency: "BRL" })}: ${cleanText(body.reason, 500) || "sem motivo informado"}`,
            author: "Sistema",
            authorType: "system",
          },
        });
        if (newTotal >= order.total)
          await transitionOrder(
            tx,
            order.id,
            "refunded",
            actor,
            "Reembolso integral",
            true,
          );
        return created;
      });
      return Response.json(
        { refund, refundableBalance: Math.max(0, balance - amount) },
        { status: 201 },
      );
    }
    if (action === "return-status") {
      const returnId = safeId(body.returnId, "Devolução"),
        status = cleanText(body.status, 30, true);
      if (
        !new Set(["pending", "approved", "rejected", "completed"]).has(status)
      )
        throw new OrderDomainError("Status de devolução inválido.");
      const updated = await db.orderReturn.updateMany({
        where: { id: returnId, salesOrderId: order.id },
        data: {
          status,
          adminNotes: cleanText(body.adminNotes, 4000) || null,
          decidedAt:
            status === "approved" || status === "rejected"
              ? new Date()
              : undefined,
          completedAt: status === "completed" ? new Date() : undefined,
        },
      });
      if (!updated.count)
        throw new OrderDomainError(
          "Solicitação de devolução não encontrada.",
          404,
        );
      {
        const dedupKey = `order:${order.id}:return:${returnId}:${status}:email:customer`;
        await db.orderNotificationQueue.upsert({
          where: { dedupKey },
          update: {},
          create: {
            salesOrderId: order.id,
            statusTrigger: `return-${status}`,
            channel: "email",
            recipientType: "customer",
            dedupKey,
          },
        });
      }
      return Response.json({ ok: true });
    }
    if (action === "queue-message") {
      await persistentRateLimit(db, `${actor.id}:manual-message`, 20, 60);
      const channel = cleanText(body.channel, 20, true);
      if (channel !== "email")
        throw new OrderDomainError(
          "Somente e-mail SMTP é enviado diretamente; use um webhook para canais externos.",
        );
      const destination =
        channel === "email" ? order.customerEmail : order.customerPhone;
      if (!destination) {
        await db.orderNotificationLog.create({
          data: {
            salesOrderId: order.id,
            statusTrigger: "manual",
            channel: `${channel}_skip`,
            recipientType: "customer",
            recipientMasked: null,
            skipped: true,
            skipReason: "Destino ausente",
          },
        });
        throw new OrderDomainError(
          "O cliente não possui destino válido para este canal.",
          422,
        );
      }
      const message = cleanText(body.message, 4096, true);
      const queued = await db.$transaction(async (tx) => {
        const queue = await tx.orderNotificationQueue.create({
          data: {
            salesOrderId: order.id,
            statusTrigger: "manual",
            channel,
            recipientType: "customer",
            force: true,
            payload: { message },
          },
        });
        await tx.orderMeta.create({
          data: {
            salesOrderId: order.id,
            key: `manual-message-${queue.id}`,
            value: { message },
          },
        });
        await tx.orderNote.create({
          data: {
            salesOrderId: order.id,
            content: `Mensagem manual agendada por ${channel}: ${message}`,
            author: actor.name,
          },
        });
        return queue;
      });
      return Response.json(
        {
          queued: true,
          queueId: queued.id,
          recipient: maskRecipient(destination),
        },
        { status: 201 },
      );
    }
    throw new OrderDomainError("Ação de pedido inválida.");
  } catch (error) {
    return failure(error);
  }
}

async function exportCsv(
  db: Awaited<ReturnType<typeof tenantDb>>,
  where: Prisma.SalesOrderWhereInput,
) {
  const count = await db.salesOrder.count({ where });
  if (count > 10000)
    throw new OrderDomainError(
      "A exportação excede 10.000 pedidos. Reduza o período.",
      422,
    );
  const orders = await db.salesOrder.findMany({
    where,
    include: { items: true, tracking: true, addresses: true },
    orderBy: { createdAt: "asc" },
  });
  const head = [
    "Número",
    "Data",
    "Status",
    "Cliente",
    "E-mail",
    "Telefone",
    "Documento",
    "Itens",
    "Subtotal",
    "Desconto",
    "Frete",
    "Total",
    "Pagamento",
    "Rastreio",
    "Origem",
  ];
  const rows = orders.map((order) => [
    order.number,
    order.createdAt.toISOString(),
    order.status,
    order.customerName,
    order.customerEmail,
    order.customerPhone,
    order.customerDocument,
    order.items
      .map((item) => `${item.nameSnapshot} x${item.quantity}`)
      .join("; "),
    order.subtotal,
    order.discount,
    order.freightAmount,
    order.total,
    order.paymentTitle || order.paymentMethod,
    order.tracking?.trackingNumber,
    order.origin,
  ]);
  const csv = [head, ...rows]
    .map((row) => row.map(csvCell).join(","))
    .join("\r\n");
  return new Response(`\uFEFF${csv}`, {
    headers: {
      "content-type": "text/csv; charset=utf-8",
      "content-disposition": `attachment; filename="pedidos-${new Date().toISOString().slice(0, 10)}.csv"`,
    },
  });
}

function idsValue(value: unknown) {
  if (!Array.isArray(value))
    throw new OrderDomainError("Selecione os pedidos.");
  const ids = [...new Set(value.map((item) => safeId(item)))];
  if (!ids.length || ids.length > 100)
    throw new OrderDomainError("Selecione de 1 a 100 pedidos.");
  return ids;
}
function integer(value: unknown, min: number, max: number, message: string) {
  const result = Number(value);
  if (!Number.isSafeInteger(result) || result < min || result > max)
    throw new OrderDomainError(message);
  return result;
}
function optionalAmount(value: string | null) {
  if (value === null || value === "") return null;
  const amount = Number(value);
  if (!Number.isFinite(amount) || amount < 0)
    throw new OrderDomainError("Faixa de valor inválida.");
  return Math.round(amount * 100) / 100;
}
function dateParam(value: string | null, end = false) {
  if (!value) return null;
  const date = new Date(`${value}T${end ? "23:59:59.999" : "00:00:00.000"}Z`);
  if (Number.isNaN(date.getTime()))
    throw new OrderDomainError("Período inválido.");
  return date;
}
function normalizeMatrix(value: unknown, statuses: Set<string>) {
  const source = record(value),
    result: Record<string, Record<string, boolean | null>> = {};
  for (const [status, raw] of Object.entries(source)) {
    if (!statuses.has(status)) continue;
    const row = record(raw),
      normalized: Record<string, boolean | null> = {};
    for (const channel of ["admin_email", "customer_email"])
      normalized[channel] =
        row[channel] === true ? true : row[channel] === false ? false : null;
    result[status] = normalized;
  }
  return result;
}
function normalizePolicies(value: unknown, statuses: Set<string>) {
  const source = record(value),
    result: Record<string, unknown> = {};
  for (const [status, raw] of Object.entries(source)) {
    if (!statuses.has(status)) continue;
    const policy = record(raw),
      quiet = record(policy.quietHours ?? policy.quiet_hours);
    result[status] = {
      delayMinutes: integer(
        policy.delayMinutes ?? policy.delay_minutes ?? 0,
        0,
        10080,
        "Atraso de comunicação inválido.",
      ),
      throttlePerMinute: integer(
        policy.throttlePerMinute ?? policy.throttle_per_minute ?? 0,
        0,
        10000,
        "Limite de comunicação inválido.",
      ),
      quietHours: {
        start: integer(
          quiet.start ?? -1,
          -1,
          23,
          "Início da janela de silêncio inválido.",
        ),
        end: integer(
          quiet.end ?? -1,
          -1,
          23,
          "Fim da janela de silêncio inválido.",
        ),
      },
      timezone: timezone(policy.timezone),
    };
  }
  return result;
}
function record(value: unknown) {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}
function stringList(value: unknown, maximum: number, length: number) {
  if (!Array.isArray(value) || value.length > maximum)
    throw new OrderDomainError("Lista de destinatários inválida.");
  return value.map((item) => cleanText(item, length, true));
}
function timezone(value: unknown) {
  const name = cleanText(value || "America/Sao_Paulo", 100, true);
  try {
    new Intl.DateTimeFormat("pt-BR", { timeZone: name }).format();
    return name;
  } catch {
    throw new OrderDomainError("Fuso horário inválido.");
  }
}
function failure(error: unknown) {
  if (error instanceof HttpSecurityError) return authErrorResponse(error);
  if (error instanceof IntegrationError)
    return Response.json({ error: error.message }, { status: error.status });
  if (error instanceof OrderDomainError)
    return Response.json(
      { error: error.message },
      {
        status: error.status,
        headers: error.retryAfter
          ? { "Retry-After": String(error.retryAfter) }
          : undefined,
      },
    );
  if (error instanceof LicenseDeniedError)
    return Response.json({ error: error.message }, { status: error.status });
  if (error instanceof AuthError) return authErrorResponse(error);
  console.error("order-management", { error: error instanceof Error ? error.name : typeof error });
  return Response.json(
    { error: "Não foi possível processar a operação de pedidos." },
    { status: 500 },
  );
}
