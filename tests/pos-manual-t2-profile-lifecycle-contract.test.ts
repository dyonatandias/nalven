import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const schema = readFileSync("prisma/tenant/schema.prisma", "utf8");
const specification = readFileSync("docs/erp/pdv/ESPECIFICACAO-EXECUTAVEL-T2A-T2B-RECONCILIACAO-MANUAL.md", "utf8");
const decisions = readFileSync("docs/erp/pdv/DECISOES-EXECUTAVEIS-T2-01.md", "utf8");

function model(name: string) {
  return schema.match(new RegExp(`model ${name} \\{[\\s\\S]*?\\n\\}`, "u"))?.[0] ?? "";
}

test("T2-01 modela três assertions segregadas e consumo one-shot", () => {
  const assertions = [
    ["PosManualProfileAdminAssertion", "pos_manual_profile_admin_assertions"],
    ["PosManualProfileAccountingAssertion", "pos_manual_profile_accounting_assertions"],
    ["PosManualProfileFiscalAssertion", "pos_manual_profile_fiscal_assertions"],
  ] as const;
  for (const [name, table] of assertions) {
    const source = model(name);
    assert.notEqual(source, "", name);
    assert.match(source, /assertionHash\s+String\s+@unique @map\("assertion_hash"\)/);
    assert.match(source, /authorityHash\s+String\s+@map\("authority_hash"\)/);
    assert.match(source, /consumedOperationId\s+BigInt\?\s+@unique @map\("consumed_operation_id"\)/);
    assert.match(source, /consumedAt\s+DateTime\?\s+@map\("consumed_at"\)/);
    assert.match(source, /writeTxid\s+Decimal[^\n]*@map\("write_txid"\) @db\.Decimal\(20, 0\)/);
    assert.match(source, /id\s+String\s+@id @db\.Uuid/);
    assert.doesNotMatch(source, /id\s+String\s+@id @default\(uuid\(\)\)/);
    assert.doesNotMatch(source, /idempotencyKey\s+String\s+@unique/);
    assert.match(source, new RegExp(`@@map\\("${table}"\\)`));
  }
  assert.match(model("PosManualProfileAdminAssertion"), /action\s+String/);
  assert.match(model("PosManualProfileAdminAssertion"), /@@unique\(\[profileId, action, idempotencyKey\]\)/);
  assert.match(model("PosManualProfileAccountingAssertion"), /expectedAccountingPolicyHash\s+String/);
  assert.match(model("PosManualProfileAccountingAssertion"), /@@unique\(\[profileId, idempotencyKey\]\)/);
  assert.match(model("PosManualProfileFiscalAssertion"), /fiscalMode\s+String/);
  assert.match(model("PosManualProfileFiscalAssertion"), /expectedFiscalPolicyHash\s+String/);
  assert.match(model("PosManualProfileFiscalAssertion"), /@@unique\(\[profileId, idempotencyKey\]\)/);
});

test("T2-01 modela operation, event e contexto owner-only sem segredo bruto", () => {
  const operation = model("PosManualProfileOperation");
  const event = model("PosManualProfileStateEvent");
  const context = model("PosManualT2LockContext");
  assert.match(operation, /@@unique\(\[profileId, action, idempotencyKey\]\)/);
  assert.doesNotMatch(operation, /@@unique\(\[action, idempotencyKey\]\)/);
  assert.match(operation, /@@unique\(\[id, profileId, action\]\)/);
  assert.match(event, /operationId\s+BigInt\s+@unique/);
  for (const field of ["profileId", "branchId", "profileVersion", "fromState", "toState", "configHash", "writeTxid"]) assert.match(event, new RegExp(`\\b${field}\\b`));
  for (const field of ["backendPid", "transactionTxid", "callerRoleHash", "capability", "aggregateKind", "aggregateId", "nonceHash"]) assert.match(context, new RegExp(`\\b${field}\\b`));
  assert.doesNotMatch(schema, /assertion(?:Token|Handle|Secret)\s/u);
  assert.doesNotMatch(context, /\bnonce\s+String/u);
});

test("decisões fecham handle, TTL, draft imutável e gate hard-off", () => {
  assert.match(decisions, /gera 32 bytes aleatórios/);
  assert.match(decisions, /persiste somente `sha256\(handle\)`/);
  assert.match(decisions, /TTL é fixo em 120 segundos/);
  assert.match(decisions, /não devolve novamente o handle/);
  assert.match(decisions, /Profiles são imutáveis por `\(branch_id, version\)`/);
  assert.match(decisions, /preserva `enabled=false`/);
  assert.match(decisions, /não remove lock de trigger antes de todos os producers existentes usarem/);
});

test("especificação congela as seis assinaturas e ACLs nominais", () => {
  for (const signature of [
    "pos_manual_issue_profile_admin_assertion_v1",
    "pos_manual_issue_profile_accounting_assertion_v1",
    "pos_manual_issue_profile_fiscal_assertion_v1",
    "pos_manual_put_finalization_profile_v1",
    "pos_manual_activate_finalization_profile_v1",
    "pos_manual_retire_finalization_profile_v1",
  ]) assert.match(specification, new RegExp(`public\\.${signature}\\(`));
  assert.match(specification, /`_mpi`, `_mpa` e `_mpf` recebem apenas suas funções emissoras/);
  assert.match(specification, /runtime admin\s+recebe apenas `put`/);
  assert.match(specification, /`_mh` recebe apenas `activate\/retire`/);
});

test("retrofit histórico cobre todo producer atual de operation/case", () => {
  const producers = new Map([
    ["prisma/tenant/migrations/20260829321000_pos_manual_payment_issuer_review_procedures/migration.sql", ["pos_manual_review_case_v1"]],
    ["prisma/tenant/migrations/20260829321100_pos_manual_payment_callback_t1_proofs/migration.sql", ["pos_manual_record_callback_v1", "pos_manual_attest_query_response_v1", "pos_manual_complete_delivery_v1", "pos_manual_report_transport_v1"]],
    ["prisma/tenant/migrations/20260829321110_pos_manual_payment_worker_claim/migration.sql", ["pos_manual_claim_queries_v1"]],
    ["prisma/tenant/migrations/20260829321200_pos_manual_open_vault_capabilities/migration.sql", ["pos_manual_open_case_v1"]],
  ]);
  for (const [path, names] of producers) {
    const sql = readFileSync(path, "utf8");
    for (const name of names) assert.match(sql, new RegExp(`FUNCTION public\\."${name}"\\(`), `${path}: ${name}`);
  }
  const historicalGuards = readFileSync("prisma/tenant/migrations/20260829320000_pos_manual_payment_reconciliation/migration.sql", "utf8")
    + readFileSync("prisma/tenant/migrations/20260829321100_pos_manual_payment_callback_t1_proofs/migration.sql", "utf8");
  for (const guard of ["guard_pos_manual_operation", "protect_pos_manual_case", "block_pos_session_with_manual_case", "block_plan_release_with_manual_case", "block_handoff_with_manual_case"]) assert.match(historicalGuards, new RegExp(guard));
  assert.match(specification, /T2-01 substitui ainda `guard_pos_manual_operation`/);
});

test("roots legadas têm allowlist nominal por producer, tabela e DML", () => {
  const migration = readFileSync("prisma/tenant/migrations/20260829322100_pos_manual_payment_t2_profile_lifecycle/migration.sql", "utf8");
  for (const capability of [
    "legacy_manual:open_case:case", "legacy_manual:open_case:operation", "legacy_manual:open_case:state_event",
    "legacy_manual:review:case", "legacy_manual:review:operation", "legacy_manual:review:state_event",
    "legacy_manual:record_callback:case", "legacy_manual:complete_delivery:case",
    "legacy_manual:report_transport:case", "legacy_manual:report_transport:case_evidence", "legacy_manual:claim_queries:case",
  ]) assert.match(migration, new RegExp(capability.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")), capability);
  assert.doesNotMatch(migration, /legacy_manual:attest_query_response:(?:case|operation|state_event)/u);
  const attestSource = readFileSync("prisma/tenant/migrations/20260829321100_pos_manual_payment_callback_t1_proofs/migration.sql", "utf8")
    .match(/CREATE FUNCTION public\."pos_manual_attest_query_response_v1"\([\s\S]*?END; \$\$;/u)?.[0] ?? "";
  assert.notEqual(attestSource, "");
  assert.doesNotMatch(attestSource, /(?:INSERT INTO|UPDATE) public\."pos_manual_payment_(?:cases|operations|state_events)"/u);
  for (const projection of [
    "pos_manual_t2_legacy_case_projection_v1",
    "pos_manual_t2_legacy_operation_projection_v1",
    "pos_manual_t2_legacy_state_event_projection_v1",
  ]) {
    const body = migration.match(new RegExp(`CREATE FUNCTION public\\."${projection}"[\\s\\S]*?\\$function\\$;`, "u"))?.[0] ?? "";
    assert.notEqual(body, "", projection);
    assert.doesNotMatch(body, /pos_manual_t2_write_roots|pos_manual_t2_lock_contexts|pg_advisory|FOR UPDATE|FOR SHARE/u);
  }
  assert.match(migration, /legacy_manual:report_transport:case_evidence[\s\S]*p_action='evidence_update'[\s\S]*p_dml_operation='UPDATE'/u);
  assert.doesNotMatch(migration, /legacy_manual:[^']*\*|legacy_manual:generic/u);
  for (const authority of ["manual_callback", "manual_worker", "manual_vault_binder"]) assert.match(migration, new RegExp(`'${authority}'`));
  assert.match(migration, /pos_manual_t2_write_authority_capability_v1/);
  assert.match(migration, /legacy_manual:open_case:%'[\s\S]*manual_vault_binder/u);
  assert.match(migration, /legacy_manual:record_callback:%'[\s\S]*manual_callback/u);
  for (const observer of [
    "pos_manual_t2_observe_legacy_case_v1",
    "pos_manual_t2_observe_legacy_operation_v1",
    "pos_manual_t2_observe_legacy_state_event_v1",
  ]) {
    const body = migration.match(new RegExp(`CREATE FUNCTION public\\."${observer}"\\(\\)[\\s\\S]*?\\$function\\$;`, "u"))?.[0] ?? "";
    assert.notEqual(body, "", observer);
    assert.doesNotMatch(body, /\b(?:SELECT|FOR UPDATE|FOR SHARE|pg_advisory)\b|pos_manual_payment_cases|pos_manual_payment_operations|pos_manual_payment_state_events/iu);
    assert.match(body, /pos_manual_t2_observe_legacy_write_v1/);
  }
  for (const rootHelper of [
    "pos_manual_t2_open_legacy_case_root_v1",
    "pos_manual_t2_open_legacy_operation_root_v1",
    "pos_manual_t2_open_legacy_state_event_root_v1",
  ]) {
    const body = migration.match(new RegExp(`CREATE FUNCTION public\\."${rootHelper}"[\\s\\S]*?\\$function\\$;`, "u"))?.[0] ?? "";
    assert.notEqual(body, "", rootHelper);
    assert.match(body, /pos_manual_t2_write_observation_digest_v1/);
    assert.match(body, /pos_manual_t2_open_write_root_v1/);
    assert.doesNotMatch(body.slice(0, body.indexOf("RETURNS")), /digest|jsonb/iu);
  }
});

test("open_case versionado reserva identidades e abre cada root imediatamente antes do DML", () => {
  const migration = readFileSync("prisma/tenant/migrations/20260829322100_pos_manual_payment_t2_profile_lifecycle/migration.sql", "utf8");
  const body = migration.match(/CREATE OR REPLACE FUNCTION public\."pos_manual_open_case_v1_t2_01_impl"[\s\S]*?\$function\$;/u)?.[0] ?? "";
  assert.notEqual(body, "");
  assert.match(body, /nextval\(pg_catalog\.pg_get_serial_sequence\('public\.pos_manual_payment_operations','id'\)::pg_catalog\.regclass\)/u);
  assert.match(body, /nextval\(pg_catalog\.pg_get_serial_sequence\('public\.pos_manual_payment_state_events','id'\)::pg_catalog\.regclass\)/u);
  for (const [helper, dml] of [
    ["pos_manual_t2_open_legacy_case_root_v1", 'INSERT INTO public."pos_manual_payment_cases"'],
    ["pos_manual_t2_open_legacy_operation_root_v1", 'INSERT INTO public."pos_manual_payment_operations"'],
    ["pos_manual_t2_open_legacy_state_event_root_v1", 'INSERT INTO public."pos_manual_payment_state_events"'],
  ] as const) {
    const helperAt = body.indexOf(helper);
    const dmlAt = body.indexOf(dml, helperAt);
    assert.ok(helperAt >= 0 && dmlAt > helperAt, `${helper} precede ${dml}`);
    assert.doesNotMatch(body.slice(helperAt + helper.length, dmlAt), /\b(?:INSERT\s+INTO|UPDATE\s+public|DELETE\s+FROM|SELECT[\s\S]*?\s+FROM)\b/iu);
  }
  assert.doesNotMatch(body.slice(0, body.indexOf("RETURNS")), /digest|projection|jsonb/iu);
});

test("cinco producers legados materializam targets e o cutover dos guards é observer-only", () => {
  const migration = readFileSync("prisma/tenant/migrations/20260829322100_pos_manual_payment_t2_profile_lifecycle/migration.sql", "utf8");
  const expectedRoots = new Map([
    ["pos_manual_review_case_v1_t2_01_impl", 3],
    ["pos_manual_record_callback_v1_t2_01_impl", 3],
    ["pos_manual_complete_delivery_v1_t2_01_impl", 3],
    ["pos_manual_report_transport_v1_t2_01_impl", 4],
    ["pos_manual_claim_queries_v1_t2_01_impl", 3],
  ]);
  for (const [name, rootCount] of expectedRoots) {
    const body = migration.match(new RegExp(`CREATE OR REPLACE FUNCTION public\\."${name}"[\\s\\S]*?(?:\\$function\\$;|END; \\$\\$;)`, "u"))?.[0] ?? "";
    assert.notEqual(body, "", name);
    assert.equal(body.match(/pos_manual_t2_open_legacy_(?:case|operation|state_event)_root_v1/gu)?.length, rootCount, name);
    assert.match(body, /nextval\(pg_catalog\.pg_get_serial_sequence\('public\.pos_manual_payment_operations','id'\)::pg_catalog\.regclass\)/u);
    assert.match(body, /nextval\(pg_catalog\.pg_get_serial_sequence\('public\.pos_manual_payment_state_events','id'\)::pg_catalog\.regclass\)/u);
    assert.doesNotMatch(body, /pg_get_functiondef/u);
  }
  assert.doesNotMatch(migration, /\$strip_trigger_locks\$|historical guard body changed/u);
  for (const guard of ["protect_pos_manual_case", "guard_pos_manual_operation", "guard_pos_manual_state_event"]) {
    const matches = [...migration.matchAll(new RegExp(`CREATE OR REPLACE FUNCTION public\\."${guard}"\\(\\)[\\s\\S]*?\\$function\\$;`, "gu"))];
    const body = matches.at(-1)?.[0] ?? "";
    assert.notEqual(body, "", guard);
    assert.match(body, /pos_manual_t2_observe_legacy_write_v1/u);
    assert.doesNotMatch(body, /pos_manual_payment_(?:cases|operations|state_events)|FOR UPDATE|FOR SHARE|pg_advisory/u);
  }
});

test("retrofit operacional expõe somente três ABIs tipadas e guards one-shot puros", () => {
  const migration = readFileSync("prisma/tenant/migrations/20260829322100_pos_manual_payment_t2_profile_lifecycle/migration.sql", "utf8");
  for (const signature of [
    /pos_manual_prepare_session_transition_v1"\(\s*p_action text,p_session_id integer,p_expected_version integer,p_actor_profile_id integer,p_actor_user_id text,p_idempotency_key text,p_request_hash text/u,
    /pos_manual_prepare_handoff_transition_v1"\(\s*p_action text,p_handoff_id text,p_session_id integer,p_expected_session_version integer,p_expected_handoff_revision integer,\s*p_target_operator_profile_id integer,p_actor_profile_id integer,p_actor_user_id text,p_idempotency_key text,p_request_hash text,p_reason text,p_expires_at timestamptz,p_held_sale_snapshot jsonb\)/u,
    /pos_manual_prepare_plan_release_v1"\(\s*p_action text,p_plan_id text,p_expected_version integer,p_actor_user_id text,p_idempotency_key text,p_request_hash text/u,
  ]) assert.match(migration, signature);

  for (const guard of ["block_pos_session_with_manual_case", "block_handoff_with_manual_case", "block_plan_release_with_manual_case"]) {
    const body = migration.match(new RegExp(`CREATE OR REPLACE FUNCTION public\\."${guard}"\\(\\)[\\s\\S]*?\\$function\\$;`, "u"))?.[0] ?? "";
    assert.notEqual(body, "", guard);
    assert.match(body, /DELETE FROM public\."pos_manual_t2_lock_contexts"/);
    assert.match(body, /GET DIAGNOSTICS consumed=ROW_COUNT/);
    assert.match(body, /IF consumed<>1 THEN RAISE EXCEPTION/);
    assert.doesNotMatch(body, /\b(FOR UPDATE|FOR SHARE|pg_advisory|pos_manual_payment_cases)\b/);
  }
});

test("consumo de assertions de profile usa somente OLD/NEW, contexto owner-only e FKs causais", () => {
  const migration = readFileSync("prisma/tenant/migrations/20260829322100_pos_manual_payment_t2_profile_lifecycle/migration.sql", "utf8");
  const body = migration.match(/CREATE FUNCTION public\."guard_pos_manual_profile_assertion_v1"\(\)[\s\S]*?\$function\$;/u)?.[0] ?? "";
  assert.notEqual(body, "");
  assert.match(body, /pos_manual_t2_lock_contexts/);
  assert.match(body, /NEW\."consumed_at":=pg_catalog\.clock_timestamp\(\)/);
  assert.doesNotMatch(body, /pos_manual_profile_operations/);
  assert.doesNotMatch(body, /\b(?:FOR\s+(?:UPDATE|SHARE)|pg_advisory)\b/iu);
  for (const constraint of [
    "pos_manual_profile_ops_admin_causal_fkey",
    "pos_manual_profile_ops_account_causal_fkey",
    "pos_manual_profile_ops_fiscal_causal_fkey",
  ]) assert.match(migration, new RegExp(constraint));
});

test("migration isolada revoga PUBLIC de helpers e guards T2-01 internos", () => {
  const migration = readFileSync("prisma/tenant/migrations/20260829322100_pos_manual_payment_t2_profile_lifecycle/migration.sql", "utf8");
  for (const signature of [
    'public."pos_manual_t2_json_dlp_safe_v1"(text,jsonb)',
    'public."pos_manual_t2_json_keys_exact_v1"(jsonb,text[])',
    'public."pos_manual_t2_payment_plan_draft_snapshot_hash_v1"(text)',
    'public."protect_held_sale_item_with_open_payment_plan"()',
    'public."protect_pos_payment_plan_quote_line"()',
    'public."protect_pos_payment_plan_slot"()',
    'public."validate_pos_payment_plan_activation"()',
    'public."protect_pos_payment_plan"()',
  ]) assert.match(migration, new RegExp(signature.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")));
});
