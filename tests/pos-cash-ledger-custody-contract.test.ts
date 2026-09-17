import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const root = fileURLToPath(new URL("..", import.meta.url));
const read = (path: string) => readFileSync(join(root, path), "utf8");
const migration = read("prisma/tenant/migrations/20260829270000_pos_cash_ledger_custody/migration.sql");

test("migration cria ledger por FK, sequência, saldos e deduplicação de origem", () => {
  for (const fragment of [
    'CREATE TABLE "pos_cash_ledger_entries"',
    'FOREIGN KEY ("register_id", "branch_id")',
    'FOREIGN KEY ("session_id", "register_id")',
    'FOREIGN KEY ("terminal_id", "register_id")',
    '"pos_cash_ledger_actor_profile_id_fkey"',
    '"pos_cash_ledger_entries_session_sequence_key"',
    '"pos_cash_ledger_reference_key"',
    '"pos_cash_ledger_entries_reversal_for_id_key"',
  ]) assert.ok(migration.includes(fragment), fragment);
  assert.match(migration, /entry_type" = 'opening' AND "delta_cents" >= 0/);
  assert.match(migration, /entry_type" IN \('sale', 'supply'\) AND "delta_cents" > 0/);
  assert.match(migration, /entry_type" IN \('return', 'withdrawal', 'custody_seal'\) AND "delta_cents" < 0/);
  assert.match(migration, /must start with opening at sequence 1 and zero balance/);
  assert.match(migration, /cash ledger sequence or balance chain broken/);
});

test("todas as estruturas monetárias e de custódia são append-only", () => {
  for (const table of ["ledger", "custody_bag", "custody_event", "custody_incident", "custody_resolution"]) {
    assert.match(migration, new RegExp(`pos_cash_${table}_forbid_update_trigger`));
    assert.match(migration, new RegExp(`pos_cash_${table}_forbid_delete_trigger`));
  }
  assert.match(migration, /pos_cash_forbid_mutation/);
  assert.match(migration, /Never update\/delete; post a compensating reversal/);
});

test("aprovação é de uso único e vinculada a ator, ação, entidade, snapshot e SoD", () => {
  for (const evidence of [
    "cash.ledger.reversal", "cash.ledger.adjustment", "cash.custody.divergence.resolve",
    'approval_record."context" <> expected_context', 'approval_record."requester_id" <> actor_user_id',
    'approval_record."approver_id" = actor_user_id', 'approval_record."consumed_at" IS NOT NULL',
    'UPDATE "pos_approvals" SET "consumed_at"', '"consumption_ref" = \'pos_cash_ledger_entry:\'',
  ]) assert.ok(migration.includes(evidence), evidence);
  assert.match(migration, /expires_at" <= NEW\."occurred_at"/);
  assert.match(migration, /expires_at" <= NEW\."resolved_at"/);
});

test("malote exige dupla custódia, incidente consistente e fechamento atômico", () => {
  assert.match(migration, /delivery requires current custodian and a distinct designated recipient/);
  assert.match(migration, /acceptance requires the distinct designated recipient and exact amount/);
  assert.match(migration, /EXISTS \(SELECT 1 FROM "pos_cash_custody_incidents" WHERE "bag_id" = NEW\."bag_id"\)/);
  assert.match(migration, /custody resolution requires the latest event to be its reported divergence/);
  for (const trigger of ["bag_requires_seal_event", "incident_requires_event", "resolution_requires_event", "ledger_custody_requires_bag"]) assert.match(migration, new RegExp(trigger));
  assert.match(migration, /DEFERRABLE INITIALLY DEFERRED/g);
});

test("serviço revalida proof, turno, ator e alçada e persiste apenas campos Prisma", () => {
  const ledger = read("lib/erp/pos-cash-ledger.ts"), custody = read("lib/erp/pos-cash-custody.ts");
  assert.match(ledger, /assertPosOperationalTerminalProof\(terminal, context\.terminalProof/);
  assert.match(ledger, /userId: context\.actorUserId/);
  assert.match(ledger, /cashAccessAllowed\(access, entryType\)/);
  assert.match(ledger, /status: \{ in: sessionStates \}/);
  assert.match(ledger, /posCashLedgerPersistenceContext\(context\)/);
  assert.doesNotMatch(ledger, /\.\.\.context, \.\.\.plan/);
  assert.match(custody, /assertCashLedgerContext\(tx, context, "custody_seal"\)/);
  assert.match(custody, /O malote possui incidente e não pode seguir pelo aceite normal/);
});

test("integração legada permanece explicitamente pendente", () => {
  const route = read("app/api/erp/pdv/route.ts"), docs = read("docs/erp/pdv/CAIXA-LEDGER-CUSTODIA-RUNBOOK.md");
  assert.doesNotMatch(route, /pos-cash-ledger|pos-cash-custody|postPosCashLedgerEntry|sealPosCashCustodyBag/);
  assert.match(docs, /PARTIAL/);
  assert.match(docs, /cash_register_events/);
  assert.match(docs, /não (?:foi|está) integrad[oa]/i);
});
