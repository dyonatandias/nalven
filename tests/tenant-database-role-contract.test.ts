import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const provision = readFileSync("deploy/provision-tenant.sh", "utf8");
const bootstrap = readFileSync("deploy/bootstrap-root.sh", "utf8");
const release = readFileSync("deploy/deploy-release.sh", "utf8");
const grants = readFileSync("deploy/reconcile-tenant-runtime-grants.sql", "utf8");
const grantsRunner = readFileSync("deploy/reconcile-tenant-runtime-grants.sh", "utf8");
const service = readFileSync("deploy/nalven.service", "utf8");
const jobsRunner = readFileSync("deploy/process-tenant-jobs.sh", "utf8");
const jobsService = readFileSync("deploy/nalven-tenant-jobs.service", "utf8");
const jobsTimer = readFileSync("deploy/nalven-tenant-jobs.timer", "utf8");
const provisioningRunner = readFileSync("deploy/process-tenant-provisioning.sh", "utf8");
const provisioningService = readFileSync("deploy/nalven-tenant-provisioning.service", "utf8");
const provisioningTimer = readFileSync("deploy/nalven-tenant-provisioning.timer", "utf8");
const bundleInstaller = readFileSync("deploy/install-tenant-migration-bundle.sh", "utf8");
const migrationRunner = readFileSync("deploy/run-tenant-migration-bundle.sh", "utf8");
const tenantClient = readFileSync("db/tenant.ts", "utf8");
const vaultBinderService = readFileSync("deploy/nalven-pos-vault-binder@.service", "utf8");
const vaultBinderCutover = readFileSync("deploy/cutover-tenant-manual-vault-binder.sh", "utf8");
const profileIssuerCutover = readFileSync("deploy/cutover-tenant-manual-profile-issuers.sh", "utf8");
const profileIssuerServices = [
  readFileSync("deploy/nalven-pos-profile-admin-issuer@.service", "utf8"),
  readFileSync("deploy/nalven-pos-profile-accounting-issuer@.service", "utf8"),
  readFileSync("deploy/nalven-pos-profile-fiscal-issuer@.service", "utf8"),
];
const sweeperCutover = readFileSync("deploy/cutover-tenant-manual-sweeper.sh", "utf8");
const sweeperRunner = readFileSync("deploy/process-pos-manual-sweep.sh", "utf8");
const sweeperService = readFileSync("deploy/nalven-pos-manual-sweep.service", "utf8");
const sweeperTimer = readFileSync("deploy/nalven-pos-manual-sweep.timer", "utf8");

test("provisionamento separa arquivo runtime do migrator e nunca faz fallback legado", () => {
  assert.match(provision, /runtime_config_dir=\/etc\/nalven\/tenants/);
  assert.match(provision, /migrator_config_dir=\/etc\/nalven\/tenant-migrators/);
  assert.match(provision, /TENANT_DATABASE_URL=postgresql:\/\//);
  assert.match(provision, /TENANT_MIGRATOR_DATABASE_URL=postgresql:\/\//);
  assert.match(provision, /chmod 0640 "\$runtime_partial"/);
  assert.match(provision, /chmod 0600 "\$migrator_partial"/);
  assert.match(provision, /runtime_group.*!= nalven-app/);
  assert.match(provision, /migrator_mode.*!= 600/);
  assert.match(provision, /credenciais de autoridade parciais/);
  assert.match(provision, /for required_authority_group in nalven-pos-worker nalven-pos-callback nalven-pos-stepup nalven-pos-homologator/);
  assert.match(provision, /getent group "\$required_authority_group"/);
  assert.match(provision, /Grupo de autoridade manual ausente/);
  assert.doesNotMatch(provision, /(?:groupadd|addgroup|useradd)[^\n]*(?:nalven-pos-worker|nalven-pos-callback|nalven-pos-stepup|nalven-pos-homologator)/);
  assert.doesNotMatch(provision, /TENANT_DATABASE_URL="\$runtime_database_url"[^\n]*migrate deploy/);
});

test("provisionamento cria autoridades manuais distintas com credenciais isoladas", () => {
  for (const role of ["manual_worker_role", "manual_callback_role", "stepup_issuer_role", "manual_homologator_role", "manual_vault_binder_role", "manual_profile_admin_issuer_role", "manual_profile_accounting_issuer_role", "manual_profile_fiscal_issuer_role", "manual_sweeper_role"]) {
    assert.match(provision, new RegExp(`readonly ${role}=`));
    assert.match(provision, new RegExp(`CREATE ROLE \\\"\\$${role}\\\"|\\$${role}:\\$`));
  }
  assert.match(provision, /tenant-manual-workers/);
  assert.match(provision, /tenant-manual-callbacks/);
  assert.match(provision, /tenant-stepup-issuers/);
  assert.match(provision, /tenant-manual-homologators/);
  assert.match(provision, /TENANT_MANUAL_WORKER_DATABASE_URL=/);
  assert.match(provision, /TENANT_MANUAL_CALLBACK_DATABASE_URL=/);
  assert.match(provision, /TENANT_STEPUP_ISSUER_DATABASE_URL=/);
  assert.match(provision, /TENANT_MANUAL_HOMOLOGATOR_DATABASE_URL=/);
  assert.match(provision, /TENANT_MANUAL_VAULT_BINDER_DATABASE_URL=/);
  assert.match(provision, /TENANT_MANUAL_PROFILE_ADMIN_ISSUER_DATABASE_URL=/);
  assert.match(provision, /TENANT_MANUAL_PROFILE_ACCOUNTING_ISSUER_DATABASE_URL=/);
  assert.match(provision, /TENANT_MANUAL_PROFILE_FISCAL_ISSUER_DATABASE_URL=/);
  assert.match(provision, /NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS/);
  assert.match(provision, /credenciais de autoridade parciais/);
  for (const osUser of ["nalven-pos-worker", "nalven-pos-callback", "nalven-pos-stepup", "nalven-pos-homologator", "nalven-pos-vault-binder", "nalven-pos-profile-admin", "nalven-pos-profile-accounting", "nalven-pos-profile-fiscal", "nalven-pos-manual-sweeper"]) {
    assert.match(bootstrap, new RegExp(osUser));
  }
  for (const directory of ["tenant-manual-workers", "tenant-manual-callbacks", "tenant-stepup-issuers", "tenant-manual-homologators", "tenant-manual-vault-binders", "tenant-manual-profile-admin-issuers", "tenant-manual-profile-accounting-issuers", "tenant-manual-profile-fiscal-issuers", "tenant-manual-sweepers"]) {
    assert.match(bootstrap, new RegExp(directory));
    assert.match(release, new RegExp(directory));
  }
  assert.match(release, /Credencial de autoridade manual ausente ou insegura/);
  assert.match(provision, /tenant-manual-homologators[\s\S]*nalven-pos-homologator|nalven-pos-homologator[\s\S]*tenant-manual-homologators/);
  assert.match(vaultBinderService, /User=nalven-pos-vault-binder/);
  assert.match(vaultBinderService, /EnvironmentFile=\/etc\/nalven\/tenant-manual-vault-binders\/%i\.env/);
  assert.match(vaultBinderService, /ConditionFileIsExecutable=\/usr\/local\/bin\/nalven-pos-vault-binder/);
  assert.doesNotMatch(`${bootstrap}\n${release}`, /enable --now[^\n]*nalven-pos-vault-binder/);
  assert.match(vaultBinderCutover, /line_count.*-eq 8.*line_count.*-eq 9/);
  assert.match(vaultBinderCutover, /ALTER ROLE[\s\S]*NOINHERIT NOREPLICATION NOBYPASSRLS/);
  assert.match(vaultBinderCutover, /TENANT_MANUAL_VAULT_BINDER_DATABASE_URL=/);
  assert.match(vaultBinderCutover, /chown root:nalven-pos-vault-binder/);
  assert.match(vaultBinderCutover, /chmod 0640/);
  assert.match(vaultBinderCutover, /reconcile-tenant-runtime-grants\.sh/);
  assert.match(vaultBinderCutover, /GRANT CONNECT ON DATABASE/);
  assert.match(vaultBinderCutover, /pg_auth_members/);
  assert.match(vaultBinderCutover, /\/etc\/nalven\/tenant-migrators/);
  assert.match(vaultBinderCutover, /readonly lock_dir=\/run\/lock\/nalven/);
  assert.match(vaultBinderCutover, /flock -x "\$cutover_lock_fd"/);
  assert.match(vaultBinderCutover, /manual-vault-binder-\$\{slug\}-\$\{database\}\.lock/);
  assert.match(vaultBinderCutover, /Arquivo de lock inseguro/);
  assert.match(vaultBinderCutover, /! -L "\$lock_file"/);
  assert.match(vaultBinderCutover, /Identidade do tenant mudou durante o cutover/);
  assert.doesNotMatch(vaultBinderCutover, /echo[^\n]*(?:binder_password|TENANT_MANUAL_VAULT_BINDER_DATABASE_URL)/);
  for (const script of [bootstrap, release]) assert.match(script, /cutover-tenant-manual-vault-binder\.sh/);
  for (const script of [bootstrap, release]) assert.match(script, /cutover-tenant-manual-profile-issuers\.sh/);
  assert.match(profileIssuerCutover, /roles=\("\$\{database\}_mpi" "\$\{database\}_mpa" "\$\{database\}_mpf"\)/);
  assert.match(profileIssuerCutover, /pg_auth_members/);
  assert.match(profileIssuerCutover, /NOINHERIT NOREPLICATION NOBYPASSRLS/);
  assert.match(profileIssuerCutover, /flock -x "\$cutover_lock_fd"/);
  assert.match(profileIssuerCutover, /TENANT_MANUAL_PROFILE_ADMIN_ISSUER_ROLE=/);
  assert.match(profileIssuerCutover, /TENANT_MANUAL_PROFILE_ACCOUNTING_ISSUER_ROLE=/);
  assert.match(profileIssuerCutover, /TENANT_MANUAL_PROFILE_FISCAL_ISSUER_ROLE=/);
  assert.match(profileIssuerCutover, /ACLs nominais reconciliadas; gate manual permanece hard-off/);
  assert.doesNotMatch(profileIssuerCutover, /echo[^\n]*(?:password|DATABASE_URL)/);
  for (const [index, suffix] of ["admin", "accounting", "fiscal"].entries()) {
    assert.match(profileIssuerServices[index]!, new RegExp(`User=nalven-pos-profile-${suffix}`));
    assert.match(profileIssuerServices[index]!, new RegExp(`EnvironmentFile=/etc/nalven/tenant-manual-profile-${suffix}-issuers/%i\\.env`));
    assert.match(profileIssuerServices[index]!, /ConditionFileIsExecutable=\/usr\/local\/bin\/nalven-pos-profile-/);
  }
  assert.doesNotMatch(`${bootstrap}\n${release}`, /enable --now[^\n]*nalven-pos-profile-(?:admin|accounting|fiscal)-issuer/);
});

test("bootstrap e release migram apenas com URL root-only e reconciliam grants", () => {
  for (const script of [bootstrap, release]) {
    assert.match(script, /TENANT_MIGRATOR_DATABASE_URL/);
    assert.match(script, /reconcile-tenant-runtime-grants\.sh/);
    assert.match(script, /sem (usar a URL runtime|fallback para a URL runtime)/);
    assert.match(script, /Credencial runtime insegura/);
    assert.doesNotMatch(script, /sed -n 's\/\^TENANT_DATABASE_URL=[\s\S]*migrate/);
  }
  assert.match(release, /reconcile-tenant-runtime-grants\.sql/);
  assert.match(release, /nalven-tenant-jobs\.service/);
  assert.match(release, /enable --now[^\n]*nalven-tenant-jobs\.timer/);
  for (const script of [bootstrap, release]) {
    assert.doesNotMatch(script, /(?:source|\.)\s+(?:"?\$app_env"?|\/etc\/nalven\/app\.env)/);
    assert.match(script, /tenant-provisioner\.env/);
    assert.match(script, /root:root:600|chown root:root/);
    assert.match(script, /CONTROL_DATABASE_URL não autenticou como nalven_app no banco nalven/);
  }
});

test("matriz concede DML, exclui histórico Prisma e retira autoridade DDL", () => {
  assert.match(grants, /GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES/);
  assert.match(grants, /immutable_table IN ARRAY/);
  assert.match(grants, /REVOKE UPDATE, DELETE ON TABLE public\.%I/);
  assert.match(grants, /GRANT USAGE, SELECT ON ALL SEQUENCES/);
  assert.doesNotMatch(grants, /GRANT USAGE, SELECT, UPDATE ON (ALL )?SEQUENCES/);
  assert.match(grants, /REVOKE ALL PRIVILEGES ON TABLE public\._prisma_migrations/);
  assert.match(grants, /REVOKE ALL PRIVILEGES ON DATABASE :"database_name" FROM PUBLIC/);
  assert.match(grants, /GRANT CONNECT ON DATABASE :"database_name" TO :"runtime_role"/);
  assert.match(grants, /REVOKE ALL PRIVILEGES ON SCHEMA public FROM :"runtime_role"/);
  assert.match(grants, /REVOKE ALL PRIVILEGES ON ALL FUNCTIONS IN SCHEMA public FROM PUBLIC/);
  assert.match(grants, /ALTER DEFAULT PRIVILEGES FOR ROLE :"migrator_role"/);
  assert.match(grants, /REVOKE ALL PRIVILEGES ON TABLES FROM :"runtime_role"/);
  assert.match(grants, /REVOKE ALL PRIVILEGES ON SEQUENCES FROM :"runtime_role"/);
  assert.doesNotMatch(grants, /ALTER DEFAULT PRIVILEGES[^;]+GRANT[^;]+TO :"runtime_role"/);
  assert.match(grants, /'pos_payment_plan_operations'/);
  assert.match(grants, /'pos_payment_plan_quote_lines'/);
  assert.match(grants, /'pos_payment_plan_slots'/);
  assert.match(grants, /runtime role % retained DDL or temporary-object privileges/);
  for (const variable of ["manual_worker_role", "manual_callback_role", "stepup_issuer_role", "manual_homologator_role", "manual_vault_binder_role", "manual_profile_admin_issuer_role", "manual_profile_accounting_issuer_role", "manual_profile_fiscal_issuer_role", "manual_sweeper_role"]) {
    assert.match(grants, new RegExp(`nalven\\.${variable}`));
    assert.match(grantsRunner, new RegExp(`TENANT_${variable.replace(/manual_/g, "MANUAL_").replace("stepup_issuer", "STEPUP_ISSUER").toUpperCase()}`));
  }
  assert.match(grants, /left\(relation\.relname,length\('pos_manual_'\)\)='pos_manual_'/);
  assert.match(grants, /left\(protected_table\.relname,length\('pos_manual_'\)\)='pos_manual_'/);
  assert.match(grants, /dependency\.refobjid=protected_table\.oid AND dependency\.deptype IN \('a','i'\)/);
  assert.match(grants, /sequence_relation\.relkind='S'/);
  assert.doesNotMatch(grants, /relname LIKE 'pos_manual_payment_%'/);
  const manualExceptions = [...grants.matchAll(/(?:c|relation|protected_table)\.relname\s*<>\s*'([^']+)'/g)].map((match) => match[1]);
  assert.deepEqual([...new Set(manualExceptions)], ["pos_manual_payment_references"]);
  assert.match(grants, /REVOKE ALL PRIVILEGES ON TABLE %I\.%I FROM %I/);
  assert.match(grants, /REVOKE ALL PRIVILEGES ON SEQUENCE %I\.%I FROM %I/);
  assert.match(grants, /operational role % retained direct privilege/);
  assert.match(grants, /GRANT EXECUTE ON FUNCTION public\.pos_manual_issue_step_up_v1\(uuid,integer,integer,text,text,text,text,text,text,text\) TO %I/);
  assert.match(grants, /GRANT EXECUTE ON FUNCTION public\.pos_manual_review_case_v1\(uuid,integer,integer,text,text,text,text,text,text\) TO %I/);
  assert.match(grants, /step-up issuer function EXECUTE allowlist diverges/);
  assert.match(grants, /manual review function EXECUTE allowlist diverges/);
  assert.match(grants, /manual callback function EXECUTE allowlist diverges/);
  assert.match(grants, /manual worker function EXECUTE allowlist diverges/);
  assert.match(grants, /321f function EXECUTE allowlist diverges/);
  assert.match(grants, /partial 321f deployment: tables or binding proof column missing/);
  assert.match(grants, /partial 321f deployment: function missing/);
  assert.match(grants, /signature=ANY\(ARRAY\['public\.guard_pos_manual_operation\(\)'[\s\S]+public\.guard_pos_manual_state_event\(\)'[\s\S]+public\.protect_pos_manual_case\(\)'\]/);
  assert.match(grants, /IF NOT marker_present THEN RETURN/);
  assert.match(grants, /pos_manual_payment_vault_verifiers/);
  assert.match(grants, /attname IN \('vault_proof_id','binding_kind'\)/);
  assert.match(grants, /Quarantine is committed independently/);
  assert.match(grants, /pos_manual_open_requests/);
  assert.match(grants, /pos_manual_vault_proofs/);
  for (const signature of ["pos_manual_prepare_open_v1", "pos_manual_open_status_v1", "pos_manual_claim_open_for_vault_v1", "pos_manual_open_case_v1", "pos_manual_abandon_open_v1", "pos_manual_probe_open_v1"]) assert.match(grants, new RegExp(signature));
  assert.match(grants, /pos_manual_prepare_open_v1[^\n]+nalven\.runtime_role/);
  assert.match(grants, /pos_manual_open_status_v1[^\n]+nalven\.runtime_role/);
  for (const signature of ["pos_manual_claim_open_for_vault_v1", "pos_manual_open_case_v1", "pos_manual_abandon_open_v1", "pos_manual_probe_open_v1"]) assert.match(grants, new RegExp(`${signature}[^\\n]+nalven\\.manual_vault_binder_role`));
  assert.match(grants, /manual proof capability owner\/SECURITY DEFINER\/search_path diverges/);
  assert.match(grants, /to_regclass\('public\.pos_manual_t2_authorities'\) IS NOT NULL[\s\S]+ARRAY\['search_path=pg_catalog'\]/);
  assert.doesNotMatch(grants, /GRANT EXECUTE ON (?:ALL )?FUNCTIONS/);
  assert.match(grants, /pg_auth_members membership[\s\S]+membership\.member[\s\S]+membership\.roleid/);
  assert.match(grants, /pg_database database[\s\S]+aclexplode/);
  assert.match(grants, /pg_namespace namespace[\s\S]+aclexplode/);
  assert.match(grants, /privilege\.grantee=0/);
  assert.match(grants, /public object owner is not the migrator/);
  assert.match(grants, /migrator default ACL grants authority to a non-owner principal/);
  assert.match(grants, /20260829322000_pos_manual_payment_t2_foundation/);
  assert.match(grants, /db6dd828c243bbfdd884cbaf25d2986901be59c76cd6dfbaf6323a30e8fc2e69/);
  assert.match(grants, /partial T2-00 deployment: relation catalog manifest mismatch/);
  assert.match(grants, /partial T2-00 deployment: legacy relation column manifest mismatch/);
  assert.match(grants, /partial T2-00 deployment: constraint manifest mismatch/);
  assert.match(grants, /partial T2-00 deployment: unique index manifest mismatch/);
  assert.match(grants, /migration_name='20260829322000_pos_manual_payment_t2_foundation'\);/);
  assert.match(grants, /partial T2-00 deployment: function code manifest mismatch/);
  assert.match(grants, /partial T2-00 deployment: trigger manifest mismatch/);
  assert.match(grants, /T2-00 hard-off invariant diverges/);
  assert.match(grants, /20260829322100_pos_manual_payment_t2_profile_lifecycle/);
  assert.match(grants, /partial T2-01 deployment: relation catalog manifest mismatch/);
  assert.match(grants, /partial T2-01 deployment: function body\/security manifest mismatch/);
  assert.match(grants, /partial T2-01 deployment: trigger manifest mismatch/);
  assert.match(grants, /T2-01 internal legacy implementation security shape mismatch/);
  assert.match(grants, /T2-01 internal legacy implementation is operationally executable/);
  assert.match(grants, /routine\.proconfig=ARRAY\['search_path=pg_catalog, public'\]/);
  for (const signature of [
    "pos_manual_prepare_session_transition_v1",
    "pos_manual_prepare_handoff_transition_v1",
    "pos_manual_t2_write_observation_multiset_digest_v1",
    "pos_manual_t2_float8_hex_v1",
    "pos_manual_t2_held_sale_items_request_hash_v1",
    "pos_manual_prepare_held_sale_items_write_v1",
    "pos_manual_t2_payment_plan_graph_request_hash_v1",
    "pos_manual_t2_payment_plan_draft_snapshot_hash_v1",
    "pos_manual_prepare_payment_plan_graph_write_v1",
    "pos_manual_prepare_order_claim_write_v1",
    "pos_manual_t2_payment_intent_request_hash_v1",
    "pos_manual_prepare_payment_intent_write_v1",
    "pos_manual_t2_manual_reference_request_hash_v1",
    "pos_manual_prepare_manual_payment_reference_write_v1",
    "pos_manual_t2_sale_payment_request_hash_v1",
    "pos_manual_prepare_sale_payment_write_v1",
    "pos_manual_put_finalization_profile_v1",
  ]) assert.match(grants, new RegExp(`GRANT EXECUTE ON FUNCTION public\\.${signature}[^\\n]+nalven\\.runtime_role`));
  assert.doesNotMatch(grants, /GRANT EXECUTE ON FUNCTION public\.pos_manual_prepare_plan_release_v1/);
  assert.match(grants, /obsolete T2-01 plan release prelock is executable by runtime/);
  assert.match(grants, /pos_manual_issue_profile_admin_assertion_v1[^\n]+nalven\.manual_profile_admin_issuer_role/);
  assert.match(grants, /pos_manual_issue_profile_accounting_assertion_v1[^\n]+nalven\.manual_profile_accounting_issuer_role/);
  assert.match(grants, /pos_manual_issue_profile_fiscal_assertion_v1[^\n]+nalven\.manual_profile_fiscal_issuer_role/);
  assert.match(grants, /T2-01 capability EXECUTE allowlist diverges/);
  assert.match(grants, /T2-01 profile assertion issuer escaped allowlist/);
  for (const [capability, roleSetting] of [
    ["manual_callback", "manual_callback_role"],
    ["manual_worker", "manual_worker_role"],
    ["manual_vault_binder", "manual_vault_binder_role"],
  ]) assert.match(grants, new RegExp(`\\('${capability}',current_setting\\('nalven\\.${roleSetting}'\\)`));
  assert.match(grants, /manual_sweeper/);
  assert.match(grants, /profile\.state IN \('active','retired'\)/);
  assert.match(grants, /operation\.action='activate'/);
  assert.match(grantsRunner, /config_owner.*!= 0/);
  assert.match(grantsRunner, /config_mode.*!= 600/);
  for (const script of [provision, grantsRunner]) {
    assert.match(script, /trap 'exit 1' HUP INT TERM/);
    assert.doesNotMatch(script, /trap (?:cleanup|'[^']*') EXIT HUP INT TERM/);
  }
});

test("jobs comuns e provisionamento privilegiado usam executores e timers separados", () => {
  assert.match(jobsService, /User=nalven-jobs/);
  assert.match(jobsService, /Group=nalven-jobs/);
  assert.match(jobsService, /ExecStart=\/usr\/local\/libexec\/nalven\/process-tenant-jobs\.sh/);
  assert.match(jobsService, /InaccessiblePaths=[^\n]*\/home\/nalven[^\n]*\/etc\/nalven\/tenants/);
  assert.doesNotMatch(jobsService, /ReadWritePaths=/);
  assert.match(jobsRunner, /"\$EUID" -ne 0/);
  assert.match(jobsRunner, /bundle runtime root-owned ainda não foi homologado/);
  assert.match(jobsRunner, /exit 0/);
  assert.doesNotMatch(jobsRunner, /(?:npm|tsx|node_modules|\/home\/nalven\/nalven)/);
  for (const script of [bootstrap, release]) {
    assert.match(script, /install -d -o root -g root -m 0755 \/usr\/local\/libexec\/nalven/);
    assert.match(script, /install -o root -g root -m 0755[^\n]+process-tenant-jobs\.sh[^\n]+\/usr\/local\/libexec\/nalven\/process-tenant-jobs\.sh/);
  }
  assert.match(jobsTimer, /Unit=nalven-tenant-jobs\.service/);

  assert.match(provisioningService, /ExecStart=\/usr\/local\/libexec\/nalven\/process-tenant-provisioning\.sh/);
  assert.doesNotMatch(provisioningService, /User=nalven-jobs/);
  assert.match(provisioningService, /ProtectSystem=strict/);
  assert.match(provisioningService, /ProtectHome=true/);
  for (const directory of ["tenants", "tenant-migrators", "tenant-manual-workers", "tenant-manual-callbacks", "tenant-stepup-issuers", "tenant-manual-homologators", "tenant-manual-vault-binders", "tenant-manual-profile-admin-issuers", "tenant-manual-profile-accounting-issuers", "tenant-manual-profile-fiscal-issuers", "tenant-manual-sweepers"]) {
    assert.match(provisioningService, new RegExp(`/etc/nalven/${directory}`));
  }
  assert.match(provisioningTimer, /Unit=nalven-tenant-provisioning\.service/);
  assert.match(provisioningRunner, /EUID[^\n]*-eq 0/);
  assert.match(provisioningRunner, /\/usr\/local\/libexec\/nalven/);
  assert.match(provisioningRunner, /tenant-provisioner\.env/);
  assert.doesNotMatch(provisioningRunner, /(?:source|\.)\s+.*\.env/);
  assert.doesNotMatch(provisioningRunner, /(?:npm|tsx|node_modules|\/home\/nalven\/nalven)/);
});

test("T2-02 isola manual_sweeper, força SERIALIZABLE e mantém allowlist fechada", () => {
  assert.match(provision, /manual_sweeper_role="\$\{database_name\}_ms"/);
  assert.match(provision, /TENANT_MANUAL_SWEEPER_DATABASE_URL=/);
  assert.match(provision, /tenant-manual-sweepers/);
  assert.match(bootstrap, /-m 0751 \/etc\/nalven/);
  assert.match(release, /chmod 0751 \/etc\/nalven/);
  assert.match(provision, /ALTER ROLE[^\n]+manual_sweeper_role[^\n]+default_transaction_isolation TO 'serializable'/);
  assert.doesNotMatch(provision, /psql[^\n]+-c[^\n]+PASSWORD/);
  assert.match(grantsRunner, /TENANT_MANUAL_SWEEPER_ROLE/);
  assert.match(grants, /20260829322200_pos_manual_payment_t2_reservations/);
  assert.match(grants, /partial T2-02 deployment: sweep migration\/ABI mismatch/);
  assert.match(grants, /left\(p\.proname,length\('pos_t2_'\)\)='pos_t2_'/);
  assert.match(grants, /manual sweeper role must have only the database-scoped SERIALIZABLE default/);
  assert.match(grants, /runtime role must not override default_transaction_isolation/);
  assert.match(grants, /GRANT EXECUTE ON FUNCTION %s TO %I/);
  assert.match(grants, /public\.pos_manual_sweep_expired_applications_v1\(text,integer,text,text\)'\s*,current_setting\('nalven\.manual_sweeper_role'/);
  for (const boundary of [
    "pos_t2_catalog_boundary_v1",
    "pos_t2_value_program_boundary_v1",
    "pos_t2_accounting_period_put_v1",
    "pos_t2_accounting_period_close_v1",
    "pos_t2_webhook_boundary_v1",
  ]) {
    assert.match(grants, new RegExp(`${boundary}[^\\n]+nalven\\.runtime_role`));
    assert.match(grants, new RegExp(`${boundary}[^\\n]+'search_path=pg_catalog'`));
  }
  assert.match(grants, /T2-02 capability EXECUTE allowlist diverges/);
  assert.match(grants, /PUBLIC executes T2-02 capability/);
  assert.match(grants, /T2-02 manual sweeper escaped its zero-DML\/single-capability allowlist/);

  assert.match(sweeperCutover, /expected_role="\$\{database\}_ms"/);
  assert.match(sweeperCutover, /NOINHERIT NOREPLICATION NOBYPASSRLS/);
  assert.match(sweeperCutover, /TENANT_MANUAL_SWEEPER_DATABASE_URL=/);
  assert.match(sweeperCutover, /chown root:nalven-pos-manual-sweeper/);
  assert.match(sweeperCutover, /reconcile-tenant-runtime-grants\.sh/);
  assert.match(sweeperCutover, /validate_migrator_config/);
  assert.match(sweeperCutover, /grep -c "\^\$\{key\}="/);
  assert.match(sweeperCutover, /line_count[^\n]+-eq 12[^\n]+sweeper_count[^\n]+-eq 0/);
  assert.doesNotMatch(sweeperCutover, /psql[^\n]+-c[^\n]+PASSWORD/);
  assert.doesNotMatch(sweeperCutover, /echo[^\n]*\$(?:sweeper_password|sweeper_url|migrator_url)/);

  assert.match(sweeperService, /User=nalven-pos-manual-sweeper/);
  assert.match(sweeperService, /ReadOnlyPaths=\/etc\/nalven\/tenant-manual-sweepers/);
  assert.match(sweeperService, /StateDirectory=nalven-pos-manual-sweep[\s\S]*StateDirectoryMode=0700/);
  assert.match(sweeperService, /RuntimeDirectory=nalven-pos-manual-sweep[\s\S]*RuntimeDirectoryMode=0700/);
  assert.match(sweeperRunner, /runtime_dir=\/run\/nalven-pos-manual-sweep/);
  assert.match(sweeperRunner, /mktemp "\$runtime_dir\/pgpass\.XXXXXX"/);
  assert.match(sweeperService, /InaccessiblePaths=[^\n]*\/etc\/nalven\/tenants[^\n]*\/etc\/nalven\/tenant-migrators/);
  assert.match(sweeperService, /CapabilityBoundingSet=\nAmbientCapabilities=/);
  assert.match(sweeperTimer, /Unit=nalven-pos-manual-sweep\.service/);
  assert.match(sweeperRunner, /batch_limit=50/);
  assert.match(sweeperRunner, /maximum_attempts=3/);
  assert.match(sweeperRunner, /pending_file="\$state_dir\/\$tenant_key\.pending"/);
  assert.match(sweeperRunner, /PGAPPNAME=nalven-pos-manual-sweep-v1 PGOPTIONS='-c default_transaction_isolation=serializable'/);
  assert.match(sweeperRunner, /SELECT public\.pos_manual_sweep_expired_applications_v1/);
  assert.doesNotMatch(sweeperRunner, /\bBEGIN\b|pipeline|prepared transaction/i);
  assert.match(bootstrap, /enable --now[^\n]*nalven-pos-manual-sweep\.timer/);
  assert.match(release, /enable --now[^\n]*nalven-pos-manual-sweep\.timer/);
});

test("migração e seed recebem credenciais somente em bundle imutável e executor dedicado", () => {
  assert.doesNotMatch(provision, /(?:\/home\/nalven\/nalven|\$source_root)[^\n]*(?:node_modules|prisma\/tenant|tsx)/);
  assert.doesNotMatch(provision, /runuser -u nalven(?:\s|$)/);
  assert.match(provision, /run-tenant-migration-bundle\.sh/);
  assert.match(provision, /tenant-migrate/);
  assert.match(provision, /tenant-seed/);

  assert.match(bundleInstaller, /Instalador recusado fora do artefato root-owned instalado/);
  assert.match(bundleInstaller, /chown -hR root:root/);
  assert.match(bundleInstaller, /MANIFEST\.sha256/);
  assert.match(bundleInstaller, /symlink externo/);
  assert.match(bundleInstaller, /tipo de arquivo não permitido/);
  assert.match(migrationRunner, /executor_user=nalven-migrator/);
  assert.match(migrationRunner, /tenant-migration-bundles/);
  assert.match(migrationRunner, /find "\$bundle"[^\n]*! -user root[^\n]*-perm \/022/);
  assert.match(migrationRunner, /sha256sum --quiet -c MANIFEST\.sha256/);
  assert.match(migrationRunner, /tipo de arquivo não permitido/);
  assert.match(migrationRunner, /runuser -u "\$executor_user" -- env -i/);
  assert.doesNotMatch(migrationRunner, /\/home\/nalven|runuser -u nalven(?:\s|$)/);

  for (const script of [bootstrap, release]) {
    assert.match(script, /install-tenant-migration-bundle\.sh "\$source_root"/);
    assert.match(script, /run-tenant-migration-bundle\.sh (?:control|tenant)-migrate/);
    assert.match(script, /nalven-migrator/);
    assert.doesNotMatch(script, /(?:"\$node_root\/bin\/node"|"\$node_target\/bin\/node")[^\n]*(?:node_modules|prisma\.(?:control|tenant)\.config)/);
    assert.doesNotMatch(script, /runuser -u nalven[^\n]*(?:CONTROL_DATABASE_URL|TENANT_DATABASE_URL|node_modules|tsx)/);
  }
  assert.match(release, /runuser -u "\$builder_user" -- env -i HOME=\/home\/nalven PATH="\$PATH"/);
  assert.doesNotMatch(release, /export CONTROL_DATABASE_URL|export NALVEN_INTERNAL_JOB_TOKEN/);
});

test("artefatos privilegiados são regulares root-owned e nunca executados do checkout", () => {
  for (const script of [provision, grantsRunner, provisioningRunner]) {
    assert.match(script, /-f "\$(?:trusted_artifact|artifact_path|grants_sql)"|-f "\$trusted_artifact"/);
    assert.match(script, /! -L/);
    assert.match(script, /stat -c '%u:%g'/);
    assert.match(script, /8#\$artifact_mode & 022/);
  }
  assert.match(provision, /readlink -f[^\n]+\/usr\/local\/libexec\/nalven\/provision-tenant\.sh/);
  assert.match(grantsRunner, /Reconciliação recusada fora do artefato root-owned instalado/);
  for (const script of [bootstrap, release]) {
    assert.match(script, /install -o root -g root -m 0750[^\n]+\/usr\/local\/libexec\/nalven/);
    assert.match(script, /bash \/usr\/local\/libexec\/nalven\/reconcile-tenant-runtime-grants\.sh/);
    assert.match(script, /ln -sfn \/usr\/local\/libexec\/nalven\/provision-tenant\.sh \/usr\/local\/sbin\/nalven-provision-tenant/);
    assert.match(script, /ln -sfn \/usr\/local\/libexec\/nalven\/reconcile-tenant-runtime-grants\.sh \/usr\/local\/sbin\/nalven-reconcile-tenant-runtime-grants/);
  }
});

test("serviço web tem bloqueio explícito ao diretório de migrators", () => {
  assert.match(service, /User=nalven-app/);
  assert.match(service, /EnvironmentFile=\/etc\/nalven\/app\.env/);
  assert.match(service, /InaccessiblePaths=\/etc\/nalven\/tenant-migrators/);
  assert.match(service, /\/etc\/nalven\/tenant-manual-workers/);
  assert.match(service, /\/etc\/nalven\/tenant-manual-callbacks/);
  assert.match(service, /\/etc\/nalven\/tenant-stepup-issuers/);
  assert.match(service, /\/etc\/nalven\/tenant-manual-homologators/);
  assert.match(service, /\/etc\/nalven\/tenant-manual-vault-binders/);
  assert.match(service, /\/etc\/nalven\/tenant-manual-profile-admin-issuers/);
  assert.match(service, /\/etc\/nalven\/tenant-manual-profile-accounting-issuers/);
  assert.match(service, /\/etc\/nalven\/tenant-manual-profile-fiscal-issuers/);
  assert.match(service, /\/etc\/nalven\/tenant-manual-sweepers/);
});

test("clientes Prisma usam arquivos por autoridade e não fazem fallback para runtime", () => {
  assert.match(tenantClient, /tenantManualPaymentWorkerDb/);
  assert.match(tenantClient, /tenantManualPaymentCallbackDb/);
  assert.match(tenantClient, /tenantManualPaymentStepUpIssuerDb/);
  assert.match(tenantClient, /tenantManualPaymentHomologatorDb/);
  assert.match(tenantClient, /tenantManualPaymentVaultBinderDb/);
  assert.match(tenantClient, /TENANT_MANUAL_WORKER_DATABASE_URL/);
  assert.match(tenantClient, /TENANT_MANUAL_CALLBACK_DATABASE_URL/);
  assert.match(tenantClient, /TENANT_STEPUP_ISSUER_DATABASE_URL/);
  assert.match(tenantClient, /TENANT_MANUAL_HOMOLOGATOR_DATABASE_URL/);
  assert.match(tenantClient, /TENANT_MANUAL_VAULT_BINDER_DATABASE_URL/);
  assert.match(tenantClient, /roleSuffix: "_mw"/);
  assert.match(tenantClient, /roleSuffix: "_mc"/);
  assert.match(tenantClient, /roleSuffix: "_si"/);
  assert.match(tenantClient, /roleSuffix: "_mh"/);
  assert.match(tenantClient, /roleSuffix: "_mb"/);
  assert.match(tenantClient, /runtime: \{[^\n]+roleSuffix: "_runtime"/);
  assert.doesNotMatch(tenantClient, /catch[^}]+tenantDb\(/);
});
