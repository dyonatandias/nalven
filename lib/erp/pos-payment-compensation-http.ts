import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { parsePosPaymentCompensationObservation, PosPaymentCompensationError } from "@/lib/erp/pos-payment-compensations";
import { containsPosPaymentPanInIdentifier } from "@/lib/erp/pos-payment-persistence";

export const POS_PAYMENT_COMPENSATION_CALLBACK_MAX_BYTES = 65_536;
export const POS_PAYMENT_COMPENSATION_CALLBACK_MAX_AGE_SECONDS = 300;
export const POS_PAYMENT_COMPENSATION_JOB_LIMITS = Object.freeze({ defaultOrganizationLimit: 20, maximumOrganizationLimit: 100, defaultItemLimit: 25, maximumItemLimit: 100 });

export class PosPaymentCompensationHttpError extends Error {
  constructor(message: string, public readonly status: number) {
    super(message);
    this.name = "PosPaymentCompensationHttpError";
  }
}

export async function verifyAndParsePosPaymentCompensationCallback(request: Request, provider: string, candidates: Array<{ keyId: string; secret: string }>, now = new Date()) {
  const contentType = request.headers.get("content-type")?.toLowerCase() || "";
  if (!contentType.startsWith("application/json")) throw new PosPaymentCompensationHttpError("Callback aceita somente JSON.", 415);
  const declared = request.headers.get("content-length");
  if (declared != null && (!Number.isSafeInteger(Number(declared)) || Number(declared) < 0 || Number(declared) > POS_PAYMENT_COMPENSATION_CALLBACK_MAX_BYTES)) throw new PosPaymentCompensationHttpError("Callback excede o limite permitido.", 413);
  const timestamp = request.headers.get("x-pos-timestamp") || "";
  const eventId = request.headers.get("x-pos-event-id") || "";
  const keyId = request.headers.get("x-pos-key-id") || "";
  const signature = request.headers.get("x-pos-signature") || "";
  if (!/^\d{10}$/.test(timestamp) || !/^[A-Za-z0-9._:-]{8,160}$/.test(eventId) || !/^[A-Za-z0-9._:-]{1,160}$/.test(keyId) || !/^sha256=[0-9a-f]{64}$/.test(signature)) throw new PosPaymentCompensationHttpError("Cabeçalhos do callback inválidos.", 401);
  if (containsPosPaymentPanInIdentifier(eventId) || containsPosPaymentPanInIdentifier(keyId)) throw new PosPaymentCompensationHttpError("Cabeçalhos do callback contêm dados de cartão proibidos.", 400);
  const age = Math.abs(Math.floor(now.valueOf() / 1_000) - Number(timestamp));
  if (!Number.isFinite(age) || age > POS_PAYMENT_COMPENSATION_CALLBACK_MAX_AGE_SECONDS) throw new PosPaymentCompensationHttpError("Callback fora da janela anti-replay.", 401);
  const matchingCandidates = candidates.filter((item) => item.keyId === keyId && Buffer.byteLength(item.secret, "utf8") >= 32);
  if (!matchingCandidates.length) throw new PosPaymentCompensationHttpError("Chave do callback não autorizada.", 401);
  const raw = await limitedText(request, POS_PAYMENT_COMPENSATION_CALLBACK_MAX_BYTES);
  const signatureValid = matchingCandidates.some((candidate) => constantEqual(`sha256=${createHmac("sha256", candidate.secret).update(`pos-compensation.v1.${timestamp}.${eventId}.${raw}`, "utf8").digest("hex")}`, signature));
  if (!signatureValid) throw new PosPaymentCompensationHttpError("Assinatura do callback inválida.", 401);
  let body: unknown;
  try { body = JSON.parse(raw); }
  catch { throw new PosPaymentCompensationHttpError("JSON do callback inválido.", 400); }
  if (!body || typeof body !== "object" || Array.isArray(body)) throw new PosPaymentCompensationHttpError("Payload do callback deve ser um objeto.", 400);
  rejectPersistablePan(body);
  try {
    return { eventId, keyId, payloadHash: createHash("sha256").update(raw, "utf8").digest("hex"), input: { ...parsePosPaymentCompensationObservation(body as Record<string, unknown>), provider } };
  } catch (error) {
    if (error instanceof PosPaymentCompensationError) throw new PosPaymentCompensationHttpError(error.message, error.status);
    throw error;
  }
}

export function parsePosPaymentCompensationOutboxClaim(body: Record<string, unknown>) {
  onlyKeys(body, ["action", "workerId", "limit", "leaseSeconds"]);
  if (body.action !== "compensation.outbox.claim") throw new PosPaymentCompensationHttpError("Ação do worker compensatório inválida.", 400);
  return {
    workerId: identifier(body.workerId, "Worker", 3, 120),
    limit: bounded(body.limit, 25, 1, 100, "Limite de claims"),
    leaseSeconds: bounded(body.leaseSeconds, 60, 15, 300, "Lease"),
  };
}

export function parsePosPaymentCompensationMaintenanceInput(body: Record<string, unknown>) {
  onlyKeys(body, ["action", "organizationLimit", "itemLimit", "afterOrganizationId"]);
  if (body.action !== "compensation.maintenance") throw new PosPaymentCompensationHttpError("Ação interna compensatória inválida.", 400);
  return {
    organizationLimit: bounded(body.organizationLimit, POS_PAYMENT_COMPENSATION_JOB_LIMITS.defaultOrganizationLimit, 1, POS_PAYMENT_COMPENSATION_JOB_LIMITS.maximumOrganizationLimit, "Limite de organizações"),
    itemLimit: bounded(body.itemLimit, POS_PAYMENT_COMPENSATION_JOB_LIMITS.defaultItemLimit, 1, POS_PAYMENT_COMPENSATION_JOB_LIMITS.maximumItemLimit, "Limite de itens"),
    afterOrganizationId: body.afterOrganizationId == null || body.afterOrganizationId === "" ? null : identifier(body.afterOrganizationId, "Cursor", 1, 160),
  };
}

async function limitedText(request: Request, maximum: number) {
  if (!request.body) throw new PosPaymentCompensationHttpError("Payload do callback ausente.", 400);
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > maximum) { await reader.cancel("payload limit exceeded"); throw new PosPaymentCompensationHttpError("Callback excede o limite permitido.", 413); }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  try { return new TextDecoder("utf-8", { fatal: true }).decode(bytes); }
  catch { throw new PosPaymentCompensationHttpError("Callback não possui UTF-8 válido.", 400); }
}

function rejectPersistablePan(value: unknown, depth = 0, fieldName = "") {
  if (depth > 8) throw new PosPaymentCompensationHttpError("Payload excede a profundidade permitida.", 400);
  if (typeof value === "string" && /(?:reference|operation|failure|event|key)/i.test(fieldName) && containsPosPaymentPanInIdentifier(value)) throw new PosPaymentCompensationHttpError("Callback contém dados de cartão proibidos.", 400);
  if (Array.isArray(value)) { for (const item of value) rejectPersistablePan(item, depth + 1, fieldName); return; }
  if (!value || typeof value !== "object") return;
  for (const [field, item] of Object.entries(value as Record<string, unknown>)) {
    if (/(?:pan|cvv|cvc|track|pin_?block|card_?number|numero_?cartao|full_?card)/i.test(field)) throw new PosPaymentCompensationHttpError("Callback contém dados de cartão proibidos.", 400);
    rejectPersistablePan(item, depth + 1, field);
  }
}

function onlyKeys(body: Record<string, unknown>, allowed: readonly string[]) { const extra = Object.keys(body).find((key) => !allowed.includes(key)); if (extra) throw new PosPaymentCompensationHttpError(`Campo não permitido: ${extra}.`, 400); }
function identifier(value: unknown, label: string, minimum: number, maximum: number) { if (typeof value !== "string") throw new PosPaymentCompensationHttpError(`${label} inválido.`, 400); const result = value.normalize("NFKC").trim(); if (result.length < minimum || result.length > maximum || !/^[A-Za-z0-9._:-]+$/.test(result) || containsPosPaymentPanInIdentifier(result)) throw new PosPaymentCompensationHttpError(`${label} inválido.`, 400); return result; }
function bounded(value: unknown, fallback: number, minimum: number, maximum: number, label: string) { if (value == null) return fallback; if (typeof value !== "number" || !Number.isSafeInteger(value) || value < minimum || value > maximum) throw new PosPaymentCompensationHttpError(`${label} deve estar entre ${minimum} e ${maximum}.`, 400); return value; }
function constantEqual(left: string, right: string) { const a = Buffer.from(left), b = Buffer.from(right); return a.length === b.length && timingSafeEqual(a, b); }
