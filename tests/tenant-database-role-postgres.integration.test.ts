import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import test from "node:test";
import { Client, type DatabaseError } from "pg";

const execFileAsync = promisify(execFile);
const adminConnectionString = process.env.TENANT_ROLE_TEST_ADMIN_DATABASE_URL;


test("reconcile 321f/T2-01 aceita somente catálogo fresh canônico e segrega todas as authorities", { skip: !adminConnectionString, timeout: 180_000 }, async () => {
  const token = randomBytes(5).toString("hex");
  const database = `role_fresh_${token}`;
  const migratorRole = `${database}_migrator`;
  const runtimeRole = `${database}_runtime`;
  const rogueRole = `${database}_rogue`;
  const roles = [`${database}_mw`, `${database}_mc`, `${database}_si`, `${database}_mh`, `${database}_mb`, `${database}_mpi`, `${database}_mpa`, `${database}_mpf`, `${database}_ms`];
  const passwords = [migratorRole, runtimeRole, ...roles].map(() => randomBytes(24).toString("hex"));
  const admin = new Client({ connectionString: adminConnectionString });
  await admin.connect();
  try {
    for (const [index, role] of [migratorRole, runtimeRole, ...roles].entries()) await admin.query(`CREATE ROLE "${role}" LOGIN PASSWORD '${passwords[index]}' NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS`);
    await admin.query(`CREATE ROLE "${rogueRole}" NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS`);
    await admin.query(`CREATE DATABASE "${database}" OWNER "${migratorRole}"`);
    await admin.query(`ALTER ROLE "${roles[8]}" IN DATABASE "${database}" SET default_transaction_isolation TO 'serializable'`);
    const migratorUrl = roleUrl(adminConnectionString!, migratorRole, passwords[0]!, database);
    await execFileAsync("npx", ["prisma", "migrate", "deploy", "--config", "prisma.tenant.config.ts"], { timeout: 150_000, env: { ...process.env, TENANT_DATABASE_URL: migratorUrl } });
    const setup = new Client({ connectionString: migratorUrl });
    await setup.connect();
    await setup.query("CREATE TABLE runtime_probe(id BIGSERIAL PRIMARY KEY,value TEXT NOT NULL)");
    await setup.end();
    await reconcile(migratorUrl, database, runtimeRole, migratorRole, roles);
    const runtime = new Client({ connectionString: roleUrl(adminConnectionString!, runtimeRole, passwords[1]!, database) });
    const binder = new Client({ connectionString: roleUrl(adminConnectionString!, roles[4]!, passwords[6]!, database) });
    const migrator = new Client({ connectionString: migratorUrl });
    const operationalClients = await Promise.all(roles.map(async (role, index) => { const client = new Client({ connectionString: roleUrl(adminConnectionString!, role, passwords[index + 2]!, database) }); await client.connect(); return client; }));
    await Promise.all([runtime.connect(), binder.connect(), migrator.connect()]);
    try {
      await runtime.query("INSERT INTO runtime_probe(value) VALUES ('ok')");
      const authorityRegistry = await migrator.query<{ capability: string; role_name: string }>("SELECT capability,role_name::text FROM pos_manual_t2_authorities ORDER BY capability");
      assert.deepEqual(authorityRegistry.rows, [
        { capability: "manual_callback", role_name: roles[1]! },
        { capability: "manual_sweeper", role_name: roles[8]! },
        { capability: "manual_vault_binder", role_name: roles[4]! },
        { capability: "manual_worker", role_name: roles[0]! },
        { capability: "profile_accounting_issuer", role_name: roles[6]! },
        { capability: "profile_admin_issuer", role_name: roles[5]! },
        { capability: "profile_fiscal_issuer", role_name: roles[7]! },
        { capability: "profile_homologator", role_name: roles[3]! },
        { capability: "runtime", role_name: runtimeRole },
      ]);
      await assertSqlState(runtime, "ALTER TABLE runtime_probe ADD COLUMN bad INTEGER", "42501");
      await assertSqlState(runtime, "TRUNCATE runtime_probe", "42501");
      await assertSqlState(runtime, "SELECT setval('runtime_probe_id_seq',99)", "42501");
      await assertSqlState(runtime, "SELECT * FROM _prisma_migrations", "42501");
      for (const legacyCatalogRelation of ["products", "product_variations"]) {
        assert.equal((await migrator.query(
          "SELECT has_table_privilege($1,$2,'SELECT,INSERT,UPDATE,DELETE') allowed",
          [runtimeRole, legacyCatalogRelation],
        )).rows[0]?.allowed, true, `${legacyCatalogRelation} must retain reconciled legacy runtime DML`);
      }
      for (const legacyCatalogSequence of ["products_id_seq", "product_variations_id_seq"]) {
        assert.equal((await migrator.query(
          "SELECT has_sequence_privilege($1,$2,'USAGE,SELECT') allowed",
          [runtimeRole, legacyCatalogSequence],
        )).rows[0]?.allowed, true, `${legacyCatalogSequence} must retain reconciled legacy runtime ACL`);
      }
      await assertSqlState(runtime, `
        INSERT INTO products(name,slug,sku,category,updated_at)
        VALUES ('forbidden direct boundary write','forbidden-direct-boundary-write','forbidden-direct-boundary-write','test',CURRENT_TIMESTAMP)
      `, "42501");
      const signatures = [
        "pos_manual_prepare_open_v1(text,integer,integer,text,timestamptz,text,text,text)", "pos_manual_open_status_v1(uuid,integer,text,text)",
        "pos_manual_claim_open_for_vault_v1(uuid,text,text,text,integer)", "pos_manual_open_case_v1(uuid,text,bigint,text,text,text,text,text,text,text,text,text,text,timestamptz,timestamptz,text)",
        "pos_manual_abandon_open_v1(uuid,text,bigint,text,text)", "pos_manual_probe_open_v1(uuid,text)",
      ];
      const t2Capabilities: Array<[string, string]> = [
        ["pos_manual_prepare_session_transition_v1(text,integer,integer,integer,text,text,text)", runtimeRole],
        ["pos_manual_prepare_handoff_transition_v1(text,text,integer,integer,integer,integer,integer,text,text,text,text,timestamp with time zone,jsonb)", runtimeRole],
        ["pos_manual_t2_write_observation_multiset_digest_v1(text[])", runtimeRole],
        ["pos_manual_t2_float8_hex_v1(double precision)", runtimeRole],
        ["pos_manual_t2_held_sale_items_request_hash_v1(text,text,integer,text,text,integer,integer,integer,integer,text,text,text)", runtimeRole],
        ["pos_manual_prepare_held_sale_items_write_v1(text,text,integer,text,text,text,jsonb,jsonb)", runtimeRole],
        ["pos_manual_t2_payment_plan_graph_request_hash_v1(text,text,integer,text,text,jsonb,jsonb,jsonb)", runtimeRole],
        ["pos_manual_t2_payment_plan_draft_snapshot_hash_v1(text)", runtimeRole],
        ["pos_manual_prepare_payment_plan_graph_write_v1(text,text,integer,text,text,text,jsonb,jsonb,jsonb)", runtimeRole],
        ["pos_manual_prepare_order_claim_write_v1(text,text,integer,integer,integer,text,text,text,jsonb)", runtimeRole],
        ["pos_manual_t2_payment_intent_request_hash_v1(text,text,integer,text,text,jsonb)", runtimeRole],
        ["pos_manual_prepare_payment_intent_write_v1(text,text,integer,text,text,text,jsonb)", runtimeRole],
        ["pos_manual_t2_manual_reference_request_hash_v1(text,text,integer,text,text,jsonb)", runtimeRole],
        ["pos_manual_prepare_manual_payment_reference_write_v1(text,text,integer,text,text,text,jsonb)", runtimeRole],
        ["pos_manual_t2_sale_payment_request_hash_v1(text,text,integer,text,text,jsonb)", runtimeRole],
        ["pos_manual_prepare_sale_payment_write_v1(text,text,integer,text,text,text,jsonb)", runtimeRole],
        ["pos_manual_put_finalization_profile_v1(integer,integer,jsonb,integer,text,text,text,text)", runtimeRole],
        ["pos_manual_activate_finalization_profile_v1(uuid,integer,text,text,text,text,text,text)", roles[3]!],
        ["pos_manual_retire_finalization_profile_v1(uuid,integer,text,text,text,text,text)", roles[3]!],
        ["pos_manual_issue_profile_admin_assertion_v1(text,integer,uuid,integer,text,text,text,text,text)", roles[5]!],
        ["pos_manual_issue_profile_accounting_assertion_v1(uuid,integer,text,text,text,text,text,text)", roles[6]!],
        ["pos_manual_issue_profile_fiscal_assertion_v1(uuid,integer,text,text,text,text,text,text)", roles[7]!],
        ["pos_manual_reserve_application_v1(uuid,integer,integer,text,text,text)", runtimeRole],
        ["pos_manual_application_status_v1(uuid,text)", runtimeRole],
        ["pos_manual_application_status_by_reservation_v1(uuid,text,text,integer,text)", runtimeRole],
        ["pos_manual_sweep_expired_applications_v1(text,integer,text,text)", roles[8]!],
        ["pos_t2_catalog_boundary_v1(text,integer,integer,text,jsonb,jsonb,text,text,text)", runtimeRole],
        ["pos_t2_value_program_boundary_v1(text,text,integer,text,integer,text,text,text,integer,integer,integer,integer,text,text,text)", runtimeRole],
        ["pos_t2_accounting_period_put_v1(integer,integer,integer,date,date,text,text,text,text)", runtimeRole],
        ["pos_t2_accounting_period_close_v1(text,integer,text,text,text,text,text)", runtimeRole],
        ["pos_t2_webhook_boundary_v1(text,text,integer,text,text,text,text,text,text,text,text,text,text,text)", runtimeRole],
      ];
      const profileIssuerRoles = roles.slice(5, 8);
      for (const [index, signature] of signatures.entries()) {
        assert.equal((await migrator.query("SELECT has_function_privilege($1,$2,'EXECUTE') allowed", [runtimeRole, signature])).rows[0]?.allowed, index < 2);
        assert.equal((await migrator.query("SELECT has_function_privilege($1,$2,'EXECUTE') allowed", [roles[4], signature])).rows[0]?.allowed, index >= 2);
        for (const role of roles.slice(0, 4)) assert.equal((await migrator.query("SELECT has_function_privilege($1,$2,'EXECUTE') allowed", [role, signature])).rows[0]?.allowed, false);
      }
      for (const [signature, allowedRole] of t2Capabilities) {
        for (const role of [runtimeRole, ...roles]) {
          assert.equal(
            (await migrator.query("SELECT has_function_privilege($1,$2,'EXECUTE') allowed", [role, signature])).rows[0]?.allowed,
            role === allowedRole,
            `${role} / ${signature}`,
          );
        }
      }
      assert.equal((await migrator.query("SELECT has_function_privilege($1,'pos_manual_prepare_plan_release_v1(text,text,integer,text,text,text)','EXECUTE') allowed", [runtimeRole])).rows[0]?.allowed, false);
      const legacyImpls = [
        "pos_manual_review_case_v1_t2_01_impl(uuid,integer,integer,text,text,text,text,text,text)",
        "pos_manual_record_callback_v1_t2_01_impl(text,text,text,text,text,text,text,text,timestamptz,text,text,text,integer,text,bigint,timestamptz,integer,text)",
        "pos_manual_attest_query_response_v1_t2_01_impl(uuid,integer,text,text,text,text,text,text,text,text,text,timestamptz,text,text,text,integer,text,bigint,timestamptz,integer,text)",
        "pos_manual_complete_delivery_v1_t2_01_impl(uuid,text,uuid,text)",
        "pos_manual_report_transport_v1_t2_01_impl(uuid,text,text,text)",
        "pos_manual_claim_queries_v1_t2_01_impl(text,integer,integer,text)",
        "pos_manual_open_case_v1_t2_01_impl(uuid,text,bigint,text,text,text,text,text,text,text,text,text,text,timestamptz,timestamptz,text)",
      ];
      for (const signature of legacyImpls) {
        const shape = await migrator.query<{ secure: boolean }>("SELECT proowner=(SELECT oid FROM pg_roles WHERE rolname=$1) AND prosecdef AND proconfig=ARRAY['search_path=pg_catalog, public']::text[] secure FROM pg_proc WHERE oid=$2::regprocedure", [migratorRole, signature]);
        assert.equal(shape.rows[0]?.secure, true, signature);
        for (const role of [runtimeRole, ...roles]) assert.equal((await migrator.query("SELECT has_function_privilege($1,$2,'EXECUTE') allowed", [role, signature])).rows[0]?.allowed, false, `${role} / ${signature}`);
      }
      await migrator.query(`ALTER FUNCTION ${legacyImpls[0]} SET search_path=pg_catalog`);
      await assertReconcileRejected(migratorUrl, database, runtimeRole, migratorRole, roles, /function body\/security manifest mismatch|internal legacy implementation security shape mismatch/);
      await migrator.query(`ALTER FUNCTION ${legacyImpls[0]} SET search_path=pg_catalog, public`);
      await reconcile(migratorUrl, database, runtimeRole, migratorRole, roles);
      for (const [index, client] of operationalClients.entries()) {
        await assertSqlState(client, "SELECT * FROM pos_manual_open_requests", "42501");
        await assertSqlState(client, "SELECT nextval('runtime_probe_id_seq')", "42501");
        assert.ok(index >= 0);
      }
      await assertSqlState(operationalClients[8]!, "SELECT * FROM runtime_probe", "42501");
      for (const role of profileIssuerRoles) {
        assert.equal((await migrator.query("SELECT has_database_privilege($1,current_database(),'CONNECT') allowed", [role])).rows[0]?.allowed, true);
        assert.equal((await migrator.query("SELECT has_schema_privilege($1,'public','USAGE') allowed", [role])).rows[0]?.allowed, true);
        assert.equal((await migrator.query("SELECT count(*)::integer count FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND has_function_privilege($1,p.oid,'EXECUTE')", [role])).rows[0]?.count, 1);
      }
      assert.equal((await migrator.query("SELECT count(*)::integer count FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND has_function_privilege($1,p.oid,'EXECUTE')", [roles[8]])).rows[0]?.count, 1);
      await admin.query(`ALTER ROLE "${roles[8]}" IN DATABASE "${database}" RESET default_transaction_isolation`);
      await assertReconcileRejected(migratorUrl, database, runtimeRole, migratorRole, roles, /manual sweeper role must have only the database-scoped SERIALIZABLE default/);
      await admin.query(`ALTER ROLE "${roles[8]}" IN DATABASE "${database}" SET default_transaction_isolation TO 'serializable'`);
      await reconcile(migratorUrl, database, runtimeRole, migratorRole, roles);
      await admin.query(`ALTER ROLE "${runtimeRole}" IN DATABASE "${database}" SET default_transaction_isolation TO 'serializable'`);
      await assertReconcileRejected(migratorUrl, database, runtimeRole, migratorRole, roles, /runtime role must not override default_transaction_isolation/);
      await admin.query(`ALTER ROLE "${runtimeRole}" IN DATABASE "${database}" RESET default_transaction_isolation`);
      await reconcile(migratorUrl, database, runtimeRole, migratorRole, roles);
      await migrator.query(`GRANT EXECUTE ON FUNCTION pos_manual_prepare_open_v1(text,integer,integer,text,timestamptz,text,text,text) TO "${profileIssuerRoles[0]}"`);
      await migrator.query(`GRANT SELECT ON runtime_probe TO "${profileIssuerRoles[1]}"`);
      await migrator.query(`GRANT USAGE ON SEQUENCE runtime_probe_id_seq TO "${profileIssuerRoles[2]}"`);
      await reconcile(migratorUrl, database, runtimeRole, migratorRole, roles);
      assert.equal((await migrator.query("SELECT has_function_privilege($1,'pos_manual_prepare_open_v1(text,integer,integer,text,timestamptz,text,text,text)','EXECUTE') allowed", [profileIssuerRoles[0]])).rows[0]?.allowed, false);
      assert.equal((await migrator.query("SELECT has_table_privilege($1,'runtime_probe','SELECT') allowed", [profileIssuerRoles[1]])).rows[0]?.allowed, false);
      assert.equal((await migrator.query("SELECT has_sequence_privilege($1,'runtime_probe_id_seq','USAGE') allowed", [profileIssuerRoles[2]])).rows[0]?.allowed, false);
      await admin.query(`GRANT "${profileIssuerRoles[0]}" TO "${rogueRole}"`);
      await assertReconcileRejected(migratorUrl, database, runtimeRole, migratorRole, roles, /operational role .* must not have memberships/);
      await admin.query(`REVOKE "${profileIssuerRoles[0]}" FROM "${rogueRole}"`);
      await reconcile(migratorUrl, database, runtimeRole, migratorRole, roles);
      const publicAcl = await migrator.query<{ count: string }>("SELECT count(*)::text count FROM pg_proc p CROSS JOIN LATERAL aclexplode(COALESCE(p.proacl,acldefault('f',p.proowner))) a WHERE p.oid=ANY($1::regprocedure[]) AND a.grantee=0 AND a.privilege_type='EXECUTE'", [signatures]);
      assert.equal(publicAcl.rows[0]?.count, "0");
      await migrator.query("CREATE TABLE future_probe(id BIGSERIAL PRIMARY KEY,value TEXT NOT NULL)");
      await migrator.query("CREATE TABLE pos_manual_payment_future_probe(id BIGSERIAL PRIMARY KEY,value TEXT NOT NULL)");
      await migrator.query("CREATE TABLE pos_manual_application_future_probe(id BIGSERIAL PRIMARY KEY,value TEXT NOT NULL)");
      await reconcile(migratorUrl, database, runtimeRole, migratorRole, roles);
      await runtime.query("INSERT INTO future_probe(value) VALUES ('granted')");
      await assertSqlState(runtime, "SELECT * FROM pos_manual_payment_future_probe", "42501");
      await assertSqlState(runtime, "SELECT * FROM pos_manual_application_future_probe", "42501");
      await assertSqlState(runtime, "SELECT nextval('pos_manual_application_future_probe_id_seq')", "42501");
      for (const client of operationalClients) {
        await assertSqlState(client, "SELECT * FROM pos_manual_application_future_probe", "42501");
        await assertSqlState(client, "SELECT nextval('pos_manual_application_future_probe_id_seq')", "42501");
      }
      const protectedRelations = await migrator.query<{ identity: string }>(`
        SELECT relation.oid::regclass::text identity
          FROM pg_class relation JOIN pg_namespace namespace ON namespace.oid=relation.relnamespace
         WHERE namespace.nspname='public' AND relation.relkind IN ('r','p','v','m','f')
           AND left(relation.relname,length('pos_manual_'))='pos_manual_'
           AND relation.relname<>'pos_manual_payment_references'
         ORDER BY relation.relname
      `);
      for (const role of [runtimeRole, ...roles]) for (const relation of protectedRelations.rows) {
        assert.equal((await migrator.query("SELECT has_any_column_privilege($1,$2,'SELECT,INSERT,UPDATE,REFERENCES') allowed", [role, relation.identity])).rows[0]?.allowed, false, `${role} has column privilege on ${relation.identity}`);
        assert.equal((await migrator.query("SELECT has_table_privilege($1,$2,'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER') allowed", [role, relation.identity])).rows[0]?.allowed, false, `${role} has table privilege on ${relation.identity}`);
      }
      assert.equal((await migrator.query("SELECT has_table_privilege($1,'pos_manual_payment_references','SELECT,INSERT,UPDATE,DELETE') allowed", [runtimeRole])).rows[0]?.allowed, true);
      for (const role of roles) {
        assert.equal((await migrator.query("SELECT has_table_privilege($1,'pos_manual_payment_references','SELECT,INSERT,UPDATE,DELETE') allowed", [role])).rows[0]?.allowed, false);
      }
      assert.equal((await migrator.query("SELECT count(*)::integer count FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relowner=(SELECT oid FROM pg_roles WHERE rolname=$1)", [runtimeRole])).rows[0]?.count, 0);
      const panDefinition = (await migrator.query<{ definition: string }>("SELECT pg_get_functiondef('pos_manual_identifier_contains_pan_321f(text)'::regprocedure) definition")).rows[0]!.definition;
      await migrator.query(`CREATE OR REPLACE FUNCTION pos_manual_identifier_contains_pan_321f(p_value text) RETURNS boolean LANGUAGE plpgsql IMMUTABLE STRICT SET search_path=pg_catalog AS $$ BEGIN RETURN false; END $$`);
      await assertReconcileRejected(migratorUrl, database, runtimeRole, migratorRole, roles, /function code manifest mismatch/);
      await migrator.query(panDefinition);
      await reconcile(migratorUrl, database, runtimeRole, migratorRole, roles);
      await migrator.query(panDefinition.replace("DECLARE candidate", "DECLARE  candidate"));
      await assertReconcileRejected(migratorUrl, database, runtimeRole, migratorRole, roles, /function code manifest mismatch/);
      await migrator.query(panDefinition); await reconcile(migratorUrl, database, runtimeRole, migratorRole, roles);
      const bindingShapes = await migrator.query<{ conname: string; definition: string }>(`SELECT conname,pg_get_constraintdef(oid,true) definition FROM pg_constraint c
        WHERE c.conrelid='pos_manual_payment_vault_bindings'::regclass AND ((c.contype='u' AND (SELECT array_agg(a.attname::text ORDER BY k.ordinality) FROM unnest(c.conkey) WITH ORDINALITY k(attnum,ordinality) JOIN pg_attribute a ON a.attrelid=c.conrelid AND a.attnum=k.attnum) IN (ARRAY['case_id'],ARRAY['stable_reference_index'],ARRAY['vault_provider','vault_reference']))
          OR (c.contype='f' AND c.confrelid='pos_manual_payment_cases'::regclass)) ORDER BY conname`);
      assert.equal(bindingShapes.rowCount, 4);
      for (const constraint of bindingShapes.rows) {
        await migrator.query(`ALTER TABLE pos_manual_payment_vault_bindings DROP CONSTRAINT "${constraint.conname}"`);
        await assertReconcileRejected(migratorUrl, database, runtimeRole, migratorRole, roles, /unique constraint missing|foreign key missing/);
        await migrator.query(`ALTER TABLE pos_manual_payment_vault_bindings ADD ${constraint.definition}`);
      }
      await reconcile(migratorUrl, database, runtimeRole, migratorRole, roles);
      const caseUnique = (await migrator.query<{ conname: string; definition: string }>(`SELECT conname,pg_get_constraintdef(oid,true) definition FROM pg_constraint c WHERE c.conrelid='pos_manual_payment_vault_bindings'::regclass AND c.contype='u' AND (SELECT array_agg(a.attname::text ORDER BY k.ordinality) FROM unnest(c.conkey) WITH ORDINALITY k(attnum,ordinality) JOIN pg_attribute a ON a.attrelid=c.conrelid AND a.attnum=k.attnum)=ARRAY['case_id']`)).rows[0]!;
      await migrator.query(`ALTER TABLE pos_manual_payment_vault_bindings DROP CONSTRAINT "${caseUnique.conname}", ADD UNIQUE(case_id) DEFERRABLE INITIALLY DEFERRED`);
      await assertReconcileRejected(migratorUrl, database, runtimeRole, migratorRole, roles, /unique constraint missing/);
      const deferredName = (await migrator.query<{ conname: string }>("SELECT conname FROM pg_constraint WHERE conrelid='pos_manual_payment_vault_bindings'::regclass AND contype='u' AND condeferrable AND conkey=ARRAY[(SELECT attnum::smallint FROM pg_attribute WHERE attrelid='pos_manual_payment_vault_bindings'::regclass AND attname='case_id')]")).rows[0]!.conname;
      await migrator.query(`ALTER TABLE pos_manual_payment_vault_bindings DROP CONSTRAINT "${deferredName}", ADD ${caseUnique.definition}`);
      const trigger = (await migrator.query<{ definition: string }>("SELECT pg_get_triggerdef(oid,true) definition FROM pg_trigger WHERE tgname='pos_manual_open_requests_guard'")).rows[0]!;
      await migrator.query("DROP TRIGGER pos_manual_open_requests_guard ON pos_manual_open_requests");
      await migrator.query("CREATE TRIGGER pos_manual_open_requests_guard BEFORE UPDATE ON pos_manual_open_requests FOR EACH ROW WHEN (false) EXECUTE FUNCTION guard_pos_manual_open_request_321f()");
      await assertReconcileRejected(migratorUrl, database, runtimeRole, migratorRole, roles, /trigger shape mismatch/);
      await migrator.query("DROP TRIGGER pos_manual_open_requests_guard ON pos_manual_open_requests"); await migrator.query(trigger.definition);
      await migrator.query("CREATE TRIGGER pos_manual_open_requests_guard_extra BEFORE UPDATE ON pos_manual_open_requests FOR EACH ROW EXECUTE FUNCTION guard_pos_manual_open_request_321f()");
      await assertReconcileRejected(migratorUrl, database, runtimeRole, migratorRole, roles, /extra or missing helper trigger/);
      await migrator.query("DROP TRIGGER pos_manual_open_requests_guard_extra ON pos_manual_open_requests");
      await migrator.query("CREATE FUNCTION arbitrary_trigger_321f() RETURNS trigger LANGUAGE plpgsql AS 'BEGIN RETURN NEW; END'");
      await migrator.query("CREATE TRIGGER arbitrary_trigger_321f BEFORE INSERT ON pos_manual_open_requests FOR EACH ROW EXECUTE FUNCTION arbitrary_trigger_321f()");
      await assertReconcileRejected(migratorUrl, database, runtimeRole, migratorRole, roles, /graph trigger catalog mismatch/);
      await migrator.query("DROP TRIGGER arbitrary_trigger_321f ON pos_manual_open_requests"); await migrator.query("DROP FUNCTION arbitrary_trigger_321f()");
      const legacyTrigger = (await migrator.query<{ definition: string }>("SELECT pg_get_triggerdef(oid,true) definition FROM pg_trigger WHERE tgname='pos_manual_vault_bindings_append_only'")).rows[0]!;
      await migrator.query("DROP TRIGGER pos_manual_vault_bindings_append_only ON pos_manual_payment_vault_bindings");
      await migrator.query("CREATE TRIGGER pos_manual_vault_bindings_append_only BEFORE UPDATE OR DELETE ON pos_manual_payment_vault_bindings FOR EACH ROW WHEN (false) EXECUTE FUNCTION protect_pos_manual_append_only()");
      await assertReconcileRejected(migratorUrl, database, runtimeRole, migratorRole, roles, /full trigger definition manifest mismatch/);
      await migrator.query("DROP TRIGGER pos_manual_vault_bindings_append_only ON pos_manual_payment_vault_bindings"); await migrator.query(legacyTrigger.definition);
      const legacySignatures = [
        "protect_pos_manual_append_only()",
        "guard_pos_manual_operation()",
        "guard_pos_manual_state_event()",
        "protect_pos_manual_case()",
        "stamp_pos_manual_ledger()",
        "validate_pos_manual_case_open_commit()",
        "validate_pos_manual_transition_commit()",
      ];
      const t2PureGuards = new Set(["guard_pos_manual_operation()", "guard_pos_manual_state_event()", "protect_pos_manual_case()"]);
      for (const signature of legacySignatures) {
        const expectedSearchPath = t2PureGuards.has(signature) ? "search_path=pg_catalog" : "search_path=pg_catalog, public";
        const shape = await migrator.query<{ owner_ok: boolean; search_path_ok: boolean; invoker: boolean }>(`
          SELECT proowner=(SELECT oid FROM pg_roles WHERE rolname=$1) owner_ok,
                 proconfig=ARRAY[$3]::text[] search_path_ok,
                 NOT prosecdef invoker
            FROM pg_proc WHERE oid=$2::regprocedure
        `, [migratorRole, signature, expectedSearchPath]);
        assert.deepEqual(shape.rows[0], { owner_ok: true, search_path_ok: true, invoker: !t2PureGuards.has(signature) }, signature);
        await migrator.query(`ALTER FUNCTION ${signature} SET search_path=${t2PureGuards.has(signature) ? "pg_catalog, public" : "pg_catalog"}`);
        await assertReconcileRejected(migratorUrl, database, runtimeRole, migratorRole, roles, /legacy function security shape mismatch/);
        await migrator.query(`ALTER FUNCTION ${signature} SET ${expectedSearchPath}`);
        await reconcile(migratorUrl, database, runtimeRole, migratorRole, roles);
        await migrator.query(`ALTER FUNCTION ${signature} SECURITY ${t2PureGuards.has(signature) ? "INVOKER" : "DEFINER"}`);
        await assertReconcileRejected(migratorUrl, database, runtimeRole, migratorRole, roles, /legacy function security shape mismatch/);
        await migrator.query(`ALTER FUNCTION ${signature} SECURITY ${t2PureGuards.has(signature) ? "DEFINER" : "INVOKER"}`);
        await reconcile(migratorUrl, database, runtimeRole, migratorRole, roles);
      }
      const protectDefinition = (await migrator.query<{ definition: string }>("SELECT pg_get_functiondef('protect_pos_manual_append_only()'::regprocedure) definition")).rows[0]!.definition;
      await migrator.query("CREATE OR REPLACE FUNCTION protect_pos_manual_append_only() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog, public AS $$ BEGIN RETURN NEW; END $$");
      await assertReconcileRejected(migratorUrl, database, runtimeRole, migratorRole, roles, /function code manifest mismatch/);
      await migrator.query(protectDefinition); await reconcile(migratorUrl, database, runtimeRole, migratorRole, roles);
      const canonicalDefinition = (await migrator.query<{ definition: string }>("SELECT pg_get_functiondef('pos_manual_canonical_json_v1(jsonb)'::regprocedure) definition")).rows[0]!.definition;
      await migrator.query("CREATE OR REPLACE FUNCTION pos_manual_canonical_json_v1(p_value jsonb) RETURNS text LANGUAGE sql IMMUTABLE STRICT SECURITY DEFINER SET search_path=pg_catalog AS $$ SELECT p_value::text $$");
      await assertReconcileRejected(migratorUrl, database, runtimeRole, migratorRole, roles, /partial T2-00 deployment: function code manifest mismatch/);
      await migrator.query(canonicalDefinition); await reconcile(migratorUrl, database, runtimeRole, migratorRole, roles);
      const profileTrigger = (await migrator.query<{ definition: string }>("SELECT pg_get_triggerdef(oid,true) definition FROM pg_trigger WHERE tgname='pos_manual_fin_profiles_inert_guard'")).rows[0]!.definition;
      await migrator.query("DROP TRIGGER pos_manual_fin_profiles_inert_guard ON pos_manual_finalization_profiles");
      await migrator.query("CREATE TRIGGER pos_manual_fin_profiles_inert_guard BEFORE INSERT OR UPDATE OR DELETE ON pos_manual_finalization_profiles FOR EACH ROW WHEN (false) EXECUTE FUNCTION guard_pos_manual_t2_profile_inert()");
      await assertReconcileRejected(migratorUrl, database, runtimeRole, migratorRole, roles, /partial T2-00 deployment: trigger manifest mismatch/);
      await migrator.query("DROP TRIGGER pos_manual_fin_profiles_inert_guard ON pos_manual_finalization_profiles");
      await migrator.query(profileTrigger); await reconcile(migratorUrl, database, runtimeRole, migratorRole, roles);
      const t2Constraint = (await migrator.query<{ definition: string }>("SELECT pg_get_constraintdef(oid,true) definition FROM pg_constraint WHERE conrelid='sales'::regclass AND conname='sales_manual_payment_source_check'")).rows[0]!.definition;
      await migrator.query("ALTER TABLE sales DROP CONSTRAINT sales_manual_payment_source_check");
      await migrator.query("ALTER TABLE sales ADD CONSTRAINT sales_manual_payment_source_check CHECK (true)");
      await assertReconcileRejected(migratorUrl, database, runtimeRole, migratorRole, roles, /partial T2-00 deployment: constraint manifest mismatch/);
      await migrator.query("ALTER TABLE sales DROP CONSTRAINT sales_manual_payment_source_check");
      await migrator.query(`ALTER TABLE sales ADD CONSTRAINT sales_manual_payment_source_check ${t2Constraint}`);
      await reconcile(migratorUrl, database, runtimeRole, migratorRole, roles);
      const t2UniqueIndex = (await migrator.query<{ definition: string }>("SELECT pg_get_indexdef('sales_manual_payment_application_key'::regclass) definition")).rows[0]!.definition;
      await migrator.query("DROP INDEX sales_manual_payment_application_key");
      await migrator.query("CREATE UNIQUE INDEX sales_manual_payment_application_key ON sales(id)");
      await assertReconcileRejected(migratorUrl, database, runtimeRole, migratorRole, roles, /partial T2-00 deployment: unique index manifest mismatch/);
      await migrator.query("DROP INDEX sales_manual_payment_application_key");
      await migrator.query(t2UniqueIndex);
      await reconcile(migratorUrl, database, runtimeRole, migratorRole, roles);
      await admin.query(`ALTER ROLE "${migratorRole}" INHERIT`);
      await assertReconcileRejected(migratorUrl, database, runtimeRole, migratorRole, roles, /migrator role attributes are unsafe/);
      assert.equal((await migrator.query("SELECT has_database_privilege($1,current_database(),'CONNECT') allowed", [runtimeRole])).rows[0]?.allowed, false);
      assert.equal((await migrator.query("SELECT has_schema_privilege($1,'public','USAGE') allowed", [runtimeRole])).rows[0]?.allowed, false);
      assert.equal((await migrator.query("SELECT has_function_privilege($1,'pos_manual_prepare_open_v1(text,integer,integer,text,timestamptz,text,text,text)','EXECUTE') allowed", [runtimeRole])).rows[0]?.allowed, false);
      await admin.query(`ALTER ROLE "${migratorRole}" NOINHERIT`);
      await reconcile(migratorUrl, database, runtimeRole, migratorRole, roles);
      const check = (await migrator.query<{ conname: string; definition: string }>(`SELECT conname,pg_get_constraintdef(oid,true) definition FROM pg_constraint WHERE conrelid='pos_manual_payment_vault_verifiers'::regclass AND contype='c' AND pg_get_constraintdef(oid,true) LIKE '%max_future_skew_seconds%'`)).rows[0]!;
      await migrator.query(`ALTER TABLE pos_manual_payment_vault_verifiers DROP CONSTRAINT "${check.conname}"`);
      await assertReconcileRejected(migratorUrl, database, runtimeRole, migratorRole, roles, /canonical CHECK manifest mismatch|lifecycle or DLP check/);
      await migrator.query(`ALTER TABLE pos_manual_payment_vault_verifiers ADD ${check.definition}`);
      await reconcile(migratorUrl, database, runtimeRole, migratorRole, roles);
      await migrator.query("UPDATE _prisma_migrations SET checksum='bad' WHERE migration_name='20260829321200_pos_manual_open_vault_capabilities'");
      await assertReconcileRejected(migratorUrl, database, runtimeRole, migratorRole, roles, /checksum mismatch/);
      await migrator.query("UPDATE _prisma_migrations SET checksum='ec7b4f84b9321a93a204d6b15b0c727169e3752d0e5a580f1b4dcb730adfc281' WHERE migration_name='20260829321200_pos_manual_open_vault_capabilities'");
      await reconcile(migratorUrl, database, runtimeRole, migratorRole, roles);
      await migrator.query("UPDATE _prisma_migrations SET checksum='bad' WHERE migration_name='20260829322000_pos_manual_payment_t2_foundation'");
      await assertReconcileRejected(migratorUrl, database, runtimeRole, migratorRole, roles, /partial T2-00 deployment: migration ledger missing or checksum mismatch/);
      await migrator.query("UPDATE _prisma_migrations SET checksum='db6dd828c243bbfdd884cbaf25d2986901be59c76cd6dfbaf6323a30e8fc2e69' WHERE migration_name='20260829322000_pos_manual_payment_t2_foundation'");
      await reconcile(migratorUrl, database, runtimeRole, migratorRole, roles);
      await migrator.query(`ALTER DEFAULT PRIVILEGES FOR ROLE "${migratorRole}" IN SCHEMA public GRANT SELECT ON TABLES TO "${rogueRole}"`);
      await assertReconcileRejected(migratorUrl, database, runtimeRole, migratorRole, roles, /migrator default ACL grants authority to a non-owner principal/);
      await migrator.query(`ALTER DEFAULT PRIVILEGES FOR ROLE "${migratorRole}" IN SCHEMA public REVOKE SELECT ON TABLES FROM "${rogueRole}"`);
      await reconcile(migratorUrl, database, runtimeRole, migratorRole, roles);
      assert.equal((await migrator.query(`
        SELECT count(*)::integer count FROM pg_default_acl defaults
        CROSS JOIN LATERAL aclexplode(defaults.defaclacl) privilege
        WHERE defaults.defaclrole=(SELECT oid FROM pg_roles WHERE rolname=$1)
          AND (defaults.defaclnamespace=0 OR defaults.defaclnamespace=(SELECT oid FROM pg_namespace WHERE nspname='public'))
          AND privilege.grantee<>(SELECT oid FROM pg_roles WHERE rolname=$1)
      `, [migratorRole])).rows[0]?.count, 0);
      assert.equal((await migrator.query(`
        SELECT count(*)::integer count
          FROM pg_class relation JOIN pg_namespace namespace ON namespace.oid=relation.relnamespace
          CROSS JOIN unnest($1::name[]) operational_role
         WHERE namespace.nspname='public' AND relation.relkind IN ('r','p','v','m','S','f')
           AND left(relation.relname,length('pos_manual_'))='pos_manual_'
           AND relation.relname<>'pos_manual_payment_references'
           AND CASE WHEN relation.relkind='S'
             THEN has_sequence_privilege(operational_role,relation.oid,'USAGE,SELECT,UPDATE')
             ELSE has_any_column_privilege(operational_role,relation.oid,'SELECT,INSERT,UPDATE,REFERENCES')
               OR has_table_privilege(operational_role,relation.oid,'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
           END
      `, [[runtimeRole, ...roles]])).rows[0]?.count, 0);
    } finally { await Promise.all([runtime.end(), binder.end(), migrator.end(), ...operationalClients.map((client) => client.end())]); }
  } finally {
    await admin.query("SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname=$1", [database]).catch(() => undefined);
    await admin.query(`DROP DATABASE IF EXISTS "${database}"`).catch(() => undefined);
    for (const role of [runtimeRole, ...roles, rogueRole, migratorRole]) await admin.query(`DROP ROLE IF EXISTS "${role}"`).catch(() => undefined);
    await admin.end();
  }
});

function roleUrl(base: string, username: string, password: string, database: string) {
  const url = new URL(base);
  url.username = username;
  url.password = password;
  url.pathname = `/${database}`;
  return url.toString();
}

async function assertSqlState(client: Client, sql: string, expectedCode: string, values?: unknown[]) {
  await assert.rejects(client.query(sql, values), (error: DatabaseError) => {
    assert.equal(error.code, expectedCode, error.message);
    return true;
  });
}

async function reconcile(
  migratorUrl: string,
  database: string,
  runtimeRole: string,
  migratorRole: string,
  [manualWorkerRole, manualCallbackRole, stepupIssuerRole, manualHomologatorRole, manualVaultBinderRole, manualProfileAdminIssuerRole, manualProfileAccountingIssuerRole, manualProfileFiscalIssuerRole, manualSweeperRole]: string[],
) {
  const connection = new URL(migratorUrl);
  await execFileAsync("psql", [
    "--no-psqlrc",
    "--no-password",
    "-v", "ON_ERROR_STOP=1",
    "-v", `database_name=${database}`,
    "-v", `runtime_role=${runtimeRole}`,
    "-v", `migrator_role=${migratorRole}`,
    "-v", `manual_worker_role=${manualWorkerRole}`,
    "-v", `manual_callback_role=${manualCallbackRole}`,
    "-v", `stepup_issuer_role=${stepupIssuerRole}`,
    "-v", `manual_homologator_role=${manualHomologatorRole}`,
    "-v", `manual_vault_binder_role=${manualVaultBinderRole}`,
    "-v", `manual_profile_admin_issuer_role=${manualProfileAdminIssuerRole}`,
    "-v", `manual_profile_accounting_issuer_role=${manualProfileAccountingIssuerRole}`,
    "-v", `manual_profile_fiscal_issuer_role=${manualProfileFiscalIssuerRole}`,
    "-v", `manual_sweeper_role=${manualSweeperRole}`,
    "-f", "deploy/reconcile-tenant-runtime-grants.sql",
  ], { env: {
    ...process.env,
    PGHOST: connection.hostname,
    PGPORT: connection.port,
    PGUSER: decodeURIComponent(connection.username),
    PGPASSWORD: decodeURIComponent(connection.password),
    PGDATABASE: database,
  } });
}

async function assertReconcileRejected(
  migratorUrl: string,
  database: string,
  runtimeRole: string,
  migratorRole: string,
  operationalRoles: string[],
  expected: RegExp,
) {
  await assert.rejects(
    reconcile(migratorUrl, database, runtimeRole, migratorRole, operationalRoles),
    (error: NodeJS.ErrnoException & { stderr?: string }) => {
      assert.match(`${error.message}\n${error.stderr ?? ""}`, expected);
      return true;
    },
  );
}
