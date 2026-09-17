import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  productionOrderInput,
  productionOrderMetadataInput,
} from "../lib/erp/production-input";

const client = readFileSync("app/erp/erp-client.tsx", "utf8");
const productionUi =
  readFileSync("components/erp/production-workspace.tsx", "utf8") +
  readFileSync("components/erp/production-forms.tsx", "utf8") +
  readFileSync("components/erp/production-types.ts", "utf8");
const productionService = readFileSync("lib/erp/production-service.ts", "utf8");
const productionStock = readFileSync("lib/erp/production-stock.ts", "utf8");
const frame = readFileSync("components/erp/operations-suite-frame.tsx", "utf8");
const frameCss = readFileSync(
  "components/erp/operations-suite-frame.module.css",
  "utf8",
);
const erpCss = readFileSync("app/erp/erp.css", "utf8");
const schema = readFileSync("prisma/tenant/schema.prisma", "utf8");
const hardening = readFileSync(
  "prisma/tenant/migrations/20260902060000_commercial_supply_hardening/migration.sql",
  "utf8",
);
const quotations = readFileSync(
  "prisma/tenant/migrations/20260902063000_purchase_quotations/migration.sql",
  "utf8",
);
const roundTwo = readFileSync(
  "prisma/tenant/migrations/20260902070000_supply_operations_round_two/migration.sql",
  "utf8",
);
const productionWorkflow = readFileSync(
  "prisma/tenant/migrations/20260902180000_production_workflow/migration.sql",
  "utf8",
);
const seed = readFileSync("prisma/tenant/seed.ts", "utf8");
const routes = [
  "crm",
  "contracts",
  "service-orders",
  "purchases",
  "inventory",
  "production",
].map((name) =>
  readFileSync(
    `app/api/erp/${name === "production" ? "production/operations" : name}/route.ts`,
    "utf8",
  ),
);

test("sete módulos compartilham layout responsivo sem duplicar o menu global", () => {
  for (const moduleKey of [
    "orders",
    "crm",
    "contracts",
    "service-orders",
    "purchases",
    "inventory",
    "production",
  ])
    assert.match(
      client,
      new RegExp(`<OperationsSuiteFrame module="${moduleKey}">`),
    );
  assert.doesNotMatch(frame, /className=\{styles\.switcher\}/);
  assert.doesNotMatch(
    frame,
    /aria-label="Módulos comerciais e de suprimentos"/,
  );
  assert.match(
    client,
    /aria-current=\{page === item\.id \? "page" : undefined\}/,
  );
  assert.match(client, /SNAPSHOT_CACHE_TTL/);
  assert.match(client, /router\.prefetch\(erpRoute\(id\)\)/);
  assert.match(frameCss, /@media\s*\(max-width:\s*390px\)/);
});

test("interfaces expõem os fluxos operacionais antes ausentes", () => {
  for (const label of [
    "Nova atividade",
    "Registrar reajuste",
    "Atualizar atendimento",
    "Nova cotação",
    "Registrar proposta",
    "Adjudicar proposta",
    "Posição consolidada",
    "SuiteListFilter",
  ])
    assert.match(client, new RegExp(label));
  assert.match(client, /OrderManagement/);
  assert.match(client, /function Inventory\(/);
});

test("APIs usam cache privado, paginação e erros seguros", () => {
  for (const route of routes) {
    assert.match(route, /force-dynamic/);
    assert.match(route, /cache-control.*no-store/);
    assert.doesNotMatch(route, /error instanceof Error \? error\.message/);
  }
  for (const route of routes.slice(0, 4)) assert.match(route, /pagination/);
});

test("transições críticas são serializáveis, bloqueadas e auditadas", () => {
  for (const route of routes.slice(0, 4)) {
    assert.match(route, /Serializable/);
    assert.match(route, /FOR UPDATE/);
    assert.match(route, /tenantAuditEvent/);
  }
  for (const route of routes) assert.doesNotMatch(route, /Date\.now\(\)/);
  assert.match(hardening, /crm_stage_history/);
  assert.match(hardening, /service_order_history/);
  assert.match(hardening, /warehouse_ledger_entries/);
  assert.match(hardening, /goods_receipts/);
});

test("cotações possuem modelo relacional completo e adjudicação gera pedido", () => {
  for (const model of [
    "PurchaseQuotation",
    "PurchaseQuotationItem",
    "PurchaseQuotationOffer",
    "PurchaseQuotationOfferItem",
  ])
    assert.match(schema, new RegExp(`model ${model}`));
  assert.match(quotations, /purchase_quotation_offer_items/);
  assert.match(routes[3], /body\.action === "quotation\.select"/);
  assert.match(routes[3], /purchaseOrder\.create/);
  assert.match(routes[3], /purchase_quotation\.awarded/);
  assert.match(roundTwo, /purchase_order_id/);
  assert.match(roundTwo, /subtotal/);
});

test("inventário oferece posição consolidada, contagem cega e razão paginada", () => {
  assert.match(schema, /blind\s+Boolean/);
  assert.match(routes[4], /positions/);
  assert.match(routes[4], /ledgerPage/);
  assert.match(routes[4], /FOR UPDATE/);
  assert.match(routes[4], /body\.action === "cancel_count"/);
  assert.match(routes[4], /inventory_count\.cancelled/);
  assert.match(roundTwo, /one_draft_per_warehouse/);
  for (const label of [
    "Produtos controlados",
    "Produtos com reserva",
    "Abaixo do mínimo",
    "contagem cega",
    "Saldo do sistema oculto",
  ])
    assert.match(client, new RegExp(label));
  for (const contract of [
    "inventory-mobile-view",
    "inventory-position-cards",
    "inventory-ledger-cards",
    "inventory-count-progress",
    "availableBalances",
    "completedItems",
    "ledgerSearch",
    "AbortController",
  ])
    assert.match(client, new RegExp(contract));
  assert.match(client, /role="tabpanel"/);
  assert.match(erpCss, /inventory-position-cards/);
  assert.match(erpCss, /@media\(max-width:480px\)/);
});

test("produção usa a fronteira de estoque rastreado, apontamento e qualidade", () => {
  assert.match(client, /<ProductionWorkspace/);
  assert.match(
    readFileSync("app/api/erp/production/route.ts", "utf8"),
    /export \{ GET, POST \} from "\.\/operations\/route"/,
  );
  assert.match(routes[5], /executeProductionCommand/);
  assert.match(productionStock, /reserveProductionMaterials/);
  assert.match(productionStock, /selectPosFefo/);
  assert.match(productionStock, /applyPosCommonStockChange/);
  assert.match(productionService, /quarantineProductionOutput/);
  assert.match(productionService, /decideProductionOutput/);
  assert.match(productionService, /Serializable/);
  assert.match(productionService, /FOR UPDATE/);
  for (const action of ["order.update", "order.transition", "order.reopen"])
    assert.match(productionService, new RegExp(action.replace(".", "\\.")));
  for (const marker of [
    "Kanban de produção",
    "Etiquetas",
    "Responsável",
    "Em produção",
    "Pausada",
    "Duplicar ficha",
  ])
    assert.match(productionUi, new RegExp(marker));
  assert.match(productionWorkflow, /production_orders_status_check/);
  assert.match(productionWorkflow, /status_priority_due_idx/);
});

test("ordens de produção validam planejamento, etiquetas e prioridade", () => {
  const order = productionOrderInput({
    bomId: 1,
    warehouseId: 2,
    plannedQuantity: 30,
    priority: "urgent",
    tags: "Lote piloto, cliente especial, Lote piloto",
    assignedTo: "Equipe A",
    dueAt: "2026-09-15",
  });
  assert.equal(order.priority, "urgent");
  assert.deepEqual(order.tags, ["Lote piloto", "cliente especial"]);
  assert.equal(order.dueAt?.toISOString(), "2026-09-15T00:00:00.000Z");
  assert.equal(
    productionOrderMetadataInput({
      orderId: 3,
      priority: "high",
      tags: ["retrabalho"],
    }).assignedTo,
    null,
  );
  assert.throws(
    () =>
      productionOrderInput({
        bomId: 1,
        warehouseId: 2,
        plannedQuantity: 1,
        tags: Array.from({ length: 13 }, (_, index) => `tag-${index}`),
      }),
    /12 etiquetas/,
  );
});

test("seed fornece cenários variados e idempotentes de suprimentos", () => {
  for (const reference of [
    "COT-DEMO-0003",
    "PC-DEMO-0004",
    "TRF-DEMO-0001",
    "INV-DEMO-0002",
    "OP-DEMO-0005",
  ])
    assert.match(seed, new RegExp(reference));
  assert.match(seed, /upsert/);
  assert.match(seed, /findUnique/);
});

test("tipografia contextual evita microtexto nas telas de suprimentos", () => {
  assert.match(frameCss, /font-size: 14px/);
  assert.match(frameCss, /min-height: 44px/);
  assert.doesNotMatch(frameCss, /font-size:\s*[789]px/);
});
