import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import test from "node:test";
import {
  POS_MANUAL_RECORD_CALLBACK_SQL,
  PosManualCallbackAdapterError,
  recordVerifiedPosManualPaymentCallback,
} from "../lib/erp/pos-manual-payment-callback-adapter";
import { POS_MANUAL_CALLBACK_SIGNATURE_CONTEXT, type PosManualPaymentCallbackVerificationKey } from "../lib/erp/pos-manual-payment-callback-security";

const now = new Date("2026-08-31T12:00:00.000Z"), timestamp = Math.floor(now.valueOf() / 1000);
const secret = Buffer.from("adapter-secret-material-32-bytes!!", "utf8");
const key: PosManualPaymentCallbackVerificationKey = { keyId: "manual-key-v1", provider: "manual_provider", secret, notBefore: new Date("2026-08-31T11:00:00Z"), notAfter: new Date("2026-09-01T00:00:00Z") };

test("HMAC real produz somente parâmetros derivados para a procedure `_mc`", async () => {
  const input = signedInput(); let capturedSql = "", captured: readonly unknown[] = [];
  const result = await recordVerifiedPosManualPaymentCallback({ ...input, trustedContext: { credentialRevision: 7, verifierVersion: "hmac-adapter-v1" }, database: { async query(sql, values) {
    capturedSql = sql; captured = values;
    return { rows: [{ result: { proofId: "11111111-1111-4111-8111-111111111111", caseId: null, disposition: "orphan_reference", duplicate: false, quarantined: true } }] };
  } } });
  assert.equal(capturedSql, POS_MANUAL_RECORD_CALLBACK_SQL);
  assert.match(String(captured[1]), /^evt:[0-9a-f]{64}$/);
  assert.notEqual(captured[1], "provider-event-00000001");
  assert.equal(captured[16], 7); assert.equal(captured[17], "hmac-adapter-v1");
  const serialized = JSON.stringify(captured);
  assert.equal(serialized.includes("provider-event-00000001"), false);
  assert.equal(serialized.includes(secret.toString("utf8")), false);
  assert.equal(serialized.includes(input.rawBody.toString("utf8")), false);
  assert.deepEqual(result, { proofId: "11111111-1111-4111-8111-111111111111", disposition: "orphan_reference", duplicate: false, quarantined: true });
});

test("erros são allowlist e não propagam segredo, body, event id ou erro SQL", async () => {
  const input = signedInput();
  await assert.rejects(recordVerifiedPosManualPaymentCallback({ ...input, headers: { ...input.headers, "x-nalven-signature": `sha256=${"0".repeat(64)}` }, trustedContext: { credentialRevision: 7, verifierVersion: "hmac-adapter-v1" }, database: neverDb() }), error => assertSafe(error, "verification_failed"));
  await assert.rejects(recordVerifiedPosManualPaymentCallback({ ...input, headers: { ...input.headers, "x-nalven-key-id": "unknown-key" }, trustedContext: { credentialRevision: 7, verifierVersion: "hmac-adapter-v1" }, database: neverDb() }), error => assertSafe(error, "verification_failed"));
  await assert.rejects(recordVerifiedPosManualPaymentCallback({ ...input, trustedContext: { credentialRevision: 7, verifierVersion: "hmac-adapter-v1" }, database: { async query() { throw new Error(`SQL leaked ${secret} provider-event-00000001`); } } }), error => assertSafe(error, "persistence_failed"));
});

test("aceita o DTO fechado do caminho callback associado", async () => {
  const input = signedInput(), caseId = "22222222-2222-4222-8222-222222222222";
  const result = await recordVerifiedPosManualPaymentCallback({ ...input, trustedContext: { credentialRevision: 7, verifierVersion: "hmac-adapter-v1" }, database: { async query() { return { rows: [{ result: { proofId: "11111111-1111-4111-8111-111111111111", callbackId: 42, caseId, resultingState: "confirmed_paid", resultingVersion: 3, disposition: "accepted", duplicate: false, quarantined: false } }] }; } } });
  assert.equal(result.callbackId, 42); assert.equal(result.caseId, caseId); assert.equal(result.resultingVersion, 3);
});

function signedInput() {
  const body = Buffer.from(JSON.stringify({ amountCents: 2590, currency: "BRL", eventId: "provider-event-00000001", evidenceHash: "b".repeat(64), method: "credit", nonce: "bm9uY2VfYWRhcHRlcl8wMDAwMDAx", occurredAt: "2026-08-31T11:59:30.000Z", outcome: "confirmed_paid", provider: "manual_provider", referenceHash: `hmac-sha256:v1:${"a".repeat(64)}`, sequence: "42", timestamp }), "utf8");
  const signature = createHmac("sha256", secret).update(Buffer.concat([Buffer.from(`${POS_MANUAL_CALLBACK_SIGNATURE_CONTEXT}\n${key.keyId}\n${timestamp}\n`), body])).digest("hex");
  return { rawBody: body, headers: { "content-type": "application/json", "content-length": String(body.length), "x-nalven-key-id": key.keyId, "x-nalven-timestamp": String(timestamp), "x-nalven-signature": `sha256=${signature}` }, keyring: new Map([[key.keyId, key]]), now };
}

function neverDb() { return { async query(): Promise<{ rows: Array<{ result: unknown }> }> { throw new Error("must not query"); } }; }
function assertSafe(error: unknown, code: string) { assert.ok(error instanceof PosManualCallbackAdapterError); assert.equal(error.code, code); assert.equal(error.message, "Callback manual recusado."); return true; }
