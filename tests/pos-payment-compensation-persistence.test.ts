import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import test from "node:test";
import {
  parsePosPaymentCompensationOutboxCompletion,
} from "../lib/erp/pos-payment-compensation-persistence";
import {
  PosPaymentCompensationHttpError,
  verifyAndParsePosPaymentCompensationCallback,
} from "../lib/erp/pos-payment-compensation-http";

const observationBody = {
  compensationId: "compensation-contract-1",
  provider: "stone",
  originalReference: "original-provider-reference",
  operationReference: "refund-provider-reference",
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

test("completion do worker aceita somente boundary estrito e resultado real do provider", () => {
  const parsed = parsePosPaymentCompensationOutboxCompletion({
    action: "compensation.outbox.complete",
    attemptId: "attempt-compensation-0001",
    claimToken: "worker:claim-compensation-0001",
    result: { kind: "result", ...observationBody },
  });
  assert.equal(parsed.result.kind, "result");
  if (parsed.result.kind === "result") {
    assert.equal(parsed.result.providerOperationReference, "refund-provider-reference");
    assert.equal(parsed.result.providerSequence, BigInt(2));
  }
  assert.throws(() => parsePosPaymentCompensationOutboxCompletion({
    action: "compensation.outbox.complete",
    attemptId: "attempt-compensation-0001",
    claimToken: "worker:claim-compensation-0001",
    result: { kind: "result", ...observationBody, operationReference: "AUTH4111111111111111X" },
  }), /cartão/);
  assert.throws(() => parsePosPaymentCompensationOutboxCompletion({
    action: "compensation.outbox.complete",
    attemptId: "attempt-compensation-0001",
    claimToken: "worker:claim-compensation-0001",
    result: { kind: "known_failure", retryable: true, failureCode: "provider_down", failureMessage: null, forgedSuccess: true },
  }), /não permitido/);
});

test("unknown do worker não carrega campos capazes de fabricar sucesso", () => {
  const parsed = parsePosPaymentCompensationOutboxCompletion({
    action: "compensation.outbox.complete",
    attemptId: "attempt-compensation-unknown",
    claimToken: "worker:claim-compensation-unknown",
    result: { kind: "unknown", failureCode: "provider_timeout", failureMessage: "Timeout depois do envio" },
  });
  assert.deepEqual(parsed.result, { kind: "unknown", failureCode: "provider_timeout", failureMessage: "Timeout depois do envio" });
  assert.throws(() => parsePosPaymentCompensationOutboxCompletion({
    action: "compensation.outbox.complete",
    attemptId: "attempt-compensation-unknown",
    claimToken: "worker:claim-compensation-unknown",
    result: { kind: "unknown", failureCode: "provider_timeout", failureMessage: null, succeeded: true },
  }), /não permitido/);
});

test("callback compensatório valida bytes brutos, HMAC, anti-replay temporal e PAN", async () => {
  const now = new Date("2026-08-29T12:00:00.000Z");
  const timestamp = String(Math.floor(now.valueOf() / 1_000));
  const eventId = "event-compensation-0001";
  const keyId = "callback-key-0001";
  const secret = "s".repeat(48);
  const raw = JSON.stringify(observationBody);
  const signature = `sha256=${createHmac("sha256", secret).update(`pos-compensation.v1.${timestamp}.${eventId}.${raw}`, "utf8").digest("hex")}`;
  const request = callbackRequest(raw, { timestamp, eventId, keyId, signature });
  const verified = await verifyAndParsePosPaymentCompensationCallback(request, "stone", [{ keyId, secret }], now);
  assert.equal(verified.eventId, eventId);
  assert.equal(verified.input.compensationId, observationBody.compensationId);
  assert.equal(verified.input.provider, "stone");

  const mismatchedProviderRaw = JSON.stringify({ ...observationBody, provider: "other-provider" });
  const mismatchedProviderSignature = `sha256=${createHmac("sha256", secret).update(`pos-compensation.v1.${timestamp}.${eventId}.${mismatchedProviderRaw}`, "utf8").digest("hex")}`;
  const providerBound = await verifyAndParsePosPaymentCompensationCallback(callbackRequest(mismatchedProviderRaw, { timestamp, eventId, keyId, signature: mismatchedProviderSignature }), "stone", [{ keyId, secret }], now);
  assert.equal(providerBound.input.provider, "stone", "o provider autenticado no path domina o campo não confiável do corpo");

  await assert.rejects(verifyAndParsePosPaymentCompensationCallback(
    callbackRequest(raw, { timestamp, eventId, keyId, signature: `sha256=${"0".repeat(64)}` }),
    "stone",
    [{ keyId, secret }],
    now,
  ), (error: unknown) => error instanceof PosPaymentCompensationHttpError && error.status === 401);

  const panRaw = JSON.stringify({ ...observationBody, operationReference: "AUTH4111111111111111X" });
  const panSignature = `sha256=${createHmac("sha256", secret).update(`pos-compensation.v1.${timestamp}.${eventId}.${panRaw}`, "utf8").digest("hex")}`;
  await assert.rejects(verifyAndParsePosPaymentCompensationCallback(
    callbackRequest(panRaw, { timestamp, eventId, keyId, signature: panSignature }),
    "stone",
    [{ keyId, secret }],
    now,
  ), /cartão/);
});

function callbackRequest(body: string, headers: { timestamp: string; eventId: string; keyId: string; signature: string }) {
  return new Request("https://example.invalid/api/webhooks/pos-payment-compensations/org/stone", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-pos-timestamp": headers.timestamp,
      "x-pos-event-id": headers.eventId,
      "x-pos-key-id": headers.keyId,
      "x-pos-signature": headers.signature,
    },
    body,
  });
}
