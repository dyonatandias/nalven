import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { posRatePolicy } from "../lib/erp/pos-http";
import { hashPosValueAdminInput, parsePosValueAdminInput, PosValueAdminError } from "../lib/erp/pos-value-admin";
import { calculatePosValueTransition, PosValueError } from "../lib/erp/pos-value-accounts";
import { generatePosGiftCode, hashPosGiftCode, hashPosGiftPin, normalizePosGiftCode, verifyPosGiftPin } from "../lib/erp/pos-value-secrets";

const projectRoot = fileURLToPath(new URL("..", import.meta.url));
const pepper = "pos-value-test-pepper-with-at-least-32-bytes-0001";

test("gift card gera segredo forte, persiste somente HMAC/PIN scrypt e valida sem reexibir", async () => {
  await withPepper(async () => {
    const code = generatePosGiftCode(), compact = normalizePosGiftCode(code), codeHash = hashPosGiftCode(code), pinHash = await hashPosGiftPin("123456");
    assert.match(code, /^GC-[23456789ABCDEFGHJKLMNPQRSTUVWXYZ]{4}(?:-[23456789ABCDEFGHJKLMNPQRSTUVWXYZ]{4}){5}-[23456789ABCDEFGHJKLMNPQRSTUVWXYZ]{2}$/);
    assert.match(compact, /^GC[23456789ABCDEFGHJKLMNPQRSTUVWXYZ]{26}$/);
    assert.match(codeHash, /^hmac-sha256:v1:[0-9a-f]{64}$/);
    assert.doesNotMatch(codeHash, new RegExp(compact));
    assert.match(pinHash, /^scrypt:/);
    assert.equal(await verifyPosGiftPin("123456", pinHash), true);
    assert.equal(await verifyPosGiftPin("654321", pinHash), false);
  });
});

test("parser vincula tipos a cliente/programa e o hash não serializa PIN aberto", async () => {
  await withPepper(async () => {
    const first = parsePosValueAdminInput({
      action: "value.account.issue", idempotencyKey: key("gift-a"), branchId: 1, customerId: null, programId: null,
      kind: "gift_card", label: "Presente", initialUnits: 5000, expiresAt: "2027-08-29T00:00:00Z", pin: "123456",
    });
    const replay = { ...first, idempotencyKey: key("gift-b") };
    assert.equal(hashPosValueAdminInput(first), hashPosValueAdminInput(replay));
    assert.match(hashPosValueAdminInput(first), /^[0-9a-f]{64}$/);
    assert.ok(!hashPosValueAdminInput(first).includes("123456"));
    assert.throws(() => parsePosValueAdminInput({ ...first, idempotencyKey: key("bad-pin"), pin: "1234" }), /6 a 12/);
    assert.throws(() => parsePosValueAdminInput({ ...first, idempotencyKey: key("bad-program"), programId: "program_1" }), /somente para pontos e cashback/);
    assert.throws(() => parsePosValueAdminInput({ ...first, idempotencyKey: key("extra"), balanceUnits: 10 }), /Campo não permitido/);
    assert.throws(() => parsePosValueAdminInput({ action: "value.account.credit", idempotencyKey: key("coerce"), branchId: 1, accountId: "account_1", amountUnits: "100", reason: "Crédito manual" }), PosValueAdminError);
  });
});

test("transições preservam saldo, reserva e criação zerada sem arredondamento", () => {
  assert.deepEqual(calculatePosValueTransition(BigInt(0), BigInt(0), "issue", BigInt(0)), { balanceDelta: BigInt(0), reservedDelta: BigInt(0), balanceAfter: BigInt(0), reservedAfter: BigInt(0) });
  assert.deepEqual(calculatePosValueTransition(BigInt(1000), BigInt(0), "reserve", BigInt(700)), { balanceDelta: BigInt(0), reservedDelta: BigInt(700), balanceAfter: BigInt(1000), reservedAfter: BigInt(700) });
  assert.deepEqual(calculatePosValueTransition(BigInt(1000), BigInt(700), "capture", BigInt(700)), { balanceDelta: BigInt(-700), reservedDelta: BigInt(-700), balanceAfter: BigInt(300), reservedAfter: BigInt(0) });
  assert.deepEqual(calculatePosValueTransition(BigInt(1000), BigInt(700), "release", BigInt(700)), { balanceDelta: BigInt(0), reservedDelta: BigInt(-700), balanceAfter: BigInt(1000), reservedAfter: BigInt(0) });
  assert.throws(() => calculatePosValueTransition(BigInt(1000), BigInt(700), "debit", BigInt(301)), (error) => error instanceof PosValueError && error.status === 409);
  assert.throws(() => calculatePosValueTransition(BigInt(100), BigInt(0), "credit", BigInt(0)), PosValueError);
});

test("resolução por PIN tem limite forte e pepper ausente falha fechado", async () => {
  assert.deepEqual(posRatePolicy("gift.resolve"), { limit: 10, seconds: 300 });
  const previous = process.env.POS_VALUE_SECRET_PEPPER;
  delete process.env.POS_VALUE_SECRET_PEPPER;
  try {
    assert.throws(() => hashPosGiftCode(generatePosGiftCode()), /ao menos 32 bytes/);
    await assert.rejects(hashPosGiftPin("123456"), /ao menos 32 bytes/);
  } finally {
    if (previous === undefined) delete process.env.POS_VALUE_SECRET_PEPPER;
    else process.env.POS_VALUE_SECRET_PEPPER = previous;
  }
});

test("migration fecha centavos, identidade, replay, nova reserva e imutabilidade do ledger", () => {
  const migration = readFileSync(join(projectRoot, "prisma/tenant/migrations/20260829110000_pos_value_accounts/migration.sql"), "utf8");
  for (const token of [
    "pos_value_accounts_balance_check", "reserved_units\" BETWEEN 0 AND \"balance_units", "pos_value_ledger_entries_equation_check",
    "pos_value_ledger_entries_immutable_guard", "reject_pos_value_ledger_mutation", "value.account.issue", "value.reservation.capture", "value.entry.reverse",
  ]) assert.ok(migration.includes(token), `migration deve conter ${token}`);
  assert.match(migration, /"type" = 'issue' AND "balance_delta_units" = "amount_units"/);
  assert.match(migration, /CREATE INDEX "pos_value_reservations_account_reference_idx"/);
  assert.doesNotMatch(migration, /CREATE UNIQUE INDEX "pos_value_reservations_account_reference/);
  assert.match(migration, /CREATE UNIQUE INDEX "pos_value_accounts_program_customer_key" ON "pos_value_accounts"\("program_id", "customer_id"\)/);
  assert.doesNotMatch(migration, /tenant_id/);
});

async function withPepper(run: () => Promise<void>) {
  const previous = process.env.POS_VALUE_SECRET_PEPPER;
  process.env.POS_VALUE_SECRET_PEPPER = pepper;
  try { await run(); } finally { if (previous === undefined) delete process.env.POS_VALUE_SECRET_PEPPER; else process.env.POS_VALUE_SECRET_PEPPER = previous; }
}
function key(suffix: string) { return `pos-value-admin:${suffix}:00000000`; }
