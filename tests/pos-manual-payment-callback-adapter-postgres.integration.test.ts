import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHmac, randomBytes } from "node:crypto";
import test from "node:test";
import { promisify } from "node:util";
import { Client, type DatabaseError } from "pg";
import { recordVerifiedPosManualPaymentCallback } from "../lib/erp/pos-manual-payment-callback-adapter";
import { POS_MANUAL_CALLBACK_SIGNATURE_CONTEXT, type PosManualPaymentCallbackVerificationKey } from "../lib/erp/pos-manual-payment-callback-security";

const connectionString = process.env.POS_TEST_DATABASE_URL;
const execFileAsync = promisify(execFile);

test("adapter HMAC persiste órfão em quarentena pela role `_mc` real e mantém isolamento", { skip: !connectionString, timeout: 30_000 }, async () => {
  const roles = await installRoles();
  const owner = new Client({ connectionString });
  await owner.connect();
  const callback = clientForRole(roles.callback, roles.password), runtime = clientForRole(roles.runtime, roles.password);
  const worker = clientForRole(roles.worker, roles.password), issuer = clientForRole(roles.issuer, roles.password), homologator = clientForRole(roles.homologator, roles.password);
  await callback.connect(); await runtime.connect(); await worker.connect(); await issuer.connect(); await homologator.connect();
  try {
    const signed = signedInput();
    const result = await recordVerifiedPosManualPaymentCallback({ ...signed, trustedContext: { credentialRevision: 1, verifierVersion: "hmac-adapter-v1" }, database: callback });
    assert.equal(result.disposition, "orphan_reference"); assert.equal(result.quarantined, true); assert.equal(result.caseId, undefined);
    const stored = await owner.query<{ event_id: string; disposition: string; caller_role: string }>(`SELECT event_id,disposition,caller_role FROM public."pos_manual_payment_provider_proofs" WHERE id=$1`, [result.proofId]);
    assert.match(stored.rows[0]!.event_id, /^evt:[0-9a-f]{64}$/); assert.notEqual(stored.rows[0]!.event_id, "provider-event-integration-0001");
    assert.equal(stored.rows[0]!.disposition, "orphan_reference"); assert.equal(stored.rows[0]!.caller_role, roles.callback);
    await denied(callback, `INSERT INTO public."pos_manual_payment_provider_proofs" (id) VALUES (gen_random_uuid())`);
    await denied(callback, `SELECT public."pos_manual_complete_delivery_v1"(NULL,NULL,NULL,NULL)`);
    await denied(callback, `SELECT public."pos_manual_report_transport_v1"(NULL,NULL,NULL,NULL)`);
    await denied(callback, `SELECT public."pos_manual_claim_queries_v1"(NULL,NULL,NULL,NULL)`);
    await denied(callback, `SELECT public."pos_manual_issue_step_up_v1"(NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL)`);
    await denied(callback, `SELECT public."pos_manual_review_case_v1"(NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL)`);
    await denied(runtime, `SELECT public."pos_manual_record_callback_v1"(NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL)`);
    await denied(worker, `SELECT public."pos_manual_record_callback_v1"(NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL)`);
    await denied(issuer, `SELECT public."pos_manual_record_callback_v1"(NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL)`);
    await denied(homologator, `SELECT public."pos_manual_record_callback_v1"(NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL)`);
    await denied(callback, `SELECT * FROM public."pos_manual_payment_provider_proofs"`);
  } finally { await Promise.allSettled([callback.end(), runtime.end(), worker.end(), issuer.end(), homologator.end(), owner.end()]); }
});

async function installRoles() {
  const owner = new Client({ connectionString });
  await owner.connect();
  const database = new URL(connectionString!).pathname.slice(1), password = `T-${randomBytes(18).toString("base64url")}`;
  const names = { runtime: `${database}_runtime`, callback: `${database}_mc`, worker: `${database}_mw`, issuer: `${database}_si`, homologator: `${database}_mh`, binder: `${database}_mb` };
  for (const name of Object.values(names)) {
    const escapedPassword = password.replaceAll("'", "''");
    await owner.query(`DO $do$ BEGIN IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='${name}') THEN EXECUTE 'ALTER ROLE "${name}" PASSWORD ''${escapedPassword}'''; ELSE EXECUTE 'CREATE ROLE "${name}" LOGIN PASSWORD ''${escapedPassword}'' NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS'; END IF; END $do$`);
  }
  const migrator = (await owner.query<{ current_user: string }>("SELECT current_user")).rows[0]!.current_user;
  const url = new URL(connectionString!);
  await execFileAsync("psql", ["--no-psqlrc", "--no-password", "-v", "ON_ERROR_STOP=1", "-v", `database_name=${database}`, "-v", `runtime_role=${names.runtime}`, "-v", `migrator_role=${migrator}`, "-v", `manual_worker_role=${names.worker}`, "-v", `manual_callback_role=${names.callback}`, "-v", `stepup_issuer_role=${names.issuer}`, "-v", `manual_homologator_role=${names.homologator}`, "-v", `manual_vault_binder_role=${names.binder}`, "-f", "deploy/reconcile-tenant-runtime-grants.sql"], { env: { ...process.env, PGHOST: url.hostname, PGPORT: url.port, PGUSER: decodeURIComponent(url.username), PGPASSWORD: decodeURIComponent(url.password), PGDATABASE: database } });
  await owner.end();
  return { ...names, password };
}

function clientForRole(role: string, password: string) { const url = new URL(connectionString!); url.username = role; url.password = password; return new Client({ connectionString: url.toString() }); }
async function denied(db: Client, sql: string) { await assert.rejects(db.query(sql), (error: DatabaseError) => { assert.equal(error.code, "42501", error.message); return true; }); }

function signedInput() {
  const now = new Date(), timestamp = Math.floor(now.valueOf() / 1000), secret = randomBytes(32);
  const key: PosManualPaymentCallbackVerificationKey = { keyId: "manual-auth-v1", provider: "manual_provider", secret, notBefore: new Date(now.valueOf() - 60_000), notAfter: new Date(now.valueOf() + 60_000) };
  const body = Buffer.from(JSON.stringify({ amountCents: 2590, currency: "BRL", eventId: "provider-event-integration-0001", evidenceHash: "b".repeat(64), method: "credit", nonce: randomBytes(24).toString("base64url"), occurredAt: now.toISOString(), outcome: "confirmed_paid", provider: "manual_provider", referenceHash: `hmac-sha256:v1:${randomBytes(32).toString("hex")}`, sequence: "1", timestamp }));
  const signature = createHmac("sha256", secret).update(Buffer.concat([Buffer.from(`${POS_MANUAL_CALLBACK_SIGNATURE_CONTEXT}\n${key.keyId}\n${timestamp}\n`), body])).digest("hex");
  return { rawBody: body, headers: { "content-type": "application/json", "content-length": String(body.length), "x-nalven-key-id": key.keyId, "x-nalven-timestamp": String(timestamp), "x-nalven-signature": `sha256=${signature}` }, keyring: new Map([[key.keyId, key]]), now };
}
