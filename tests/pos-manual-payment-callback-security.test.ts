import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import test from "node:test";
import {
  POS_MANUAL_CALLBACK_SIGNATURE_CONTEXT,
  PosManualPaymentCallbackSecurityError,
  type PosManualPaymentCallbackVerificationKey,
  verifyPosManualPaymentCallback,
} from "../lib/erp/pos-manual-payment-callback-security";

const NOW = new Date("2026-08-31T12:00:00.000Z");
const TIMESTAMP = Math.floor(NOW.valueOf() / 1_000);
const OLD_SECRET = Buffer.from("old-secret-material-exactly-32bytes!", "utf8");
const NEW_SECRET = Buffer.from("new-secret-material-exactly-32bytes!", "utf8");
const oldKey = key("manual-old", OLD_SECRET, "2026-08-31T10:00:00.000Z", "2026-08-31T12:01:00.000Z");
const newKey = key("manual-new", NEW_SECRET, "2026-08-31T11:59:00.000Z", "2026-09-01T00:00:00.000Z");

test("autentica os bytes exatos antes do parse e produz DTO sem segredo/body/nonce", () => {
  const body = Buffer.from(JSON.stringify(payload()), "utf8"), input = signedInput(body, newKey);
  const result = verifyPosManualPaymentCallback(input);
  assert.equal(result.eventId, "evt_manual_00000001");
  assert.equal(result.providerSequence, BigInt(42));
  assert.match(result.payloadHash, /^[0-9a-f]{64}$/);
  assert.match(result.replayKeyHash, /^[0-9a-f]{64}$/);
  assert.equal("rawBody" in result, false);
  assert.equal("secret" in result, false);
  assert.equal("nonce" in result, false);

  const tampered = Buffer.from(`${body.toString("utf8")} `, "utf8");
  expectCode(() => verifyPosManualPaymentCallback({ ...input, rawBody: tampered, headers: { ...input.headers, "content-length": String(tampered.byteLength) } }), "signature_invalid");
});

test("HMAC é verificado antes de JSON.parse", () => {
  const malformed = Buffer.from("{not-json", "utf8");
  const wrong = signedInput(malformed, newKey);
  expectCode(() => verifyPosManualPaymentCallback({ ...wrong, headers: { ...wrong.headers, "x-nalven-signature": `sha256=${"0".repeat(64)}` } }), "signature_invalid");
  expectCode(() => verifyPosManualPaymentCallback(wrong), "body_json_invalid");
});

test("rejeita timestamps stale/future e timestamp do payload divergente", () => {
  const staleTimestamp = TIMESTAMP - 301, staleBody = Buffer.from(JSON.stringify(payload({ timestamp: staleTimestamp })), "utf8");
  expectCode(() => verifyPosManualPaymentCallback(signedInput(staleBody, newKey, staleTimestamp)), "timestamp_skew");
  const futureTimestamp = TIMESTAMP + 301, futureBody = Buffer.from(JSON.stringify(payload({ timestamp: futureTimestamp })), "utf8");
  expectCode(() => verifyPosManualPaymentCallback(signedInput(futureBody, newKey, futureTimestamp)), "timestamp_skew");
  const mismatch = Buffer.from(JSON.stringify(payload({ timestamp: TIMESTAMP - 1 })), "utf8");
  expectCode(() => verifyPosManualPaymentCallback(signedInput(mismatch, newKey)), "timestamp_mismatch");
});

test("suporta rotação por key-id e recusa chave desconhecida/inativa/provider divergente", () => {
  const body = Buffer.from(JSON.stringify(payload()), "utf8"), keyring = new Map([[oldKey.keyId, oldKey], [newKey.keyId, newKey]]);
  assert.equal(verifyPosManualPaymentCallback({ ...signedInput(body, oldKey), keyring }).authKeyId, oldKey.keyId);
  assert.equal(verifyPosManualPaymentCallback({ ...signedInput(body, newKey), keyring }).authKeyId, newKey.keyId);
  const unknown = signedInput(body, { ...newKey, keyId: "manual-missing" });
  expectCode(() => verifyPosManualPaymentCallback({ ...unknown, keyring }), "key_unknown");
  const expired = key("manual-expired", OLD_SECRET, "2026-08-30T00:00:00.000Z", "2026-08-31T11:59:59.000Z");
  expectCode(() => verifyPosManualPaymentCallback(signedInput(body, expired)), "key_inactive");
  const otherProvider = Buffer.from(JSON.stringify(payload({ provider: "other_provider" })), "utf8");
  expectCode(() => verifyPosManualPaymentCallback(signedInput(otherProvider, newKey)), "provider_mismatch");
});

test("rejeita encoding, headers, JSON, campos extras e formatos inválidos", () => {
  const body = Buffer.from(JSON.stringify(payload()), "utf8"), valid = signedInput(body, newKey);
  expectCode(() => verifyPosManualPaymentCallback({ ...valid, headers: { ...valid.headers, "content-encoding": "gzip" } }), "content_encoding_invalid");
  expectCode(() => verifyPosManualPaymentCallback({ ...valid, headers: { ...valid.headers, "x-extra": "no" } }), "headers_invalid");
  const invalidUtf8 = Buffer.from([0xc3, 0x28]);
  expectCode(() => verifyPosManualPaymentCallback(signedInput(invalidUtf8, newKey)), "body_encoding_invalid");
  const extra = Buffer.from(JSON.stringify({ ...payload(), extra: true }), "utf8");
  expectCode(() => verifyPosManualPaymentCallback(signedInput(extra, newKey)), "body_keys_invalid");
  const duplicate = Buffer.from(JSON.stringify(payload()).replace('"amountCents":2590', '"amountCents":1,"amountCents":2590'), "utf8");
  expectCode(() => verifyPosManualPaymentCallback(signedInput(duplicate, newKey)), "body_keys_invalid");
  for (const patch of [
    { nonce: "short" }, { eventId: "bad event" }, { outcome: "paid" }, { amountCents: 0 }, { currency: "brl" },
    { referenceHash: "a".repeat(64) }, { timestamp: "bad" }, { sequence: "01" }, { occurredAt: "2026-08-31" },
  ]) {
    const invalid = Buffer.from(JSON.stringify(payload(patch)), "utf8");
    assert.throws(() => verifyPosManualPaymentCallback(signedInput(invalid, newKey)), PosManualPaymentCallbackSecurityError);
  }
});

test("aplica limites estritos de body e headers", () => {
  expectCode(() => verifyPosManualPaymentCallback({ rawBody: Buffer.alloc(32_769, 0x20), headers: {}, keyring: new Map(), now: NOW }), "body_size_invalid");
  const body = Buffer.from(JSON.stringify(payload()), "utf8"), valid = signedInput(body, newKey);
  expectCode(() => verifyPosManualPaymentCallback({ ...valid, headers: { ...valid.headers, "x-nalven-key-id": `k${"a".repeat(4_096)}` } }), "headers_limit_exceeded");
});

test("rejeita PAN Luhn, CVV, trilha e PIN mesmo com assinatura válida", () => {
  for (const patch of [
    { eventId: "evt-4111-1111-1111-1111" },
    { eventId: "evt-ref4111111111111111x" },
    { nonce: "nonce_cvv_1234567890123456789012" },
    { nonce: "nonce_track2_12345678901234567890" },
    { nonce: "nonce_pin_block_12345678901234567" },
  ]) {
    const body = Buffer.from(JSON.stringify(payload(patch)), "utf8");
    expectCode(() => verifyPosManualPaymentCallback(signedInput(body, newKey)), "sensitive_data");
  }
});

test("rejeita PAN separado por dois-pontos ou parênteses", () => {
  for (const eventId of ["4111:1111:1111:1111", "(4111) 1111 1111 1111"]) {
    const body = Buffer.from(JSON.stringify(payload({ eventId })));
    expectCode(() => verifyPosManualPaymentCallback(signedInput(body, newKey)), "sensitive_data");
  }
});

test("não confunde substring Luhn em hash criptográfico com PAN textual", () => {
  const hexadecimalWithPan = `aa4111111111111111${"b".repeat(46)}`;
  assert.equal(hexadecimalWithPan.length, 64);
  const body = Buffer.from(JSON.stringify(payload({ evidenceHash: hexadecimalWithPan, referenceHash: `hmac-sha256:v1:${hexadecimalWithPan}` })), "utf8");
  assert.doesNotThrow(() => verifyPosManualPaymentCallback(signedInput(body, newKey)));
  const textual = Buffer.from(JSON.stringify(payload({ eventId: "evt-4111-1111-1111-1111" })), "utf8");
  expectCode(() => verifyPosManualPaymentCallback(signedInput(textual, newKey)), "sensitive_data");
});

test("payload hash preserva bytes; hash canônico converge formatação JSON", () => {
  const compact = Buffer.from(JSON.stringify(payload()), "utf8");
  const pretty = Buffer.from(JSON.stringify(payload(), null, 2), "utf8");
  const a = verifyPosManualPaymentCallback(signedInput(compact, newKey));
  const b = verifyPosManualPaymentCallback(signedInput(pretty, newKey));
  assert.notEqual(a.payloadHash, b.payloadHash);
  assert.equal(a.canonicalEventHash, b.canonicalEventHash);
  assert.equal(a.replayKeyHash, b.replayKeyHash);
});

function payload(patch: Record<string, unknown> = {}) {
  return {
    amountCents: 2590,
    currency: "BRL",
    eventId: "evt_manual_00000001",
    evidenceHash: "b".repeat(64),
    method: "credit",
    nonce: "bm9uY2VfbWFudWFsXzAwMDAwMDAx",
    occurredAt: "2026-08-31T11:59:30.000Z",
    outcome: "confirmed_paid",
    provider: "manual_provider",
    referenceHash: `hmac-sha256:v1:${"a".repeat(64)}`,
    sequence: "42",
    timestamp: TIMESTAMP,
    ...patch,
  };
}

function key(keyId: string, secret: Uint8Array, notBefore: string, notAfter: string): PosManualPaymentCallbackVerificationKey {
  return { keyId, provider: "manual_provider", secret, notBefore: new Date(notBefore), notAfter: new Date(notAfter) };
}

function signedInput(rawBody: Buffer, selectedKey: PosManualPaymentCallbackVerificationKey, timestamp = TIMESTAMP) {
  const signed = Buffer.concat([Buffer.from(`${POS_MANUAL_CALLBACK_SIGNATURE_CONTEXT}\n${selectedKey.keyId}\n${timestamp}\n`, "utf8"), rawBody]);
  const signature = createHmac("sha256", selectedKey.secret).update(signed).digest("hex");
  return {
    rawBody,
    headers: { "Content-Type": "application/json", "content-length": String(rawBody.byteLength), "x-nalven-key-id": selectedKey.keyId, "x-nalven-timestamp": String(timestamp), "x-nalven-signature": `sha256=${signature}` },
    keyring: new Map([[selectedKey.keyId, selectedKey]]),
    now: NOW,
  };
}

function expectCode(operation: () => unknown, code: string) {
  assert.throws(operation, error => error instanceof PosManualPaymentCallbackSecurityError && error.code === code);
}
