import assert from "node:assert/strict";
import test from "node:test";
import {
  buildPosAccountingSourceSnapshot,
  buildPosCashAccountingSnapshot,
  buildPosFiscalTaxAccountingSnapshot,
  buildPosInventoryCogsAccountingSnapshot,
  buildPosMdrAccountingSnapshot,
  buildPosRefundAccountingSnapshot,
  buildPosSaleAccountingSnapshot,
  buildPosValueAccountAccountingSnapshot,
  closePosAccountingPeriod,
  hashPosAccountingPolicyMappings,
  hashPosAccountingPayload,
  postPosAccountingJournal,
  PosAccountingError,
  reversePosAccountingJournal,
} from "../lib/erp/pos-accounting-subledger";

test("snapshot contábil é canônico, versionado e não contém decisão de conta", () => {
  const snapshot = buildPosSaleAccountingSnapshot({
    saleId: 42,
    saleVersion: 3,
    competenceDate: "2026-08-29",
    status: "completed",
    subtotalCents: 1_200,
    discountCents: 200,
    surchargeCents: 0,
    totalCents: 1_000,
    paymentIds: ["payment-42"],
  });
  assert.equal(snapshot.sourceType, "sale");
  assert.equal(snapshot.sourceId, "42");
  assert.equal(snapshot.sourceVersion, 3);
  assert.equal(snapshot.factsHash, hashPosAccountingPayload(snapshot.facts));
  assert.doesNotMatch(JSON.stringify(snapshot), /accountCode|accountId|debit|credit/);
  assert.equal(hashPosAccountingPayload({ b: 2, a: 1 }), hashPosAccountingPayload({ a: 1, b: 2 }));
});

test("builders cobrem todas as origens sem inferir mappings contábeis", () => {
  const snapshots = [
    buildPosRefundAccountingSnapshot({ compensationId: "compensation-1", compensationVersion: 2, competenceDate: "2026-08-29", saleId: 1, originalPaymentId: "payment-1", refundPaymentId: "refund-1", amountCents: 500, evidenceHash: "a".repeat(64) }),
    buildPosCashAccountingSnapshot({ ledgerEntryId: "cash-ledger-1", ledgerVersion: 1, competenceDate: "2026-08-29", branchId: 1, registerId: 2, sessionId: 3, entryType: "sale", deltaCents: 500 }),
    buildPosInventoryCogsAccountingSnapshot({ sourceId: "warehouse-ledger-1", sourceVersion: 1, competenceDate: "2026-08-29", saleId: 1, warehouseLedgerEntryIds: ["warehouse-ledger-1"], costCents: 250, quantityMicros: "1000000" }),
    buildPosFiscalTaxAccountingSnapshot({ fiscalDocumentId: "fiscal-document-1", fiscalVersion: 4, competenceDate: "2026-08-29", saleId: 1, documentStatus: "authorized", totalCents: 500, taxFacts: { icmsCents: 25 } }),
    buildPosMdrAccountingSnapshot({ reconciliationLineId: "reconciliation-line-1", reconciliationVersion: 1, competenceDate: "2026-08-29", paymentId: "payment-1", grossCents: 500, feeCents: 10, netCents: 490, provider: "stone" }),
    buildPosValueAccountAccountingSnapshot({ ledgerEntryId: "value-ledger-1", ledgerVersion: 1, competenceDate: "2026-08-29", valueAccountId: "value-account-1", kind: "gift_card", deltaUnits: -500, monetaryValueCents: 500 }),
  ];
  assert.deepEqual(snapshots.map((item) => item.sourceType), ["refund_compensation", "cash_ledger", "inventory_cogs", "fiscal_tax", "mdr", "value_account"]);
  for (const snapshot of snapshots) assert.doesNotMatch(JSON.stringify(snapshot), /accountCode|accountingAccount|direction/);
});

test("snapshot e dimensions rejeitam PII, PCI e JSON não finito", () => {
  assert.doesNotThrow(() => buildPosAccountingSourceSnapshot({ sourceType: "sale", sourceId: "63ef462b-4712-4677-8206-96916b47fb73", sourceVersion: 1, competenceDate: "2026-08-29", facts: { paymentIds: ["63ef462b-4712-4677-8206-96916b47fb73"] } }));
  assert.throws(() => buildPosAccountingSourceSnapshot({ sourceType: "sale", sourceId: "sale-1", sourceVersion: 1, competenceDate: "2026-08-29", facts: { customerName: "Maria" } }), /PII/);
  assert.throws(() => buildPosAccountingSourceSnapshot({ sourceType: "sale", sourceId: "sale-1", sourceVersion: 1, competenceDate: "2026-08-29", facts: { contact: "maria@example.com" } }), /PII/);
  assert.throws(() => buildPosAccountingSourceSnapshot({ sourceType: "sale", sourceId: "sale-1", sourceVersion: 1, competenceDate: "2026-08-29", facts: { paymentReference: "AUTH4111111111111111X" } }), /cartão/);
  assert.throws(() => buildPosAccountingSourceSnapshot({ sourceType: "sale", sourceId: "sale-1", sourceVersion: 1, competenceDate: "2026-08-29", facts: { total: Number.NaN } }), /JSON finito/);
  assert.throws(() => buildPosAccountingSourceSnapshot({ sourceType: "sale", sourceId: "sale-1", sourceVersion: 1, competenceDate: "2026-08-29", facts: { missing: undefined } }), /JSON finito/);
  assert.throws(() => buildPosAccountingSourceSnapshot({ sourceType: "sale", sourceId: "sale-1", sourceVersion: 1, competenceDate: "2026-02-30", facts: {} }), (error: unknown) => error instanceof PosAccountingError && error.status === 400);
});

test("descrições, motivos e atores rejeitam PII antes de acessar o banco", async () => {
  const source = buildPosSaleAccountingSnapshot({ saleId: 43, saleVersion: 1, competenceDate: "2026-08-29", status: "completed", subtotalCents: 100, discountCents: 0, surchargeCents: 0, totalCents: 100, paymentIds: ["payment-43"] });
  const request = {
    branchId: 1,
    costCenterId: 1,
    periodId: "period-2026-08",
    policyId: "policy-2026-08",
    occurredAt: new Date("2026-08-29T12:00:00.000Z"),
    currency: "BRL" as const,
    description: "Venda contabilizada",
    source,
    postings: [{ mappingKey: "sale_receivable", amountCents: 100 }, { mappingKey: "gross_revenue", amountCents: 100 }],
    idempotencyKey: "accounting-journal-43",
    createdBy: "actor-43",
  };
  await assert.rejects(postPosAccountingJournal({} as never, { ...request, description: "Contato maria@example.com" }), /PII/);
  await assert.rejects(postPosAccountingJournal({} as never, { ...request, postings: [{ ...request.postings[0]!, description: "CPF: 529.982.247-25" }, request.postings[1]!] }), /PII/);
  await assert.rejects(postPosAccountingJournal({} as never, { ...request, createdBy: "529.982.247-25" }), /PII/);
  await assert.rejects(reversePosAccountingJournal({} as never, { originalJournalId: "journal-43", periodId: "period-2026-08", competenceDate: "2026-08-29", occurredAt: new Date("2026-08-29T13:00:00.000Z"), reason: "Telefone: (11) 99999-1234", idempotencyKey: "accounting-reversal-43", createdBy: "actor-43" }), /PII/);
  await assert.rejects(closePosAccountingPeriod({} as never, { periodId: "period-2026-08", closedBy: "actor-43", reason: "Cliente: Maria" }), /PII/);
});

test("hash da política é independente de ordem e muda com conta/direção", () => {
  const mappings = [
    { id: "mapping-credit", sourceType: "sale", entryKey: "gross_revenue", accountId: "revenue", direction: "credit" },
    { id: "mapping-debit", sourceType: "sale", entryKey: "cash_receivable", accountId: "cash", direction: "debit" },
  ];
  assert.equal(hashPosAccountingPolicyMappings(mappings), hashPosAccountingPolicyMappings([...mappings].reverse()));
  assert.notEqual(hashPosAccountingPolicyMappings(mappings), hashPosAccountingPolicyMappings([{ ...mappings[0], direction: "debit" }, mappings[1]]));
});
