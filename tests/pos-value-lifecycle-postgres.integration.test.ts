import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../generated/tenant/client";
import { applyPosValueCommand, hashPosValueCommand, issuePosValueAccount } from "../lib/erp/pos-value-accounts";
import { posValueLiabilityReport } from "../lib/erp/pos-value-liability";
import { POS_VALUE_LIFECYCLE_ACTOR, sweepPosValueLifecycle } from "../lib/erp/pos-value-lifecycle";

const connectionString = process.env.POS_TEST_DATABASE_URL;

test("PostgreSQL executa lifecycle concorrente uma vez e preserva ledger/auditoria", { skip: !connectionString }, async () => {
  const first = client(), second = client(), token = randomUUID(), base = new Date(), sweepAt = new Date(base.valueOf() + 2 * 60 * 60_000);
  try {
    const branch = await first.branch.create({ data: { code: `PG-VALUE-LIFE-${token}`, name: "Filial lifecycle PostgreSQL", legalName: "Filial lifecycle PostgreSQL Ltda", document: `PGVL${token.replaceAll("-", "")}` } });
    const customers = await Promise.all(["A", "B"].map(suffix => first.customer.create({ data: { name: `Cliente lifecycle ${suffix}`, document: `PGVLC${suffix}${token.replaceAll("-", "")}`, status: "active" } })));
    const context = { actor: "postgres:value-lifecycle", now: base };
    const operation = (name: string) => ({
      operationKey: `value-lifecycle:${name}:${token}`,
      requestHash: hashPosValueCommand({ name, token }),
      referenceType: "postgres_value_lifecycle",
      referenceId: token,
      reason: `Operação lifecycle PostgreSQL ${name}`,
    });
    const issue = (name: string, customerId: number, expiresAt: Date, initialUnits: number) => first.$transaction(tx => issuePosValueAccount(tx, {
      ...operation(`issue-${name}`), branchId: branch.id, customerId, programId: null, kind: "store_credit", label: `Crédito lifecycle ${name}`, initialUnits, expiresAt,
    }, context), { isolationLevel: "Serializable" });
    const expiring = await issue("expiring", customers[0].id, new Date(base.valueOf() + 60 * 60_000), 1_000);
    const active = await issue("active", customers[1].id, new Date(base.valueOf() + 24 * 60 * 60_000), 500);
    const reserve = (name: string, accountId: string, expiresAt: Date, amountUnits: number) => first.$transaction(tx => applyPosValueCommand(tx, {
      ...operation(`reserve-${name}`), type: "reserve", accountId, branchId: branch.id, amountUnits, expiresAt,
    }, context), { isolationLevel: "Serializable" });
    const futureReservation = await reserve("future-on-expiring", expiring.account.id, new Date(base.valueOf() + 6 * 60 * 60_000), 400);
    const expiredReservation = await reserve("expired-on-active", active.account.id, new Date(base.valueOf() + 60 * 60_000), 200);
    assert.ok(futureReservation.reservation && expiredReservation.reservation);

    const concurrent = await Promise.all([
      sweepPosValueLifecycle(first, { now: sweepAt, batchSize: 20 }),
      sweepPosValueLifecycle(second, { now: sweepAt, batchSize: 20 }),
    ]);
    assert.ok(concurrent.reduce((sum, result) => sum + result.releasedReservations, 0) >= 2, "o sweep pode também consumir resíduos vencidos do banco descartável");
    assert.ok(concurrent.reduce((sum, result) => sum + result.expiredAccounts, 0) >= 1, "o sweep pode também expirar resíduos vencidos do banco descartável");
    assert.equal(concurrent.reduce((sum, result) => sum + result.skippedConcurrent, 0) >= 1, true, "um worker concorrente deve ceder o advisory lock");
    const [expiredAccount, activeAccount, reservations] = await Promise.all([
      first.posValueAccount.findUniqueOrThrow({ where: { id: expiring.account.id } }),
      first.posValueAccount.findUniqueOrThrow({ where: { id: active.account.id } }),
      first.posValueReservation.findMany({ where: { id: { in: [futureReservation.reservation.id, expiredReservation.reservation.id] } }, orderBy: { id: "asc" } }),
    ]);
    assert.deepEqual({ status: expiredAccount.status, balance: expiredAccount.balanceUnits, reserved: expiredAccount.reservedUnits }, { status: "expired", balance: BigInt(0), reserved: BigInt(0) });
    assert.deepEqual({ status: activeAccount.status, balance: activeAccount.balanceUnits, reserved: activeAccount.reservedUnits }, { status: "active", balance: BigInt(500), reserved: BigInt(0) });
    assert.equal(reservations.every(reservation => reservation.state === "expired" && reservation.completedAt != null), true);

    const lifecycleEntries = await first.posValueLedgerEntry.findMany({ where: { accountId: { in: [expiring.account.id, active.account.id] }, actor: POS_VALUE_LIFECYCLE_ACTOR }, orderBy: { id: "asc" } });
    assert.equal(lifecycleEntries.filter(entry => entry.type === "release").length, 2);
    assert.equal(lifecycleEntries.filter(entry => entry.type === "expire").length, 1);
    assert.equal(new Set(lifecycleEntries.map(entry => entry.operationKey)).size, 3);
    assert.equal(await first.tenantAuditEvent.count({ where: { action: { in: ["pos.value.reservation.expired", "pos.value.account.expired"] }, entityId: { in: [expiring.account.id, futureReservation.reservation.id, expiredReservation.reservation.id] } } }), 3);

    const replay = await sweepPosValueLifecycle(first, { now: sweepAt, batchSize: 20 });
    assert.equal(replay.releasedReservations, 0);
    assert.equal(replay.expiredAccounts, 0);
    assert.equal(await first.posValueLedgerEntry.count({ where: { accountId: { in: [expiring.account.id, active.account.id] }, actor: POS_VALUE_LIFECYCLE_ACTOR } }), 3);
    await assert.rejects(first.posValueLedgerEntry.update({ where: { id: lifecycleEntries[0].id }, data: { reason: "Tentativa de alteração do lifecycle" } }));
    await assert.rejects(first.posValueLedgerEntry.delete({ where: { id: lifecycleEntries[0].id } }));

    const report = await posValueLiabilityReport(first, branch.id, sweepAt);
    assert.deepEqual(report.totals, { accountCount: 1, points: "0", cents: "500", faceValueCents: "500", reservedFaceValueCents: "0", availableFaceValueCents: "500" });
    assert.equal(report.rows.length, 1);
    assert.deepEqual({ kind: report.rows[0].kind, unit: report.rows[0].unit, status: report.rows[0].status, accountCount: report.rows[0].accountCount }, { kind: "store_credit", unit: "cents", status: "active", accountCount: 1 });
    assert.equal(report.due.reservationCount, 0);
    assert.equal(report.due.accountCount, 0);
    assert.ok(report.lastSweep);
  } finally {
    await Promise.all([first.$disconnect(), second.$disconnect()]);
  }
});

function client() {
  if (!connectionString) throw new Error("POS_TEST_DATABASE_URL não definida");
  return new PrismaClient({ adapter: new PrismaPg({ connectionString }) });
}
