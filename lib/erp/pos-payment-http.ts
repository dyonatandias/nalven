import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { containsPosPaymentPanInIdentifier, parsePosPaymentCallbackPayload, PosPaymentPersistenceError } from "@/lib/erp/pos-payment-persistence";

export const POS_PAYMENT_CALLBACK_MAX_BYTES = 65_536;
export const POS_PAYMENT_CALLBACK_MAX_AGE_SECONDS = 300;
export const POS_PAYMENT_JOB_LIMITS = Object.freeze({ defaultOrganizationLimit: 20, maximumOrganizationLimit: 100, defaultItemLimit: 25, maximumItemLimit: 100 });

export class PosPaymentHttpError extends Error {
  constructor(message: string, public readonly status: number) {
    super(message);
    this.name = "PosPaymentHttpError";
  }
}

export function assertPosPaymentJobAuthorization(request: Request, expectedToken = process.env.NALVEN_INTERNAL_JOB_TOKEN || "") {
  const authorization = request.headers.get("authorization") || "", match = /^Bearer ([\x21-\x7e]{32,512})$/.exec(authorization);
  const validExpected = /^[\x21-\x7e]{32,512}$/.test(expectedToken);
  const expected = createHash("sha256").update(expectedToken, "utf8").digest(), received = createHash("sha256").update(match?.[1] || "", "utf8").digest();
  if (!validExpected || !match || !timingSafeEqual(expected, received)) throw new PosPaymentHttpError("Não autorizado.", 401);
}

export async function verifyAndParsePosPaymentCallback(request: Request, provider: string, candidates: Array<{ keyId: string; secret: string }>, now = new Date()) {
  const contentType = request.headers.get("content-type")?.toLowerCase() || "";
  if (!contentType.startsWith("application/json")) throw new PosPaymentHttpError("Callback aceita somente JSON.", 415);
  const declared = request.headers.get("content-length");
  if (declared != null && (!Number.isSafeInteger(Number(declared)) || Number(declared) < 0 || Number(declared) > POS_PAYMENT_CALLBACK_MAX_BYTES)) throw new PosPaymentHttpError("Callback excede o limite permitido.", 413);
  const timestamp = request.headers.get("x-pos-timestamp") || "", eventId = request.headers.get("x-pos-event-id") || "", keyId = request.headers.get("x-pos-key-id") || "", signature = request.headers.get("x-pos-signature") || "";
  if (!/^\d{10}$/.test(timestamp) || !/^[A-Za-z0-9._:-]{8,160}$/.test(eventId) || !/^[A-Za-z0-9._:-]{1,160}$/.test(keyId) || !/^sha256=[0-9a-f]{64}$/.test(signature)) throw new PosPaymentHttpError("Cabeçalhos do callback inválidos.", 401);
  if (containsPosPaymentPanInIdentifier(eventId) || containsPosPaymentPanInIdentifier(keyId)) throw new PosPaymentHttpError("Cabeçalhos do callback contêm dados de cartão proibidos.", 400);
  const age = Math.abs(Math.floor(now.valueOf() / 1_000) - Number(timestamp));
  if (!Number.isFinite(age) || age > POS_PAYMENT_CALLBACK_MAX_AGE_SECONDS) throw new PosPaymentHttpError("Callback fora da janela anti-replay.", 401);
  const matchingCandidates = candidates.filter(item => item.keyId === keyId && Buffer.byteLength(item.secret, "utf8") >= 32);
  if (!matchingCandidates.length) throw new PosPaymentHttpError("Chave do callback não autorizada.", 401);
  const raw = await limitedText(request, POS_PAYMENT_CALLBACK_MAX_BYTES);
  const signatureValid = matchingCandidates.some(candidate => constantEqual(`sha256=${createHmac("sha256", candidate.secret).update(`${timestamp}.${eventId}.${raw}`, "utf8").digest("hex")}`, signature));
  if (!signatureValid) throw new PosPaymentHttpError("Assinatura do callback inválida.", 401);
  let body: unknown;
  try { body = JSON.parse(raw); } catch { throw new PosPaymentHttpError("JSON do callback inválido.", 400); }
  if (!body || typeof body !== "object" || Array.isArray(body)) throw new PosPaymentHttpError("Payload do callback deve ser um objeto.", 400);
  try {
    return { eventId, keyId, payloadHash: createHash("sha256").update(raw, "utf8").digest("hex"), input: { ...parsePosPaymentCallbackPayload(body as Record<string, unknown>), provider } };
  } catch (error) {
    if (error instanceof PosPaymentPersistenceError) throw new PosPaymentHttpError(error.message, error.status);
    throw error;
  }
}

export function parsePosPaymentMaintenanceJobInput(body: Record<string, unknown>) {
  onlyKeys(body, ["action", "organizationLimit", "itemLimit", "afterOrganizationId"]);
  if (body.action !== "payment.maintenance") throw new PosPaymentHttpError("Ação interna inválida.", 400);
  return {
    action: "payment.maintenance" as const,
    organizationLimit: bounded(body.organizationLimit, POS_PAYMENT_JOB_LIMITS.defaultOrganizationLimit, POS_PAYMENT_JOB_LIMITS.maximumOrganizationLimit, "Limite de organizações"),
    itemLimit: bounded(body.itemLimit, POS_PAYMENT_JOB_LIMITS.defaultItemLimit, POS_PAYMENT_JOB_LIMITS.maximumItemLimit, "Limite de itens"),
    afterOrganizationId: body.afterOrganizationId == null || body.afterOrganizationId === "" ? null : identifier(body.afterOrganizationId, "Cursor", 160),
  };
}

export function parsePosPaymentOutboxClaim(body: Record<string, unknown>) {
  onlyKeys(body, ["action", "workerId", "limit", "leaseSeconds"]);
  if (body.action !== "outbox.claim") throw new PosPaymentHttpError("Ação do worker inválida.", 400);
  return {
    action: "outbox.claim" as const,
    workerId: identifier(body.workerId, "Worker", 120),
    limit: bounded(body.limit, POS_PAYMENT_WORK_DEFAULTS.limit, POS_PAYMENT_WORK_DEFAULTS.maximumLimit, "Limite de claims"),
    leaseSeconds: boundedRange(body.leaseSeconds, POS_PAYMENT_WORK_DEFAULTS.leaseSeconds, 15, POS_PAYMENT_WORK_DEFAULTS.maximumLeaseSeconds, "Lease"),
  };
}

const POS_PAYMENT_WORK_DEFAULTS = { limit: 25, maximumLimit: 100, leaseSeconds: 60, maximumLeaseSeconds: 300 };

async function limitedText(request: Request, maximum: number) {
  if (!request.body) throw new PosPaymentHttpError("Payload do callback ausente.", 400);
  const reader = request.body.getReader(), chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > maximum) { await reader.cancel("payload limit exceeded"); throw new PosPaymentHttpError("Callback excede o limite permitido.", 413); }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  const bytes = new Uint8Array(length); let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  try { return new TextDecoder("utf-8", { fatal: true }).decode(bytes); }
  catch { throw new PosPaymentHttpError("Callback não possui UTF-8 válido.", 400); }
}

function bounded(value: unknown, fallback: number, maximum: number, label: string) { if (value == null) return fallback; if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1 || value > maximum) throw new PosPaymentHttpError(`${label} deve estar entre 1 e ${maximum}.`, 400); return value; }
function boundedRange(value: unknown, fallback: number, minimum: number, maximum: number, label: string) { if (value == null) return fallback; if (typeof value !== "number" || !Number.isSafeInteger(value) || value < minimum || value > maximum) throw new PosPaymentHttpError(`${label} deve estar entre ${minimum} e ${maximum}.`, 400); return value; }
function identifier(value: unknown, label: string, maximum: number) { if (typeof value !== "string" || value.length < 1 || value.length > maximum || !/^[A-Za-z0-9._:-]+$/.test(value)) throw new PosPaymentHttpError(`${label} inválido.`, 400); return value; }
function onlyKeys(body: Record<string, unknown>, allowed: readonly string[]) { const extra = Object.keys(body).find(key => !allowed.includes(key)); if (extra) throw new PosPaymentHttpError(`Campo não permitido: ${extra}.`, 400); }
function constantEqual(left: string, right: string) { const a = Buffer.from(left), b = Buffer.from(right); return a.length === b.length && timingSafeEqual(a, b); }
