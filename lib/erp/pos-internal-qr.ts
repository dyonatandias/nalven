import { createHash, createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import { PosDomainError } from "@/lib/erp/pos-domain";

const PREFIX = "NALVEN-POS";
const PURPOSE = "pos.internal-qr";
const AUDIENCE = "pos.scanner";
const TOKEN_VERSION = "v1";
const MAX_TOKEN_BYTES = 2_048;
const MIN_SECRET_BYTES = 32;
const MAX_LIFETIME_SECONDS = 366 * 24 * 60 * 60;
const DEFAULT_CLOCK_SKEW_SECONDS = 60;

export const POS_INTERNAL_QR_KINDS = ["customer", "held_cart", "coupon", "gift_card", "order", "receipt"] as const;
export type PosInternalQrKind = typeof POS_INTERNAL_QR_KINDS[number];

export type PosInternalQrPayload = {
  version: 1;
  purpose: typeof PURPOSE;
  audience: typeof AUDIENCE;
  organizationId: string;
  branchId: number | null;
  kind: PosInternalQrKind;
  reference: string;
  issuedAt: number;
  expiresAt: number;
  nonce: string;
};

export type PosInternalQrKey = {
  id: string;
  secret: string | Uint8Array;
  notBefore?: Date;
  notAfter?: Date;
};

export class PosInternalQrError extends PosDomainError {
  constructor(message: string, readonly code: "invalid" | "expired" | "scope" | "key" = "invalid") {
    super(message);
    this.name = "PosInternalQrError";
  }
}

export function loadPosInternalQrKeyring(env: Record<string, string | undefined> = process.env, now = new Date()) {
  const raw = env.POS_INTERNAL_QR_KEYS_JSON;
  const activeId = keyIdentifier(env.POS_INTERNAL_QR_ACTIVE_KEY_ID);
  if (!raw || Buffer.byteLength(raw, "utf8") > 16_384) throw new PosInternalQrError("Keyring do QR interno ausente ou inválido.", "key");
  let parsed: unknown;
  try { parsed = JSON.parse(raw); } catch { throw new PosInternalQrError("Keyring do QR interno não é JSON válido.", "key"); }
  if (!Array.isArray(parsed) || !parsed.length || parsed.length > 8) throw new PosInternalQrError("Keyring do QR interno deve conter de uma a oito chaves.", "key");
  const keys = parsed.map((value, index): PosInternalQrKey => {
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new PosInternalQrError(`Chave ${index + 1} do QR interno inválida.`, "key");
    const record = value as Record<string, unknown>;
    const allowed = ["id", "secretBase64url", "notBefore", "notAfter"];
    if (Object.keys(record).some(field => !allowed.includes(field)) || !Object.hasOwn(record, "id") || !Object.hasOwn(record, "secretBase64url")) throw new PosInternalQrError(`Chave ${index + 1} do QR interno contém campos inválidos.`, "key");
    const encoded = String(record.secretBase64url ?? "");
    if (!/^[A-Za-z0-9_-]{43,172}$/.test(encoded)) throw new PosInternalQrError(`Segredo da chave ${index + 1} deve estar em base64url.`, "key");
    const secret = decodeBase64url(encoded, 128, `Segredo da chave ${index + 1}`);
    if (secret.byteLength < MIN_SECRET_BYTES) throw new PosInternalQrError(`Segredo da chave ${index + 1} é curto.`, "key");
    return {
      id: keyIdentifier(record.id),
      secret,
      ...(record.notBefore == null ? {} : { notBefore: isoDate(record.notBefore, `Início da chave ${index + 1}`) }),
      ...(record.notAfter == null ? {} : { notAfter: isoDate(record.notAfter, `Fim da chave ${index + 1}`) }),
    };
  });
  if (new Set(keys.map(key => key.id)).size !== keys.length) throw new PosInternalQrError("Keyring do QR interno contém identificadores duplicados.", "key");
  const activeCandidates = keys.filter(key => key.id === activeId);
  if (activeCandidates.length !== 1) throw new PosInternalQrError("Chave ativa do QR interno não foi encontrada uma única vez.", "key");
  const active = activeCandidates[0];
  qrKey(active, validDate(now, "Relógio do servidor"));
  return { active, keys };
}

export function issuePosInternalQr(input: {
  organizationId: string;
  branchId?: number | null;
  kind: PosInternalQrKind;
  reference: string;
  expiresAt: Date;
  now?: Date;
  nonce?: string;
}, key: PosInternalQrKey) {
  const now = validDate(input.now ?? new Date(), "Relógio do servidor");
  const expiresAt = validDate(input.expiresAt, "Expiração do QR");
  const normalizedKey = qrKey(key, now);
  if (normalizedKey.notAfter && expiresAt > normalizedKey.notAfter) throw new PosInternalQrError("Expiração do QR ultrapassa a vigência da chave de assinatura.", "key");
  const payload: PosInternalQrPayload = {
    version: 1,
    purpose: PURPOSE,
    audience: AUDIENCE,
    organizationId: identifier(input.organizationId, "Organização", 160),
    branchId: input.branchId == null ? null : positiveInteger(input.branchId, "Filial"),
    kind: qrKind(input.kind),
    reference: normalizePosInternalQrReference(input.kind, input.reference).reference,
    issuedAt: epochSeconds(now),
    expiresAt: epochSeconds(expiresAt),
    nonce: uuid(input.nonce ?? randomUUID(), "Nonce"),
  };
  assertLifetime(payload.issuedAt, payload.expiresAt);
  const encodedPayload = base64url(Buffer.from(canonicalJson(payload), "utf8"));
  const signingInput = `${PREFIX}.${TOKEN_VERSION}.${normalizedKey.id}.${encodedPayload}`;
  const signature = base64url(createHmac("sha256", normalizedKey.secret).update(signingInput, "utf8").digest());
  const token = `${signingInput}.${signature}`;
  if (Buffer.byteLength(token, "utf8") > MAX_TOKEN_BYTES) throw new PosInternalQrError("QR interno excede o limite permitido.");
  return { token, payload };
}

export function verifyPosInternalQr(token: unknown, scope: {
  organizationId: string;
  branchId?: number | null;
  keys: readonly PosInternalQrKey[];
  now?: Date;
  clockSkewSeconds?: number;
}) {
  const raw = String(token ?? "").trim();
  if (!raw || Buffer.byteLength(raw, "utf8") > MAX_TOKEN_BYTES) throw new PosInternalQrError("QR interno inválido.");
  const parts = raw.split(".");
  if (parts.length !== 5 || parts[0] !== PREFIX || parts[1] !== TOKEN_VERSION) throw new PosInternalQrError("QR não pertence ao formato interno do PDV.");
  const [, , keyIdRaw, encodedPayload, encodedSignature] = parts;
  const keyId = keyIdentifier(keyIdRaw);
  if (!/^[A-Za-z0-9_-]{40,800}$/.test(encodedPayload) || !/^[A-Za-z0-9_-]{43}$/.test(encodedSignature)) throw new PosInternalQrError("QR interno malformado.");
  const now = validDate(scope.now ?? new Date(), "Relógio do servidor");
  const matching = scope.keys.filter(candidate => candidate.id === keyId);
  if (matching.length !== 1) throw new PosInternalQrError("Chave do QR indisponível ou ambígua.", "key");
  const key = qrKey(matching[0]);
  const signingInput = `${PREFIX}.${TOKEN_VERSION}.${keyId}.${encodedPayload}`;
  const expected = createHmac("sha256", key.secret).update(signingInput, "utf8").digest();
  const supplied = decodeBase64url(encodedSignature, 32, "Assinatura");
  if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) throw new PosInternalQrError("Assinatura do QR interno inválida.");
  const decoded = decodeBase64url(encodedPayload, 1_024, "Payload");
  let parsed: unknown;
  try { parsed = JSON.parse(decoded.toString("utf8")); } catch { throw new PosInternalQrError("Payload do QR interno inválido."); }
  const payload = normalizePayload(parsed);
  if (base64url(Buffer.from(canonicalJson(payload), "utf8")) !== encodedPayload) throw new PosInternalQrError("Payload do QR interno não é canônico.");
  assertQrKeyWindow(key, new Date(payload.issuedAt * 1_000));
  const organizationId = identifier(scope.organizationId, "Organização", 160);
  if (payload.organizationId !== organizationId) throw new PosInternalQrError("QR pertence a outra organização.", "scope");
  if (payload.branchId != null && (scope.branchId == null || payload.branchId !== positiveInteger(scope.branchId, "Filial"))) throw new PosInternalQrError("QR pertence a outra filial.", "scope");
  const skew = boundedInteger(scope.clockSkewSeconds ?? DEFAULT_CLOCK_SKEW_SECONDS, 0, 300, "Tolerância de relógio");
  const nowSeconds = epochSeconds(now);
  if (payload.issuedAt > nowSeconds + skew) throw new PosInternalQrError("QR interno ainda não é válido.", "expired");
  if (payload.expiresAt < nowSeconds - skew) throw new PosInternalQrError("QR interno expirado.", "expired");
  assertLifetime(payload.issuedAt, payload.expiresAt);
  return payload;
}

export function isPosInternalQr(value: unknown) {
  return typeof value === "string" && value.trim().startsWith(`${PREFIX}.${TOKEN_VERSION}.`);
}

export function hashPosInternalQr(value: unknown) {
  const token = String(value ?? "").trim();
  if (!isPosInternalQr(token) || Buffer.byteLength(token, "utf8") > MAX_TOKEN_BYTES) throw new PosInternalQrError("QR interno inválido.");
  return `sha256:v1:${createHash("sha256").update(token, "utf8").digest("hex")}`;
}

export function normalizePosInternalQrReference(kindValue: unknown, referenceValue: unknown) {
  const kind = qrKind(kindValue);
  const reference = identifier(referenceValue, "Referência", 160);
  const separator = reference.indexOf(":");
  const prefix = separator < 0 ? "" : reference.slice(0, separator);
  const entityId = separator < 0 ? "" : reference.slice(separator + 1);
  if (prefix !== kind || !entityId || entityId.includes(":")) throw new PosInternalQrError("Referência não corresponde ao tipo do QR interno.");
  if (["customer", "order", "receipt"].includes(kind)) positiveInteger(entityId, "Entidade do QR");
  else if (entityId.length < 3 || entityId.length > 120 || !/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(entityId)) throw new PosInternalQrError("Entidade do QR interno inválida.");
  return { kind, reference: `${kind}:${entityId}`, entityId };
}

function normalizePayload(value: unknown): PosInternalQrPayload {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new PosInternalQrError("Payload do QR interno deve ser um objeto.");
  const record = value as Record<string, unknown>;
  const allowed = ["version", "purpose", "audience", "organizationId", "branchId", "kind", "reference", "issuedAt", "expiresAt", "nonce"];
  if (Object.keys(record).length !== allowed.length || Object.keys(record).some(key => !allowed.includes(key)) || allowed.some(key => !Object.hasOwn(record, key))) throw new PosInternalQrError("Payload do QR interno contém campos inválidos.");
  if (record.version !== 1 || record.purpose !== PURPOSE || record.audience !== AUDIENCE) throw new PosInternalQrError("Contexto do QR interno inválido.");
  const payload: PosInternalQrPayload = {
    version: 1,
    purpose: PURPOSE,
    audience: AUDIENCE,
    organizationId: identifier(record.organizationId, "Organização", 160),
    branchId: record.branchId == null ? null : positiveInteger(record.branchId, "Filial"),
    kind: qrKind(record.kind),
    reference: normalizePosInternalQrReference(record.kind, record.reference).reference,
    issuedAt: boundedInteger(record.issuedAt, 0, 4_102_444_800, "Emissão"),
    expiresAt: boundedInteger(record.expiresAt, 1, 4_102_444_800, "Expiração"),
    nonce: uuid(record.nonce, "Nonce"),
  };
  assertLifetime(payload.issuedAt, payload.expiresAt);
  return payload;
}

function qrKey(value: PosInternalQrKey, now?: Date) {
  if (!value || typeof value !== "object") throw new PosInternalQrError("Chave do QR inválida.", "key");
  const id = keyIdentifier(value.id);
  const secret = typeof value.secret === "string" ? Buffer.from(value.secret, "utf8") : Buffer.from(value.secret);
  if (secret.byteLength < MIN_SECRET_BYTES) throw new PosInternalQrError("Chave do QR deve possuir ao menos 32 bytes.", "key");
  const notBefore = value.notBefore == null ? null : validDate(value.notBefore, "Início da chave");
  const notAfter = value.notAfter == null ? null : validDate(value.notAfter, "Fim da chave");
  if (notBefore && notAfter && notAfter <= notBefore) throw new PosInternalQrError("Janela da chave do QR inválida.", "key");
  const normalized = { id, secret, notBefore, notAfter };
  if (now) assertQrKeyWindow(normalized, now);
  return normalized;
}

function assertQrKeyWindow(key: { notBefore: Date | null; notAfter: Date | null }, instant: Date) {
  if (key.notBefore && instant < key.notBefore || key.notAfter && instant > key.notAfter) throw new PosInternalQrError("Chave do QR fora da vigência.", "key");
}

function assertLifetime(issuedAt: number, expiresAt: number) {
  if (expiresAt <= issuedAt) throw new PosInternalQrError("Expiração do QR deve ser posterior à emissão.");
  if (expiresAt - issuedAt > MAX_LIFETIME_SECONDS) throw new PosInternalQrError("Vigência do QR excede 366 dias.");
}

function qrKind(value: unknown): PosInternalQrKind {
  const result = String(value ?? "") as PosInternalQrKind;
  if (!(POS_INTERNAL_QR_KINDS as readonly string[]).includes(result)) throw new PosInternalQrError("Tipo de QR interno inválido.");
  return result;
}

function identifier(value: unknown, label: string, maximum: number) {
  const result = String(value ?? "").trim();
  if (result.length < 1 || result.length > maximum || !/^[A-Za-z0-9][A-Za-z0-9._:@/-]*$/.test(result)) throw new PosInternalQrError(`${label} inválida.`);
  return result;
}

function keyIdentifier(value: unknown) {
  const result = String(value ?? "").trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,39}$/.test(result)) throw new PosInternalQrError("Identificador da chave do QR inválido.", "key");
  return result;
}

function uuid(value: unknown, label: string) {
  const result = String(value ?? "").trim().toLowerCase();
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(result)) throw new PosInternalQrError(`${label} inválido.`);
  return result;
}

function positiveInteger(value: unknown, label: string) {
  return boundedInteger(value, 1, 2_147_483_647, label);
}

function boundedInteger(value: unknown, minimum: number, maximum: number, label: string) {
  const result = Number(value);
  if (!Number.isSafeInteger(result) || result < minimum || result > maximum) throw new PosInternalQrError(`${label} inválido.`);
  return result;
}

function validDate(value: Date, label: string) {
  if (!(value instanceof Date) || Number.isNaN(value.valueOf())) throw new PosInternalQrError(`${label} inválido.`);
  return value;
}

function isoDate(value: unknown, label: string) {
  if (typeof value !== "string" || value.length > 40 || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/.test(value)) throw new PosInternalQrError(`${label} inválido.`, "key");
  return validDate(new Date(value), label);
}

function epochSeconds(value: Date) {
  return Math.floor(value.valueOf() / 1_000);
}

function base64url(value: Buffer) {
  return value.toString("base64url");
}

function decodeBase64url(value: string, maximumBytes: number, label: string) {
  let result: Buffer;
  try { result = Buffer.from(value, "base64url"); } catch { throw new PosInternalQrError(`${label} do QR interno inválido.`); }
  if (!result.length || result.byteLength > maximumBytes || base64url(result) !== value) throw new PosInternalQrError(`${label} do QR interno inválido.`);
  return result;
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map(key => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(",")}}`;
}
