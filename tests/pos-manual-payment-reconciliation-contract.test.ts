import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  assertProviderCausality,
  containsManualPaymentPan,
  hashManualPaymentQueryCompletion,
  isTransactionConflict,
  openPosManualPaymentCase,
  PosManualReconciliationError,
  type PosManualReferenceVaultAdapter,
} from "../lib/erp/pos-manual-payment-reconciliation";

const migration = readFileSync("prisma/tenant/migrations/20260829320000_pos_manual_payment_reconciliation/migration.sql", "utf8");
const authoritativeReviewSnapshotMigration = readFileSync("prisma/tenant/migrations/20260829320100_pos_manual_review_authoritative_snapshot/migration.sql", "utf8");
const issuerReviewMigration = readFileSync("prisma/tenant/migrations/20260829321000_pos_manual_payment_issuer_review_procedures/migration.sql", "utf8");
const callbackProofMigration = readFileSync("prisma/tenant/migrations/20260829321100_pos_manual_payment_callback_t1_proofs/migration.sql", "utf8");
const schema = readFileSync("prisma/tenant/schema.prisma", "utf8");
const service = readFileSync("lib/erp/pos-manual-payment-reconciliation.ts", "utf8");

test("320000 mantém gate financeiro hard-disabled até roles e T2 completos", () => {
  assert.match(migration, /manual reconciliation remains hard-disabled until worker\/vault roles and T2 application guards are installed/);
  assert.match(migration, /IF NEW\."enabled"=true THEN/);
  assert.match(migration, /pos_payment_plans_320_manual_gate/);
  assert.match(migration, /payment plan has unresolved manual reconciliation evidence/);
  assert.match(migration, /seal_legacy_pos_manual_payment_reference/);
  assert.match(migration, /sealed history-only/);
});

test("320000 separa vault, blind index estável, assertion one-shot e ledger causal", () => {
  for (const model of ["Case", "VaultBinding", "StepUpAssertion", "Review", "Attempt", "Outbox", "DeliveryResult", "Callback", "Observation", "Incident", "Application", "Operation", "StateEvent"]) {
    assert.match(schema, new RegExp(`model PosManualPayment${model}`));
  }
  assert.match(schema, /stableReferenceIndex\s+String\s+@unique/);
  assert.match(migration, /step-up assertion is immutable and single-use/);
  assert.match(migration, /manual observation delivery\/callback\/ledger graph is incomplete/);
  assert.match(migration, /manual case operation\/state-event graph is incomplete/);
  assert.match(migration, /ELSIF TG_TABLE_NAME = 'integration_credentials' THEN/);
});

test("320100 preserva precisão PostgreSQL e materializa o snapshot autoritativo da review", () => {
  assert.match(authoritativeReviewSnapshotMigration, /CREATE OR REPLACE FUNCTION "validate_pos_manual_review"/);
  assert.match(authoritativeReviewSnapshotMigration, /"branch_id" = case_record\."branch_id"[\s\S]*"user_profile_id" = NEW\."checker_profile_id"[\s\S]*FOR SHARE/);
  assert.match(authoritativeReviewSnapshotMigration, /"register_id" = case_record\."register_id"[\s\S]*"user_profile_id" = NEW\."checker_profile_id"[\s\S]*FOR SHARE/);
  assert.match(authoritativeReviewSnapshotMigration, /assertion\."assertion_hash" = NEW\."step_up_proof_hash"[\s\S]*assertion\."request_hash" = NEW\."request_hash"[\s\S]*FOR UPDATE/);
  for (const assignment of [
    'NEW."branch_grant_id" := branch_grant_record."id"',
    'NEW."register_grant_id" := register_grant_record."id"',
    'NEW."grant_valid_from" := register_grant_record."valid_from"',
    'NEW."grant_valid_until" := register_grant_record."valid_until"',
    'NEW."authority_limit_cents" := register_grant_record."manual_payment_review_limit_cents"',
    'NEW."step_up_evidence_id" := assertion_record."id"::text',
    'NEW."step_up_verified_at" := assertion_record."verified_at"',
    'NEW."step_up_expires_at" := assertion_record."expires_at"',
  ]) assert.ok(authoritativeReviewSnapshotMigration.includes(assignment), `snapshot ausente: ${assignment}`);
  assert.doesNotMatch(authoritativeReviewSnapshotMigration, /assertion\."verified_at"\s*=\s*NEW\."step_up_verified_at"/);
  assert.doesNotMatch(authoritativeReviewSnapshotMigration, /assertion\."expires_at"\s*=\s*NEW\."step_up_expires_at"/);
  assert.doesNotMatch(authoritativeReviewSnapshotMigration, /b\."id"\s*=\s*NEW\."branch_grant_id"/);
  assert.doesNotMatch(authoritativeReviewSnapshotMigration, /r\."id"\s*=\s*NEW\."register_grant_id"/);
  assert.doesNotMatch(authoritativeReviewSnapshotMigration, /NEW\."authority_limit_cents"\s*=\s*r\."manual_payment_review_limit_cents"/);
  assert.match(authoritativeReviewSnapshotMigration, /"consumed_review_id" = NEW\."id", "consumed_at" = evaluation_time/);

  const assertionLock = authoritativeReviewSnapshotMigration.indexOf('FROM "pos_manual_payment_step_up_assertions" assertion');
  const postLockClock = authoritativeReviewSnapshotMigration.indexOf("evaluation_time := clock_timestamp();", assertionLock);
  const temporalValidation = authoritativeReviewSnapshotMigration.indexOf('assertion_record."expires_at" <= evaluation_time', postLockClock);
  const snapshot = authoritativeReviewSnapshotMigration.indexOf('NEW."branch_grant_id" :=', temporalValidation);
  assert.ok(assertionLock > 0 && postLockClock > assertionLock && temporalValidation > postLockClock && snapshot > temporalValidation,
    "validade temporal deve ser avaliada depois dos locks e antes do snapshot");
  assert.match(authoritativeReviewSnapshotMigration, /evaluation_time TIMESTAMPTZ;/);
  assert.doesNotMatch(authoritativeReviewSnapshotMigration.slice(0, postLockClock), /(?:valid_from|valid_until|verified_at|expires_at)"?\s*(?:<=|>=|<|>)\s*evaluation_time/);
});

test("321000 expõe somente issuer/review SECURITY DEFINER causais e mantém o gate hard-off", () => {
  for (const routine of ["pos_manual_issue_step_up_v1", "pos_manual_review_case_v1"]) {
    assert.match(issuerReviewMigration, new RegExp(`CREATE FUNCTION public\\.\"${routine}\"`));
  }
  assert.equal((issuerReviewMigration.match(/SECURITY DEFINER/g) ?? []).length, 2);
  assert.equal((issuerReviewMigration.match(/SET search_path = pg_catalog, public/g) ?? []).length, 2);
  assert.match(issuerReviewMigration, /REVOKE ALL ON FUNCTION public\."pos_manual_issue_step_up_v1"[^;]+FROM PUBLIC/);
  assert.match(issuerReviewMigration, /REVOKE ALL ON FUNCTION public\."pos_manual_review_case_v1"[^;]+FROM PUBLIC/);
  assert.match(issuerReviewMigration, /current_database\(\) \|\| '_si'/);
  assert.match(issuerReviewMigration, /current_database\(\) \|\| '_runtime'/);
  assert.match(issuerReviewMigration, /"state" IS DISTINCT FROM 'review_pending'/);
  for (const field of ["expected_case_version", "decision", "reason_code"]) {
    assert.match(issuerReviewMigration, new RegExp(`ADD COLUMN \"${field}\"`));
    assert.match(issuerReviewMigration, new RegExp(`NEW\\.\"${field}\"`));
    assert.match(issuerReviewMigration, new RegExp(`assertion_record\\.\"${field}\"|\"${field}\"=p_`));
  }
  assert.match(schema, /expectedCaseVersion\s+Int\s+@map\("expected_case_version"\)/);
  assert.match(schema, /decision\s+String/);
  assert.match(schema, /reasonCode\s+String\s+@map\("reason_code"\)/);
  assert.match(issuerReviewMigration, /"expires_at" <= evaluation_time/);
  assert.match(issuerReviewMigration, /"status" = 'active'/);
  assert.match(issuerReviewMigration, /"consumed_review_id" IS NULL/);
  assert.match(issuerReviewMigration, /"version" IS DISTINCT FROM p_expected_version/);
  assert.match(issuerReviewMigration, /pg_catalog\.txid_current\(\)::numeric/);
  assert.match(issuerReviewMigration, /INSERT INTO public\."pos_manual_payment_operations"/);
  assert.match(issuerReviewMigration, /INSERT INTO public\."pos_manual_payment_state_events"/);
  assert.match(issuerReviewMigration, /INSERT INTO public\."pos_manual_payment_attempts"/);
  assert.match(issuerReviewMigration, /INSERT INTO public\."pos_manual_payment_outbox"/);
  assert.match(issuerReviewMigration, /pos_manual_vault_bindings_append_only/);
  for (const boundary of [
    'session_record."status"', 'terminal_record."token_expires_at"', 'terminal_record."last_seen_at"',
    'maker_profile_record."user_id"', 'maker_register_grant."can_manual_payment"',
    'draft_record."revision"', 'claim_record."lease_expires_at"', 'plan_record."state"',
    'slot_record."proof_kind"', 'connector_record."revision"', 'credential_record."revision"',
    'provider_record."family"', 'gate_record."connector_revision"',
  ]) assert.ok(issuerReviewMigration.includes(boundary), `boundary pós-lock ausente: ${boundary}`);
  const finalClock = issuerReviewMigration.lastIndexOf("evaluation_time := pg_catalog.clock_timestamp();");
  const assertionLock = issuerReviewMigration.lastIndexOf('FROM public."pos_manual_payment_step_up_assertions"', finalClock);
  const ledgerWrite = issuerReviewMigration.indexOf('INSERT INTO public."pos_manual_payment_reviews"', finalClock);
  assert.ok(assertionLock > 0 && finalClock > assertionLock && ledgerWrite > finalClock, "clock autoritativo deve ser recapturado após os locks e antes da escrita");
  assert.match(issuerReviewMigration, /'consumed', replay_record\."consumed_review_id" IS NOT NULL/);
  assert.match(issuerReviewMigration, /'currentlyValid'/);
  assert.doesNotMatch(issuerReviewMigration, /UPDATE public\."pos_manual_payment_reconciliation_gates"/);
  assert.doesNotMatch(issuerReviewMigration, /ALTER TABLE public\."pos_payment_plan_slots"/);
});

test("domínio nunca abre caso sem adapter de vault e DTO não expõe hashes ou vaultReference", async () => {
  await assert.rejects(openPosManualPaymentCase({} as never, null, {
    paymentPlanId: "plan-12345678", paymentIndex: 0, makerProfileId: 1, makerUserId: "maker-user",
    rawReference: "safe-reference", occurredAt: new Date(), reasonCode: "manual.external_terminal", idempotencyKey: "manual-idempotency-0001",
  }), /desativada/);
  const dtoBody = service.slice(service.indexOf("function manualCaseDto"), service.indexOf("function normalizeOpenInput"));
  assert.doesNotMatch(dtoBody, /referenceHash|referenceKeyId|vaultReference|stableReferenceIndex/);
  assert.match(dtoBody, /referenceMasked/);
});

test("serviço usa ordem global de locks, relógio do banco, retries e accounting de starvation", () => {
  assert.doesNotMatch(service, /Promise\.all/);
  const lockBody = service.slice(service.indexOf("async function lockManualGraph"), service.indexOf("export function assertManualFoundationBoundary"));
  const orderedMarkers = [
    'FROM "cash_register_sessions"', 'FROM "pos_terminals"', 'FROM "tenant_user_profiles"',
    'FROM "pos_order_claims"', 'FROM "pos_held_sales"', 'FROM "pos_payment_plans"',
    'FROM "pos_connectors"', 'FROM "integration_credentials"',
    'FROM "pos_manual_payment_reconciliation_gates"', 'FROM "pos_manual_payment_cases"',
    'FROM "pos_manual_payment_attempts"', 'FROM "pos_manual_payment_outbox"',
  ];
  let cursor = -1;
  for (const marker of orderedMarkers) {
    const next = lockBody.indexOf(marker, cursor + 1);
    assert.ok(next > cursor, `lock ausente ou fora de ordem: ${marker}`);
    cursor = next;
  }
  assert.match(service, /SELECT clock_timestamp\(\) AS "now"/);
  assert.match(service, /40001/);
  assert.match(service, /40P01/);
  assert.match(service, /deliveryCount >= outbox\.maxDeliveries/);
  assert.match(service, /blockedCount/);
  assert.match(service, /remainingDue/);
  assert.match(service, /maximumQueryCycles/);
});

test("vault é idempotente e possui compensação explícita para token órfão", () => {
  assert.match(service, /bindReference\(input: \{ provider: string; rawReference: string; retentionExpiresAt: Date; idempotencyKey: string \}\)/);
  assert.match(service, /created: boolean/);
  assert.match(service, /reconcileOrphanBinding/);
  assert.match(service, /database_write_rejected/);
  const preflight = service.indexOf("previewGate");
  const binding = service.indexOf("adapter.bindReference");
  assert.ok(preflight > 0 && binding > preflight, "gate deve ser verificado antes da mutação no vault");
});

test("erro do adapter é redigido e nunca propaga rawReference em message/cause", async () => {
  const rawReference = "provider-safe-ref-secret-9876";
  let bindCalls = 0;
  const db = {
    posPaymentPlan: { findUnique: async () => ({ branchId: 1, expiresAt: new Date("2026-08-31T12:15:00.000Z"), slots: [{ paymentIndex: 0, proofKind: "manual", provider: "manual_provider", connectorId: "connector-1", credentialRef: "credential-1" }] }) },
    posManualPaymentReconciliationGate: { findUnique: async () => ({ enabled: true, vaultAdapterId: "vault-test" }) },
  };
  const adapter: PosManualReferenceVaultAdapter = {
    adapterId: "vault-test",
    bindReference: async () => { bindCalls += 1; throw new Error(`adapter leaked ${rawReference}`); },
    reconcileOrphanBinding: async () => "released",
  };
  await assert.rejects(openPosManualPaymentCase(db as never, adapter, {
    paymentPlanId: "plan-12345678", paymentIndex: 0, makerProfileId: 1, makerUserId: "maker-user",
    rawReference, occurredAt: new Date("2026-08-31T12:00:00.000Z"), reasonCode: "manual.external_terminal", idempotencyKey: "manual-idempotency-0002",
  }), error => {
    const record = error as Error & { cause?: unknown };
    assert.doesNotMatch(`${record.message} ${String(record.cause ?? "")}`, new RegExp(rawReference));
    assert.match(record.message, /desativada/);
    return true;
  });
  assert.equal(bindCalls, 0);
});

test("binding nulo do vault falha tipado e redigido", async () => {
  let bindCalls = 0;
  const db = {
    posPaymentPlan: { findUnique: async () => ({ branchId: 1, expiresAt: new Date("2026-08-31T12:15:00.000Z"), slots: [{ paymentIndex: 0, proofKind: "manual", provider: "manual_provider", connectorId: "connector-1", credentialRef: "credential-1" }] }) },
    posManualPaymentReconciliationGate: { findUnique: async () => ({ enabled: true, vaultAdapterId: "vault-test" }) },
  };
  const adapter: PosManualReferenceVaultAdapter = {
    adapterId: "vault-test",
    bindReference: async () => { bindCalls += 1; return null as never; },
    reconcileOrphanBinding: async () => "released",
  };
  await assert.rejects(openPosManualPaymentCase(db as never, adapter, {
    paymentPlanId: "plan-12345678", paymentIndex: 0, makerProfileId: 1, makerUserId: "maker-user",
    rawReference: "provider-safe-ref-9876", occurredAt: new Date("2026-08-31T12:00:00.000Z"), reasonCode: "manual.external_terminal", idempotencyKey: "manual-idempotency-null-binding",
  }), error => {
    assert.ok(error instanceof PosManualReconciliationError);
    assert.equal(error.status, 503);
    assert.equal(error.cause, undefined);
    assert.match(error.message, /desativada/);
    return true;
  });
  assert.equal(bindCalls, 0);
});

test("falha da reconciliação do vault nunca preserva segredo em cause", async () => {
  let bindCalls = 0;
  const leakedToken = "vault://secret-token-do-not-leak";
  const expiresAt = new Date("2026-08-31T12:15:00.000Z");
  const db = {
    posPaymentPlan: { findUnique: async () => ({ branchId: 1, expiresAt, slots: [{ paymentIndex: 0, proofKind: "manual", provider: "manual_provider", connectorId: "connector-1", credentialRef: "credential-1" }] }) },
    posManualPaymentReconciliationGate: { findUnique: async () => ({ enabled: true, vaultAdapterId: "vault-test" }) },
  };
  const adapter: PosManualReferenceVaultAdapter = {
    adapterId: "vault-test",
    bindReference: async () => { bindCalls += 1; return ({
      vaultReference: "vault-token-safe-002", vaultKeyId: "vault-key-1", bindingHash: "c".repeat(64),
      stableReferenceIndex: "invalid-blind-index", referenceHash: `hmac-sha256:v1:${"a".repeat(64)}`,
      referenceKeyId: "reference-key-1", referenceLastFour: "9876", retentionExpiresAt: new Date(expiresAt.valueOf() + 60_000), created: true,
    }); },
    reconcileOrphanBinding: async () => { throw new Error(leakedToken); },
  };
  await assert.rejects(openPosManualPaymentCase(db as never, adapter, {
    paymentPlanId: "plan-12345678", paymentIndex: 0, makerProfileId: 1, makerUserId: "maker-user",
    rawReference: "provider-safe-ref-9876", occurredAt: new Date("2026-08-31T12:00:00.000Z"), reasonCode: "manual.external_terminal", idempotencyKey: "manual-idempotency-cleanup-error",
  }), error => {
    assert.ok(error instanceof PosManualReconciliationError);
    assert.equal(error.status, 503);
    assert.equal(error.cause, undefined);
    assert.doesNotMatch(`${error.message} ${JSON.stringify(error)}`, new RegExp(leakedToken.replaceAll("/", "\\/")));
    assert.match(error.message, /desativada/);
    return true;
  });
  assert.equal(bindCalls, 0);
});

test("binding criado mas inválido é compensado antes de rejeitar abertura", async () => {
  let reconciled = false;
  let bindCalls = 0;
  const expiresAt = new Date("2026-08-31T12:15:00.000Z");
  const db = {
    posPaymentPlan: { findUnique: async () => ({ branchId: 1, expiresAt, slots: [{ paymentIndex: 0, proofKind: "manual", provider: "manual_provider", connectorId: "connector-1", credentialRef: "credential-1" }] }) },
    posManualPaymentReconciliationGate: { findUnique: async () => ({ enabled: true, vaultAdapterId: "vault-test" }) },
  };
  const adapter: PosManualReferenceVaultAdapter = {
    adapterId: "vault-test",
    bindReference: async () => { bindCalls += 1; return ({
      vaultReference: "vault-token-safe-001", vaultKeyId: "vault-key-1", bindingHash: "c".repeat(64),
      stableReferenceIndex: "invalid-blind-index", referenceHash: `hmac-sha256:v1:${"a".repeat(64)}`,
      referenceKeyId: "reference-key-1", referenceLastFour: "9876", retentionExpiresAt: new Date(expiresAt.valueOf() + 60_000), created: true,
    }); },
    reconcileOrphanBinding: async input => {
      assert.equal(input.vaultReference, "vault-token-safe-001");
      assert.equal(input.bindingHash, "c".repeat(64));
      reconciled = true;
      return "released";
    },
  };
  await assert.rejects(openPosManualPaymentCase(db as never, adapter, {
    paymentPlanId: "plan-12345678", paymentIndex: 0, makerProfileId: 1, makerUserId: "maker-user",
    rawReference: "provider-safe-ref-9876", occurredAt: new Date("2026-08-31T12:00:00.000Z"), reasonCode: "manual.external_terminal", idempotencyKey: "manual-idempotency-0003",
  }), /desativada/);
  assert.equal(bindCalls, 0);
  assert.equal(reconciled, false);
});

test("detecção PCI usa Luhn e rejeita PAN formatado ou embutido em texto opaco", () => {
  assert.equal(containsManualPaymentPan("4111 1111 1111 1111"), true);
  assert.equal(containsManualPaymentPan("5555-5555-5555-4444"), true);
  assert.equal(containsManualPaymentPan("4111:1111:1111:1111"), true);
  assert.equal(containsManualPaymentPan("(4111) 1111 1111 1111"), true);
  assert.equal(containsManualPaymentPan("ref4111111111111111x"), true);
  assert.equal(containsManualPaymentPan("manual-ref-20260831-xyz"), false);
  assert.equal(containsManualPaymentPan("123456789012"), false);
  assert.equal(containsManualPaymentPan("sha256:abc4111111111111111def"), true, "a exceção de hash deve existir somente no validador tipado");
  assert.match(service, /isTypedCryptographicVaultReference\(value\.vaultReference\) && containsManualPaymentPan\(value\.vaultReference\)/);
  assert.match(service, /\^vault\[-_:]\[0-9a-f]\{64\}\$/);
});

test("causalidade do provider exige timestamp conclusivo e tolerância limitada", () => {
  const occurredAt = new Date("2026-08-31T10:00:00.000Z"), now = new Date("2026-08-31T10:10:00.000Z");
  assert.throws(() => assertProviderCausality({ outcome: "confirmed_paid" }, occurredAt, now), /sem data causal/);
  assert.throws(() => assertProviderCausality({ outcome: "confirmed_paid", providerOccurredAt: new Date("2026-08-31T09:40:00.000Z") }, occurredAt, now), /diverge/);
  assert.throws(() => assertProviderCausality({ outcome: "confirmed_paid", providerOccurredAt: new Date("2026-08-31T10:05:00.000Z") }, occurredAt, now, new Date("2026-08-31T10:03:00.000Z")), /expiração/);
  assert.doesNotThrow(() => assertProviderCausality({ outcome: "confirmed_paid", providerOccurredAt: new Date("2026-08-31T10:05:00.000Z"), providerSequence: BigInt(1) }, occurredAt, now));
  assert.doesNotThrow(() => assertProviderCausality({ outcome: "unknown" }, occurredAt, now));
});

test("retry reconhece conflitos PostgreSQL diretos e encapsulados pelo Prisma", () => {
  assert.equal(isTransactionConflict({ code: "P2034" }), true);
  assert.equal(isTransactionConflict({ code: "40001" }), true);
  assert.equal(isTransactionConflict({ meta: { code: "40P01" } }), true);
  assert.equal(isTransactionConflict({ code: "P2010", meta: { database_error: "deadlock detected SQLSTATE 40P01" } }), true);
  assert.equal(isTransactionConflict({ code: "P2002" }), false);
});

test("review vincula identidade perfil/usuário e assertion ao hash idempotente", () => {
  assert.match(service, /snapshot\?\.profile\?\.userId !== userId/);
  assert.match(service, /assertLiveManualOperator\(graph, current\.makerProfileId, current\.makerUserId, true\)/);
  assert.match(service, /assertLiveManualReviewer\(graph, input\.checkerProfileId, input\.checkerUserId, current\.amountCents\)/);
  assert.match(service, /assertionHash: input\.assertionHash, decision: input\.decision/);
});

test("attestation integra o hash de completion e qualquer revisão divergente muda replay", () => {
  const base = {
    attemptId: "123e4567-e89b-42d3-a456-426614174000",
    claimToken: "worker:claim-token-0001",
    provider: "manual_provider",
    connectorRevision: 7,
    credentialRevision: 11,
    providerAdapterVersion: "adapter-v3",
    gateConfigHash: "c".repeat(64),
    outcome: "confirmed_paid" as const,
    referenceHash: `hmac-sha256:v1:${"a".repeat(64)}`,
    method: "credit",
    amountCents: 100,
    currency: "BRL",
    evidenceHash: "b".repeat(64),
    providerSequence: BigInt(1),
    providerOccurredAt: new Date("2026-08-31T10:00:00.000Z"),
    authKeyId: "manual-key-v1",
  };
  const hash = hashManualPaymentQueryCompletion(base);
  assert.notEqual(hashManualPaymentQueryCompletion({ ...base, connectorRevision: 8 }), hash);
  assert.notEqual(hashManualPaymentQueryCompletion({ ...base, credentialRevision: 12 }), hash);
  assert.notEqual(hashManualPaymentQueryCompletion({ ...base, providerAdapterVersion: "adapter-v4" }), hash);
  assert.notEqual(hashManualPaymentQueryCompletion({ ...base, gateConfigHash: "d".repeat(64) }), hash);
});

test("worker aplica fairness por sessão, estado unknown e auth key vinculada", () => {
  const claimBody = service.slice(service.indexOf("export async function claimPosManualPaymentQueries"), service.indexOf("export async function completePosManualPaymentQuery"));
  assert.match(service, /row_number\(\) OVER \(PARTITION BY manual_case\."session_id"/);
  assert.match(service, /WHERE "sessionRank"=1/);
  assert.match(service, /current\.state !== "unknown"/);
  assert.match(service, /manualCallbackAuthKeyIds\(graph\.credential\.config\)/);
  assert.match(service, /input\.authKeyId/);
  assert.match(service, /binding do vault preservado para reconciliação/);
  assert.match(claimBody, /now = graph\.now/);
  assert.match(claimBody, /claimExpiresAt = new Date\(now\.valueOf\(\) \+ leaseSeconds \* 1_000\)/);
  assert.match(claimBody, /attemptSequence: attempt\.sequence/);
  assert.match(claimBody, /providerIdempotencyKey: attempt\.providerIdempotencyKey/);
});

test("321e fecha taxonomia e impede provider result legado sem proof", () => {
  assert.match(service, /input\.outcome !== "unknown"[\s\S]*prova autenticada persistida pelo boundary/);
  assert.match(service, /resultKind: "transport_outcome_unknown"[\s\S]*processingResult: "retry_scheduled"/);
  assert.doesNotMatch(service, /resultKind: "retry"|resultKind: "result"|resultKind: "transport_unknown"/);
  assert.match(callbackProofMigration, /\("result_kind"='provider_result'\)=\("provider_proof_id" IS NOT NULL\)/);
  assert.match(callbackProofMigration, /pos_manual_payment_proof_consumptions/);
  assert.match(callbackProofMigration, /pos_manual_record_callback_v1/);
  assert.match(callbackProofMigration, /pos_manual_attest_query_response_v1/);
  assert.match(callbackProofMigration, /pos_manual_complete_delivery_v1/);
  assert.match(callbackProofMigration, /pos_manual_report_transport_v1/);
  for (const invariant of ["cash_register_sessions", "token_expires_at", "last_seen_at", "branch_user_accesses", "pos_register_accesses", "pos_held_sales", "draft_request_hash", "quote_hash", "pos_order_claims", "vault_bindings"]) {
    assert.match(callbackProofMigration, new RegExp(invariant));
  }
  assert.doesNotMatch(callbackProofMigration, /UPDATE public\."pos_manual_payment_reconciliation_gates"[\s\S]*"enabled"=true/);
});
