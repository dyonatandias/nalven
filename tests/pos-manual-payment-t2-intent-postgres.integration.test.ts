import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import test from "node:test";
import { promisify } from "node:util";
import { Client } from "pg";

const execFileAsync = promisify(execFile);
const adminUrl = process.env.TENANT_ROLE_TEST_ADMIN_DATABASE_URL;

test("T2-01 rebinds intent e manual selado a projections redacted", { skip: !adminUrl, timeout: 180_000 }, async () => {
  const token = randomBytes(5).toString("hex"), database = `t2_intent_${token}`, role = `${database}_owner`, password = randomBytes(24).toString("hex");
  const admin = new Client({ connectionString: adminUrl }); await admin.connect();
  try {
    await admin.query(`CREATE ROLE "${role}" LOGIN PASSWORD '${password}' NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS`);
    await admin.query(`CREATE DATABASE "${database}" OWNER "${role}"`);
    const url = roleUrl(adminUrl!, role, password, database);
    await execFileAsync("npx", ["prisma", "migrate", "deploy", "--config", "prisma.tenant.config.ts"], { timeout: 150_000, env: { ...process.env, TENANT_DATABASE_URL: url } });
    const db = new Client({ connectionString: url }); await db.connect();
    try {
      const projection = (await db.query<{ body: string }>(`SELECT pg_get_functiondef('public.pos_manual_t2_payment_intent_projection_v1(public.pos_payment_intents)'::regprocedure) body`)).rows[0]!.body;
      const preview = (await db.query<{ body: string }>(`SELECT pg_get_functiondef('public.pos_manual_t2_payment_intent_request_hash_v1(text,text,integer,text,text,jsonb)'::regprocedure) body`)).rows[0]!.body;
      const guard = (await db.query<{ body: string }>(`SELECT pg_get_functiondef('public.protect_pos_payment_intent_artifact_t2()'::regprocedure) body`)).rows[0]!.body;
      const trigger = (await db.query<{ definition: string }>(`SELECT pg_get_triggerdef(trigger.oid) definition FROM pg_trigger trigger JOIN pg_class relation ON relation.oid=trigger.tgrelid WHERE trigger.tgname='pos_payment_intents_t2_write_guard'`)).rows[0]!.definition;
      assert.match(trigger, /protect_pos_payment_intent_artifact_t2/);
      assert.match(preview, /current_database\(\)[\s\S]*session_user/);
      assert.match(projection, /'commitments'[\s\S]*'v0'[\s\S]*'v6'/);
      assert.doesNotMatch(projection, /'providerReference',p\.provider_reference|'authorizationCode',p\.authorization_code/);
      assert.match(guard, /pos_manual_t2_payment_intent_projection_v1[\s\S]*pos_manual_t2_observe_payment_intent_v1/);
      assert.doesNotMatch(guard, /\b(?:pos_payment_plans|pos_payment_plan_slots|pos_connectors|integration_credentials|cash_register_sessions|pos_terminals)\b/i);
      await assert.rejects(db.query("INSERT INTO pos_payment_intents(id,branch_id,register_id,session_id,operator_profile_id,connector_id,credential_ref,sale_draft_id,payment_plan_id,payment_index,status,version,amount_cents,currency,method,installments,provider,expires_at,idempotency_key,request_hash) VALUES('direct-intent',1,1,1,1,'connector','credential','draft','plan',0,'created',0,1,'BRL','pix',1,'provider',transaction_timestamp()+interval '1 minute','direct-intent-key','" + "a".repeat(64) + "')"), (error: { code?: string }) => error.code === "42501");

      const manualProjection = (await db.query<{ body: string }>(`SELECT pg_get_functiondef('public.pos_manual_t2_manual_reference_projection_v1(public.pos_manual_payment_references)'::regprocedure) body`)).rows[0]!.body;
      const manualPreview = (await db.query<{ body: string }>(`SELECT pg_get_functiondef('public.pos_manual_t2_manual_reference_request_hash_v1(text,text,integer,text,text,jsonb)'::regprocedure) body`)).rows[0]!.body;
      const manualCapability = (await db.query<{ body: string }>(`SELECT pg_get_functiondef('public.pos_manual_prepare_manual_payment_reference_write_v1(text,text,integer,text,text,text,jsonb)'::regprocedure) body`)).rows[0]!.body;
      const manualGuard = (await db.query<{ body: string }>(`SELECT pg_get_functiondef('public.protect_pos_manual_payment_reference_t2()'::regprocedure) body`)).rows[0]!.body;
      const manualTrigger = (await db.query<{ definition: string }>(`SELECT pg_get_triggerdef(trigger.oid) definition FROM pg_trigger trigger JOIN pg_class relation ON relation.oid=trigger.tgrelid WHERE trigger.tgname='pos_manual_payment_references_t2_write_guard'`)).rows[0]!.definition;
      const seal = (await db.query<{ body: string }>(`SELECT pg_get_functiondef('public.seal_legacy_pos_manual_payment_reference()'::regprocedure) body`)).rows[0]!.body;
      assert.match(manualTrigger, /protect_pos_manual_payment_reference_t2/);
      assert.match(manualProjection, /referenceHash[\s\S]*referenceLastFour/);
      assert.doesNotMatch(manualProjection, /'reference',p\.reference|'revokeReason',p\.revoke_reason/);
      assert.match(manualPreview, /canonical_text_dlp_safe/);
      assert.match(manualPreview, /current_database\(\)[\s\S]*session_user/);
      assert.match(manualCapability, /pg_advisory_xact_lock[\s\S]*pos_manual_t2_open_write_root_v1/);
      assert.match(manualGuard, /root_action_v1[\s\S]*observe_manual_reference_v1/);
      assert.doesNotMatch(manualGuard, /\b(?:pos_payment_plans|pos_payment_plan_slots|pos_connectors|integration_credentials|cash_register_sessions|pos_terminals)\b/i);
      assert.match(seal, /RAISE EXCEPTION[\s\S]*42501/);
      await assert.rejects(db.query("INSERT INTO pos_manual_payment_references(id) VALUES('direct-manual')"), (error: { code?: string }) => error.code === "42501");
    } finally { await db.end(); }
  } finally {
    await admin.query("SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname=$1", [database]).catch(() => undefined);
    await admin.query(`DROP DATABASE IF EXISTS "${database}"`).catch(() => undefined);
    await admin.query(`DROP ROLE IF EXISTS "${role}"`).catch(() => undefined);
    await admin.end();
  }
});

function roleUrl(base: string, username: string, password: string, database: string) {
  const url = new URL(base); url.username = username; url.password = password; url.pathname = `/${database}`; return url.toString();
}
