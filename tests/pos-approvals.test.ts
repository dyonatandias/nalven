import assert from "node:assert/strict";
import test from "node:test";
import {
  assertApprovalReplay,
  effectivePosApprovalStatus,
  normalizePosApprovalDecision,
  normalizePosApprovalRequest,
} from "../lib/erp/pos-approvals";
import { PosDomainError } from "../lib/erp/pos-domain";
import { normalizePosApprovalStepUpInput, posApprovalStepUpTargetKey } from "../lib/erp/pos-approval-step-up";
import { assertPosDiscountApprovalContext, buildPosDiscountApproval, normalizePosDiscountApprovalContext } from "../lib/erp/pos-discount-approval";

const scope = { branchId: 7, requesterId: "user-1", now: new Date("2026-08-28T12:00:00.000Z") };

test("normaliza pedido com escopo, expiração e hash determinístico", () => {
  const input = {
    approvalAction: "sale.cancel",
    entityId: "42",
    reason: "Cliente solicitou o cancelamento integral.",
    context: { sessionId: 9 },
    idempotencyKey: "cancel:42:intent-1",
    expiryMinutes: 15,
  };
  const first = normalizePosApprovalRequest(input, scope);
  const replay = normalizePosApprovalRequest(input, { ...scope, now: new Date("2026-08-28T12:01:00.000Z") });
  assert.equal(first.entityType, "sale");
  assert.equal(first.expiresAt.toISOString(), "2026-08-28T12:15:00.000Z");
  assert.equal(first.requestHash, replay.requestHash);
});

test("hash muda quando o conteúdo muda e replay conflitante falha", () => {
  const base = {
    approvalAction: "cash.withdrawal",
    entityId: "9",
    reason: "Sangria extraordinária para reduzir numerário.",
    context: { amountCents: 20_000 },
    idempotencyKey: "withdrawal:9:1",
  };
  const first = normalizePosApprovalRequest(base, scope);
  const changed = normalizePosApprovalRequest({ ...base, context: { amountCents: 30_000 } }, scope);
  assert.notEqual(first.requestHash, changed.requestHash);
  assert.doesNotThrow(() => assertApprovalReplay(first.requestHash, first.requestHash));
  assert.throws(() => assertApprovalReplay(first.requestHash, changed.requestHash), /outro pedido/);
});

test("ações vinculadas exigem entidade e limites de expiração", () => {
  const base = {
    approvalAction: "return.create",
    reason: "Produto devolvido com embalagem preservada.",
    idempotencyKey: "return:intent-1",
  };
  assert.throws(() => normalizePosApprovalRequest(base, scope), /identificação/);
  assert.throws(() => normalizePosApprovalRequest({ ...base, entityId: "1", expiryMinutes: 61 }, scope), /Validade/);
  assert.throws(() => normalizePosApprovalRequest({ ...base, entityId: "1", idempotencyKey: "inválida com espaços" }, scope), /idempotência/);
});

test("contexto rejeita material sensível e estruturas abusivas", () => {
  const base = {
    approvalAction: "discount.override",
    entityId: "sale-draft-1234",
    reason: "Desconto comercial autorizado para negociação.",
    idempotencyKey: "discount:intent-1",
  };
  assert.throws(() => normalizePosApprovalRequest({ ...base, context: { cardNumber: "4111111111111111" } }, scope), /sensível/);
  assert.throws(() => normalizePosApprovalRequest({ ...base, context: { nested: { authorizationToken: "x" } } }, scope), /sensível/);
  assert.throws(() => normalizePosApprovalRequest({ ...base, context: { note: "x".repeat(1001) } }, scope), /texto muito longo/);
});

test("desconto excepcional soma linha e venda, usa a menor alçada e ignora promoção", () => {
  const exactLimit = buildPosDiscountApproval({
    saleDraftId: "sale-draft-1234",
    sessionId: 9,
    grossCents: 10_000,
    orderDiscountCents: 500,
    lineDiscountCents: 500,
    settingsMaximumPercent: 20,
    accessMaximumBasisPoints: 1_000,
  });
  assert.equal(exactLimit.context.manualDiscountCents, 1_000);
  assert.equal(exactLimit.context.basisPoints, 1_000);
  assert.equal(exactLimit.maximumPercent, 10);
  assert.equal(exactLimit.requiresApproval, false);

  const overLimit = buildPosDiscountApproval({
    saleDraftId: "sale-draft-1234",
    sessionId: 9,
    grossCents: 10_000,
    orderDiscountCents: 501,
    lineDiscountCents: 500,
    settingsMaximumPercent: 10,
    accessMaximumBasisPoints: 2_000,
  });
  assert.equal(overLimit.context.manualDiscountCents, 1_001);
  assert.equal(overLimit.requiresApproval, true);
  assert.equal(Object.hasOwn(overLimit.context, "promotionDiscountCents"), false, "promoção não integra a alçada manual");
});

test("contexto de desconto exige rascunho e valores numéricos exatamente correspondentes", () => {
  const context = { saleDraftId: "sale-draft-1234", sessionId: 9, grossCents: 10_000, manualDiscountCents: 1_001, basisPoints: 1_001 };
  assert.deepEqual(normalizePosDiscountApprovalContext(context, context.saleDraftId), context);
  assert.doesNotThrow(() => assertPosDiscountApprovalContext(context, context));
  for (const changed of [
    { ...context, sessionId: 10 },
    { ...context, grossCents: 10_001 },
    { ...context, manualDiscountCents: 1_002, basisPoints: 1_002 },
    { ...context, saleDraftId: "sale-draft-5678" },
  ]) assert.throws(() => assertPosDiscountApprovalContext(changed, context), /não corresponde/);
  assert.throws(() => normalizePosDiscountApprovalContext({ ...context, customerId: 7 }, context.saleDraftId), /somente os valores/);
  assert.throws(() => normalizePosDiscountApprovalContext({ ...context, basisPoints: 999 }, context.saleDraftId), /Percentual/);
});

test("pedido de desconto vincula obrigatoriamente entity sale_draft ao contexto exato", () => {
  const input = {
    approvalAction: "discount.override",
    entityId: "sale-draft-1234",
    reason: "Exceção comercial negociada com o cliente.",
    idempotencyKey: "discount:sale-draft-1234",
    context: { saleDraftId: "sale-draft-1234", sessionId: 9, grossCents: 10_000, manualDiscountCents: 1_001, basisPoints: 1_001 },
  };
  const normalized = normalizePosApprovalRequest(input, scope);
  assert.equal(normalized.entityType, "sale_draft");
  assert.equal(normalized.entityId, input.entityId);
  assert.throws(() => normalizePosApprovalRequest({ ...input, entityId: undefined }, scope), /identificação/);
  assert.throws(() => normalizePosApprovalRequest({ ...input, entityId: "sale-draft-other" }, scope), /não corresponde/);
  assert.notEqual(normalized.requestHash, normalizePosApprovalRequest({ ...input, context: { ...input.context, manualDiscountCents: 1_002, basisPoints: 1_002 } }, scope).requestHash);
});

test("decisão exige estado conhecido e motivo ao rejeitar", () => {
  assert.deepEqual(normalizePosApprovalDecision({ decision: "approved" }), { decision: "approved", decisionReason: null });
  assert.throws(() => normalizePosApprovalDecision({ decision: "rejected" }), /motivo/);
  assert.deepEqual(normalizePosApprovalDecision({ decision: "rejected", decisionReason: "Sem evidência suficiente" }), {
    decision: "rejected",
    decisionReason: "Sem evidência suficiente",
  });
  assert.throws(() => normalizePosApprovalDecision({ decision: "pending" }), PosDomainError);
});

test("status pendente expira sem reabrir decisões finais", () => {
  const now = new Date("2026-08-28T12:00:00.000Z");
  assert.equal(effectivePosApprovalStatus("pending", new Date("2026-08-28T11:59:59.000Z"), now), "expired");
  assert.equal(effectivePosApprovalStatus("pending", new Date("2026-08-28T12:00:01.000Z"), now), "pending");
  assert.equal(effectivePosApprovalStatus("approved", new Date("2026-08-28T11:00:00.000Z"), now), "approved");
});

test("step-up exige payload fechado e credencial limitada sem incorporá-la à chave de taxa", () => {
  const input = normalizePosApprovalStepUpInput({
    action: "approval.step-up.decide",
    approvalId: "approval-123",
    email: " SUPERVISOR@EXAMPLE.COM ",
    password: "credencial forte",
    decision: "approved",
  });
  assert.equal(input.email, "supervisor@example.com");
  assert.equal(input.decisionReason, null);
  assert.match(posApprovalStepUpTargetKey(input.email), /^supervisor:[0-9a-f]{32}$/);
  assert.doesNotMatch(posApprovalStepUpTargetKey(input.email), /supervisor@example/);
  assert.throws(() => normalizePosApprovalStepUpInput({ ...input, password: "" }), /Credencial/);
  assert.throws(() => normalizePosApprovalStepUpInput({ ...input, password: "x".repeat(513) }), /Credencial/);
  assert.throws(() => normalizePosApprovalStepUpInput({ ...input, unexpected: true }), /não permitido/);
  assert.throws(() => normalizePosApprovalStepUpInput({ ...input, decision: "rejected", decisionReason: "" }), /motivo/);
});
