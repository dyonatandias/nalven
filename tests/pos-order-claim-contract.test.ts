import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

const root = process.cwd();
const read = (path: string) => readFileSync(join(root, path), "utf8");
const schema = read("prisma/tenant/schema.prisma");
const migration = read(
  "prisma/tenant/migrations/20260829280000_pos_order_claim/migration.sql",
);
const route = read("app/api/erp/pdv/route.ts");
const qrRoute = read("app/api/erp/pdv/internal-qrs/route.ts");
const paymentPersistence = read("lib/erp/pos-payment-persistence.ts");
const paymentPlan = read("lib/erp/pos-payment-plan.ts");
const manualPaymentsRoute = read("app/api/erp/pdv/manual-payments/route.ts");
const sessionLifecycleRoute = read(
  "app/api/erp/pdv/session-lifecycle/route.ts",
);
const paymentIntentRoute = read("app/api/erp/pdv/payment-intents/route.ts");
const ordersRoute = read("app/api/erp/orders/route.ts");
const logisticsRoute = read("app/api/erp/logistics/route.ts");
const workspace = read("components/erp/pdv-workspace.tsx");

test("schema e migration impõem FKs operacionais, claim ativo único e histórico append-only", () => {
  const claim = model("PosOrderClaim"),
    operation = model("PosOrderClaimOperation");
  assert.match(claim, /salesOrderId\s+Int/);
  assert.match(claim, /lifecycleTxid\s+Decimal[^\r\n]*@db\.Decimal\(20, 0\)/);
  assert.match(operation, /writeTxid\s+Decimal[^\r\n]*@db\.Decimal\(20, 0\)/);
  assert.match(
    model("Sale"),
    /sourceCreationTxid\s+Decimal\?[^\r\n]*@db\.Decimal\(20, 0\)/,
  );
  assert.match(
    claim,
    /register\s+PosRegister\s+@relation\([^\n]*fields: \[registerId, branchId\]/,
  );
  assert.match(
    claim,
    /terminal\s+PosTerminal\s+@relation\([^\n]*fields: \[terminalId, registerId\]/,
  );
  assert.match(
    claim,
    /sessionRegister\s+CashRegisterSession\s+@relation\("PosOrderClaimSessionRegister"/,
  );
  assert.match(claim, /operatorProfile\s+TenantUserProfile\s+@relation/);
  assert.doesNotMatch(claim, /PosOrderClaimSessionOperator/);
  assert.match(operation, /onDelete: Restrict/);
  assert.match(claim, /sessionRegister[\s\S]*onUpdate: Restrict/);
  assert.match(operation, /onUpdate: Restrict/);
  assert.match(operation, /@@unique\(\[claimId, resultingVersion\]\)/);
  assert.match(
    migration,
    /pos_order_claims_one_active_order_key[\s\S]*WHERE "state" = 'active'/,
  );
  assert.match(
    migration,
    /action" IN \('claim', 'renew', 'release', 'expire', 'convert'\)/,
  );
  assert.match(migration, /lease_expires_at" > "claimed_at"/);
  assert.match(migration, /prevent_pos_order_claim_operation_mutation/);
  assert.match(migration, /pos_order_claim_operations_no_update/);
  assert.match(migration, /pos_order_claim_operations_no_delete/);
  assert.match(
    migration,
    /REFERENCES "pos_order_claims"\("id"\) ON DELETE RESTRICT ON UPDATE RESTRICT/,
  );
  assert.doesNotMatch(migration, /pos_order_claims[\s\S]*ON UPDATE CASCADE/);
  assert.match(
    migration,
    /sales_order_id", "branch_id"[\s\S]*REFERENCES "sales_orders"\("id", "branch_id"\)/,
  );
  assert.match(migration, /pos_order_claim_identity_guard/);
  assert.match(migration, /identity is immutable/);
  assert.match(migration, /converted sale does not match/);
  assert.match(
    migration,
    /cash_register_sessions_active_order_claim_handoff_guard/,
  );
  assert.match(migration, /status" = 'open'[\s\S]*FOR UPDATE/);
  assert.match(migration, /pos_order_claims_operation_ledger_guard/);
  assert.match(migration, /pos_order_claim_operations_claim_state_guard/);
  assert.match(migration, /missing its append-only operation ledger/);
  assert.match(migration, /claim_txid <> txid_current\(\)::numeric/);
  assert.match(migration, /o\."write_txid" = txid_current\(\)::numeric/);
  assert.match(migration, /NEW\."lifecycle_txid" := txid_current\(\)::numeric/);
  assert.match(migration, /NEW\."write_txid" := txid_current\(\)::numeric/);
  assert.match(
    migration,
    /NEW\."source_creation_txid" := CASE WHEN NEW\."source_type" = 'sales_order' THEN txid_current\(\)::numeric ELSE NULL END/,
  );
  assert.doesNotMatch(migration, /xmin/i);
  assert.match(
    migration,
    /lifecycle and operation ledger must be written in the same database transaction/,
  );
  assert.match(migration, /TG_TABLE_NAME = 'pos_order_claim_operations'/);
  assert.match(migration, /NEW\."resulting_version" <> claim_version/);
  assert.match(
    migration,
    /operation does not exactly match the lifecycle transition/,
  );
  assert.doesNotMatch(migration, /session_id_operator_profile_id_fkey/);
});

test("lookup e lifecycle exigem escopo, terminal vivo, CAS e QR assinado só como identidade", () => {
  assert.match(route, /action === "order\.lookup"/);
  assert.match(
    route,
    /resolveInternalQrEntity\(tx, context, qrToken, "order"\)/,
  );
  assert.match(route, /verifyPosInternalQr\(token/);
  for (const action of [
    "order.claim",
    "order.claim.recover",
    "order.claim.renew",
    "order.claim.release",
  ])
    assert.match(
      route,
      new RegExp(
        `FINANCIAL_TERMINAL_ACTIONS[\\s\\S]*"${action.replaceAll(".", "\\.")}"`,
      ),
    );
  assert.match(
    route,
    /assertLiveTerminalProof\(tx, context, terminalProof, register\.id\)/,
  );
  assert.match(route, /liveRegisterSaleAccess\(tx, context, register\.id\)/);
  assert.match(route, /assertPosOrderClaimContext\(claim/);
  const claimPrelock = read("lib/erp/pos-order-claim-prelock.ts");
  assert.match(route, /prelockPosOrderClaimWrite\(tx/);
  assert.match(claimPrelock, /FROM "sales_orders"[\s\S]*FOR UPDATE/);
  assert.match(
    route,
    /where: \{ id: orderId, branchId: context\.branch\.id \}/,
  );
  assert.match(qrRoute, /action: "lookup_order"/);
  assert.doesNotMatch(qrRoute, /QR está bloqueada até existir claim/);
});

test("sale.commit converte pedido, estoque, histórico e claim dentro da mesma Serializable", () => {
  const commit = block(
    "async function commitSale",
    "async function preparePosOrderReservations",
  );
  assert.match(commit, /db\.\$transaction\(\s*async \(tx\) =>/);
  assert.match(commit, /isolationLevel: "Serializable"/);
  assert.match(
    commit,
    /sourceType: "sales_order", sourceId: String\(claimedOrder\.id\)/,
  );
  assert.match(commit, /preparePosOrderReservations\(tx, claimedOrder/);
  assert.match(commit, /allocatePosTrackedSaleItem\(tx/);
  assert.match(commit, /applyPosCommonStockChange\(tx/);
  assert.match(commit, /queuePosFiscalIssuanceForSale\(tx/);
  assert.match(commit, /salesOrderHistory\.create/);
  assert.match(commit, /action: "convert"/);
  assert.match(commit, /action: "pos\.order\.converted"/);
  assert.match(commit, /state: "converted"[\s\S]*convertedSaleId: created\.id/);
  assert.match(
    commit,
    /assertPosOrderSettlement\(claimedOrder, paymentInputs\)/,
  );
  assert.match(commit, /assertExactPosOrderPricing\(claimedOrder/);
  assert.match(commit, /assertConvertedOrderClaimReplay/);
  assert.doesNotMatch(commit, /orderPayment\.updateMany/);
  assert.match(
    commit,
    /prevalidatedInertOrderPayments: claimedOrder\.payments\.length/,
  );
  assert.doesNotMatch(commit, /\/api\/erp\/orders|complete\(.*order/i);
});

test("novo claim, release e descarte direto falham fechados diante de artefatos financeiros", () => {
  const claim = block(
    "async function claimPosOrder",
    "async function renewPosOrderClaim",
  );
  const release = block(
    "async function mutatePosOrderClaim",
    "async function unresolvedPosOrderClaimArtifacts",
  );
  const discard = block(
    "async function discardRecoveryDraft",
    "async function holdCart",
  );
  const artifacts = block(
    "async function unresolvedPosOrderClaimArtifacts",
    "function replayClaimCreation",
  );
  assert.match(claim, /unresolvedPosOrderClaimArtifacts\(tx, active\)/);
  assert.match(claim, /referência manual sem resolução/);
  assert.match(release, /unresolvedPosOrderClaimArtifacts\(tx, claim\)/);
  assert.match(release, /Reconcilie ou cancele com segurança/);
  assert.match(artifacts, /POS_DRAFT_RECOVERY_INTENT_STATES/);
  assert.match(artifacts, /posManualPaymentReference\.count/);
  assert.match(
    discard,
    /SELECT "id" FROM "pos_order_claims" WHERE "id" = \$\{draftId\} FOR UPDATE/,
  );
  assert.match(discard, /state: "active"/);
  assert.match(discard, /Libere o pedido pelo fluxo de claim/);
  assert.match(discard, /posManualPaymentReference\.count/);
  assert.match(discard, /consumedSalePaymentId:\s*null,\s*status:\s*"pending"/);
  assert.match(discard, /unresolved \|\| manualReferences/);
});

test("criação de intent e referência manual compartilha locks claim→draft e exige claim vivo/contextual", () => {
  const helper = read("lib/erp/pos-order-claim.ts");
  assert.match(
    helper,
    /SELECT "id" FROM "pos_order_claims" WHERE "id" = \$\{expected\.saleDraftId\} FOR UPDATE/,
  );
  assert.match(
    helper,
    /SELECT "id" FROM "pos_held_sales" WHERE "id" = \$\{expected\.saleDraftId\} FOR UPDATE/,
  );
  assert.match(
    helper,
    /SELECT "id" FROM "sales_orders" WHERE "id" = \$\{claimIdentity\.salesOrderId\} FOR UPDATE/,
  );
  assert.match(
    helper,
    /claim\.state !== "active" \|\|\s*claim\.leaseExpiresAt <=/,
  );
  assert.match(helper, /claim\.terminalId !== expected\.terminalId/);
  assert.match(paymentPersistence, /lockPosPaymentIntentCreateCanonical\(tx/);
  assert.match(paymentPlan, /assertOrderClaimPlan\(tx, plan/);
  assert.match(paymentPlan, /lockedPosPaymentDraftIssue\(tx/);
  assert.match(manualPaymentsRoute, /lockedPosPaymentDraftIssue\(tx/);
  assert.match(
    manualPaymentsRoute,
    /draftIssue[\s\S]*PosOrderClaimError\(draftIssue\)/,
  );
  const release = block(
    "async function mutatePosOrderClaim",
    "async function unresolvedPosOrderClaimArtifacts",
  );
  assert.match(
    release,
    /prelockPosOrderClaimWrite\(tx[\s\S]*unresolvedPosOrderClaimArtifacts/,
  );
});

test("slot financeiro é exclusivo inclusive para estorno parcial e referências manuais recuperáveis", () => {
  const helper = read("lib/erp/pos-order-claim.ts");
  assert.match(helper, /pg_advisory_xact_lock/);
  assert.match(helper, /"captured",\s*"partially_refunded",\s*"unknown"/);
  assert.match(
    migration,
    /pos_payment_intents_one_unresolved_draft_slot_key[\s\S]*partially_refunded/,
  );
  assert.match(migration, /enforce_pos_payment_draft_slot_exclusivity/);
  assert.match(paymentIntentRoute, /posManualPaymentReference\.findMany/);
  assert.match(
    paymentIntentRoute,
    /manualReferences: manualReferences\.map\(recoveryManualReferenceDto\)/,
  );
  assert.match(paymentIntentRoute, /approved_expired/);
  assert.match(workspace, /paymentFromRecoveredManualReference/);
  assert.match(workspace, /Revogar rejeição com auditoria/);
  assert.match(workspace, /Estado expirado: o slot permanece bloqueado/);
});

test("pedido fica congelado contra comercial e logística durante claim e após conversão", () => {
  assert.match(
    logisticsRoute,
    /SELECT "id" FROM "sales_orders" WHERE "id" = \$\{input\.salesOrderId\} FOR UPDATE/,
  );
  assert.match(logisticsRoute, /posOrderClaim\.findFirst/);
  assert.match(logisticsRoute, /isolationLevel: "Serializable"/);
  assert.match(ordersRoute, /lockSalesOrderWithoutActivePosClaim/);
  assert.match(ordersRoute, /O pedido está reivindicado no PDV/);
  for (const guard of [
    "shipments_pos_order_conversion_guard",
    "sales_orders_active_pos_claim_transition_guard",
    "sales_order_items_active_pos_claim_guard",
    "order_payments_active_pos_claim_guard",
    "order_tracking_active_pos_claim_guard",
    "order_shipping_labels_active_pos_claim_guard",
    "stock_reservations_active_pos_claim_guard",
  ])
    assert.match(migration, new RegExp(guard));
  assert.match(migration, /DEFERRABLE INITIALLY DEFERRED/);
  assert.match(migration, /c\."lifecycle_txid" = txid_current\(\)::numeric/);
  assert.match(
    migration,
    /s\."source_creation_txid" = txid_current\(\)::numeric/,
  );
  assert.match(migration, /o\."write_txid" = txid_current\(\)::numeric/);
  assert.match(migration, /old_order_id := OLD\."sales_order_id"/);
  assert.match(migration, /new_order_id := NEW\."sales_order_id"/);
  assert.match(
    migration,
    /c\."sales_order_id" = old_order_id OR c\."sales_order_id" = new_order_id/,
  );
  assert.match(
    migration,
    /OLD\."status" = 'active' AND NEW\."status" = 'consumed'/,
  );
});

test("turno com claim ativo não pode ser pausado, fechado nem transferido", () => {
  assert.match(
    route,
    /assertNoActivePosOrderClaim\(tx, session\.id, "fechar"\)/,
  );
  assert.match(
    sessionLifecycleRoute,
    /assertNoActivePosOrderClaim\(tx, current\.id, "pausar"\)/,
  );
  assert.match(
    sessionLifecycleRoute,
    /assertNoActivePosOrderClaim\(tx, current\.id, "transferir"\)/,
  );
  assert.match(
    sessionLifecycleRoute,
    /assertNoActivePosOrderClaim\(tx, session\.id, "aceitar a transferência de"\)/,
  );
  assert.match(
    sessionLifecycleRoute,
    /Conclua ou libere o pedido reivindicado/,
  );
  assert.match(sessionLifecycleRoute, /status: 409|, 409/);
});

test("qualquer trilha OrderPayment não inerte ou com prova externa bloqueia conversão", () => {
  assert.match(
    route,
    /payments:\s*\{\s*select:\s*\{\s*status:\s*true,\s*paidAt:\s*true,\s*transactionId:\s*true,\s*paymentUrl:\s*true,?\s*\},?\s*\}/,
  );
  assert.match(route, /assertPosOrderEligible\(order, context\.branch\.id\)/);
  const helper = read("lib/erp/pos-order-claim.ts");
  assert.match(helper, /INERT_ORDER_PAYMENT_STATES/);
  assert.match(helper, /payment\.paymentUrl\?\.trim\(\)/);
  assert.match(helper, /!INERT_ORDER_PAYMENT_STATES\.has\(payment\.status\)/);
});

test("fulfillment e artefatos de frete tornam pedido inelegível e são revalidados sob lock", () => {
  const helper = read("lib/erp/pos-order-claim.ts");
  for (const evidence of [
    "shipment_exists",
    "shipping_artifact",
    "fulfillment_pending",
    "unsupported_channel",
    "shippingLabels",
    "tracking",
  ])
    assert.match(helper, new RegExp(evidence));
  assert.match(
    route,
    /shipments:\s*\{\s*select:\s*\{\s*id:\s*true,\s*status:\s*true\s*\}\s*\}/,
  );
  assert.match(
    route,
    /assertPosOrderEligible\(claimedOrder, context\.branch\.id\)/,
  );
});

test("reservas parciais e dimensionais incompatíveis falham antes da baixa comum", () => {
  const reservations = block(
    "async function preparePosOrderReservations",
    "async function assertConvertedOrderClaimReplay",
  );
  assert.match(reservations, /hasAnyReservation/);
  assert.match(reservations, /não cobrem integralmente o item estocável/);
  assert.match(reservations, /mode === "variation"/);
  assert.match(reservations, /não identifica o bucket da variação/);
  assert.match(reservations, /reserva agregada do kit/);
  assert.match(
    reservations,
    /reservedQuantity: \{ decrement: reservation\.quantity \}/,
  );
  assert.match(reservations, /status: "consumed", consumedAt: new Date\(\)/);
});

test("workspace usa claim.id como draft, renova com retry, bloqueia mutações e recupera condição exata", () => {
  assert.match(workspace, /saleIdempotencyKey\.current = claimId/);
  assert.match(workspace, /action: "order\.claim\.renew"/);
  assert.match(workspace, /window\.setInterval\(tick, 5_000\)/);
  assert.match(
    workspace,
    /remaining <= 60_000\) void renewOrderClaim\(activeOrderClaim\)/,
  );
  assert.match(workspace, /orderClaimCheckoutBlocked/);
  assert.match(
    workspace,
    /createDisabled=\{orderClaimCheckoutBlocked \|\| !paymentPlanSlotsMatch\}/,
  );
  assert.match(workspace, /order\.claim\.release/);
  assert.match(workspace, /stringValue\(rawClaim\.state\) !== "active"/);
  assert.match(workspace, /orderClaimAttempt\.current = null/);
  assert.match(
    workspace,
    /O rascunho recuperado diverge do pedido reivindicado/,
  );
  assert.match(
    workspace,
    /A intenção eletrônica recuperada diverge da condição de pagamento/,
  );
  for (const field of [
    "Quantidade",
    "Desconto de",
    "Forma do pagamento",
    "Valor do pagamento",
    "Parcelas do pagamento",
  ])
    assert.match(
      workspace,
      new RegExp(`${field}[\\s\\S]{0,300}Boolean\\(activeOrderClaim\\)`),
    );
  assert.match(
    workspace,
    /Nenhum dado desta recuperação é salvo em localStorage/,
  );
});

function model(name: string) {
  const start = schema.indexOf(`model ${name} {`);
  assert.notEqual(start, -1, `model ${name} ausente`);
  const end = schema.indexOf("\n}\n", start);
  return schema.slice(start, end + 2);
}

function block(startLabel: string, endLabel: string) {
  const start = route.indexOf(startLabel),
    end = route.indexOf(endLabel, start + startLabel.length);
  assert.ok(start >= 0 && end > start, `bloco ${startLabel} ausente`);
  return route.slice(start, end);
}
