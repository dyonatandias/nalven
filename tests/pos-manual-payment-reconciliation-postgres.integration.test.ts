import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../generated/tenant/client";

const connectionString = process.env.POS_TEST_DATABASE_URL;

test("320000 instala aggregate e mantém gate manual impossível de habilitar", { skip: !connectionString }, async () => {
  const db = client(), token = randomUUID().replaceAll("-", "");
  try {
    const branch = await db.branch.create({ data: { code: `M${token}`, name: `Manual ${token}`, legalName: `Manual ${token} Ltda`, document: `MAN${token}` } });
    const register = await db.posRegister.create({ data: { branchId: branch.id, code: `R${token}`, name: "Manual register" } });
    const provider = `manual_${token}`;
    await db.integrationProvider.create({ data: { id: provider, family: "payment", label: "Manual provider", description: "fixture", recipientType: "none", authType: "api_key", capabilities: {}, credentialSchema: {} } });
    const credential = await db.integrationCredential.create({ data: { id: `cred-${token}`, providerId: provider, label: "Manual credential", enabled: true, config: {} } });
    const connector = await db.posConnector.create({ data: { id: `connector-${token}`, branchId: branch.id, registerId: register.id, type: `manual_${token}`, provider, credentialRef: credential.id, status: "active", settings: { capabilities: ["manual_reference_query"], manualReconciliation: { enabled: true, vaultBindingRequired: true } } } });
    const disabled = await db.posManualPaymentReconciliationGate.create({ data: { connectorId: connector.id, connectorRevision: connector.revision, credentialRef: credential.id, credentialRevision: credential.revision } });
    assert.equal(disabled.enabled, false);
    await assert.rejects(db.posManualPaymentReconciliationGate.update({ where: { connectorId: connector.id }, data: { enabled: true, vaultAdapterId: "vault-test", providerAdapterVersion: "1", enabledBy: "test", enabledAt: new Date(), configHash: "a".repeat(64) } }), /hard-disabled/);
    assert.equal((await db.posManualPaymentReconciliationGate.findUniqueOrThrow({ where: { connectorId: connector.id } })).enabled, false);
    await assert.rejects(db.posManualPaymentReconciliationGate.update({ where: { connectorId: connector.id }, data: { connectorRevision: connector.revision + 1 } }), /immutable to runtime/);
    await db.posConnector.update({ where: { id: connector.id }, data: { revision: 999 } });
    assert.equal((await db.posConnector.findUniqueOrThrow({ where: { id: connector.id } })).revision, connector.revision);
    await db.posConnector.update({ where: { id: connector.id }, data: { settings: { capabilities: ["manual_reference_query"], manualReconciliation: { enabled: false } } } });
    assert.equal((await db.posConnector.findUniqueOrThrow({ where: { id: connector.id } })).revision, connector.revision + 1);
    await db.posConnector.update({ where: { id: connector.id }, data: { mode: "local_agent" } });
    assert.equal((await db.posConnector.findUniqueOrThrow({ where: { id: connector.id } })).revision, connector.revision + 2);
    await db.integrationCredential.update({ where: { id: credential.id }, data: { revision: 999 } });
    assert.equal((await db.integrationCredential.findUniqueOrThrow({ where: { id: credential.id } })).revision, credential.revision);
    await db.integrationCredential.update({ where: { id: credential.id }, data: { config: { endpoint: "https://manual.invalid/query" } } });
    assert.equal((await db.integrationCredential.findUniqueOrThrow({ where: { id: credential.id } })).revision, credential.revision + 1);
    await db.integrationCredential.update({ where: { id: credential.id }, data: { revision: 999, config: { endpoint: "https://manual.invalid/query" } } });
    assert.equal((await db.integrationCredential.findUniqueOrThrow({ where: { id: credential.id } })).revision, credential.revision + 1);
    await db.integrationCredential.update({ where: { id: credential.id }, data: { sandbox: true } });
    assert.equal((await db.integrationCredential.findUniqueOrThrow({ where: { id: credential.id } })).revision, credential.revision + 2);
  } finally {
    await db.$disconnect();
  }
});

test("320000 expõe todos os ledgers e preserva legado selado", { skip: !connectionString }, async () => {
  const db = client();
  try {
    const names = await db.$queryRawUnsafe<Array<{ table_name: string }>>(`SELECT table_name FROM information_schema.tables WHERE table_schema='public' AND table_name LIKE 'pos_manual_payment_%' ORDER BY table_name`);
    const actual = new Set(names.map(row => row.table_name));
    for (const table of ["pos_manual_payment_cases", "pos_manual_payment_vault_bindings", "pos_manual_payment_step_up_assertions", "pos_manual_payment_reviews", "pos_manual_payment_attempts", "pos_manual_payment_outbox", "pos_manual_payment_delivery_results", "pos_manual_payment_callbacks", "pos_manual_payment_observations", "pos_manual_payment_incidents", "pos_manual_payment_applications", "pos_manual_payment_operations", "pos_manual_payment_state_events"]) assert.ok(actual.has(table), table);
    const legacyGuard = await db.$queryRawUnsafe<Array<{ definition: string }>>(`SELECT pg_get_functiondef('seal_legacy_pos_manual_payment_reference()'::regprocedure) AS definition`);
    assert.match(legacyGuard[0]?.definition ?? "", /sealed history-only/);
    await assert.rejects(
      db.$executeRawUnsafe(`INSERT INTO "pos_manual_payment_references" ("id") VALUES ($1)`, `legacy-${randomUUID()}`),
      /sealed history-only/,
    );
    const appendOnlyTriggers = await db.$queryRawUnsafe<Array<{ tgname: string }>>(`
      SELECT tgname
      FROM pg_trigger
      WHERE NOT tgisinternal AND tgname IN (
        'pos_manual_reviews_append_only',
        'pos_manual_delivery_append_only',
        'pos_manual_callbacks_append_only',
        'pos_manual_observations_append_only',
        'pos_manual_operations_append_only',
        'pos_manual_state_events_append_only',
        'pos_manual_case_open_commit_guard',
        'pos_manual_application_graph_guard'
      )
    `);
    assert.equal(appendOnlyTriggers.length, 8);
  } finally {
    await db.$disconnect();
  }
});

test("320100 instala snapshot autoritativo e rejeita review sem agregado causal", { skip: !connectionString }, async () => {
  const db = client(), caseId = randomUUID(), reviewId = randomUUID();
  try {
    const guards = await db.$queryRawUnsafe<Array<{ enabled: string; definition: string }>>(`
      SELECT trigger.tgenabled::text AS enabled,
             pg_get_functiondef(trigger.tgfoid) AS definition
        FROM pg_trigger trigger
       WHERE trigger.tgrelid='pos_manual_payment_reviews'::regclass
         AND trigger.tgname='pos_manual_review_guard'
         AND NOT trigger.tgisinternal
    `);
    assert.equal(guards.length, 1);
    assert.equal(guards[0]?.enabled, "O");
    const definition = guards[0]?.definition ?? "";
    assert.match(definition, /NEW\."branch_grant_id" := branch_grant_record\."id"/);
    assert.match(definition, /NEW\."step_up_verified_at" := assertion_record\."verified_at"/);
    assert.doesNotMatch(definition, /assertion\."verified_at"\s*=\s*NEW\."step_up_verified_at"/);
    assert.doesNotMatch(definition, /NEW\."authority_limit_cents"\s*=\s*r\."manual_payment_review_limit_cents"/);

    await assert.rejects(
      db.$executeRawUnsafe(`
        INSERT INTO "pos_manual_payment_reviews" (
          "id", "case_id", "decision", "maker_profile_id", "maker_user_id",
          "checker_profile_id", "checker_user_id", "step_up_evidence_id",
          "step_up_proof_hash", "step_up_verified_at", "step_up_expires_at",
          "branch_grant_id", "register_grant_id", "authority_limit_cents",
          "reason_code", "idempotency_key", "request_hash", "write_txid"
        ) VALUES (
          $1::uuid, $2::uuid, 'authorize_query', 1, 'maker-missing', 2, 'checker-missing',
          $3, $4, clock_timestamp(), clock_timestamp() + interval '5 minutes',
          1, 1, 100, 'manual.external_terminal', $5, $6, txid_current()
        )
      `, reviewId, caseId, randomUUID(), "a".repeat(64), `review-${reviewId}`, "b".repeat(64)),
      /manual payment review requires distinct checker, live grants and bounded step-up/,
    );
    assert.equal(await db.posManualPaymentReview.count({ where: { id: reviewId } }), 0);
  } finally {
    await db.$disconnect();
  }
});

function client() {
  if (!connectionString) throw new Error("POS_TEST_DATABASE_URL ausente");
  return new PrismaClient({ adapter: new PrismaPg({ connectionString }) });
}
