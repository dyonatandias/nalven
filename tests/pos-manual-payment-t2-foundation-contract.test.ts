import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { POS_MANUAL_T2_EFFECT_KINDS, POS_MANUAL_T2_HASH_VECTORS, canonicalizePosManualT2, formatPosManualT2Timestamp, hashPosManualT2, assertPosManualT2DlpSafe, assertPosManualT2SnapshotDocument } from "../lib/erp/pos-manual-t2-canonical";

test("canonical v1 ordena bytes, preserva arrays/null e rejeita non-NFC", () => {
  assert.equal(canonicalizePosManualT2({ z: null, a: [2, 1], label: "Café" }), '{"a":[2,1],"label":"Café","z":null}');
  assert.throws(() => canonicalizePosManualT2("Cafe\u0301"), /NFC_REQUIRED/);
  assert.throws(() => canonicalizePosManualT2(1.5), /INTEGER_REQUIRED/);
  assert.throws(() => canonicalizePosManualT2("bad\nvalue"), /CONTROL_CHARACTER/);
  assert.throws(() => canonicalizePosManualT2({ "bad\nkey": 1 }), /CONTROL_CHARACTER/);
  assert.throws(() => canonicalizePosManualT2({ "é": 1, "e\u0301": 2 }), /NFC_REQUIRED/);
  assert.equal(formatPosManualT2Timestamp(new Date("2026-08-31T12:34:56.123Z")), "2026-08-31T12:34:56.123000Z");
  assert.equal(formatPosManualT2Timestamp("2026-08-31T12:34:56.123456Z"), "2026-08-31T12:34:56.123456Z");
  assert.throws(() => formatPosManualT2Timestamp("2026-02-30T12:34:56.123456Z"), /TIMESTAMP_INVALID/);
});

test("hash é domain-separated e manifesto enumera todos os kinds congelados", () => {
  assert.notEqual(hashPosManualT2("snapshot", { id: "opaque" }), hashPosManualT2("manifest", { id: "opaque" }));
  assert.equal(POS_MANUAL_T2_EFFECT_KINDS.length, 22);
  assert.equal(new Set(POS_MANUAL_T2_EFFECT_KINDS).size, POS_MANUAL_T2_EFFECT_KINDS.length);
  assert.equal(hashPosManualT2(POS_MANUAL_T2_HASH_VECTORS[0].domain, { a: [2, 1], z: null }), POS_MANUAL_T2_HASH_VECTORS[0].sha256);
});

test("schema Prisma expõe o grafo T2-00 e cardinalidades corretas", () => {
  const schema = readFileSync("prisma/tenant/schema.prisma", "utf8");
  const migration = readFileSync("prisma/tenant/migrations/20260829322000_pos_manual_payment_t2_foundation/migration.sql", "utf8");
  for (const model of ["PosManualFinalizationProfile", "PosManualApplicationSnapshot", "PosManualApplicationManifestEntry", "PosManualApplicationEffect"]) assert.match(schema, new RegExp(`model ${model} \\{`));
  assert.match(schema, /manualPaymentApplicationId\s+String\?\s+@unique @map\("manual_payment_application_id"\)/);
  assert.match(schema, /manualPaymentCaseId\s+String\?\s+@unique @map\("manual_payment_case_id"\)/);
  const caseModel = schema.match(/model PosManualPaymentCase \{[\s\S]*?\n\}/u)?.[0] ?? "";
  assert.match(caseModel, /application\s+PosManualPaymentApplication\?/);
  assert.doesNotMatch(caseModel, /applications\s+PosManualPaymentApplication\[\]/);
  for (const expected of [
    /accountingPolicyVersion\s+Int\s+@map\("accounting_policy_version"\)/,
    /homologatedAt\s+DateTime\?\s+@map\("homologated_at"\)/,
    /accountingApprovedAt\s+DateTime\?\s+@map\("accounting_approved_at"\)/,
    /fiscalApprovedAt\s+DateTime\?\s+@map\("fiscal_approved_at"\)/,
    /failureAt\s+DateTime\?\s+@map\("failure_at"\)/,
    /schemaVersion\s+Int\s+@default\(1\) @map\("schema_version"\)/,
    /reserveTxid\s+Decimal\s+@map\("reserve_txid"\) @db\.Decimal\(20, 0\)/,
    /manifestEntryId\s+BigInt\s+@map\("manifest_entry_id"\)/,
  ]) assert.match(schema, expected);
  assert.doesNotMatch(schema, /creationTxid\s+Decimal\s+@map\("creation_txid"\)/);
  assert.match(schema, /confirmedObservation\s+PosManualPaymentObservation\s+@relation\("PosManualApplicationConfirmedObservation", fields: \[caseId, confirmedObservationId\], references: \[caseId, id\]/);
  for (const uniqueField of ["saleIdempotencyKey", "saleId", "applyIdempotencyKey", "plannedSaleNumber"]) {
    assert.match(schema, new RegExp(`${uniqueField}\\s+\\S+\\s+@unique`));
  }
  assert.doesNotMatch(schema, /@@unique\(\[caseId, confirmedObservationId\]\)/);
  assert.match(schema, /accountingPolicy\s+PosAccountingPolicy\s+@relation\(fields: \[accountingPolicyId, branchId, accountingPolicyVersion, accountingPolicyHash\], references: \[id, branchId, version, mappingHash\]/);
  assert.match(schema, /fiscalProfile\s+PosFiscalProfileVersion\?\s+@relation\(fields: \[fiscalProfileId, fiscalProfileVersion, branchId, fiscalPolicyHash\], references: \[id, version, branchId, policyDigest\]/);
  assert.match(schema, /authoritativeSnapshot\s+PosManualApplicationSnapshot\s+@relation\("ApplicationSnapshotAuthority", fields: \[id, snapshotHash, manifestHash\], references: \[applicationId, snapshotHash, manifestHash\]/);
  assert.match(migration, /CONSTRAINT "pos_manual_apps_snapshot_fkey"[\s\S]*?FOREIGN KEY \("id", "snapshot_hash", "manifest_hash"\)[\s\S]*?REFERENCES public\."pos_manual_application_snapshots"\("application_id", "snapshot_hash", "manifest_hash"\)/);
  for (const sqlName of ["pos_manual_canonical_json_v1", "pos_manual_hash_canonical_json_v1", "pos_manual_t2_json_dlp_safe_v1", "manual_payment_application_id", "manual_payment_case_id"]) assert.match(migration, new RegExp(sqlName));
  assert.doesNotMatch(migration, /ADD COLUMN "manual_application_id"/);
});

test("DLP rejeita classe A", () => {
  assert.throws(() => assertPosManualT2DlpSafe({ authorization_code: "ABC123" }), /CLASS_A/);
  assert.doesNotThrow(() => assertPosManualT2DlpSafe({ reference_hash: "a".repeat(64), actor_id: "opaque" }));
  for (const forbidden of ["vault_token", "open_reference", "authorization_code", "nsu", "e2e"]) {
    assert.throws(() => assertPosManualT2DlpSafe({ [forbidden]: "secret" }), /CLASS_A/);
  }
  assert.throws(() => assertPosManualT2DlpSafe({ value: "4111 1111 1111 1111" }), /CLASS_A/);
  assert.doesNotThrow(() => assertPosManualT2DlpSafe({ value: "4111 1111 1111 1112" }));
  for (const forbidden of ["buyer@example.com", "123.456.789-09", "12.345.678/0001-90", "name", "nome", "postal code", "cep", "(11) 91234-5678", "+55 (11) 91234-5678", "01310-100", "Rua Augusta 123", "Avenida Paulista 1000"]) {
    assert.throws(() => assertPosManualT2DlpSafe({ value: forbidden }), /CLASS_B/);
  }
  assert.doesNotThrow(() => assertPosManualT2DlpSafe({ envelopeLocator: "opaque:v1:abc_DEF-123" }));
  for (const forbiddenUnicodeBoundary of ["énameé", "名nome名", "Ωpostal codeΩ"]) {
    assert.throws(() => assertPosManualT2DlpSafe({ value: forbiddenUnicodeBoundary }), /CLASS_B/);
  }
  for (const allowedEmbeddedMarker of ["username", "surname", "renomear"]) {
    assert.doesNotThrow(() => assertPosManualT2DlpSafe({ value: allowedEmbeddedMarker }));
  }
  assert.throws(() => assertPosManualT2SnapshotDocument("operationalActor", { unknown: "opaque" }), /UNKNOWN_KEY/);
  assert.throws(() => assertPosManualT2SnapshotDocument("webhooks", { schemaVersion: 1, endpoints: [{ endpointId: "id", unknownNested: true }] }), /UNKNOWN_KEY/);
  assert.throws(() => assertPosManualT2SnapshotDocument("fiscal", { schemaVersion: "1" }), /SCHEMA_VERSION/);
  assert.throws(() => assertPosManualT2SnapshotDocument("caseEvidence", { schemaVersion: 1 }), /REFERENCE_LAST_FOUR_INVALID/);
  assert.doesNotThrow(() => assertPosManualT2SnapshotDocument("caseEvidence", { schemaVersion: 1, referenceLastFour: "A*9_" }));
  for (const unsafeLastFour of ["123", "12345", "12 4", "12é4"]) {
    assert.throws(() => assertPosManualT2SnapshotDocument("caseEvidence", { schemaVersion: 1, referenceLastFour: unsafeLastFour }), /REFERENCE_LAST_FOUR_INVALID/);
  }
  assert.doesNotThrow(() => assertPosManualT2SnapshotDocument("fiscal", { schemaVersion: 1, envelopeLocator: "opaque:v1:abc", envelopeHash: "a".repeat(64) }));
});

test("canonical impõe limites de profundidade e tamanho", () => {
  let deep: { child?: unknown } = {};
  const root = deep;
  for (let index = 0; index < 34; index += 1) deep = (deep.child = {}) as { child?: unknown };
  assert.throws(() => canonicalizePosManualT2(root as never), /DEPTH_EXCEEDED/);
  assert.throws(() => canonicalizePosManualT2("x".repeat(65_537)), /SIZE_EXCEEDED/);
});
