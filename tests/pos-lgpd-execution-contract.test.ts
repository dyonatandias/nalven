import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import test from "node:test";

const root = fileURLToPath(new URL("..", import.meta.url));
const schema = readFileSync(`${root}/prisma/tenant/schema.prisma`, "utf8");
const migration = readFileSync(`${root}/prisma/tenant/migrations/20260829300000_pos_lgpd_execution/migration.sql`, "utf8");
const service = readFileSync(`${root}/lib/erp/pos-lgpd-execution.ts`, "utf8");
const runbook = readFileSync(`${root}/docs/erp/pdv/RUNBOOK-LGPD-EXECUTAVEL.md`, "utf8");

test("schema separa cadastro legado da execução LGPD pseudonimizada", () => {
  for (const model of ["PosLgpdRetentionPolicy", "PosLgpdSubjectRequest", "PosLgpdRequestStateLedger", "PosLgpdInventoryObject", "PosLgpdLegalHold", "PosLgpdExecutionJob", "PosLgpdExecutionOutbox", "PosLgpdEvidence"]) assert.match(schema, new RegExp(`model ${model}\\s`));
  assert.match(schema, /subjectTokenHash\s+String\s+@map\("subject_token_hash"\)/);
  assert.match(schema, /tokenKeyId\s+String\s+@map\("token_key_id"\)/);
  assert.match(schema, /tokenVersion\s+Int/);
  assert.match(schema, /matchedCount\s+BigInt/);
  assert.doesNotMatch(migration, /INSERT INTO "pos_lgpd_retention_policies"/);
  assert.doesNotMatch(schema.slice(schema.indexOf("model PosLgpdRetentionPolicy")), /subjectName|subjectDocument|contact\s+String/);
});

test("estado e evidência são append-only e toda transição exige ledger no mesmo tx", () => {
  assert.match(migration, /LGPD evidence and state ledgers are append-only/);
  assert.match(migration, /DEFERRABLE INITIALLY DEFERRED/);
  assert.match(migration, /exactly one append-only ledger event in the same transaction/);
  assert.match(migration, /subject requests must be created in received state/);
  assert.match(migration, /legal holds must be created active/);
  assert.match(migration, /inventory objects must be created as observed/);
  assert.match(migration, /LGPD request ledger hash chain is broken/);
  assert.match(migration, /creation_txid[\s\S]*txid_current\(\)/);
  assert.match(service, /priorEvidenceHash: prior\?\.evidenceHash/);
  assert.match(service, /priorHash: prior\?\.eventHash/);
});

test("ações destrutivas exigem política homologada, maker-checker, step-up e ausência de hold", () => {
  assert.match(migration, /destructive LGPD job requires maker-checker and step-up approval/);
  assert.match(migration, /active LGPD legal hold blocks destructive execution/);
  assert.match(migration, /exact active homologated retention policy/);
  assert.match(migration, /proposed_by" <> "homologated_by/);
  assert.match(migration, /retention policies must be created as draft/);
  assert.match(service, /checker distinto e prova de step-up/);
  assert.match(service, /blockReason = "legal_hold"/);
});

test("fundação é fail-closed sem adapter, KMS ou alegação de execução real", () => {
  assert.match(migration, /must be created fail-closed in blocked state/);
  assert.match(service, /always persisted as `blocked`/);
  assert.match(service, /exposes no claim\/execute\/delete\/anonymize method/);
  assert.doesNotMatch(service, /function (claim|execute|delete|anonymize)PosLgpd/i);
  assert.doesNotMatch(migration, /CREATE EXTENSION|encryption_key|ciphertext/i);
  assert.match(runbook, /PARTIAL/);
  assert.match(runbook, /não apaga nem anonimiza/i);
  assert.match(runbook, /KMS/i);
  assert.match(runbook, /jurídic/i);
  assert.match(runbook, /retokeniza/i);
});

test("serviço rejeita PII, PAN e JSON não canônico", () => {
  assert.match(service, /containsPosPaymentPanInIdentifier/);
  assert.match(service, /createHmac\("sha256", context\.pepper\)/);
  assert.match(service, /POS_LGPD_TOKEN_PEPPER obrigatório/);
  assert.match(service, /POS_LGPD_TOKEN_KEY_ID obrigatório/);
  assert.match(service, /v\$\{context\.version\}:\$\{domain\}/);
  assert.match(service, /PII\/PCI em claro não permitida/);
  assert.match(service, /JSON LGPD contém número não finito/);
  assert.match(service, /JSON LGPD contém valor não serializável/);
});
