import assert from "node:assert/strict";
import test from "node:test";
import { hashPosInternalQrMutation, parsePosInternalQrAdminInput } from "../lib/erp/pos-internal-qr-admin";

const now = new Date("2026-08-29T12:00:00.000Z");

test("emissão normaliza referência, expiração e idempotência", () => {
  const parsed = parsePosInternalQrAdminInput({ action: "qr.issue", branchId: 3, kind: "receipt", reference: "receipt:42", expiresAt: "2026-08-30T12:00:00.000Z", idempotencyKey: "issue-receipt-0001" }, now);
  assert.equal(parsed.action, "qr.issue");
  if (parsed.action !== "qr.issue") return;
  assert.equal(parsed.entityId, "42");
  assert.equal(parsed.expiresAt.toISOString(), "2026-08-30T12:00:00.000Z");
  assert.match(hashPosInternalQrMutation(parsed, { organizationId: "org_a", actorId: "user_a" }), /^[0-9a-f]{64}$/);
});

test("TTL é específico por tipo e nunca aceita expiração imediata", () => {
  assert.throws(() => parsePosInternalQrAdminInput({ action: "qr.issue", branchId: 3, kind: "held_cart", reference: "held_cart:held_123", expiresAt: "2026-08-30T12:00:01.000Z", idempotencyKey: "issue-held-cart-1" }, now), /Vigência/);
  assert.throws(() => parsePosInternalQrAdminInput({ action: "qr.issue", branchId: 3, kind: "coupon", reference: "coupon:coupon_123", expiresAt: "2026-08-29T12:00:30.000Z", idempotencyKey: "issue-coupon-001" }, now), /Vigência/);
  assert.doesNotThrow(() => parsePosInternalQrAdminInput({ action: "qr.issue", branchId: 3, kind: "customer", reference: "customer:7", expiresAt: "2027-08-29T12:00:00.000Z", idempotencyKey: "issue-customer-01" }, now));
});

test("resolução e revogação têm payload mínimo fechado", () => {
  const token = `NALVEN-POS.v1.key.${"A".repeat(80)}.${"B".repeat(43)}`;
  assert.deepEqual(parsePosInternalQrAdminInput({ action: "qr.resolve", sessionId: 9, token }, now), { action: "qr.resolve", sessionId: 9, token });
  assert.deepEqual(parsePosInternalQrAdminInput({ action: "qr.revoke", qrId: "qr_123", reason: "Código comprometido", idempotencyKey: "revoke-qr-000001" }, now), { action: "qr.revoke", qrId: "qr_123", reason: "Código comprometido", idempotencyKey: "revoke-qr-000001" });
  assert.throws(() => parsePosInternalQrAdminInput({ action: "qr.resolve", sessionId: 9, token, url: "https://example.com" }, now), /Campo não permitido/);
  assert.throws(() => parsePosInternalQrAdminInput({ action: "qr.revoke", qrId: "qr_123", reason: "curto", idempotencyKey: "revoke-qr-000001" }, now), /Motivo/);
});

test("hash muda com ator, escopo ou conteúdo", () => {
  const parsed = parsePosInternalQrAdminInput({ action: "qr.issue", branchId: 3, kind: "order", reference: "order:42", expiresAt: "2026-08-30T12:00:00.000Z", idempotencyKey: "issue-order-00001" }, now);
  if (parsed.action !== "qr.issue") throw new Error("unexpected");
  const base = hashPosInternalQrMutation(parsed, { organizationId: "org_a", actorId: "user_a" });
  assert.notEqual(base, hashPosInternalQrMutation(parsed, { organizationId: "org_a", actorId: "user_b" }));
  assert.notEqual(base, hashPosInternalQrMutation({ ...parsed, reference: "order:43", entityId: "43" }, { organizationId: "org_a", actorId: "user_a" }));
});
