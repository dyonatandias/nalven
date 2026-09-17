import assert from "node:assert/strict";
import test from "node:test";
import { hashPosInternalQr, isPosInternalQr, issuePosInternalQr, loadPosInternalQrKeyring, normalizePosInternalQrReference, POS_INTERNAL_QR_KINDS, PosInternalQrError, verifyPosInternalQr } from "../lib/erp/pos-internal-qr";

const now = new Date("2026-08-29T12:00:00.000Z");
const key = { id: "active-2026", secret: "0123456789abcdef0123456789abcdef" };
const nonce = "4d73d687-4f04-4cda-9e87-22a997167272";

test("QR interno assina todos os contextos previstos e preserva somente referência opaca", () => {
  const references = { customer: "customer:123", held_cart: "held_cart:held_123", coupon: "coupon:coupon_123", gift_card: "gift_card:gift_123", order: "order:456", receipt: "receipt:789" } as const;
  for (const kind of POS_INTERNAL_QR_KINDS) {
    const issued = issuePosInternalQr({ organizationId: "org_demo", branchId: 7, kind, reference: references[kind], expiresAt: new Date(now.valueOf() + 60_000), now, nonce }, key);
    assert.equal(isPosInternalQr(issued.token), true);
    assert.match(hashPosInternalQr(issued.token), /^sha256:v1:[0-9a-f]{64}$/);
    assert.deepEqual(verifyPosInternalQr(issued.token, { organizationId: "org_demo", branchId: 7, keys: [key], now }), issued.payload);
    assert.equal(Object.hasOwn(issued.payload, "document"), false);
    assert.equal(Object.hasOwn(issued.payload, "url"), false);
  }
});

test("assinatura vincula organização, filial, payload e chave", () => {
  const { token } = issuePosInternalQr({ organizationId: "org_a", branchId: 1, kind: "receipt", reference: "receipt:99", expiresAt: new Date(now.valueOf() + 60_000), now, nonce }, key);
  assert.throws(() => verifyPosInternalQr(token, { organizationId: "org_b", branchId: 1, keys: [key], now }), (error: unknown) => error instanceof PosInternalQrError && error.code === "scope");
  assert.throws(() => verifyPosInternalQr(token, { organizationId: "org_a", branchId: 2, keys: [key], now }), (error: unknown) => error instanceof PosInternalQrError && error.code === "scope");
  assert.throws(() => verifyPosInternalQr(`${token.slice(0, -1)}${token.endsWith("A") ? "B" : "A"}`, { organizationId: "org_a", branchId: 1, keys: [key], now }), /Assinatura/);
  assert.throws(() => verifyPosInternalQr(token, { organizationId: "org_a", branchId: 1, keys: [{ ...key, secret: "abcdef0123456789abcdef0123456789" }], now }), /Assinatura/);
});

test("expiração, emissão futura e vigência máxima falham fechadas", () => {
  const expired = issuePosInternalQr({ organizationId: "org_a", kind: "customer", reference: "customer:1", expiresAt: new Date(now.valueOf() + 1_000), now, nonce }, key).token;
  assert.throws(() => verifyPosInternalQr(expired, { organizationId: "org_a", keys: [key], now: new Date(now.valueOf() + 62_000), clockSkewSeconds: 0 }), (error: unknown) => error instanceof PosInternalQrError && error.code === "expired");
  const future = issuePosInternalQr({ organizationId: "org_a", kind: "customer", reference: "customer:1", expiresAt: new Date(now.valueOf() + 121_000), now: new Date(now.valueOf() + 120_000), nonce }, key).token;
  assert.throws(() => verifyPosInternalQr(future, { organizationId: "org_a", keys: [key], now, clockSkewSeconds: 0 }), /ainda não/);
  assert.throws(() => issuePosInternalQr({ organizationId: "org_a", kind: "customer", reference: "customer:1", expiresAt: new Date(now.valueOf() + 367 * 86_400_000), now, nonce }, key), /366 dias/);
});

test("rotação aceita chave identificada, mas recusa keyring ambíguo ou fora da vigência para emissão", () => {
  const previous = { id: "previous", secret: "previous-0123456789abcdef01234567" };
  const { token } = issuePosInternalQr({ organizationId: "org_a", kind: "order", reference: "order:8", expiresAt: new Date(now.valueOf() + 60_000), now, nonce }, previous);
  assert.equal(verifyPosInternalQr(token, { organizationId: "org_a", keys: [key, previous], now }).reference, "order:8");
  assert.throws(() => verifyPosInternalQr(token, { organizationId: "org_a", keys: [previous, previous], now }), /ambígua/);
  assert.throws(() => issuePosInternalQr({ organizationId: "org_a", kind: "order", reference: "order:8", expiresAt: new Date(now.valueOf() + 60_000), now, nonce }, { ...key, notAfter: new Date(now.valueOf() - 1) }), /fora da vigência/);
  assert.throws(() => issuePosInternalQr({ organizationId: "org_a", kind: "order", reference: "order:8", expiresAt: new Date(now.valueOf() + 120_000), now, nonce }, { ...key, notAfter: new Date(now.valueOf() + 60_000) }), /ultrapassa/);
  const retiredKey = { ...previous, notBefore: new Date(now.valueOf() - 120_000), notAfter: new Date(now.valueOf() + 30_000) };
  const retiredToken = issuePosInternalQr({ organizationId: "org_a", kind: "order", reference: "order:8", expiresAt: new Date(now.valueOf() + 20_000), now, nonce }, retiredKey).token;
  assert.equal(verifyPosInternalQr(retiredToken, { organizationId: "org_a", keys: [retiredKey], now: new Date(now.valueOf() + 40_000) }).reference, "order:8");
});

test("formato rejeita URL externa, segredo curto, campos e referências abusivas", () => {
  assert.equal(isPosInternalQr("https://example.com"), false);
  assert.throws(() => verifyPosInternalQr("https://example.com", { organizationId: "org_a", keys: [key], now }), /não pertence/);
  assert.throws(() => issuePosInternalQr({ organizationId: "org_a", kind: "coupon", reference: "coupon:1", expiresAt: new Date(now.valueOf() + 60_000), now, nonce }, { id: "short", secret: "short" }), /32 bytes/);
  assert.throws(() => issuePosInternalQr({ organizationId: "org_a", kind: "coupon", reference: "<script>", expiresAt: new Date(now.valueOf() + 60_000), now, nonce }, key), /Referência/);
  assert.throws(() => issuePosInternalQr({ organizationId: "org_a", kind: "external" as "coupon", reference: "coupon:1", expiresAt: new Date(now.valueOf() + 60_000), now, nonce }, key), /Tipo/);
  assert.throws(() => normalizePosInternalQrReference("coupon", "customer:1"), /não corresponde/);
  assert.throws(() => normalizePosInternalQrReference("customer", "customer:not-a-number"), /Entidade/);
});

test("keyring configurável exige base64url, chave ativa única e janela válida", () => {
  const secretBase64url = Buffer.from(key.secret).toString("base64url");
  const configured = loadPosInternalQrKeyring({
    POS_INTERNAL_QR_ACTIVE_KEY_ID: key.id,
    POS_INTERNAL_QR_KEYS_JSON: JSON.stringify([{ id: key.id, secretBase64url, notBefore: "2026-08-29T00:00:00.000Z", notAfter: "2026-08-30T00:00:00.000Z" }]),
  }, now);
  assert.equal(configured.active.id, key.id);
  assert.equal(Buffer.from(configured.active.secret).equals(Buffer.from(key.secret)), true);
  assert.throws(() => loadPosInternalQrKeyring({ POS_INTERNAL_QR_ACTIVE_KEY_ID: key.id, POS_INTERNAL_QR_KEYS_JSON: "[]" }, now), /uma a oito/);
  assert.throws(() => loadPosInternalQrKeyring({ POS_INTERNAL_QR_ACTIVE_KEY_ID: "missing", POS_INTERNAL_QR_KEYS_JSON: JSON.stringify([{ id: key.id, secretBase64url }]) }, now), /ativa/);
  assert.throws(() => loadPosInternalQrKeyring({ POS_INTERNAL_QR_ACTIVE_KEY_ID: key.id, POS_INTERNAL_QR_KEYS_JSON: JSON.stringify([{ id: key.id, secretBase64url, leaked: "x" }]) }, now), /campos/);
  assert.throws(() => loadPosInternalQrKeyring({ POS_INTERNAL_QR_ACTIVE_KEY_ID: key.id, POS_INTERNAL_QR_KEYS_JSON: JSON.stringify([{ id: key.id, secretBase64url, notAfter: "2026-08-28T00:00:00.000Z" }]) }, now), /fora da vigência/);
});
