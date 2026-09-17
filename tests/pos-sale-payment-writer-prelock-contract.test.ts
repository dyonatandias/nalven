import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const route = source("app/api/erp/pdv/route.ts");
const paymentPersistence = source("lib/erp/pos-payment-persistence.ts");
const compensationPersistence = source(
  "lib/erp/pos-payment-compensation-persistence.ts",
);
const prelock = source("lib/erp/pos-sale-payment-prelock.ts");
const capability = source("lib/erp/pos-payment-artifact-capability.ts");

test("inventário de escritores produtivos de pos_sale_payments permanece fechado", () => {
  assert.equal(
    matches(paymentPersistence, /posSalePayment\.(?:create|update|delete)\(/g),
    1,
    "materialização eletrônica",
  );
  assert.equal(
    matches(
      compensationPersistence,
      /posSalePayment\.(?:create|update|delete)\(/g,
    ),
    2,
    "refund compensatório e atualização original",
  );
  assert.equal(
    matches(route, /posSalePayment\.(?:create|update|delete)\(/g),
    4,
    "cancelamento e devolução local",
  );
  assert.equal(
    matches(route, /payments:\s*\{\s*create:\s*salePaymentCreates/g),
    1,
    "criação aninhada no commit",
  );
});

test("todo INSERT produtivo de pagamento materializa UUID explícito", () => {
  const commit = slice(
    route,
    "async function commitSale",
    "async function preparePosOrderReservations",
  );
  const consume = slice(
    paymentPersistence,
    "export async function consumeCapturedPosPaymentIntent",
    "export async function acceptPosPaymentCallback",
  );
  const cancellation = slice(
    route,
    "async function cancelSale",
    "async function createReturn",
  );
  const returns = slice(
    route,
    "async function createReturn",
    "async function restorePosKitSaleItemComponents",
  );
  const compensation = slice(
    compensationPersistence,
    "export async function applyPosPaymentCompensation",
    "export async function maintainPosPaymentCompensations",
  );

  assert.match(
    commit,
    /const paymentRowIds = paymentExecutions\.map\(\(\) => randomUUID\(\)\)/,
  );
  assert.match(commit, /id: paymentRowIds\[index\]!/);
  assert.match(commit, /paymentId: paymentRowIds\[paymentIndex\]!/);
  assert.match(
    commit,
    /nextval\(pg_get_serial_sequence\('public\.sales', 'id'\)\)::integer AS "id"/,
  );
  assert.match(
    commit,
    /tx\.sale\.create\(\{\s*data: \{\s*id: reservedSale\.id,/,
  );
  assert.match(
    consume,
    /const paymentId = input\.paymentId \?\? randomUUID\(\)/,
  );
  assert.match(consume, /posSalePayment\.create\(\{ data: \{\s*id: paymentId,/);
  assert.match(
    cancellation,
    /const refundPaymentIds = new Map\(\s*cancelPaymentLocatorIds\.map\(\(paymentId\) => \[paymentId, randomUUID\(\)\]\),?\s*\)/,
  );
  assert.match(
    cancellation,
    /const refundPaymentId = refundPaymentIds\.get\(payment\.id\)!/,
  );
  assert.match(
    returns,
    /const refundPaymentIds = new Map\(\s*returnPaymentLocatorIds\.map\(\(paymentId\) => \[paymentId, randomUUID\(\)\]\),?\s*\)/,
  );
  assert.match(
    returns,
    /const refundPaymentId = refundPaymentIds\.get\(payment\.id\)!/,
  );
  assert.match(
    compensation,
    /const refundPaymentId = randomUUID\(\);[\s\S]*serializableRetry/,
  );
  assert.match(
    compensation,
    /posSalePayment\.create\(\{ data: \{\s*id: refundPaymentId,/,
  );
});

test("os oito DML produtivos abrem a action sale_payment exata imediatamente antes da escrita", () => {
  const commit = slice(
    route,
    "async function commitSale",
    "async function preparePosOrderReservations",
  );
  const consume = slice(
    paymentPersistence,
    "export async function consumeCapturedPosPaymentIntent",
    "export async function acceptPosPaymentCallback",
  );
  const cancellation = slice(
    route,
    "async function cancelSale",
    "async function createReturn",
  );
  const returns = slice(
    route,
    "async function createReturn",
    "async function restorePosKitSaleItemComponents",
  );
  const compensation = slice(
    compensationPersistence,
    "export async function applyPosPaymentCompensation",
    "export async function maintainPosPaymentCompensations",
  );

  assertBefore(
    commit,
    /action: "create_commit"/,
    /const created = await tx\.sale\.create/,
  );
  assertBefore(
    consume,
    /action: "create_intent_consumption"/,
    /const payment = await tx\.posSalePayment\.create/,
  );
  assertBefore(
    compensation,
    /action: "insert_refund_compensation"/,
    /const refund = await tx\.posSalePayment\.create/,
  );
  assertBefore(
    compensation,
    /action: "update_refund_status"/,
    /await tx\.posSalePayment\.update/,
  );
  assertBefore(
    cancellation,
    /action: "insert_refund_cancel"/,
    /await tx\.posSalePayment\.create/,
  );
  assertBefore(
    cancellation,
    /action: "update_refund_status"/,
    /await tx\.posSalePayment\.update/,
  );
  assertBefore(
    returns,
    /action: "insert_refund_return"/,
    /await tx\.posSalePayment\.create/,
  );
  assertBefore(
    returns,
    /action: "update_refund_status"/,
    /await tx\.posSalePayment\.update/,
  );
  assert.equal(
    matches(
      `${commit}\n${consume}\n${compensation}\n${cancellation}\n${returns}`,
      /action: "update_refund_status"/g,
    ),
    3,
  );
  assert.match(commit, /expectedVersion: lockedSalePaymentPlan\.version/);
  assert.match(consume, /expectedVersion: lockedPlan\.version/);
  assert.equal(
    matches(
      `${compensation}\n${cancellation}\n${returns}`,
      /expectedVersion: -1/g,
    ),
    6,
  );
  assert.equal(
    matches(
      `${compensation}\n${cancellation}\n${returns}`,
      /action: "update_refund_status"[\s\S]*?target: posSalePaymentWriteTarget\(\{[\s\S]*?refundedAt: null/g,
    ),
    3,
    "update_refund_status sempre transporta sentinel null; o guard estampa apenas o full refund",
  );
});

test("wrapper sale_payment usa preview DB e target snake completo", () => {
  const body = slice(
    capability,
    "export async function preparePosSalePaymentWrite",
    "export type PosSalePaymentTarget",
  );
  assertOrder(body, [
    "pos_manual_t2_sale_payment_request_hash_v1",
    "pos_manual_prepare_sale_payment_write_v1",
    "preview.requestHash",
  ]);
  assert.match(body, /CAST\(\$\{target\} AS jsonb\)/);
  for (const field of [
    "sale_id",
    "connector_id",
    "original_payment_id",
    "processing_session_id",
    "payment_intent_id",
    "compensation_id",
    "payment_plan_id",
    "payment_index",
    "value_capture_entry_id",
    "value_amount_units",
    "manual_payment_case_id",
    "metadata",
    "authorized_at",
    "captured_at",
    "refunded_at",
  ]) {
    assert.match(capability, new RegExp(`\\b${field}\\b`), field);
  }
  assert.match(capability, /valueCaptureEntryId\?\.toString\(\) \?\? null/);
  assert.match(capability, /valueAmountUnits\?\.toString\(\) \?\? null/);
  assert.match(prelock, /version: true/);
  assert.match(prelock, /return \{ plans: lockedPlans,/);
});

test("pré-lock usa a ordem global sessão, terminal/acesso, pedido, claim, held, plano e pagamento", () => {
  const body = slice(
    prelock,
    "export async function prelockPosSalePaymentWriteGraph",
    "async function lockBranchAccess",
  );
  assertOrder(body, [
    '"cash_register_sessions"',
    '"pos_terminals"',
    '"tenant_user_profiles"',
    '"branches"',
    '"pos_registers"',
    "lockBranchAccess(tx, plans, input.mode)",
    "lockRegisterAccess(tx, plans, input.mode)",
    '"sales_orders"',
    '"pos_order_claims"',
    '"pos_held_sales"',
    "lockHeldSaleItems(tx",
    '"pos_connectors"',
    '"integration_providers"',
    '"integration_credentials"',
    '"pos_payment_plans"',
    "lockPlanSlots(tx",
    '"sales"',
    'FROM "pos_sale_payments"',
    'lockStringIds(tx, "pos_sale_payments"',
  ]);
  assert.match(
    prelock,
    /uniqueNumbers[\s\S]*sort\(\(left, right\) => left - right\)/,
  );
  assert.match(prelock, /uniqueStrings[\s\S]*\.sort\(\)/);
  assert.match(body, /assertPlanBindingsUnchanged\(plans, lockedPlans\)/);
  assert.match(
    body,
    /claimLocators = claimIds\.length \? await tx\.posOrderClaim\.findMany/,
  );
  assert.match(
    body,
    /assertClaimBindingsUnchanged\(plans, claimIds, claimLocators, lockedClaims\)/,
  );
  assertBefore(
    body,
    /lockNumberIds\(tx, "sales_orders"/,
    /lockStringIds\(tx, "pos_order_claims"/,
  );
  assert.match(body, /pos-sale-payment-insert:/);
  assert.match(body, /pos-sale-payment-refund-range:/);
  assert.match(body, /t2-payment-plan:aggregate:/);
  assert.match(body, /t2-payment-plan:draft:/);
  assert.match(body, /pos-held-sale-items:v1:held-sale:/);
  assert.match(body, /\.\.\.\(input\.preRootAdvisoryNamespaces \?\? \[\]\)/);
  assert.match(
    body,
    /\.\.\.\(input\.existingPaymentIds \?\? \[\]\)\.map\(\(id\) => `pos-sale-payment-refund-range:\$\{id\}`\)/,
  );
  assert.match(
    body,
    /\.\.\.\(input\.refundOriginalPaymentIds \?\? \[\]\)\.map\(\(id\) => `pos-sale-payment-refund-range:\$\{id\}`\)/,
  );
  assertBefore(
    body,
    /for \(const namespace of advisoryNamespaces\)/,
    /lockNumberIds\(tx, "cash_register_sessions"/,
  );
  assert.match(body, /t\."status" = 'online'/);
  assert.match(body, /t\."paired_at" IS NOT NULL/);
  assert.match(body, /t\."revoked_at" IS NULL/);
  assert.match(body, /t\."token_expires_at" > clock_timestamp\(\)/);
  assert.match(
    body,
    /t\."last_seen_at" > clock_timestamp\(\) - interval '5 minutes'/,
  );
  assert.match(
    body,
    /if \(input\.mode === "operational"\) \{[\s\S]*const boundary/,
  );
  assert.match(prelock, /mode: "operational" \| "historical_refund"/);
  assert.match(prelock, /mode === "operational" && rows\.length !== 1/);
});

test("commit e materialização eletrônica pré-lockam antes de inserir ou tocar claim/held", () => {
  const commit = slice(
    route,
    "async function commitSale",
    "async function preparePosOrderReservations",
  );
  const transaction = slice(
    commit,
    "sale = await db.$transaction(",
    "const authoritativePayment = await exactPosPaymentPlanForCommit",
  );
  assertBefore(
    transaction,
    /preparePosPaymentPlanConsumption\(\s*tx,\s*\{/,
    /prelockPosSalePaymentWriteGraph\(\s*tx,\s*\{/,
  );
  assertBefore(
    transaction,
    /prelockPosSalePaymentWriteGraph\(\s*tx,\s*\{/,
    /assertLiveTerminalProof\(/,
  );
  assertBefore(
    transaction,
    /prelockPosSalePaymentWriteGraph\(\s*tx,\s*\{/,
    /SELECT "id" FROM "cash_register_sessions"/,
  );
  assertBefore(
    transaction,
    /prelockPosSalePaymentWriteGraph\(\s*tx,\s*\{/,
    /liveRegisterSaleAccess\(/,
  );
  assertBefore(
    commit,
    /prelockPosSalePaymentWriteGraph\(\s*tx,\s*\{/,
    /tx\.sale\.create\(/,
  );
  assertBefore(
    transaction,
    /prelockPosSalePaymentWriteGraph\(\s*tx,\s*\{/,
    /tx\.posOrderClaim\.findUnique\(/,
  );
  assert.doesNotMatch(
    transaction,
    /SELECT "id" FROM "pos_order_claims"/,
    "o claim já deve estar bloqueado pelo prelock canônico",
  );
  assert.doesNotMatch(
    transaction,
    /SELECT "id" FROM "sales_orders"/,
    "o pedido já deve estar bloqueado pelo prelock canônico",
  );
  assertBefore(
    transaction,
    /prelockPosSalePaymentWriteGraph\(\s*tx,\s*\{/,
    /SELECT "id" FROM "pos_held_sales"/,
  );
  assert.match(
    commit,
    /orderClaimLocator[\s\S]*pos-order-claim:\$\{orderClaimId\}[\s\S]*pos-order-claim-operation:\$\{orderClaimId\}:convert[\s\S]*sales-order:\$\{orderClaimLocator\.salesOrderId\}/,
  );
  assert.match(
    transaction,
    /preRootAdvisoryNamespaces: commitPreRootAdvisoryNamespaces/,
  );
  assert.match(
    commit,
    /nestedPaymentInsertKeys = paymentExecutions\.map\([\s\S]*insertIdempotencyKeys: nestedPaymentInsertKeys/,
  );
  assert.match(commit, /t2-payment-plan:aggregate:\$\{paymentPlanId\}/);
  assert.match(commit, /t2-payment-plan:idempotency:\$\{consumeOperationKey\}/);
  assert.match(
    commit,
    /consumePosPaymentPlan\(\s*tx,\s*authoritativePayment\.plan,\s*created\.id,[\s\S]*planConsumeRequestHash,?\s*\)/,
  );

  const consume = slice(
    paymentPersistence,
    "export async function consumeCapturedPosPaymentIntent",
    "export async function acceptPosPaymentCallback",
  );
  assertBefore(
    consume,
    /prelockPosSalePaymentWriteGraph\(tx, \{[\s\S]*?paymentPlanIds:/,
    /posSalePayment\.create\(/,
  );
});

test("compensação, cancelamento e devolução resolvem o plano pelo original; legado é explícito", () => {
  const compensation = slice(
    compensationPersistence,
    "export async function applyPosPaymentCompensation",
    "export async function maintainPosPaymentCompensations",
  );
  assertBefore(
    compensation,
    /prelockPosSalePaymentWriteGraph\(tx, \{[\s\S]*?existingPaymentIds:/,
    /posSalePayment\.create\(/,
  );
  assert.match(compensation, /allowLegacyNoPlanPayments: true/);
  assert.match(compensation, /mode: "historical_refund"/);

  const cancellation = slice(
    route,
    "async function cancelSale",
    "async function createReturn",
  );
  assertBefore(
    cancellation,
    /prelockPosSalePaymentWriteGraph\(tx, \{[\s\S]*?existingPaymentIds:/,
    /posSalePayment\.create\(/,
  );
  assertBefore(
    cancellation,
    /prelockPosSalePaymentWriteGraph\(tx, \{[\s\S]*?existingPaymentIds:/,
    /SELECT "id" FROM "sales" WHERE "id"/,
  );
  assert.match(
    cancellation,
    /prelockPosSalePaymentWriteGraph[\s\S]*sale = await tx\.sale\.findFirst/,
  );
  assert.match(cancellation, /allowLegacyNoPlanPayments: true/);
  assert.match(cancellation, /mode: "historical_refund"/);
  const cancellationTransaction = slice(
    cancellation,
    "const result = await db.$transaction(",
    "return Response.json",
  );
  assertBefore(
    cancellationTransaction,
    /prelockPosSalePaymentWriteGraph\(tx, \{/,
    /assertLiveTerminalProof\(/,
  );
  assert.match(
    cancellation,
    /cancelSaleLocator[\s\S]*cancelPaymentLocatorIds[\s\S]*refundPaymentIds[\s\S]*db\.\$transaction/,
  );

  const returns = slice(
    route,
    "async function createReturn",
    "async function restorePosKitSaleItemComponents",
  );
  assertBefore(
    returns,
    /prelockPosSalePaymentWriteGraph\(tx, \{[\s\S]*?existingPaymentIds:/,
    /posSalePayment\.create\(/,
  );
  assertBefore(
    returns,
    /prelockPosSalePaymentWriteGraph\(tx, \{[\s\S]*?existingPaymentIds:/,
    /SELECT "id" FROM "sales" WHERE "id"/,
  );
  assertBefore(
    returns,
    /prelockPosSalePaymentWriteGraph\(tx, \{[\s\S]*?existingPaymentIds:/,
    /prelockPosHeldSaleItemWrite\(/,
  );
  assert.match(returns, /allowLegacyNoPlanPayments: true/);
  assert.match(returns, /mode: "historical_refund"/);
  assert.match(
    returns,
    /returnSaleLocator[\s\S]*refundOriginalPaymentIds: returnPaymentLocatorIds[\s\S]*SELECT "id" FROM "sales"/,
  );
  assert.match(
    returns,
    /lockedReturnPaymentIds[\s\S]*JSON\.stringify\(returnPaymentLocatorIds\)/,
  );
  assert.match(
    prelock,
    /legacyPaymentIds\.length && input\.allowLegacyNoPlanPayments !== true/,
  );
  assert.equal(
    matches(
      `${compensation}\n${cancellation}\n${returns}`,
      /paymentPlanId: null,\s*paymentIndex: null/g,
    ),
    3,
    "refunds não reutilizam o slot único do plano original",
  );

  const commit = slice(
    route,
    "async function commitSale",
    "async function preparePosOrderReservations",
  );
  const consume = slice(
    paymentPersistence,
    "export async function consumeCapturedPosPaymentIntent",
    "export async function acceptPosPaymentCallback",
  );
  assert.match(
    commit,
    /prelockPosSalePaymentWriteGraph\(tx, \{\s*mode: "operational"/,
  );
  assert.match(
    consume,
    /prelockPosSalePaymentWriteGraph\(tx, \{\s*mode: "operational"/,
  );
});

function source(path: string) {
  return readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
}

function matches(value: string, pattern: RegExp) {
  return [...value.matchAll(pattern)].length;
}

function slice(value: string, start: string, end: string) {
  const first = value.indexOf(start);
  const last = value.indexOf(end, first + start.length);
  assert.notEqual(first, -1, `${start} ausente`);
  assert.notEqual(last, -1, `${end} ausente`);
  return value.slice(first, last);
}

function assertBefore(value: string, first: RegExp, second: RegExp) {
  const firstIndex = value.search(first);
  const secondIndex = value.search(second);
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
