import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const migration = readFileSync(new URL("../prisma/tenant/migrations/20260829322100_pos_manual_payment_t2_profile_lifecycle/migration.sql", import.meta.url), "utf8");
const salePayment = migration.slice(
  migration.indexOf("-- Sale-payment T2 ABI"),
  migration.indexOf("-- Lifecycle writers are installed fail-closed"),
);

test("sale-payment T2 mantém ABI final sem scaffold transitório", () => {
  for (const action of ["create_commit", "create_intent_consumption", "insert_refund_compensation", "insert_refund_cancel", "insert_refund_return", "update_refund_status"]) {
    assert.match(salePayment, new RegExp(`'${action}'`));
  }
  assert.match(salePayment, /DROP TRIGGER "pos_sale_payments_authoritative_plan_guard"/);
  assert.match(salePayment, /CREATE TRIGGER "pos_sale_payments_t2_write_guard"/);
  assert.doesNotMatch(salePayment, /incomplete foundation|intentionally absent|DROP FUNCTION public\."protect_pos_sale_payment_t2"/);
  assert.match(migration, /pos_manual_t2_sale_payment_evidence_transport_safe_v1"\(text\)[\s\S]*FROM PUBLIC/);
});

test("advisories e locks seguem os domínios compartilhados antes das roots", () => {
  for (const namespace of [
    "pos-sale-payment-insert:", "pos-sale-payment-refund-range:", "t2-payment-plan:aggregate:",
    "t2-payment-plan:draft:", "pos-held-sale-items:v1:held-sale:", "pos-order-claim:v1:claim:",
    "pos-order-claim:v1:artifacts:", "pos-order-claim:v1:order:",
  ]) assert.match(salePayment, new RegExp(namespace.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  const advisory = salePayment.indexOf("pg_advisory_xact_lock");
  const session = salePayment.indexOf('FROM public."cash_register_sessions"', advisory);
  const connector = salePayment.indexOf('FROM public."pos_connectors"', session);
  const provider = salePayment.indexOf('FROM public."integration_providers"', connector);
  const credential = salePayment.indexOf('FROM public."integration_credentials"', provider);
  const plan = salePayment.indexOf('FROM public."pos_payment_plans" WHERE id=target.payment_plan_id FOR UPDATE', credential);
  const payments = salePayment.indexOf('FROM public."pos_sale_payments" WHERE payment_plan_id=plan_row.id ORDER BY id FOR UPDATE', plan);
  assert.ok(advisory >= 0 && advisory < session && session < connector && connector < provider && provider < credential && credential < plan && plan < payments);
  assert.match(salePayment, /plan_locator[\s\S]*claim_locator[\s\S]*sale payment locator graph changed after advisory locks/);
});

test("proofs financeiros, causalidade de refund e sentinel são fechados", () => {
  for (const proof of ["slot_row.proof_kind='cash'", "slot_row.proof_kind='value'", "slot_row.proof_kind='intent'", "slot_row.proof_kind='manual'"]) assert.ok(salePayment.includes(proof));
  assert.match(salePayment, /manualReferenceId[\s\S]*payment_artifact:manual_reference[\s\S]*action='consume'/);
  assert.match(salePayment, /compensation_row\.status<>'applied'[\s\S]*provider_state<>'succeeded'/);
  assert.match(salePayment, /access\.can_cancel[\s\S]*approval\.action='sale\.cancel'/);
  assert.match(salePayment, /access\.can_refund[\s\S]*approval\.action='return\.create'/);
  assert.match(salePayment, /ROW\(payment\.created_at,payment\.id\)<ROW\(original_row\.created_at,original_row\.id\)/);
  assert.match(salePayment, /p_target->'refunded_at'<>'null'::jsonb[\s\S]*target\.refunded_at:=now_at/);
  assert.doesNotMatch(salePayment, /idempotency_key (?:NOT )?LIKE operation_ref/);
});

test("guard sale-payment é puro e observa root exata", () => {
  const guard = salePayment.slice(salePayment.indexOf('CREATE FUNCTION public."protect_pos_sale_payment_t2"'), salePayment.indexOf('DROP TRIGGER "pos_sale_payments_authoritative_plan_guard"'));
  assert.match(guard, /pos_manual_t2_sale_payment_root_action_v1/);
  assert.match(guard, /pos_manual_t2_observe_write_v1/);
  assert.doesNotMatch(guard, /\bFROM\s+public\."(?:pos_sale_payments|sales|pos_payment_plans|pos_payment_intents|pos_manual_payment_references)"/);
  assert.doesNotMatch(guard, /pg_advisory|FOR UPDATE|FOR SHARE/);
});
