import assert from "node:assert/strict";
import test from "node:test";
import { parsePosSettlementCsv, reconcilePosSettlements } from "../lib/erp/pos-reconciliation";

const header = "provider,settlement_id,transaction_id,kind,gross_cents,fee_cents,net_cents,occurred_at,settled_at";
const now = new Date("2026-08-29T12:00:00.000Z");

test("importa CSV canônico, aspas, digest e equações de entrada/saída", () => {
  const source = `${header}\npsp-demo,"SET,001",TX-1,payment,10000,250,9750,2026-08-28T10:00:00Z,2026-08-29T10:00:00Z\npsp-demo,SET-002,TX-2,refund,1000,10,-1010,2026-08-28T11:00:00Z,2026-08-29T11:00:00Z\n`;
  const result = parsePosSettlementCsv(source, now);
  assert.match(result.digest, /^[a-f0-9]{64}$/);
  assert.equal(result.entries.length, 2);
  assert.equal(result.entries[0].settlementId, "SET,001");
  assert.equal(result.entries[1].netCents, -1_010);
});

test("recusa cabeçalho, CSV, equação, data e arquivo excessivo", () => {
  assert.throws(() => parsePosSettlementCsv("provider,bad\na,b", now), /Cabeçalho/);
  assert.throws(() => parsePosSettlementCsv(`${header}\n"psp-demo,SET,TX,payment,100,0,100,2026-08-28T10:00:00Z,2026-08-29T10:00:00Z`, now), /não terminado/);
  assert.throws(() => parsePosSettlementCsv(`${header}\n"psp-demo"x,SET,TX,payment,100,0,100,2026-08-28T10:00:00Z,2026-08-29T10:00:00Z`, now), /após aspas/);
  assert.throws(() => parsePosSettlementCsv(`${header}\npsp-demo,SET,TX,payment,100,10,100,2026-08-28T10:00:00Z,2026-08-29T10:00:00Z`, now), /Equação/);
  assert.throws(() => parsePosSettlementCsv(`${header}\npsp-demo,SET,TX,payment,100,0,100,2026-08-30T10:00:00Z,2026-08-30T11:00:00Z`, now), /inválido/);
  assert.throws(() => parsePosSettlementCsv("x".repeat(5 * 1024 * 1024 + 1), now), /5 MiB/);
});

test("conciliação perfeita fecha totais e não bloqueia", () => {
  const entries = parsePosSettlementCsv(`${header}\npsp-demo,SET-1,TX-1,payment,10000,250,9750,2026-08-28T10:00:00Z,2026-08-29T10:00:00Z\n`, now).entries;
  const result = reconcilePosSettlements([{ provider: "PSP-DEMO", transactionId: "TX-1", kind: "payment", amountCents: 10_000, status: "captured" }], entries);
  assert.deepEqual({ matched: result.matched, issues: result.issueCount, blocking: result.productionBlocking }, { matched: 1, issues: 0, blocking: false });
  assert.deepEqual(result.totals, { grossCents: 10_000, feeCents: 250, netCents: 9_750 });
});

test("classifica ausente, inesperado, tipo, valor e estado não final", () => {
  const entries = parsePosSettlementCsv(`${header}\npsp-demo,SET-1,TX-1,chargeback,900,10,-910,2026-08-28T10:00:00Z,2026-08-29T10:00:00Z\npsp-demo,SET-2,TX-X,payment,500,0,500,2026-08-28T10:00:00Z,2026-08-29T10:00:00Z\n`, now).entries;
  const result = reconcilePosSettlements([
    { provider: "psp-demo", transactionId: "TX-1", kind: "payment", amountCents: 1_000, status: "processing" },
    { provider: "psp-demo", transactionId: "TX-MISSING", kind: "payment", amountCents: 200, status: "captured" },
  ], entries);
  assert.equal(result.productionBlocking, true);
  assert.deepEqual(new Set(result.issues.map((item) => item.code)), new Set(["kind_mismatch", "amount_mismatch", "non_final_erp_state", "missing_provider_entry", "unexpected_provider_entry"]));
});

test("marca duplicidades de lançamento e referência sem ocultar o confronto", () => {
  const entry = parsePosSettlementCsv(`${header}\npsp-demo,SET-1,TX-1,payment,100,0,100,2026-08-28T10:00:00Z,2026-08-29T10:00:00Z\n`, now).entries[0];
  const result = reconcilePosSettlements([
    { provider: "psp-demo", transactionId: "TX-1", kind: "payment", amountCents: 100, status: "captured" },
    { provider: "psp-demo", transactionId: "TX-1", kind: "payment", amountCents: 100, status: "captured" },
  ], [entry, entry]);
  assert.equal(result.issues.filter((item) => item.code === "duplicate_transaction").length, 2);
  assert.equal(result.issues.filter((item) => item.code === "duplicate_settlement").length, 1);
});

test("boundary rejeita objeto de liquidação montado fora do parser", () => {
  assert.throws(() => reconcilePosSettlements([], [{ provider: "psp-demo", settlementId: "SET", transactionId: "TX", kind: "payment", grossCents: 100, feeCents: 0, netCents: 100, occurredAt: new Date("invalid"), settledAt: now }]), /Datas/);
});

test("recusa overflow agregado mesmo quando cada linha cabe no inteiro seguro", () => {
  const entry = { provider: "psp-demo", settlementId: "SET", transactionId: "TX", kind: "payment" as const, grossCents: 9_000_000_000_000_000, feeCents: 0, netCents: 9_000_000_000_000_000, occurredAt: new Date("2026-08-28T10:00:00Z"), settledAt: now };
  assert.throws(() => reconcilePosSettlements([], [entry, { ...entry, settlementId: "SET-2", transactionId: "TX-2" }]), /inteiro seguro/);
});
