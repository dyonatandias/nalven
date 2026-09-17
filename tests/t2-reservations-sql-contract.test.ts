import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import test from "node:test";

const migrationPath = "prisma/tenant/migrations/20260829322200_pos_manual_payment_t2_reservations/migration.sql";
const migration = readFileSync(migrationPath, "utf8");
const decisions = readFileSync("docs/erp/pdv/DECISOES-EXECUTAVEIS-T2-02.md");

test("T2-02 SQL rejects the invalidated decisions hash while v12 remains open for cross-review", () => {
  assert.notEqual(createHash("sha256").update(decisions).digest("hex"), "7116152ab347c931203f0f77695f8b619bcdd7fdb3943d24a94e714579003ad0");
  assert.match(decisions.toString("utf8"), /#### 3\.3\.1 Cinco ABIs boundary fechadas/);
  assert.match(decisions.toString("utf8"), /Esta v12 substitui a omissão anterior/);
  assert.match(migration, /4c239c899b6c7e498150ceee3c635c03eb1f432298994be7d12ac04896b5d388/);
  assert.match(migration, /T2-02 preflight requires an empty hard-off T2 database/);
});

test("T2-02 materializes the closed reservation and sweep relations", () => {
  for (const relation of [
    "pos_manual_application_stock_reservations",
    "pos_manual_application_stock_reservation_events",
    "pos_manual_application_promotion_reservations",
    "pos_manual_application_promotion_reservation_events",
    "pos_manual_application_reserve_assertions",
    "pos_manual_application_release_assertions",
    "pos_manual_application_sweep_batches",
    "pos_manual_application_sweep_receipts",
  ]) assert.match(migration, new RegExp(`CREATE TABLE public\\.\"${relation}\"`));
  assert.match(migration, /quantity_micros\" BETWEEN 1 AND 9007199254740991/);
  assert.match(migration, /release_reason\" IN \('reservation_expired','boundary_changed'\)/);
  assert.match(migration, /DEFERRABLE INITIALLY DEFERRED/);
});

test("T2-02 exposes the nine exact public ABIs and leaves all nine revoked", () => {
  const signatures = [
    ["pos_manual_reserve_application_v1", "uuid,integer,integer,text,text,text"],
    ["pos_manual_application_status_v1", "uuid,text"],
    ["pos_manual_application_status_by_reservation_v1", "uuid,text,text,integer,text"],
    ["pos_manual_sweep_expired_applications_v1", "text,integer,text,text"],
    ["pos_t2_catalog_boundary_v1", "text,integer,integer,text,jsonb,jsonb,text,text,text"],
    ["pos_t2_value_program_boundary_v1", "text,text,integer,text,integer,text,text,text,integer,integer,integer,integer,text,text,text"],
    ["pos_t2_accounting_period_put_v1", "integer,integer,integer,date,date,text,text,text,text"],
    ["pos_t2_accounting_period_close_v1", "text,integer,text,text,text,text,text"],
    ["pos_t2_webhook_boundary_v1", "text,text,integer,text,text,text,text,text,text,text,text,text,text,text"],
  ] as const;
  for (const [name, identity] of signatures) {
    assert.match(migration, new RegExp(`CREATE FUNCTION public\\.\"${name}\"`));
    assert.match(migration, new RegExp(`REVOKE ALL ON FUNCTION public\\.\"${name}\"\\(${identity}\\) FROM PUBLIC`));
  }
  assert.doesNotMatch(migration, /GRANT\s+EXECUTE/i);
  assert.doesNotMatch(migration, /GRANT\s+(SELECT|INSERT|UPDATE|DELETE)/i);
});

test("T2-02 keeps incomplete reserve/release paths explicitly fail-closed", () => {
  assert.match(migration, /T2 reserve snapshot graph is unavailable/);
  assert.match(migration, /T2 non-empty sweep release producer is unavailable/);
  assert.match(migration, /T2 required fiscal envelope is unavailable/);
  assert.match(migration, /manual reconciliation remains hard-disabled/);
});

test("T2-02 closes canonical size, path DLP, UUID16 and frozen response semantics", () => {
  assert.match(migration, /4194304/);
  assert.match(migration, /pos_manual_t2_document_shape_v1/);
  assert.match(migration, /pos_manual_uuid16_v1/);
  assert.match(migration, /'applicationVersion',0/);
  assert.match(migration, /'snapshotHash',app\.snapshot_hash,'state','pending'/);
  assert.match(migration, /'status','not_found'/);
});
