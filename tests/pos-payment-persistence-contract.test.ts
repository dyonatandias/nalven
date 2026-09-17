import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const root = fileURLToPath(new URL("..", import.meta.url));
const read = (path: string) => readFileSync(join(root, path), "utf8");
const schema = read("prisma/tenant/schema.prisma");
const migration = read("prisma/tenant/migrations/20260829200000_pos_payment_persistence/migration.sql");
const integrityMigration = read("prisma/tenant/migrations/20260829220000_pos_payment_integrity/migration.sql");
const domain = read("lib/erp/pos-payment-persistence.ts");
const callbackRoute = read("app/api/webhooks/pos-payments/[organizationId]/[provider]/route.ts");
const operatorRoute = read("app/api/erp/pdv/payment-intents/route.ts");
const outboxRoute = read("app/api/internal/pdv/payments/outbox/[organizationId]/route.ts");
const maintenanceRoute = read("app/api/internal/pdv/payments/process/route.ts");
const saleRoute = read("app/api/erp/pdv/route.ts");
const lifecycleRoute = read("app/api/erp/pdv/session-lifecycle/route.ts");

test("persistência separa intent, attempt, outbox, callback e ledger imutável", () => {
  for (const model of ["PosPaymentIntent", "PosPaymentAttempt", "PosPaymentOutbox", "PosPaymentCallback", "PosPaymentStateEvent"]) assert.match(schema, new RegExp(`model ${model}\\b`));
  assert.match(schema, /paymentIntentId\s+String\?\s+@unique/);
  assert.match(migration, /pos_payment_intents_unknown_check/);
  assert.match(migration, /"status" <> 'unknown' OR "unknown_since" IS NOT NULL/);
  assert.match(migration, /pos_payment_intents_captured_evidence_check/);
  assert.match(migration, /pos_payment_intents_method_evidence_check/);
  assert.match(migration, /pos_payment_intents_pix_e2e_tenant_key/);
  assert.match(migration, /pos_payment_intents_provider_transaction_tenant_key/);
  assert.match(migration, /"method" = 'pix'[\s\S]*"end_to_end_id" ~ '\^E\[0-9\]\{16\}\[A-Z0-9\]\{15\}\$'/);
  assert.match(migration, /"transaction_id" IS NOT NULL AND "authorization_code" IS NOT NULL AND "card_last_four" IS NOT NULL/);
  assert.match(migration, /"consumed_at" IS NULL OR "status" IN \('captured', 'partially_refunded', 'refunded'\)/);
  assert.match(migration, /FOREIGN KEY \("session_id", "register_id"\)/);
  assert.match(migration, /FOREIGN KEY \("connector_id", "branch_id", "provider"\)/);
  for (const table of ["pos_payment_callbacks", "pos_payment_state_events", "pos_payment_attempts", "pos_payment_outbox", "pos_payment_intents"]) assert.match(migration, new RegExp(`${table}_(?:immutable_|delete_)?guard`));
});

test("unknown não fabrica identidade do provider e callback real pode convergir depois", () => {
  const unknownBlock = domain.slice(domain.indexOf('if (input.result.kind === "unknown")'), domain.indexOf("const observation = input.result"));
  assert.match(unknownBlock, /providerReference: null/);
  assert.match(unknownBlock, /providerSequence: null/);
  assert.match(unknownBlock, /occurredAt: null/);
  assert.doesNotMatch(unknownBlock, /merchant:/);
  assert.match(domain, /providerReference: observation\.providerReference \?\? intent\.providerReference/);
  assert.match(domain, /providerSequence: observation\.providerSequence \?\? intent\.providerSequence/);
  assert.match(domain, /unknown: \["unknown", "processing", "authorized", "captured"/);
});

test("boundary de callback é allowlisted, assinado, limitado e não recebe PAN", () => {
  for (const evidence of ["persistentRateLimit", "credentialRef: { not: null }", 'provider: { family: "payment" }', "decryptSecrets", "verifyAndParsePosPaymentCallback", "payment_callback_secret", "status: 202", "cache-control"]) assert.match(callbackRoute, new RegExp(evidence.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.match(callbackRoute, /unresolvedIntents/);
  assert.match(callbackRoute, /payment_callback_grace_until/);
  assert.match(domain, /rejectSensitiveData\(body\)/);
  assert.match(domain, /pin_\?block\|card_\?number/);
  assert.match(domain, /containsPosPaymentPanInIdentifier\(value\)/);
  assert.match(domain, /assertPosPaymentMethodEvidence/);
  assert.match(domain, /A evidência do provedor já foi vinculada a outra intenção de pagamento/);
  assert.match(domain, /digits\.length < 12 \|\| digits\.length > 19/);
  assert.doesNotMatch(callbackRoute, /claimPosPaymentOutbox|completePosPaymentOutbox|createPosPaymentIntent|retryPosPaymentIntent/);
});

test("API do operador, worker e manutenção são autenticadas, bounded e idempotentes", () => {
  for (const evidence of ["assertSameOrigin(request)", "assertPosMutationRequest(request)", 'assertTenantPermission(organization.id, "pdv.write")', "assertTenantWriteAccess", "readPosJson(request, 32_768)", "payment.intent.create", "payment.intent.retry", "noStoreHeaders"]) assert.match(operatorRoute, new RegExp(evidence.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  for (const route of [outboxRoute, maintenanceRoute]) {
    assert.match(route, /assertPosPaymentJobAuthorization\(request\)/);
    assert.match(route, /assertPosMutationRequest\(request\)/);
    assert.match(route, /readPosJson\(request,/);
    assert.match(route, /cache-control/);
  }
  assert.match(domain, /FOR UPDATE OF session SKIP LOCKED/);
  assert.match(domain, /locked_sessions AS MATERIALIZED/);
  assert.match(domain, /isolationLevel: "Serializable"/);
  assert.match(domain, /operationKey: input\.idempotencyKey/);
  assert.match(domain, /providerIdempotencyKey: operation === "create" \? intent\.idempotencyKey/);
  assert.match(domain, /credentialRef: slot\.credentialRef!/);
  assert.match(domain, /credentialRef: intent\.credentialRef/);
});

test("incidente financeiro é persistente, bloqueante e visível no ciclo do turno", () => {
  for (const model of ["PosPaymentIntegrityIncident", "PosPaymentDeliveryResult"]) assert.match(schema, new RegExp(`model ${model}\\b`));
  assert.match(integrityMigration, /pos_payment_integrity_incidents_resolution_check/);
  assert.match(integrityMigration, /production_blocking/);
  assert.match(integrityMigration, /pos_payment_delivery_results_claim_token_hash_key/);
  assert.match(integrityMigration, /protect_consumed_pos_payment_evidence/);
  assert.match(integrityMigration, /consumed pos payment evidence is immutable/);
  assert.match(domain, /callback_monetary_mismatch/);
  assert.match(domain, /supplemental_after_consumption/);
  assert.match(domain, /lockIntent\(tx,[\s\S]*lockAttempt\(tx,[\s\S]*lockOutbox\(tx,/);
  assert.match(domain, /posPaymentDeliveryResult\.findUnique/);
  for (const source of [saleRoute, lifecycleRoute]) {
    assert.match(source, /posPaymentIntegrityIncident\.count/);
    assert.match(source, /productionBlocking: true/);
  }
});

test("commit deriva a execução do plano e vincula intent capturado uma vez", () => {
  assert.match(saleRoute, /authoritativePayment\.paymentInputs/);
  assert.match(saleRoute, /exactPosPaymentPlanForCommit/);
  assert.match(saleRoute, /consumeCapturedPosPaymentIntent\(tx/);
  assert.match(saleRoute, /paymentIndex,/);
  assert.match(domain, /intent\.status !== "captured"/);
  assert.match(domain, /paymentIntentId: intent\.id/);
  assert.match(domain, /consumedAt: null/);
  assert.match(domain, /data: \{ consumedAt, version: \{ increment: 1 \}/);
  assert.match(domain, /source: "sale_commit"/);
  assert.doesNotMatch(saleRoute.slice(saleRoute.indexOf("function assertSalePaymentKeys")), /transactionId|authorizationCode|cardLastFour|endToEndId/);
});

test("fechamento e passagem de turno bloqueiam intent capturado ainda não consumido", () => {
  for (const source of [saleRoute, lifecycleRoute]) {
    assert.match(source, /posPaymentIntent\.count/);
    assert.match(source, /consumedAt: null/);
    assert.match(source, /"captured"/);
  }
});
