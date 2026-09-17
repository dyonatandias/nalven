import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import {
  POS_FISCAL_WORK_LIMITS,
  PosFiscalPersistenceError,
  type PosFiscalCallbackInput,
  type PosFiscalOutboxCompletion,
  type PosFiscalWorkerArtifact,
} from "@/lib/erp/pos-fiscal-persistence";

export const POS_FISCAL_CALLBACK_MAX_BYTES = 131_072;
export const POS_FISCAL_CALLBACK_MAX_AGE_SECONDS = 300;

export class PosFiscalHttpError extends Error {
  constructor(message: string, public readonly status: number) {
    super(message);
    this.name = "PosFiscalHttpError";
  }
}

export function assertPosFiscalJobAuthorization(request: Request, expectedToken = process.env.NALVEN_INTERNAL_JOB_TOKEN || "") {
  const authorization = request.headers.get("authorization") || "";
  const match = /^Bearer ([\x21-\x7e]{32,512})$/.exec(authorization);
  const validExpected = /^[\x21-\x7e]{32,512}$/.test(expectedToken);
  const expected = createHash("sha256").update(expectedToken, "utf8").digest();
  const received = createHash("sha256").update(match?.[1] || "", "utf8").digest();
  if (!validExpected || !match || !timingSafeEqual(expected, received)) throw new PosFiscalHttpError("Não autorizado.", 401);
}

export async function verifyAndParsePosFiscalCallback(
  request: Request,
  provider: string,
  candidates: Array<{ keyId: string; secret: string }>,
  now = new Date(),
) {
  const contentType = request.headers.get("content-type")?.toLowerCase() || "";
  if (!contentType.startsWith("application/json")) throw new PosFiscalHttpError("Callback fiscal aceita somente JSON.", 415);
  const declared = request.headers.get("content-length");
  if (declared != null && (!Number.isSafeInteger(Number(declared)) || Number(declared) < 0 || Number(declared) > POS_FISCAL_CALLBACK_MAX_BYTES)) throw new PosFiscalHttpError("Callback fiscal excede o limite permitido.", 413);
  const timestamp = request.headers.get("x-pos-timestamp") || "";
  const eventId = request.headers.get("x-pos-event-id") || "";
  const keyId = request.headers.get("x-pos-key-id") || "";
  const signature = request.headers.get("x-pos-signature") || "";
  if (!/^\d{10}$/.test(timestamp) || !/^[A-Za-z0-9._:-]{8,160}$/.test(eventId) || !/^[A-Za-z0-9._:-]{1,160}$/.test(keyId) || !/^sha256=[0-9a-f]{64}$/.test(signature)) throw new PosFiscalHttpError("Cabeçalhos do callback fiscal inválidos.", 401);
  const age = Math.abs(Math.floor(now.valueOf() / 1_000) - Number(timestamp));
  if (!Number.isFinite(age) || age > POS_FISCAL_CALLBACK_MAX_AGE_SECONDS) throw new PosFiscalHttpError("Callback fiscal fora da janela anti-replay.", 401);
  const matching = candidates.filter((candidate) => candidate.keyId === keyId && Buffer.byteLength(candidate.secret, "utf8") >= 32);
  if (!matching.length) throw new PosFiscalHttpError("Chave do callback fiscal não autorizada.", 401);
  const raw = await limitedText(request, POS_FISCAL_CALLBACK_MAX_BYTES);
  const validSignature = matching.some((candidate) => constantEqual(`sha256=${createHmac("sha256", candidate.secret).update(`${timestamp}.${eventId}.${raw}`, "utf8").digest("hex")}`, signature));
  if (!validSignature) throw new PosFiscalHttpError("Assinatura do callback fiscal inválida.", 401);
  let parsed: unknown;
  try { parsed = JSON.parse(raw); } catch { throw new PosFiscalHttpError("JSON do callback fiscal inválido.", 400); }
  const body = record(parsed, "Callback fiscal");
  const documentId = identifier(body.documentId, "Documento fiscal", 1, 160, true);
  const resultBody = { ...body };
  delete resultBody.documentId;
  const completion = parsePosFiscalOutboxCompletion({ action: "outbox.complete", attemptId: documentId, claimToken: `callback:${eventId}`, result: { kind: "result", ...resultBody } });
  if (completion.result.kind !== "result") throw new PosFiscalHttpError("Resultado do callback fiscal inválido.", 400);
  const input: PosFiscalCallbackInput = { documentId, ...completion.result };
  delete (input as Partial<{ kind: string }>).kind;
  return { provider, eventId, keyId, payloadHash: createHash("sha256").update(raw, "utf8").digest("hex"), input };
}

export function parsePosFiscalOutboxClaim(body: Record<string, unknown>) {
  onlyKeys(body, ["action", "workerId", "limit", "leaseSeconds"]);
  if (body.action !== "outbox.claim") throw new PosFiscalHttpError("Ação do worker fiscal inválida.", 400);
  return {
    action: "outbox.claim" as const,
    workerId: identifier(body.workerId, "Worker", 3, 120),
    limit: integer(body.limit, "Limite", 1, POS_FISCAL_WORK_LIMITS.maximumBatchSize, POS_FISCAL_WORK_LIMITS.defaultBatchSize),
    leaseSeconds: integer(body.leaseSeconds, "Lease", 15, POS_FISCAL_WORK_LIMITS.maximumLeaseSeconds, POS_FISCAL_WORK_LIMITS.defaultLeaseSeconds),
  };
}

export function parsePosFiscalOutboxCompletion(body: Record<string, unknown>): PosFiscalOutboxCompletion {
  onlyKeys(body, ["action", "attemptId", "claimToken", "result"]);
  if (body.action !== "outbox.complete") throw new PosFiscalHttpError("Ação do worker fiscal inválida.", 400);
  const result = record(body.result, "Resultado fiscal");
  const kind = choice(result.kind, ["result", "unknown", "known_failure"] as const, "Tipo de resultado");
  if (kind === "known_failure" || kind === "unknown") {
    onlyKeys(result, kind === "known_failure" ? ["kind", "retryable", "failureCode", "failureMessage"] : ["kind", "failureCode", "failureMessage"]);
    return {
      attemptId: identifier(body.attemptId, "Tentativa", 1, 160, true),
      claimToken: identifier(body.claimToken, "Claim", 16, 320, true),
      result: {
        kind,
        ...(kind === "known_failure" ? { retryable: result.retryable === true } : {}),
        failureCode: identifier(result.failureCode, "Código da falha", 1, 80, true),
        failureMessage: nullableText(result.failureMessage, "Mensagem da falha", 500),
      } as PosFiscalOutboxCompletion["result"],
    };
  }
  onlyKeys(result, ["kind", "provider", "reference", "state", "accessKey", "protocol", "rejectionCode", "rejectionMessage", "providerSequence", "occurredAt", "totalCents", "currency", "artifacts"]);
  const artifacts = array(result.artifacts, "Artefatos fiscais");
  if (artifacts.length > 7) throw new PosFiscalHttpError("Artefatos fiscais excedem o limite.", 400);
  return {
    attemptId: identifier(body.attemptId, "Tentativa", 1, 160, true),
    claimToken: identifier(body.claimToken, "Claim", 16, 320, true),
    result: {
      kind,
      provider: identifier(result.provider, "Provider", 2, 80),
      reference: identifier(result.reference, "Referência", 1, 160, true),
      state: choice(result.state, ["processing", "authorized", "rejected", "contingency", "cancelled", "unknown"] as const, "Estado fiscal"),
      accessKey: nullablePattern(result.accessKey, "Chave de acesso", /^\d{44}$/, 44),
      protocol: nullableText(result.protocol, "Protocolo", 100),
      rejectionCode: nullableText(result.rejectionCode, "Código de rejeição", 40),
      rejectionMessage: nullableText(result.rejectionMessage, "Mensagem de rejeição", 500),
      providerSequence: optionalBigInt(result.providerSequence, "Sequência do provider"),
      occurredAt: date(result.occurredAt, "Data do provider"),
      totalCents: integer(result.totalCents, "Total fiscal", 1, 2_147_483_647),
      currency: choice(result.currency, ["BRL"] as const, "Moeda"),
      artifacts: artifacts.map(parseArtifact),
    },
  };
}

export function parsePosFiscalMaintenanceJobInput(body: Record<string, unknown>) {
  onlyKeys(body, ["action", "organizationLimit", "itemLimit", "afterOrganizationId"]);
  if (body.action !== "fiscal.maintenance") throw new PosFiscalHttpError("Ação interna fiscal inválida.", 400);
  return {
    action: "fiscal.maintenance" as const,
    organizationLimit: integer(body.organizationLimit, "Limite de organizações", 1, 100, 20),
    itemLimit: integer(body.itemLimit, "Limite de itens", 1, POS_FISCAL_WORK_LIMITS.maximumBatchSize, POS_FISCAL_WORK_LIMITS.defaultBatchSize),
    afterOrganizationId: body.afterOrganizationId == null || body.afterOrganizationId === "" ? null : identifier(body.afterOrganizationId, "Cursor", 1, 160),
  };
}

function parseArtifact(value: unknown): PosFiscalWorkerArtifact {
  const artifact = record(value, "Artefato fiscal");
  onlyKeys(artifact, ["type", "providerArtifactId", "storageKey", "mimeType", "sizeBytes", "sha256", "encryptionKeyId", "retentionUntil"]);
  return {
    type: choice(artifact.type, ["authorized_xml", "contingency_xml", "authorization_protocol", "cancellation_protocol", "danfe", "qr", "provider_response_redacted"] as const, "Tipo de artefato"),
    providerArtifactId: nullableText(artifact.providerArtifactId, "Artefato do provider", 160),
    storageKey: identifier(artifact.storageKey, "Chave de armazenamento", 8, 500, true),
    mimeType: choice(artifact.mimeType, ["application/xml", "text/xml", "application/pdf", "application/json", "text/plain", "image/png"] as const, "MIME do artefato"),
    sizeBytes: integer(artifact.sizeBytes, "Tamanho do artefato", 1, 52_428_800),
    sha256: pattern(artifact.sha256, "Hash do artefato", /^[0-9a-f]{64}$/, 64),
    encryptionKeyId: nullableText(artifact.encryptionKeyId, "Chave de criptografia", 160),
    retentionUntil: artifact.retentionUntil == null ? null : date(artifact.retentionUntil, "Retenção do artefato"),
  };
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new PosFiscalHttpError(`${label} deve ser um objeto.`, 400);
  return value as Record<string, unknown>;
}

function array(value: unknown, label: string) {
  if (!Array.isArray(value)) throw new PosFiscalHttpError(`${label} devem ser uma lista.`, 400);
  return value;
}

function onlyKeys(body: Record<string, unknown>, allowed: readonly string[]) {
  const extra = Object.keys(body).find((key) => !allowed.includes(key));
  if (extra) throw new PosFiscalHttpError(`Campo não permitido: ${extra}.`, 400);
}

function identifier(value: unknown, label: string, minimum: number, maximum: number, punctuation = false) {
  if (typeof value !== "string") throw new PosFiscalHttpError(`${label} inválido.`, 400);
  const result = value.normalize("NFKC").trim();
  const expression = punctuation ? /^[^\u0000-\u001f]+$/ : /^[A-Za-z0-9._:-]+$/;
  if (result.length < minimum || result.length > maximum || !expression.test(result)) throw new PosFiscalHttpError(`${label} inválido.`, 400);
  return result;
}

function nullableText(value: unknown, label: string, maximum: number) {
  if (value == null || value === "") return null;
  return identifier(value, label, 1, maximum, true);
}

function pattern(value: unknown, label: string, expression: RegExp, maximum: number) {
  if (typeof value !== "string" || value.length > maximum || !expression.test(value)) throw new PosFiscalHttpError(`${label} inválido.`, 400);
  return value;
}

function nullablePattern(value: unknown, label: string, expression: RegExp, maximum: number) {
  return value == null || value === "" ? null : pattern(value, label, expression, maximum);
}

function integer(value: unknown, label: string, minimum: number, maximum: number, fallback?: number) {
  if (value == null && fallback != null) return fallback;
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < minimum || value > maximum) throw new PosFiscalHttpError(`${label} inválido.`, 400);
  return value;
}

function optionalBigInt(value: unknown, label: string) {
  if (value == null || value === "") return null;
  if (typeof value !== "number" && typeof value !== "string") throw new PosFiscalHttpError(`${label} inválida.`, 400);
  if (!/^\d{1,18}$/.test(String(value))) throw new PosFiscalHttpError(`${label} inválida.`, 400);
  const result = BigInt(String(value));
  if (result <= BigInt(0) || result > BigInt(Number.MAX_SAFE_INTEGER)) throw new PosFiscalHttpError(`${label} inválida.`, 400);
  return result;
}

function date(value: unknown, label: string) {
  if (typeof value !== "string" || value.length > 40) throw new PosFiscalHttpError(`${label} inválida.`, 400);
  const result = new Date(value);
  if (Number.isNaN(result.valueOf()) || result.toISOString() !== value) throw new PosFiscalHttpError(`${label} deve usar ISO-8601 canônico.`, 400);
  return result;
}

function choice<const T extends readonly string[]>(value: unknown, choices: T, label: string): T[number] {
  if (typeof value !== "string" || !choices.includes(value)) throw new PosFiscalHttpError(`${label} inválido.`, 400);
  return value as T[number];
}

async function limitedText(request: Request, maximum: number) {
  if (!request.body) throw new PosFiscalHttpError("Payload do callback fiscal ausente.", 400);
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > maximum) {
        await reader.cancel("payload limit exceeded");
        throw new PosFiscalHttpError("Callback fiscal excede o limite permitido.", 413);
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  try { return new TextDecoder("utf-8", { fatal: true }).decode(bytes); }
  catch { throw new PosFiscalHttpError("Callback fiscal não possui UTF-8 válido.", 400); }
}

function constantEqual(left: string, right: string) {
  const first = Buffer.from(left);
  const second = Buffer.from(right);
  return first.length === second.length && timingSafeEqual(first, second);
}

export function fiscalHttpFailure(error: unknown) {
  if (error instanceof PosFiscalHttpError || error instanceof PosFiscalPersistenceError) return Response.json({ error: error.message }, { status: error.status, headers: { "cache-control": "no-store, max-age=0", expires: "0", pragma: "no-cache" } });
  return Response.json({ error: "Não foi possível processar o outbox fiscal." }, { status: 500, headers: { "cache-control": "no-store, max-age=0", expires: "0", pragma: "no-cache" } });
}
