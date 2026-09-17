import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const migration = readFileSync("prisma/tenant/migrations/20260829321200_pos_manual_open_vault_capabilities/migration.sql", "utf8");

test("321f materializa protocolo bifásico sem raw reference ou vault token", () => {
  for (const table of ["pos_manual_open_requests", "pos_manual_vault_proofs"]) assert.match(migration, new RegExp(`CREATE TABLE public\\.\"${table}\"`));
  for (const fn of ["prepare_open", "claim_open_for_vault", "open_case", "open_status", "abandon_open", "probe_open"]) {
    assert.match(migration, new RegExp(`CREATE FUNCTION public\\.\"pos_manual_${fn}_v1\"`));
  }
  assert.doesNotMatch(migration, /raw_reference|rawReference|redeemable_token/i);
  assert.match(migration, /'vault-proof:'\|\|proof\."id"::text/);
  assert.match(migration, /"vault_proof_id" UUID UNIQUE/);
});

test("321f fecha authority, fencing, replay e grafo causal", () => {
  assert.equal((migration.match(/SECURITY DEFINER SET search_path=pg_catalog/g) ?? []).length, 6);
  assert.equal((migration.match(/REVOKE ALL ON FUNCTION public\."pos_manual_(?:prepare_open|claim_open_for_vault|open_case|open_status|abandon_open|probe_open)_v1"/g) ?? []).length, 6);
  assert.match(migration, /pos_manual_lock_open_graph_321f/);
  assert.match(migration, /pos_manual_open_boundary_failure_321f/);
  assert.match(migration, /clock_timestamp\(\)/);
  assert.match(migration, /p_claim_token IS NULL/);
  assert.match(migration, /finalize_request_hash/);
  assert.match(migration, /abandon_request_hash/);
  assert.match(migration, /manual open finalized graph is incomplete or divergent/);
  assert.match(migration, /DEFERRABLE INITIALLY DEFERRED/);
  assert.match(migration, /pos_manual_vault_proofs_append_only/);
  assert.match(migration, /current_database\(\)\|\|'_mb'/);
  assert.doesNotMatch(migration, /UPDATE public\."pos_manual_payment_reconciliation_gates"/);
});

