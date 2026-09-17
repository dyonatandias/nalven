import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import test from "node:test";
import { assertPosFiscalJobAuthorization, parsePosFiscalOutboxClaim, parsePosFiscalOutboxCompletion, verifyAndParsePosFiscalCallback } from "../lib/erp/pos-fiscal-http";

const token = "fiscal-worker-token-that-is-long-enough-for-tests";

test("worker fiscal exige bearer interno forte", () => {
  assert.doesNotThrow(() => assertPosFiscalJobAuthorization(new Request("https://example.invalid", { headers: { authorization: `Bearer ${token}` } }), token));
  assert.throws(() => assertPosFiscalJobAuthorization(new Request("https://example.invalid", { headers: { authorization: "Bearer errado" } }), token), /Não autorizado/);
  assert.throws(() => assertPosFiscalJobAuthorization(new Request("https://example.invalid"), "curto"), /Não autorizado/);
});

test("claim fiscal aplica limites e rejeita campos extras", () => {
  assert.deepEqual(parsePosFiscalOutboxClaim({ action: "outbox.claim", workerId: "worker:01" }), {
    action: "outbox.claim",
    workerId: "worker:01",
    limit: 25,
    leaseSeconds: 60,
  });
  assert.throws(() => parsePosFiscalOutboxClaim({ action: "outbox.claim", workerId: "worker:01", limit: 101 }), /Limite inválido/);
  assert.throws(() => parsePosFiscalOutboxClaim({ action: "outbox.claim", workerId: "worker:01", unsafe: true }), /Campo não permitido/);
});

test("conclusão fiscal converte datas e sequência sem aceitar conteúdo de artefato", () => {
  const parsed = parsePosFiscalOutboxCompletion({
    action: "outbox.complete",
    attemptId: "attempt:fiscal:01",
    claimToken: "worker:claim:0000000000000001",
    result: {
      kind: "result",
      provider: "fiscal_provider",
      reference: "provider-document-1",
      state: "authorized",
      accessKey: "1".repeat(44),
      protocol: "protocol-1",
      rejectionCode: null,
      rejectionMessage: null,
      providerSequence: "19",
      occurredAt: "2026-08-29T12:00:00.000Z",
      totalCents: 12_345,
      currency: "BRL",
      artifacts: [{
        type: "authorized_xml",
        providerArtifactId: "xml-1",
        storageKey: "fiscal/document-1/authorized.xml",
        mimeType: "application/xml",
        sizeBytes: 512,
        sha256: "a".repeat(64),
        encryptionKeyId: "key-1",
        retentionUntil: "2032-08-29T00:00:00.000Z",
      }],
    },
  });
  assert.equal(parsed.result.kind, "result");
  if (parsed.result.kind !== "result") return;
  assert.equal(parsed.result.providerSequence, BigInt(19));
  assert.equal(parsed.result.occurredAt.toISOString(), "2026-08-29T12:00:00.000Z");
  assert.equal(parsed.result.artifacts[0].retentionUntil?.toISOString(), "2032-08-29T00:00:00.000Z");
  assert.throws(() => parsePosFiscalOutboxCompletion({
    action: "outbox.complete",
    attemptId: "attempt:fiscal:01",
    claimToken: "worker:claim:0000000000000001",
    result: {
      kind: "result",
      provider: "fiscal_provider",
      reference: "provider-document-1",
      state: "authorized",
      accessKey: "1".repeat(44),
      protocol: "protocol-1",
      rejectionCode: null,
      rejectionMessage: null,
      providerSequence: 1,
      occurredAt: "2026-08-29T12:00:00.000Z",
      totalCents: 12_345,
      currency: "BRL",
      artifacts: [{
        type: "authorized_xml",
        providerArtifactId: "xml-1",
        storageKey: "fiscal/document-1/authorized.xml",
        mimeType: "application/xml",
        sizeBytes: 512,
        sha256: "a".repeat(64),
        encryptionKeyId: "key-1",
        retentionUntil: null,
        content: "<xml>não deve atravessar este boundary</xml>",
      }],
    },
  }), /Campo não permitido/);
});

test("falha conhecida do boundary fiscal preserva retry explícito", () => {
  const parsed = parsePosFiscalOutboxCompletion({
    action: "outbox.complete",
    attemptId: "attempt:fiscal:02",
    claimToken: "worker:claim:0000000000000002",
    result: { kind: "known_failure", retryable: true, failureCode: "provider_unavailable", failureMessage: "Provider temporariamente indisponível" },
  });
  assert.deepEqual(parsed.result, { kind: "known_failure", retryable: true, failureCode: "provider_unavailable", failureMessage: "Provider temporariamente indisponível" });
});

test("callback fiscal exige HMAC, timestamp e evento anti-replay", async () => {
  const now = new Date();
  const timestamp = String(Math.floor(now.valueOf() / 1_000));
  const eventId = "fiscal-event-0001";
  const secret = "fiscal-callback-secret-with-at-least-32-bytes";
  const raw = JSON.stringify({
    documentId: "fiscal-document-0001",
    provider: "fiscal_provider",
    reference: "provider-document-1",
    state: "processing",
    accessKey: null,
    protocol: null,
    rejectionCode: null,
    rejectionMessage: null,
    providerSequence: "1",
    occurredAt: now.toISOString(),
    totalCents: 12_345,
    currency: "BRL",
    artifacts: [],
  });
  const signature = `sha256=${createHmac("sha256", secret).update(`${timestamp}.${eventId}.${raw}`, "utf8").digest("hex")}`;
  const headers = { "content-type": "application/json", "x-pos-timestamp": timestamp, "x-pos-event-id": eventId, "x-pos-key-id": "fiscal-key-1", "x-pos-signature": signature };
  const verified = await verifyAndParsePosFiscalCallback(new Request("https://example.invalid/callback", { method: "POST", headers, body: raw }), "fiscal_provider", [{ keyId: "fiscal-key-1", secret }], now);
  assert.equal(verified.input.documentId, "fiscal-document-0001");
  assert.equal(verified.input.providerSequence, BigInt(1));
  assert.equal(verified.payloadHash.length, 64);
  await assert.rejects(
    verifyAndParsePosFiscalCallback(new Request("https://example.invalid/callback", { method: "POST", headers: { ...headers, "x-pos-signature": `sha256=${"0".repeat(64)}` }, body: raw }), "fiscal_provider", [{ keyId: "fiscal-key-1", secret }], now),
    /Assinatura do callback fiscal inválida/,
  );
});
