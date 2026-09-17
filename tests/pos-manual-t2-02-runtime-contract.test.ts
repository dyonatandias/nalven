import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  POS_MANUAL_T2_ALLOWED_HASH_DOMAINS,
  canonicalizePosManualT2,
  hashPosManualT2Domain,
} from "../lib/erp/pos-manual-t2-canonical";

const schema = readFileSync("prisma/tenant/schema.prisma", "utf8");
const runtime = readFileSync("lib/erp/pos-manual-t2-reserve.ts", "utf8");
const reserveDb = readFileSync("db/tenant-manual-t2-reserve.ts", "utf8");
const pdvRoute = readFileSync("app/api/erp/pdv/route.ts", "utf8");
const stock = readFileSync("lib/erp/pos-common-stock.ts", "utf8");
const boundary = readFileSync("lib/erp/pos-t2-boundary.ts", "utf8");
const catalog = readFileSync("lib/erp/product-catalog.ts", "utf8");
const valueAdmin = readFileSync("app/api/erp/pdv/value-accounts/route.ts", "utf8");
const accounting = readFileSync("lib/erp/pos-accounting-subledger.ts", "utf8");
const webhook = readFileSync("lib/integrations/webhooks.ts", "utf8");
const fiscalReport = readFileSync("app/api/erp/reports/fiscal/route.ts", "utf8");

test("Prisma mapeia somente o catálogo T2-02 congelado desta onda", () => {
  const models = [
    ["PosManualApplicationStockReservation", "pos_manual_application_stock_reservations"],
    ["PosManualApplicationStockReservationEvent", "pos_manual_application_stock_reservation_events"],
    ["PosManualApplicationPromotionReservation", "pos_manual_application_promotion_reservations"],
    ["PosManualApplicationPromotionReservationEvent", "pos_manual_application_promotion_reservation_events"],
    ["PosManualApplicationReserveAssertion", "pos_manual_application_reserve_assertions"],
    ["PosManualApplicationReleaseAssertion", "pos_manual_application_release_assertions"],
    ["PosManualApplicationSweepBatch", "pos_manual_application_sweep_batches"],
    ["PosManualApplicationSweepReceipt", "pos_manual_application_sweep_receipts"],
  ] as const;
  for (const [model, table] of models) {
    const body = schema.match(new RegExp(`model ${model} \\{[\\s\\S]*?\\n\\}`, "u"))?.[0] ?? "";
    assert.notEqual(body, "", `${model} ausente`);
    assert.match(body, new RegExp(`@@map\\("${table}"\\)`));
  }
  for (const field of ["posRevision", "posConfigHash", "revision", "configHash", "logicalId", "supersededAt"]) assert.match(schema, new RegExp(`\\b${field}\\b`));
  assert.doesNotMatch(schema, /model PosManualFiscalEnvelope|model PosFiscalNumberAllocation/u);
  assert.match(schema, /model PosManualT2BoundaryOperation[\s\S]*?@@map\("pos_manual_t2_boundary_operations"\)/u);
});

test("cinco boundary wrappers recalculam requests e writers reais não fazem boundary DML legado", () => {
  for (const [abi, domain] of [
    ["pos_t2_catalog_boundary_v1", "t2-catalog-boundary-request-v1"],
    ["pos_t2_value_program_boundary_v1", "t2-value-program-boundary-request-v1"],
    ["pos_t2_accounting_period_put_v1", "t2-accounting-period-put-request-v1"],
    ["pos_t2_accounting_period_close_v1", "t2-accounting-period-boundary-request-v1"],
    ["pos_t2_webhook_boundary_v1", "t2-webhook-boundary-request-v1"],
  ]) {
    assert.match(boundary, new RegExp(`SELECT public\\.${abi}\\(`, "u"));
    assert.match(boundary, new RegExp(`hashPosManualT2Domain\\(\"${domain}\"`, "u"));
  }
  assert.match(catalog, /preparePosT2CatalogBoundary/);
  assert.match(fiscalReport, /field === "gtin"[\s\S]*preparePosT2CatalogBoundary/u);
  assert.match(fiscalReport, /assertTenantPermission\(organization\.id, "products\.write"\)/u);
  assert.doesNotMatch(catalog, /productVariation\.deleteMany\(\{ where: \{ productId \} \}\)/u);
  assert.match(valueAdmin, /writePosT2ValueProgramBoundary/);
  assert.doesNotMatch(valueAdmin, /posValueProgram\.(?:create|updateMany)/u);
  assert.match(accounting, /closePosT2AccountingPeriodBoundary/);
  assert.match(accounting, /putPosT2AccountingPeriodBoundary/);
  assert.doesNotMatch(accounting, /posAccountingPeriod\.update\(/u);
  assert.doesNotMatch(accounting, /posAccountingPeriod\.create\(/u);
  assert.match(webhook, /writePosT2WebhookBoundary/);
  assert.doesNotMatch(webhook, /data: \{ status: "paused" \}/u);
});

test("runtime expõe reserve/status/probe exatos, sem gate/apply/sweep", () => {
  for (const signature of [
    "pos_manual_reserve_application_v1",
    "pos_manual_application_status_v1",
    "pos_manual_application_status_by_reservation_v1",
  ]) assert.match(runtime, new RegExp(`SELECT public\\.${signature}\\(`));
  assert.doesNotMatch(runtime, /pos_manual_(?:apply|claim|sweep|gate)|withEphemeralManualGate/u);
  assert.match(runtime, /default_transaction_isolation=serializable/);
  assert.match(runtime, /application_name=\$\{POS_MANUAL_T2_RESERVE_APPLICATION_NAME\}/);
  assert.match(runtime, /Deliberately one statement and no BEGIN/);
  assert.match(runtime, /connection\.release\(true\)/);
  assert.match(reserveDb, /isolated from the general Prisma pool/i);
  assert.match(reserveDb, /tenantRuntimeDatabaseConnectionString/);
});

test("estoque normal usa saldo reservado incorporado uma única vez", () => {
  assert.match(stock, /availableBefore: input\.quantity - input\.reservedQuantity/);
  assert.match(stock, /input\.quantity - input\.reservedQuantity \+ 0\.000_001/);
  assert.doesNotMatch(stock, /posManualApplicationStockReservation|pos_manual_application_stock_reservations/);
  assert.match(pdvRoute, /balance\.quantity - balance\.reservedQuantity/);
});

test("canonical T2-02 preserva vetores e limita documento a 4 MiB/string a 64 KiB", () => {
  assert.ok(POS_MANUAL_T2_ALLOWED_HASH_DOMAINS.includes("t2-reserve-request-v1"));
  assert.equal(hashPosManualT2Domain("t2-stock-multiset-v1", { reservations: [], schemaVersion: 1 }), "4d3b679caff5499d47ec8c9d24de641d783e47f576e49b28711989a18720f00e");
  assert.equal(hashPosManualT2Domain("t2-promotion-multiset-v1", { reservations: [], schemaVersion: 1 }), "2ecf821974593e457a99f0274a17885d3826f5e8cedcb5ab9567c460e940f0d4");
  assert.throws(() => canonicalizePosManualT2("x".repeat(65_537)), /STRING_SIZE_EXCEEDED/);
  assert.throws(() => canonicalizePosManualT2(Array.from({ length: 65 }, () => "x".repeat(65_000))), /SIZE_EXCEEDED/);
});
