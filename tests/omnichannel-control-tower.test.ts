import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  channelInput,
  incidentInput,
  incidentResolutionInput,
  marketplaceOrderStateInput,
  reverseLogisticsInput,
  reverseLogisticsStateInput,
  returnInspectionInput,
  shipmentCancellationInput,
  shipmentDeliveryInput,
  shipmentInput,
  shipmentPackingInput,
  shipmentPickingInput,
  shipmentTrackingInput,
  shippingManifestInput,
} from "../lib/erp/omnichannel-input";
import {
  assertOmnichannelMutationRequest,
  OmnichannelHttpError,
  readOmnichannelJson,
} from "../lib/erp/omnichannel-http";

const read = (path: string) => readFileSync(path, "utf8");

test("políticas de canal aceitam provedores e limites operacionais", () => {
  assert.deepEqual(
    channelInput({
      name: "Loja Shopify",
      provider: "shopify",
      environment: "sandbox",
      autoImport: true,
      stockBuffer: 3,
      priceAdjustment: 12.5,
      syncInterval: 10,
    }),
    {
      name: "Loja Shopify",
      provider: "shopify",
      environment: "sandbox",
      autoImport: true,
      stockBuffer: 3,
      priceAdjustment: 12.5,
      syncInterval: 10,
    },
  );
  assert.throws(
    () =>
      channelInput({ name: "Loja", provider: "shopify", priceAdjustment: 501 }),
    /intervalo/,
  );
  assert.throws(
    () => channelInput({ name: "Loja", provider: "shopify", syncInterval: 0 }),
    /inteiro/,
  );
});

test("expedição valida SLA, cubagem, picking e comprovante", () => {
  const created = shipmentInput({
    salesOrderId: 1,
    warehouseId: 2,
    priority: "urgent",
    packageCount: 2,
    weightKg: 3.4,
    dispatchDeadlineAt: "2026-09-02T18:30:00.000Z",
    items: [
      { orderItemId: 10, quantity: 2 },
      { orderItemId: 11, quantity: 0.5 },
    ],
  });
  assert.equal(created.priority, "urgent");
  assert.equal(created.packageCount, 2);
  assert.deepEqual(created.items, [
    { orderItemId: 10, quantity: 2 },
    { orderItemId: 11, quantity: 0.5 },
  ]);
  assert.throws(
    () =>
      shipmentInput({
        salesOrderId: 1,
        warehouseId: 2,
        items: [
          { orderItemId: 10, quantity: 1 },
          { orderItemId: 10, quantity: 1 },
        ],
      }),
    /Item repetido/,
  );
  assert.equal(
    created.dispatchDeadlineAt?.toISOString(),
    "2026-09-02T18:30:00.000Z",
  );
  assert.equal(
    shipmentPackingInput({
      shipmentId: 3,
      packageCount: 1,
      weightKg: 1.2,
      lengthCm: 30,
      widthCm: 20,
      heightCm: 10,
    }).lengthCm,
    30,
  );
  assert.deepEqual(
    shipmentPickingInput({
      shipmentId: 4,
      items: [{ itemId: 8, pickedQuantity: 2 }],
    }).items,
    [
      {
        itemId: 8,
        pickedQuantity: 2,
        shortQuantity: 0,
        location: null,
        allocations: [],
      },
    ],
  );
  const packed = shipmentPackingInput({
    shipmentId: 3,
    packageCount: 2,
    weightKg: 3,
    lengthCm: 30,
    widthCm: 20,
    heightCm: 10,
    packages: [
      {
        sequence: 1,
        weightKg: 1,
        lengthCm: 20,
        widthCm: 10,
        heightCm: 8,
        items: [{ shipmentItemId: 10, quantity: 1 }],
      },
      {
        sequence: 2,
        weightKg: 2,
        lengthCm: 30,
        widthCm: 20,
        heightCm: 10,
        items: [{ shipmentItemId: 10, quantity: 2 }],
      },
    ],
  });
  assert.equal(packed.packages.length, 2);
  assert.equal(
    shipmentDeliveryInput({
      shipmentId: 5,
      recipient: "Maria Souza",
      proofUrl: "https://example.com/proof",
    }).proofUrl,
    "https://example.com/proof",
  );
  assert.throws(
    () =>
      shipmentDeliveryInput({
        shipmentId: 5,
        recipient: "Maria Souza",
        proofUrl: "javascript:alert(1)",
      }),
    /URL/,
  );
  assert.throws(
    () => shipmentPackingInput({ shipmentId: 3, packageCount: 1 }),
    /peso, comprimento, largura e altura/,
  );
});

test("exceções, rastreio, romaneio e reversa exigem dados completos", () => {
  assert.equal(
    incidentInput({
      shipmentId: 1,
      category: "carrier",
      owner: "Equipe logística",
      dueAt: "2026-09-03T18:00:00.000Z",
      description: "Transportadora não realizou a coleta.",
    }).category,
    "carrier",
  );
  assert.equal(
    incidentResolutionInput({
      shipmentId: 1,
      resolution: "Coleta reagendada.",
    }).resolution,
    "Coleta reagendada.",
  );
  assert.equal(
    shipmentTrackingInput({
      shipmentId: 1,
      status: "in_transit",
      occurredAt: "2026-09-03T19:00:00.000Z",
      description: "Recebido na unidade de tratamento.",
    }).status,
    "in_transit",
  );
  assert.equal(
    returnInspectionInput({
      returnId: 7,
      warehouseId: 2,
      items: [
        {
          returnItemId: 9,
          receivedQuantity: 1,
          condition: "opened",
          disposition: "quarantine",
        },
      ],
    }).items[0]?.disposition,
    "quarantine",
  );
  assert.deepEqual(
    shippingManifestInput({ shipmentIds: [3, 3, 4], carrier: "Correios" })
      .shipmentIds,
    [3, 4],
  );
  assert.equal(
    reverseLogisticsInput({
      shipmentId: 2,
      reason: "defect",
      description: "Produto com defeito relatado pelo cliente.",
      customerEmail: "CLIENTE@EXAMPLE.COM",
    }).customerEmail,
    "cliente@example.com",
  );
  assert.equal(
    reverseLogisticsStateInput({
      returnId: 7,
      status: "in_transit",
      trackingCode: "REV123BR",
    }).status,
    "in_transit",
  );
  assert.equal(
    shipmentCancellationInput({
      shipmentId: 2,
      confirmation: "CANCELAR",
      reason: "Pedido cancelado antes da coleta.",
    }).confirmation,
    "CANCELAR",
  );
  assert.equal(
    marketplaceOrderStateInput({
      orderId: 8,
      paymentStatus: "paid",
      riskStatus: "approved",
    }).riskStatus,
    "approved",
  );
});

test("HTTP omnicanal limita JSON e exige content-type seguro", async () => {
  assert.throws(
    () =>
      assertOmnichannelMutationRequest(
        new Request("https://erp.example/api", { method: "POST" }),
      ),
    (error) => error instanceof OmnichannelHttpError && error.status === 415,
  );
  const parsed = await readOmnichannelJson(
    new Request("https://erp.example/api", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action: "tracking.update" }),
    }),
    128,
  );
  assert.equal(parsed.action, "tracking.update");
  await assert.rejects(
    () =>
      readOmnichannelJson(
        new Request("https://erp.example/api", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ value: "x".repeat(200) }),
        }),
        64,
      ),
    (error) => error instanceof OmnichannelHttpError && error.status === 413,
  );
});

test("torres de controle e APIs mantêm recursos críticos no contrato", () => {
  const component = read("components/erp/omnichannel-control-tower.tsx");
  const marketplaceRoute = read("app/api/erp/marketplaces/route.ts");
  const logisticsRoute = read("app/api/erp/logistics/route.ts");
  const migration = read(
    "prisma/tenant/migrations/20260902170000_omnichannel_operational_hardening/migration.sql",
  );
  const seed = read("scripts/seed-demo-omnichannel.ts");
  const schema = read("prisma/tenant/schema.prisma");
  const splitMigration = read(
    "prisma/tenant/migrations/20260902230000_split_shipment_fulfillment/migration.sql",
  );
  for (const marker of [
    "Receita líquida estimada",
    "Cobertura do catálogo",
    "Exceções",
    "Criar onda",
    "SLA e exceções",
    "Comprovante de entrega",
    "Logística reversa",
    "Gerar romaneio",
    "Atualizar rastreio",
    "Exportar CSV",
    "Desempenho e custos",
    "Inspecionar devolução",
    "Gerar etiquetas",
    "Quantidades parciais permanecem disponíveis",
  ])
    assert.match(component, new RegExp(marker));
  for (const action of [
    "channel.update",
    "listing.toggle",
    "webhook.retry",
    "order.update",
  ])
    assert.match(marketplaceRoute, new RegExp(action.replace(".", "\\.")));
  for (const action of [
    "pick.wave",
    "pick.items",
    "priority",
    "cancel",
    "reopen",
    "manifest.create",
    "tracking.update",
    "incident.resolve",
    "return.create",
    "return.update",
    "return.inspect",
    "freight.quote",
    "label.generate",
    "manifest.update",
  ])
    assert.match(
      logisticsRoute,
      new RegExp(`body\\.action === \\"${action.replace(".", "\\.")}\\"`),
    );
  assert.match(logisticsRoute, /isolationLevel: "Serializable"/);
  assert.match(migration, /shipments_exception_status_due_idx/);
  assert.match(migration, /order_returns_reverse_status_idx/);
  assert.match(logisticsRoute, /omnichannelNoStoreHeaders/);
  assert.match(logisticsRoute, /idempotency-key/);
  assert.match(logisticsRoute, /logisticsCsv/);
  assert.match(logisticsRoute, /assertLogisticsScope/);
  assert.match(
    logisticsRoute,
    /status:\s*\{\s*in:\s*\["approved", "partially_shipped"\]/,
  );
  assert.match(logisticsRoute, /orderFullyShipped/);
  assert.match(schema, /shipments\s+Shipment\[\]/);
  assert.match(
    splitMigration,
    /DROP INDEX IF EXISTS "shipments_sales_order_id_key"/,
  );
  assert.match(
    splitMigration,
    /DROP CONSTRAINT IF EXISTS "shipments_sales_order_id_key"/,
  );
  assert.match(splitMigration, /shipments_sales_order_status_idx/);
  const executionMigration = read(
    "prisma/tenant/migrations/20260902190000_logistics_execution_suite/migration.sql",
  );
  for (const table of [
    "shipment_packages",
    "picking_waves",
    "shipping_manifests",
    "shipment_incidents",
    "logistics_operation_receipts",
  ])
    assert.match(executionMigration, new RegExp(table));
  assert.match(marketplaceRoute, /readOmnichannelJson/);
  assert.match(marketplaceRoute, /!channel\.credentialId/);
  assert.match(marketplaceRoute, /shipByAt: \{ lt: new Date\(\) \}/);
  assert.match(seed, /nalven_t_demo_runtime/);
  assert.match(seed, /createdAt: shipmentCreatedAt/);
  assert.doesNotMatch(
    seed,
    /TRUNCATE|DROP TABLE|shipment\.deleteMany|salesOrder\.deleteMany/,
  );
  assert.match(seed, /shipmentPackage\.upsert/);
  assert.match(seed, /pickingWave\.upsert/);
  assert.match(seed, /shippingManifest\.upsert/);
});
