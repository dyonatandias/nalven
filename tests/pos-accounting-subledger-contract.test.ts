import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import test from "node:test";

const root = fileURLToPath(new URL("..", import.meta.url));
const schema = readFileSync(`${root}/prisma/tenant/schema.prisma`, "utf8");
const migration = readFileSync(`${root}/prisma/tenant/migrations/20260829290000_pos_accounting_subledger/migration.sql`, "utf8");
const service = readFileSync(`${root}/lib/erp/pos-accounting-subledger.ts`, "utf8");
const runbook = readFileSync(`${root}/docs/erp/pdv/RUNBOOK-SUBLEDGER-CONTABIL.md`, "utf8");

test("schema cria subledger dedicado e não reutiliza Float/saldo mutável legado", () => {
  for (const model of ["PosAccountingAccount", "PosAccountingPeriod", "PosAccountingPolicy", "PosAccountingPolicyMapping", "PosAccountingJournal", "PosAccountingPosting", "PosAccountingExportOutbox"]) assert.match(schema, new RegExp(`model ${model}\\s`));
  assert.match(schema, /amount\s+Decimal\s+@db\.Decimal\(20, 2\)/);
  assert.match(schema, /amountCents\s+BigInt/);
  assert.match(schema, /@@unique\(\[originType, originId, originVersion\]/);
  assert.doesNotMatch(migration, /INSERT INTO "pos_accounting_accounts"/);
  assert.doesNotMatch(service, /financialAccount|accountEntry/);
});

test("PostgreSQL impõe double-entry diferido, journal fechado no tx e append-only", () => {
  assert.match(migration, /DEFERRABLE INITIALLY DEFERRED/);
  assert.match(migration, /posting_count < 2 OR debit_total <> credit_total/);
  assert.match(migration, /debit_total <> journal_record\."total_debit_cents"/);
  assert.match(migration, /postings must be created in the journal transaction/);
  assert.match(migration, /txid_current\(\)/);
  assert.match(migration, /pos_accounting_journals_immutable_guard/);
  assert.match(migration, /pos_accounting_postings_immutable_guard/);
  assert.match(migration, /post a reversal journal/);
});

test("contexto exige período aberto, política homologada e mapping exato da mesma policy", () => {
  assert.match(migration, /closed POS accounting period rejects retroactive journal/);
  assert.match(migration, /competence_date[\s\S]*starts_at/);
  assert.match(migration, /policy_record\."status" <> 'active'/);
  assert.match(migration, /accountant_approval_ref/);
  assert.match(migration, /homologated POS accounting policy content is immutable/);
  assert.match(migration, /OLD\."effective_until" IS DISTINCT FROM NEW\."effective_until"/);
  assert.match(migration, /mapping_record\."policy_id" <> journal_record\."policy_id"/);
  assert.match(migration, /mapping_record\."source_type" <> expected_source/);
  assert.match(migration, /NEW\."direction" <> expected_direction/);
  assert.match(migration, /NEW\."account_code_snapshot" <> account_record\."code"/);
  assert.match(migration, /"amount" = \("amount_cents"::numeric \/ 100\)/);
  assert.match(service, /hashPosAccountingPolicyMappings\(allMappings\) !== policy\.mappingHash/);
});

test("reversão é novo journal, inversão exata e outbox não muta journal", () => {
  assert.match(migration, /reversal must exactly invert the original journal/);
  assert.match(migration, /reversal\."direction" <> CASE original\."direction"/);
  assert.match(service, /originType: "accounting_reversal"/);
  assert.match(service, /posting\.direction === "debit" \? "credit" : "debit"/);
  assert.match(service, /exportOutbox: \{ create: \{\} \}/);
  assert.match(migration, /Mutable export delivery state kept outside the immutable journal/);
  assert.match(service, /factsHash: hashPosAccountingPayload\(reversalFacts\)/);
});

test("replays e textos livres são fail-closed para conteúdo divergente ou PII", () => {
  assert.match(service, /policy\.accountantApprovalRef !== accountantApprovalRef \|\| policy\.homologatedBy !== homologatedBy/);
  assert.match(service, /period\.closedBy !== closedBy \|\| period\.closeReason !== reason/);
  assert.match(service, /function safeText[\s\S]*rejectPiiText\(result\)/);
  assert.match(service, /function safeActorIdentifier[\s\S]*rejectPiiText\(result\)/);
});

test("fundação permanece PARTIAL e todos os producers são apenas snapshots sem contas fictícias", () => {
  for (const builder of ["buildPosSaleAccountingSnapshot", "buildPosRefundAccountingSnapshot", "buildPosCashAccountingSnapshot", "buildPosInventoryCogsAccountingSnapshot", "buildPosFiscalTaxAccountingSnapshot", "buildPosMdrAccountingSnapshot", "buildPosValueAccountAccountingSnapshot"]) assert.match(service, new RegExp(`function ${builder}`));
  assert.match(runbook, /PARTIAL/);
  assert.match(runbook, /não habilita/i);
  assert.match(runbook, /contador/i);
  assert.match(runbook, /sem seed/i);
});
