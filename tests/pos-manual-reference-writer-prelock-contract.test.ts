import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const root = fileURLToPath(new URL("..", import.meta.url));
const read = (path: string) => readFileSync(join(root, path), "utf8");
const helper = read("lib/erp/pos-manual-payment-reference-prelock.ts");
const manualRoute = read("app/api/erp/pdv/manual-payments/route.ts");
const checkout = read("app/api/erp/pdv/route.ts");

test("manual-reference usa UUID reservado e namespaces ASCII antes dos business locks", () => {
  assert.ok(manualRoute.indexOf("const manualId = randomUUID()") < manualRoute.indexOf("db.$transaction(async (tx)"));
  assert.match(helper, /function unique\(values:[\s\S]*\.sort\(\)/);
  assert.doesNotMatch(helper, /localeCompare/);
  for (const namespace of [
    "t2-payment-plan:aggregate:",
    "t2-payment-plan:draft:",
    "pos-held-sale-items:v1:held-sale:",
    "pos-order-claim:v1:claim:",
    "pos-order-claim:v1:order:",
    "pos-order-claim:v1:artifacts:",
    "pos-manual-payment-reference:v1:reference:",
    "pos-manual-payment-reference:v1:operation:",
    "pos-manual-payment-reference:v1:slot:",
    "pos-manual-payment-reference:v1:sale-payment:",
  ]) assert.match(helper, new RegExp(namespace.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.ok(helper.indexOf("posManualReferenceAdvisoryNamespaces") < helper.indexOf("lockNumbers(tx, \"cash_register_sessions\""));
});

test("prelock segue a ordem canônica e relê bindings completos", () => {
  const checkpoints = [
    'lockNumbers(tx, "cash_register_sessions"',
    'lockStrings(tx, "pos_terminals"',
    'lockPairs(tx, "branch_user_accesses"',
    'lockNumbers(tx, "sales_orders"',
    'lockStrings(tx, "pos_order_claims"',
    'lockStrings(tx, "pos_held_sales"',
    'lockForeignStrings(tx, "pos_held_sale_items"',
    'lockStrings(tx, "pos_connectors"',
    'lockStrings(tx, "integration_credentials"',
    'lockStrings(tx, "pos_payment_plans"',
    "lockPlanSlots(tx, slots)",
    'lockStrings(tx, "pos_approvals"',
    'lockStrings(tx, "pos_manual_payment_references"',
    'lockStrings(tx, "pos_sale_payments"',
  ];
  for (let index = 1; index < checkpoints.length; index += 1) {
    assert.ok(helper.indexOf(checkpoints[index - 1]!) < helper.indexOf(checkpoints[index]!), `${checkpoints[index - 1]} antes de ${checkpoints[index]}`);
  }
  assert.match(helper, /canonical\(planLocators\)[\s\S]*canonical\(claimLocators\)[\s\S]*canonical\(referenceLocators\)/);
  assert.match(helper, /plan\.orderClaimId !== plan\.saleDraftId/);
  assert.match(helper, /const planSelect = \{ id: true, version: true/);
});

test("create, revoke e consumo do checkout compartilham o prelock", () => {
  assert.equal((manualRoute.match(/prelockPosManualReferenceWrite\(tx/g) ?? []).length, 2);
  assert.match(manualRoute, /reservedReferenceIds: \[manualId\]/);
  assert.match(manualRoute, /slotCoordinates: \[\{ planId: paymentPlanLocator\.id, paymentIndex: normalized\.paymentIndex \}\]/);
  assert.match(manualRoute, /referenceIds: \[input\.id\]/);
  assert.match(checkout, /manualReferenceOperationKeys[\s\S]*prelockPosManualReferenceWrite\(tx/);
  assert.match(checkout, /paymentPlanLocator\.saleDraftId !== orderClaimId/);
  const prelockAt = checkout.indexOf("prelockPosManualReferenceWrite(tx");
  const referenceDmlAt = checkout.indexOf("tx.posManualPaymentReference.updateMany", prelockAt);
  assert.ok(prelockAt >= 0 && referenceDmlAt > prelockAt);
});

test("create, revoke e consume usam versão relida e sentinels server-owned", () => {
  assert.match(manualRoute, /lockedPlan = prelocked\.plans\.find[\s\S]*action: "create"[\s\S]*expectedVersion: lockedPlan\.version[\s\S]*posManualPaymentReference\.create/);
  assert.match(manualRoute, /action: "revoke"[\s\S]*expectedVersion: lockedPlan\.version[\s\S]*revokedAt: null[\s\S]*posManualPaymentReference\.updateMany/);
  assert.match(manualRoute, /current\.idempotencyKey === input\.idempotencyKey/);
  assert.match(checkout, /action: "consume"[\s\S]*expectedVersion: lockedPlan\.version[\s\S]*consumedAt: null[\s\S]*posManualPaymentReference\.updateMany/);
  assert.match(checkout, /reservedSalePaymentIds: manualReferenceSalePaymentIds/);
  const consumePrepareAt = checkout.indexOf('action: "consume"');
  const saleCreateAt = checkout.indexOf("const created = await tx.sale.create");
  const consumeUpdateAt = checkout.indexOf("tx.posManualPaymentReference.updateMany", saleCreateAt);
  assert.ok(consumePrepareAt >= 0 && consumePrepareAt < saleCreateAt, "capability consume deve preceder sale.create");
  assert.ok(saleCreateAt < consumeUpdateAt, "update da referência deve ocorrer depois da venda causal");
  assert.equal(checkout.slice(saleCreateAt, consumeUpdateAt).includes('action: "consume"'), false, "não deve haver segunda prepare após sale.create");
  assert.match(checkout.slice(consumePrepareAt, saleCreateAt), /consumedSalePaymentId: paymentRowIds\[paymentIndex\]!/);
  assert.match(checkout, /manualReferenceConsumeOperationKey[\s\S]*createHash\("sha256"\)/);
});
