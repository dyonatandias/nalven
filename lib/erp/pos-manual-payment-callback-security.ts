import { createHash, createHmac, timingSafeEqual } from "node:crypto";

export const POS_MANUAL_CALLBACK_SIGNATURE_CONTEXT = "nalven-pos-manual-callback-v1";
export const POS_MANUAL_CALLBACK_LIMITS = Object.freeze({ maximumBodyBytes: 32_768, maximumHeaderBytes: 4_096, maximumHeaders: 6, defaultSkewSeconds: 300, maximumSkewSeconds: 900 });

const ALLOWED_HEADERS = new Set(["content-type", "content-encoding", "content-length", "x-nalven-key-id", "x-nalven-timestamp", "x-nalven-signature"]);
const PAYLOAD_KEYS = ["amountCents", "currency", "eventId", "evidenceHash", "method", "nonce", "occurredAt", "outcome", "provider", "referenceHash", "sequence", "timestamp"] as const;
const OUTCOMES = ["confirmed_paid", "not_found", "voided", "refunded", "unknown"] as const;

export class PosManualPaymentCallbackSecurityError extends Error {
  constructor(public readonly code: string, message: string, public readonly status = 400) { super(message); this.name = "PosManualPaymentCallbackSecurityError"; }
}

export type PosManualPaymentCallbackVerificationKey = {
  keyId: string;
  provider: string;
  secret: Uint8Array;
  notBefore: Date;
  notAfter: Date;
};

export type PosManualPaymentCallbackSecurityInput = {
  rawBody: Uint8Array;
  headers: Readonly<Record<string, string | readonly string[] | undefined>>;
  keyring: ReadonlyMap<string, PosManualPaymentCallbackVerificationKey>;
  now?: Date;
  maximumSkewSeconds?: number;
};

export type PosManualPaymentCallbackSecurityDto = Readonly<{
  eventId: string;
  provider: string;
  outcome: typeof OUTCOMES[number];
  referenceHash: string;
  method: string;
  amountCents: number;
  currency: string;
  providerSequence: bigint;
  providerOccurredAt: Date;
  evidenceHash: string;
  eventTimestamp: Date;
  authKeyId: string;
  payloadHash: string;
  signatureHash: string;
  canonicalEventHash: string;
  nonceHash: string;
  replayKeyHash: string;
}>;

/**
 * Pure verification boundary. Authentication covers the exact request bytes
 * and is completed before UTF-8 decoding or JSON parsing.
 */
export function verifyPosManualPaymentCallback(input: PosManualPaymentCallbackSecurityInput): PosManualPaymentCallbackSecurityDto {
  const now = validDate(input.now ?? new Date(), "clock_invalid");
  const skewSeconds = boundedInteger(input.maximumSkewSeconds ?? POS_MANUAL_CALLBACK_LIMITS.defaultSkewSeconds, 1, POS_MANUAL_CALLBACK_LIMITS.maximumSkewSeconds, "skew_invalid");
  const rawBody = rawBytes(input.rawBody);
  const headers = normalizeHeaders(input.headers);
  validateTransport(headers, rawBody.byteLength);
  const keyId = headerIdentifier(requiredHeader(headers, "x-nalven-key-id"), "key_id_invalid");
  const timestampSeconds = epochSeconds(requiredHeader(headers, "x-nalven-timestamp"));
  const signature = signatureBytes(requiredHeader(headers, "x-nalven-signature"));
  const key = input.keyring.get(keyId);
  if (!key || key.keyId !== keyId) fail("key_unknown", "Chave de callback desconhecida.", 401);
  validateKey(key, now, timestampSeconds, skewSeconds);
  const expected = createHmac("sha256", key.secret).update(signingInput(keyId, timestampSeconds, rawBody)).digest();
  if (signature.byteLength !== expected.byteLength || !timingSafeEqual(signature, expected)) fail("signature_invalid", "Assinatura do callback inválida.", 401);

  // Nothing above this point decodes or parses the untrusted body.
  const text = decodeUtf8(rawBody);
  let parsed: unknown;
  try { parsed = JSON.parse(text); } catch { fail("body_json_invalid", "JSON do callback inválido."); }
  const lexicalKeys = topLevelJsonKeys(text);
  if (new Set(lexicalKeys).size !== lexicalKeys.length) fail("body_keys_invalid", "Payload contém chave JSON duplicada.");
  rejectSensitiveData(parsed);
  const body = exactObject(parsed, PAYLOAD_KEYS);
  const eventId = opaqueIdentifier(body.eventId, "event_id_invalid", 8, 160);
  const nonce = base64Url(body.nonce, "nonce_invalid", 22, 128);
  const provider = providerCode(body.provider);
  if (provider !== key.provider) fail("provider_mismatch", "Provider não corresponde à chave autenticadora.", 401);
  const outcome = choice(body.outcome, OUTCOMES, "outcome_invalid");
  const referenceHash = keyedHash(body.referenceHash, "reference_hash_invalid");
  const method = lowerCode(body.method, "method_invalid", 2, 40);
  const amountCents = boundedInteger(body.amountCents, 1, 2_147_483_647, "amount_invalid");
  const currency = currencyCode(body.currency);
  const evidenceHash = hexHash(body.evidenceHash, "evidence_hash_invalid");
  const payloadTimestamp = boundedInteger(body.timestamp, 0, Number.MAX_SAFE_INTEGER, "timestamp_invalid");
  if (payloadTimestamp !== timestampSeconds) fail("timestamp_mismatch", "Timestamp do payload diverge do header autenticado.");
  const providerSequence = decimalBigInt(body.sequence, "sequence_invalid");
  const providerOccurredAt = canonicalIsoDate(body.occurredAt, "occurred_at_invalid");
  const eventTimestamp = new Date(timestampSeconds * 1_000);
  if (providerOccurredAt > new Date(eventTimestamp.valueOf() + skewSeconds * 1_000) || providerOccurredAt < new Date(eventTimestamp.valueOf() - 90 * 24 * 60 * 60_000)) fail("occurred_at_causality_invalid", "Data do provider fora da janela causal.");

  const payloadHash = sha256(rawBody);
  const signatureHash = sha256(signature);
  const normalizedEvent = { eventId, provider, outcome, referenceHash, method, amountCents, currency, providerSequence, providerOccurredAt, evidenceHash, eventTimestamp, authKeyId: keyId };
  const canonicalEventHash = sha256(canonicalJson(normalizedEvent));
  const nonceHash = sha256(`nonce:${provider}:${nonce}`);
  const replayKeyHash = sha256(canonicalJson({ provider, eventId, nonceHash, timestamp: timestampSeconds }));
  return Object.freeze({ ...normalizedEvent, payloadHash, signatureHash, canonicalEventHash, nonceHash, replayKeyHash });
}

function signingInput(keyId: string, timestampSeconds: number, rawBody: Uint8Array) {
  return Buffer.concat([
    Buffer.from(`${POS_MANUAL_CALLBACK_SIGNATURE_CONTEXT}\n${keyId}\n${timestampSeconds}\n`, "utf8"),
    Buffer.from(rawBody.buffer, rawBody.byteOffset, rawBody.byteLength),
  ]);
}

function rawBytes(value: Uint8Array) {
  if (!(value instanceof Uint8Array) || value.byteLength < 2 || value.byteLength > POS_MANUAL_CALLBACK_LIMITS.maximumBodyBytes) fail("body_size_invalid", "Tamanho do callback inválido.", 413);
  return value;
}

function normalizeHeaders(source: PosManualPaymentCallbackSecurityInput["headers"]) {
  if (!source || typeof source !== "object" || Array.isArray(source)) fail("headers_invalid", "Headers inválidos.");
  const entries = Object.entries(source);
  if (entries.length > POS_MANUAL_CALLBACK_LIMITS.maximumHeaders) fail("headers_limit_exceeded", "Quantidade de headers excedida.", 431);
  const result = new Map<string, string>();
  let bytes = 0;
  for (const [rawName, rawValue] of entries) {
    const name = rawName.toLowerCase();
    if (!/^[A-Za-z0-9-]+$/.test(rawName) || !ALLOWED_HEADERS.has(name) || result.has(name) || typeof rawValue !== "string" || /[\r\n\0]/.test(rawValue)) fail("headers_invalid", "Header ausente, duplicado ou não permitido.");
    bytes += Buffer.byteLength(rawName) + Buffer.byteLength(rawValue);
    if (bytes > POS_MANUAL_CALLBACK_LIMITS.maximumHeaderBytes) fail("headers_limit_exceeded", "Tamanho dos headers excedido.", 431);
    result.set(name, rawValue.trim());
  }
  return result;
}

function validateTransport(headers: ReadonlyMap<string, string>, bodyBytes: number) {
  const contentType = requiredHeader(headers, "content-type").toLowerCase();
  if (contentType !== "application/json" && contentType !== "application/json; charset=utf-8") fail("content_type_invalid", "Content-Type deve ser JSON UTF-8.", 415);
  const encoding = headers.get("content-encoding");
  if (encoding && encoding.toLowerCase() !== "identity") fail("content_encoding_invalid", "Body comprimido ou recodificado não é aceito.", 415);
  const contentLength = headers.get("content-length");
  if (contentLength != null && (!/^(?:0|[1-9][0-9]{0,8})$/.test(contentLength) || Number(contentLength) !== bodyBytes)) fail("content_length_invalid", "Content-Length diverge dos bytes recebidos.");
}

function validateKey(key: PosManualPaymentCallbackVerificationKey, now: Date, timestampSeconds: number, skewSeconds: number) {
  headerIdentifier(key.keyId, "key_id_invalid");
  const provider = providerCode(key.provider);
  if (provider !== key.provider || !(key.secret instanceof Uint8Array) || key.secret.byteLength < 32 || key.secret.byteLength > 128) fail("key_invalid", "Material autenticador inválido.", 401);
  const notBefore = validDate(key.notBefore, "key_invalid"), notAfter = validDate(key.notAfter, "key_invalid");
  if (notBefore >= notAfter || now < notBefore || now >= notAfter) fail("key_inactive", "Chave de callback fora da vigência.", 401);
  const eventTime = new Date(timestampSeconds * 1_000);
  if (Math.abs(now.valueOf() - eventTime.valueOf()) > skewSeconds * 1_000) fail("timestamp_skew", "Timestamp do callback fora da tolerância.", 401);
  if (eventTime < notBefore || eventTime >= notAfter) fail("key_timestamp_invalid", "Timestamp fora da vigência da chave.", 401);
}

function decodeUtf8(raw: Uint8Array) {
  if (raw.byteLength >= 3 && raw[0] === 0xef && raw[1] === 0xbb && raw[2] === 0xbf) fail("body_encoding_invalid", "BOM UTF-8 não é aceito.");
  try { return new TextDecoder("utf-8", { fatal: true }).decode(raw); } catch { return fail("body_encoding_invalid", "Body não é UTF-8 válido."); }
}

function exactObject(value: unknown, allowed: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) fail("body_shape_invalid", "Payload deve ser objeto JSON.");
  const fields = Object.keys(value as object).sort();
  if (fields.length !== allowed.length || fields.some((field, index) => field !== allowed[index])) fail("body_keys_invalid", "Payload contém campo ausente ou não permitido.");
  return value as Record<string, unknown>;
}

function topLevelJsonKeys(text: string) {
  const keys: string[] = [];
  let cursor = skipWhitespace(text, 0);
  if (text[cursor] !== "{") return keys;
  cursor += 1;
  for (;;) {
    cursor = skipWhitespace(text, cursor);
    if (text[cursor] === "}") return keys;
    if (text[cursor] !== '"') fail("body_json_invalid", "Objeto JSON inválido.");
    const keyEnd = skipJsonString(text, cursor);
    keys.push(JSON.parse(text.slice(cursor, keyEnd)) as string);
    cursor = skipWhitespace(text, keyEnd);
    if (text[cursor] !== ":") fail("body_json_invalid", "Objeto JSON inválido.");
    cursor = skipJsonValue(text, skipWhitespace(text, cursor + 1));
    cursor = skipWhitespace(text, cursor);
    if (text[cursor] === "}") return keys;
    if (text[cursor] !== ",") fail("body_json_invalid", "Objeto JSON inválido.");
    cursor += 1;
  }
}

function skipJsonValue(text: string, start: number) {
  if (text[start] === '"') return skipJsonString(text, start);
  if (text[start] === "{" || text[start] === "[") {
    const opening = text[start], closing = opening === "{" ? "}" : "]";
    let depth = 1, cursor = start + 1;
    while (cursor < text.length && depth > 0) {
      if (text[cursor] === '"') { cursor = skipJsonString(text, cursor); continue; }
      if (text[cursor] === opening) depth += 1;
      else if (text[cursor] === closing) depth -= 1;
      cursor += 1;
    }
    return cursor;
  }
  let cursor = start;
  while (cursor < text.length && text[cursor] !== "," && text[cursor] !== "}") cursor += 1;
  return cursor;
}

function skipJsonString(text: string, start: number) {
  let cursor = start + 1;
  while (cursor < text.length) {
    if (text[cursor] === "\\") { cursor += 2; continue; }
    if (text[cursor] === '"') return cursor + 1;
    cursor += 1;
  }
  return cursor;
}

function skipWhitespace(text: string, start: number) { let cursor = start; while (/\s/.test(text[cursor] ?? "")) cursor += 1; return cursor; }

function rejectSensitiveData(value: unknown, field = "", depth = 0): void {
  if (depth > 8) fail("body_depth_invalid", "Payload excede a profundidade permitida.");
  if (/(?:pan|cvv|cvc|track|magnetic|pin(?:_?block)?|card_?number|numero_?cartao|full_?card)/i.test(field)) fail("sensitive_data", "Dados sensíveis de cartão não são aceitos.");
  if (typeof value === "string") {
    const cryptographicField = field === "referenceHash" || field === "evidenceHash" || field === "nonce";
    if ((!cryptographicField && containsLuhnPan(value)) || /(?:^|[^a-z])(?:cvv|cvc|pin|track\s*[12])(?:[^a-z]|$)|;[0-9]{12,19}=/i.test(value)) fail("sensitive_data", "Dados sensíveis de cartão não são aceitos.");
  }
  if (Array.isArray(value)) { for (const item of value) rejectSensitiveData(item, field, depth + 1); return; }
  if (value && typeof value === "object") for (const [name, item] of Object.entries(value as Record<string, unknown>)) rejectSensitiveData(item, name, depth + 1);
}

export function containsLuhnPan(value: string) {
  const normalized = value.normalize("NFKC");
  for (const match of normalized.matchAll(/[0-9](?:[^A-Za-z0-9]*[0-9])+/g)) {
    const digits = match[0].replace(/[^0-9]/g, "");
    if (digits.length < 12 || digits.length > 19) continue;
    let sum = 0, alternate = false;
    for (let index = digits.length - 1; index >= 0; index -= 1) { let digit = Number(digits[index]); if (alternate) { digit *= 2; if (digit > 9) digit -= 9; } sum += digit; alternate = !alternate; }
    if (sum % 10 === 0) return true;
  }
  return false;
}

function requiredHeader(headers: ReadonlyMap<string, string>, name: string) { const value = headers.get(name); if (!value) fail("header_missing", `Header obrigatório ausente: ${name}.`); return value; }
function headerIdentifier(value: unknown, errorCode: string) { if (typeof value !== "string" || !/^[A-Za-z][A-Za-z0-9._:-]{2,79}$/.test(value)) fail(errorCode, "Identificador de header inválido."); return value; }
function epochSeconds(value: string) { if (!/^(?:0|[1-9][0-9]{0,10})$/.test(value)) fail("timestamp_invalid", "Timestamp autenticado inválido."); const result = Number(value); if (!Number.isSafeInteger(result) || result < 0 || result > 253_402_300_799) fail("timestamp_invalid", "Timestamp autenticado inválido."); return result; }
function signatureBytes(value: string) { if (!/^sha256=[0-9a-f]{64}$/.test(value)) fail("signature_format_invalid", "Formato da assinatura inválido.", 401); return Buffer.from(value.slice(7), "hex"); }
function opaqueIdentifier(value: unknown, errorCode: string, minimum: number, maximum: number) { if (typeof value !== "string" || value.length < minimum || value.length > maximum || !/^[A-Za-z0-9._:@/-]+$/.test(value) || containsLuhnPan(value)) fail(errorCode, "Identificador opaco inválido."); return value; }
function base64Url(value: unknown, errorCode: string, minimum: number, maximum: number) { if (typeof value !== "string" || value.length < minimum || value.length > maximum || !/^[A-Za-z0-9_-]+$/.test(value)) fail(errorCode, "Nonce inválido."); return value; }
function providerCode(value: unknown) { return lowerCode(value, "provider_invalid", 2, 80); }
function lowerCode(value: unknown, errorCode: string, minimum: number, maximum: number) { if (typeof value !== "string" || value.length < minimum || value.length > maximum || !/^[a-z][a-z0-9._:-]*$/.test(value)) fail(errorCode, "Código inválido."); return value; }
function choice<const T extends readonly string[]>(value: unknown, allowed: T, errorCode: string): T[number] { if (typeof value !== "string" || !allowed.includes(value)) fail(errorCode, "Valor enumerado inválido."); return value as T[number]; }
function keyedHash(value: unknown, errorCode: string) { if (typeof value !== "string" || !/^hmac-sha256:v[1-9][0-9]*:[0-9a-f]{64}$/.test(value)) fail(errorCode, "Hash autenticado inválido."); return value; }
function hexHash(value: unknown, errorCode: string) { if (typeof value !== "string" || !/^[0-9a-f]{64}$/.test(value)) fail(errorCode, "Hash inválido."); return value; }
function currencyCode(value: unknown) { if (typeof value !== "string" || !/^[A-Z]{3}$/.test(value)) fail("currency_invalid", "Moeda inválida."); return value; }
function decimalBigInt(value: unknown, errorCode: string) { if (typeof value !== "string" || !/^[1-9][0-9]{0,18}$/.test(value)) fail(errorCode, "Sequência inválida."); const result = BigInt(value); if (result > BigInt("9223372036854775807")) fail(errorCode, "Sequência inválida."); return result; }
function canonicalIsoDate(value: unknown, errorCode: string) { if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)) fail(errorCode, "Data ISO inválida."); const result = new Date(value); if (!Number.isFinite(result.valueOf()) || result.toISOString() !== value) fail(errorCode, "Data ISO inválida."); return result; }
function boundedInteger(value: unknown, minimum: number, maximum: number, errorCode: string) { if (!Number.isSafeInteger(value) || Object.is(value, -0) || (value as number) < minimum || (value as number) > maximum) fail(errorCode, "Inteiro fora do limite."); return value as number; }
function validDate(value: Date, errorCode: string) { if (!(value instanceof Date) || !Number.isFinite(value.valueOf())) fail(errorCode, "Data inválida."); return value; }
function sha256(value: Uint8Array | string) { return createHash("sha256").update(value).digest("hex"); }
function canonicalJson(value: unknown): string { if (typeof value === "bigint") return JSON.stringify(value.toString()); if (value instanceof Date) return JSON.stringify(value.toISOString()); if (value === null || typeof value !== "object") return JSON.stringify(value); if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`; const record = value as Record<string, unknown>; return `{${Object.keys(record).sort().map(key => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(",")}}`; }
function fail(code: string, message: string, status = 400): never { throw new PosManualPaymentCallbackSecurityError(code, message, status); }
