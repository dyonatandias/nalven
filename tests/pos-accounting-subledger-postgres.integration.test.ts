import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../generated/tenant/client";
import {
  activatePosAccountingPolicy,
  buildPosSaleAccountingSnapshot,
  closePosAccountingPeriod,
  createPosAccountingPeriod,
  postPosAccountingJournal,
  reversePosAccountingJournal,
} from "../lib/erp/pos-accounting-subledger";

const connectionString = process.env.POS_TEST_DATABASE_URL;

test("PostgreSQL serializa origem, fecha double-entry, bloqueia mutação/período e exige reversão exata", { skip: !connectionString, timeout: 90_000 }, async () => {
  const first = client();
  const second = client();
  const rawToken = randomUUID().replaceAll("-", "").toLowerCase();
  const token = [...rawToken].map((character) => String.fromCharCode(97 + Number.parseInt(character, 16))).join("");
  const saleId = 1_000_000 + Number.parseInt(rawToken.slice(0, 6), 16);
  const competenceDate = "2026-08-29";
  try {
    const branch = await first.branch.create({ data: { code: `ACC${token.slice(0, 12)}`, name: "Accounting test branch", legalName: "Accounting test branch Ltda", document: `ACCDOC${token}` } });
    const accountingActor = `accountant-${token}`;
    const adminRole = await first.tenantRole.upsert({ where: { key: "admin" }, update: { active: true, permissions: { "accounting.write": true } }, create: { key: "admin", name: "Administrator", active: true, permissions: { "accounting.write": true }, system: true } });
    await first.tenantUserProfile.create({ data: { userId: accountingActor, roleId: adminRole.id, displayName: "Accounting test actor", email: `${token}@example.test`, status: "active" } });
    const costCenter = await first.costCenter.create({ data: { code: `CC${token.slice(0, 12)}`, name: "Accounting test cost center" } });
    const debitAccount = await first.posAccountingAccount.create({ data: { id: `account-debit-${token}`, code: `D.${token.slice(0, 16)}`, name: "Homologated debit account", accountType: "asset", normalBalance: "debit", status: "active" } });
    const creditAccount = await first.posAccountingAccount.create({ data: { id: `account-credit-${token}`, code: `C.${token.slice(0, 16)}`, name: "Homologated credit account", accountType: "revenue", normalBalance: "credit", status: "active" } });
    const { period } = await createPosAccountingPeriod(first, { branchId: branch.id, year: 2026, month: 8, startsOn: "2026-08-01", endsOn: "2026-08-31", actorUserId: accountingActor, idempotencyKey: `accounting-period-${token}` });
    const policy = await first.posAccountingPolicy.create({ data: { id: `policy-${token}`, branchId: branch.id, version: 1, status: "draft", effectiveFrom: new Date("2026-08-01T00:00:00.000Z"), mappingHash: "0".repeat(64) } });
    const debitMapping = await first.posAccountingPolicyMapping.create({ data: { id: `mapping-debit-${token}`, policyId: policy.id, sourceType: "sale", entryKey: "sale_receivable", accountId: debitAccount.id, direction: "debit" } });
    const creditMapping = await first.posAccountingPolicyMapping.create({ data: { id: `mapping-credit-${token}`, policyId: policy.id, sourceType: "sale", entryKey: "gross_revenue", accountId: creditAccount.id, direction: "credit" } });
    const activated = await activatePosAccountingPolicy(first, { policyId: policy.id, accountantApprovalRef: `approval-${token}`, homologatedBy: `accountant-${token}`, now: new Date("2026-08-29T10:00:00.000Z") });
    assert.equal(activated.policy.status, "active");
    await assert.rejects(activatePosAccountingPolicy(first, { policyId: policy.id, accountantApprovalRef: `other-approval-${token}`, homologatedBy: `accountant-${token}` }), /outra homologação/);

    const request = {
      branchId: branch.id,
      costCenterId: costCenter.id,
      periodId: period.id,
      policyId: policy.id,
      occurredAt: new Date("2026-08-29T12:00:00.000Z"),
      currency: "BRL" as const,
      description: "Venda contabilizada em homologação",
      source: buildPosSaleAccountingSnapshot({ saleId, saleVersion: 1, competenceDate, status: "completed", subtotalCents: 1_000, discountCents: 0, surchargeCents: 0, totalCents: 1_000, paymentIds: [`payment-${token}`] }),
      postings: [{ mappingKey: "sale_receivable", amountCents: 1_000 }, { mappingKey: "gross_revenue", amountCents: 1_000 }],
      idempotencyKey: `accounting-journal-${token}`,
      createdBy: `accountant-${token}`,
    };
    const raced = await Promise.all([postPosAccountingJournal(first, request), postPosAccountingJournal(second, request)]);
    assert.equal(new Set(raced.map((item) => item.journal.id)).size, 1);
    assert.equal(await first.posAccountingJournal.count({ where: { originType: "sale", originId: request.source.sourceId, originVersion: 1 } }), 1);
    const journal = await first.posAccountingJournal.findUniqueOrThrow({ where: { id: raced[0]!.journal.id }, include: { postings: { orderBy: { sequence: "asc" } }, exportOutbox: true } });
    assert.equal(journal.totalDebitCents, BigInt(1_000));
    assert.equal(journal.totalCreditCents, BigInt(1_000));
    assert.equal(journal.exportOutbox?.state, "pending");

    await assert.rejects(first.posAccountingJournal.update({ where: { id: journal.id }, data: { description: "mutated" } }), /append-only/);
    await assert.rejects(first.posAccountingPosting.delete({ where: { id: journal.postings[0]!.id } }), /append-only/);
    await assert.rejects(first.posAccountingPosting.create({ data: { journalId: journal.id, sequence: 3, policyMappingId: debitMapping.id, accountId: debitAccount.id, accountCodeSnapshot: debitAccount.code, accountNameSnapshot: debitAccount.name, direction: "debit", amountCents: BigInt(1), amount: "0.01" } }), /journal transaction/);

    await assert.rejects(first.$transaction(async (tx) => {
      await tx.posAccountingJournal.create({ data: {
        id: `unbalanced-${token}`,
        branchId: branch.id,
        costCenterId: costCenter.id,
        periodId: period.id,
        policyId: policy.id,
        policyHash: activated.policy.mappingHash,
        originType: "sale",
        originId: `unbalanced-origin-${token}`,
        originVersion: 1,
        competenceDate: new Date(`${competenceDate}T00:00:00.000Z`),
        occurredAt: new Date("2026-08-29T12:01:00.000Z"),
        description: "Must rollback",
        sourceSnapshot: { schemaVersion: 1 },
        sourceSnapshotHash: "a".repeat(64),
        totalDebitCents: BigInt(100),
        totalCreditCents: BigInt(100),
        idempotencyKey: `unbalanced-journal-${token}`,
        requestHash: "b".repeat(64),
        createdBy: `accountant-${token}`,
        postings: { create: [
          { sequence: 1, policyMappingId: debitMapping.id, accountId: debitAccount.id, accountCodeSnapshot: debitAccount.code, accountNameSnapshot: debitAccount.name, direction: "debit", amountCents: BigInt(100), amount: "1.00" },
          { sequence: 2, policyMappingId: creditMapping.id, accountId: creditAccount.id, accountCodeSnapshot: creditAccount.code, accountNameSnapshot: creditAccount.name, direction: "credit", amountCents: BigInt(99), amount: "0.99" },
        ] },
        exportOutbox: { create: {} },
      } });
    }), /debits and credits must balance exactly/);
    assert.equal(await first.posAccountingJournal.count({ where: { id: `unbalanced-${token}` } }), 0);

    const reversed = await reversePosAccountingJournal(first, { originalJournalId: journal.id, periodId: period.id, competenceDate, occurredAt: new Date("2026-08-29T13:00:00.000Z"), reason: "Reversão de homologação", idempotencyKey: `accounting-reversal-${token}`, createdBy: `accountant-${token}` });
    assert.equal(reversed.journal.reversalOfId, journal.id);
    assert.deepEqual(reversed.journal.postings.map((item) => item.direction), ["credit", "debit"]);
    assert.equal((await reversePosAccountingJournal(first, { originalJournalId: journal.id, periodId: period.id, competenceDate, occurredAt: new Date("2026-08-29T13:00:00.000Z"), reason: "Reversão de homologação", idempotencyKey: `accounting-reversal-${token}`, createdBy: `accountant-${token}` })).replayed, true);

    await closePosAccountingPeriod(first, { periodId: period.id, closedBy: accountingActor, reason: "Fechamento homologado" });
    await assert.rejects(closePosAccountingPeriod(first, { periodId: period.id, closedBy: `other-accountant-${token}`, reason: "Outro fechamento" }), /outro conteúdo/);
    await assert.rejects(postPosAccountingJournal(first, { ...request, source: buildPosSaleAccountingSnapshot({ saleId: saleId + 1, saleVersion: 1, competenceDate, status: "completed", subtotalCents: 1_000, discountCents: 0, surchargeCents: 0, totalCents: 1_000, paymentIds: [`payment-2-${token}`] }), idempotencyKey: `accounting-journal-closed-${token}` }), /Período contábil aberto/);
  } finally {
    await Promise.all([first.$disconnect(), second.$disconnect()]);
  }
});

function client() {
  if (!connectionString) throw new Error("POS_TEST_DATABASE_URL não definida");
  return new PrismaClient({ adapter: new PrismaPg({ connectionString }) });
}
