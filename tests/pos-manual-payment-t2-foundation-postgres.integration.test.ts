import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { readdirSync } from "node:fs";
import { promisify } from "node:util";
import test from "node:test";
import { Client, type DatabaseError } from "pg";
import { assertPosManualT2DlpSafe } from "../lib/erp/pos-manual-t2-canonical";
import {
  POS_MANUAL_T2_DLP_CLASS_A_VECTORS,
  POS_MANUAL_T2_DLP_CLASS_B_VECTORS,
  POS_MANUAL_T2_DLP_SAFE_VECTORS,
} from "./fixtures/pos-manual-t2-dlp-vectors";

const execFileAsync = promisify(execFile);
const adminConnectionString = process.env.TENANT_ROLE_TEST_ADMIN_DATABASE_URL;
const t2MigrationName = "20260829322000_pos_manual_payment_t2_foundation";
const t2MigrationFile = `prisma/tenant/migrations/${t2MigrationName}/migration.sql`;
const t2LifecycleMigrationFile = "prisma/tenant/migrations/20260829322100_pos_manual_payment_t2_profile_lifecycle/migration.sql";

test("vetores DLP Class A/B são compartilhados pelo canônico TypeScript e pelo PostgreSQL", () => {
  for (const vector of POS_MANUAL_T2_DLP_CLASS_A_VECTORS) {
    assert.throws(() => assertPosManualT2DlpSafe({ actorUserId: vector.value }), /T2_DLP_CLASS_A_FORBIDDEN/, vector.label);
  }
  for (const vector of POS_MANUAL_T2_DLP_CLASS_B_VECTORS) {
    assert.throws(() => assertPosManualT2DlpSafe({ actorUserId: vector.value }), /T2_DLP_CLASS_B_FORBIDDEN/, vector.label);
  }
  for (const vector of POS_MANUAL_T2_DLP_SAFE_VECTORS) {
    assert.doesNotThrow(() => assertPosManualT2DlpSafe({ actorUserId: vector.value }), vector.label);
  }
});

test("T2-00 aborta atomicamente diante de application legado ou gate habilitado", { skip: !adminConnectionString, timeout: 240_000 }, async () => {
  const token = randomBytes(5).toString("hex");
  const templateDatabase = `t2_pre_${token}`;
  const applicationDatabase = `t2_app_${token}`;
  const gateDatabase = `t2_gate_${token}`;
  const admin = new Client({ connectionString: adminConnectionString });
  await admin.connect();
  try {
    await admin.query(`CREATE DATABASE "${templateDatabase}"`);
    await runPsqlFiles(databaseUrl(adminConnectionString!, templateDatabase), previousMigrationFiles());
    await admin.query(`CREATE DATABASE "${applicationDatabase}" TEMPLATE "${templateDatabase}"`);
    await admin.query(`CREATE DATABASE "${gateDatabase}" TEMPLATE "${templateDatabase}"`);

    const application = new Client({ connectionString: databaseUrl(adminConnectionString!, applicationDatabase) });
    await application.connect();
    try {
      await application.query("SET session_replication_role=replica");
      await application.query(`
        INSERT INTO pos_manual_payment_applications(
          case_id,payment_plan_id,payment_index,sale_draft_id,quote_hash,
          expected_plan_version,sale_idempotency_key,sale_request_hash,state,
          idempotency_key,request_hash,write_txid,reserved_by_profile_id,reserved_at
        ) VALUES (
          gen_random_uuid(),'fabricated-plan',0,'fabricated-draft',repeat('a',64),
          1,'fabricated-sale-idem',repeat('b',64),'pending',
          'fabricated-app-idem',repeat('c',64),txid_current(),1,clock_timestamp()
        )
      `);
      await application.query("SET session_replication_role=origin");
    } finally {
      await application.end();
    }
    await assertMigrationRejected(databaseUrl(adminConnectionString!, applicationDatabase), /T2-00 requires an empty legacy application table/);
    await assertPreflightWasAtomic(databaseUrl(adminConnectionString!, applicationDatabase));

    const gate = new Client({ connectionString: databaseUrl(adminConnectionString!, gateDatabase) });
    await gate.connect();
    try {
      await gate.query("SET session_replication_role=replica");
      await gate.query(`
        INSERT INTO pos_manual_payment_reconciliation_gates(
          connector_id,connector_revision,credential_ref,credential_revision,enabled,
          vault_adapter_id,provider_adapter_version,enabled_by,enabled_at,config_hash
        ) VALUES (
          'fabricated-connector',0,'fabricated-credential',0,true,
          'fabricated-vault','1','fabricated-auditor',clock_timestamp(),repeat('d',64)
        )
      `);
      await gate.query("SET session_replication_role=origin");
    } finally {
      await gate.end();
    }
    await assertMigrationRejected(databaseUrl(adminConnectionString!, gateDatabase), /T2-00 requires every manual reconciliation gate disabled/);
    await assertPreflightWasAtomic(databaseUrl(adminConnectionString!, gateDatabase));
  } finally {
    for (const database of [applicationDatabase, gateDatabase, templateDatabase]) {
      await admin.query("SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname=$1", [database]).catch(() => undefined);
      await admin.query(`DROP DATABASE IF EXISTS "${database}"`).catch(() => undefined);
    }
    await admin.end();
  }
});

test("T2-00 fresh permanece hard-off com catálogo, DLP e guards fechados", { skip: !adminConnectionString, timeout: 240_000 }, async () => {
  const database = `t2_fresh_${randomBytes(5).toString("hex")}`;
  const admin = new Client({ connectionString: adminConnectionString });
  await admin.connect();
  try {
    await admin.query(`CREATE DATABASE "${database}"`);
    const tenantUrl = databaseUrl(adminConnectionString!, database);
    await execFileAsync("npx", ["prisma", "migrate", "deploy", "--config", "prisma.tenant.config.ts"], {
      timeout: 180_000,
      env: { ...process.env, TENANT_DATABASE_URL: tenantUrl },
    });
    await execFileAsync("npx", ["tsx", "prisma/tenant/seed.ts"], {
      timeout: 120_000,
      env: { ...process.env, TENANT_DATABASE_URL: tenantUrl },
    });

    const tenant = new Client({ connectionString: tenantUrl });
    await tenant.connect();
    try {
      const relations = [
        "pos_manual_finalization_profiles",
        "pos_manual_application_snapshots",
        "pos_manual_application_manifest_entries",
        "pos_manual_application_effects",
      ];
      for (const relation of relations) {
        assert.equal((await tenant.query("SELECT to_regclass($1) IS NOT NULL present", [`public.${relation}`])).rows[0]?.present, true, relation);
        assert.equal((await tenant.query(`SELECT count(*)::integer count FROM "${relation}"`)).rows[0]?.count, 0, relation);
        assert.equal((await tenant.query(`
          SELECT EXISTS (
            SELECT 1 FROM pg_class protected
            CROSS JOIN LATERAL aclexplode(coalesce(protected.relacl,acldefault('r',protected.relowner))) privilege
            WHERE protected.oid=$1::regclass AND privilege.grantee=0
          ) allowed
        `, [`public.${relation}`])).rows[0]?.allowed, false, relation);
      }
      for (const sequence of ["pos_manual_application_manifest_entries_id_seq", "pos_manual_application_effects_id_seq"]) {
        assert.equal((await tenant.query(`
          SELECT EXISTS (
            SELECT 1 FROM pg_class protected
            CROSS JOIN LATERAL aclexplode(coalesce(protected.relacl,acldefault('S',protected.relowner))) privilege
            WHERE protected.oid=$1::regclass AND privilege.grantee=0
          ) allowed
        `, [`public.${sequence}`])).rows[0]?.allowed, false, sequence);
      }
      assert.equal((await tenant.query("SELECT count(*)::integer count FROM pos_manual_payment_applications")).rows[0]?.count, 0);
      assert.equal((await tenant.query("SELECT count(*)::integer count FROM pos_manual_payment_reconciliation_gates WHERE enabled OR finalization_profile_id IS NOT NULL OR finalization_profile_version IS NOT NULL OR finalization_profile_hash IS NOT NULL")).rows[0]?.count, 0);

      const helperSignatures = [
        "pos_manual_canonical_json_impl_v1(jsonb,integer)",
        "pos_manual_canonical_json_v1(jsonb)",
        "pos_manual_hash_canonical_json_v1(text,jsonb)",
        "pos_manual_utc_micros_v1(timestamp with time zone)",
        "pos_manual_t2_dlp_walk_impl_v1(text,jsonb,integer)",
        "pos_manual_t2_json_dlp_safe_v1(text,jsonb)",
        "guard_pos_manual_t2_profile_inert()",
        "guard_pos_manual_t2_application_inert()",
        "guard_pos_manual_t2_sale_link_inert()",
        "guard_pos_manual_t2_payment_link_inert()",
      ];
      for (const signature of helperSignatures) {
        const shape = await tenant.query<{ exists: boolean; public_execute: boolean; security_definer: boolean; proconfig: string[] | null }>(`
          SELECT routine.oid IS NOT NULL exists,
                 EXISTS (
                   SELECT 1 FROM aclexplode(coalesce(routine.proacl,acldefault('f',routine.proowner))) privilege
                   WHERE privilege.grantee=0 AND privilege.privilege_type='EXECUTE'
                 ) public_execute,
                 coalesce(routine.prosecdef,false) security_definer,
                 routine.proconfig
            FROM (SELECT to_regprocedure($1) oid) expected
            LEFT JOIN pg_proc routine ON routine.oid=expected.oid
        `, [signature]);
        assert.equal(shape.rows[0]?.exists, true, signature);
        assert.equal(shape.rows[0]?.public_execute, false, signature);
        assert.equal(shape.rows[0]?.security_definer, true, signature);
        assert.deepEqual(shape.rows[0]?.proconfig, ["search_path=pg_catalog"], signature);
      }

      assert.equal((await tenant.query("SELECT pos_manual_canonical_json_v1('{\"b\":2,\"a\":1}'::jsonb)=pos_manual_canonical_json_v1('{\"a\":1,\"b\":2}'::jsonb) same")).rows[0]?.same, true);
      assert.equal((await tenant.query("SELECT pos_manual_hash_canonical_json_v1('t2-effect-v1','{\"schemaVersion\":1}'::jsonb)<>pos_manual_hash_canonical_json_v1('t2-manifest-v1','{\"schemaVersion\":1}'::jsonb) separated")).rows[0]?.separated, true);
      await assertSqlState(tenant, "SELECT pos_manual_hash_canonical_json_v1('unknown-domain','{}'::jsonb)", "22023");
      assert.equal((await tenant.query("SELECT pos_manual_t2_json_dlp_safe_v1('operational_actor','{\"schemaVersion\":1}'::jsonb) allowed")).rows[0]?.allowed, true);
      for (const vector of [...POS_MANUAL_T2_DLP_CLASS_A_VECTORS, ...POS_MANUAL_T2_DLP_CLASS_B_VECTORS]) {
        assert.equal((await tenant.query(`
          SELECT pos_manual_t2_json_dlp_safe_v1(
            'operational_actor',jsonb_build_object('schemaVersion',1,'actorUserId',$1::text)
          ) allowed
        `, [vector.value])).rows[0]?.allowed, false, vector.label);
      }
      for (const vector of POS_MANUAL_T2_DLP_SAFE_VECTORS) {
        assert.equal((await tenant.query(`
          SELECT pos_manual_t2_json_dlp_safe_v1(
            'operational_actor',jsonb_build_object('schemaVersion',1,'actorUserId',$1::text)
          ) allowed
        `, [vector.value])).rows[0]?.allowed, true, vector.label);
      }
      await assertSqlState(tenant, "SELECT pos_manual_canonical_json_v1('1.5'::jsonb)", "22023");
      assert.equal((await tenant.query("SELECT pos_manual_canonical_json_v1('9007199254740991'::jsonb) value")).rows[0]?.value, "9007199254740991");
      assert.equal((await tenant.query("SELECT pos_manual_canonical_json_v1('-9007199254740991'::jsonb) value")).rows[0]?.value, "-9007199254740991");
      await assertSqlState(tenant, "SELECT pos_manual_canonical_json_v1('9007199254740992'::jsonb)", "22023");
      await assertSqlState(tenant, "SELECT pos_manual_canonical_json_v1('-9007199254740992'::jsonb)", "22023");
      await assertSqlState(tenant, "SELECT pos_manual_canonical_json_v1(to_jsonb(U&'e\\0301'::text))", "22023");
      assert.equal((await tenant.query("SELECT pos_manual_utc_micros_v1('2026-08-31T12:34:56.123456Z'::timestamptz) value")).rows[0]?.value, "2026-08-31T12:34:56.123456Z");

      const expectedForeignKeys = [
        ["pos_manual_finalization_profiles", "pos_manual_fin_profiles_branch_fkey", ["branch_id"], "branches", ["id"], false],
        ["pos_manual_finalization_profiles", "pos_manual_fin_profiles_cost_center_fkey", ["cost_center_id"], "cost_centers", ["id"], false],
        ["pos_manual_finalization_profiles", "pos_manual_fin_profiles_accounting_fkey", ["accounting_policy_id", "branch_id", "accounting_policy_version", "accounting_policy_hash"], "pos_accounting_policies", ["id", "branch_id", "version", "mapping_hash"], false],
        ["pos_manual_finalization_profiles", "pos_manual_fin_profiles_fiscal_fkey", ["fiscal_profile_id", "fiscal_profile_version", "branch_id", "fiscal_policy_hash"], "pos_fiscal_profiles", ["id", "version", "branch_id", "policy_digest"], false],
        ["pos_manual_payment_reconciliation_gates", "pos_manual_gate_fin_profile_fkey", ["finalization_profile_id", "finalization_profile_version", "finalization_profile_hash"], "pos_manual_finalization_profiles", ["id", "version", "config_hash"], false],
        ["pos_manual_payment_applications", "pos_manual_apps_observation_fkey", ["case_id", "confirmed_observation_id"], "pos_manual_payment_observations", ["case_id", "id"], false],
        ["pos_manual_payment_applications", "pos_manual_apps_fin_profile_fkey", ["finalization_profile_id", "finalization_profile_version", "finalization_profile_hash"], "pos_manual_finalization_profiles", ["id", "version", "config_hash"], false],
        ["pos_manual_application_snapshots", "pos_manual_app_snapshots_application_fkey", ["application_id"], "pos_manual_payment_applications", ["id"], true],
        ["pos_manual_payment_applications", "pos_manual_apps_snapshot_fkey", ["id", "snapshot_hash", "manifest_hash"], "pos_manual_application_snapshots", ["application_id", "snapshot_hash", "manifest_hash"], true],
        ["pos_manual_application_manifest_entries", "pos_manual_app_manifest_application_fkey", ["application_id"], "pos_manual_payment_applications", ["id"], false],
        ["pos_manual_application_effects", "pos_manual_app_effects_application_fkey", ["application_id"], "pos_manual_payment_applications", ["id"], false],
        ["pos_manual_application_effects", "pos_manual_app_effects_manifest_fkey", ["manifest_entry_id", "application_id"], "pos_manual_application_manifest_entries", ["id", "application_id"], false],
        ["pos_manual_payment_applications", "pos_manual_apps_sale_fkey", ["sale_id"], "sales", ["id"], true],
        ["pos_manual_payment_applications", "pos_manual_apps_sale_payment_fkey", ["sale_payment_id"], "pos_sale_payments", ["id"], true],
        ["sales", "sales_manual_payment_application_fkey", ["manual_payment_application_id"], "pos_manual_payment_applications", ["id"], true],
        ["pos_sale_payments", "pos_sale_payments_manual_case_fkey", ["manual_payment_case_id"], "pos_manual_payment_cases", ["id"], true],
      ] as const;
      for (const [tableName, constraintName, columns, referencedTable, referencedColumns, deferred] of expectedForeignKeys) {
        const foreignKey = await tenant.query<{ columns: string[]; referenced_table: string; referenced_columns: string[]; condeferrable: boolean; condeferred: boolean; confdeltype: string }>(`
          SELECT
            (SELECT array_agg(attribute.attname::text ORDER BY key.ordinality) FROM unnest(constraint_row.conkey) WITH ORDINALITY key(attnum,ordinality) JOIN pg_attribute attribute ON attribute.attrelid=constraint_row.conrelid AND attribute.attnum=key.attnum) columns,
            constraint_row.confrelid::regclass::text referenced_table,
            (SELECT array_agg(attribute.attname::text ORDER BY key.ordinality) FROM unnest(constraint_row.confkey) WITH ORDINALITY key(attnum,ordinality) JOIN pg_attribute attribute ON attribute.attrelid=constraint_row.confrelid AND attribute.attnum=key.attnum) referenced_columns,
            constraint_row.condeferrable,constraint_row.condeferred,constraint_row.confdeltype
          FROM pg_constraint constraint_row
          WHERE constraint_row.conrelid=$1::regclass AND constraint_row.conname=$2 AND constraint_row.contype='f' AND constraint_row.convalidated
        `, [`public.${tableName}`, constraintName]);
        assert.equal(foreignKey.rowCount, 1, constraintName);
        assert.deepEqual(foreignKey.rows[0], { columns: [...columns], referenced_table: referencedTable, referenced_columns: [...referencedColumns], condeferrable: deferred, condeferred: deferred, confdeltype: "r" }, constraintName);
      }

      const expectedUniqueKeys = [
        ["pos_manual_finalization_profiles", ["id"], false], ["pos_manual_finalization_profiles", ["branch_id", "version"], false],
        ["pos_manual_finalization_profiles", ["id", "version", "config_hash"], false], ["pos_manual_finalization_profiles", ["branch_id"], true],
        ["pos_manual_application_snapshots", ["application_id"], false], ["pos_manual_application_snapshots", ["application_id", "snapshot_hash", "manifest_hash"], false],
        ["pos_manual_application_manifest_entries", ["id"], false], ["pos_manual_application_manifest_entries", ["application_id", "effect_kind", "effect_key"], false],
        ["pos_manual_application_manifest_entries", ["id", "application_id"], false], ["pos_manual_application_effects", ["id"], false],
        ["pos_manual_application_effects", ["manifest_entry_id"], false], ["pos_manual_application_effects", ["application_id", "effect_kind", "effect_key"], false],
        ["pos_manual_payment_applications", ["planned_sale_id"], false], ["pos_manual_payment_applications", ["planned_sale_number"], false],
        ["pos_manual_payment_applications", ["sale_id"], true], ["pos_manual_payment_applications", ["sale_idempotency_key"], false],
        ["pos_manual_payment_applications", ["confirmed_observation_id"], false], ["pos_manual_payment_applications", ["apply_idempotency_key"], true],
        ["sales", ["manual_payment_application_id"], true], ["pos_sale_payments", ["manual_payment_case_id"], true],
      ] as const;
      for (const [tableName, columns, partial] of expectedUniqueKeys) {
        const uniqueKey = await tenant.query<{ count: number }>(`
          SELECT count(*)::integer count FROM pg_index index_row
          WHERE index_row.indrelid=$1::regclass AND index_row.indisunique AND index_row.indisvalid AND index_row.indisready
            AND (index_row.indpred IS NOT NULL)=$3
            AND (SELECT array_agg(attribute.attname::text ORDER BY key.ordinality) FROM unnest(index_row.indkey) WITH ORDINALITY key(attnum,ordinality) JOIN pg_attribute attribute ON attribute.attrelid=index_row.indrelid AND attribute.attnum=key.attnum)=$2::text[]
        `, [`public.${tableName}`, [...columns], partial]);
        assert.ok((uniqueKey.rows[0]?.count ?? 0) >= 1, `${tableName}.${columns.join(",")}`);
      }

      const triggerCatalog = await tenant.query<{ table_name: string; trigger_name: string; definition: string }>(`
        SELECT trigger_table.relname table_name, trigger.tgname trigger_name, pg_get_triggerdef(trigger.oid,true) definition
          FROM pg_trigger trigger
          JOIN pg_class trigger_table ON trigger_table.oid=trigger.tgrelid
          JOIN pg_namespace namespace ON namespace.oid=trigger_table.relnamespace
         WHERE namespace.nspname='public' AND NOT trigger.tgisinternal
           AND trigger_table.relname=ANY($1::text[])
         ORDER BY trigger_table.relname,trigger.tgname
      `, [[...relations, "pos_manual_payment_applications", "sales", "pos_sale_payments"]]);
      for (const relation of relations.slice(1)) {
        const triggers = triggerCatalog.rows.filter((row) => row.table_name === relation);
        assert.equal(triggers.length, 1, relation);
        assert.match(triggers[0]!.definition, /BEFORE (DELETE OR UPDATE|UPDATE OR DELETE)/);
        assert.match(triggers[0]!.definition, /protect_pos_manual_append_only\(\)/);
      }
      assert.equal(triggerCatalog.rows.filter((row) => row.table_name === "pos_manual_finalization_profiles" && /guard_pos_manual_t2_profile_inert\(\)/.test(row.definition)).length, 1);
      assert.equal(triggerCatalog.rows.filter((row) => row.table_name === "pos_manual_payment_applications" && /guard_pos_manual_t2_application_inert\(\)/.test(row.definition)).length, 1);
      for (const relation of ["sales", "pos_sale_payments"]) {
        const expectedGuard = relation === "sales" ? /guard_pos_manual_t2_sale_link_inert\(\)/ : /guard_pos_manual_t2_payment_link_inert\(\)/;
        assert.equal(triggerCatalog.rows.filter((row) => row.table_name === relation && expectedGuard.test(row.definition)).length, 1, relation);
      }

      await tenant.query("CREATE TEMP TABLE append_only_probe(id integer PRIMARY KEY)");
      await tenant.query("CREATE TRIGGER append_only_probe_guard BEFORE UPDATE OR DELETE ON append_only_probe FOR EACH ROW EXECUTE FUNCTION protect_pos_manual_append_only() ");
      await tenant.query("INSERT INTO append_only_probe VALUES (1)");
      await assertSqlState(tenant, "UPDATE append_only_probe SET id=2", "23514");
      await assertSqlState(tenant, "INSERT INTO pos_manual_finalization_profiles DEFAULT VALUES", "0A000");
      await assertSqlState(tenant, "INSERT INTO pos_manual_payment_applications DEFAULT VALUES", "0A000");
      await tenant.query("CREATE TEMP TABLE sale_link_probe(manual_payment_application_id uuid,source_type text)");
      await tenant.query("CREATE TRIGGER sale_link_probe_guard BEFORE INSERT OR UPDATE ON sale_link_probe FOR EACH ROW EXECUTE FUNCTION guard_pos_manual_t2_sale_link_inert() ");
      await assertSqlState(tenant, "INSERT INTO sale_link_probe VALUES (gen_random_uuid(),'manual_payment_application')", "0A000");
      await tenant.query("CREATE TEMP TABLE payment_link_probe(manual_payment_case_id uuid,status text,metadata jsonb)");
      await tenant.query("CREATE TRIGGER payment_link_probe_guard BEFORE INSERT OR UPDATE ON payment_link_probe FOR EACH ROW EXECUTE FUNCTION guard_pos_manual_t2_payment_link_inert() ");
      await assertSqlState(tenant, "INSERT INTO payment_link_probe VALUES (gen_random_uuid(),'manual_confirmed','{}'::jsonb)", "0A000");
      await tenant.query("INSERT INTO payment_link_probe VALUES (NULL,'manual_confirmed','{\"manualReferenceId\":\"legacy-reference\"}'::jsonb)");
      await tenant.query("UPDATE payment_link_probe SET status='partially_refunded' WHERE manual_payment_case_id IS NULL");
      await tenant.query("UPDATE payment_link_probe SET status='refunded' WHERE manual_payment_case_id IS NULL");
      assert.equal((await tenant.query("SELECT status FROM payment_link_probe WHERE manual_payment_case_id IS NULL")).rows[0]?.status, "refunded");
      await assertSqlState(tenant, "INSERT INTO payment_link_probe VALUES (NULL,'manual_confirmed','{\"manualPaymentCaseId\":\"phantom\"}'::jsonb)", "0A000");

      const activeWriters = await tenant.query<{ count: number }>(`
        SELECT count(*)::integer count
          FROM pg_proc routine JOIN pg_namespace namespace ON namespace.oid=routine.pronamespace
         WHERE namespace.nspname='public' AND routine.proname LIKE 'pos_manual%'
           AND routine.proname ~ '(reserve.*application|apply.*application|activate.*finalization|homologat.*finalization)'
      `);
      assert.equal(activeWriters.rows[0]?.count, 0);
    } finally {
      await tenant.end();
    }
  } finally {
    await admin.query("SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname=$1", [database]).catch(() => undefined);
    await admin.query(`DROP DATABASE IF EXISTS "${database}"`).catch(() => undefined);
    await admin.end();
  }
});

test("T2-01 mantém raízes e observações de lote owner-only, exatas e efêmeras", { skip: !adminConnectionString, timeout: 240_000 }, async () => {
  const token = randomBytes(5).toString("hex");
  const database = `t2_write_root_${token}`;
  const runtimeRole = `t2_write_runtime_${token}`;
  const runtimePassword = randomBytes(24).toString("hex");
  const admin = new Client({ connectionString: adminConnectionString });
  await admin.connect();
  try {
    await admin.query(`CREATE ROLE "${runtimeRole}" LOGIN NOINHERIT PASSWORD '${runtimePassword}'`);
    await admin.query(`CREATE DATABASE "${database}"`);
    const tenantUrl = databaseUrl(adminConnectionString!, database);
    await runPsqlFiles(tenantUrl, [...previousMigrationFiles(), t2MigrationFile, t2LifecycleMigrationFile]);
    const owner = new Client({ connectionString: tenantUrl });
    await owner.connect();
    const runtime = new Client({ connectionString: roleUrl(adminConnectionString!, database, runtimeRole, runtimePassword) });
    try {
      const relations = ["pos_manual_t2_write_roots", "pos_manual_t2_write_observations"];
      for (const relation of relations) {
        const acl = await owner.query<{ public_access: boolean }>(`
          SELECT EXISTS (
            SELECT 1
              FROM pg_class protected
              CROSS JOIN LATERAL aclexplode(coalesce(protected.relacl,acldefault('r',protected.relowner))) privilege
             WHERE protected.oid=$1::regclass AND privilege.grantee=0
          ) public_access
        `, [`public.${relation}`]);
        assert.equal(acl.rows[0]?.public_access, false, relation);
      }
      for (const signature of [
        "pos_manual_t2_write_observation_multiset_digest_v1(text[])",
        "pos_manual_t2_float8_hex_v1(double precision)",
        "pos_manual_t2_write_observation_digest_v1(text,text,text,text,text,text,jsonb,jsonb)",
        "pos_manual_t2_open_write_root_v1(text,text,text,text,text,text,text,text[])",
        "pos_manual_t2_observe_write_v1(text,text,text,text,text,text,jsonb,jsonb)",
      ]) {
        const acl = await owner.query<{ public_execute: boolean; security_definer: boolean; proconfig: string[] | null }>(`
          SELECT EXISTS (
                   SELECT 1 FROM aclexplode(coalesce(proc.proacl,acldefault('f',proc.proowner))) privilege
                    WHERE privilege.grantee=0 AND privilege.privilege_type='EXECUTE'
                 ) public_execute,
                 proc.prosecdef security_definer,proc.proconfig
            FROM pg_proc proc
           WHERE proc.oid=to_regprocedure($1)
        `, [signature]);
        assert.deepEqual(acl.rows[0], { public_execute: false, security_definer: true, proconfig: ["search_path=pg_catalog"] }, signature);
      }

      await owner.query(`GRANT CONNECT ON DATABASE "${database}" TO "${runtimeRole}"; GRANT USAGE ON SCHEMA public TO "${runtimeRole}"`);
      await runtime.connect();
      try {
        await assertSqlState(runtime, "SELECT * FROM pos_manual_t2_write_roots", "42501");
        await assertSqlState(runtime, "SELECT pos_manual_t2_open_write_root_v1('held_sale_items','held_sale','held-sale-1','insert','pos_held_sale_items_payment_plan_guard','INSERT',repeat('a',64),ARRAY[repeat('b',64)])", "42501");
      } finally {
        await owner.query("INSERT INTO pos_manual_t2_authorities(capability,role_name,authority_hash) VALUES('runtime',$1,$2)", [runtimeRole, authorityHash(database, runtimeRole)]);
        for (const signature of [
          "pos_manual_t2_write_observation_digest_v1(text,text,text,text,text,text,jsonb,jsonb)",
          "pos_manual_t2_open_write_root_v1(text,text,text,text,text,text,text,text[])",
          "pos_manual_t2_observe_write_v1(text,text,text,text,text,text,jsonb,jsonb)",
          "pos_manual_t2_float8_hex_v1(double precision)",
        ]) await owner.query(`GRANT EXECUTE ON FUNCTION public.${signature} TO "${runtimeRole}"`);
      }

      const meta = {
        capability: "held_sale_items",
        aggregateKind: "held_sale",
        aggregateId: "held-sale-1",
        action: "insert",
        triggerIdentity: "pos_held_sale_items_payment_plan_guard",
        dmlOperation: "INSERT",
      };
      const root = async (expected: string[], overrides: Partial<typeof meta> = {}) => {
        const value = { ...meta, ...overrides };
        await runtime.query(`
          SELECT pos_manual_t2_open_write_root_v1($1,$2,$3,$4,$5,$6,$7,$8::text[])
        `, [value.capability, value.aggregateKind, value.aggregateId, value.action, value.triggerIdentity, value.dmlOperation, authorityHash(database, runtimeRole), expected]);
      };
      const digest = async (newProjection: object | null, overrides: Partial<typeof meta> = {}, oldProjection: object | null = null) => {
        const value = { ...meta, ...overrides };
        return (await runtime.query<{ digest: string }>(`
          SELECT pos_manual_t2_write_observation_digest_v1($1,$2,$3,$4,$5,$6,$7::jsonb,$8::jsonb) digest
        `, [value.capability, value.aggregateKind, value.aggregateId, value.action, value.triggerIdentity, value.dmlOperation, oldProjection, newProjection])).rows[0]!.digest;
      };
      const observe = async (newProjection: object | null, overrides: Partial<typeof meta> = {}, oldProjection: object | null = null) => {
        const value = { ...meta, ...overrides };
        await runtime.query(`
          SELECT pos_manual_t2_observe_write_v1($1,$2,$3,$4,$5,$6,$7::jsonb,$8::jsonb)
        `, [value.capability, value.aggregateKind, value.aggregateId, value.action, value.triggerIdentity, value.dmlOperation, oldProjection, newProjection]);
      };
      const assertEphemeralState = async () => {
        for (const relation of ["pos_manual_t2_write_observations", "pos_manual_t2_write_roots", "pos_manual_t2_transaction_nonces"]) {
          assert.equal((await owner.query(`SELECT count(*)::integer count FROM ${relation}`)).rows[0]?.count, 0, relation);
        }
      };

      const quantityFloat8Hex = (await runtime.query<{ value: string }>("SELECT pos_manual_t2_float8_hex_v1(1.5::double precision) value")).rows[0]!.value;
      assert.equal(quantityFloat8Hex, "3ff8000000000000");
      const projectionA = { heldSaleId: "held-sale-1", productId: 1, quantityFloat8Hex };
      const projectionB = { heldSaleId: "held-sale-1", productId: 2, quantityFloat8Hex };
      const digestA = await digest(projectionA);
      const digestB = await digest(projectionB);
      await assertSqlState(runtime, "SELECT pos_manual_t2_write_observation_digest_v1('held_sale_items','held_sale','held-sale-1','insert','pos_held_sale_items_payment_plan_guard','INSERT',NULL::jsonb,jsonb_build_object('quantity',1.5))", "22023");
      await runtime.query("BEGIN");
      await root([digestA, digestA, digestB]);
      await observe(projectionB);
      await observe(projectionA);
      await observe(projectionA);
      await runtime.query("COMMIT");
      await assertEphemeralState();

      const deleteMeta = { action: "delete", dmlOperation: "DELETE" };
      const deleteProjection = { id: 1, heldSaleId: "held-sale-1", productId: 1, quantityFloat8Hex };
      const deleteDigest = await digest(null, deleteMeta, deleteProjection);
      await runtime.query("BEGIN");
      await root([deleteDigest], deleteMeta);
      await observe(null, deleteMeta, deleteProjection);
      await runtime.query("COMMIT");
      await assertEphemeralState();

      await runtime.query("BEGIN");
      await root([digestA, digestB]);
      await observe(projectionA);
      await assert.rejects(runtime.query("COMMIT"), (error: DatabaseError) => {
        assert.equal(error.code, "23514");
        assert.match(error.message, /write root observations were not fully matched/);
        return true;
      });
      await runtime.query("ROLLBACK").catch(() => undefined);
      await assertEphemeralState();

      await runtime.query("BEGIN");
      await root([digestA]);
      await observe(projectionA);
      await observe(projectionB);
      await assert.rejects(runtime.query("COMMIT"), (error: DatabaseError) => {
        assert.equal(error.code, "23514");
        return true;
      });
      await runtime.query("ROLLBACK").catch(() => undefined);
      await assertEphemeralState();

      await runtime.query("BEGIN");
      await root([digestA]);
      await observe(projectionA);
      await assert.rejects(runtime.query("SELECT 1/0"), (error: DatabaseError) => {
        assert.equal(error.code, "22012");
        return true;
      });
      await runtime.query("ROLLBACK");
      await assertEphemeralState();

      for (const mismatch of [
        { action: "update", dmlOperation: "UPDATE", oldProjection: projectionA, newProjection: projectionA },
        { aggregateId: "held-sale-2", oldProjection: null, newProjection: projectionA },
        { action: "delete", dmlOperation: "DELETE", oldProjection: projectionA, newProjection: null },
      ]) {
        await runtime.query("BEGIN");
        await root([digestA]);
        await assert.rejects(observe(mismatch.newProjection, mismatch, mismatch.oldProjection), (error: DatabaseError) => {
          assert.equal(error.code, "23514");
          assert.match(error.message, /does not exactly match this trigger observation/);
          return true;
        });
        await runtime.query("ROLLBACK");
        await assertEphemeralState();
      }

      await runtime.query("BEGIN");
      await root([digestA]);
      await assert.rejects(runtime.query(
        "SELECT pos_manual_t2_open_write_root_v1('held_sale_items','held_sale','held-sale-1','insert','pos_held_sale_items_payment_plan_guard','INSERT',$1,ARRAY[$2::text])",
        [authorityHash(database, runtimeRole), digestA],
      ), (error: DatabaseError) => {
        assert.equal(error.code, "23505");
        return true;
      });
      await runtime.query("ROLLBACK");
      await assertEphemeralState();
    } finally {
      await runtime.end().catch(() => undefined);
      await owner.end();
    }
  } finally {
    await admin.query("SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname=$1", [database]).catch(() => undefined);
    await admin.query(`DROP DATABASE IF EXISTS "${database}"`).catch(() => undefined);
    await admin.query(`DROP ROLE IF EXISTS "${runtimeRole}"`).catch(() => undefined);
    await admin.end();
  }
});

test("T2-01 held items prepara lotes canônicos e o guard permanece puro", { skip: !adminConnectionString, timeout: 240_000 }, async () => {
  const token = randomBytes(5).toString("hex"); const database = `t2_held_${token}`; const runtimeRole = `t2_held_rt_${token}`; const password = randomBytes(24).toString("hex");
  const admin = new Client({ connectionString: adminConnectionString }); await admin.connect();
  try {
    await admin.query(`CREATE ROLE "${runtimeRole}" LOGIN NOINHERIT PASSWORD '${password}'`); await admin.query(`CREATE DATABASE "${database}"`);
    const url = databaseUrl(adminConnectionString!, database); await runPsqlFiles(url, [...previousMigrationFiles(), t2MigrationFile, t2LifecycleMigrationFile]);
    const owner = new Client({ connectionString: url }); const runtime = new Client({ connectionString: roleUrl(adminConnectionString!, database, runtimeRole, password) }); await owner.connect();
    try {
      const branch = (await owner.query("INSERT INTO branches(code,name,legal_name,document,status) VALUES($1,'T2 held','T2 held',$2,'active') RETURNING id", [`H-${token}`, `H${token}`])).rows[0]!;
      const role = (await owner.query("INSERT INTO tenant_roles(key,name,permissions,system,active) VALUES($1,'T2 held','[]',false,true) RETURNING id", [`held-${token}`])).rows[0]!;
      const profile = (await owner.query("INSERT INTO tenant_user_profiles(user_id,role_id,display_name,email,status,active_branch_id) VALUES($1,$2,'T2 held',$3,'active',$4) RETURNING id", [`held-user-${token}`, role.id, `held-${token}@invalid`, branch.id])).rows[0]!;
      const register = (await owner.query("INSERT INTO pos_registers(branch_id,code,name,status) VALUES($1,$2,'T2 held','active') RETURNING id", [branch.id, `HREG-${token}`])).rows[0]!;
      const session = (await owner.query("INSERT INTO cash_register_sessions(number,register_name,status,opening_amount,opened_by,operator_profile_id,register_id,version) VALUES($1,'T2 held','open',0,$2,$3,$4,1) RETURNING id", [`HSESS-${token}`, `held-user-${token}`, profile.id, register.id])).rows[0]!;
      const terminalId = `held-terminal-${token}`;
      await owner.query("INSERT INTO pos_terminals(id,register_id,code,name,status,token_hash,token_issued_at,token_expires_at,credential_version,paired_at,last_seen_at,app_version) VALUES($1,$2,$3,'T2 held','online','hmac-sha256:v1:'||repeat('a',64),clock_timestamp(),clock_timestamp()+interval '1 hour',1,clock_timestamp(),clock_timestamp(),'1')", [terminalId, register.id, `HT-${token}`]);
      await owner.query("INSERT INTO branch_user_accesses(branch_id,user_profile_id,can_sell) VALUES($1,$2,true)", [branch.id, profile.id]);
      await owner.query("INSERT INTO pos_register_accesses(register_id,user_profile_id,active,can_sell) VALUES($1,$2,true,true)", [register.id, profile.id]);
      const product = (await owner.query("INSERT INTO products(name,sku,slug,category,updated_at) VALUES('T2 held',$1,$2,'T2',clock_timestamp()) RETURNING id", [`HP-${token}`, `t2-held-${token}`])).rows[0]!;
      const heldId = `held-${token}`;
      type HeldContext = { branchId: number; registerId: number; sessionId: number; operatorProfileId: number; terminalId: string; orderClaimId: string | null };
      const context: HeldContext = { branchId: branch.id, registerId: register.id, sessionId: session.id, operatorProfileId: profile.id, terminalId, orderClaimId: null };
      await owner.query(`GRANT CONNECT ON DATABASE "${database}" TO "${runtimeRole}"; GRANT USAGE ON SCHEMA public TO "${runtimeRole}"; GRANT INSERT,UPDATE,DELETE,SELECT ON pos_held_sales,pos_held_sale_items TO "${runtimeRole}"; GRANT USAGE ON SEQUENCE pos_held_sale_items_id_seq TO "${runtimeRole}"`);
      await owner.query("INSERT INTO pos_manual_t2_authorities(capability,role_name,authority_hash) VALUES('runtime',$1,$2)", [runtimeRole, authorityHash(database, runtimeRole)]);
      for (const signature of [
        "pos_manual_prepare_held_sale_items_write_v1(text,text,integer,text,text,text,jsonb,jsonb)", "pos_manual_t2_held_sale_items_request_hash_v1(text,text,integer,text,text,integer,integer,integer,integer,text,text,text)",
        "pos_manual_t2_write_observation_multiset_digest_v1(text[])", "pos_manual_canonical_json_v1(jsonb)", "pos_manual_t2_float8_hex_v1(double precision)",
      ]) await owner.query(`GRANT EXECUTE ON FUNCTION public.${signature} TO "${runtimeRole}"`);
      await runtime.connect();
      const target = (productId: number) => [{ transportOrdinal: 0, productId, variationId: null, quantity: 1.5, unitPriceCents: 100, discountCents: 0, scanData: null, notes: null }];
      const requestHash = async (action: string, revision: number, items: unknown, operationalContext: HeldContext = context) => (await runtime.query<{ value: string }>(`
        WITH material AS (SELECT CASE WHEN $3 IN ('update','delete') THEN jsonb_build_object('id',(value->>'id')::int)||jsonb_build_object('heldSaleId',$1::text,'productId',(value->>'productId')::int,'variationId',NULL,'quantityFloat8Hex',pos_manual_t2_float8_hex_v1((value->>'quantity')::float8),'unitPriceCents',(value->>'unitPriceCents')::int,'discountCents',(value->>'discountCents')::int,'scanData',NULL,'notes',NULL) ELSE jsonb_build_object('heldSaleId',$1::text,'productId',(value->>'productId')::int,'variationId',NULL,'quantityFloat8Hex',pos_manual_t2_float8_hex_v1((value->>'quantity')::float8),'unitPriceCents',(value->>'unitPriceCents')::int,'discountCents',(value->>'discountCents')::int,'scanData',NULL,'notes',NULL) END doc FROM jsonb_array_elements($2::jsonb)),
        digests AS (SELECT array_agg(encode(sha256(convert_to(pos_manual_canonical_json_v1(doc),'UTF8')),'hex')) values FROM material)
        SELECT pos_manual_t2_held_sale_items_request_hash_v1($3,$1,$4,$5,$6,$7,$8,$9,$10,$11,$12,pos_manual_t2_write_observation_multiset_digest_v1(values)) value FROM digests
      `, [heldId, JSON.stringify(items), action, revision, `held-user-${token}`, `held-key-${action}-${token}`.padEnd(16, "x"), operationalContext.branchId, operationalContext.registerId, operationalContext.sessionId, operationalContext.operatorProfileId, operationalContext.terminalId, operationalContext.orderClaimId])).rows[0]!.value;
      const prepare = async (action: string, revision: number, items: unknown, hash?: string, operationalContext: HeldContext = context) => runtime.query("SELECT pos_manual_prepare_held_sale_items_write_v1($1,$2,$3,$4,$5,$6,$7::jsonb,$8::jsonb)", [action, heldId, revision, `held-user-${token}`, `held-key-${action}-${token}`.padEnd(16, "x"), hash ?? await requestHash(action, revision, items, operationalContext), JSON.stringify(operationalContext), JSON.stringify(items)]);
      await assertSqlState(runtime, "INSERT INTO pos_held_sale_items(held_sale_id,product_id,quantity,unit_price_cents) VALUES('missing',1,1,1)", "42501");
      const assertBoundaryRejected = async (operationalContext: HeldContext = context) => assert.rejects(prepare("insert", 0, target(product.id), undefined, operationalContext), (error: DatabaseError) => { assert.equal(error.code, "23514"); return true; });
      await owner.query("UPDATE pos_terminals SET status='offline' WHERE id=$1", [terminalId]); await assertBoundaryRejected(); await owner.query("UPDATE pos_terminals SET status='online' WHERE id=$1", [terminalId]);
      await owner.query("UPDATE pos_terminals SET revoked_at=clock_timestamp() WHERE id=$1", [terminalId]); await assertBoundaryRejected(); await owner.query("UPDATE pos_terminals SET revoked_at=NULL WHERE id=$1", [terminalId]);
      await owner.query("UPDATE pos_terminals SET token_issued_at=clock_timestamp()-interval '2 hours',token_expires_at=clock_timestamp()-interval '1 minute' WHERE id=$1", [terminalId]); await assertBoundaryRejected(); await owner.query("UPDATE pos_terminals SET token_issued_at=clock_timestamp(),token_expires_at=clock_timestamp()+interval '1 hour' WHERE id=$1", [terminalId]);
      await owner.query("UPDATE pos_terminals SET last_seen_at=clock_timestamp()-interval '6 minutes' WHERE id=$1", [terminalId]); await assertBoundaryRejected(); await owner.query("UPDATE pos_terminals SET last_seen_at=clock_timestamp() WHERE id=$1", [terminalId]);
      await owner.query("UPDATE pos_register_accesses SET active=false WHERE register_id=$1 AND user_profile_id=$2", [register.id, profile.id]); await assertBoundaryRejected(); await owner.query("UPDATE pos_register_accesses SET active=true WHERE register_id=$1 AND user_profile_id=$2", [register.id, profile.id]);
      await owner.query("UPDATE pos_register_accesses SET valid_until=clock_timestamp()-interval '1 minute' WHERE register_id=$1 AND user_profile_id=$2", [register.id, profile.id]); await assertBoundaryRejected(); await owner.query("UPDATE pos_register_accesses SET valid_until=NULL WHERE register_id=$1 AND user_profile_id=$2", [register.id, profile.id]);
      await assertBoundaryRejected({ ...context, orderClaimId: `missing-claim-${token}` });
      const expiredOrder = (await owner.query("INSERT INTO sales_orders(number,order_key,customer_name,created_by) VALUES($1,$2,'T2 held',$3) RETURNING id", [`H-ORDER-EXPIRED-${token}`, `order-expired-${token}`, `held-user-${token}`])).rows[0]!;
      const divergentOrder = (await owner.query("INSERT INTO sales_orders(number,order_key,customer_name,created_by) VALUES($1,$2,'T2 held',$3) RETURNING id", [`H-ORDER-DIVERGENT-${token}`, `order-divergent-${token}`, `held-user-${token}`])).rows[0]!;
      const expiredClaim = `expired-claim-${token}`; const divergentClaim = `divergent-claim-${token}`;
      await owner.query("SET session_replication_role=replica");
      await owner.query("INSERT INTO pos_order_claims(id,sales_order_id,branch_id,register_id,session_id,operator_profile_id,terminal_id,state,lease_expires_at,idempotency_key,request_hash,claimed_at,updated_at) VALUES($1,$2,$3,$4,$5,$6,$7,'active',clock_timestamp()-interval '1 minute',$8,repeat('a',64),clock_timestamp()-interval '2 minutes',clock_timestamp())", [expiredClaim, expiredOrder.id, branch.id, register.id, session.id, profile.id, terminalId, `expired-${token}`.padEnd(16, "x")]);
      await owner.query("INSERT INTO pos_order_claims(id,sales_order_id,branch_id,register_id,session_id,operator_profile_id,terminal_id,state,lease_expires_at,idempotency_key,request_hash,updated_at) VALUES($1,$2,$3,$4,$5,$6,$7,'active',clock_timestamp()+interval '1 minute',$8,repeat('b',64),clock_timestamp())", [divergentClaim, divergentOrder.id, branch.id, register.id, session.id, profile.id, `other-terminal-${token}`, `divergent-${token}`.padEnd(16, "x")]);
      await owner.query("SET session_replication_role=origin");
      await assertBoundaryRejected({ ...context, orderClaimId: expiredClaim });
      await assertBoundaryRejected({ ...context, orderClaimId: divergentClaim });
      const capabilityBody = (await owner.query<{ body: string }>("SELECT pg_get_functiondef('public.pos_manual_prepare_held_sale_items_write_v1(text,text,integer,text,text,text,jsonb,jsonb)'::regprocedure) body")).rows[0]!.body;
      assert.ok(capabilityBody.indexOf('SELECT * INTO sales_order_row FROM public."sales_orders"') < capabilityBody.indexOf('SELECT * INTO claim_row FROM public."pos_order_claims"'));
      await runtime.query("BEGIN"); await prepare("insert", 0, target(product.id)); await runtime.query("INSERT INTO pos_held_sales(id,register_id,session_id,operator_profile_id,status,revision) VALUES($1,$2,$3,$4,'held',0)", [heldId, register.id, session.id, profile.id]); await runtime.query("INSERT INTO pos_held_sale_items(held_sale_id,product_id,quantity,unit_price_cents,discount_cents) VALUES($1,$2,1.5,100,0)", [heldId, product.id]); await runtime.query("COMMIT");
      assert.equal((await owner.query("SELECT count(*)::int n FROM pos_manual_t2_write_roots")).rows[0]!.n, 0);
      const itemId = (await owner.query("SELECT id FROM pos_held_sale_items WHERE held_sale_id=$1", [heldId])).rows[0]!.id;
      const updateTarget = [{ id: itemId, productId: product.id, variationId: null, quantity: 1.5, unitPriceCents: 101, discountCents: 0, scanData: null, notes: null }];
      await runtime.query("BEGIN"); await prepare("update", 0, updateTarget); await runtime.query("UPDATE pos_held_sale_items SET unit_price_cents=101 WHERE id=$1", [itemId]); await runtime.query("COMMIT");
      await owner.query("UPDATE pos_held_sales SET status='draft' WHERE id=$1", [heldId]);
      await runtime.query("BEGIN"); await prepare("replace_batch", 0, target(product.id)); await runtime.query("DELETE FROM pos_held_sale_items WHERE held_sale_id=$1", [heldId]); await runtime.query("INSERT INTO pos_held_sale_items(held_sale_id,product_id,quantity,unit_price_cents,discount_cents) VALUES($1,$2,1.5,100,0)", [heldId, product.id]); await runtime.query("COMMIT");
      await runtime.query("BEGIN"); await prepare("replace_batch", 0, target(product.id)); await runtime.query("DELETE FROM pos_held_sale_items WHERE held_sale_id=$1", [heldId]); await assert.rejects(runtime.query("COMMIT"), (error: DatabaseError) => { assert.equal(error.code, "23514"); return true; }); await runtime.query("ROLLBACK").catch(() => undefined);
      await runtime.query("BEGIN"); await prepare("replace_batch", 0, target(product.id)); await runtime.query("DELETE FROM pos_held_sale_items WHERE held_sale_id=$1", [heldId]); await runtime.query("INSERT INTO pos_held_sale_items(held_sale_id,product_id,quantity,unit_price_cents,discount_cents) VALUES($1,$2,1.5,100,0),($1,$2,1.5,100,0)", [heldId, product.id]); await assert.rejects(runtime.query("COMMIT"), (error: DatabaseError) => { assert.equal(error.code, "23514"); return true; }); await runtime.query("ROLLBACK").catch(() => undefined);
      await runtime.query("BEGIN"); await prepare("replace_batch", 0, target(product.id)); await runtime.query("DELETE FROM pos_held_sale_items WHERE held_sale_id=$1", [heldId]); await runtime.query("INSERT INTO pos_held_sale_items(held_sale_id,product_id,quantity,unit_price_cents,discount_cents) VALUES($1,$2,1.5,101,0)", [heldId, product.id]); await assert.rejects(runtime.query("COMMIT"), (error: DatabaseError) => { assert.equal(error.code, "23514"); return true; }); await runtime.query("ROLLBACK").catch(() => undefined);
      await assert.rejects(prepare("replace_batch", 0, target(product.id), "f".repeat(64)), (error: DatabaseError) => { assert.equal(error.code, "23514"); return true; });
      await assert.rejects(prepare("insert", 0, [{ ...target(product.id)[0], transportOrdinal: 0 }, { ...target(product.id)[0], transportOrdinal: 0 }]), (error: DatabaseError) => { assert.equal(error.code, "22023"); return true; });
      await owner.query("SET session_replication_role=replica");
      await owner.query("INSERT INTO pos_payment_plans(id,branch_id,register_id,session_id,operator_profile_id,terminal_id,sale_draft_id,draft_revision,draft_request_hash,draft_status,quote_hash,evaluated_at,expires_at,total_cents,state,version,idempotency_key,request_hash) VALUES($1,$2,$3,$4,$5,$6,$7,0,repeat('a',64),'draft',repeat('b',64),clock_timestamp(),clock_timestamp()+interval '1 minute',100,'quoted',0,$8,repeat('c',64))", [`plan-${token}`, branch.id, register.id, session.id, profile.id, terminalId, heldId, `plan-key-${token}`.padEnd(16, "x")]);
      await owner.query("SET session_replication_role=origin");
      await assert.rejects(prepare("replace_batch", 0, target(product.id)), (error: DatabaseError) => { assert.equal(error.code, "23514"); return true; });
      assert.ok(itemId);
    } finally { await runtime.end().catch(() => undefined); await owner.end(); }
  } finally { await admin.query("SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname=$1", [database]).catch(() => undefined); await admin.query(`DROP DATABASE IF EXISTS "${database}"`).catch(() => undefined); await admin.query(`DROP ROLE IF EXISTS "${runtimeRole}"`).catch(() => undefined); await admin.end(); }
});

function databaseUrl(base: string, database: string) {
  const url = new URL(base);
  url.pathname = `/${database}`;
  return url.toString();
}

function roleUrl(base: string, database: string, role: string, password: string) {
  const url = new URL(databaseUrl(base, database));
  url.username = role;
  url.password = password;
  return url.toString();
}

function authorityHash(database: string, role: string) {
  return createHash("sha256").update(`t2-authority-v1\0${database}\0${role}`).digest("hex");
}

function previousMigrationFiles() {
  return readdirSync("prisma/tenant/migrations", { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && entry.name < t2MigrationName)
    .map((entry) => `prisma/tenant/migrations/${entry.name}/migration.sql`)
    .sort();
}

async function runPsqlFiles(connectionString: string, files: string[]) {
  const connection = new URL(connectionString);
  await execFileAsync("psql", [
    "--no-psqlrc",
    "--no-password",
    "-v", "ON_ERROR_STOP=1",
    ...files.flatMap((file) => ["-f", file]),
  ], { timeout: 180_000, env: psqlEnv(connection) });
}

async function assertMigrationRejected(connectionString: string, expected: RegExp) {
  await assert.rejects(
    runPsqlFiles(connectionString, [t2MigrationFile]),
    (error: NodeJS.ErrnoException & { stderr?: string }) => {
      assert.match(`${error.message}\n${error.stderr ?? ""}`, expected);
      return true;
    },
  );
}

async function assertPreflightWasAtomic(connectionString: string) {
  const client = new Client({ connectionString });
  await client.connect();
  try {
    const state = await client.query<{ new_tables: number; write_txid: boolean; reserve_txid: boolean; legacy_guard: boolean }>(`
      SELECT
        (SELECT count(*)::integer FROM unnest(ARRAY[
          'public.pos_manual_finalization_profiles',
          'public.pos_manual_application_snapshots',
          'public.pos_manual_application_manifest_entries',
          'public.pos_manual_application_effects'
        ]) name WHERE to_regclass(name) IS NOT NULL) new_tables,
        EXISTS (SELECT 1 FROM pg_attribute WHERE attrelid='pos_manual_payment_applications'::regclass AND attname='write_txid' AND NOT attisdropped) write_txid,
        EXISTS (SELECT 1 FROM pg_attribute WHERE attrelid='pos_manual_payment_applications'::regclass AND attname='reserve_txid' AND NOT attisdropped) reserve_txid,
        to_regprocedure('guard_pos_manual_application()') IS NOT NULL legacy_guard
    `);
    assert.deepEqual(state.rows[0], { new_tables: 0, write_txid: true, reserve_txid: false, legacy_guard: true });
  } finally {
    await client.end();
  }
}

function psqlEnv(connection: URL) {
  return {
    ...process.env,
    PGHOST: connection.hostname,
    PGPORT: connection.port,
    PGUSER: decodeURIComponent(connection.username),
    PGPASSWORD: decodeURIComponent(connection.password),
    PGDATABASE: connection.pathname.slice(1),
  };
}

async function assertSqlState(client: Client, sql: string, expectedCode: string) {
  await assert.rejects(client.query(sql), (error: DatabaseError) => {
    assert.equal(error.code, expectedCode, error.message);
    return true;
  });
}
