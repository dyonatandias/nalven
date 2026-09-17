import assert from "node:assert/strict";
import test from "node:test";
import { DEFAULT_POS_RECONCILIATION_COLUMNS, DEFAULT_POS_RECONCILIATION_KINDS, hashPosReconciliationRequest, parsePosReconciliationAdminInput, reconciliationOperationKey } from "../lib/erp/pos-reconciliation-admin";
import { assertPosReconciliationJobAuthorization, parsePosReconciliationJobInput } from "../lib/erp/pos-reconciliation-http";
import { isPosReconciliationSerializationConflict } from "../lib/erp/pos-reconciliation-persistence";
import { parseConfiguredPosSettlementCsv, posReconciliationReferenceHash, type PosReconciliationLayoutConfig } from "../lib/erp/pos-reconciliation-layout";

const now = new Date("2026-08-29T12:00:00.000Z");
const layout: PosReconciliationLayoutConfig = {
  provider: "PSP-DEMO", delimiter: ";", amountMode: "decimal", decimalSeparator: ",", dateMode: "iso8601",
  columns: { settlementId: "liquidacao", transactionId: "transacao", kind: "tipo", grossCents: "bruto", feeCents: "taxa", netCents: "liquido", occurredAt: "ocorrido_em", settledAt: "liquidado_em" },
  kindMapping: { payment: ["venda"], refund: ["estorno"], chargeback: ["contestacao"] },
};

test("layout configurável normaliza provider, colunas, tipos e decimal sem ponto flutuante", () => {
  const csv = "liquidacao;transacao;tipo;bruto;taxa;liquido;ocorrido_em;liquidado_em\nSET-1;TX-1;VENDA;100,00;2,50;97,50;2026-08-28T10:00:00Z;2026-08-29T10:00:00Z\nSET-2;TX-2;estorno;10,00;0,10;-10,10;2026-08-28T11:00:00Z;2026-08-29T11:00:00Z\n";
  const parsed = parseConfiguredPosSettlementCsv(csv, layout, now);
  assert.match(parsed.digest, /^[0-9a-f]{64}$/);
  assert.deepEqual(parsed.entries.map(entry => ({ provider: entry.provider, kind: entry.kind, gross: entry.grossCents, fee: entry.feeCents, net: entry.netCents })), [
    { provider: "psp-demo", kind: "payment", gross: 10_000, fee: 250, net: 9_750 },
    { provider: "psp-demo", kind: "refund", gross: 1_000, fee: 10, net: -1_010 },
  ]);
  assert.equal(parsed.periodStart.toISOString(), "2026-08-28T10:00:00.000Z");
  assert.equal(parsed.periodEnd.toISOString(), "2026-08-28T11:00:00.000Z");
});

test("layout aceita epoch, cents e CSV quoted sem executar conteúdo de planilha", () => {
  const configured = { ...layout, delimiter: "," as const, amountMode: "integer_cents" as const, decimalSeparator: "." as const, dateMode: "epoch_millis" as const, columns: DEFAULT_POS_RECONCILIATION_COLUMNS, kindMapping: DEFAULT_POS_RECONCILIATION_KINDS };
  const parsed = parseConfiguredPosSettlementCsv("settlement_id,transaction_id,kind,gross_cents,fee_cents,net_cents,occurred_at,settled_at\n\"=FORMULA\",\"+TX\",payment,100,0,100,1787911200000,1787997600000\n", configured, now);
  assert.equal(parsed.entries[0].settlementId, "=FORMULA");
  assert.equal(parsed.entries[0].transactionId, "+TX");
  assert.notEqual(posReconciliationReferenceHash("psp-demo", "+TX"), "+TX");
  assert.match(posReconciliationReferenceHash("psp-demo", "+TX"), /^[0-9a-f]{64}$/);
});

test("layout recusa aliases/colunas duplicados, equação, datas e tamanho", () => {
  assert.throws(() => parseConfiguredPosSettlementCsv("a;b\n1;2\n", { ...layout, columns: { ...layout.columns, transactionId: "liquidacao" } }, now), /colunas.*distintas/i);
  assert.throws(() => parseConfiguredPosSettlementCsv("a;b\n1;2\n", { ...layout, kindMapping: { payment: ["x"], refund: ["x"], chargeback: ["z"] } }, now), /tipo.*distintos/i);
  assert.throws(() => parseConfiguredPosSettlementCsv("liquidacao;transacao;tipo;bruto;taxa;liquido;ocorrido_em;liquidado_em\nS;T;venda;1,00;0,10;1,00;2026-08-28T10:00:00Z;2026-08-29T10:00:00Z\n", layout, now), /Equação/);
  assert.throws(() => parseConfiguredPosSettlementCsv("x".repeat(768 * 1024 + 1), layout, now), /768 KiB/);
});

test("payload administrativo é allowlist estrita, tipado e sem coerção", () => {
  const base = { action: "layout.create", branchId: 7, provider: "psp-demo", name: "Layout demo", delimiter: ",", amountMode: "integer_cents", decimalSeparator: ".", dateMode: "iso8601", columns: DEFAULT_POS_RECONCILIATION_COLUMNS, kindMapping: DEFAULT_POS_RECONCILIATION_KINDS, matchWindowHours: 24, idempotencyKey: "12345678-1234-1234-1234-123456789012" };
  assert.equal(parsePosReconciliationAdminInput(base).action, "layout.create");
  assert.throws(() => parsePosReconciliationAdminInput({ ...base, branchId: "7" }), /Filial/);
  assert.throws(() => parsePosReconciliationAdminInput({ ...base, unexpected: true }), /não permitido/);
  assert.throws(() => parsePosReconciliationAdminInput({ action: "batch.import", branchId: 7, layoutId: "layout_1", csv: "x".repeat(768 * 1024 + 1), idempotencyKey: base.idempotencyKey }), /768 KiB/);
  assert.throws(() => parsePosReconciliationAdminInput({ action: "batch.reprocess", batchId: "batch_1", expectedVersion: "0", idempotencyKey: base.idempotencyKey }), /Versão/);
});

test("hash e chave de operação são determinísticos e não carregam payload aberto", () => {
  assert.equal(hashPosReconciliationRequest({ b: 2, a: 1 }), hashPosReconciliationRequest({ a: 1, b: 2 }));
  const key = reconciliationOperationKey("import", "12345678-1234-1234-1234-123456789012");
  assert.match(key, /^reconciliation:import:[0-9a-f]{48}$/);
  assert.doesNotMatch(key, /12345678/);
});

test("job valida bearer forte, allowlist, cursores e limites sem coerção", () => {
  const token = "a".repeat(64), request = new Request("https://nalven.test/api/internal", { headers: { authorization: `Bearer ${token}` } });
  assert.doesNotThrow(() => assertPosReconciliationJobAuthorization(request, token));
  assert.throws(() => assertPosReconciliationJobAuthorization(new Request("https://nalven.test/api/internal", { headers: { authorization: `Bearer ${"b".repeat(64)}` } }), token), /autorizado/i);
  assert.deepEqual(parsePosReconciliationJobInput({ action: "reconciliation.process" }), { action: "reconciliation.process", organizationLimit: 20, batchLimit: 10, afterOrganizationId: null });
  assert.throws(() => parsePosReconciliationJobInput({ action: "reconciliation.process", batchLimit: "10" }), /Limite de lotes/);
  assert.throws(() => parsePosReconciliationJobInput({ action: "reconciliation.process", extra: 1 }), /não permitido/);
});

test("classifica P2034, 40001 e deadlock como conflitos retryable", () => {
  assert.equal(isPosReconciliationSerializationConflict({ code: "P2034" }), true);
  assert.equal(isPosReconciliationSerializationConflict({ meta: { code: "40001" } }), true);
  assert.equal(isPosReconciliationSerializationConflict({ cause: { code: "40P01" } }), true);
  assert.equal(isPosReconciliationSerializationConflict({ code: "P2010", meta: { driverAdapterError: { cause: { originalCode: "40001" } } } }), true);
  assert.equal(isPosReconciliationSerializationConflict({ code: "P2010", message: "Raw query failed. Code: `40P01`." }), true);
  assert.equal(isPosReconciliationSerializationConflict({ code: "P2002" }), false);
});
