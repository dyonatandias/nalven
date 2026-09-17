import { PrismaPg } from "@prisma/adapter-pg";
import { Prisma, PrismaClient } from "../generated/tenant/client";

if (process.env.NALVEN_ALLOW_DEMO_OMNICHANNEL_SEED !== "1")
  throw new Error(
    "Defina NALVEN_ALLOW_DEMO_OMNICHANNEL_SEED=1 para confirmar o seed omnicanal demonstrativo.",
  );
const url = process.env.TENANT_DATABASE_URL;
if (!url) throw new Error("TENANT_DATABASE_URL não foi definida.");
const db = new PrismaClient({
  adapter: new PrismaPg({ connectionString: url }),
});
const actor = "Seed demonstrativo NALVEN";
const now = new Date();
const at = (hours: number) => new Date(now.getTime() + hours * 3_600_000);

async function main() {
  const [identity] = await db.$queryRaw<
    Array<{ database: string; role: string }>
  >(Prisma.sql`SELECT current_database() AS database, current_user AS role`);
  if (
    !identity ||
    identity.database !== "nalven_t_demo" ||
    identity.role !== "nalven_t_demo_runtime"
  )
    throw new Error(
      "O seed omnicanal só pode executar em nalven_t_demo com a credencial runtime.",
    );
  const [branch, warehouse, products] = await Promise.all([
    db.branch.findFirst({ where: { primary: true }, orderBy: { id: "asc" } }),
    db.warehouse.findFirst({
      where: { primary: true, active: true },
      orderBy: { id: "asc" },
    }),
    db.product.findMany({
      where: { active: true, type: "product" },
      include: {
        variations: {
          where: { enabled: true, status: { not: "trash" } },
          orderBy: { id: "asc" },
          take: 1,
        },
      },
      orderBy: { id: "asc" },
      take: 12,
    }),
  ]);
  if (!branch || !warehouse || products.length < 4)
    throw new Error(
      "Filial, depósito principal e ao menos quatro produtos são obrigatórios.",
    );

  const channelDefinitions = [
    {
      name: "Mercado Livre · Loja principal",
      provider: "mercado_livre",
      stockBuffer: 3,
      priceAdjustment: 7.5,
      syncInterval: 5,
    },
    {
      name: "Shopee · Auto Mais",
      provider: "shopee",
      stockBuffer: 5,
      priceAdjustment: 9,
      syncInterval: 10,
    },
    {
      name: "Loja virtual WooCommerce",
      provider: "woocommerce",
      stockBuffer: 2,
      priceAdjustment: 0,
      syncInterval: 15,
    },
    {
      name: "Amazon · Catálogo nacional",
      provider: "amazon",
      stockBuffer: 4,
      priceAdjustment: 11,
      syncInterval: 15,
    },
    {
      name: "Nuvemshop · Venda direta",
      provider: "nuvemshop",
      stockBuffer: 1,
      priceAdjustment: 2.5,
      syncInterval: 10,
    },
  ] as const;
  const channels = [];
  for (const [channelIndex, definition] of channelDefinitions.entries()) {
    const existing = await db.marketplaceChannel.findFirst({
      where: { name: definition.name },
    });
    const channel = existing
      ? await db.marketplaceChannel.update({
          where: { id: existing.id },
          data: {
            ...definition,
            status: "active",
            environment: "sandbox",
            autoImport: true,
            lastSyncStatus: "local_only",
            lastSyncMessage:
              "Cenário demonstrativo local; conecte uma credencial homologada para publicar externamente.",
            lastSyncAt: at(channelIndex === 3 ? -36 : -1),
          },
        })
      : await db.marketplaceChannel.create({
          data: {
            ...definition,
            status: "active",
            environment: "sandbox",
            autoImport: true,
            lastSyncStatus: "local_only",
            lastSyncMessage:
              "Cenário demonstrativo local; conecte uma credencial homologada para publicar externamente.",
            lastSyncAt: at(channelIndex === 3 ? -36 : -1),
          },
        });
    channels.push(channel);
  }

  for (const [channelIndex, channel] of channels.entries()) {
    for (const [index, product] of products
      .slice(channelIndex, channelIndex + 6)
      .entries()) {
      const externalId = `DEMO-${channel.provider.toUpperCase()}-${product.sku}`;
      const targetPrice =
        Math.round(product.price * (1 + channel.priceAdjustment / 100) * 100) /
        100;
      const targetStock = Math.max(0, product.stock - channel.stockBuffer);
      await db.marketplaceListing.upsert({
        where: {
          channelId_productId: { channelId: channel.id, productId: product.id },
        },
        update: {
          externalId,
          title: `${product.name} | Envio rápido`,
          price: index === 1 ? targetPrice + 8 : targetPrice,
          syncedStock: index === 2 ? Math.max(0, targetStock - 4) : targetStock,
          desiredPrice: targetPrice,
          desiredStock: targetStock,
          syncState:
            index === 4
              ? "error"
              : [1, 2].includes(index)
                ? "pending_external"
                : "observed",
          syncMessage:
            index === 4
              ? "Canal recusou o anúncio; revise os atributos obrigatórios."
              : [1, 2].includes(index)
                ? "Alteração aguardando confirmação do canal."
                : "Último estado observado no canal.",
          status: index === 4 ? "error" : index === 5 ? "paused" : "active",
          lastSyncedAt: at(-(index + 1)),
        },
        create: {
          channelId: channel.id,
          productId: product.id,
          externalId,
          title: `${product.name} | Envio rápido`,
          price: index === 1 ? targetPrice + 8 : targetPrice,
          syncedStock: index === 2 ? Math.max(0, targetStock - 4) : targetStock,
          desiredPrice: targetPrice,
          desiredStock: targetStock,
          syncState:
            index === 4
              ? "error"
              : [1, 2].includes(index)
                ? "pending_external"
                : "observed",
          syncMessage:
            index === 4
              ? "Canal recusou o anúncio; revise os atributos obrigatórios."
              : [1, 2].includes(index)
                ? "Alteração aguardando confirmação do canal."
                : "Último estado observado no canal.",
          status: index === 4 ? "error" : index === 5 ? "paused" : "active",
          lastSyncedAt: at(-(index + 1)),
        },
      });
    }
  }

  const scenarios = [
    {
      key: "ML-900101",
      channel: 0,
      product: 0,
      status: "approved",
      shipment: null,
      total: 219.8,
      commission: 35.17,
      buyerFreight: 0,
      sellerFreight: 18.9,
      priority: "urgent",
      deadline: -3,
      incident: false,
    },
    {
      key: "ML-900102",
      channel: 0,
      product: 1,
      status: "approved",
      shipment: "picking",
      total: 149.9,
      commission: 23.98,
      buyerFreight: 0,
      sellerFreight: 15.4,
      priority: "urgent",
      deadline: -1,
      incident: true,
    },
    {
      key: "SHP-810201",
      channel: 1,
      product: 2,
      status: "approved",
      shipment: "picking",
      total: 89.9,
      commission: 16.18,
      buyerFreight: 9.9,
      sellerFreight: 6.5,
      priority: "high",
      deadline: 5,
      incident: false,
    },
    {
      key: "SHP-810202",
      channel: 1,
      product: 3,
      status: "approved",
      shipment: "packed",
      total: 329.7,
      commission: 59.35,
      buyerFreight: 0,
      sellerFreight: 22.8,
      priority: "normal",
      deadline: 18,
      incident: false,
    },
    {
      key: "WOO-720301",
      channel: 2,
      product: 4,
      status: "shipped",
      shipment: "dispatched",
      total: 179.8,
      commission: 5.4,
      buyerFreight: 19.9,
      sellerFreight: 13.2,
      priority: "normal",
      deadline: 32,
      incident: false,
    },
    {
      key: "AMZ-630401",
      channel: 3,
      product: 5,
      status: "delivered",
      shipment: "delivered",
      total: 459.9,
      commission: 73.58,
      buyerFreight: 0,
      sellerFreight: 25.7,
      priority: "high",
      deadline: -24,
      incident: false,
    },
    {
      key: "NUV-540501",
      channel: 4,
      product: 6,
      status: "approved",
      shipment: "cancelled",
      total: 119.9,
      commission: 3.6,
      buyerFreight: 14.9,
      sellerFreight: 10.1,
      priority: "low",
      deadline: 48,
      incident: false,
    },
    {
      key: "WOO-720302",
      channel: 2,
      product: 7,
      status: "delivered",
      shipment: "delivered",
      total: 279.8,
      commission: 8.39,
      buyerFreight: 16.9,
      sellerFreight: 12.4,
      priority: "normal",
      deadline: -72,
      incident: false,
    },
    {
      key: "AMZ-630402",
      channel: 3,
      product: 8,
      status: "approved",
      shipment: null,
      total: 539.9,
      commission: 86.38,
      buyerFreight: 0,
      sellerFreight: 28.5,
      priority: "high",
      deadline: 10,
      incident: false,
    },
    {
      key: "NUV-540502",
      channel: 4,
      product: 9,
      status: "approved",
      shipment: "picking",
      total: 198.7,
      commission: 5.96,
      buyerFreight: 18.9,
      sellerFreight: 11.4,
      priority: "normal",
      deadline: 7,
      incident: false,
    },
    {
      key: "ML-900103",
      channel: 0,
      product: 10,
      status: "approved",
      shipment: "packed",
      total: 749.9,
      commission: 119.98,
      buyerFreight: 0,
      sellerFreight: 32.7,
      priority: "urgent",
      deadline: 2,
      incident: false,
    },
    {
      key: "SHP-810203",
      channel: 1,
      product: 11,
      status: "shipped",
      shipment: "dispatched",
      total: 264.5,
      commission: 47.61,
      buyerFreight: 12.9,
      sellerFreight: 17.6,
      priority: "high",
      deadline: -4,
      incident: true,
    },
    {
      key: "WOO-720303",
      channel: 2,
      product: 0,
      status: "delivered",
      shipment: "delivered",
      total: 399.8,
      commission: 11.99,
      buyerFreight: 22.9,
      sellerFreight: 16.2,
      priority: "normal",
      deadline: -36,
      incident: false,
    },
    {
      key: "AMZ-630403",
      channel: 3,
      product: 1,
      status: "approved",
      shipment: null,
      total: 169.9,
      commission: 27.18,
      buyerFreight: 0,
      sellerFreight: 14.8,
      priority: "low",
      deadline: 72,
      incident: false,
    },
  ] as const;

  for (const [index, scenario] of scenarios.entries()) {
    const channel = channels[scenario.channel],
      product = products[scenario.product % products.length],
      variation = index % 3 === 0 ? product.variations[0] : undefined,
      number = `OMNI-DEMO-${String(index + 1).padStart(3, "0")}`,
      orderCreatedAt = at(-96 - index * 5),
      shipmentCreatedAt = at(-36);
    let salesOrder = await db.salesOrder.findUnique({
      where: { number },
      include: { items: true },
    });
    if (!salesOrder)
      salesOrder = await db.salesOrder.create({
        data: {
          number,
          kind: "order",
          status: scenario.status,
          origin: "marketplace",
          salesChannel: "marketplace",
          branchId: branch.id,
          customerName:
            [
              "Mariana Lopes",
              "Oficina Três Irmãos",
              "Paulo Henrique",
              "Auto Center Pinhal",
              "Bruna Martins",
              "Frotas Oeste",
              "Renata Alves",
              "Mecânica Boa Vista",
            ][index] || `Cliente Omnicanal ${index + 1}`,
          customerEmail: `cliente.omni.${index + 1}@example.com`,
          customerPhone: `4999000${String(index + 1).padStart(4, "0")}`,
          subtotal: scenario.total,
          freightAmount: scenario.buyerFreight,
          total: scenario.total + scenario.buyerFreight,
          deliveryType: "carrier",
          deliveryZip: "89800000",
          deliveryStreet: "Avenida Getúlio Vargas",
          deliveryNumber: String(150 + index),
          deliveryDistrict: "Centro",
          deliveryCity: index % 2 ? "Xanxerê" : "Chapecó",
          deliveryState: "SC",
          priority: scenario.priority,
          approvedAt: at(-48 - index * 5),
          completedAt: scenario.status === "delivered" ? at(-8) : null,
          notes: `Pedido demonstrativo importado de ${channel.name}.`,
          createdBy: actor,
          createdAt: orderCreatedAt,
          items: {
            create: {
              productId: product.id,
              variationId: variation?.id,
              nameSnapshot: product.name,
              skuSnapshot: variation?.sku || product.sku,
              variationSnapshot: variation?.attributes || undefined,
              quantity: scenario.total > 300 ? 3 : 2,
              listPrice: product.price,
              unitPrice: scenario.total / (scenario.total > 300 ? 3 : 2),
              total: scenario.total,
            },
          },
          addresses: {
            create: {
              type: "shipping",
              firstName:
                [
                  "Mariana",
                  "Rafael",
                  "Paulo",
                  "Juliana",
                  "Bruna",
                  "Eduardo",
                  "Renata",
                  "Carlos",
                ][index] || `Cliente ${index + 1}`,
              email: `cliente.omni.${index + 1}@example.com`,
              zip: "89800000",
              street: "Avenida Getúlio Vargas",
              number: String(150 + index),
              neighborhood: "Centro",
              city: index % 2 ? "Xanxerê" : "Chapecó",
              state: "SC",
            },
          },
          history: {
            create: {
              toStatus: scenario.status,
              actor,
              actorType: "system",
              notes: "Cenário omnicanal demonstrativo",
            },
          },
        },
        include: { items: true },
      });
    else
      salesOrder = await db.salesOrder.update({
        where: { id: salesOrder.id },
        data: { createdAt: orderCreatedAt },
        include: { items: true },
      });
    if (variation && salesOrder.items[0]?.variationId !== variation.id) {
      await db.salesOrderItem.update({
        where: { id: salesOrder.items[0]!.id },
        data: {
          variationId: variation.id,
          skuSnapshot: variation.sku || product.sku,
          variationSnapshot: variation.attributes || undefined,
        },
      });
      await db.warehouseVariationBalance.upsert({
        where: {
          warehouseId_variationId: {
            warehouseId: warehouse.id,
            variationId: variation.id,
          },
        },
        update: { quantity: { increment: 0 } },
        create: {
          warehouseId: warehouse.id,
          productId: product.id,
          variationId: variation.id,
          quantity: Math.max(25, variation.stock || 0),
        },
      });
      salesOrder = await db.salesOrder.findUniqueOrThrow({
        where: { id: salesOrder.id },
        include: { items: true },
      });
    }
    const paymentStatus = index === 2 ? "pending" : "paid",
      riskStatus = index === 3 ? "review" : "approved",
      buyerCancelRequested = [0, 13].includes(index),
      shipByAt = at(scenario.deadline),
      deliverByAt = at(scenario.deadline + 48),
      cancelByAt = at(scenario.deadline + 6);
    await db.marketplaceOrder.upsert({
      where: {
        channelId_externalId: {
          channelId: channel.id,
          externalId: scenario.key,
        },
      },
      update: {
        status:
          scenario.status === "shipped"
            ? "shipped"
            : scenario.status === "delivered"
              ? "delivered"
              : "imported",
        total: scenario.total,
        fee: scenario.commission,
        commission: scenario.commission,
        buyerShippingCost: scenario.buyerFreight,
        sellerShippingCost: scenario.sellerFreight,
        marketplaceStatus: scenario.status,
        paymentStatus,
        riskStatus,
        buyerCancelRequested,
        shipByAt,
        deliverByAt,
        cancelByAt,
        logisticType:
          channel.provider === "mercado_livre" ? "cross_docking" : "carrier",
        invoiceStatus:
          scenario.shipment && scenario.shipment !== "cancelled"
            ? "authorized"
            : "pending",
      },
      create: {
        channelId: channel.id,
        externalId: scenario.key,
        status:
          scenario.status === "shipped"
            ? "shipped"
            : scenario.status === "delivered"
              ? "delivered"
              : "imported",
        customerName: salesOrder.customerName,
        total: scenario.total,
        fee: scenario.commission,
        commission: scenario.commission,
        buyerShippingCost: scenario.buyerFreight,
        sellerShippingCost: scenario.sellerFreight,
        marketplaceStatus: scenario.status,
        paymentStatus,
        riskStatus,
        buyerCancelRequested,
        shipByAt,
        deliverByAt,
        cancelByAt,
        logisticType:
          channel.provider === "mercado_livre" ? "cross_docking" : "carrier",
        shipmentExternalId: `PACK-${scenario.key}`,
        invoiceStatus:
          scenario.shipment && scenario.shipment !== "cancelled"
            ? "authorized"
            : "pending",
        salesOrderId: salesOrder.id,
        rawData: { demo: true, version: "omnichannel-v2" },
      },
    });
    if (!scenario.shipment) continue;
    const marketplaceOrder = await db.marketplaceOrder.findUniqueOrThrow({
      where: {
        channelId_externalId: {
          channelId: channel.id,
          externalId: scenario.key,
        },
      },
    });
    const shipmentNumber = `EXP-DEMO-${String(index + 1).padStart(3, "0")}`;
    const existingShipment = await db.shipment.findUnique({
      where: { number: shipmentNumber },
    });
    if (!existingShipment) {
      // O banco exige que toda expedição nasça de um pedido aprovado. Os
      // estados shipped/delivered são aplicados somente após a expedição ter
      // sido materializada, reproduzindo a ordem do fluxo operacional real.
      if (salesOrder.status !== "approved") {
        salesOrder = await db.salesOrder.update({
          where: { id: salesOrder.id },
          data: { status: "approved", completedAt: null },
          include: { items: true },
        });
      }
      const dispatched = ["dispatched", "delivered"].includes(
          scenario.shipment,
        ),
        delivered = scenario.shipment === "delivered",
        cancelled = scenario.shipment === "cancelled";
      await db.shipment.create({
        data: {
          number: shipmentNumber,
          salesOrderId: salesOrder.id,
          channelOrderId: marketplaceOrder.id,
          warehouseId: warehouse.id,
          status: scenario.shipment,
          priority: scenario.priority,
          carrier: dispatched ? (index % 2 ? "Jadlog" : "Correios") : null,
          service: dispatched ? "Expresso" : null,
          trackingCode: dispatched
            ? `NLV${String(index + 1).padStart(9, "0")}BR`
            : null,
          freight: scenario.sellerFreight,
          assignedTo: scenario.shipment === "picking" ? "Equipe A" : actor,
          station: index % 2 ? "Bancada 02" : "Bancada 01",
          fiscalRequired: true,
          fiscalStatus: "authorized",
          quotedFreightCents: Math.round(scenario.sellerFreight * 100),
          actualFreightCents: dispatched
            ? Math.round(
                scenario.sellerFreight * (1 + (index % 3) * 0.04) * 100,
              )
            : null,
          chargedFreightCents: Math.round(scenario.buyerFreight * 100),
          declaredValueCents: Math.round(scenario.total * 100),
          dispatchDeadlineAt: at(scenario.deadline),
          deadlineAt: at(scenario.deadline + 48),
          packageCount: scenario.total > 300 ? 2 : 1,
          weightKg: 1.2 + index * 0.35,
          lengthCm: 28,
          widthCm: 19,
          heightCm: 12,
          pickingStartedAt: at(-30),
          packedBy: scenario.shipment !== "picking" ? actor : null,
          packedAt: scenario.shipment !== "picking" ? at(-20) : null,
          dispatchedAt: dispatched ? at(-15) : null,
          deliveredAt: delivered ? at(-8) : null,
          deliveryRecipient: delivered ? salesOrder.customerName : null,
          deliveryDocument: delivered ? `***${100 + index}` : null,
          deliveryNotes: delivered ? "Volume recebido sem ressalvas." : null,
          proofUrl: delivered
            ? `https://example.com/comprovantes/${scenario.key}`
            : null,
          exceptionStatus: scenario.incident ? "open" : "none",
          exceptionCategory: scenario.incident ? "carrier" : null,
          exceptionOwner: scenario.incident ? "Torre logística" : null,
          exceptionDueAt: scenario.incident ? at(12) : null,
          manifestNumber: dispatched
            ? `ROM-DEMO-${index % 2 ? "JADLOG" : "CORREIOS"}`
            : null,
          manifestedAt: dispatched ? at(-16) : null,
          handoffAt: dispatched ? at(-15) : null,
          cancelledAt: cancelled ? at(-6) : null,
          cancelledBy: cancelled ? actor : null,
          cancellationReason: cancelled
            ? "Cliente alterou a modalidade de entrega antes da coleta."
            : null,
          createdBy: actor,
          createdAt: shipmentCreatedAt,
          items: {
            create: salesOrder.items.map((item) => ({
              salesOrderItemId: item.id,
              quantity: item.quantity,
              pickedQuantity:
                scenario.shipment === "picking" && !scenario.incident
                  ? item.quantity / 2
                  : item.quantity,
            })),
          },
          events: {
            create: [
              {
                type: "created",
                description: "Expedição demonstrativa aberta",
                actor,
                createdAt: at(-32),
              },
              {
                type:
                  scenario.shipment === "picking"
                    ? "picking_progress"
                    : "picked",
                description:
                  scenario.shipment === "picking"
                    ? "Separação parcial registrada"
                    : "Itens separados e conferidos",
                actor,
                createdAt: at(-27),
              },
              ...(scenario.shipment !== "picking"
                ? [
                    {
                      type: "packed",
                      description: "Volumes embalados e cubagem conferida",
                      actor,
                      createdAt: at(-20),
                    },
                  ]
                : []),
              ...(dispatched
                ? [
                    {
                      type: "dispatched",
                      description: "Volume entregue à transportadora",
                      actor,
                      createdAt: at(-15),
                    },
                  ]
                : []),
              ...(delivered
                ? [
                    {
                      type: "delivered",
                      description: `Entrega confirmada para ${salesOrder.customerName}`,
                      actor,
                      createdAt: at(-8),
                    },
                  ]
                : []),
              ...(cancelled
                ? [
                    {
                      type: "cancelled",
                      description: "Expedição cancelada antes do despacho",
                      actor,
                      createdAt: at(-6),
                    },
                  ]
                : []),
              ...(scenario.incident
                ? [
                    {
                      type: "incident",
                      description:
                        "Divergência de embalagem em análise pela equipe",
                      actor,
                      createdAt: at(-2),
                    },
                  ]
                : []),
            ],
          },
        },
      });
    }
    const seededShipment = await db.shipment.findUniqueOrThrow({
        where: { number: shipmentNumber },
        include: { items: true },
      }),
      seededDispatched = ["dispatched", "delivered"].includes(
        scenario.shipment,
      ),
      seededDelivered = scenario.shipment === "delivered",
      seededCancelled = scenario.shipment === "cancelled";
    await db.shipment.update({
      where: { id: seededShipment.id },
      data: {
        createdAt: shipmentCreatedAt,
        exceptionStatus: scenario.incident ? "open" : "none",
        exceptionCategory: scenario.incident ? "carrier" : null,
        exceptionOwner: scenario.incident ? "Torre logística" : null,
        exceptionDueAt: scenario.incident ? at(12) : null,
        exceptionResolvedAt: null,
        exceptionResolution: null,
        fiscalRequired: true,
        fiscalStatus: "authorized",
        quotedFreightCents: Math.round(scenario.sellerFreight * 100),
        actualFreightCents: seededDispatched
          ? Math.round(scenario.sellerFreight * (1 + (index % 3) * 0.04) * 100)
          : null,
        chargedFreightCents: Math.round(scenario.buyerFreight * 100),
        declaredValueCents: Math.round(scenario.total * 100),
        manifestNumber: seededDispatched
          ? `ROM-DEMO-${index % 2 ? "JADLOG" : "CORREIOS"}`
          : null,
        manifestedAt: seededDispatched ? at(-16) : null,
        handoffAt: seededDispatched ? at(-15) : null,
        cancellationReason: seededCancelled
          ? "Cliente alterou a modalidade de entrega antes da coleta."
          : null,
      },
    });
    const volumeCount = Math.max(1, seededShipment.packageCount);
    if (scenario.shipment !== "picking" && !seededCancelled) {
      for (let sequence = 1; sequence <= volumeCount; sequence += 1) {
        const trackingCode = `NLV${String(index + 1).padStart(7, "0")}${String(sequence).padStart(2, "0")}BR`,
          labelReady = ["packed", "dispatched", "delivered"].includes(
            scenario.shipment,
          ),
          volume = await db.shipmentPackage.upsert({
            where: {
              shipmentId_sequence: {
                shipmentId: seededShipment.id,
                sequence,
              },
            },
            update: {
              code: `${shipmentNumber}-V${String(sequence).padStart(3, "0")}`,
              status: seededDelivered
                ? "delivered"
                : seededDispatched
                  ? "dispatched"
                  : "label_ready",
              carrier: seededShipment.carrier || "Jadlog",
              service: seededShipment.service || "Econômico",
              trackingCode,
              sscc: `0789${String(10_000_000_000_000 + index * 100 + sequence)}`.slice(
                0,
                18,
              ),
              weightKg: (seededShipment.weightKg || 1) / volumeCount,
              lengthCm: seededShipment.lengthCm || 28,
              widthCm: seededShipment.widthCm || 19,
              heightCm: seededShipment.heightCm || 12,
              volumetricWeightKg:
                ((seededShipment.lengthCm || 28) *
                  (seededShipment.widthCm || 19) *
                  (seededShipment.heightCm || 12)) /
                6000,
              quotedFreightCents: Math.round(
                (scenario.sellerFreight * 100) / volumeCount,
              ),
              actualFreightCents: seededDispatched
                ? Math.round(
                    (scenario.sellerFreight * (1 + (index % 3) * 0.04) * 100) /
                      volumeCount,
                  )
                : null,
              declaredValueCents: Math.round(
                (scenario.total * 100) / volumeCount,
              ),
              labelFormat: "pdf",
              labelUrl: labelReady
                ? `/api/erp/logistics/labels/demo-${index + 1}-${sequence}?format=pdf`
                : null,
              labelGeneratedAt: labelReady ? at(-19) : null,
              dispatchedAt: seededDispatched ? at(-15) : null,
              deliveredAt: seededDelivered ? at(-8) : null,
            },
            create: {
              id: `demo-${index + 1}-${sequence}`,
              shipmentId: seededShipment.id,
              sequence,
              code: `${shipmentNumber}-V${String(sequence).padStart(3, "0")}`,
              status: seededDelivered
                ? "delivered"
                : seededDispatched
                  ? "dispatched"
                  : "label_ready",
              carrier: seededShipment.carrier || "Jadlog",
              service: seededShipment.service || "Econômico",
              trackingCode,
              sscc: `0789${String(10_000_000_000_000 + index * 100 + sequence)}`.slice(
                0,
                18,
              ),
              weightKg: (seededShipment.weightKg || 1) / volumeCount,
              lengthCm: seededShipment.lengthCm || 28,
              widthCm: seededShipment.widthCm || 19,
              heightCm: seededShipment.heightCm || 12,
              volumetricWeightKg:
                ((seededShipment.lengthCm || 28) *
                  (seededShipment.widthCm || 19) *
                  (seededShipment.heightCm || 12)) /
                6000,
              quotedFreightCents: Math.round(
                (scenario.sellerFreight * 100) / volumeCount,
              ),
              actualFreightCents: seededDispatched
                ? Math.round(
                    (scenario.sellerFreight * (1 + (index % 3) * 0.04) * 100) /
                      volumeCount,
                  )
                : null,
              declaredValueCents: Math.round(
                (scenario.total * 100) / volumeCount,
              ),
              labelFormat: "pdf",
              labelUrl: labelReady
                ? `/api/erp/logistics/labels/demo-${index + 1}-${sequence}?format=pdf`
                : null,
              labelGeneratedAt: labelReady ? at(-19) : null,
              dispatchedAt: seededDispatched ? at(-15) : null,
              deliveredAt: seededDelivered ? at(-8) : null,
            },
          });
        const localLabelUrl = labelReady
          ? `/api/erp/logistics/labels/${volume.id}?format=pdf`
          : null;
        if (volume.labelUrl !== localLabelUrl)
          await db.shipmentPackage.update({
            where: { id: volume.id },
            data: { labelUrl: localLabelUrl },
          });
        await db.shipmentPackageItem.deleteMany({
          where: { packageId: volume.id },
        });
        await db.shipmentPackageItem.createMany({
          data: seededShipment.items.map((item) => ({
            packageId: volume.id,
            shipmentItemId: item.id,
            quantity: item.quantity / volumeCount,
          })),
        });
        await db.orderShippingLabel.upsert({
          where: {
            salesOrderId_externalId: {
              salesOrderId: salesOrder.id,
              externalId: volume.id,
            },
          },
          update: {
            carrier: volume.carrier,
            serviceName: volume.service,
            status: "purchased",
            amount: scenario.sellerFreight / volumeCount,
            trackingCode,
            labelUrl: localLabelUrl,
            purchasedAt: at(-19),
          },
          create: {
            salesOrderId: salesOrder.id,
            provider: "nalven_logistics_demo",
            externalId: volume.id,
            carrier: volume.carrier,
            serviceName: volume.service,
            status: "purchased",
            statusLabel: "Etiqueta demonstrativa pronta",
            amount: scenario.sellerFreight / volumeCount,
            trackingCode,
            labelUrl: localLabelUrl,
            purchasedAt: at(-19),
            createdBy: actor,
          },
        });
      }
    }
    if (scenario.shipment === "picking") {
      const waveNumber = `OND-DEMO-${index % 2 ? "B" : "A"}`,
        wave = await db.pickingWave.upsert({
          where: { number: waveNumber },
          update: {
            status: "open",
            assignedTo: index % 2 ? "Equipe B" : "Equipe A",
          },
          create: {
            number: waveNumber,
            branchId: branch.id,
            warehouseId: warehouse.id,
            status: "open",
            priority: scenario.priority,
            assignedTo: index % 2 ? "Equipe B" : "Equipe A",
            station: index % 2 ? "Corredor B" : "Corredor A",
            createdBy: actor,
            startedAt: at(-28),
          },
        });
      await db.pickingWaveShipment.upsert({
        where: {
          waveId_shipmentId: { waveId: wave.id, shipmentId: seededShipment.id },
        },
        update: { status: "in_progress", position: index },
        create: {
          waveId: wave.id,
          shipmentId: seededShipment.id,
          status: "in_progress",
          position: index,
        },
      });
      for (const [itemIndex, item] of seededShipment.items.entries()) {
        await db.shipmentPickAllocation.deleteMany({
          where: { shipmentItemId: item.id, pickedBy: actor },
        });
        if (item.pickedQuantity > 0)
          await db.shipmentPickAllocation.create({
            data: {
              shipmentItemId: item.id,
              quantity: item.pickedQuantity,
              location: `${index % 2 ? "B" : "A"}-${String(itemIndex + 1).padStart(2, "0")}-01`,
              scannedCode: salesOrder.items.find(
                (orderItem) => orderItem.id === item.salesOrderItemId,
              )?.skuSnapshot,
              pickedBy: actor,
              pickedAt: at(-26),
            },
          });
      }
    }
    if (seededDispatched) {
      const manifestNumber = `ROM-DEMO-${index % 2 ? "JADLOG" : "CORREIOS"}`,
        manifest = await db.shippingManifest.upsert({
          where: { number: manifestNumber },
          update: { status: "handed_off", handedOffAt: at(-15) },
          create: {
            number: manifestNumber,
            branchId: branch.id,
            warehouseId: warehouse.id,
            carrier: index % 2 ? "Jadlog" : "Correios",
            status: "handed_off",
            pickupWindow: at(-16),
            dock: index % 2 ? "Doca 02" : "Doca 01",
            vehiclePlate: index % 2 ? "ABC1D23" : "DEF4G56",
            driverName: index % 2 ? "João Silva" : "Maria Souza",
            driverDocument: "***.***.***-**",
            protocol: `PROTO-${index % 2 ? "JAD" : "COR"}`,
            createdBy: actor,
            closedAt: at(-16),
            handedOffAt: at(-15),
          },
        });
      await db.shippingManifestShipment.upsert({
        where: {
          manifestId_shipmentId: {
            manifestId: manifest.id,
            shipmentId: seededShipment.id,
          },
        },
        update: {},
        create: { manifestId: manifest.id, shipmentId: seededShipment.id },
      });
    }
    if (scenario.incident) {
      const description =
          index === 11
            ? "Primeira tentativa de entrega sem sucesso; endereço em validação"
            : "Divergência de embalagem em análise pela equipe",
        existingIncident = await db.shipmentIncident.findFirst({
          where: { shipmentId: seededShipment.id, description },
        });
      if (existingIncident)
        await db.shipmentIncident.update({
          where: { id: existingIncident.id },
          data: {
            status: "open",
            category: index === 11 ? "address" : "operational",
            severity: index === 11 ? "high" : "medium",
            owner: "Torre logística",
            dueAt: at(12),
          },
        });
      else
        await db.shipmentIncident.create({
          data: {
            shipmentId: seededShipment.id,
            category: index === 11 ? "address" : "operational",
            severity: index === 11 ? "high" : "medium",
            status: "open",
            owner: "Torre logística",
            description,
            dueAt: at(12),
            rootCause: index === 11 ? "Número do endereço divergente" : null,
            claimCents: index === 11 ? 1760 : 0,
            createdBy: actor,
          },
        });
    }
    if (seededDispatched) {
      const tracking = await db.orderTracking.upsert({
        where: { salesOrderId: salesOrder.id },
        update: {
          trackingNumber: seededShipment.trackingCode!,
          carrier: seededShipment.carrier,
          status: seededDelivered ? "delivered" : "in_transit",
          statusLabel: seededDelivered ? "Entregue" : "Em trânsito",
        },
        create: {
          salesOrderId: salesOrder.id,
          trackingNumber: seededShipment.trackingCode!,
          carrier: seededShipment.carrier,
          status: seededDelivered ? "delivered" : "in_transit",
          statusLabel: seededDelivered ? "Entregue" : "Em trânsito",
        },
      });
      const checkpointDescription = `Checkpoint demonstrativo ${scenario.key}`;
      if (
        !(await db.orderTrackingEvent.findFirst({
          where: {
            trackingId: tracking.id,
            description: checkpointDescription,
          },
        }))
      )
        await db.orderTrackingEvent.create({
          data: {
            trackingId: tracking.id,
            status: seededDelivered ? "delivered" : "in_transit",
            description: checkpointDescription,
            location: index % 2 ? "Xanxerê/SC" : "Chapecó/SC",
            occurredAt: seededDelivered ? at(-8) : at(-6),
          },
        });
    }
    if (seededDelivered && [5, 12].includes(index)) {
      const description = `Logística reversa demonstrativa ${scenario.key}`,
        existingReturn = await db.orderReturn.findFirst({
          where: { salesOrderId: salesOrder.id, description },
        });
      if (existingReturn)
        await db.orderReturn.update({
          where: { id: existingReturn.id },
          data: {
            status: index === 12 ? "received" : "authorized",
            reverseProvider: "Correios",
            reverseCode: `REV-${scenario.key}`,
            reverseTrackingCode: `REV${String(index + 1).padStart(9, "0")}BR`,
            reverseLabelUrl: `https://example.com/reversa/${scenario.key}`,
            reverseRequestedAt: at(-3),
            receivedAt: index === 12 ? at(-1) : null,
          },
        });
      else
        await db.orderReturn.create({
          data: {
            salesOrderId: salesOrder.id,
            reason: index === 5 ? "defect" : "withdrawal",
            description,
            status: index === 12 ? "received" : "authorized",
            customerEmail: salesOrder.customerEmail!,
            reverseProvider: "Correios",
            reverseCode: `REV-${scenario.key}`,
            reverseTrackingCode: `REV${String(index + 1).padStart(9, "0")}BR`,
            reverseLabelUrl: `https://example.com/reversa/${scenario.key}`,
            reverseRequestedAt: at(-3),
            receivedAt: index === 12 ? at(-1) : null,
            items: {
              create: seededShipment.items.map((item) => ({
                orderItemId: item.salesOrderItemId,
                quantity: item.quantity,
              })),
            },
          },
        });
    }
    if (
      scenario.status !== "approved" &&
      salesOrder.status !== scenario.status
    ) {
      await db.salesOrder.update({
        where: { id: salesOrder.id },
        data: {
          status: scenario.status,
          completedAt: scenario.status === "delivered" ? at(-8) : null,
        },
      });
    }
  }

  // Mantém um cenário idempotente de atendimento fracionado: duas remessas
  // independentes consomem partes diferentes do mesmo item do pedido.
  const splitOrder = await db.salesOrder.findUnique({
      where: { number: "OMNI-DEMO-004" },
      include: { items: { orderBy: { id: "asc" } } },
    }),
    splitMarketplaceOrder = splitOrder
      ? await db.marketplaceOrder.findUnique({
          where: { salesOrderId: splitOrder.id },
        })
      : null,
    splitPrimary = splitOrder
      ? await db.shipment.findUnique({
          where: { number: "EXP-DEMO-004" },
          include: { items: true, packages: true },
        })
      : null;
  if (splitOrder && splitMarketplaceOrder && splitPrimary) {
    const orderItem = splitOrder.items[0];
    if (!orderItem || orderItem.quantity <= 1)
      throw new Error(
        "O cenário de remessa fracionada exige um item com quantidade maior que um.",
      );
    const secondaryQuantity = 1,
      primaryQuantity = orderItem.quantity - secondaryQuantity,
      primaryItem = splitPrimary.items.find(
        (item) => item.salesOrderItemId === orderItem.id,
      );
    if (!primaryItem)
      throw new Error("Item da remessa principal fracionada não encontrado.");
    await db.shipmentItem.update({
      where: { id: primaryItem.id },
      data: {
        quantity: primaryQuantity,
        pickedQuantity: primaryQuantity,
        shortQuantity: 0,
      },
    });
    if (splitPrimary.packages.length)
      await db.shipmentPackageItem.updateMany({
        where: { shipmentItemId: primaryItem.id },
        data: { quantity: primaryQuantity / splitPrimary.packages.length },
      });

    const splitSecondary = await db.shipment.upsert({
      where: { number: "EXP-DEMO-004-B" },
      update: {
        salesOrderId: splitOrder.id,
        channelOrderId: splitMarketplaceOrder.id,
        warehouseId: warehouse.id,
        status: "picking",
        priority: "normal",
        assignedTo: "Equipe B",
        station: "Corredor B",
        fiscalRequired: true,
        fiscalStatus: "authorized",
        dispatchDeadlineAt: at(18),
        deadlineAt: at(66),
        packageCount: 1,
        weightKg: 0.55,
        lengthCm: 22,
        widthCm: 16,
        heightCm: 9,
        pickingStartedAt: at(-2),
        createdAt: at(-3),
      },
      create: {
        number: "EXP-DEMO-004-B",
        salesOrderId: splitOrder.id,
        channelOrderId: splitMarketplaceOrder.id,
        warehouseId: warehouse.id,
        status: "picking",
        priority: "normal",
        assignedTo: "Equipe B",
        station: "Corredor B",
        fiscalRequired: true,
        fiscalStatus: "authorized",
        dispatchDeadlineAt: at(18),
        deadlineAt: at(66),
        packageCount: 1,
        weightKg: 0.55,
        lengthCm: 22,
        widthCm: 16,
        heightCm: 9,
        pickingStartedAt: at(-2),
        createdBy: actor,
        createdAt: at(-3),
        items: {
          create: {
            salesOrderItemId: orderItem.id,
            quantity: secondaryQuantity,
            pickedQuantity: 0,
          },
        },
        events: {
          create: {
            type: "created",
            description:
              "Segunda remessa aberta para atendimento fracionado do pedido",
            actor,
            createdAt: at(-3),
          },
        },
      },
      include: { items: true },
    });
    const splitSecondaryItem = splitSecondary.items.find(
      (item) => item.salesOrderItemId === orderItem.id,
    );
    if (splitSecondaryItem)
      await db.shipmentItem.update({
        where: { id: splitSecondaryItem.id },
        data: {
          quantity: secondaryQuantity,
          pickedQuantity: 0,
          shortQuantity: 0,
        },
      });
    else
      await db.shipmentItem.create({
        data: {
          shipmentId: splitSecondary.id,
          salesOrderItemId: orderItem.id,
          quantity: secondaryQuantity,
        },
      });
    const splitWave = await db.pickingWave.upsert({
      where: { number: "OND-DEMO-B" },
      update: { status: "open", assignedTo: "Equipe B" },
      create: {
        number: "OND-DEMO-B",
        branchId: branch.id,
        warehouseId: warehouse.id,
        status: "open",
        priority: "normal",
        assignedTo: "Equipe B",
        station: "Corredor B",
        createdBy: actor,
        startedAt: at(-2),
      },
    });
    await db.pickingWaveShipment.upsert({
      where: {
        waveId_shipmentId: {
          waveId: splitWave.id,
          shipmentId: splitSecondary.id,
        },
      },
      update: { status: "pending", position: 99 },
      create: {
        waveId: splitWave.id,
        shipmentId: splitSecondary.id,
        status: "pending",
        position: 99,
      },
    });
  }

  const demoManifests = await db.shippingManifest.findMany({
    where: { number: { startsWith: "ROM-DEMO-" } },
    include: {
      shipments: {
        include: { shipment: { include: { packages: true } } },
      },
    },
  });
  for (const manifest of demoManifests)
    await db.shippingManifest.update({
      where: { id: manifest.id },
      data: {
        totalPackages: manifest.shipments.reduce(
          (sum, entry) => sum + entry.shipment.packages.length,
          0,
        ),
        totalWeightKg: manifest.shipments.reduce(
          (sum, entry) =>
            sum +
            entry.shipment.packages.reduce(
              (weight, volume) => weight + volume.weightKg,
              0,
            ),
          0,
        ),
      },
    });

  const failedChannel = channels[1];
  await db.marketplaceWebhookEvent.upsert({
    where: {
      channelId_eventKey: {
        channelId: failedChannel.id,
        eventKey: "demo-order-update-failed-v1",
      },
    },
    update: {
      state: "failed",
      attempts: 3,
      lastError:
        "SKU externo não mapeado; revise o anúncio antes de reprocessar.",
      nextAttemptAt: at(2),
    },
    create: {
      channelId: failedChannel.id,
      eventKey: "demo-order-update-failed-v1",
      eventType: "order.updated",
      payloadHash: "demo-omnichannel-failed-v1",
      payload: { demo: true },
      state: "failed",
      attempts: 3,
      lastError:
        "SKU externo não mapeado; revise o anúncio antes de reprocessar.",
      nextAttemptAt: at(2),
    },
  });
  await db.marketplaceWebhookEvent.upsert({
    where: {
      channelId_eventKey: {
        channelId: channels[0].id,
        eventKey: "demo-shipment-processed-v1",
      },
    },
    update: { state: "processed", processedAt: at(-1), attempts: 1 },
    create: {
      channelId: channels[0].id,
      eventKey: "demo-shipment-processed-v1",
      eventType: "shipment.updated",
      payloadHash: "demo-omnichannel-processed-v1",
      payload: { demo: true },
      state: "processed",
      attempts: 1,
      processedAt: at(-1),
    },
  });

  const [
    channelCount,
    listingCount,
    orderCount,
    shipmentCount,
    openIncidentCount,
    returnCount,
    manifestCount,
    packageCount,
    waveCount,
    incidentCount,
  ] = await Promise.all([
    db.marketplaceChannel.count({
      where: {
        environment: "sandbox",
        name: { in: channelDefinitions.map((item) => item.name) },
      },
    }),
    db.marketplaceListing.count({
      where: { externalId: { startsWith: "DEMO-" } },
    }),
    db.marketplaceOrder.count({
      where: { externalId: { in: scenarios.map((item) => item.key) } },
    }),
    db.shipment.count({ where: { number: { startsWith: "EXP-DEMO-" } } }),
    db.shipment.count({
      where: {
        number: { startsWith: "EXP-DEMO-" },
        exceptionStatus: "open",
      },
    }),
    db.orderReturn.count({
      where: { description: { startsWith: "Logística reversa demonstrativa" } },
    }),
    db.shipment.count({
      where: {
        number: { startsWith: "EXP-DEMO-" },
        manifestNumber: { not: null },
      },
    }),
    db.shipmentPackage.count({
      where: { shipment: { number: { startsWith: "EXP-DEMO-" } } },
    }),
    db.pickingWave.count({ where: { number: { startsWith: "OND-DEMO-" } } }),
    db.shipmentIncident.count({
      where: { shipment: { number: { startsWith: "EXP-DEMO-" } } },
    }),
  ]);
  console.log(
    JSON.stringify({
      channels: channelCount,
      listings: listingCount,
      orders: orderCount,
      shipments: shipmentCount,
      openIncidents: openIncidentCount,
      returns: returnCount,
      manifested: manifestCount,
      packages: packageCount,
      waves: waveCount,
      incidents: incidentCount,
    }),
  );
}

main().finally(() => db.$disconnect());
