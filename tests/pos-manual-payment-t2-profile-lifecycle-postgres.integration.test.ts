import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { promisify } from "node:util";
import test from "node:test";
import { Client, type DatabaseError } from "pg";
import { canonicalizePosManualT2, hashPosManualT2, type T2CanonicalValue } from "../lib/erp/pos-manual-t2-canonical";

const execFileAsync = promisify(execFile);
const adminConnectionString = process.env.TENANT_ROLE_TEST_ADMIN_DATABASE_URL;

test("T2-01 PG18: lifecycle é causal, segregado, idempotente e permanece hard-off", {
  skip: !adminConnectionString,
  timeout: 300_000,
}, async () => {
  const token = randomBytes(5).toString("hex");
  const database = `t2_lifecycle_${token}`;
  const migrator = `${database}_migrator`;
  const roles = {
    adminIssuer: `${database}_mpi`, accountingIssuer: `${database}_mpa`, fiscalIssuer: `${database}_mpf`,
    runtime: `${database}_runtime`, homologator: `${database}_mh`,
  };
  const passwords = Object.fromEntries([migrator, ...Object.values(roles)].map((role) => [role, randomBytes(24).toString("hex")])) as Record<string, string>;
  const admin = new Client({ connectionString: adminConnectionString });
  await admin.connect();
  try {
    for (const role of [migrator, ...Object.values(roles)])
      await admin.query(`CREATE ROLE "${role}" LOGIN NOINHERIT PASSWORD '${passwords[role]}'`);
    await admin.query(`CREATE DATABASE "${database}" OWNER "${migrator}"`);
    const migratorUrl = roleUrl(adminConnectionString!, database, migrator, passwords[migrator]);
    await execFileAsync("npx", ["prisma", "migrate", "deploy", "--config", "prisma.tenant.config.ts"], {
      timeout: 180_000, env: { ...process.env, TENANT_DATABASE_URL: migratorUrl },
    });
    await execFileAsync("npx", ["tsx", "prisma/tenant/seed.ts"], {
      timeout: 120_000, env: { ...process.env, TENANT_DATABASE_URL: migratorUrl },
    });

    const owner = await connect(migratorUrl);
    const clients = Object.fromEntries(await Promise.all(Object.entries(roles).map(async ([key, role]) =>
      [key, await connect(roleUrl(adminConnectionString!, database, role, passwords[role]))]))) as Record<keyof typeof roles, Client>;
    try {
      assert.ok(Number((await owner.query("SHOW server_version_num")).rows[0]?.server_version_num) >= 180000);
      await installAuthoritiesAndAcl(owner, database, roles);
      const fixture = await prepareFixture(owner);

      await testAcl(owner, clients, roles);

      const profileId = randomUUID();
      const version = 1;
      const profile = profileInput(fixture.costCenterId, fixture.policyId, fixture.policyHash, "operacao_manual_sem_documento_fiscal");
      const configHash = profileConfigHash(fixture.branchId, version, profile);
      const actorUser = fixture.actorUserId;

      const putAdmin = await issueAdmin(clients.adminIssuer, database, {
        action: "put", branchId: fixture.branchId, profileId, version, configHash,
        issuer: "admin-issuer", subject: actorUser, key: key("01"),
      });
      assert.equal(putAdmin.alreadyIssued, false);
      assert.match(putAdmin.assertionHandle, /^[0-9a-f]{64}$/);
      const replayAdmin = await issueAdmin(clients.adminIssuer, database, {
        action: "put", branchId: fixture.branchId, profileId, version, configHash,
        issuer: "admin-issuer", subject: actorUser, key: key("01"),
      });
      assert.equal(replayAdmin.alreadyIssued, true);
      assert.equal(replayAdmin.assertionHandle, undefined);
      await assertSqlState(clients.adminIssuer, adminIssueSql(), "23514", adminIssueArgs({
        action: "put", branchId: fixture.branchId, profileId, version, configHash,
        issuer: "admin-issuer", subject: actorUser, key: key("02"), requestHash: "0".repeat(64),
      }));
      await assertSqlState(clients.adminIssuer, adminIssueSql(), "23505", adminIssueArgs({
        action: "put", branchId: fixture.branchId, profileId, version, configHash,
        issuer: "different-issuer", subject: actorUser, key: key("01"),
        requestHash: requestHash("profile-admin-assert-v1", database, roles.adminIssuer, {
          action: "put", branchId: fixture.branchId, profileId, expectedVersion: version,
          expectedConfigHash: configHash, issuerSubjectId: "different-issuer", subjectId: actorUser, idempotencyKey: key("01"),
        }),
      }));

      const putKey = key("03");
      const putParameters = { branchId: fixture.branchId, version, profile, actorProfileId: fixture.actorProfileId,
        actorUserId: actorUser, adminAssertionHash: digest(putAdmin.assertionHandle), idempotencyKey: putKey };
      const putHash = requestHash("profile-put-v1", database, roles.runtime, putParameters);
      const put = (await clients.runtime.query("SELECT pos_manual_put_finalization_profile_v1($1,$2,$3,$4,$5,$6,$7,$8) result", [
        fixture.branchId, version, profile, fixture.actorProfileId, actorUser, putAdmin.assertionHandle, putKey, putHash,
      ])).rows[0].result;
      assert.deepEqual({ state: put.state, replayed: put.replayed, configHash: put.configHash }, { state: "draft", replayed: false, configHash });
      const putReplay = (await clients.runtime.query("SELECT pos_manual_put_finalization_profile_v1($1,$2,$3,$4,$5,$6,$7,$8) result", [
        fixture.branchId, version, profile, fixture.actorProfileId, actorUser, putAdmin.assertionHandle, putKey, putHash,
      ])).rows[0].result;
      assert.equal(putReplay.replayed, true);
      await assertCleanContext(owner);
      await assertCausal(owner, profileId, "put", 1);

      // Expiração é simulada preservando o CHECK issued_at + 120s; não espera relógio real.
      const expiredProfile = randomUUID();
      const expiredAdmin = await issueAdmin(clients.adminIssuer, database, {
        action: "put", branchId: fixture.branchId, profileId: expiredProfile, version: 2,
        configHash: profileConfigHash(fixture.branchId, 2, profile), issuer: "admin-issuer", subject: actorUser, key: key("04"),
      });
      await owner.query("ALTER TABLE pos_manual_profile_admin_assertions DISABLE TRIGGER USER");
      await owner.query("WITH anchor AS (SELECT clock_timestamp()-interval '121 seconds' issued_at) UPDATE pos_manual_profile_admin_assertions SET issued_at=anchor.issued_at, expires_at=anchor.issued_at+interval '120 seconds' FROM anchor WHERE id=$1", [expiredAdmin.assertionId]);
      await owner.query("ALTER TABLE pos_manual_profile_admin_assertions ENABLE TRIGGER USER");
      const expiredPutKey = key("05");
      const expiredParams = { branchId: fixture.branchId, version: 2, profile, actorProfileId: fixture.actorProfileId,
        actorUserId: actorUser, adminAssertionHash: digest(expiredAdmin.assertionHandle), idempotencyKey: expiredPutKey };
      await assertSqlState(clients.runtime, "SELECT pos_manual_put_finalization_profile_v1($1,$2,$3,$4,$5,$6,$7,$8)", "42501", [
        fixture.branchId, 2, profile, fixture.actorProfileId, actorUser, expiredAdmin.assertionHandle, expiredPutKey,
        requestHash("profile-put-v1", database, roles.runtime, expiredParams),
      ]);
      await assertCleanContext(owner);

      const activateAdmin = await issueAdmin(clients.adminIssuer, database, {
        action: "activate", branchId: fixture.branchId, profileId, version, configHash,
        issuer: "admin-issuer", subject: "homologator", key: key("06"),
      });
      const accounting = await issueSpecialized(clients.accountingIssuer, database, roles.accountingIssuer,
        "accounting", profileId, version, configHash, fixture.policyHash, "accounting-issuer", "accountant", key("07"));
      const fiscalSame = await issueSpecialized(clients.fiscalIssuer, database, roles.fiscalIssuer,
        "fiscal", profileId, version, configHash, profile.fiscalPolicyHash, "fiscal-issuer", "accountant", key("08"));
      const activateKey = key("09");
      await assertSqlState(clients.homologator, activateSql(), "42501", activateArgs(profileId, version, "homologator",
        activateAdmin.assertionHandle, accounting.assertionHandle, fiscalSame.assertionHandle, activateKey,
        requestHash("profile-activate-v1", database, roles.homologator, activationParameters(profileId, version, "homologator", activateAdmin.assertionHandle, accounting.assertionHandle, fiscalSame.assertionHandle, activateKey))));
      await assertCleanContext(owner);

      const fiscal = await issueSpecialized(clients.fiscalIssuer, database, roles.fiscalIssuer,
        "fiscal", profileId, version, configHash, profile.fiscalPolicyHash, "fiscal-issuer", "fiscal-approver", key("0a"));
      const activeKey = key("0b");
      const activeParams = activationParameters(profileId, version, "homologator", activateAdmin.assertionHandle, accounting.assertionHandle, fiscal.assertionHandle, activeKey);
      const activated = (await clients.homologator.query(`${activateSql()} result`, activateArgs(profileId, version, "homologator",
        activateAdmin.assertionHandle, accounting.assertionHandle, fiscal.assertionHandle, activeKey,
        requestHash("profile-activate-v1", database, roles.homologator, activeParams)))).rows[0].result;
      assert.equal(activated.state, "active");
      assert.equal(activated.gateEnabled, false);
      assert.equal((await owner.query("SELECT count(*)::int n FROM pos_manual_payment_reconciliation_gates WHERE enabled OR (finalization_profile_id IS NOT NULL AND (finalization_profile_id,finalization_profile_version,finalization_profile_hash) IS DISTINCT FROM ($1::uuid,$2,$3))", [profileId, version, configHash])).rows[0].n, 0);
      await assertCausal(owner, profileId, "activate", 3);
      await assertCleanContext(owner);

      const retireAdmin = await issueAdmin(clients.adminIssuer, database, {
        action: "retire", branchId: fixture.branchId, profileId, version, configHash,
        issuer: "admin-issuer", subject: "homologator", key: key("0c"),
      });
      const retireKey = key("0d");
      const retireParams = { profileId, expectedVersion: version, homologatorId: "homologator", reasonCode: "policy_rotation",
        adminAssertionHash: digest(retireAdmin.assertionHandle), idempotencyKey: retireKey };
      const retired = (await clients.homologator.query("SELECT pos_manual_retire_finalization_profile_v1($1,$2,$3,$4,$5,$6,$7) result", [
        profileId, version, "homologator", "policy_rotation", retireAdmin.assertionHandle, retireKey,
        requestHash("profile-retire-v1", database, roles.homologator, retireParams),
      ])).rows[0].result;
      assert.equal(retired.state, "retired");
      await assertCausal(owner, profileId, "retire", 1);
      await assertCleanContext(owner);
      await assertSqlState(owner, "UPDATE pos_manual_finalization_profiles SET state='active' WHERE id=$1", "23514", [profileId]);

      // Contrato de DLP T2-01: um perfil não pode transportar PAN/PII em campos textuais.
      const unsafeProfile = profileInput(fixture.costCenterId, fixture.policyId, fixture.policyHash, "contato (11) 91234-5678");
      const unsafeId = randomUUID();
      const unsafeHash = profileConfigHash(fixture.branchId, 3, unsafeProfile);
      const unsafeAdmin = await issueAdmin(clients.adminIssuer, database, { action: "put", branchId: fixture.branchId,
        profileId: unsafeId, version: 3, configHash: unsafeHash, issuer: "admin-issuer", subject: actorUser, key: key("0e") });
      const unsafeKey = key("0f");
      const unsafeParams = { branchId: fixture.branchId, version: 3, profile: unsafeProfile, actorProfileId: fixture.actorProfileId,
        actorUserId: actorUser, adminAssertionHash: digest(unsafeAdmin.assertionHandle), idempotencyKey: unsafeKey };
      await assertSqlState(clients.runtime, "SELECT pos_manual_put_finalization_profile_v1($1,$2,$3,$4,$5,$6,$7,$8)", "22023", [
        fixture.branchId, 3, unsafeProfile, fixture.actorProfileId, actorUser, unsafeAdmin.assertionHandle, unsafeKey,
        requestHash("profile-put-v1", database, roles.runtime, unsafeParams),
      ]);
      await assertCleanContext(owner);
    } finally {
      await Promise.all([...Object.values(clients), owner].map((client) => client.end().catch(() => undefined)));
    }
  } finally {
    await admin.query("SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname=$1", [database]).catch(() => undefined);
    await admin.query(`DROP DATABASE IF EXISTS "${database}"`).catch(() => undefined);
    for (const role of Object.values(roles).reverse()) await admin.query(`DROP ROLE IF EXISTS "${role}"`).catch(() => undefined);
    await admin.query(`DROP ROLE IF EXISTS "${migrator}"`).catch(() => undefined);
    await admin.end();
  }
});

function key(suffix: string) { return suffix.padStart(64, "a"); }
function digest(value: string) { return createHash("sha256").update(value, "utf8").digest("hex"); }
function requestHash(domain: string, database: string, role: string, parameters: T2CanonicalValue) {
  return createHash("sha256").update(domain).update("\0").update(database).update("\0").update(role).update("\0").update(canonicalizePosManualT2(parameters)).digest("hex");
}
function authorityHash(database: string, role: string) {
  return createHash("sha256").update("t2-authority-v1\0").update(database).update("\0").update(role).digest("hex");
}
function profileInput(costCenterId: number, policyId: string, policyHash: string, reason: string) {
  return { schemaVersion: 1, costCenterId, accountingPolicyId: policyId, accountingPolicyVersion: 1,
    accountingPolicyHash: policyHash, fiscalMode: "not_applicable", fiscalProfileId: null, fiscalProfileVersion: null,
    fiscalPolicyHash: "f".repeat(64), notApplicableReason: reason, webhookMode: "disabled", stockMode: "reserve_exact", reservationTtlSeconds: 300 };
}
function profileConfigHash(branchId: number, version: number, profile: ReturnType<typeof profileInput>) {
  return hashPosManualT2("profile", { branchId, version, ...profile });
}

async function connect(connectionString: string) { const client = new Client({ connectionString }); await client.connect(); return client; }
function roleUrl(base: string, database: string, role: string, password: string) { const url = new URL(base); url.pathname = `/${database}`; url.username = role; url.password = password; return url.toString(); }

async function installAuthoritiesAndAcl(owner: Client, database: string, roles: Record<string, string>) {
  for (const role of Object.values(roles)) await owner.query(`GRANT CONNECT ON DATABASE "${database}" TO "${role}"; GRANT USAGE ON SCHEMA public TO "${role}"`);
  const grants: Array<[string, string]> = [
    [roles.adminIssuer, "pos_manual_issue_profile_admin_assertion_v1(text,integer,uuid,integer,text,text,text,text,text)"],
    [roles.accountingIssuer, "pos_manual_issue_profile_accounting_assertion_v1(uuid,integer,text,text,text,text,text,text)"],
    [roles.fiscalIssuer, "pos_manual_issue_profile_fiscal_assertion_v1(uuid,integer,text,text,text,text,text,text)"],
    [roles.runtime, "pos_manual_put_finalization_profile_v1(integer,integer,jsonb,integer,text,text,text,text)"],
    [roles.homologator, "pos_manual_activate_finalization_profile_v1(uuid,integer,text,text,text,text,text,text)"],
    [roles.homologator, "pos_manual_retire_finalization_profile_v1(uuid,integer,text,text,text,text,text)"],
  ];
  for (const [role, signature] of grants) await owner.query(`GRANT EXECUTE ON FUNCTION public.${signature} TO "${role}"`);
  for (const [capability, role] of [["profile_admin_issuer", roles.adminIssuer], ["profile_accounting_issuer", roles.accountingIssuer], ["profile_fiscal_issuer", roles.fiscalIssuer], ["runtime", roles.runtime], ["profile_homologator", roles.homologator]])
    await owner.query("INSERT INTO pos_manual_t2_authorities(capability,role_name,authority_hash) VALUES ($1,$2,$3)", [capability, role, authorityHash(database, role)]);
}

async function prepareFixture(owner: Client) {
  let actor = (await owner.query(`SELECT p.id actor_profile_id,p.user_id actor_user_id,a.branch_id FROM tenant_user_profiles p JOIN branch_user_accesses a ON a.user_profile_id=p.id JOIN branches b ON b.id=a.branch_id WHERE p.status='active' AND a.can_sell AND b.status='active' ORDER BY p.id LIMIT 1`)).rows[0];
  if (!actor) {
    const fixtureToken = randomBytes(6).toString("hex");
    const branch = (await owner.query(
      "INSERT INTO branches(code,name,legal_name,document,status) VALUES($1,$2,$3,$4,'active') RETURNING id",
      [`T2-${fixtureToken}`, "T2 lifecycle", "T2 lifecycle LTDA", `T2${fixtureToken}`],
    )).rows[0];
    const role = (await owner.query(
      "INSERT INTO tenant_roles(key,name,permissions,system,active) VALUES($1,$2,'[]'::jsonb,false,true) RETURNING id",
      [`t2-${fixtureToken}`, "T2 lifecycle"],
    )).rows[0];
    const profile = (await owner.query(
      "INSERT INTO tenant_user_profiles(user_id,role_id,display_name,email,status,active_branch_id) VALUES($1,$2,$3,$4,'active',$5) RETURNING id,user_id",
      [`t2-user-${fixtureToken}`, role.id, "T2 actor", `t2-${fixtureToken}@example.invalid`, branch.id],
    )).rows[0];
    await owner.query(
      "INSERT INTO branch_user_accesses(branch_id,user_profile_id,can_sell,\"primary\") VALUES($1,$2,true,true)",
      [branch.id, profile.id],
    );
    actor = { actor_profile_id: profile.id, actor_user_id: profile.user_id, branch_id: branch.id };
  }
  const costCenter = (await owner.query("INSERT INTO cost_centers(name,code,active) VALUES ('T2 lifecycle','T2-LIFECYCLE',true) ON CONFLICT(code) DO UPDATE SET active=true RETURNING id")).rows[0];
  const policyId = `t2-policy-${randomBytes(4).toString("hex")}`; const policyHash = "e".repeat(64);
  await owner.query(`INSERT INTO pos_accounting_policies(id,branch_id,version,status,currency,effective_from,mapping_hash,accountant_approval_ref,homologated_by,homologated_at) VALUES ($1,$2,1,'active','BRL',current_date-1,$3,'T2-APPROVED','t2-homologator',clock_timestamp())`, [policyId, actor.branch_id, policyHash]);
  return { branchId: actor.branch_id as number, actorProfileId: actor.actor_profile_id as number, actorUserId: actor.actor_user_id as string, costCenterId: costCenter.id as number, policyId, policyHash };
}

async function testAcl(owner: Client, clients: Record<string, Client>, roles: Record<string, string>) {
  const signatures = ["pos_manual_issue_profile_admin_assertion_v1", "pos_manual_issue_profile_accounting_assertion_v1", "pos_manual_issue_profile_fiscal_assertion_v1", "pos_manual_put_finalization_profile_v1", "pos_manual_activate_finalization_profile_v1", "pos_manual_retire_finalization_profile_v1"];
  const expected: Record<string, string[]> = { adminIssuer: [signatures[0]], accountingIssuer: [signatures[1]], fiscalIssuer: [signatures[2]], runtime: [signatures[3]], homologator: [signatures[4], signatures[5]] };
  for (const [keyName, role] of Object.entries(roles)) for (const name of signatures)
    assert.equal((await owner.query("SELECT has_function_privilege($1,p.oid,'EXECUTE') allowed FROM pg_proc p WHERE p.pronamespace='public'::regnamespace AND p.proname=$2", [role, name])).rows[0]?.allowed, expected[keyName].includes(name), `${role} -> ${name}`);
  for (const client of Object.values(clients)) {
    await assertSqlState(client, "SELECT * FROM pos_manual_profile_operations", "42501");
    await assertSqlState(client, "INSERT INTO pos_manual_t2_lock_contexts(backend_pid,transaction_txid,caller_role_hash,capability,aggregate_kind,aggregate_id,nonce_hash) VALUES(pg_backend_pid(),txid_current(),'a','profile_put','profile','x','b')", "42501");
  }
  assert.equal((await owner.query("SELECT count(*)::int n FROM pg_proc p CROSS JOIN LATERAL aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a WHERE p.pronamespace='public'::regnamespace AND p.proname=ANY($1) AND a.grantee=0 AND a.privilege_type='EXECUTE'", [signatures])).rows[0].n, 0);
}

type AdminInput = { action: string; branchId: number; profileId: string; version: number; configHash: string; issuer: string; subject: string; key: string; requestHash?: string };
function adminIssueSql() { return "SELECT pos_manual_issue_profile_admin_assertion_v1($1,$2,$3,$4,$5,$6,$7,$8,$9) result"; }
function adminIssueArgs(input: AdminInput) { return [input.action,input.branchId,input.profileId,input.version,input.configHash,input.issuer,input.subject,input.key,input.requestHash]; }
async function issueAdmin(client: Client, database: string, input: AdminInput) {
  const role = (await client.query("SELECT session_user role")).rows[0].role as string;
  const parameters = { action: input.action, branchId: input.branchId, profileId: input.profileId, expectedVersion: input.version,
    expectedConfigHash: input.configHash, issuerSubjectId: input.issuer, subjectId: input.subject, idempotencyKey: input.key };
  return (await client.query(adminIssueSql(), adminIssueArgs({ ...input, requestHash: requestHash("profile-admin-assert-v1",database,role,parameters) }))).rows[0].result;
}
async function issueSpecialized(client: Client,database: string,role: string,kind: "accounting"|"fiscal",profileId: string,version: number,configHash: string,policyHash: string,issuer: string,approver: string,idempotencyKey: string) {
  const parameters: T2CanonicalValue = kind === "accounting"
    ? { profileId,expectedVersion:version,expectedConfigHash:configHash,expectedAccountingPolicyHash:policyHash,issuerSubjectId:issuer,approverId:approver,idempotencyKey }
    : { profileId,expectedVersion:version,expectedConfigHash:configHash,expectedFiscalPolicyHash:policyHash,issuerSubjectId:issuer,approverId:approver,idempotencyKey };
  const hash = requestHash(`profile-${kind}-assert-v1`,database,role,parameters);
  return (await client.query(`SELECT pos_manual_issue_profile_${kind}_assertion_v1($1,$2,$3,$4,$5,$6,$7,$8) result`, [profileId,version,configHash,policyHash,issuer,approver,idempotencyKey,hash])).rows[0].result;
}
function activationParameters(profileId:string,version:number,homologatorId:string,admin:string,accounting:string,fiscal:string,idempotencyKey:string) { return { profileId,expectedVersion:version,homologatorId,adminAssertionHash:digest(admin),accountingAssertionHash:digest(accounting),fiscalAssertionHash:digest(fiscal),idempotencyKey }; }
function activateSql() { return "SELECT pos_manual_activate_finalization_profile_v1($1,$2,$3,$4,$5,$6,$7,$8)"; }
function activateArgs(profileId:string,version:number,homologator:string,admin:string,accounting:string,fiscal:string,keyValue:string,hash:string) { return [profileId,version,homologator,admin,accounting,fiscal,keyValue,hash]; }

async function assertCausal(owner: Client, profileId: string, action: string, consumedAssertions: number) {
  const row = (await owner.query(`SELECT o.id,o.write_txid,e.write_txid event_txid,e.lifecycle_txid,p.lifecycle_txid,
    (SELECT count(*)::int FROM (SELECT consumed_operation_id FROM pos_manual_profile_admin_assertions UNION ALL SELECT consumed_operation_id FROM pos_manual_profile_accounting_assertions UNION ALL SELECT consumed_operation_id FROM pos_manual_profile_fiscal_assertions) a WHERE a.consumed_operation_id=o.id) consumed
    FROM pos_manual_profile_operations o JOIN pos_manual_profile_state_events e ON e.operation_id=o.id JOIN pos_manual_finalization_profiles p ON p.id=o.profile_id WHERE o.profile_id=$1 AND o.action=$2`, [profileId,action])).rows[0];
  assert.ok(row); assert.equal(row.write_txid, row.event_txid); assert.equal(row.write_txid, row.lifecycle_txid); assert.equal(row.consumed, consumedAssertions);
}
async function assertCleanContext(owner: Client) { assert.equal((await owner.query("SELECT count(*)::int n FROM pos_manual_t2_lock_contexts")).rows[0].n, 0); }
async function assertSqlState(client: Client, sql: string, code: string, parameters: unknown[] = []) { await assert.rejects(client.query(sql,parameters), (error: DatabaseError) => { assert.equal(error.code,code,error.message); return true; }); }
