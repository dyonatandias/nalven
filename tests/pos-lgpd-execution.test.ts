import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import {
  createPosLgpdLegalHold,
  createPosLgpdSubjectRequest,
  derivePosLgpdTokenHash,
  hashPosLgpdPayload,
  planPosLgpdExecution,
  releasePosLgpdLegalHold,
} from "../lib/erp/pos-lgpd-execution";

const digest = (value: string) => hashPosLgpdPayload({ value });
process.env.POS_LGPD_TOKEN_PEPPER = "test-only-lgpd-pepper-with-at-least-thirty-two-bytes";
process.env.POS_LGPD_TOKEN_KEY_ID = "test-lgpd-key-v1";

test("hash LGPD é canônico e identificadores usam HMAC com separação de domínio", () => {
  assert.equal(hashPosLgpdPayload({ b: 2, a: 1 }), hashPosLgpdPayload({ a: 1, b: 2 }));
  const subject = derivePosLgpdTokenHash("A".repeat(64), "subject");
  const object = derivePosLgpdTokenHash("A".repeat(64), "object-key");
  assert.match(subject.digest, /^[0-9a-f]{64}$/);
  assert.notEqual(subject.digest, object.digest);
  assert.equal(subject.keyId, "test-lgpd-key-v1");
  assert.equal(subject.version, 1);
  assert.notEqual(subject.digest, createSimpleSha("A".repeat(64)));
  assert.throws(() => derivePosLgpdTokenHash("4111111111111111", "subject"), /PAN/);
  assert.throws(() => hashPosLgpdPayload({ value: Number.NaN }), /não finito/);
  assert.throws(() => hashPosLgpdPayload({ value: undefined }), /não serializável/);
});

test("tokenização falha sem pepper e key-id dedicados", () => {
  const pepper = process.env.POS_LGPD_TOKEN_PEPPER;
  const keyId = process.env.POS_LGPD_TOKEN_KEY_ID;
  delete process.env.POS_LGPD_TOKEN_PEPPER;
  assert.throws(() => derivePosLgpdTokenHash("opaque-subject-token-0001", "subject"), /PEPPER obrigatório/);
  process.env.POS_LGPD_TOKEN_PEPPER = pepper;
  delete process.env.POS_LGPD_TOKEN_KEY_ID;
  assert.throws(() => derivePosLgpdTokenHash("opaque-subject-token-0001", "subject"), /KEY_ID obrigatório/);
  process.env.POS_LGPD_TOKEN_KEY_ID = keyId;
});

test("escopo e manifesto rejeitam PII/PCI antes de abrir banco", async () => {
  await assert.rejects(createPosLgpdSubjectRequest({} as never, {
    idempotencyKeyHash: digest("request"),
    subjectTokenHash: digest("subject"),
    requestType: "access",
    scope: { email: "maria@example.com" },
    dueAt: new Date("2026-09-15T00:00:00.000Z"),
    createdBy: "privacy-operator",
    now: new Date("2026-08-29T00:00:00.000Z"),
  }), /PII\/PCI/);
  await assert.rejects(createPosLgpdSubjectRequest({} as never, {
    idempotencyKeyHash: digest("request-2"),
    subjectTokenHash: digest("subject"),
    requestType: "access",
    scope: { categories: ["sales"], note: "Cartão 4111111111111111" },
    dueAt: new Date("2026-09-15T00:00:00.000Z"),
    createdBy: "privacy-operator",
    now: new Date("2026-08-29T00:00:00.000Z"),
  }), /PII\/PCI/);
});

test("legal hold exige maker-checker, step-up hash e escopo coerente", async () => {
  const base = {
    idempotencyKeyHash: digest("hold"),
    subjectTokenHash: digest("subject"),
    reasonCode: "litigation.active",
    legalReferenceHash: digest("legal-reference"),
    proposedBy: "privacy-maker",
    approvedBy: "privacy-maker",
    stepUpProofHash: digest("step-up"),
  };
  await assert.rejects(createPosLgpdLegalHold({} as never, base), /maker e checker distintos/);
  await assert.rejects(createPosLgpdLegalHold({} as never, { ...base, approvedBy: "privacy-checker", objectType: "sale" }), /tipo e chave juntos/);
  await assert.rejects(releasePosLgpdLegalHold({} as never, { holdId: "hold-0001", proposedBy: "privacy-checker", releasedBy: "privacy-checker", stepUpProofHash: digest("release"), reasonCode: "litigation.closed" }), /maker e checker distintos/);
});

test("planejamento não aceita ação fora do catálogo nem identificador em claro", async () => {
  await assert.rejects(planPosLgpdExecution({} as never, {
    requestId: "request-0001",
    expectedVersion: 1,
    action: "purge" as never,
    idempotencyKeyHash: digest("job"),
    actorId: "privacy-operator",
  }), /Ação LGPD inválida/);
  await assert.rejects(planPosLgpdExecution({} as never, {
    requestId: "maria@example.com",
    expectedVersion: 1,
    action: "export",
    idempotencyKeyHash: digest("job-2"),
    actorId: "privacy-operator",
  }), /PII\/PCI/);
});

function createSimpleSha(value: string) {
  return createHash("sha256").update(value, "utf8").digest("hex");
}
