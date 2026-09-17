import assert from "node:assert/strict";
import { createHash, createHmac } from "node:crypto";
import test from "node:test";
import {
  assertPosPaymentMethodEvidence,
  assertPosPaymentTransition,
  parsePosPaymentCallbackPayload,
  parsePosPaymentIntentCommand,
  parsePosPaymentOutboxCompletion,
} from "../lib/erp/pos-payment-persistence";
import {
  assertPosPaymentJobAuthorization,
  parsePosPaymentOutboxClaim,
  verifyAndParsePosPaymentCallback,
} from "../lib/erp/pos-payment-http";

test("intent vincula rascunho, divisão e valor e rejeita dados PCI", () => {
  const command = parsePosPaymentIntentCommand({
    action: "intent.create",
    sessionId: 7,
    paymentPlanId: "payment-plan-0000001",
    paymentIndex: 1,
    idempotencyKey: "payment-create-0000001",
  });
  assert.equal(command.action, "intent.create");
  assert.equal(command.paymentIndex, 1);
  assert.equal(command.paymentPlanId, "payment-plan-0000001");
  assert.throws(() => parsePosPaymentIntentCommand({ ...command, cardNumber: "4111111111111111" }), /sensíveis/);
  assert.throws(() => parsePosPaymentIntentCommand({ ...command, amountCents: 12_345 }), /Campo não permitido/);
  assert.throws(() => parsePosPaymentIntentCommand({ ...command, idempotencyKey: "AUTH４１１１１１１１１１１１１１１１" }), /dados de cartão/);
  assert.throws(() => parsePosPaymentIntentCommand({ ...command, paymentIndex: 10 }), /Índice/);
});

test("máquina de estados é monotônica e unknown pode convergir para captura", () => {
  assert.equal(assertPosPaymentTransition("created", "unknown"), "unknown");
  assert.equal(assertPosPaymentTransition("unknown", "captured"), "captured");
  assert.equal(assertPosPaymentTransition("captured", "refunded"), "refunded");
  assert.throws(() => assertPosPaymentTransition("captured", "processing"), /Transição/);
  assert.throws(() => assertPosPaymentTransition("declined", "captured"), /Transição/);
});

test("evidência confirmada respeita o método e falha fechada", () => {
  const empty = { transactionId: null, endToEndId: null, nsu: null, authorizationCode: null, cardBrand: null, cardLastFour: null };
  assert.throws(() => assertPosPaymentMethodEvidence("pix", "captured", empty), /EndToEndId/);
  assert.doesNotThrow(() => assertPosPaymentMethodEvidence("pix", "captured", { ...empty, transactionId: "provider-transaction", endToEndId: "E1234567820260829ABCDEFGHIJKLMNO" }));
  assert.throws(() => assertPosPaymentMethodEvidence("pix", "captured", { ...empty, endToEndId: "E1234567820260829ABCDEFGHIJKLMNO", cardLastFour: "4242" }), /exclusivos de cartão/);
  assert.throws(() => assertPosPaymentMethodEvidence("credit", "captured", empty), /evidência obrigatória/);
  assert.doesNotThrow(() => assertPosPaymentMethodEvidence("credit", "captured", { ...empty, transactionId: "transaction-123", authorizationCode: "AUTH123", cardLastFour: "4242" }));
  assert.throws(() => assertPosPaymentMethodEvidence("credit", "captured", { ...empty, transactionId: "transaction-123", authorizationCode: "AUTH123", cardLastFour: "4242", endToEndId: "E1234567820260829ABCDEFGHIJKLMNO" }), /evidência Pix/);
});

test("callback exige contexto financeiro e evidência temporal estritos", () => {
  const now = new Date();
  const raw = {
    intentId: "intent-0000000001",
    reference: "provider-reference-1",
    state: "captured",
    amountCents: 500,
    currency: "BRL",
    sequence: 4,
    occurredAt: now.toISOString(),
    lastFour: "4242",
  };
  const parsed = parsePosPaymentCallbackPayload(raw);
  assert.equal(parsed.providerReference, "provider-reference-1");
  assert.equal(parsed.providerSequence, BigInt(4));
  assert.equal(parsed.cardLastFour, "4242");
  assert.equal(parsePosPaymentCallbackPayload({ ...raw, currency: "USD" }).currency, "USD");
  assert.throws(() => parsePosPaymentCallbackPayload({ ...raw, currency: "brl" }), /Moeda/);
  assert.throws(() => parsePosPaymentCallbackPayload({ ...raw, sequence: 0 }), /Sequência/);
  assert.throws(() => parsePosPaymentCallbackPayload({ ...raw, lastFour: "1111111111111111" }), /Últimos quatro/);
  assert.throws(() => parsePosPaymentCallbackPayload({ ...raw, reference: "ref-4111 1111 1111 1111-approved" }), /sensíveis/);
  assert.throws(() => parsePosPaymentCallbackPayload({ ...raw, reference: "ref-4111.1111.1111.1111-approved" }), /sensíveis/);
  assert.throws(() => parsePosPaymentCallbackPayload({ ...raw, reference: "ref-4111/1111/1111/1111-approved" }), /sensíveis/);
  assert.throws(() => parsePosPaymentCallbackPayload({ ...raw, reference: "ref-4111\u00a01111\u00a01111\u00a01111-approved" }), /sensíveis/);
  assert.throws(() => parsePosPaymentCallbackPayload({ ...raw, reference: "AUTH4111111111111111" }), /sensíveis/);
  assert.throws(() => parsePosPaymentCallbackPayload({ ...raw, transactionId: "4111-1111-1111-1111" }), /sensíveis/);
  assert.throws(() => parsePosPaymentCallbackPayload({ ...raw, transactionId: "X4111111111111111" }), /sensíveis/);
  assert.throws(() => parsePosPaymentCallbackPayload({ ...raw, authorizationCode: "AUTH4111111111111111" }), /sensíveis/);
  assert.throws(() => parsePosPaymentCallbackPayload({ ...raw, transactionId: "AUTH４１１１１１１１１１１１１１１１" }), /sensíveis/);
  assert.throws(() => parsePosPaymentCallbackPayload({ ...raw, brand: "VISA4111111111111111" }), /sensíveis/);
  assert.throws(() => parsePosPaymentCallbackPayload({ ...raw, endToEndId: "X4111111111111111" }), /sensíveis/);
  assert.doesNotThrow(() => parsePosPaymentCallbackPayload({ ...raw, endToEndId: "E1234567820260829ABCDEFGHIJKLMNO" }));
});

test("boundary valida HMAC sobre bytes crus, key id e janela anti-replay", async () => {
  const secret = "s".repeat(48), keyId = "key-current", eventId = "event-00000001";
  const now = new Date(), timestamp = String(Math.floor(now.valueOf() / 1_000));
  const payload = JSON.stringify({ intentId: "intent-0000000001", reference: "provider-reference-1", state: "captured", amountCents: 500, currency: "BRL", sequence: 1, occurredAt: now.toISOString() });
  const signature = `sha256=${createHmac("sha256", secret).update(`${timestamp}.${eventId}.${payload}`).digest("hex")}`;
  const request = new Request("https://erp.example/api/webhooks", { method: "POST", headers: { "content-type": "application/json", "x-pos-timestamp": timestamp, "x-pos-event-id": eventId, "x-pos-key-id": keyId, "x-pos-signature": signature }, body: payload });
  const verified = await verifyAndParsePosPaymentCallback(request, "payment_gateway", [{ keyId, secret }], now);
  assert.equal(verified.eventId, eventId);
  assert.equal(verified.input.provider, "payment_gateway");
  assert.equal(verified.payloadHash, createHash("sha256").update(payload).digest("hex"));
  const rotatedRequest = new Request("https://erp.example/api/webhooks", { method: "POST", headers: { "content-type": "application/json", "x-pos-timestamp": timestamp, "x-pos-event-id": eventId, "x-pos-key-id": keyId, "x-pos-signature": signature }, body: payload });
  await assert.doesNotReject(verifyAndParsePosPaymentCallback(rotatedRequest, "payment_gateway", [{ keyId, secret: "w".repeat(48) }, { keyId, secret }], now));

  const tampered = new Request("https://erp.example/api/webhooks", { method: "POST", headers: { "content-type": "application/json", "x-pos-timestamp": timestamp, "x-pos-event-id": eventId, "x-pos-key-id": keyId, "x-pos-signature": signature }, body: `${payload} ` });
  await assert.rejects(verifyAndParsePosPaymentCallback(tampered, "payment_gateway", [{ keyId, secret }], now), /Assinatura/);
  const pciEventId = "AUTH4111111111111111", pciSignature = `sha256=${createHmac("sha256", secret).update(`${timestamp}.${pciEventId}.${payload}`).digest("hex")}`;
  const pciHeader = new Request("https://erp.example/api/webhooks", { method: "POST", headers: { "content-type": "application/json", "x-pos-timestamp": timestamp, "x-pos-event-id": pciEventId, "x-pos-key-id": keyId, "x-pos-signature": pciSignature }, body: payload });
  await assert.rejects(verifyAndParsePosPaymentCallback(pciHeader, "payment_gateway", [{ keyId, secret }], now), /dados de cartão/);
});

test("worker usa bearer forte, lease bounded e conclusão desconhecida sem referência sintética", () => {
  const token = "internal-job-token-".padEnd(48, "x");
  assert.doesNotThrow(() => assertPosPaymentJobAuthorization(new Request("https://erp.example/internal", { headers: { authorization: `Bearer ${token}` } }), token));
  assert.throws(() => assertPosPaymentJobAuthorization(new Request("https://erp.example/internal"), token), /Não autorizado/);
  assert.deepEqual(parsePosPaymentOutboxClaim({ action: "outbox.claim", workerId: "worker-1", limit: 2, leaseSeconds: 15 }), { action: "outbox.claim", workerId: "worker-1", limit: 2, leaseSeconds: 15 });
  assert.throws(() => parsePosPaymentOutboxClaim({ action: "outbox.claim", workerId: "worker-1", leaseSeconds: 5 }), /entre 15 e 300/);
  const completion = parsePosPaymentOutboxCompletion({ action: "outbox.complete", attemptId: "attempt-000000001", claimToken: "claim-token-0000001", result: { kind: "unknown", failureCode: "transport_timeout", failureMessage: "sem resposta conclusiva" } });
  assert.equal(completion.result.kind, "unknown");
  assert.equal("providerReference" in completion.result, false);
  assert.throws(() => parsePosPaymentOutboxCompletion({ action: "outbox.complete", attemptId: "attempt-000000001", claimToken: "claim-token-0000001", result: { kind: "result", provider: "payment_gateway", reference: "provider-reference", state: "captured", amountCents: 100, currency: "BRL", occurredAt: new Date().toISOString(), authorizationCode: "auth-4111111111111111" } }), /sensíveis/);
});
