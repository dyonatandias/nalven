import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const capability = readFileSync(new URL("../lib/erp/pos-payment-artifact-capability.ts", import.meta.url), "utf8");
const persistence = readFileSync(new URL("../lib/erp/pos-payment-persistence.ts", import.meta.url), "utf8");
const cancelRoute = readFileSync(new URL("../app/api/erp/pdv/payment-intents/route.ts", import.meta.url), "utf8");

test("wrappers tipam exatamente as ações congeladas dos artefatos de pagamento", () => {
  for (const action of ["create", "retry", "apply_delivery", "apply_callback", "cancel_before_dispatch", "expire_before_dispatch", "schedule_reconcile", "force_manual_review", "consume"]) {
    assert.match(capability, new RegExp(`\\|? \\"${action}\\"`));
  }
  assert.match(capability, /PosManualPaymentReferenceWriteAction = "create" \| "revoke" \| "consume"/);
  for (const action of ["create_commit", "create_intent_consumption", "insert_refund_compensation", "insert_refund_cancel", "insert_refund_return", "update_refund_status"]) {
    assert.match(capability, new RegExp(`\\|? \\"${action}\\"`));
  }
  assert.match(capability, /PosPaymentIntentWrite[\s\S]*target: PosPaymentIntentTarget/);
  assert.match(capability, /PosPaymentArtifactWrite[\s\S]*target: Prisma\.InputJsonObject/);
});

test("wrappers chamam as três signatures ABI com target convertido para jsonb", () => {
  assert.match(capability, /pos_manual_t2_sale_payment_request_hash_v1[\s\S]*AS "requestHash"[\s\S]*pos_manual_prepare_sale_payment_write_v1[\s\S]*preview\.requestHash[\s\S]*CAST\(\$\{target\} AS jsonb\)/);
  assert.match(capability, /pos_manual_t2_payment_intent_request_hash_v1[\s\S]*AS "requestHash"[\s\S]*pos_manual_prepare_payment_intent_write_v1[\s\S]*preview\.requestHash/);
  assert.match(capability, /pos_manual_t2_manual_reference_request_hash_v1[\s\S]*AS "requestHash"[\s\S]*pos_manual_prepare_manual_payment_reference_write_v1[\s\S]*preview\.requestHash/);
  assert.match(capability, /return preview\.requestHash/);
  assert.equal((capability.match(/CAST\(\$\{target\} AS jsonb\)/g) ?? []).length, 6);
});

test("target manual é integral, snake_case e preserva referência apenas no transporte", () => {
  for (const key of ["payment_plan_id", "requester_profile_id", "reference", "reference_hash", "consumed_sale_payment_id", "consumed_at", "revoked_at", "revoke_idempotency_key", "revoke_request_hash"]) assert.match(capability, new RegExp(`\\b${key}\\b`));
  assert.match(capability, /occurredAt\.toISOString\(\)/);
});

test("target intent é fechado em snake_case e serializa datas e bigint", () => {
  for (const key of ["branch_id", "payment_plan_id", "provider_sequence", "provider_occurred_at", "next_reconcile_at", "request_hash", "consumed_at"]) assert.match(capability, new RegExp(`\\b${key}\\b`));
  assert.match(capability, /providerSequence\?\.toString\(\)/);
  assert.match(capability, /toISOString\(\)/);
});

test("todos os nove producers preparam capability imediatamente antes do DML de intent", () => {
  for (const action of ["create", "retry", "apply_delivery", "apply_callback", "expire_before_dispatch", "schedule_reconcile", "force_manual_review", "consume"]) {
    assert.match(persistence, new RegExp(`["]${action}["]`));
  }
  assert.match(cancelRoute, /action: "cancel_before_dispatch"[\s\S]*posPaymentIntent\.updateMany/);
  assert.match(persistence, /preparePosPaymentIntentWrite\(tx,[\s\S]*posPaymentIntent\.create/);
  assert.match(persistence, /prepareIntentTransition\(tx, "retry"[\s\S]*posPaymentIntent\.updateMany/);
  assert.match(persistence, /prepareIntentTransition\(tx, "consume"[\s\S]*posPaymentIntent\.updateMany/);
  assert.match(persistence, /prepareIntentTransition\(tx, "force_manual_review"[\s\S]*posPaymentIntent\.updateMany/);
  assert.match(persistence, /source\.source === "callback" \? "apply_callback" : "apply_delivery"/);
  assert.match(persistence, /"expire_before_dispatch"[\s\S]*posPaymentIntent\.updateMany/);
  assert.match(persistence, /"schedule_reconcile"[\s\S]*posPaymentIntent\.updateMany/);
  assert.match(persistence, /"consume"[\s\S]*consumedAt: null[\s\S]*findUniqueOrThrow/);
});
