import assert from "node:assert/strict";
import test from "node:test";
import {
  assertPosManualPaymentApprovalContext,
  hashPosManualPaymentReference,
  normalizePosManualPaymentApprovalContext,
  normalizePosManualPaymentRequest,
  posManualPaymentApprovalContext,
} from "../lib/erp/pos-manual-payment";

const now = new Date("2026-08-29T12:00:00.000Z");
const base = {
  sessionId: 10,
  saleDraftId: "sale-draft-0001",
  quoteHash: "a".repeat(64),
  paymentIndex: 0,
  method: "credit",
  amountCents: 12_345,
  installments: 3,
  provider: " Cielo ",
  reference: "AUTH-ABC-123",
  occurredAt: "2026-08-29T11:59:00.000Z",
  reason: "Terminal externo confirmou no comprovante",
  idempotencyKey: "manual-ref-0001",
};
const scope = { id: "manual-reference-1", branchId: 2, registerId: 3, requesterUserId: "user-1", now };

test("normaliza instituição e deduplica referência sem distinguir caixa", () => {
  const upper = normalizePosManualPaymentRequest(base, scope);
  const lower = normalizePosManualPaymentRequest({ ...base, provider: "cielo" }, scope);
  assert.equal(upper.provider, "cielo");
  assert.equal(upper.referenceHash, lower.referenceHash);
  assert.equal(upper.installments, 3);
  assert.equal(upper.requestHash, lower.requestHash);
  assert.equal(hashPosManualPaymentReference("credit", "cielo", upper.reference), upper.referenceHash);
});

test("Pix exige EndToEndId e cartão nunca aceita PAN como referência", () => {
  const pix = normalizePosManualPaymentRequest({ ...base, method: "pix", installments: 1, reference: "E1234567820260829ABCDEFGHIJKLMNO" }, scope);
  assert.equal(pix.reference, "E1234567820260829ABCDEFGHIJKLMNO");
  assert.throws(() => normalizePosManualPaymentRequest({ ...base, method: "pix", installments: 1, reference: "PIX-qualquer" }, scope), /EndToEndId/);
  assert.throws(() => normalizePosManualPaymentRequest({ ...base, saleDraftId: "AUTH4111111111111111" }, scope), /número de cartão/);
  assert.throws(() => normalizePosManualPaymentRequest({ ...base, idempotencyKey: "AUTH４１１１１１１１１１１１１１１１" }, scope), /número de cartão/);
  assert.throws(() => normalizePosManualPaymentRequest({ ...base, reason: "Comprovante AUTH4111111111111111" }, scope), /número de cartão/);
  assert.throws(() => normalizePosManualPaymentRequest({ ...base, reference: "4111111111111111" }, scope), /Número de cartão/);
  assert.throws(() => normalizePosManualPaymentRequest({ ...base, reference: "4111-1111-1111-1111" }, scope), /Número de cartão/);
  assert.throws(() => normalizePosManualPaymentRequest({ ...base, method: "debit", installments: 1, reference: "4111.1111.1111.1111" }, scope), /Número de cartão/);
  assert.throws(() => normalizePosManualPaymentRequest({ ...base, reference: "PAN:4111-1111-1111-1111" }, scope), /Número de cartão/);
  assert.throws(() => normalizePosManualPaymentRequest({ ...base, reference: "AUTH4111111111111111" }, scope), /Número de cartão/);
  assert.throws(() => normalizePosManualPaymentRequest({ ...base, method: "debit", installments: 3 }, scope), /Somente crédito/);
});

test("contexto vincula cotação, divisão, valor e referência exatamente", () => {
  const normalized = normalizePosManualPaymentRequest(base, scope);
  const context = posManualPaymentApprovalContext(normalized, scope.registerId);
  assert.deepEqual(normalizePosManualPaymentApprovalContext(context, normalized.saleDraftId), context);
  assert.deepEqual(assertPosManualPaymentApprovalContext(context, context), context);
  assert.throws(() => assertPosManualPaymentApprovalContext({ ...context, amountCents: context.amountCents + 1 }, context), /não corresponde/);
  assert.throws(() => assertPosManualPaymentApprovalContext({ ...context, installments: 2 }, context), /não corresponde/);
  assert.throws(() => assertPosManualPaymentApprovalContext({ ...context, quoteHash: "b".repeat(64) }, context), /não corresponde/);
  assert.throws(() => normalizePosManualPaymentApprovalContext({ ...context, authorizationCode: "secret" }, normalized.saleDraftId), /campos não permitidos/);
});

test("janela temporal e idempotência são fail-closed", () => {
  assert.throws(() => normalizePosManualPaymentRequest({ ...base, occurredAt: "2026-08-28T11:00:00.000Z" }, scope), /últimas 24 horas/);
  assert.throws(() => normalizePosManualPaymentRequest({ ...base, idempotencyKey: "com espaço" }, scope), /idempotência/);
});
