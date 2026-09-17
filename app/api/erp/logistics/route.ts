import { createHash, randomUUID } from "node:crypto";
import { currentOrganization, tenantDb } from "@/db";
import { Prisma } from "@/generated/tenant/client";
import { AuthError, authErrorResponse } from "@/lib/auth";
import { LicenseDeniedError } from "@/lib/billing/license";
import { assertSameOrigin, CustomerInputError } from "@/lib/erp/customer-input";
import {
  incidentInput,
  incidentResolutionInput,
  entityId,
  OmnichannelInputError,
  reverseLogisticsInput,
  reverseLogisticsStateInput,
  returnInspectionInput,
  shipmentCancellationInput,
  shipmentDeliveryInput,
  shipmentDispatchInput,
  shipmentInput,
  shipmentPackingInput,
  shipmentPickingInput,
  shipmentTrackingInput,
  shippingManifestInput,
} from "@/lib/erp/omnichannel-input";
import {
  assertOmnichannelMutationRequest,
  enforceOmnichannelRateLimit,
  OmnichannelHttpError,
  omnichannelNoStoreHeaders,
  readOmnichannelJson,
} from "@/lib/erp/omnichannel-http";
import { assertTenantPermission } from "@/lib/erp/permissions";
import { enqueueStatusNotifications } from "@/lib/erp/order-domain";
import { dateInTimezone, zonedMidnight } from "@/lib/erp/report-sales";
import { assertTenantWriteAccess } from "@/lib/tenant-access";

const include = {
  salesOrder: {
    include: {
      items: { include: { product: true, variation: true } },
      shippingLabels: { orderBy: { createdAt: "desc" as const } },
      documents: { orderBy: { createdAt: "desc" as const } },
      tracking: {
        include: {
          events: { orderBy: { occurredAt: "desc" as const }, take: 8 },
        },
      },
      returns: {
        include: { items: true },
        orderBy: { requestedAt: "desc" as const },
      },
    },
  },
  channelOrder: { include: { channel: true } },
  warehouse: { include: { branch: true } },
  items: {
    include: {
      salesOrderItem: { include: { product: true, variation: true } },
      pickAllocations: {
        include: { lot: true },
        orderBy: { pickedAt: "desc" as const },
      },
    },
  },
  packages: {
    include: { items: true },
    orderBy: { sequence: "asc" as const },
  },
  incidents: { orderBy: { createdAt: "desc" as const } },
  waveEntries: {
    include: { wave: true },
    orderBy: { wave: { createdAt: "desc" as const } },
    take: 5,
  },
  manifestEntries: {
    include: { manifest: true },
    orderBy: { manifest: { createdAt: "desc" as const } },
    take: 5,
  },
  events: { orderBy: { createdAt: "desc" as const }, take: 20 },
};

function logisticsJson(body: unknown, init: ResponseInit = {}) {
  const headers = new Headers(init.headers);
  for (const [name, value] of Object.entries(omnichannelNoStoreHeaders))
    headers.set(name, value);
  return Response.json(body, { ...init, headers });
}

export async function GET(request: Request) {
  try {
    const context = await logisticsContext("logistics.read"),
      { db, branchIds, activeBranch, timezone } = context,
      searchParams = new URL(request.url).searchParams,
      query = String(searchParams.get("q") || "")
        .trim()
        .slice(0, 100),
      requestedStatus = String(searchParams.get("status") || "open"),
      status = [
        "all",
        "open",
        "picking",
        "packed",
        "dispatched",
        "delivered",
        "cancelled",
        "on_hold",
      ].includes(requestedStatus)
        ? requestedStatus
        : "open",
      requestedPage = Number(searchParams.get("page") || 1),
      page = Number.isSafeInteger(requestedPage)
        ? Math.min(10_000, Math.max(1, requestedPage))
        : 1,
      pageSize = 40,
      warehouseId = optionalPositiveInt(searchParams.get("warehouse")),
      channelId = optionalPositiveInt(searchParams.get("channel")),
      priority = allowedFilter(searchParams.get("priority"), [
        "low",
        "normal",
        "high",
        "urgent",
      ]),
      incident = allowedFilter(searchParams.get("incident"), [
        "all",
        "open",
        "resolved",
        "none",
      ]),
      carrier = String(searchParams.get("carrier") || "")
        .trim()
        .slice(0, 120),
      sla = allowedFilter(searchParams.get("sla"), [
        "all",
        "late",
        "today",
        "upcoming",
      ]),
      from = dateFilter(searchParams.get("from"), timezone),
      to = dateFilter(searchParams.get("to"), timezone, true),
      now = new Date(),
      today = dateInTimezone(now, timezone),
      tomorrow = zonedMidnight(addCalendarDays(today, 1), timezone),
      where: Prisma.ShipmentWhereInput = {
        warehouse: {
          branchId: { in: branchIds },
          ...(warehouseId ? { id: warehouseId } : {}),
        },
        ...(status === "open"
          ? { status: { notIn: ["delivered", "cancelled"] } }
          : status !== "all"
            ? { status }
            : {}),
        ...(priority ? { priority } : {}),
        ...(carrier
          ? { carrier: { equals: carrier, mode: "insensitive" } }
          : {}),
        ...(channelId ? { channelOrder: { is: { channelId } } } : {}),
        ...(incident === "open" || incident === "resolved"
          ? { incidents: { some: { status: incident } } }
          : incident === "none"
            ? { incidents: { none: { status: "open" } } }
            : {}),
        ...(from || to
          ? {
              createdAt: {
                ...(from ? { gte: from } : {}),
                ...(to ? { lt: to } : {}),
              },
            }
          : {}),
        AND: [
          ...(sla === "late"
            ? [
                {
                  status: { notIn: ["delivered", "cancelled"] },
                  OR: [
                    { dispatchDeadlineAt: { lt: now } },
                    {
                      dispatchDeadlineAt: null,
                      deadlineAt: { lt: new Date(`${today}T00:00:00.000Z`) },
                    },
                  ],
                },
              ]
            : sla === "today"
              ? [
                  {
                    status: { notIn: ["delivered", "cancelled"] },
                    OR: [
                      { dispatchDeadlineAt: { gte: now, lt: tomorrow } },
                      {
                        dispatchDeadlineAt: null,
                        deadlineAt: new Date(`${today}T00:00:00.000Z`),
                      },
                    ],
                  },
                ]
              : sla === "upcoming"
                ? [
                    {
                      status: { notIn: ["delivered", "cancelled"] },
                      OR: [
                        { dispatchDeadlineAt: { gte: tomorrow } },
                        {
                          dispatchDeadlineAt: null,
                          deadlineAt: {
                            gt: new Date(`${today}T00:00:00.000Z`),
                          },
                        },
                      ],
                    },
                  ]
                : []),
          ...(query
            ? [
                {
                  OR: [
                    { number: { contains: query, mode: "insensitive" } },
                    { trackingCode: { contains: query, mode: "insensitive" } },
                    { carrier: { contains: query, mode: "insensitive" } },
                    {
                      salesOrder: {
                        is: {
                          OR: [
                            {
                              number: {
                                contains: query,
                                mode: "insensitive",
                              },
                            },
                            {
                              customerName: {
                                contains: query,
                                mode: "insensitive",
                              },
                            },
                          ],
                        },
                      },
                    },
                  ],
                },
              ]
            : []),
        ] as Prisma.ShipmentWhereInput[],
      };
    if (searchParams.get("export") === "csv") {
      await enforceOmnichannelRateLimit(
        db,
        context.access.user.id,
        "export.csv",
      );
      const exportRows = await db.shipment.findMany({
        where,
        include,
        orderBy: { createdAt: "desc" },
        take: 10_000,
      });
      return logisticsCsv(exportRows, timezone);
    }
    const [
      shipments,
      total,
      summaryShipments,
      openReturns,
      availableOrderCandidates,
      warehouses,
      carriers,
      channels,
      manifests,
      waves,
    ] = await Promise.all([
      db.shipment.findMany({
        where,
        include,
        orderBy: [
          { dispatchDeadlineAt: { sort: "asc", nulls: "last" } },
          { createdAt: "desc" },
        ],
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
      db.shipment.count({ where }),
      db.shipment.findMany({
        where,
        select: {
          status: true,
          priority: true,
          carrier: true,
          service: true,
          createdAt: true,
          packedAt: true,
          dispatchedAt: true,
          deliveredAt: true,
          deadlineAt: true,
          dispatchDeadlineAt: true,
          freight: true,
          quotedFreightCents: true,
          actualFreightCents: true,
          packageCount: true,
          incidents: { select: { status: true, category: true } },
          packages: {
            select: { status: true, weightKg: true, actualFreightCents: true },
          },
          manifestEntries: { select: { id: true } },
          warehouse: { select: { id: true, name: true } },
          channelOrder: {
            select: { channel: { select: { id: true, name: true } } },
          },
        },
      }),
      db.orderReturn.count({
        where: {
          status: { in: ["pending", "authorized", "in_transit", "received"] },
          salesOrder: { branchId: { in: branchIds } },
        },
      }),
      db.salesOrder.findMany({
        where: {
          branchId: { in: branchIds },
          status: { in: ["approved", "partially_shipped"] },
          posClaims: { none: { state: "active" } },
          OR: [
            { channelOrder: { is: null } },
            {
              channelOrder: {
                is: {
                  paymentStatus: "paid",
                  riskStatus: "approved",
                  buyerCancelRequested: false,
                },
              },
            },
          ],
        },
        include: {
          channelOrder: { include: { channel: true } },
          items: { include: { product: true, variation: true } },
          shipments: {
            where: { status: { not: "cancelled" } },
            select: {
              items: {
                select: { salesOrderItemId: true, quantity: true },
              },
            },
          },
        },
        orderBy: { createdAt: "asc" },
        take: 200,
      }),
      db.warehouse.findMany({
        where: { active: true, branchId: { in: branchIds } },
        orderBy: { name: "asc" },
      }),
      db.shippingCarrier.findMany({
        where: { active: true },
        select: { key: true, label: true, urlTemplate: true },
        orderBy: [{ position: "asc" }, { label: "asc" }],
      }),
      db.marketplaceChannel.findMany({
        where: { status: "active" },
        select: { id: true, name: true, provider: true },
        orderBy: { name: "asc" },
      }),
      db.shippingManifest.findMany({
        where: { branchId: { in: branchIds } },
        include: { _count: { select: { shipments: true } } },
        orderBy: { createdAt: "desc" },
        take: 20,
      }),
      db.pickingWave.findMany({
        where: { branchId: { in: branchIds } },
        include: { _count: { select: { shipments: true } } },
        orderBy: { createdAt: "desc" },
        take: 20,
      }),
    ]);
    const availableOrders = availableOrderCandidates
        .map((order) => ({
          id: order.id,
          number: order.number,
          customerName: order.customerName,
          total: order.total,
          priority: order.priority,
          channelOrder: order.channelOrder,
          items: order.items
            .map((item) => {
              const allocatedQuantity = order.shipments.reduce(
                (sum, shipment) =>
                  sum +
                  (shipment.items.find(
                    (row) => row.salesOrderItemId === item.id,
                  )?.quantity || 0),
                0,
              );
              return {
                id: item.id,
                productId: item.productId,
                variationId: item.variationId,
                name: item.product.name,
                sku: item.variation?.sku || item.product.sku,
                quantity: item.quantity,
                allocatedQuantity,
                remainingQuantity: Math.max(
                  0,
                  item.quantity - allocatedQuantity,
                ),
              };
            })
            .filter((item) => item.remainingQuantity > 0.0001),
        }))
        .filter((order) => order.items.length),
      availableOrderCount = availableOrders.length,
      summary = logisticsSummary(summaryShipments, timezone, now);
    return logisticsJson({
      shipments,
      pagination: {
        page,
        pageSize,
        total,
        pages: Math.max(1, Math.ceil(total / pageSize)),
      },
      availableOrders,
      availableOrderCount,
      warehouses,
      carriers,
      channels,
      manifests,
      waves,
      branch: {
        id: activeBranch.id,
        name: activeBranch.name,
        timezone,
        crossBranch: branchIds.length > 1,
      },
      summary: { ...summary, openReturns },
    });
  } catch (error) {
    return failure(error);
  }
}

export async function POST(request: Request) {
  const key = request.headers.get("idempotency-key")?.trim() || "";
  if (key.length < 16 || key.length > 160)
    return logisticsJson(
      { error: "Informe uma chave de idempotência válida." },
      { status: 400 },
    );
  let db: Awaited<ReturnType<typeof tenantDb>> | null = null;
  let receiptId = "";
  try {
    const payload = await request.clone().text();
    if (new TextEncoder().encode(payload).byteLength > 262_144)
      throw new OmnichannelHttpError("Payload excede o limite permitido.", 413);
    const organization = await currentOrganization(),
      access = await assertTenantPermission(organization.id, "logistics.write"),
      requestHash = createHash("sha256").update(payload).digest("hex"),
      correlationId = randomUUID();
    db = await tenantDb(organization.id);
    const existing = await db.logisticsOperationReceipt.findUnique({
      where: { idempotencyKey: key },
    });
    if (existing && existing.requestHash !== requestHash)
      throw new OmnichannelHttpError(
        "A chave de idempotência já foi usada com dados diferentes.",
        409,
      );
    if (
      existing?.state === "completed" &&
      existing.responseStatus &&
      existing.responseBody
    )
      return logisticsJson(existing.responseBody, {
        status: existing.responseStatus,
        headers: { "x-idempotent-replay": "true" },
      });
    if (existing?.state === "accepted" && existing.expiresAt > new Date())
      return logisticsJson(
        { error: "Esta operação ainda está em processamento." },
        { status: 409, headers: { "retry-after": "3" } },
      );
    if (existing)
      await db.logisticsOperationReceipt.delete({ where: { id: existing.id } });
    const receipt = await db.logisticsOperationReceipt.create({
      data: {
        idempotencyKey: key,
        action: safeAction(payload),
        requestHash,
        actorId: access.user.id,
        correlationId,
        expiresAt: new Date(Date.now() + 24 * 60 * 60_000),
      },
    });
    receiptId = receipt.id;
    const response = await processPost(request, correlationId);
    const responseBody = await response
      .clone()
      .json()
      .catch(() => ({
        error: "Resposta logística inválida.",
        correlationId,
      }));
    await db.logisticsOperationReceipt.update({
      where: { id: receipt.id },
      data: response.ok
        ? {
            state: "completed",
            responseStatus: response.status,
            responseBody,
          }
        : { state: "failed", responseStatus: response.status, responseBody },
    });
    return response;
  } catch (error) {
    if (db && receiptId)
      await db.logisticsOperationReceipt
        .update({ where: { id: receiptId }, data: { state: "failed" } })
        .catch(() => undefined);
    return failure(error);
  }
}

async function processPost(request: Request, operationCorrelationId: string) {
  try {
    assertSameOrigin(request);
    assertOmnichannelMutationRequest(request);
    const context = await logisticsContext("logistics.write"),
      { organization, access, db, branchIds } = context;
    await assertTenantWriteAccess(organization.id);
    const body = await readOmnichannelJson(request),
      correlationId = operationCorrelationId;
    await enforceOmnichannelRateLimit(
      db,
      access.user.id,
      String(body.action || "unknown"),
    );
    await assertLogisticsScope(db, body, branchIds);
    if (body.action === "create") {
      const input = shipmentInput(body);
      const shipment = await db.$transaction(
        async (tx) => {
          await tx.$queryRaw(
            Prisma.sql`SELECT "id" FROM "sales_orders" WHERE "id" = ${input.salesOrderId} FOR UPDATE`,
          );
          const [order, warehouse, activeClaim, convertedSale] =
            await Promise.all([
              tx.salesOrder.findFirst({
                where: {
                  id: input.salesOrderId,
                  branchId: { in: branchIds },
                  status: { in: ["approved", "partially_shipped"] },
                  OR: [
                    { channelOrder: { is: null } },
                    {
                      channelOrder: {
                        is: {
                          paymentStatus: "paid",
                          riskStatus: "approved",
                          buyerCancelRequested: false,
                        },
                      },
                    },
                  ],
                },
                include: {
                  items: true,
                  channelOrder: true,
                  shipments: {
                    where: { status: { not: "cancelled" } },
                    include: { items: true },
                  },
                },
              }),
              tx.warehouse.findFirst({
                where: {
                  id: input.warehouseId,
                  active: true,
                  branchId: { in: branchIds },
                },
              }),
              tx.posOrderClaim.findFirst({
                where: { salesOrderId: input.salesOrderId, state: "active" },
                select: { id: true },
              }),
              tx.sale.findUnique({
                where: {
                  sourceType_sourceId: {
                    sourceType: "sales_order",
                    sourceId: String(input.salesOrderId),
                  },
                },
                select: { id: true },
              }),
            ]);
          if (!order || !warehouse || activeClaim || convertedSale)
            throw new OmnichannelInputError(
              "Pedido aprovado está em uso no PDV, já foi convertido ou o depósito não está disponível.",
            );
          const remainingItems = order.items
              .map((item) => ({
                orderItem: item,
                remainingQuantity: Math.max(
                  0,
                  item.quantity -
                    order.shipments.reduce(
                      (sum, shipment) =>
                        sum +
                        (shipment.items.find(
                          (row) => row.salesOrderItemId === item.id,
                        )?.quantity || 0),
                      0,
                    ),
                ),
              }))
              .filter((item) => item.remainingQuantity > 0.0001),
            requestedItems = input.items.length
              ? input.items.map((requested) => {
                  const available = remainingItems.find(
                    (item) => item.orderItem.id === requested.orderItemId,
                  );
                  if (
                    !available ||
                    requested.quantity > available.remainingQuantity + 0.0001
                  )
                    throw new OmnichannelInputError(
                      "A expedição contém item ou quantidade superior ao saldo pendente do pedido.",
                    );
                  return {
                    salesOrderItemId: available.orderItem.id,
                    quantity: requested.quantity,
                  };
                })
              : remainingItems.map((item) => ({
                  salesOrderItemId: item.orderItem.id,
                  quantity: item.remainingQuantity,
                }));
          if (!requestedItems.length)
            throw new OmnichannelInputError(
              "O pedido não possui quantidade pendente para expedição.",
            );
          const created = await tx.shipment.create({
            data: {
              number: `EXP-${Date.now().toString(36).toUpperCase()}-${randomUUID().slice(0, 6).toUpperCase()}`,
              salesOrderId: order.id,
              channelOrderId: order.channelOrder?.id,
              warehouseId: warehouse.id,
              carrier: input.carrier,
              service: input.service,
              freight: input.freight,
              deadlineAt: input.deadlineAt,
              dispatchDeadlineAt: input.dispatchDeadlineAt,
              priority: input.priority,
              packageCount: input.packageCount,
              weightKg: input.weightKg,
              lengthCm: input.lengthCm,
              widthCm: input.widthCm,
              heightCm: input.heightCm,
              fiscalRequired: Boolean(order.channelOrder),
              fiscalStatus: order.channelOrder
                ? ["authorized", "approved", "issued"].includes(
                    String(order.channelOrder.invoiceStatus || ""),
                  )
                  ? "authorized"
                  : "pending"
                : "not_required",
              quotedFreightCents: Math.round(input.freight * 100),
              chargedFreightCents: Math.round(order.freightAmount * 100),
              declaredValueCents: Math.round(order.total * 100),
              createdBy: access.user.name,
              items: {
                create: requestedItems,
              },
              events: {
                create: {
                  type: "created",
                  description: "Expedição aberta para separação",
                  actor: access.user.name,
                },
              },
            },
            include,
          });
          await tx.tenantAuditEvent.create({
            data: {
              actorId: access.user.id,
              action: "shipment.created",
              entityType: "shipment",
              entityId: String(created.id),
              correlationId,
              afterData: { salesOrderId: order.id, warehouseId: warehouse.id },
            },
          });
          return created;
        },
        { isolationLevel: "Serializable", maxWait: 10_000, timeout: 30_000 },
      );
      return logisticsJson({ shipment, correlationId }, { status: 201 });
    }
    if (body.action === "pick.wave") {
      const rawIds = Array.isArray(body.shipmentIds) ? body.shipmentIds : [],
        shipmentIds = [...new Set(rawIds.map((value) => entityId(value)))];
      if (!shipmentIds.length || shipmentIds.length > 100)
        throw new OmnichannelInputError(
          "Selecione de 1 a 100 expedições para separar na onda.",
        );
      const result = await db.$transaction(
        async (tx) => {
          await tx.$queryRaw(
            Prisma.sql`SELECT "id" FROM "shipments" WHERE "id" IN (${Prisma.join(shipmentIds)}) ORDER BY "id" FOR UPDATE`,
          );
          const shipments = await tx.shipment.findMany({
            where: { id: { in: shipmentIds } },
            include,
            orderBy: { id: "asc" },
          });
          if (
            shipments.length !== shipmentIds.length ||
            shipments.some((shipment) => shipment.status !== "picking")
          )
            throw new OmnichannelInputError(
              "Uma ou mais expedições da onda não estão disponíveis para separação.",
            );
          if (
            new Set(shipments.map((shipment) => shipment.warehouseId)).size !==
            1
          )
            throw new OmnichannelInputError(
              "Uma onda deve usar um único depósito.",
            );
          await assertPickingWaveStock(tx, shipments);
          const warehouse = shipments[0]!.warehouse;
          if (!warehouse.branchId)
            throw new OmnichannelInputError(
              "O depósito precisa estar vinculado a uma filial.",
            );
          const wave = await tx.pickingWave.create({
            data: {
              number: `OND-${Date.now().toString(36).toUpperCase()}-${randomUUID().slice(0, 5).toUpperCase()}`,
              branchId: warehouse.branchId,
              warehouseId: warehouse.id,
              status: "open",
              priority: shipments.some((item) => item.priority === "urgent")
                ? "urgent"
                : shipments.some((item) => item.priority === "high")
                  ? "high"
                  : "normal",
              assignedTo: access.user.name,
              createdBy: access.user.name,
              shipments: {
                create: shipments.map((shipment, position) => ({
                  shipmentId: shipment.id,
                  position,
                  status: "pending",
                })),
              },
            },
          });
          for (const shipment of shipments) {
            await tx.shipment.update({
              where: { id: shipment.id },
              data: {
                assignedTo: access.user.name,
                version: { increment: 1 },
              },
            });
            await tx.shipmentEvent.create({
              data: {
                shipmentId: shipment.id,
                type: "wave_assigned",
                description: `Atribuída à onda ${wave.number}; aguardando leitura e conferência`,
                actor: access.user.name,
              },
            });
            await tx.tenantAuditEvent.create({
              data: {
                actorId: access.user.id,
                action: "shipment.wave_assigned",
                entityType: "shipment",
                entityId: String(shipment.id),
                correlationId,
                afterData: {
                  waveId: wave.id,
                  waveNumber: wave.number,
                  waveSize: shipments.length,
                },
              },
            });
          }
          return { count: shipments.length, waveNumber: wave.number };
        },
        { isolationLevel: "Serializable", maxWait: 10_000, timeout: 30_000 },
      );
      return logisticsJson({ ...result, correlationId });
    }
    if (body.action === "manifest.create") {
      const input = shippingManifestInput(body);
      const result = await db.$transaction(
        async (tx) => {
          await tx.$queryRaw(
            Prisma.sql`SELECT "id" FROM "shipments" WHERE "id" IN (${Prisma.join(input.shipmentIds)}) ORDER BY "id" FOR UPDATE`,
          );
          const shipments = await tx.shipment.findMany({
            where: { id: { in: input.shipmentIds } },
            include,
            orderBy: { id: "asc" },
          });
          if (
            shipments.length !== input.shipmentIds.length ||
            shipments.some(
              (shipment) => !["packed", "dispatched"].includes(shipment.status),
            )
          )
            throw new OmnichannelInputError(
              "O romaneio aceita somente expedições embaladas ou despachadas.",
            );
          if (
            input.confirmHandoff &&
            shipments.some((shipment) => shipment.status !== "dispatched")
          )
            throw new OmnichannelInputError(
              "Confirme a coleta somente após despachar todas as expedições.",
            );
          if (
            new Set(shipments.map((shipment) => shipment.warehouseId)).size !==
            1
          )
            throw new OmnichannelInputError(
              "Um romaneio deve usar um único depósito.",
            );
          const carriers = new Set(
              shipments.map((shipment) => shipment.carrier).filter(Boolean),
            ),
            carrier = input.carrier || [...carriers][0];
          if (!carrier || (carriers.size > 1 && !input.carrier))
            throw new OmnichannelInputError(
              "Informe uma única transportadora para o romaneio.",
            );
          const manifestNumber =
              input.manifestNumber ||
              `ROM-${Date.now().toString(36).toUpperCase()}-${randomUUID().slice(0, 5).toUpperCase()}`,
            manifestedAt = new Date(),
            handoffAt = input.confirmHandoff ? manifestedAt : null;
          const warehouse = shipments[0]!.warehouse;
          if (!warehouse.branchId)
            throw new OmnichannelInputError(
              "O depósito precisa estar vinculado a uma filial.",
            );
          const manifest = await tx.shippingManifest.create({
            data: {
              number: manifestNumber,
              branchId: warehouse.branchId,
              warehouseId: warehouse.id,
              carrier,
              status: input.confirmHandoff ? "handed_off" : "closed",
              pickupWindow: input.pickupWindow,
              dock: input.dock,
              vehiclePlate: input.vehiclePlate,
              driverName: input.driverName,
              driverDocument: input.driverDocument,
              protocol: input.protocol,
              totalPackages: shipments.reduce(
                (sum, shipment) => sum + shipment.packages.length,
                0,
              ),
              totalWeightKg: shipments.reduce(
                (sum, shipment) =>
                  sum +
                  shipment.packages.reduce(
                    (weight, item) => weight + item.weightKg,
                    0,
                  ),
                0,
              ),
              createdBy: access.user.name,
              closedAt: manifestedAt,
              handedOffAt: handoffAt,
              shipments: {
                create: shipments.map((shipment) => ({
                  shipmentId: shipment.id,
                })),
              },
            },
          });
          for (const shipment of shipments) {
            await tx.shipment.update({
              where: { id: shipment.id },
              data: {
                carrier,
                manifestNumber,
                manifestedAt,
                handoffAt,
                version: { increment: 1 },
              },
            });
            await tx.shipmentEvent.create({
              data: {
                shipmentId: shipment.id,
                type: input.confirmHandoff ? "handoff" : "manifested",
                description: input.confirmHandoff
                  ? `Coleta confirmada no romaneio ${manifestNumber} · ${carrier}`
                  : `Incluído no romaneio ${manifestNumber} · ${carrier}`,
                actor: access.user.name,
              },
            });
            await tx.tenantAuditEvent.create({
              data: {
                actorId: access.user.id,
                action: input.confirmHandoff
                  ? "shipment.handoff_confirmed"
                  : "shipment.manifested",
                entityType: "shipment",
                entityId: String(shipment.id),
                correlationId,
                afterData: {
                  manifestId: manifest.id,
                  manifestNumber,
                  carrier,
                  handoffAt,
                },
              },
            });
          }
          return {
            count: shipments.length,
            manifestNumber,
            carrier,
            manifestId: manifest.id,
          };
        },
        { isolationLevel: "Serializable", maxWait: 10_000, timeout: 30_000 },
      );
      return logisticsJson({ ...result, correlationId });
    }
    if (body.action === "manifest.update") {
      const manifestId = String(body.manifestId || "").trim(),
        nextStatus = String(body.status || "");
      if (
        !manifestId ||
        !["open", "closed", "handed_off", "cancelled"].includes(nextStatus)
      )
        throw new OmnichannelInputError("Situação do romaneio inválida.");
      const manifest = await db.$transaction(async (tx) => {
        await tx.$queryRaw(
          Prisma.sql`SELECT "id" FROM "shipping_manifests" WHERE "id" = ${manifestId} FOR UPDATE`,
        );
        const current = await tx.shippingManifest.findFirst({
          where: { id: manifestId, branchId: { in: branchIds } },
          include: { shipments: true },
        });
        if (!current)
          throw new OmnichannelInputError("Romaneio não encontrado.");
        const transitions: Record<string, string[]> = {
          open: ["closed", "cancelled"],
          closed: ["open", "handed_off", "cancelled"],
          handed_off: [],
          cancelled: ["open"],
        };
        if (!(transitions[current.status] || []).includes(nextStatus))
          throw new OmnichannelInputError("Transição de romaneio inválida.");
        const now = new Date(),
          updated = await tx.shippingManifest.update({
            where: { id: current.id },
            data: {
              status: nextStatus,
              pickupWindow:
                optionalDateTime(body.pickupWindow) || current.pickupWindow,
              dock: optionalText(body.dock, 80) || current.dock,
              vehiclePlate:
                optionalText(body.vehiclePlate, 12)?.toUpperCase() ||
                current.vehiclePlate,
              driverName:
                optionalText(body.driverName, 160) || current.driverName,
              driverDocument:
                maskSensitiveDocument(optionalText(body.driverDocument, 30)) ||
                current.driverDocument,
              protocol: optionalText(body.protocol, 160) || current.protocol,
              closedAt:
                nextStatus === "closed"
                  ? now
                  : nextStatus === "open"
                    ? null
                    : current.closedAt,
              handedOffAt:
                nextStatus === "handed_off" ? now : current.handedOffAt,
              cancelledAt:
                nextStatus === "cancelled"
                  ? now
                  : nextStatus === "open"
                    ? null
                    : current.cancelledAt,
            },
          });
        for (const entry of current.shipments) {
          await tx.shipment.update({
            where: { id: entry.shipmentId },
            data:
              nextStatus === "cancelled"
                ? {
                    manifestNumber: null,
                    manifestedAt: null,
                    handoffAt: null,
                    version: { increment: 1 },
                  }
                : {
                    manifestNumber: current.number,
                    manifestedAt: current.closedAt || now,
                    handoffAt: nextStatus === "handed_off" ? now : null,
                    version: { increment: 1 },
                  },
          });
          await tx.shipmentEvent.create({
            data: {
              shipmentId: entry.shipmentId,
              type: `manifest_${nextStatus}`,
              description: `Romaneio ${current.number} atualizado para ${nextStatus}`,
              actor: access.user.name,
            },
          });
        }
        await tx.tenantAuditEvent.create({
          data: {
            actorId: access.user.id,
            action: "shipment.manifest_updated",
            entityType: "shipping_manifest",
            entityId: current.id,
            correlationId,
            beforeData: { status: current.status },
            afterData: { status: nextStatus },
          },
        });
        return updated;
      });
      return logisticsJson({ manifest, correlationId });
    }
    if (body.action === "pick.items") {
      const input = shipmentPickingInput(body);
      const updated = await db.$transaction(
        async (tx) => {
          await tx.$queryRaw(
            Prisma.sql`SELECT "id" FROM "shipments" WHERE "id" = ${input.shipmentId} FOR UPDATE`,
          );
          const shipment = await tx.shipment.findUnique({
            where: { id: input.shipmentId },
            include,
          });
          if (!shipment || shipment.status !== "picking")
            throw new OmnichannelInputError(
              "Expedição não está disponível para separação.",
            );
          if (
            input.items.length !== shipment.items.length ||
            input.items.some(
              (row) => !shipment.items.some((item) => item.id === row.itemId),
            )
          )
            throw new OmnichannelInputError(
              "A conferência precisa conter todos os itens da expedição.",
            );
          await assertPickingStock(tx, shipment);
          for (const row of input.items) {
            const item = shipment.items.find(
              (candidate) => candidate.id === row.itemId,
            )!;
            if (row.pickedQuantity > item.quantity)
              throw new OmnichannelInputError(
                `Quantidade separada excede o pedido para ${item.salesOrderItem.product.name}.`,
              );
            if (row.shortQuantity > item.quantity - row.pickedQuantity + 0.0001)
              throw new OmnichannelInputError(
                `A ruptura informada excede o saldo não separado de ${item.salesOrderItem.product.name}.`,
              );
            if (item.salesOrderItem.product.type === "product") {
              const balance = item.salesOrderItem.variationId
                ? await tx.warehouseVariationBalance.findUnique({
                    where: {
                      warehouseId_variationId: {
                        warehouseId: shipment.warehouseId,
                        variationId: item.salesOrderItem.variationId,
                      },
                    },
                  })
                : await tx.warehouseBalance.findUnique({
                    where: {
                      warehouseId_productId: {
                        warehouseId: shipment.warehouseId,
                        productId: item.salesOrderItem.productId,
                      },
                    },
                  });
              if (!balance || balance.quantity < row.pickedQuantity)
                throw new OmnichannelInputError(
                  `Saldo insuficiente para separar ${item.salesOrderItem.product.name}.`,
                );
              await replacePickAllocations(
                tx,
                shipment,
                item,
                row,
                access.user.name,
              );
            }
            await tx.shipmentItem.update({
              where: { id: item.id },
              data: {
                pickedQuantity: row.pickedQuantity,
                shortQuantity: row.shortQuantity,
                location: row.location,
              },
            });
          }
          const complete = input.items.every(
            (row) =>
              row.pickedQuantity >=
              shipment.items.find((item) => item.id === row.itemId)!.quantity,
          );
          await tx.shipment.update({
            where: { id: shipment.id },
            data: {
              pickingStartedAt: shipment.pickingStartedAt || new Date(),
              holdReason: complete
                ? null
                : input.items.some((row) => row.shortQuantity > 0)
                  ? "Ruptura de estoque aguardando tratamento"
                  : null,
              version: { increment: 1 },
            },
          });
          await tx.shipmentEvent.create({
            data: {
              shipmentId: shipment.id,
              type: complete ? "picked" : "picking_progress",
              description: complete
                ? "Todos os itens foram separados e conferidos"
                : "Progresso da separação atualizado",
              actor: access.user.name,
            },
          });
          if (complete) {
            const activeWaveEntries = await tx.pickingWaveShipment.findMany({
              where: {
                shipmentId: shipment.id,
                status: { in: ["pending", "in_progress"] },
              },
              select: { id: true, waveId: true },
            });
            if (activeWaveEntries.length) {
              await tx.pickingWaveShipment.updateMany({
                where: { id: { in: activeWaveEntries.map((item) => item.id) } },
                data: { status: "completed" },
              });
              for (const waveId of new Set(
                activeWaveEntries.map((item) => item.waveId),
              )) {
                const remaining = await tx.pickingWaveShipment.count({
                  where: {
                    waveId,
                    status: { in: ["pending", "in_progress", "short"] },
                  },
                });
                await tx.pickingWave.update({
                  where: { id: waveId },
                  data: remaining
                    ? { status: "in_progress", startedAt: new Date() }
                    : {
                        status: "completed",
                        startedAt: new Date(),
                        completedAt: new Date(),
                      },
                });
              }
            }
          }
          await tx.tenantAuditEvent.create({
            data: {
              actorId: access.user.id,
              action: "shipment.picking_updated",
              entityType: "shipment",
              entityId: String(shipment.id),
              correlationId,
              afterData: { complete, items: input.items },
            },
          });
          return tx.shipment.findUniqueOrThrow({
            where: { id: shipment.id },
            include,
          });
        },
        { isolationLevel: "Serializable", maxWait: 10_000, timeout: 30_000 },
      );
      return logisticsJson({ shipment: updated, correlationId });
    }
    if (body.action === "pick") {
      const id = entityId(body.shipmentId);
      const updated = await db.$transaction(
        async (tx) => {
          await lockShipment(tx, id);
          const shipment = await tx.shipment.findUnique({
            where: { id },
            include,
          });
          if (!shipment || shipment.status !== "picking")
            throw new OmnichannelInputError(
              "Expedição não está disponível para separação.",
            );
          await assertPickingStock(tx, shipment);
          await Promise.all(
            shipment.items.map((item) =>
              tx.shipmentItem.update({
                where: { id: item.id },
                data: { pickedQuantity: item.quantity },
              }),
            ),
          );
          await tx.shipmentEvent.create({
            data: {
              shipmentId: id,
              type: "picked",
              description: "Todos os itens foram separados e conferidos",
              actor: access.user.name,
            },
          });
          await tx.shipment.update({
            where: { id },
            data: { pickingStartedAt: shipment.pickingStartedAt || new Date() },
          });
          await tx.tenantAuditEvent.create({
            data: {
              actorId: access.user.id,
              action: "shipment.picked",
              entityType: "shipment",
              entityId: String(id),
              correlationId,
              afterData: { items: shipment.items.length },
            },
          });
          return tx.shipment.findUniqueOrThrow({ where: { id }, include });
        },
        { isolationLevel: "Serializable", maxWait: 10_000, timeout: 30_000 },
      );
      return logisticsJson({ shipment: updated, correlationId });
    }
    if (body.action === "pack") {
      const input = shipmentPackingInput(body),
        id = input.shipmentId;
      const updated = await db.$transaction(
        async (tx) => {
          await lockShipment(tx, id);
          const shipment = await tx.shipment.findUnique({
            where: { id },
            include: { items: true, packages: true },
          });
          if (
            !shipment ||
            shipment.status !== "picking" ||
            shipment.items.some((item) => item.pickedQuantity < item.quantity)
          )
            throw new OmnichannelInputError(
              "Conclua a separação antes de embalar.",
            );
          const packageRows = input.packages.length
            ? input.packages
            : Array.from({ length: input.packageCount }, (_, index) => ({
                sequence: index + 1,
                weightKg: input.weightKg! / input.packageCount,
                lengthCm: input.lengthCm!,
                widthCm: input.widthCm!,
                heightCm: input.heightCm!,
                sscc: null,
                trackingCode: null,
                labelUrl: null,
                labelFormat: "pdf",
                items:
                  index === 0
                    ? shipment.items.map((item) => ({
                        shipmentItemId: item.id,
                        quantity: item.quantity,
                      }))
                    : [],
              }));
          const allocationByItem = new Map<number, number>();
          for (const volume of packageRows)
            for (const item of volume.items)
              allocationByItem.set(
                item.shipmentItemId,
                (allocationByItem.get(item.shipmentItemId) || 0) +
                  item.quantity,
              );
          if (
            packageRows.some((volume) =>
              volume.items.some(
                (row) =>
                  !shipment.items.some(
                    (item) => item.id === row.shipmentItemId,
                  ),
              ),
            ) ||
            shipment.items.some(
              (item) =>
                Math.abs((allocationByItem.get(item.id) || 0) - item.quantity) >
                0.0001,
            )
          )
            throw new OmnichannelInputError(
              "Distribua toda a quantidade separada entre os volumes, sem sobras ou excessos.",
            );
          if (shipment.packages.length)
            await tx.shipmentPackage.deleteMany({ where: { shipmentId: id } });
          await Promise.all(
            packageRows.map((volume) =>
              tx.shipmentPackage.create({
                data: {
                  shipmentId: id,
                  sequence: volume.sequence,
                  code: `${shipment.number}-V${String(volume.sequence).padStart(3, "0")}`,
                  status: volume.labelUrl ? "label_ready" : "packed",
                  carrier: shipment.carrier,
                  service: shipment.service,
                  trackingCode: volume.trackingCode,
                  sscc: volume.sscc || generateSscc(id, volume.sequence),
                  weightKg: volume.weightKg,
                  lengthCm: volume.lengthCm,
                  widthCm: volume.widthCm,
                  heightCm: volume.heightCm,
                  volumetricWeightKg:
                    Math.round(
                      ((volume.lengthCm * volume.widthCm * volume.heightCm) /
                        6000) *
                        1000,
                    ) / 1000,
                  declaredValueCents: Math.round(
                    shipment.declaredValueCents *
                      (volume.items.reduce(
                        (sum, item) => sum + item.quantity,
                        0,
                      ) /
                        Math.max(
                          0.0001,
                          shipment.items.reduce(
                            (sum, item) => sum + item.quantity,
                            0,
                          ),
                        )),
                  ),
                  labelFormat: volume.labelFormat,
                  labelUrl: volume.labelUrl,
                  labelGeneratedAt: volume.labelUrl ? new Date() : null,
                  items: {
                    create: volume.items.map((item) => ({
                      shipmentItemId: item.shipmentItemId,
                      quantity: item.quantity,
                    })),
                  },
                },
              }),
            ),
          );
          const value = await tx.shipment.update({
            where: { id },
            data: {
              status: "packed",
              packedBy: access.user.name,
              packedAt: new Date(),
              packageCount: input.packageCount,
              weightKg: input.weightKg,
              lengthCm: input.lengthCm,
              widthCm: input.widthCm,
              heightCm: input.heightCm,
              version: { increment: 1 },
            },
            include,
          });
          await tx.shipmentEvent.create({
            data: {
              shipmentId: id,
              type: "packed",
              description: "Volumes embalados e conferidos",
              actor: access.user.name,
            },
          });
          await tx.tenantAuditEvent.create({
            data: {
              actorId: access.user.id,
              action: "shipment.packed",
              entityType: "shipment",
              entityId: String(id),
              correlationId,
            },
          });
          return value;
        },
        { isolationLevel: "Serializable", maxWait: 10_000, timeout: 30_000 },
      );
      return logisticsJson({ shipment: updated, correlationId });
    }
    if (body.action === "freight.quote") {
      const shipmentId = entityId(body.shipmentId);
      const shipment = await db.$transaction(async (tx) => {
        await lockShipment(tx, shipmentId);
        const current = await tx.shipment.findUnique({
          where: { id: shipmentId },
          include,
        });
        if (!current || !["picking", "packed"].includes(current.status))
          throw new OmnichannelInputError(
            "A cotação aceita somente expedições em preparação.",
          );
        const carriers = await tx.shippingCarrier.findMany({
          where: { active: true },
          orderBy: [{ position: "asc" }, { label: "asc" }],
          take: 5,
        });
        if (!carriers.length)
          throw new OmnichannelInputError(
            "Cadastre ao menos uma transportadora ativa para cotar.",
          );
        const realWeight = current.packages.length
            ? current.packages.reduce((sum, item) => sum + item.weightKg, 0)
            : current.weightKg || 0.1,
          volumetricWeight = current.packages.length
            ? current.packages.reduce(
                (sum, item) => sum + item.volumetricWeightKg,
                0,
              )
            : ((current.lengthCm || 10) *
                (current.widthCm || 10) *
                (current.heightCm || 10)) /
              6000,
          billingWeight = Math.max(realWeight, volumetricWeight, 0.1),
          destinationFactor = current.salesOrder.deliveryState
            ? ["SP", "PR", "SC", "RS"].includes(
                current.salesOrder.deliveryState,
              )
              ? 1
              : 1.28
            : 1.4,
          quotes = carriers.map((carrier, index) => ({
            carrier: carrier.label,
            service: index % 2 ? "Expresso" : "Econômico",
            amountCents: Math.round(
              (1290 + billingWeight * (260 + index * 35)) * destinationFactor,
            ),
            deliveryDays: Math.max(
              1,
              Math.round(3 + destinationFactor * 2 + index),
            ),
            source: "contract_fallback",
          })),
          best = [...quotes].sort(
            (left, right) => left.amountCents - right.amountCents,
          )[0]!;
        const updated = await tx.shipment.update({
          where: { id: current.id },
          data: {
            carrier: best.carrier,
            service: best.service,
            freight: best.amountCents / 100,
            quotedFreightCents: best.amountCents,
            version: { increment: 1 },
          },
          include,
        });
        await tx.shipmentEvent.create({
          data: {
            shipmentId: current.id,
            type: "freight_quoted",
            description: `${quotes.length} cotações calculadas; ${best.carrier} ${best.service} selecionado por ${best.amountCents / 100} BRL`,
            actor: access.user.name,
          },
        });
        await tx.tenantAuditEvent.create({
          data: {
            actorId: access.user.id,
            action: "shipment.freight_quoted",
            entityType: "shipment",
            entityId: String(current.id),
            correlationId,
            afterData: { billingWeight, quotes, selected: best },
          },
        });
        return updated;
      });
      return logisticsJson({ shipment, correlationId });
    }
    if (body.action === "label.generate") {
      const shipmentId = entityId(body.shipmentId);
      const shipment = await db.$transaction(async (tx) => {
        await lockShipment(tx, shipmentId);
        const current = await tx.shipment.findUnique({
          where: { id: shipmentId },
          include,
        });
        if (!current || current.status !== "packed" || !current.packages.length)
          throw new OmnichannelInputError(
            "Embale e confira os volumes antes de gerar etiquetas.",
          );
        for (const volume of current.packages) {
          const trackingCode =
              volume.trackingCode ||
              operationalTrackingCode(current.id, volume.sequence),
            labelUrl = `/api/erp/logistics/labels/${volume.id}?format=${volume.labelFormat || "pdf"}`;
          await tx.shipmentPackage.update({
            where: { id: volume.id },
            data: {
              status: "label_ready",
              carrier: current.carrier,
              service: current.service,
              trackingCode,
              labelUrl,
              labelGeneratedAt: new Date(),
            },
          });
          await tx.orderShippingLabel.upsert({
            where: {
              salesOrderId_externalId: {
                salesOrderId: current.salesOrderId,
                externalId: volume.id,
              },
            },
            update: {
              carrier: current.carrier,
              serviceName: current.service,
              status: "purchased",
              trackingCode,
              labelUrl,
              purchasedAt: new Date(),
            },
            create: {
              salesOrderId: current.salesOrderId,
              provider: "nalven_logistics",
              externalId: volume.id,
              carrier: current.carrier,
              serviceName: current.service,
              status: "purchased",
              statusLabel: "Etiqueta operacional pronta",
              amount:
                (current.quotedFreightCents || 0) /
                100 /
                current.packages.length,
              trackingCode,
              labelUrl,
              purchasedAt: new Date(),
              createdBy: access.user.name,
            },
          });
        }
        const first = current.packages[0]!,
          trackingCode =
            first.trackingCode || operationalTrackingCode(current.id, 1),
          updated = await tx.shipment.update({
            where: { id: current.id },
            data: { trackingCode, version: { increment: 1 } },
            include,
          });
        const shippingCredential = await tx.integrationCredential.findFirst({
          where: { enabled: true, provider: { family: "shipping" } },
          select: { id: true, providerId: true },
        });
        if (shippingCredential)
          await tx.integrationQueueItem.create({
            data: {
              eventType: "shipping.label_requested",
              trigger: "shipment.label_generated",
              context: `shipment:${current.id}`,
              providerId: shippingCredential.providerId,
              credentialId: shippingCredential.id,
              channel: "shipping",
              payload: {
                shipmentId: current.id,
                packageIds: current.packages.map((item) => item.id),
                correlationId,
              },
            },
          });
        await tx.shipmentEvent.create({
          data: {
            shipmentId: current.id,
            type: "labels_generated",
            description: `${current.packages.length} etiqueta(s) gerada(s) e pronta(s) para impressão`,
            actor: access.user.name,
          },
        });
        return updated;
      });
      return logisticsJson({ shipment, correlationId });
    }
    if (body.action === "dispatch")
      return dispatch(
        db,
        shipmentDispatchInput(body),
        access.user,
        correlationId,
      );
    if (body.action === "deliver") {
      const input = shipmentDeliveryInput(body),
        id = input.shipmentId;
      const shipment = await db.$transaction(
        async (tx) => {
          await lockShipment(tx, id);
          const before = await tx.shipment.findUnique({ where: { id } });
          if (!before || before.status !== "dispatched")
            throw new OmnichannelInputError(
              "Somente uma expedição despachada pode ser entregue.",
            );
          const value = await tx.shipment.update({
            where: { id },
            data: {
              status: "delivered",
              deliveredAt: new Date(),
              deliveryRecipient: input.recipient,
              deliveryDocument: maskSensitiveDocument(input.document),
              deliveryNotes: input.notes,
              proofUrl: input.proofUrl,
              version: { increment: 1 },
            },
            include,
          });
          await tx.shipmentEvent.create({
            data: {
              shipmentId: id,
              type: "delivered",
              description: `Entrega confirmada para ${input.recipient}`,
              actor: access.user.name,
            },
          });
          await tx.shipmentPackage.updateMany({
            where: { shipmentId: id, status: { not: "cancelled" } },
            data: { status: "delivered", deliveredAt: new Date() },
          });
          await finalizeOrderDeliveryIfComplete(
            tx,
            before.salesOrderId,
            new Date(),
            access.user.name,
            before.number,
          );
          await tx.tenantAuditEvent.create({
            data: {
              actorId: access.user.id,
              action: "shipment.delivered",
              entityType: "shipment",
              entityId: String(id),
              correlationId,
              afterData: {
                recipient: input.recipient,
                proofUrl: input.proofUrl,
              },
            },
          });
          return value;
        },
        { isolationLevel: "Serializable", maxWait: 10_000, timeout: 30_000 },
      );
      return logisticsJson({ shipment, correlationId });
    }
    if (body.action === "priority") {
      const id = entityId(body.shipmentId),
        priority = String(body.priority || "");
      if (!["low", "normal", "high", "urgent"].includes(priority))
        throw new OmnichannelInputError("Prioridade inválida.");
      const shipment = await db.$transaction(
        async (tx) => {
          await lockShipment(tx, id);
          const before = await tx.shipment.findUnique({ where: { id } });
          if (!before || ["delivered", "cancelled"].includes(before.status))
            throw new OmnichannelInputError(
              "Expedição não aceita alteração de prioridade.",
            );
          const updated = await tx.shipment.update({
            where: { id },
            data: { priority, version: { increment: 1 } },
            include,
          });
          await tx.shipmentEvent.create({
            data: {
              shipmentId: id,
              type: "priority_changed",
              description: `Prioridade alterada para ${priority}`,
              actor: access.user.name,
            },
          });
          await tx.tenantAuditEvent.create({
            data: {
              actorId: access.user.id,
              action: "shipment.priority_changed",
              entityType: "shipment",
              entityId: String(id),
              correlationId,
              afterData: { priority },
            },
          });
          return updated;
        },
        { isolationLevel: "Serializable", maxWait: 10_000, timeout: 30_000 },
      );
      return logisticsJson({ shipment, correlationId });
    }
    if (body.action === "cancel") {
      const input = shipmentCancellationInput(body),
        id = input.shipmentId;
      if (input.confirmation !== "CANCELAR")
        throw new OmnichannelInputError(
          "Confirmação de cancelamento inválida.",
        );
      const shipment = await db.$transaction(async (tx) => {
        await lockShipment(tx, id);
        const before = await tx.shipment.findUnique({ where: { id } });
        if (!before || !["picking", "packed"].includes(before.status))
          throw new OmnichannelInputError(
            "Somente uma expedição ainda não despachada pode ser cancelada.",
          );
        await releaseShipmentPickAllocations(tx, id);
        const value = await tx.shipment.update({
          where: { id },
          data: {
            status: "cancelled",
            cancelledAt: new Date(),
            cancelledBy: access.user.name,
            cancellationReason: input.reason,
            version: { increment: 1 },
          },
          include,
        });
        await tx.shipmentEvent.create({
          data: {
            shipmentId: id,
            type: "cancelled",
            description: `Expedição cancelada antes do despacho: ${input.reason}`,
            actor: access.user.name,
          },
        });
        await tx.shipmentPackage.updateMany({
          where: { shipmentId: id },
          data: { status: "cancelled" },
        });
        await tx.tenantAuditEvent.create({
          data: {
            actorId: access.user.id,
            action: "shipment.cancelled",
            entityType: "shipment",
            entityId: String(id),
            correlationId,
            beforeData: { status: before.status },
            afterData: { status: "cancelled", reason: input.reason },
          },
        });
        return value;
      });
      return logisticsJson({ shipment, correlationId });
    }
    if (body.action === "reopen") {
      const id = entityId(body.shipmentId);
      const shipment = await db.$transaction(
        async (tx) => {
          await lockShipment(tx, id);
          const before = await tx.shipment.findUnique({ where: { id } });
          if (!before || before.status !== "cancelled")
            throw new OmnichannelInputError(
              "Expedição cancelada não encontrada.",
            );
          await tx.shipmentItem.updateMany({
            where: { shipmentId: id },
            data: { pickedQuantity: 0, shortQuantity: 0 },
          });
          await tx.shipmentPackage.deleteMany({ where: { shipmentId: id } });
          const value = await tx.shipment.update({
            where: { id },
            data: {
              status: "picking",
              cancelledAt: null,
              cancelledBy: null,
              cancellationReason: null,
              pickingStartedAt: null,
              packedAt: null,
              packedBy: null,
              manifestNumber: null,
              manifestedAt: null,
              handoffAt: null,
              holdReason: null,
              version: { increment: 1 },
            },
            include,
          });
          await tx.shipmentEvent.create({
            data: {
              shipmentId: id,
              type: "reopened",
              description: "Expedição reaberta para nova separação",
              actor: access.user.name,
            },
          });
          await tx.tenantAuditEvent.create({
            data: {
              actorId: access.user.id,
              action: "shipment.reopened",
              entityType: "shipment",
              entityId: String(id),
              correlationId,
            },
          });
          return value;
        },
        { isolationLevel: "Serializable", maxWait: 10_000, timeout: 30_000 },
      );
      return logisticsJson({ shipment, correlationId });
    }
    if (body.action === "tracking.update") {
      const input = shipmentTrackingInput(body);
      const shipment = await db.$transaction(
        async (tx) => {
          await lockShipment(tx, input.shipmentId);
          const current = await tx.shipment.findUnique({
            where: { id: input.shipmentId },
            include,
          });
          if (!current || current.status !== "dispatched")
            throw new OmnichannelInputError(
              "Somente uma expedição em transporte aceita checkpoints.",
            );
          const volume = input.packageId
            ? current.packages.find((item) => item.id === input.packageId)
            : null;
          if (input.packageId && !volume)
            throw new OmnichannelInputError(
              "O volume informado não pertence à expedição.",
            );
          const currentTrackingCode =
            volume?.trackingCode || current.trackingCode;
          if (!currentTrackingCode)
            throw new OmnichannelInputError(
              "A expedição não possui código de rastreio.",
            );
          const label = trackingStatusLabel(input.status),
            tracking = await tx.orderTracking.upsert({
              where: { salesOrderId: current.salesOrderId },
              update: { status: input.status, statusLabel: label },
              create: {
                salesOrderId: current.salesOrderId,
                trackingNumber: currentTrackingCode,
                carrier: current.carrier,
                status: input.status,
                statusLabel: label,
              },
            });
          await tx.orderTrackingEvent.create({
            data: {
              trackingId: tracking.id,
              status: input.status,
              description: input.description,
              location: input.location,
              occurredAt: input.occurredAt,
            },
          });
          await tx.shipmentEvent.create({
            data: {
              shipmentId: current.id,
              type: "tracking_checkpoint",
              description: `${label}: ${input.description}${input.location ? ` · ${input.location}` : ""}`,
              actor: access.user.name,
            },
          });
          if (
            ["delivery_failed", "returned_to_sender"].includes(input.status)
          ) {
            const existingCarrierIncident = await tx.shipmentIncident.findFirst(
              {
                where: {
                  shipmentId: current.id,
                  category: "carrier",
                  status: "open",
                },
              },
            );
            if (!existingCarrierIncident)
              await tx.shipmentIncident.create({
                data: {
                  shipmentId: current.id,
                  category: "carrier",
                  severity:
                    input.status === "returned_to_sender" ? "high" : "medium",
                  status: "open",
                  owner: access.user.name,
                  description: input.description,
                  dueAt: new Date(Date.now() + 24 * 3_600_000),
                  createdBy: access.user.name,
                },
              });
            await tx.shipment.update({
              where: { id: current.id },
              data: {
                exceptionStatus: "open",
                exceptionCategory: "carrier",
                exceptionOwner: access.user.name,
                exceptionDueAt: new Date(Date.now() + 24 * 3_600_000),
                exceptionResolvedAt: null,
                exceptionResolution: null,
                version: { increment: 1 },
              },
            });
          }
          if (volume)
            await tx.shipmentPackage.update({
              where: { id: volume.id },
              data: {
                status: packageStatus(input.status),
                deliveredAt:
                  input.status === "delivered" ? input.occurredAt : null,
              },
            });
          else
            await tx.shipmentPackage.updateMany({
              where: { shipmentId: current.id },
              data: {
                status: packageStatus(input.status),
                deliveredAt:
                  input.status === "delivered" ? input.occurredAt : null,
              },
            });
          if (input.status === "delivered") {
            const remainingPackages = await tx.shipmentPackage.count({
              where: {
                shipmentId: current.id,
                status: { notIn: ["delivered", "cancelled"] },
              },
            });
            if (!remainingPackages) {
              await tx.shipment.update({
                where: { id: current.id },
                data: {
                  status: "delivered",
                  deliveredAt: input.occurredAt,
                  version: { increment: 1 },
                },
              });
              await finalizeOrderDeliveryIfComplete(
                tx,
                current.salesOrderId,
                input.occurredAt,
                access.user.name,
                current.number,
              );
            }
          }
          await tx.tenantAuditEvent.create({
            data: {
              actorId: access.user.id,
              action: "shipment.tracking_updated",
              entityType: "shipment",
              entityId: String(current.id),
              correlationId,
              afterData: input,
            },
          });
          return tx.shipment.findUniqueOrThrow({
            where: { id: current.id },
            include,
          });
        },
        { isolationLevel: "Serializable", maxWait: 10_000, timeout: 30_000 },
      );
      return logisticsJson({ shipment, correlationId });
    }
    if (body.action === "return.create") {
      const input = reverseLogisticsInput(body);
      const orderReturn = await db.$transaction(
        async (tx) => {
          await lockShipment(tx, input.shipmentId);
          const shipment = await tx.shipment.findUnique({
            where: { id: input.shipmentId },
            include,
          });
          if (
            !shipment ||
            !["dispatched", "delivered"].includes(shipment.status)
          )
            throw new OmnichannelInputError(
              "A logística reversa exige uma expedição despachada ou entregue.",
            );
          const activeReturn = await tx.orderReturn.findFirst({
            where: {
              salesOrderId: shipment.salesOrderId,
              status: {
                in: ["pending", "authorized", "in_transit", "received"],
              },
            },
          });
          if (activeReturn)
            throw new OmnichannelInputError(
              "Este pedido já possui uma logística reversa em andamento.",
            );
          const returnItems = input.items.length
            ? input.items
            : shipment.items.map((item) => ({
                orderItemId: item.salesOrderItemId,
                quantity: item.quantity,
              }));
          if (
            returnItems.some((row) => {
              const shipped = shipment.items.find(
                (item) => item.salesOrderItemId === row.orderItemId,
              );
              return !shipped || row.quantity > shipped.quantity;
            })
          )
            throw new OmnichannelInputError(
              "A devolução contém item ou quantidade superior ao que foi enviado.",
            );
          const created = await tx.orderReturn.create({
            data: {
              salesOrderId: shipment.salesOrderId,
              customerId: shipment.salesOrder.customerId,
              reason: input.reason,
              description: input.description,
              status:
                input.reverseCode || input.trackingCode
                  ? "authorized"
                  : "pending",
              customerEmail: input.customerEmail,
              reverseProvider: input.provider,
              reverseCode: input.reverseCode,
              reverseTrackingCode: input.trackingCode,
              reverseLabelUrl: input.labelUrl,
              reverseRequestedAt: new Date(),
              items: {
                create: returnItems,
              },
            },
            include: { items: true },
          });
          await tx.shipmentEvent.create({
            data: {
              shipmentId: shipment.id,
              type: "return_requested",
              description: `Logística reversa ${created.status === "authorized" ? "autorizada" : "solicitada"}${input.provider ? ` · ${input.provider}` : ""}`,
              actor: access.user.name,
            },
          });
          await tx.tenantAuditEvent.create({
            data: {
              actorId: access.user.id,
              action: "shipment.return_created",
              entityType: "shipment",
              entityId: String(shipment.id),
              correlationId,
              afterData: {
                returnId: created.id,
                reason: input.reason,
                status: created.status,
              },
            },
          });
          return created;
        },
        { isolationLevel: "Serializable", maxWait: 10_000, timeout: 30_000 },
      );
      return logisticsJson({ orderReturn, correlationId }, { status: 201 });
    }
    if (body.action === "return.update") {
      const input = reverseLogisticsStateInput(body);
      const orderReturn = await db.$transaction(
        async (tx) => {
          await tx.$queryRaw(
            Prisma.sql`SELECT "id" FROM "order_returns" WHERE "id" = ${input.returnId} FOR UPDATE`,
          );
          const current = await tx.orderReturn.findUnique({
            where: { id: input.returnId },
            include: {
              salesOrder: {
                include: {
                  shipments: { orderBy: { createdAt: "desc" }, take: 1 },
                },
              },
            },
          });
          if (!current)
            throw new OmnichannelInputError(
              "Logística reversa não encontrada.",
            );
          const transitions: Record<string, string[]> = {
            pending: ["authorized", "rejected", "cancelled"],
            authorized: ["in_transit", "received", "cancelled"],
            in_transit: ["received", "cancelled"],
            received: [],
          };
          if (input.status === "completed")
            throw new OmnichannelInputError(
              "Conclua a devolução pela inspeção dos itens e definição de destino.",
            );
          if (!(transitions[current.status] || []).includes(input.status))
            throw new OmnichannelInputError(
              "A transição da logística reversa é inválida.",
            );
          const provider = input.provider || current.reverseProvider,
            reverseCode = input.reverseCode || current.reverseCode,
            trackingCode = input.trackingCode || current.reverseTrackingCode,
            labelUrl = input.labelUrl || current.reverseLabelUrl;
          if (
            input.status === "authorized" &&
            (!provider || (!reverseCode && !trackingCode))
          )
            throw new OmnichannelInputError(
              "Informe operador e código de autorização ou rastreio.",
            );
          const now = new Date(),
            updated = await tx.orderReturn.update({
              where: { id: current.id },
              data: {
                status: input.status,
                reverseProvider: provider,
                reverseCode,
                reverseTrackingCode: trackingCode,
                reverseLabelUrl: labelUrl,
                adminNotes: input.notes || current.adminNotes,
                decidedAt:
                  ["authorized", "rejected"].includes(input.status) &&
                  !current.decidedAt
                    ? now
                    : current.decidedAt,
                receivedAt: ["received", "completed"].includes(input.status)
                  ? current.receivedAt || now
                  : current.receivedAt,
                completedAt:
                  input.status === "completed" ? now : current.completedAt,
              },
              include: { items: true },
            });
          if (current.salesOrder.shipments[0])
            await tx.shipmentEvent.create({
              data: {
                shipmentId: current.salesOrder.shipments[0].id,
                type: "return_updated",
                description: `Logística reversa atualizada para ${input.status}${input.notes ? `: ${input.notes}` : ""}`,
                actor: access.user.name,
              },
            });
          await tx.tenantAuditEvent.create({
            data: {
              actorId: access.user.id,
              action: "shipment.return_updated",
              entityType: "order_return",
              entityId: String(current.id),
              correlationId,
              beforeData: { status: current.status },
              afterData: { status: input.status, provider, trackingCode },
            },
          });
          return updated;
        },
        { isolationLevel: "Serializable", maxWait: 10_000, timeout: 30_000 },
      );
      return logisticsJson({ orderReturn, correlationId });
    }
    if (body.action === "return.inspect") {
      const input = returnInspectionInput(body);
      const orderReturn = await db.$transaction(
        async (tx) => {
          await tx.$queryRaw(
            Prisma.sql`SELECT "id" FROM "order_returns" WHERE "id" = ${input.returnId} FOR UPDATE`,
          );
          const [current, warehouse] = await Promise.all([
            tx.orderReturn.findUnique({
              where: { id: input.returnId },
              include: {
                salesOrder: {
                  include: {
                    shipments: { orderBy: { createdAt: "desc" }, take: 1 },
                  },
                },
                items: {
                  include: {
                    orderItem: { include: { product: true, variation: true } },
                  },
                },
              },
            }),
            tx.warehouse.findFirst({
              where: {
                id: input.warehouseId,
                active: true,
                branchId: { in: branchIds },
              },
            }),
          ]);
          if (!current || !warehouse)
            throw new OmnichannelInputError(
              "Devolução ou depósito de recebimento não encontrado.",
            );
          if (!new Set(["in_transit", "received"]).has(current.status))
            throw new OmnichannelInputError(
              "A inspeção exige uma devolução recebida ou em trânsito.",
            );
          if (
            input.items.length !== current.items.length ||
            input.items.some((row) => {
              const item = current.items.find(
                (value) => value.id === row.returnItemId,
              );
              return (
                !item ||
                item.inspectedAt ||
                row.receivedQuantity > item.quantity
              );
            })
          )
            throw new OmnichannelInputError(
              "Revise os itens: a inspeção deve conter todos os itens ainda não processados.",
            );
          for (const row of input.items) {
            const item = current.items.find(
                (value) => value.id === row.returnItemId,
              )!,
              orderItem = item.orderItem,
              micros = BigInt(Math.round(row.receivedQuantity * 1_000_000));
            if (row.disposition === "restock" && row.receivedQuantity > 0) {
              const parent = await tx.warehouseBalance.upsert({
                where: {
                  warehouseId_productId: {
                    warehouseId: warehouse.id,
                    productId: orderItem.productId,
                  },
                },
                update: { quantity: { increment: row.receivedQuantity } },
                create: {
                  warehouseId: warehouse.id,
                  productId: orderItem.productId,
                  quantity: row.receivedQuantity,
                },
              });
              if (orderItem.variationId)
                await tx.warehouseVariationBalance.upsert({
                  where: {
                    warehouseId_variationId: {
                      warehouseId: warehouse.id,
                      variationId: orderItem.variationId,
                    },
                  },
                  update: { quantity: { increment: row.receivedQuantity } },
                  create: {
                    warehouseId: warehouse.id,
                    productId: orderItem.productId,
                    variationId: orderItem.variationId,
                    quantity: row.receivedQuantity,
                  },
                });
              await tx.product.update({
                where: { id: orderItem.productId },
                data: { stock: { increment: row.receivedQuantity } },
              });
              if (orderItem.variationId && orderItem.variation?.stock != null)
                await tx.productVariation.update({
                  where: { id: orderItem.variationId },
                  data: { stock: { increment: row.receivedQuantity } },
                });
              await tx.stockMovement.create({
                data: {
                  productId: orderItem.productId,
                  variationId: orderItem.variationId,
                  warehouseId: warehouse.id,
                  type: "return",
                  quantity: row.receivedQuantity,
                  previousStock: parent.quantity - row.receivedQuantity,
                  currentStock: parent.quantity,
                  note: `Devolução ${current.id} inspecionada`,
                  userName: access.user.name,
                },
              });
              await tx.warehouseLedgerEntry.create({
                data: {
                  warehouseId: warehouse.id,
                  productId: orderItem.productId,
                  variationId: orderItem.variationId,
                  type: "return",
                  quantity: row.receivedQuantity,
                  balanceBefore: parent.quantity - row.receivedQuantity,
                  balanceAfter: parent.quantity,
                  referenceType: "order_return",
                  referenceId: String(current.id),
                  actor: access.user.name,
                },
              });
            }
            let lotId = row.lotId;
            if (
              micros > BigInt(0) &&
              ["restock", "quarantine"].includes(row.disposition)
            ) {
              let lot = lotId
                ? await tx.posInventoryLot.findFirst({
                    where: {
                      id: lotId,
                      warehouseId: warehouse.id,
                      productId: orderItem.productId,
                      variationId: orderItem.variationId,
                    },
                  })
                : null;
              if (lotId && !lot)
                throw new OmnichannelInputError(
                  `O lote informado não pertence ao item ${orderItem.product.name}.`,
                );
              const bucketKey =
                row.disposition === "restock" ? "sellable" : "quarantine";
              if (lot && lot.bucketKey !== bucketKey)
                throw new OmnichannelInputError(
                  "O lote informado pertence a uma situação de estoque diferente da destinação escolhida.",
                );
              if (!lot) {
                const code = `RET-${current.id}-${item.id}`;
                lot = await tx.posInventoryLot.create({
                  data: {
                    warehouseId: warehouse.id,
                    productId: orderItem.productId,
                    variationId: orderItem.variationId,
                    lotCode: code,
                    normalizedLotCode: code,
                    bucketKey,
                    status:
                      bucketKey === "sellable" ? "available" : "quarantine",
                    quantityMicros: BigInt(0),
                  },
                });
                lotId = lot.id;
              }
              const beforeMicros = lot.quantityMicros;
              await tx.posInventoryLot.update({
                where: { id: lot.id },
                data: {
                  quantityMicros: { increment: micros },
                  bucketKey,
                  status: bucketKey === "sellable" ? "available" : "quarantine",
                },
              });
              await tx.posInventoryLotMovement.create({
                data: {
                  lotId: lot.id,
                  type: "logistics_return",
                  quantityMicros: micros,
                  balanceBeforeMicros: beforeMicros,
                  balanceAfterMicros: beforeMicros + micros,
                  referenceType: "order_return",
                  referenceId: String(current.id),
                  idempotencyKey: `logistics-return:${current.id}:${item.id}`,
                  actor: access.user.name,
                },
              });
            }
            await tx.orderReturnItem.update({
              where: { id: item.id },
              data: {
                receivedQuantity: row.receivedQuantity,
                condition: row.condition,
                disposition: row.disposition,
                inspectionNotes: row.notes,
                warehouseId: warehouse.id,
                lotId,
                inspectedBy: access.user.name,
                inspectedAt: new Date(),
              },
            });
          }
          const updated = await tx.orderReturn.update({
            where: { id: current.id },
            data: {
              status: "completed",
              receivedAt: current.receivedAt || new Date(),
              completedAt: new Date(),
              adminNotes: input.notes || current.adminNotes,
            },
            include: { items: true },
          });
          const shipment = current.salesOrder.shipments[0];
          if (shipment)
            await tx.shipmentEvent.create({
              data: {
                shipmentId: shipment.id,
                type: "return_inspected",
                description: `Devolução ${current.id} inspecionada e destinada`,
                actor: access.user.name,
              },
            });
          await tx.tenantAuditEvent.create({
            data: {
              actorId: access.user.id,
              action: "shipment.return_inspected",
              entityType: "order_return",
              entityId: String(current.id),
              correlationId,
              afterData: { warehouseId: warehouse.id, items: input.items },
            },
          });
          return updated;
        },
        { isolationLevel: "Serializable", maxWait: 10_000, timeout: 30_000 },
      );
      return logisticsJson({ orderReturn, correlationId });
    }
    if (body.action === "incident.resolve") {
      const input = incidentResolutionInput(body);
      const shipment = await db.$transaction(
        async (tx) => {
          await lockShipment(tx, input.shipmentId);
          const current = await tx.shipment.findUnique({
            where: { id: input.shipmentId },
          });
          const openIncident = current
            ? await tx.shipmentIncident.findFirst({
                where: { shipmentId: current.id, status: "open" },
                orderBy: [{ dueAt: "asc" }, { createdAt: "asc" }],
              })
            : null;
          if (!current || !openIncident)
            throw new OmnichannelInputError(
              "Nenhuma ocorrência aberta foi encontrada.",
            );
          const resolvedAt = new Date();
          await tx.shipmentIncident.update({
            where: { id: openIncident.id },
            data: {
              status: "resolved",
              resolution: input.resolution,
              rootCause: input.rootCause || openIncident.rootCause,
              resolvedBy: access.user.name,
              resolvedAt,
            },
          });
          const nextIncident = await tx.shipmentIncident.findFirst({
              where: { shipmentId: current.id, status: "open" },
              orderBy: [{ dueAt: "asc" }, { createdAt: "asc" }],
            }),
            updated = await tx.shipment.update({
              where: { id: current.id },
              data: {
                exceptionStatus: nextIncident ? "open" : "resolved",
                exceptionCategory:
                  nextIncident?.category || current.exceptionCategory,
                exceptionOwner: nextIncident?.owner || current.exceptionOwner,
                exceptionDueAt: nextIncident?.dueAt || current.exceptionDueAt,
                exceptionResolvedAt: nextIncident ? null : resolvedAt,
                exceptionResolution: nextIncident ? null : input.resolution,
                holdReason:
                  nextIncident?.severity === "critical"
                    ? current.holdReason
                    : null,
                version: { increment: 1 },
              },
              include,
            });
          await tx.shipmentEvent.create({
            data: {
              shipmentId: current.id,
              type: "incident_resolved",
              description: input.resolution,
              actor: access.user.name,
            },
          });
          await tx.tenantAuditEvent.create({
            data: {
              actorId: access.user.id,
              action: "shipment.incident_resolved",
              entityType: "shipment",
              entityId: String(current.id),
              correlationId,
              afterData: {
                incidentId: openIncident.id,
                resolution: input.resolution,
                rootCause: input.rootCause,
                resolvedAt,
              },
            },
          });
          return updated;
        },
        { isolationLevel: "Serializable", maxWait: 10_000, timeout: 30_000 },
      );
      return logisticsJson({ shipment, correlationId });
    }
    if (body.action === "incident") {
      const input = incidentInput(body),
        result = await db.$transaction(
          async (tx) => {
            await lockShipment(tx, input.shipmentId);
            const shipment = await tx.shipment.findUnique({
              where: { id: input.shipmentId },
            });
            if (
              !shipment ||
              ["delivered", "cancelled"].includes(shipment.status)
            )
              throw new OmnichannelInputError(
                "Expedição não aceita nova ocorrência.",
              );
            const incident = await tx.shipmentIncident.create({
                data: {
                  shipmentId: shipment.id,
                  category: input.category,
                  severity: input.severity,
                  status: "open",
                  owner: input.owner,
                  description: input.description,
                  dueAt: input.dueAt,
                  rootCause: input.rootCause,
                  claimCents: input.claimCents,
                  createdBy: access.user.name,
                },
              }),
              updated = await tx.shipment.update({
                where: { id: shipment.id },
                data: {
                  exceptionStatus: "open",
                  exceptionCategory: input.category,
                  exceptionOwner: input.owner,
                  exceptionDueAt: input.dueAt,
                  exceptionResolvedAt: null,
                  exceptionResolution: null,
                  holdReason:
                    input.severity === "critical"
                      ? `Ocorrência crítica: ${input.description}`
                      : shipment.holdReason,
                  version: { increment: 1 },
                },
                include,
              }),
              event = await tx.shipmentEvent.create({
                data: {
                  shipmentId: input.shipmentId,
                  type: "incident",
                  description: input.description,
                  actor: access.user.name,
                },
              });
            await tx.tenantAuditEvent.create({
              data: {
                actorId: access.user.id,
                action: "shipment.incident_created",
                entityType: "shipment",
                entityId: String(shipment.id),
                correlationId,
                afterData: {
                  eventId: event.id,
                  incidentId: incident.id,
                  category: input.category,
                  severity: input.severity,
                  owner: input.owner,
                  dueAt: input.dueAt,
                  description: input.description,
                },
              },
            });
            return { event, shipment: updated };
          },
          {
            isolationLevel: "Serializable",
            maxWait: 10_000,
            timeout: 30_000,
          },
        );
      return logisticsJson({ ...result, correlationId }, { status: 201 });
    }
    throw new OmnichannelInputError("Ação logística inválida.");
  } catch (error) {
    return failure(error);
  }
}

type IncludedShipment = Prisma.ShipmentGetPayload<{ include: typeof include }>;

async function finalizeOrderDeliveryIfComplete(
  tx: Prisma.TransactionClient,
  salesOrderId: number,
  deliveredAt: Date,
  actor: string,
  shipmentNumber: string,
) {
  await tx.$queryRaw(
    Prisma.sql`SELECT "id" FROM "sales_orders" WHERE "id" = ${salesOrderId} FOR UPDATE`,
  );
  const [remaining, order] = await Promise.all([
    tx.shipment.count({
      where: {
        salesOrderId,
        status: { notIn: ["delivered", "cancelled"] },
      },
    }),
    tx.salesOrder.findUnique({
      where: { id: salesOrderId },
      select: { status: true },
    }),
  ]);
  if (remaining || order?.status === "delivered") return false;
  await tx.salesOrder.update({
    where: { id: salesOrderId },
    data: {
      status: "delivered",
      completedAt: deliveredAt,
      history: {
        create: {
          fromStatus: order?.status,
          toStatus: "delivered",
          actor,
          notes: `Todos os envios entregues; confirmação em ${shipmentNumber}`,
        },
      },
    },
  });
  await tx.marketplaceOrder.updateMany({
    where: { salesOrderId },
    data: { status: "delivered" },
  });
  await enqueueStatusNotifications(tx, salesOrderId, "delivered");
  return true;
}

async function lockShipment(tx: Prisma.TransactionClient, shipmentId: number) {
  await tx.$queryRaw(
    Prisma.sql`SELECT "id" FROM "shipments" WHERE "id" = ${shipmentId} FOR UPDATE`,
  );
}

async function assertPickingStock(
  tx: Prisma.TransactionClient,
  shipment: IncludedShipment,
) {
  await assertPickingWaveStock(tx, [shipment]);
}

async function assertPickingWaveStock(
  tx: Prisma.TransactionClient,
  shipments: IncludedShipment[],
) {
  const demand = new Map<
    string,
    {
      warehouseId: number;
      productId: number;
      variationId: number | null;
      quantity: number;
      productName: string;
      shipmentNumbers: Set<string>;
    }
  >();
  for (const shipment of shipments)
    for (const item of shipment.items) {
      if (item.salesOrderItem.product.type !== "product") continue;
      const key = `${shipment.warehouseId}:${item.salesOrderItem.productId}:${item.salesOrderItem.variationId || 0}`,
        current = demand.get(key) || {
          warehouseId: shipment.warehouseId,
          productId: item.salesOrderItem.productId,
          variationId: item.salesOrderItem.variationId,
          quantity: 0,
          productName: item.salesOrderItem.product.name,
          shipmentNumbers: new Set<string>(),
        };
      current.quantity += item.quantity;
      current.shipmentNumbers.add(shipment.number);
      demand.set(key, current);
    }
  if (!demand.size) return;
  const rows = [...demand.values()],
    balances = await tx.warehouseBalance.findMany({
      where: {
        OR: rows.map((row) => ({
          warehouseId: row.warehouseId,
          productId: row.productId,
        })),
      },
    }),
    variationBalances = await tx.warehouseVariationBalance.findMany({
      where: {
        OR: rows.flatMap((row) =>
          row.variationId
            ? [{ warehouseId: row.warehouseId, variationId: row.variationId }]
            : [],
        ),
      },
    }),
    reservations = await tx.stockReservation.findMany({
      where: {
        salesOrderId: {
          in: shipments.map((shipment) => shipment.salesOrderId),
        },
        status: "active",
      },
    });
  for (const row of rows) {
    const balance = row.variationId
        ? variationBalances.find(
            (candidate) =>
              candidate.warehouseId === row.warehouseId &&
              candidate.variationId === row.variationId,
          )
        : balances.find(
            (candidate) =>
              candidate.warehouseId === row.warehouseId &&
              candidate.productId === row.productId,
          ),
      ownReserved = reservations
        .filter(
          (reservation) =>
            reservation.warehouseId === row.warehouseId &&
            reservation.productId === row.productId &&
            reservation.variationId === row.variationId,
        )
        .reduce((sum, reservation) => sum + reservation.quantity, 0),
      available = balance
        ? balance.quantity - balance.reservedQuantity + ownReserved
        : 0;
    if (available + 0.0001 < row.quantity)
      throw new OmnichannelInputError(
        `Saldo disponível insuficiente para separar ${row.productName} em ${[...row.shipmentNumbers].join(", ")}. Disponível: ${available}; necessário: ${row.quantity}.`,
      );
  }
}

function trackingStatusLabel(status: string) {
  return (
    {
      in_transit: "Em trânsito",
      out_for_delivery: "Saiu para entrega",
      delivery_failed: "Tentativa de entrega sem sucesso",
      awaiting_pickup: "Aguardando retirada",
      returned_to_sender: "Em devolução ao remetente",
      delivered: "Entregue",
    } as Record<string, string>
  )[status];
}

async function dispatch(
  db: Awaited<ReturnType<typeof tenantDb>>,
  input: ReturnType<typeof shipmentDispatchInput>,
  user: { id: string; name: string },
  correlationId: string,
) {
  const shipment = await db.$transaction(
    async (tx) => {
      const locator = await tx.shipment.findUnique({
        where: { id: input.shipmentId },
        select: { salesOrderId: true },
      });
      if (!locator)
        throw new OmnichannelInputError("Expedição não encontrada.");
      await tx.$queryRaw(
        Prisma.sql`SELECT "id" FROM "sales_orders" WHERE "id" = ${locator.salesOrderId} FOR UPDATE`,
      );
      await lockShipment(tx, input.shipmentId);
      const before = await tx.shipment.findUnique({
        where: { id: input.shipmentId },
        include,
      });
      if (!before || before.status !== "packed")
        throw new OmnichannelInputError(
          "Embale a expedição antes do despacho.",
        );
      const fiscalAuthorized =
        !before.fiscalRequired ||
        before.fiscalStatus === "authorized" ||
        ["authorized", "approved", "issued"].includes(
          String(before.channelOrder?.invoiceStatus || ""),
        ) ||
        before.salesOrder.documents.some((document) =>
          ["nfe", "danfe", "invoice"].includes(document.type.toLowerCase()),
        );
      if (!fiscalAuthorized)
        throw new OmnichannelInputError(
          "Autorize a NF-e e vincule o DANFE antes do despacho.",
        );
      if (
        before.incidents.some(
          (incident) =>
            incident.status === "open" && incident.severity === "critical",
        )
      )
        throw new OmnichannelInputError(
          "Resolva a ocorrência crítica antes do despacho.",
        );
      if (
        before.packages.length !== before.packageCount ||
        before.packages.some((item) => item.status === "draft")
      )
        throw new OmnichannelInputError(
          "Confira e feche todos os volumes antes do despacho.",
        );
      const orderHasActiveLabel = before.salesOrder.shippingLabels.some(
        (label) => !["cancelled", "quoted"].includes(label.status),
      );
      if (
        before.channelOrder &&
        !orderHasActiveLabel &&
        before.packages.some((item) => !item.labelUrl)
      )
        throw new OmnichannelInputError(
          "Gere as etiquetas de todos os volumes antes do despacho do marketplace.",
        );
      const products = before.items.filter(
          (item) => item.salesOrderItem.product.type === "product",
        ),
        reservations = await tx.stockReservation.findMany({
          where: { salesOrderId: before.salesOrderId, status: "active" },
        }),
        balances = await tx.warehouseBalance.findMany({
          where: {
            warehouseId: before.warehouseId,
            productId: {
              in: products.map((item) => item.salesOrderItem.productId),
            },
          },
        }),
        variationBalances = await tx.warehouseVariationBalance.findMany({
          where: {
            warehouseId: before.warehouseId,
            variationId: {
              in: products.flatMap((item) =>
                item.salesOrderItem.variationId
                  ? [item.salesOrderItem.variationId]
                  : [],
              ),
            },
          },
        }),
        balanceMap = new Map(balances.map((item) => [item.productId, item])),
        variationBalanceMap = new Map(
          variationBalances.map((item) => [item.variationId, item]),
        );
      for (const item of products) {
        const product = item.salesOrderItem.product,
          parentBalance = balanceMap.get(product.id),
          variationId = item.salesOrderItem.variationId,
          balance = variationId
            ? variationBalanceMap.get(variationId)
            : parentBalance,
          itemReservations = reservations.filter(
            (reservation) => reservation.orderItemId === item.salesOrderItemId,
          ),
          localReservations = itemReservations.filter(
            (reservation) => reservation.warehouseId === before.warehouseId,
          ),
          reservedHere = localReservations.reduce(
            (sum, reservation) => sum + reservation.quantity,
            0,
          ),
          reservedToConsume = Math.min(item.quantity, reservedHere);
        if (itemReservations.length && reservedHere + 0.0001 < item.quantity)
          throw new OmnichannelInputError(
            `A reserva de ${product.name} está distribuída em outro depósito. Selecione o atendimento direto do pedido ou reorganize as reservas.`,
          );
        if (
          !balance ||
          !parentBalance ||
          balance.quantity - balance.reservedQuantity + reservedToConsume <
            item.quantity
        )
          throw new OmnichannelInputError(
            `Saldo disponível insuficiente no despacho de ${product.name}.`,
          );
        await tx.warehouseBalance.update({
          where: { id: parentBalance.id },
          data: {
            quantity: { decrement: item.quantity },
            ...(reservedToConsume
              ? { reservedQuantity: { decrement: reservedToConsume } }
              : {}),
          },
        });
        if (variationId)
          await tx.warehouseVariationBalance.update({
            where: { id: balance.id },
            data: {
              quantity: { decrement: item.quantity },
              ...(reservedToConsume
                ? { reservedQuantity: { decrement: reservedToConsume } }
                : {}),
            },
          });
        let reservationRemaining = reservedToConsume;
        for (const reservation of localReservations) {
          if (reservationRemaining <= 0.0001) break;
          const consumed = Math.min(reservationRemaining, reservation.quantity),
            remainder = reservation.quantity - consumed;
          await tx.stockReservation.update({
            where: { id: reservation.id },
            data:
              remainder <= 0.0001
                ? { status: "consumed", consumedAt: new Date() }
                : { quantity: remainder },
          });
          reservationRemaining -= consumed;
        }
        await tx.product.update({
          where: { id: product.id },
          data: { stock: { decrement: item.quantity } },
        });
        if (variationId && item.salesOrderItem.variation?.stock != null)
          await tx.productVariation.update({
            where: { id: variationId },
            data: { stock: { decrement: item.quantity } },
          });
        await consumePickAllocations(tx, item, before.id, user.name);
        await tx.stockMovement.create({
          data: {
            productId: product.id,
            warehouseId: before.warehouseId,
            type: "exit",
            quantity: item.quantity,
            variationId,
            previousStock: balance.quantity,
            currentStock: balance.quantity - item.quantity,
            note: `Expedição ${before.number}`,
            userName: user.name,
          },
        });
        await tx.warehouseLedgerEntry.create({
          data: {
            warehouseId: before.warehouseId,
            productId: product.id,
            variationId,
            type: "shipment",
            quantity: -item.quantity,
            balanceBefore: balance.quantity,
            balanceAfter: balance.quantity - item.quantity,
            referenceType: "shipment",
            referenceId: String(before.id),
            actor: user.name,
          },
        });
      }
      const fulfillmentShipments = await tx.shipment.findMany({
          where: {
            salesOrderId: before.salesOrderId,
            status: { not: "cancelled" },
          },
          include: { items: true },
        }),
        orderFullyShipped = before.salesOrder.items.every((orderItem) => {
          const shipped = fulfillmentShipments.reduce(
            (sum, sibling) =>
              sum +
              (["dispatched", "delivered"].includes(sibling.status) ||
              sibling.id === before.id
                ? sibling.items.find(
                    (item) => item.salesOrderItemId === orderItem.id,
                  )?.quantity || 0
                : 0),
            0,
          );
          return shipped + 0.0001 >= orderItem.quantity;
        }),
        nextOrderStatus = orderFullyShipped ? "shipped" : "partially_shipped";
      let sale: { id: number } | null = null;
      if (orderFullyShipped) {
        sale = await tx.sale.create({
          data: {
            saleNumber: `#${Date.now().toString(36).toUpperCase()}-${randomUUID().slice(0, 5).toUpperCase()}`,
            branchId: before.warehouse.branchId,
            warehouseId: before.warehouse.id,
            customer: before.salesOrder.customerName,
            seller: user.name,
            cashRegister: before.warehouse.name,
            paymentMethod: "Canal/transportadora",
            total: before.salesOrder.total,
            subtotalCents: Math.round(before.salesOrder.total * 100),
            discountCents: 0,
            surchargeCents: 0,
            totalCents: Math.round(before.salesOrder.total * 100),
            changeCents: 0,
            sourceType: "sales_order",
            sourceId: String(before.salesOrder.id),
            items: {
              create: before.salesOrder.items.map((item) => ({
                productId: item.productId,
                productName: item.product.name,
                variationId: item.variationId,
                skuSnapshot: item.variation?.sku || item.product.sku,
                gtinSnapshot: item.variation?.gtin || item.product.gtin,
                unit: item.product.unit,
                quantity: item.quantity,
                unitPrice: item.unitPrice,
                total: item.total,
                unitPriceCents: Math.round(item.unitPrice * 100),
                grossCents: Math.round(item.total * 100),
                discountCents: 0,
                surchargeCents: 0,
                totalCents: Math.round(item.total * 100),
              })),
            },
          },
        });
        const marketplaceReceivable = before.channelOrder
          ? Math.max(
              0,
              before.channelOrder.total +
                before.channelOrder.buyerShippingCost -
                (before.channelOrder.commission || before.channelOrder.fee) -
                before.channelOrder.sellerShippingCost,
            )
          : before.salesOrder.total;
        await tx.financialTitle.create({
          data: {
            type: "receivable",
            description: before.channelOrder
              ? `Liquidação ${before.channelOrder.channel.name} · ${before.channelOrder.externalId}`
              : `Pedido ${before.salesOrder.number}`,
            customerId: before.salesOrder.customerId,
            documentNumber: before.salesOrder.number,
            sourceType: "sales_order",
            sourceId: String(before.salesOrder.id),
            amount: Math.round(marketplaceReceivable * 100) / 100,
            dueAt: before.salesOrder.expectedAt || new Date(),
          },
        });
      }
      await tx.salesOrder.update({
        where: { id: before.salesOrderId },
        data: {
          status: nextOrderStatus,
          history: {
            create: {
              fromStatus: before.salesOrder.status,
              toStatus: nextOrderStatus,
              actor: user.name,
              notes: orderFullyShipped
                ? `Pedido integralmente despachado em ${before.number}`
                : `Despacho parcial registrado em ${before.number}`,
            },
          },
        },
      });
      const tracking = await tx.orderTracking.upsert({
        where: { salesOrderId: before.salesOrderId },
        update: {
          trackingNumber: input.trackingCode,
          carrier: input.carrier,
          status: nextOrderStatus,
          statusLabel: orderFullyShipped
            ? "Despachado"
            : "Parcialmente despachado",
        },
        create: {
          salesOrderId: before.salesOrderId,
          trackingNumber: input.trackingCode,
          carrier: input.carrier,
          status: nextOrderStatus,
          statusLabel: orderFullyShipped
            ? "Despachado"
            : "Parcialmente despachado",
        },
      });
      await tx.orderTrackingEvent.create({
        data: {
          trackingId: tracking.id,
          status: nextOrderStatus,
          description: `Despachado por ${input.carrier}`,
          occurredAt: new Date(),
        },
      });
      if (orderFullyShipped)
        await enqueueStatusNotifications(tx, before.salesOrderId, "shipped");
      if (before.channelOrderId)
        await tx.marketplaceOrder.update({
          where: { id: before.channelOrderId },
          data: { status: nextOrderStatus },
        });
      const updated = await tx.shipment.update({
        where: { id: before.id },
        data: {
          status: "dispatched",
          carrier: input.carrier,
          service: input.service,
          trackingCode: input.trackingCode,
          dispatchedAt: new Date(),
          actualFreightCents:
            before.actualFreightCents ||
            before.quotedFreightCents ||
            Math.round(before.freight * 100),
          holdReason: null,
          version: { increment: 1 },
        },
        include,
      });
      await tx.shipmentPackage.updateMany({
        where: { shipmentId: before.id },
        data: {
          status: "dispatched",
          carrier: input.carrier,
          service: input.service,
          dispatchedAt: new Date(),
        },
      });
      await tx.shipmentEvent.create({
        data: {
          shipmentId: before.id,
          type: "dispatched",
          description: `Despachado por ${input.carrier} · rastreio ${input.trackingCode}`,
          actor: user.name,
        },
      });
      await tx.tenantAuditEvent.create({
        data: {
          actorId: user.id,
          action: "shipment.dispatched",
          entityType: "shipment",
          entityId: String(before.id),
          correlationId,
          afterData: {
            carrier: input.carrier,
            trackingCode: input.trackingCode,
            saleId: sale?.id || null,
            salesOrderId: before.salesOrderId,
            orderFullyShipped,
          },
        },
      });
      return updated;
    },
    { isolationLevel: "Serializable", maxWait: 10_000, timeout: 30_000 },
  );
  return logisticsJson({ shipment, correlationId });
}

async function logisticsContext(
  permission: "logistics.read" | "logistics.write",
) {
  const organization = await currentOrganization(),
    access = await assertTenantPermission(organization.id, permission),
    db = await tenantDb(organization.id),
    profile = await db.tenantUserProfile.findUnique({
      where: { userId: access.user.id },
      select: {
        id: true,
        activeBranchId: true,
        branchAccesses: {
          select: {
            branchId: true,
            canManageStock: true,
            branch: { select: { status: true } },
          },
        },
      },
    });
  if (!profile?.activeBranchId)
    throw new OmnichannelHttpError("Selecione uma filial ativa.", 409);
  const activeAccess = profile.branchAccesses.find(
      (item) =>
        item.branchId === profile.activeBranchId &&
        item.branch.status === "active",
    ),
    activeBranch = activeAccess
      ? await db.branch.findFirst({
          where: { id: profile.activeBranchId, status: "active" },
          include: { settings: true },
        })
      : null;
  if (!activeBranch || !activeAccess)
    throw new OmnichannelHttpError(
      "Você não possui acesso à filial ativa.",
      403,
    );
  if (
    permission === "logistics.write" &&
    access.membership.role !== "owner" &&
    !activeAccess.canManageStock
  )
    throw new OmnichannelHttpError(
      "Seu acesso à filial não permite movimentar estoque.",
      403,
    );
  const branchIds = activeBranch.settings?.allowCrossBranchFulfillment
    ? profile.branchAccesses
        .filter(
          (item) =>
            item.branch.status === "active" &&
            (permission === "logistics.read" ||
              access.membership.role === "owner" ||
              item.canManageStock),
        )
        .map((item) => item.branchId)
    : [activeBranch.id];
  return {
    organization,
    access,
    db,
    activeBranch,
    branchIds,
    timezone: activeBranch.timezone,
  };
}

async function assertLogisticsScope(
  db: Awaited<ReturnType<typeof tenantDb>>,
  body: Record<string, unknown>,
  branchIds: number[],
) {
  const shipmentIds = [
    ...(body.shipmentId != null ? [entityId(body.shipmentId)] : []),
    ...(Array.isArray(body.shipmentIds)
      ? body.shipmentIds.map((value) => entityId(value))
      : []),
  ];
  if (shipmentIds.length) {
    const expected = new Set(shipmentIds).size,
      count = await db.shipment.count({
        where: {
          id: { in: [...new Set(shipmentIds)] },
          warehouse: { branchId: { in: branchIds } },
        },
      });
    if (count !== expected)
      throw new OmnichannelHttpError(
        "Expedição não encontrada na filial ativa.",
        404,
      );
  }
  if (body.salesOrderId != null) {
    const order = await db.salesOrder.findFirst({
      where: { id: entityId(body.salesOrderId), branchId: { in: branchIds } },
      select: { id: true },
    });
    if (!order)
      throw new OmnichannelHttpError(
        "Pedido não encontrado na filial ativa.",
        404,
      );
  }
  if (body.warehouseId != null) {
    const warehouse = await db.warehouse.findFirst({
      where: { id: entityId(body.warehouseId), branchId: { in: branchIds } },
      select: { id: true },
    });
    if (!warehouse)
      throw new OmnichannelHttpError(
        "Depósito não encontrado na filial ativa.",
        404,
      );
  }
  if (body.returnId != null) {
    const orderReturn = await db.orderReturn.findFirst({
      where: {
        id: entityId(body.returnId),
        salesOrder: { branchId: { in: branchIds } },
      },
      select: { id: true },
    });
    if (!orderReturn)
      throw new OmnichannelHttpError(
        "Devolução não encontrada na filial ativa.",
        404,
      );
  }
  if (body.manifestId != null) {
    const manifest = await db.shippingManifest.findFirst({
      where: {
        id: String(body.manifestId),
        branchId: { in: branchIds },
      },
      select: { id: true },
    });
    if (!manifest)
      throw new OmnichannelHttpError(
        "Romaneio não encontrado na filial ativa.",
        404,
      );
  }
}

type SummaryShipment = {
  status: string;
  priority: string;
  carrier: string | null;
  service: string | null;
  createdAt: Date;
  packedAt: Date | null;
  dispatchedAt: Date | null;
  deliveredAt: Date | null;
  deadlineAt: Date | null;
  dispatchDeadlineAt: Date | null;
  freight: number;
  quotedFreightCents: number | null;
  actualFreightCents: number | null;
  packageCount: number;
  incidents: Array<{ status: string; category: string }>;
  packages: Array<{
    status: string;
    weightKg: number;
    actualFreightCents: number | null;
  }>;
  manifestEntries: Array<{ id: string }>;
  warehouse: { id: number; name: string };
  channelOrder: { channel: { id: number; name: string } } | null;
};

function logisticsSummary(
  rows: SummaryShipment[],
  timezone: string,
  now: Date,
) {
  const open = rows.filter(
      (item) => !["delivered", "cancelled"].includes(item.status),
    ),
    delivered = rows.filter(
      (item) =>
        item.deliveredAt &&
        item.dispatchedAt &&
        item.deliveredAt >= item.dispatchedAt,
    ),
    deadline = (item: SummaryShipment) =>
      item.dispatchDeadlineAt ||
      (item.deadlineAt
        ? zonedMidnight(
            addCalendarDays(item.deadlineAt.toISOString().slice(0, 10), 1),
            timezone,
          )
        : null),
    late = open.filter((item) => {
      const value = deadline(item);
      return value && value < now;
    }),
    tomorrow = zonedMidnight(
      addCalendarDays(dateInTimezone(now, timezone), 1),
      timezone,
    ),
    dueToday = open.filter((item) => {
      const value = deadline(item);
      return value && value >= now && value < tomorrow;
    }),
    deliveredOnTime = delivered.filter((item) => {
      const value = deadline(item);
      return !value || item.deliveredAt! <= value;
    }),
    shippedOnTime = rows.filter((item) => {
      if (!item.dispatchedAt) return false;
      const value = item.dispatchDeadlineAt;
      return !value || item.dispatchedAt <= value;
    }),
    totalFreightCents = rows.reduce((sum, item) => {
      const packageFreight = item.packages.reduce(
        (value, volume) => value + (volume.actualFreightCents || 0),
        0,
      );
      return (
        sum +
        (item.actualFreightCents ??
          (packageFreight > 0
            ? packageFreight
            : (item.quotedFreightCents ?? Math.round(item.freight * 100))))
      );
    }, 0),
    cycleHours = delivered.map(
      (item) =>
        (item.deliveredAt!.valueOf() - item.createdAt.valueOf()) / 3_600_000,
    ),
    pickingHours = rows
      .filter((item) => item.packedAt)
      .map(
        (item) =>
          (item.packedAt!.valueOf() - item.createdAt.valueOf()) / 3_600_000,
      ),
    transitHours = delivered.map(
      (item) =>
        (item.deliveredAt!.valueOf() - item.dispatchedAt!.valueOf()) /
        3_600_000,
    ),
    incidentCount = rows.reduce(
      (sum, item) =>
        sum +
        item.incidents.filter((incident) => incident.status === "open").length,
      0,
    ),
    manifestedPackages = rows
      .filter((item) => item.manifestEntries.length > 0)
      .reduce((sum, item) => sum + item.packages.length, 0),
    totalPackages = rows.reduce((sum, item) => sum + item.packages.length, 0),
    labelledPackages = rows.reduce(
      (sum, item) =>
        sum +
        item.packages.filter((volume) =>
          [
            "label_ready",
            "dispatched",
            "in_transit",
            "out_for_delivery",
            "delivered",
          ].includes(volume.status),
        ).length,
      0,
    );
  const carrierMap = new Map<
    string,
    {
      shipments: number;
      delivered: number;
      onTime: number;
      freightCents: number;
    }
  >();
  for (const item of rows) {
    const key = item.carrier || "Não definida",
      current = carrierMap.get(key) || {
        shipments: 0,
        delivered: 0,
        onTime: 0,
        freightCents: 0,
      };
    current.shipments += 1;
    current.delivered += Number(Boolean(item.deliveredAt));
    current.onTime += Number(deliveredOnTime.includes(item));
    current.freightCents +=
      item.actualFreightCents ||
      item.quotedFreightCents ||
      Math.round(item.freight * 100);
    carrierMap.set(key, current);
  }
  const dailyMap = new Map<string, { created: number; delivered: number }>();
  for (let offset = 13; offset >= 0; offset -= 1) {
    const date = new Date(now.valueOf() - offset * 86_400_000),
      key = dateInTimezone(date, timezone);
    dailyMap.set(key, { created: 0, delivered: 0 });
  }
  for (const item of rows) {
    const createdKey = dateInTimezone(item.createdAt, timezone),
      deliveredKey = item.deliveredAt
        ? dateInTimezone(item.deliveredAt, timezone)
        : null;
    if (dailyMap.has(createdKey)) dailyMap.get(createdKey)!.created += 1;
    if (deliveredKey && dailyMap.has(deliveredKey))
      dailyMap.get(deliveredKey)!.delivered += 1;
  }
  const exceptionCauses = new Map<string, number>();
  for (const item of rows)
    for (const incident of item.incidents)
      exceptionCauses.set(
        incident.category,
        (exceptionCauses.get(incident.category) || 0) + 1,
      );
  return {
    pending: rows.filter((item) =>
      ["picking", "packed", "on_hold"].includes(item.status),
    ).length,
    dispatched: rows.filter((item) => item.status === "dispatched").length,
    late: late.length,
    dueToday: dueToday.length,
    urgent: open.filter((item) => item.priority === "urgent").length,
    onTimeRate: rate(deliveredOnTime.length, delivered.length, 100),
    shipOnTimeRate: rate(
      shippedOnTime.length,
      rows.filter((item) => item.dispatchedAt).length,
      100,
    ),
    otifRate: rate(
      deliveredOnTime.filter((item) => item.incidents.length === 0).length,
      delivered.length,
      100,
    ),
    firstAttemptRate: rate(
      delivered.filter(
        (item) =>
          !item.incidents.some((incident) => incident.category === "carrier"),
      ).length,
      delivered.length,
      100,
    ),
    averageCycleHours: average(cycleHours),
    averagePickingHours: average(pickingHours),
    averageTransitHours: average(transitHours),
    freight: totalFreightCents / 100,
    costPerShipment: rows.length ? totalFreightCents / 100 / rows.length : 0,
    incidents: incidentCount,
    exceptionRate: rate(
      rows.filter((item) => item.incidents.length > 0).length,
      rows.length,
      0,
    ),
    manifested: manifestedPackages,
    packageCount: totalPackages,
    labelCoverageRate: rate(labelledPackages, totalPackages, 0),
    bi: {
      statusDistribution: [
        "picking",
        "packed",
        "dispatched",
        "delivered",
        "cancelled",
        "on_hold",
      ].map((status) => ({
        status,
        count: rows.filter((item) => item.status === status).length,
      })),
      dailyThroughput: [...dailyMap].map(([date, value]) => ({
        date,
        ...value,
      })),
      carrierScorecards: [...carrierMap]
        .map(([carrier, value]) => ({
          carrier,
          ...value,
          onTimeRate: rate(value.onTime, value.delivered, 0),
          averageFreight:
            value.shipments > 0
              ? value.freightCents / 100 / value.shipments
              : 0,
        }))
        .sort((left, right) => right.shipments - left.shipments),
      exceptionCauses: [...exceptionCauses]
        .map(([category, count]) => ({ category, count }))
        .sort((left, right) => right.count - left.count),
    },
  };
}

async function replacePickAllocations(
  tx: Prisma.TransactionClient,
  shipment: IncludedShipment,
  item: IncludedShipment["items"][number],
  row: ReturnType<typeof shipmentPickingInput>["items"][number],
  actor: string,
) {
  const allocationTotal = row.allocations.reduce(
    (sum, allocation) => sum + allocation.quantity,
    0,
  );
  if (
    row.allocations.length &&
    Math.abs(allocationTotal - row.pickedQuantity) > 0.0001
  )
    throw new OmnichannelInputError(
      `A soma dos lotes de ${item.salesOrderItem.product.name} deve ser igual à quantidade separada.`,
    );
  const oldAllocations = item.pickAllocations,
    lotIds = [
      ...new Set(
        [
          ...oldAllocations.map((value) => value.lotId),
          ...row.allocations.map((value) => value.lotId),
        ].filter((value): value is string => Boolean(value)),
      ),
    ];
  if (lotIds.length)
    await tx.$queryRaw(
      Prisma.sql`SELECT "id" FROM "pos_inventory_lots" WHERE "id" IN (${Prisma.join(lotIds)}) ORDER BY "id" FOR UPDATE`,
    );
  for (const allocation of oldAllocations)
    if (allocation.lotId)
      await tx.posInventoryLot.update({
        where: { id: allocation.lotId },
        data: {
          reservedMicros: {
            decrement: BigInt(Math.round(allocation.quantity * 1_000_000)),
          },
        },
      });
  await tx.shipmentPickAllocation.deleteMany({
    where: { shipmentItemId: item.id },
  });
  const trackedLots = await tx.posInventoryLot.count({
    where: {
      warehouseId: shipment.warehouseId,
      productId: item.salesOrderItem.productId,
      variationId: item.salesOrderItem.variationId,
      quantityMicros: { gt: BigInt(0) },
    },
  });
  if (trackedLots && row.pickedQuantity > 0 && !row.allocations.length)
    throw new OmnichannelInputError(
      `Selecione lote ou série para ${item.salesOrderItem.product.name}.`,
    );
  const acceptedCodes = new Set(
    [
      item.salesOrderItem.product.sku,
      item.salesOrderItem.product.gtin,
      item.salesOrderItem.variation?.sku,
      item.salesOrderItem.variation?.gtin,
    ].filter(Boolean),
  );
  for (const allocation of row.allocations) {
    if (allocation.scannedCode && !acceptedCodes.has(allocation.scannedCode))
      throw new OmnichannelInputError(
        `O código lido não corresponde a ${item.salesOrderItem.product.name}.`,
      );
    if (trackedLots && !allocation.lotId)
      throw new OmnichannelInputError(
        `Informe o lote ou número de série de ${item.salesOrderItem.product.name}.`,
      );
    if (allocation.lotId) {
      const lot = await tx.posInventoryLot.findFirst({
        where: {
          id: allocation.lotId,
          warehouseId: shipment.warehouseId,
          productId: item.salesOrderItem.productId,
          variationId: item.salesOrderItem.variationId,
          bucketKey: "sellable",
          status: "available",
        },
      });
      const micros = BigInt(Math.round(allocation.quantity * 1_000_000));
      if (!lot || lot.quantityMicros - lot.reservedMicros < micros)
        throw new OmnichannelInputError(
          `O lote selecionado de ${item.salesOrderItem.product.name} não possui saldo disponível.`,
        );
      await tx.posInventoryLot.update({
        where: { id: lot.id },
        data: { reservedMicros: { increment: micros } },
      });
    }
    await tx.shipmentPickAllocation.create({
      data: {
        shipmentItemId: item.id,
        lotId: allocation.lotId,
        quantity: allocation.quantity,
        location: allocation.location || row.location,
        scannedCode: allocation.scannedCode,
        pickedBy: actor,
      },
    });
  }
}

async function releaseShipmentPickAllocations(
  tx: Prisma.TransactionClient,
  shipmentId: number,
) {
  const allocations = await tx.shipmentPickAllocation.findMany({
    where: { shipmentItem: { shipmentId } },
  });
  const lotIds = [
    ...new Set(
      allocations
        .map((item) => item.lotId)
        .filter((value): value is string => Boolean(value)),
    ),
  ];
  if (lotIds.length)
    await tx.$queryRaw(
      Prisma.sql`SELECT "id" FROM "pos_inventory_lots" WHERE "id" IN (${Prisma.join(lotIds)}) ORDER BY "id" FOR UPDATE`,
    );
  for (const allocation of allocations)
    if (allocation.lotId)
      await tx.posInventoryLot.update({
        where: { id: allocation.lotId },
        data: {
          reservedMicros: {
            decrement: BigInt(Math.round(allocation.quantity * 1_000_000)),
          },
        },
      });
  await tx.shipmentPickAllocation.deleteMany({
    where: { shipmentItem: { shipmentId } },
  });
}

async function consumePickAllocations(
  tx: Prisma.TransactionClient,
  item: IncludedShipment["items"][number],
  shipmentId: number,
  actor: string,
) {
  for (const allocation of item.pickAllocations) {
    if (!allocation.lotId) continue;
    await tx.$queryRaw(
      Prisma.sql`SELECT "id" FROM "pos_inventory_lots" WHERE "id" = ${allocation.lotId} FOR UPDATE`,
    );
    const lot = await tx.posInventoryLot.findUnique({
        where: { id: allocation.lotId },
      }),
      micros = BigInt(Math.round(allocation.quantity * 1_000_000));
    if (!lot || lot.quantityMicros < micros || lot.reservedMicros < micros)
      throw new OmnichannelInputError(
        `A reserva de lote de ${item.salesOrderItem.product.name} está inconsistente.`,
      );
    await tx.posInventoryLot.update({
      where: { id: lot.id },
      data: {
        quantityMicros: { decrement: micros },
        reservedMicros: { decrement: micros },
        ...(lot.quantityMicros === micros ? { status: "depleted" } : {}),
      },
    });
    await tx.posInventoryLotMovement.create({
      data: {
        lotId: lot.id,
        type: "shipment",
        quantityMicros: -micros,
        balanceBeforeMicros: lot.quantityMicros,
        balanceAfterMicros: lot.quantityMicros - micros,
        referenceType: "shipment",
        referenceId: String(shipmentId),
        idempotencyKey: `shipment:${shipmentId}:allocation:${allocation.id}`,
        actor,
      },
    });
  }
}

function generateSscc(shipmentId: number, sequence: number) {
  const base = `789${String(shipmentId).padStart(10, "0").slice(-10)}${String(sequence).padStart(4, "0").slice(-4)}`;
  let sum = 0;
  for (let index = base.length - 1, weight = 3; index >= 0; index -= 1) {
    sum += Number(base[index]) * weight;
    weight = weight === 3 ? 1 : 3;
  }
  return `${base}${(10 - (sum % 10)) % 10}`;
}

function operationalTrackingCode(shipmentId: number, sequence: number) {
  return `NLV${String(shipmentId).padStart(8, "0")}${String(sequence).padStart(3, "0")}BR`;
}

function logisticsCsv(rows: IncludedShipment[], timezone: string) {
  const headers = [
      "Expedição",
      "Pedido",
      "Filial",
      "Depósito",
      "Cliente",
      "Canal",
      "Status",
      "Prioridade",
      "Transportadora",
      "Serviço",
      "Rastreio",
      "Volumes",
      "Peso kg",
      "Prazo",
      "Frete cotado",
      "Frete realizado",
      "Ocorrências abertas",
      "Romaneio",
      "Criada em",
    ],
    records = rows.map((row) => [
      row.number,
      row.salesOrder.number,
      row.warehouse.branch?.name || "",
      row.warehouse.name,
      row.salesOrder.customerName,
      row.channelOrder?.channel.name || "Venda direta",
      row.status,
      row.priority,
      row.carrier || "",
      row.service || "",
      row.trackingCode || "",
      row.packages.length,
      row.packages.reduce((sum, item) => sum + item.weightKg, 0),
      row.dispatchDeadlineAt?.toISOString() ||
        row.deadlineAt?.toISOString() ||
        "",
      (row.quotedFreightCents || 0) / 100,
      (row.actualFreightCents || 0) / 100,
      row.incidents.filter((item) => item.status === "open").length,
      row.manifestEntries[0]?.manifest.number || row.manifestNumber || "",
      new Intl.DateTimeFormat("pt-BR", {
        timeZone: timezone,
        dateStyle: "short",
        timeStyle: "short",
      }).format(row.createdAt),
    ]),
    csv = [headers, ...records]
      .map((record) => record.map(csvCell).join(";"))
      .join("\r\n");
  return new Response(`\uFEFF${csv}`, {
    headers: {
      "content-type": "text/csv; charset=utf-8",
      "content-disposition": `attachment; filename="expedicoes-${dateInTimezone(new Date(), timezone)}.csv"`,
      ...omnichannelNoStoreHeaders,
    },
  });
}

function csvCell(value: unknown) {
  const raw = String(value ?? ""),
    neutralized = /^[\t\r ]*[=+\-@]/.test(raw) ? `'${raw}` : raw;
  return `"${neutralized.replaceAll('"', '""')}"`;
}

function packageStatus(status: string) {
  return (
    {
      in_transit: "in_transit",
      out_for_delivery: "out_for_delivery",
      delivery_failed: "delivery_failed",
      awaiting_pickup: "in_transit",
      returned_to_sender: "returned",
      delivered: "delivered",
    } as Record<string, string>
  )[status];
}

function maskSensitiveDocument(value: string | null | undefined) {
  if (!value) return null;
  const clean = value.replace(/\s+/g, "");
  return clean.length <= 4 ? `***${clean}` : `***${clean.slice(-4)}`;
}

function safeAction(payload: string) {
  try {
    const value = JSON.parse(payload) as Record<string, unknown>;
    return String(value.action || "unknown").slice(0, 120);
  } catch {
    return "invalid";
  }
}

function optionalPositiveInt(value: string | null) {
  if (!value) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}

function allowedFilter(value: string | null, allowed: string[]) {
  return value && allowed.includes(value) ? value : null;
}

function dateFilter(value: string | null, timezone: string, end = false) {
  if (!value || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  return zonedMidnight(end ? addCalendarDays(value, 1) : value, timezone);
}

function addCalendarDays(value: string, days: number) {
  const date = new Date(`${value}T12:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

function optionalText(value: unknown, maximum: number) {
  const text = String(value || "").trim();
  if (text.length > maximum)
    throw new OmnichannelInputError("Texto muito longo.");
  return text || null;
}

function optionalDateTime(value: unknown) {
  if (!value) return null;
  const date = new Date(String(value));
  if (Number.isNaN(date.valueOf()))
    throw new OmnichannelInputError("Data e hora inválidas.");
  return date;
}

function rate(numerator: number, denominator: number, fallback: number) {
  return denominator
    ? Math.round((numerator / denominator) * 1000) / 10
    : fallback;
}

function average(values: number[]) {
  return values.length
    ? Math.round(
        (values.reduce((sum, value) => sum + value, 0) / values.length) * 10,
      ) / 10
    : 0;
}

function failure(error: unknown) {
  if (error instanceof OmnichannelHttpError)
    return logisticsJson({ error: error.message }, { status: error.status });
  const databaseMessage = error instanceof Error ? error.message : "";
  if (
    databaseMessage.includes("claimed or converted by POS") ||
    databaseMessage.includes("pos_order_claim")
  )
    return logisticsJson(
      {
        error:
          "O pedido está reivindicado ou convertido no PDV e não pode entrar em expedição.",
      },
      { status: 409 },
    );
  if (
    error instanceof OmnichannelInputError ||
    error instanceof CustomerInputError
  )
    return logisticsJson(
      { error: error.message },
      { status: error.message.includes("Origem") ? 403 : 400 },
    );
  if (error instanceof LicenseDeniedError)
    return logisticsJson({ error: error.message }, { status: error.status });
  if (
    error &&
    typeof error === "object" &&
    "code" in error &&
    error.code === "P2002"
  )
    return logisticsJson(
      { error: "Expedição ou lançamento já processado." },
      { status: 409 },
    );
  if (
    error &&
    typeof error === "object" &&
    "code" in error &&
    error.code === "P2034"
  )
    return logisticsJson(
      {
        error:
          "A expedição mudou durante a operação. Atualize e tente novamente.",
      },
      { status: 409 },
    );
  if (error instanceof AuthError) {
    const response = authErrorResponse(error);
    for (const [name, value] of Object.entries(omnichannelNoStoreHeaders))
      response.headers.set(name, value);
    return response;
  }
  const errorId = randomUUID();
  console.error("logistics_api_error", { errorId, error: error instanceof Error ? error.name : typeof error });
  return logisticsJson(
    { error: "Não foi possível concluir a operação logística.", errorId },
    { status: 500 },
  );
}
