import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const migration = readFileSync("prisma/tenant/migrations/20260829321110_pos_manual_payment_worker_claim/migration.sql", "utf8");
const grants = readFileSync("deploy/reconcile-tenant-runtime-grants.sql", "utf8");
const claimBody = migration.slice(migration.indexOf('CREATE FUNCTION public."pos_manual_claim_queries_v1"'));

test("321e.1 cria claim idempotente, fenced e justo somente para _mw", () => {
  assert.match(migration, /pos_manual_payment_claim_batches/);
  assert.match(migration, /pos_manual_payment_claim_receipts/);
  assert.match(migration, /"batch_index" INTEGER NOT NULL/);
  assert.match(migration, /UNIQUE \("batch_id","batch_index"\)/);
  assert.match(claimBody, /SECURITY DEFINER\s+SET search_path = pg_catalog/);
  assert.match(claimBody, /FOR UPDATE OF session SKIP LOCKED/);
  assert.match(claimBody, /row_number\(\) OVER \(PARTITION BY manual_case\."session_id"/);
  assert.match(claimBody, /candidate_limit := p_limit/);
  assert.doesNotMatch(claimBody, /p_limit\s*\*\s*8|p_limit\s*\+\s*16/);
  assert.match(claimBody, /pos_manual_lock_case_graph_321e/);
  assert.match(claimBody, /now_at := pg_catalog\.clock_timestamp\(\)/);
  assert.match(claimBody, /claim_expires_at[\s\S]*make_interval/);
  assert.match(claimBody, /claim-expired-retry/);
  assert.match(claimBody, /manual-claim-block/);
  assert.match(claimBody, /maximum_deliveries_reached/);
  assert.match(claimBody, /manual_boundary_changed/);
  assert.match(claimBody, /replayExpired/);
  assert.match(claimBody, /idempotency key conflicts with different parameters/);
  assert.match(claimBody, /manual claim replay authority changed/);
  assert.match(claimBody, /ORDER BY receipt\."batch_index"/);
  assert.match(claimBody, /'vaultBindingId',vault_record\."id"/);
  assert.match(claimBody, /'vaultOpenAvailable',false/);
  assert.doesNotMatch(claimBody, /vault_reference|reference_hash|binding_hash|vault_key_id|stable_reference_index/i);
  assert.doesNotMatch(migration, /UPDATE public\."pos_manual_payment_reconciliation_gates"[\s\S]*"enabled"=true/);
  assert.match(migration, /REVOKE ALL ON FUNCTION public\."pos_manual_claim_queries_v1"\(TEXT,INTEGER,INTEGER,TEXT\) FROM PUBLIC/);
  assert.match(migration, /GRANT EXECUTE ON FUNCTION public\.pos_manual_claim_queries_v1\(text,integer,integer,text\) TO %I/);
});

test("reconciler mantém assinatura claim na allowlist exata do worker", () => {
  assert.match(grants, /GRANT EXECUTE ON FUNCTION public\.pos_manual_claim_queries_v1\(text,integer,integer,text\) TO %I/);
  assert.match(grants, /public\.pos_manual_claim_queries_v1\(text,integer,integer,text\)/);
  assert.match(grants, /manual worker function EXECUTE allowlist diverges/);
  assert.match(grants, /ARRAY\['search_path=pg_catalog'\]/);
});
