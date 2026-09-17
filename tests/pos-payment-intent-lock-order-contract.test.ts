import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const persistence = readFileSync(new URL("../lib/erp/pos-payment-persistence.ts", import.meta.url), "utf8");

test("intent existente segue advisory e a ordem global até a própria intent", () => {
  const body = slice("export async function lockPosPaymentIntentCanonical", "type PaymentPlanIntentLocator");
  assertOrder(body, [
    "lockIntentGraphNamespaces(tx",
    "paymentPlanIntentLocator(tx",
    "posOrderClaim.findUnique",
    "heldSaleItemLocatorIds(tx",
    "lockIntentPlanRoots(tx",
    'lockExactStringRoot(tx, "pos_connectors"',
    'lockExactStringRoot(tx, "integration_credentials"',
    'lockExactStringRoot(tx, "pos_payment_plans"',
    "lockIntent(tx, intentId)",
  ]);
  assert.match(body, /intent\.paymentPlanId !== locator\.paymentPlanId/);
  assert.match(body, /assertPaymentPlanIntentLocatorUnchanged\(planLocator, plan\)/);
  assert.match(body, /assertExactNumberSet\(itemIds, lockedItemIds/);
  assert.match(body, /claim\.salesOrderId !== claimLocator\?\.salesOrderId/);
  assert.match(body, /connector\.id !== locator\.connectorId/);
  assert.match(body, /credential\.id !== locator\.credentialRef/);
  assert.match(body, /paymentPlanSharedNamespaces\(planLocator, claimLocator\?\.salesOrderId \?\? null\)/);
  assert.doesNotMatch(body, /pos-order-claim:v1:artifacts:\$\{locator\.saleDraftId\}/);
});

test("roots do plano seguem sessão, terminal, acesso, pedido, claim, held e itens", () => {
  const body = slice("async function lockIntentPlanRoots", "async function lockExactNumberRoot");
  assertOrder(body, [
    '"cash_register_sessions"',
    '"pos_terminals"',
    "lockPaymentAccessRows(tx",
    '"sales_orders"',
    '"pos_order_claims"',
    '"pos_held_sales"',
    'FROM "pos_held_sale_items"',
  ]);
  assert.match(body, /rows\.length !== itemIds\.length/);
});

test("create fixa IDs antes do retry e trava connector/credential antes do plano", () => {
  const create = slice("export async function createPosPaymentIntent", "export async function retryPosPaymentIntent");
  const prelock = slice("async function lockPosPaymentIntentCreateCanonical", "/**\n * Locks the immutable payment aggregate");
  assertBefore(create, /const intentId = randomUUID\(\), attemptId = randomUUID\(\)/, /serializableRetry\(db/);
  assertBefore(create, /lockPosPaymentIntentCreateCanonical\(tx/, /posPaymentIntent\.create\(/);
  assert.doesNotMatch(persistence, /lockedAuthoritativePosPaymentPlanSlot/);
  assertOrder(prelock, [
    "paymentPlanIntentLocator(tx",
    "posPaymentPlanSlot.findUnique",
    "posOrderClaim.findUnique",
    "heldSaleItemLocatorIds(tx",
    "lockIntentGraphNamespaces(tx",
    "lockIntentPlanRoots(tx",
    'lockExactStringRoot(tx, "pos_connectors"',
    'lockExactStringRoot(tx, "integration_credentials"',
    'lockExactStringRoot(tx, "pos_payment_plans"',
  ]);
  assert.match(prelock, /slot\.connectorId !== slotLocator\.connectorId/);
  assert.match(prelock, /connector\.credentialRef !== slot\.credentialRef/);
  assert.match(prelock, /credential\.providerId !== connector\.provider/);
  assert.match(prelock, /paymentPlanSharedNamespaces\(planLocator, claimLocator\?\.salesOrderId \?\? null\)/);
});

test("writers de intent compartilham namespaces de plano, draft, held e claim em ordem C", () => {
  const namespaces = slice("function paymentPlanSharedNamespaces", "async function heldSaleItemLocatorIds");
  assertOrder(namespaces, [
    "t2-payment-plan:aggregate:",
    "t2-payment-plan:draft:",
    "pos-held-sale-items:v1:held-sale:",
    "pos-order-claim:v1:claim:",
    "pos-order-claim:v1:artifacts:",
    "pos-order-claim:v1:order:",
  ]);
  assert.match(persistence, /\[\.\.\.new Set\(namespaces\)\]\.sort\(\)/);
  const consume = slice("export async function consumeCapturedPosPaymentIntent", "export async function acceptPosPaymentCallback");
  assertOrder(consume, ["paymentPlanIntentLocator(tx", "posOrderClaim.findUnique", "prelockPosSalePaymentWriteGraph", "lockPosPaymentIntentCanonical(tx"]);
  assert.doesNotMatch(consume, /pos-order-claim:v1:artifacts:\$\{input\.saleDraftId\}/);
});

function slice(start: string, end: string) {
  const first = persistence.indexOf(start);
  const last = persistence.indexOf(end, first + start.length);
  assert.notEqual(first, -1, `${start} ausente`);
  assert.notEqual(last, -1, `${end} ausente`);
  return persistence.slice(first, last);
}

function assertBefore(value: string, first: RegExp, second: RegExp) {
  const firstIndex = value.search(first), secondIndex = value.search(second);
  assert.notEqual(firstIndex, -1, `${first} ausente`);
  assert.notEqual(secondIndex, -1, `${second} ausente`);
  assert.ok(firstIndex < secondIndex, `${first} deve preceder ${second}`);
}

function assertOrder(value: string, fragments: readonly string[]) {
  let previous = -1;
  for (const fragment of fragments) {
    const index = value.indexOf(fragment, previous + 1);
    assert.notEqual(index, -1, `${fragment} ausente ou fora de ordem`);
    previous = index;
  }
}
