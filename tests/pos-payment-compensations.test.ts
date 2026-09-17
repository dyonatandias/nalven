import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import test from "node:test";
import {
  assertPosPaymentCompensationStateTuple,
  assertPosPaymentCompensationTransition,
  hashPosPaymentCompensationPayload,
  parsePosPaymentCompensationObservation,
  parsePosPaymentCompensationRequest,
} from "../lib/erp/pos-payment-compensations";

const projectRoot = fileURLToPath(new URL("..", import.meta.url));

test("pedido compensatório exige terminal, aprovação, delta e idempotência estritos", () => {
  const parsed = parsePosPaymentCompensationRequest({
    action: "compensation.request",
    sessionId: 7,
    terminalId: "terminal-7",
    originalPaymentId: "payment-7",
    returnId: "return-7",
    approvalId: "approval-7",
    kind: "refund",
    amountCents: 1_250,
    currency: "BRL",
    idempotencyKey: "refund-request-0007",
  });
  assert.deepEqual(parsed, {
    action: "compensation.request",
    sessionId: 7,
    terminalId: "terminal-7",
    originalPaymentId: "payment-7",
    returnId: "return-7",
    approvalId: "approval-7",
    kind: "refund",
    amountCents: 1_250,
    currency: "BRL",
    idempotencyKey: "refund-request-0007",
  });
  assert.throws(() => parsePosPaymentCompensationRequest({ ...parsed, amountCents: 0 }), /Valor inválido/);
  assert.throws(() => parsePosPaymentCompensationRequest({ ...parsed, terminalId: "" }), /Terminal inválido/);
  assert.throws(() => parsePosPaymentCompensationRequest({ ...parsed, approvalId: "" }), /Aprovação inválido/);
  assert.throws(() => parsePosPaymentCompensationRequest({ ...parsed, pan: "4111111111111111" }), /sensível proibido/);
  assert.throws(() => parsePosPaymentCompensationRequest({ ...parsed, unexpected: true }), /não permitido/);
});

test("resultado do provedor carrega referências próprias e recusa sucesso com valor divergente", () => {
  const body = {
    compensationId: "compensation-1",
    provider: "Stone",
    originalReference: "original-psp-reference",
    operationReference: "refund-psp-reference",
    state: "succeeded",
    requestedAmountCents: 500,
    confirmedAmountCents: 500,
    currency: "BRL",
    sequence: 2,
    occurredAt: "2026-08-29T12:00:00.000Z",
    evidenceHash: "a".repeat(64),
    failureCode: null,
    failureMessage: null,
  };
  const parsed = parsePosPaymentCompensationObservation(body);
  assert.equal(parsed.provider, "stone");
  assert.equal(parsed.providerSequence, BigInt(2));
  assert.equal(parsed.providerOperationReference, "refund-psp-reference");
  assert.throws(() => parsePosPaymentCompensationObservation({ ...body, confirmedAmountCents: 499 }), /valor diferente/);
  assert.throws(() => parsePosPaymentCompensationObservation({ ...body, evidenceHash: "raw-provider-payload" }), /Hash de evidência/);
});

test("máquina de estados separa confirmação externa da aplicação local", () => {
  assert.equal(assertPosPaymentCompensationTransition("processing", "unknown"), "unknown");
  assert.equal(assertPosPaymentCompensationTransition("unknown", "provider_succeeded"), "provider_succeeded");
  assert.equal(assertPosPaymentCompensationTransition("provider_succeeded", "application_pending"), "application_pending");
  assert.equal(assertPosPaymentCompensationTransition("application_pending", "applied"), "applied");
  assert.throws(() => assertPosPaymentCompensationTransition("unknown", "applied"), /Transição compensatória inválida/);
  assert.throws(() => assertPosPaymentCompensationTransition("applied", "processing"), /Transição compensatória inválida/);
  assert.doesNotThrow(() => assertPosPaymentCompensationStateTuple({ status: "applied", providerState: "succeeded", applicationState: "applied" }));
  assert.throws(() => assertPosPaymentCompensationStateTuple({ status: "applied", providerState: "unknown", applicationState: "applied" }), /sucesso imutável/);
  assert.throws(() => assertPosPaymentCompensationStateTuple({ status: "processing", providerState: "processing", applicationState: "applying" }), /só pode começar/);
});

test("hash compensatório é canônico e sensível ao delta financeiro", () => {
  assert.equal(hashPosPaymentCompensationPayload({ b: 2, a: 1 }), hashPosPaymentCompensationPayload({ a: 1, b: 2 }));
  assert.notEqual(hashPosPaymentCompensationPayload({ amountCents: 500 }), hashPosPaymentCompensationPayload({ amountCents: 501 }));
});

test("migration cria agregado/outbox próprios e invariantes anti-overrefund", () => {
  const schema = readFileSync(`${projectRoot}/prisma/tenant/schema.prisma`, "utf8");
  const migration = readFileSync(`${projectRoot}/prisma/tenant/migrations/20260829260000_pos_payment_compensations/migration.sql`, "utf8");
  for (const model of [
    "PosPaymentCompensation",
    "PosPaymentCompensationAttempt",
    "PosPaymentCompensationOutbox",
    "PosPaymentCompensationCallback",
    "PosPaymentCompensationStateEvent",
    "PosPaymentCompensationDeliveryResult",
    "PosPaymentCompensationIncident",
  ]) assert.match(schema, new RegExp(`model ${model}\\s`));
  for (const token of [
    "pos_payment_compensations",
    "pos_payment_compensation_attempts",
    "pos_payment_compensation_outbox",
    "pos_payment_compensation_callbacks",
    "pos_payment_compensation_state_events",
    "pos_payment_compensation_delivery_results",
    "pos_payment_compensation_incidents",
    "payment compensation exceeds the original payment",
    "electronic refund requires a persisted compensation",
    "applied compensation requires exactly one matching refund",
    "refund total exceeds the original payment",
    "payment compensation requires an exact independent approval",
  ]) assert.match(migration, new RegExp(token));
  assert.match(migration, /provider_result_persisted_at/);
  assert.match(migration, /application_state/);
  assert.match(migration, /DEFERRABLE INITIALLY DEFERRED/);
});
