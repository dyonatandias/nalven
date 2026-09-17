import { createHash, randomUUID } from "node:crypto";
import { currentOrganization, tenantDb } from "@/db";
import type { Prisma } from "@/generated/tenant/client";
import { AuthError, authErrorResponse } from "@/lib/auth";
import { LicenseDeniedError } from "@/lib/billing/license";
import { assertSameOrigin, CustomerInputError } from "@/lib/erp/customer-input";
import { assertTenantPermission } from "@/lib/erp/permissions";
import { enqueueStatusNotifications } from "@/lib/erp/order-domain";
import {
  channelInput,
  entityId,
  listingInput,
  marketplaceOrderInput,
  marketplaceOrderStateInput,
  OmnichannelInputError,
} from "@/lib/erp/omnichannel-input";
import {
  assertOmnichannelMutationRequest,
  enforceOmnichannelRateLimit,
  OmnichannelHttpError,
  omnichannelNoStoreHeaders,
  readOmnichannelJson,
} from "@/lib/erp/omnichannel-http";
import { assertTenantWriteAccess } from "@/lib/tenant-access";
import { reserveOrderStock } from "@/lib/erp/order-stock";
import { SalesOrderInputError } from "@/lib/erp/sales-order-input";

function marketplaceJson(body: unknown, init: ResponseInit = {}) {
  const headers = new Headers(init.headers);
  for (const [name, value] of Object.entries(omnichannelNoStoreHeaders))
    headers.set(name, value);
  return Response.json(body, { ...init, headers });
}

const include = {
  credential: {
    select: {
      id: true,
      label: true,
      enabled: true,
      sandbox: true,
      lastTestAt: true,
      lastTestOk: true,
      lastTestMessage: true,
    },
  },
  listings: {
    include: { product: true },
    orderBy: { updatedAt: "desc" as const },
    take: 250,
  },
  orders: {
    include: { salesOrder: true },
    orderBy: { importedAt: "desc" as const },
    take: 250,
  },
  webhookEvents: {
    orderBy: { createdAt: "desc" as const },
    take: 10,
  },
};

export async function GET() {
  try {
    const organization = await currentOrganization();
    await assertTenantPermission(organization.id, "marketplaces.read");
    const db = await tenantDb(organization.id);
    const [
      channels,
      products,
      credentials,
      webhookSummary,
      orderTotals,
      orderCount,
      listingErrors,
      listedProductGroups,
      operationalExceptions,
    ] = await Promise.all([
      db.marketplaceChannel.findMany({ include, orderBy: { name: "asc" } }),
      db.product.findMany({
        where: { active: true },
        select: {
          id: true,
          name: true,
          sku: true,
          price: true,
          stock: true,
          cost: true,
          type: true,
        },
        orderBy: { name: "asc" },
      }),
      db.integrationCredential.findMany({
        where: { providerId: "marketplace" },
        select: {
          id: true,
          label: true,
          enabled: true,
          sandbox: true,
          lastTestAt: true,
          lastTestOk: true,
          config: true,
        },
        orderBy: [{ enabled: "desc" }, { label: "asc" }],
      }),
      db.marketplaceWebhookEvent.groupBy({
        by: ["state"],
        _count: { _all: true },
      }),
      db.marketplaceOrder.aggregate({
        _sum: {
          total: true,
          buyerShippingCost: true,
          commission: true,
          fee: true,
          sellerShippingCost: true,
        },
      }),
      db.marketplaceOrder.count(),
      db.marketplaceListing.count({ where: { status: "error" } }),
      db.marketplaceListing.groupBy({ by: ["productId"] }),
      db.marketplaceOrder.count({
        where: {
          OR: [
            { buyerCancelRequested: true },
            { riskStatus: { in: ["review", "blocked"] } },
            { paymentStatus: { in: ["pending", "cancelled"] } },
            {
              status: "imported",
              shipByAt: { lt: new Date() },
            },
          ],
        },
      }),
    ]);
    const orders = channels.flatMap((channel) => channel.orders),
      listings = channels.flatMap((channel) => channel.listings),
      listedProducts = listedProductGroups.length,
      fees = orderTotals._sum.commission || orderTotals._sum.fee || 0,
      netRevenue =
        (orderTotals._sum.total || 0) +
        (orderTotals._sum.buyerShippingCost || 0) -
        fees -
        (orderTotals._sum.sellerShippingCost || 0),
      failedEvents =
        webhookSummary.find((item) => item.state === "failed")?._count._all ||
        0,
      pendingEvents = webhookSummary
        .filter((item) =>
          ["received", "processing", "retry"].includes(item.state),
        )
        .reduce((sum, item) => sum + item._count._all, 0),
      staleChannels = channels.filter((channel) => {
        if (channel.status !== "active" || !channel.credentialId) return false;
        if (!channel.lastSyncAt) return true;
        return (
          channel.lastSyncAt.getTime() + channel.syncInterval * 60_000 <
          Date.now()
        );
      }).length;
    return marketplaceJson({
      channels,
      products,
      credentials,
      summary: {
        channels: channels.filter((item) => item.status === "active").length,
        connected: channels.filter(
          (item) =>
            item.credential?.enabled && item.credential.lastTestOk === true,
        ).length,
        gmv: orderTotals._sum.total || 0,
        netRevenue,
        orders: orderCount,
        errors: listingErrors,
        listingCoverage: products.length
          ? Math.round((listedProducts / products.length) * 1000) / 10
          : 0,
        listedProducts,
        catalogProducts: products.length,
        failedEvents,
        pendingEvents,
        staleChannels,
        operationalExceptions,
      },
      pagination: {
        listingsShown: listings.length,
        ordersShown: orders.length,
        perChannelLimit: 250,
      },
    });
  } catch (error) {
    return failure(error);
  }
}

export async function POST(request: Request) {
  try {
    assertSameOrigin(request);
    assertOmnichannelMutationRequest(request);
    const organization = await currentOrganization(),
      access = await assertTenantPermission(
        organization.id,
        "marketplaces.write",
      );
    await assertTenantWriteAccess(organization.id);
    const db = await tenantDb(organization.id),
      body = await readOmnichannelJson(request, 1_048_576),
      correlationId = randomUUID();
    await enforceOmnichannelRateLimit(
      db,
      access.user.id,
      String(body.action || "unknown"),
    );
    if (body.action === "channel.create") {
      const input = channelInput(body),
        credentialId = String(body.credentialId || "").trim() || null;
      if (
        credentialId &&
        !(await db.integrationCredential.findFirst({
          where: { id: credentialId, providerId: "marketplace", enabled: true },
        }))
      )
        throw new OmnichannelInputError(
          "Credencial de marketplace inválida ou desconectada.",
        );
      const channel = await db.marketplaceChannel.create({
        data: {
          ...input,
          credentialId,
          lastSyncStatus: credentialId ? "pending" : "local_only",
          lastSyncMessage: credentialId
            ? "Conexão vinculada; reconciliação inicial pendente."
            : "Canal operando sem conector externo.",
        },
        include,
      });
      await audit(
        db,
        access.user.id,
        "marketplace_channel.created",
        "marketplace_channel",
        channel.id,
        correlationId,
        { ...input, credentialId },
      );
      return marketplaceJson({ channel, correlationId }, { status: 201 });
    }
    if (body.action === "channel.toggle") {
      const id = entityId(body.channelId),
        before = await db.marketplaceChannel.findUnique({ where: { id } });
      if (!before) throw new OmnichannelInputError("Canal não encontrado.");
      const status = before.status === "active" ? "paused" : "active",
        channel = await db.marketplaceChannel.update({
          where: { id },
          data: { status },
          include,
        });
      await audit(
        db,
        access.user.id,
        "marketplace_channel.status_changed",
        "marketplace_channel",
        id,
        correlationId,
        { status },
      );
      return marketplaceJson({ channel, correlationId });
    }
    if (body.action === "channel.update") {
      const id = entityId(body.channelId),
        input = channelInput(body),
        credentialId = String(body.credentialId || "").trim() || null;
      const before = await db.marketplaceChannel.findUnique({ where: { id } });
      if (!before) throw new OmnichannelInputError("Canal não encontrado.");
      if (
        credentialId &&
        !(await db.integrationCredential.findFirst({
          where: { id: credentialId, providerId: "marketplace", enabled: true },
        }))
      )
        throw new OmnichannelInputError(
          "Credencial de marketplace inválida ou desconectada.",
        );
      const channel = await db.marketplaceChannel.update({
        where: { id },
        data: {
          ...input,
          credentialId,
          lastSyncStatus: credentialId ? "pending" : "local_only",
          lastSyncMessage: credentialId
            ? "Configuração alterada; reconciliação inicial pendente."
            : "Canal operando sem conector externo.",
        },
        include,
      });
      await audit(
        db,
        access.user.id,
        "marketplace_channel.updated",
        "marketplace_channel",
        id,
        correlationId,
        { before, input, credentialId },
      );
      return marketplaceJson({ channel, correlationId });
    }
    if (body.action === "listing.upsert") {
      const input = listingInput(body);
      const channel = await db.marketplaceChannel.findFirst({
          where: { id: input.channelId, status: "active" },
        }),
        product = await db.product.findFirst({
          where: { id: input.productId, active: true },
        });
      if (!channel || !product)
        throw new OmnichannelInputError("Canal ou produto indisponível.");
      const listing = await db.marketplaceListing.upsert({
        where: {
          channelId_productId: {
            channelId: input.channelId,
            productId: input.productId,
          },
        },
        create: {
          ...input,
          syncedStock: Math.max(0, product.stock - channel.stockBuffer),
          desiredStock: Math.max(0, product.stock - channel.stockBuffer),
          desiredPrice: Math.round(input.price * 100) / 100,
          syncState: channel.credentialId ? "pending_external" : "local_only",
          syncMessage: channel.credentialId
            ? "Publicação externa pendente de confirmação do conector."
            : "Alvo salvo apenas no ERP; nenhum conector está vinculado.",
          lastSyncedAt: new Date(),
        },
        update: {
          externalId: input.externalId,
          title: input.title,
          price: input.price,
          status: "active",
          desiredStock: Math.max(0, product.stock - channel.stockBuffer),
          desiredPrice: Math.round(input.price * 100) / 100,
          syncState: channel.credentialId ? "pending_external" : "local_only",
          syncMessage: channel.credentialId
            ? "Alteração externa pendente de confirmação do conector."
            : "Alvo salvo apenas no ERP; nenhum conector está vinculado.",
          lastSyncedAt: new Date(),
        },
        include: { product: true, channel: true },
      });
      await db.marketplaceChannel.update({
        where: { id: input.channelId },
        data: { lastSyncAt: new Date() },
      });
      await audit(
        db,
        access.user.id,
        "marketplace_listing.synced",
        "marketplace_listing",
        listing.id,
        correlationId,
        { productId: product.id, stock: product.stock, price: input.price },
      );
      return marketplaceJson({ listing, correlationId });
    }
    if (body.action === "channel.sync") {
      const channelId = entityId(body.channelId),
        channel = await db.marketplaceChannel.findFirst({
          where: { id: channelId, status: "active" },
        });
      if (!channel)
        throw new OmnichannelInputError("Canal ativo não encontrado.");
      const listings = await db.marketplaceListing.findMany({
        where: { channelId },
        include: { product: true },
      });
      const syncAt = new Date(),
        hasConnector = Boolean(channel.credentialId);
      await db.$transaction([
        ...listings.map((item) =>
          db.marketplaceListing.update({
            where: { id: item.id },
            data: {
              desiredStock: Math.max(
                0,
                item.product.stock - channel.stockBuffer,
              ),
              desiredPrice:
                Math.round(
                  item.product.price *
                    (1 + channel.priceAdjustment / 100) *
                    100,
                ) / 100,
              syncState: hasConnector ? "pending_external" : "local_only",
              syncMessage: hasConnector
                ? "Novo alvo calculado; aguardando confirmação do conector externo."
                : "Novo alvo calculado apenas no ERP; vincule uma credencial para publicar.",
            },
          }),
        ),
        db.marketplaceChannel.update({
          where: { id: channelId },
          data: {
            lastSyncAt: syncAt,
            lastSyncStatus: hasConnector ? "pending_external" : "local_only",
            lastSyncMessage: hasConnector
              ? "Alvos recalculados; publicação e confirmação externas aguardam o worker homologado do provedor."
              : "Alvos recalculados apenas no ERP; vincule uma credencial para publicar externamente.",
          },
        }),
        db.tenantAuditEvent.create({
          data: {
            actorId: access.user.id,
            action: "marketplace_channel.synced",
            entityType: "marketplace_channel",
            entityId: String(channelId),
            correlationId,
            afterData: { listings: listings.length },
          },
        }),
      ]);
      return marketplaceJson({ synced: listings.length, correlationId });
    }
    if (body.action === "listing.toggle") {
      const id = entityId(body.listingId),
        before = await db.marketplaceListing.findUnique({ where: { id } });
      if (!before) throw new OmnichannelInputError("Anúncio não encontrado.");
      const status = before.status === "paused" ? "active" : "paused";
      const listing = await db.marketplaceListing.update({
        where: { id },
        data: { status },
        include: { product: true, channel: true },
      });
      await audit(
        db,
        access.user.id,
        "marketplace_listing.status_changed",
        "marketplace_listing",
        id,
        correlationId,
        { status },
      );
      return marketplaceJson({ listing, correlationId });
    }
    if (body.action === "webhook.retry") {
      const id = entityId(body.eventId),
        before = await db.marketplaceWebhookEvent.findUnique({ where: { id } });
      if (!before || before.state !== "failed")
        throw new OmnichannelInputError("Evento com falha não encontrado.");
      const event = await db.marketplaceWebhookEvent.update({
        where: { id },
        data: { state: "retry", nextAttemptAt: new Date(), lastError: null },
      });
      await audit(
        db,
        access.user.id,
        "marketplace_webhook.retry_scheduled",
        "marketplace_webhook_event",
        id,
        correlationId,
        { attempts: before.attempts },
      );
      return marketplaceJson({ event, correlationId });
    }
    if (body.action === "order.update") {
      const input = marketplaceOrderStateInput(body),
        before = await db.marketplaceOrder.findUnique({
          where: { id: input.orderId },
        });
      if (!before)
        throw new OmnichannelInputError("Pedido do canal não encontrado.");
      const order = await db.$transaction(async (tx) => {
        const updated = await tx.marketplaceOrder.update({
          where: { id: before.id },
          data: {
            paymentStatus: input.paymentStatus,
            riskStatus: input.riskStatus,
            buyerCancelRequested: input.buyerCancelRequested,
            marketplaceStatus: input.marketplaceStatus,
            invoiceStatus: input.invoiceStatus,
            shipByAt: input.shipByAt,
            deliverByAt: input.deliverByAt,
            cancelByAt: input.cancelByAt,
          },
          include: { salesOrder: true, channel: true },
        });
        await tx.shipment.updateMany({
          where: { channelOrderId: updated.id },
          data: {
            fiscalRequired: true,
            fiscalStatus: ["authorized", "approved", "issued"].includes(
              String(input.invoiceStatus || ""),
            )
              ? "authorized"
              : input.invoiceStatus === "rejected"
                ? "rejected"
                : "pending",
          },
        });
        return updated;
      });
      await audit(
        db,
        access.user.id,
        "marketplace_order.operational_state_updated",
        "marketplace_order",
        order.id,
        correlationId,
        { before, input },
      );
      return marketplaceJson({ order, correlationId });
    }
    if (body.action === "order.import") {
      const input = marketplaceOrderInput(body),
        channel = await db.marketplaceChannel.findFirst({
          where: { id: input.channelId, status: "active" },
        });
      if (!channel)
        throw new OmnichannelInputError("Canal ativo não encontrado.");
      const existingOrder = await db.marketplaceOrder.findUnique({
        where: {
          channelId_externalId: {
            channelId: input.channelId,
            externalId: input.externalId,
          },
        },
        include: { salesOrder: true, channel: true },
      });
      if (existingOrder)
        return marketplaceJson({
          order: existingOrder,
          correlationId,
          replayed: true,
        });
      let webhookEvent = input.eventKey
        ? await db.marketplaceWebhookEvent.findUnique({
            where: {
              channelId_eventKey: {
                channelId: input.channelId,
                eventKey: input.eventKey,
              },
            },
          })
        : null;
      if (webhookEvent) {
        const staleBefore = new Date(Date.now() - 300_000),
          claimed = await db.marketplaceWebhookEvent.updateMany({
            where: {
              id: webhookEvent.id,
              OR: [
                { state: { in: ["received", "retry", "failed"] } },
                { state: "processing", updatedAt: { lt: staleBefore } },
              ],
            },
            data: {
              state: "processing",
              attempts: { increment: 1 },
              lastError: null,
              nextAttemptAt: null,
            },
          });
        if (claimed.count !== 1)
          return marketplaceJson({
            event: { id: webhookEvent.id, state: webhookEvent.state },
            correlationId,
            replayed: true,
          });
        webhookEvent = await db.marketplaceWebhookEvent.findUniqueOrThrow({
          where: { id: webhookEvent.id },
        });
      } else if (input.eventKey) {
        try {
          webhookEvent = await db.marketplaceWebhookEvent.create({
            data: {
              channelId: input.channelId,
              eventKey: input.eventKey,
              eventType: input.eventType,
              payloadHash: createHash("sha256")
                .update(JSON.stringify(input.rawData || body))
                .digest("hex"),
              payload: (input.rawData || {}) as Prisma.InputJsonValue,
              state: "processing",
              attempts: 1,
            },
          });
        } catch (error) {
          if (
            error &&
            typeof error === "object" &&
            "code" in error &&
            error.code === "P2002"
          ) {
            const concurrent = await db.marketplaceWebhookEvent.findUnique({
              where: {
                channelId_eventKey: {
                  channelId: input.channelId,
                  eventKey: input.eventKey,
                },
              },
            });
            return marketplaceJson({
              event: concurrent
                ? { id: concurrent.id, state: concurrent.state }
                : null,
              correlationId,
              replayed: true,
            });
          }
          throw error;
        }
      }
      const profile = await db.tenantUserProfile.findUnique({
        where: { userId: access.user.id },
        select: { activeBranchId: true },
      });
      if (
        !profile?.activeBranchId ||
        !(await db.branchUserAccess.findFirst({
          where: {
            branchId: profile.activeBranchId,
            userProfile: { userId: access.user.id },
          },
        }))
      )
        throw new OmnichannelInputError(
          "Selecione uma filial operacional autorizada antes de importar.",
        );
      const activeBranchId = profile.activeBranchId;
      const products = await db.product.findMany({
        where: {
          id: { in: input.items.map((item) => item.productId) },
          active: true,
        },
      });
      if (
        products.length !==
        new Set(input.items.map((item) => item.productId)).size
      )
        throw new OmnichannelInputError(
          "Produto do pedido não está disponível.",
        );
      const customer = input.customerDocument
        ? await db.customer.findUnique({
            where: { document: input.customerDocument },
          })
        : null;
      let result;
      try {
        result = await db.$transaction(
          async (tx) => {
            const order = await tx.salesOrder.create({
              data: {
                number: `MKT-${Date.now().toString(36).toUpperCase()}-${randomUUID().slice(0, 6).toUpperCase()}`,
                kind: "order",
                status: "approved",
                origin: "marketplace",
                salesChannel: "marketplace",
                branchId: activeBranchId,
                customerId: customer?.id,
                customerName:
                  customer?.tradeName || customer?.name || input.customerName,
                customerDocument: input.customerDocument,
                customerEmail: input.customerEmail,
                customerPhone: input.customerPhone,
                subtotal: input.total,
                freightAmount: input.buyerShippingCost,
                total:
                  Math.round((input.total + input.buyerShippingCost) * 100) /
                  100,
                deliveryType: "carrier",
                deliveryZip: input.deliveryZip,
                deliveryStreet: input.deliveryStreet,
                deliveryNumber: input.deliveryNumber,
                deliveryComplement: input.deliveryComplement,
                deliveryDistrict: input.deliveryDistrict,
                deliveryCity: input.deliveryCity,
                deliveryState: input.deliveryState,
                notes: `Importado de ${channel.name} · ${input.externalId}`,
                createdBy: access.user.name,
                approvedAt: new Date(),
                notificationManaged: true,
                items: {
                  create: input.items.map((item) => {
                    const product = products.find(
                      (row) => row.id === item.productId,
                    )!;
                    return {
                      ...item,
                      nameSnapshot: product.name,
                      skuSnapshot: product.sku,
                      listPrice: product.price,
                      total:
                        Math.round(item.quantity * item.unitPrice * 100) / 100,
                    };
                  }),
                },
                addresses: {
                  create: {
                    type: "shipping",
                    firstName: input.customerName,
                    email: input.customerEmail,
                    phone: input.customerPhone,
                    document: input.customerDocument,
                    zip: input.deliveryZip,
                    street: input.deliveryStreet,
                    number: input.deliveryNumber,
                    complement: input.deliveryComplement,
                    neighborhood: input.deliveryDistrict,
                    city: input.deliveryCity,
                    state: input.deliveryState,
                  },
                },
                history: {
                  create: {
                    toStatus: "approved",
                    actor: access.user.name,
                    notes: `Importado do canal ${channel.name}`,
                  },
                },
              },
              include: {
                items: {
                  include: { product: { select: { name: true, type: true } } },
                },
              },
            });
            const [tenantSettings, branch] = await Promise.all([
              tx.tenantSettings.findUnique({
                where: { id: 1 },
                select: { allowNegativeStock: true },
              }),
              tx.branch.findUnique({
                where: { id: activeBranchId },
                include: { settings: true },
              }),
            ]);
            if (branch?.settings?.reserveStockOnOrder ?? true)
              await reserveOrderStock(
                tx,
                { ...order, branchId: activeBranchId },
                Boolean(tenantSettings?.allowNegativeStock),
              );
            const marketplaceOrder = await tx.marketplaceOrder.create({
              data: {
                channelId: input.channelId,
                externalId: input.externalId,
                customerName: input.customerName,
                customerDocument: input.customerDocument,
                total: input.total,
                fee: input.fee,
                marketplaceStatus: input.marketplaceStatus,
                paymentStatus: input.paymentStatus,
                riskStatus: input.riskStatus,
                buyerCancelRequested: input.buyerCancelRequested,
                shipByAt: input.shipByAt,
                deliverByAt: input.deliverByAt,
                cancelByAt: input.cancelByAt,
                connectionId: input.connectionId,
                shipmentExternalId: input.shipmentExternalId,
                logisticType: input.logisticType,
                buyerShippingCost: input.buyerShippingCost,
                sellerShippingCost: input.sellerShippingCost,
                commission: input.commission,
                invoiceExternalId: input.invoiceExternalId,
                invoiceStatus: input.invoiceStatus,
                rawData: input.rawData as Prisma.InputJsonValue | undefined,
                salesOrderId: order.id,
              },
              include: { salesOrder: true, channel: true },
            });
            await tx.salesOrder.update({
              where: { id: order.id },
              data: { notificationManaged: false, marketplaceNotified: true },
            });
            await enqueueStatusNotifications(tx, order.id, "approved");
            if (webhookEvent)
              await tx.marketplaceWebhookEvent.update({
                where: { id: webhookEvent.id },
                data: { state: "processed", processedAt: new Date() },
              });
            await tx.tenantAuditEvent.create({
              data: {
                actorId: access.user.id,
                action: "marketplace_order.imported",
                entityType: "marketplace_order",
                entityId: String(marketplaceOrder.id),
                correlationId,
                afterData: {
                  channelId: input.channelId,
                  externalId: input.externalId,
                  salesOrderId: order.id,
                  total: input.total,
                },
              },
            });
            return marketplaceOrder;
          },
          { isolationLevel: "Serializable" },
        );
      } catch (error) {
        if (webhookEvent)
          await db.marketplaceWebhookEvent
            .update({
              where: { id: webhookEvent.id },
              data: {
                state: "failed",
                lastError: (error instanceof Error
                  ? error.message
                  : "Falha na importação"
                ).slice(0, 1000),
                nextAttemptAt: new Date(
                  Date.now() +
                    Math.min(
                      86_400_000,
                      30_000 * 2 ** Math.min(webhookEvent.attempts, 10),
                    ),
                ),
              },
            })
            .catch(() => undefined);
        throw error;
      }
      return marketplaceJson({ order: result, correlationId }, { status: 201 });
    }
    throw new OmnichannelInputError("Ação de marketplace inválida.");
  } catch (error) {
    return failure(error);
  }
}

async function audit(
  db: Awaited<ReturnType<typeof tenantDb>>,
  actorId: string,
  action: string,
  entityType: string,
  id: number,
  correlationId: string,
  afterData: object,
) {
  await db.tenantAuditEvent.create({
    data: {
      actorId,
      action,
      entityType,
      entityId: String(id),
      correlationId,
      afterData,
    },
  });
}
function failure(error: unknown) {
  if (error instanceof OmnichannelHttpError)
    return marketplaceJson({ error: error.message }, { status: error.status });
  if (
    error instanceof OmnichannelInputError ||
    error instanceof CustomerInputError ||
    error instanceof SalesOrderInputError
  )
    return marketplaceJson(
      { error: error.message },
      {
        status: error.message.includes("Origem")
          ? 403
          : error.message.includes("Saldo disponível")
            ? 409
            : 400,
      },
    );
  if (error instanceof LicenseDeniedError)
    return marketplaceJson({ error: error.message }, { status: error.status });
  if (
    error &&
    typeof error === "object" &&
    "code" in error &&
    error.code === "P2002"
  )
    return marketplaceJson(
      { error: "Canal, anúncio ou pedido externo já cadastrado." },
      { status: 409 },
    );
  if (
    error &&
    typeof error === "object" &&
    "code" in error &&
    error.code === "P2034"
  )
    return marketplaceJson(
      {
        error:
          "A operação concorreu com outra alteração. Atualize e tente novamente.",
      },
      { status: 409 },
    );
  if (error instanceof AuthError) {
    const response = authErrorResponse(error);
    for (const [name, value] of Object.entries(omnichannelNoStoreHeaders))
      response.headers.set(name, value);
    return response;
  }
  console.error("erp-marketplaces", { error: error instanceof Error ? error.name : typeof error });
  return marketplaceJson({ error: "Erro na operação omnicanal." }, { status: 500 });
}
