import { createHash } from "node:crypto";

export const POS_OFFLINE_SUPPORT_MATRIX = {
  "terminal.heartbeat": "applied",
  "cart.draft.upsert": "applied",
  "cart.draft.discard": "applied",
  "session.open": "rejected",
  "session.close": "rejected",
  "cash.event": "rejected",
  "sale.commit": "rejected",
  "sale.cancel": "rejected",
  "return.create": "rejected",
  "payment.capture": "rejected",
  "payment.confirm": "rejected",
  "fiscal.issue": "rejected",
  "fiscal.authorize": "rejected",
} as const;

export type PosOfflineSupportedType = "terminal.heartbeat" | "cart.draft.upsert" | "cart.draft.discard";
export type PosOfflineFinalState = "applied" | "rejected" | "conflict";
export type PosOfflineJson = Record<string, unknown>;

export type PosOfflineSyncOperation = {
  operationId: string;
  sequence: bigint;
  type: string;
  occurredAt: Date;
  payload: PosOfflineJson;
  requestHash: string;
  supported: boolean;
};

export type PosOfflineReplayRecord = {
  terminalId: string;
  operationId: string;
  sequence: bigint;
  type: string;
  state: string;
  requestHash: string;
  response: unknown;
  conflict: unknown;
  processedAt: Date | null;
};

export type PosOfflineDraftRecord = { draftId: string; revision: number; state: string; payload: unknown };

export class PosOfflineSyncError extends Error {
  constructor(message: string, public readonly status = 422) {
    super(message);
    this.name = "PosOfflineSyncError";
  }
}

export function normalizePosOfflineSyncBatch(
  body: Record<string, unknown>,
  scope: { organizationId: string; terminalId: string },
  options: { now?: Date; maxPastMs?: number; maxFutureMs?: number } = {},
) {
  onlyKeys(body, ["action", "operations"], "Lote");
  if (body.action !== "sync.push") throw new PosOfflineSyncError("Ação de sincronização inválida.");
  if (!Array.isArray(body.operations) || !body.operations.length || body.operations.length > 50) throw new PosOfflineSyncError("Informe de uma a cinquenta operações offline.");
  const now = options.now ?? new Date();
  const configured = posOfflineSyncWindow();
  const window = {
    maxPastMs: options.maxPastMs ?? configured.maxPastMs,
    maxFutureMs: options.maxFutureMs ?? configured.maxFutureMs,
  };
  validateWindow(window.maxPastMs, window.maxFutureMs);
  const operations = body.operations.map((raw, index) => normalizeOperation(raw, index, scope, now, window));
  if (new Set(operations.map(item => item.operationId)).size !== operations.length) throw new PosOfflineSyncError("O lote contém operationIds repetidos.");
  if (new Set(operations.map(item => item.sequence.toString())).size !== operations.length) throw new PosOfflineSyncError("O lote contém sequências repetidas.");
  for (let index = 1; index < operations.length; index++) {
    if (operations[index].sequence <= operations[index - 1].sequence) throw new PosOfflineSyncError("As operações devem estar em sequência estritamente crescente.");
  }
  return operations;
}

export function normalizePosOfflinePull(body: Record<string, unknown>) {
  onlyKeys(body, ["action", "afterSequence", "catalogVersion", "permissionVersion"], "Pull");
  if (body.action !== "sync.pull") throw new PosOfflineSyncError("Ação de pull inválida.");
  return {
    afterSequence: nonnegativeSequenceValue(body.afterSequence, "Cursor de pull"),
    catalogVersion: optionalVersion(body.catalogVersion, "Versão do catálogo"),
    permissionVersion: optionalVersion(body.permissionVersion, "Versão de permissões"),
  };
}

export function normalizePosOfflineAck(body: Record<string, unknown>) {
  onlyKeys(body, ["action", "throughSequence"], "ACK");
  if (body.action !== "sync.ack") throw new PosOfflineSyncError("Ação de ACK inválida.");
  return { throughSequence: nonnegativeSequenceValue(body.throughSequence, "Cursor de ACK") };
}

export function hashPosOfflineSnapshot(purpose: "catalog" | "permissions", value: unknown) {
  return createHash("sha256").update(canonicalJson({ purpose: `pos.offline.${purpose}`, version: 1, value }), "utf8").digest("hex");
}

export function hashPosOfflineOperation(input: {
  organizationId: string;
  terminalId: string;
  operationId: string;
  sequence: bigint;
  type: string;
  occurredAt: Date;
  payload: PosOfflineJson;
}) {
  return createHash("sha256").update(canonicalJson({
    purpose: "pos.offline.sync",
    version: 1,
    organizationId: input.organizationId,
    terminalId: input.terminalId,
    operationId: input.operationId,
    sequence: input.sequence.toString(),
    type: input.type,
    occurredAt: input.occurredAt.toISOString(),
    payload: input.payload,
  }), "utf8").digest("hex");
}

export function finalizePosOfflineOperation(operation: PosOfflineSyncOperation): { state: "applied" | "rejected"; response: PosOfflineJson } {
  if (!operation.supported) {
    return {
      state: "rejected",
      response: {
        accepted: false,
        code: "offline_operation_not_supported",
        requiresOnline: true,
        message: "Esta operação exige processamento online autoritativo.",
      },
    };
  }
  if (operation.type === "terminal.heartbeat") {
    return { state: "applied", response: { accepted: true, type: operation.type } };
  }
  if (operation.type === "cart.draft.discard") {
    return { state: "applied", response: { accepted: true, type: operation.type, draftId: operation.payload.draftId, stored: true } };
  }
  return {
    state: "applied",
    response: {
      accepted: true,
      type: operation.type,
      draftId: operation.payload.draftId,
      stored: true,
      authoritative: false,
      requiresOnlineCommit: true,
    },
  };
}

export function planPosOfflineDraftMutation(operation: PosOfflineSyncOperation, current: PosOfflineDraftRecord | null): {
  state: "applied" | "conflict";
  response?: PosOfflineJson;
  conflict?: PosOfflineJson;
  projection?: { draftId: string; revision: number; state: "active" | "discarded"; payload: PosOfflineJson };
} {
  if (operation.type !== "cart.draft.upsert" && operation.type !== "cart.draft.discard") throw new PosOfflineSyncError("Operação não é uma mutação de rascunho.", 500);
  const draftId = String(operation.payload.draftId), baseRevision = Number(operation.payload.baseRevision), revision = Number(operation.payload.revision);
  const validNext = revision === baseRevision + 1 && (current ? current.revision === baseRevision : baseRevision === 0);
  if (!validNext) return {
    state: "conflict",
    conflict: {
      code: "draft_revision_conflict",
      draftId,
      clientBaseRevision: baseRevision,
      clientRevision: revision,
      serverRevision: current?.revision ?? 0,
      serverState: current?.state ?? "missing",
      requiresResolution: true,
    },
  };
  const discarded = operation.type === "cart.draft.discard";
  const payload = discarded ? { draftId, baseRevision, revision } : operation.payload;
  return {
    state: "applied",
    response: {
      accepted: true,
      type: operation.type,
      draftId,
      revision,
      stored: true,
      authoritative: false,
      requiresOnlineCommit: !discarded,
    },
    projection: { draftId, revision, state: discarded ? "discarded" : "active", payload },
  };
}

export function replayPosOfflineOperation(record: PosOfflineReplayRecord, operation: PosOfflineSyncOperation, terminalId: string) {
  if (record.terminalId !== terminalId || record.operationId !== operation.operationId || record.sequence !== operation.sequence || record.type !== operation.type || record.requestHash !== operation.requestHash) {
    throw new PosOfflineSyncError("O operationId já foi usado com outro contexto ou payload.", 409);
  }
  if (!record.processedAt || !["applied", "rejected", "conflict"].includes(record.state)) throw new PosOfflineSyncError("A operação offline ainda está em processamento.", 409);
  return {
    operationId: record.operationId,
    sequence: record.sequence.toString(),
    type: record.type,
    state: record.state as PosOfflineFinalState,
    response: record.response,
    conflict: record.conflict,
    replayed: true,
  };
}

export function posOfflineSyncWindow(env: Record<string, string | undefined> = process.env) {
  const pastHours = configuredInteger(env.POS_OFFLINE_SYNC_MAX_AGE_HOURS, 168, 1, 720, "POS_OFFLINE_SYNC_MAX_AGE_HOURS");
  const futureSeconds = configuredInteger(env.POS_OFFLINE_SYNC_MAX_FUTURE_SECONDS, 300, 0, 3600, "POS_OFFLINE_SYNC_MAX_FUTURE_SECONDS");
  return { maxPastMs: pastHours * 3_600_000, maxFutureMs: futureSeconds * 1_000 };
}

function normalizeOperation(
  raw: unknown,
  index: number,
  scope: { organizationId: string; terminalId: string },
  now: Date,
  window: { maxPastMs: number; maxFutureMs: number },
): PosOfflineSyncOperation {
  const value = object(raw, `Operação ${index + 1}`);
  onlyKeys(value, ["operationId", "sequence", "type", "occurredAt", "payload"], `Operação ${index + 1}`);
  const operationId = uuid(value.operationId, "Operation ID");
  const sequence = sequenceValue(value.sequence);
  const type = operationType(value.type);
  const occurredAt = occurredAtValue(value.occurredAt, now, window);
  const safePayload = safeJsonObject(value.payload, `Payload da operação ${index + 1}`);
  const supported = type === "terminal.heartbeat" || type === "cart.draft.upsert" || type === "cart.draft.discard";
  const payload = supported ? supportedPayload(type, safePayload) : {};
  const requestHash = hashPosOfflineOperation({ ...scope, operationId, sequence, type, occurredAt, payload: supported ? payload : safePayload });
  return { operationId, sequence, type, occurredAt, payload, requestHash, supported };
}

function supportedPayload(type: PosOfflineSupportedType, payload: PosOfflineJson) {
  if (type === "terminal.heartbeat") {
    onlyKeys(payload, ["appVersion", "queueDepth"], "Heartbeat");
    return {
      appVersion: text(payload.appVersion, 1, 64, "Versão do agente"),
      queueDepth: integer(payload.queueDepth, 0, 100_000, "Tamanho da fila"),
    };
  }
  if (type === "cart.draft.discard") {
    onlyKeys(payload, ["draftId", "baseRevision", "revision"], "Descarte do rascunho");
    const baseRevision = revisionValue(payload.baseRevision, true), revision = revisionValue(payload.revision, false);
    if (revision !== baseRevision + 1) throw new PosOfflineSyncError("A revisão do descarte deve suceder baseRevision.");
    return { draftId: uuid(payload.draftId, "Rascunho"), baseRevision, revision };
  }
  onlyKeys(payload, ["draftId", "baseRevision", "revision", "customerId", "items"], "Rascunho do carrinho");
  const baseRevision = revisionValue(payload.baseRevision, true), revision = revisionValue(payload.revision, false);
  if (revision !== baseRevision + 1) throw new PosOfflineSyncError("A revisão do rascunho deve suceder baseRevision.");
  if (!Array.isArray(payload.items) || !payload.items.length || payload.items.length > 200) throw new PosOfflineSyncError("O rascunho deve possuir de um a duzentos itens.");
  const items = payload.items.map((raw, index) => {
    const item = object(raw, `Item ${index + 1}`);
    onlyKeys(item, ["lineId", "productId", "variationId", "quantityMicros"], `Item ${index + 1}`);
    return {
      lineId: uuid(item.lineId, "Linha"),
      productId: integer(item.productId, 1, 2_147_483_647, "Produto"),
      variationId: item.variationId == null ? null : integer(item.variationId, 1, 2_147_483_647, "Variação"),
      quantityMicros: quantityMicros(item.quantityMicros),
    };
  });
  if (new Set(items.map(item => item.lineId)).size !== items.length) throw new PosOfflineSyncError("O rascunho contém linhas repetidas.");
  return {
    draftId: uuid(payload.draftId, "Rascunho"),
    baseRevision,
    revision,
    customerId: payload.customerId == null ? null : integer(payload.customerId, 1, 2_147_483_647, "Cliente"),
    items,
  };
}

function safeJsonObject(value: unknown, label: string): PosOfflineJson {
  const objectValue = object(value, label);
  let nodes = 0;
  const inspect = (candidate: unknown, depth: number): void => {
    if (++nodes > 2_000 || depth > 8) throw new PosOfflineSyncError(`${label} excede os limites estruturais.`);
    if (typeof candidate === "string") {
      if (Buffer.byteLength(candidate, "utf8") > 2_048) throw new PosOfflineSyncError(`${label} contém texto muito longo.`);
      rejectCardValue(candidate, label);
      return;
    }
    if (candidate == null || typeof candidate === "boolean") return;
    if (typeof candidate === "number") {
      if (!Number.isFinite(candidate)) throw new PosOfflineSyncError(`${label} contém número inválido.`);
      return;
    }
    if (Array.isArray(candidate)) {
      if (candidate.length > 200) throw new PosOfflineSyncError(`${label} contém lista muito grande.`);
      for (const item of candidate) inspect(item, depth + 1);
      return;
    }
    if (typeof candidate !== "object") throw new PosOfflineSyncError(`${label} contém valor não serializável.`);
    const entries = Object.entries(candidate as Record<string, unknown>);
    if (entries.length > 100) throw new PosOfflineSyncError(`${label} contém campos demais.`);
    for (const [key, item] of entries) {
      const normalized = key.toLowerCase().replace(/[^a-z0-9]/g, "");
      if (!key || key.length > 80 || ["__proto__", "prototype", "constructor"].includes(key) || ["pan", "card", "cardnumber", "creditcardnumber", "debitcardnumber", "cvv", "cvc", "cid", "pin", "pinblock", "track", "track1", "track2", "trackdata", "magstripe", "securitycode", "token", "authorization", "password", "secret", "credential"].some(forbidden => normalized.includes(forbidden))) {
        throw new PosOfflineSyncError(`${label} contém campo sensível ou PCI proibido.`);
      }
      inspect(item, depth + 1);
    }
  };
  inspect(objectValue, 0);
  const encoded = canonicalJson(objectValue);
  if (Buffer.byteLength(encoded, "utf8") > 16_384) throw new PosOfflineSyncError(`${label} excede 16 KiB.`);
  return JSON.parse(encoded) as PosOfflineJson;
}

function rejectCardValue(value: string, label: string) {
  if (/[;%][A-Z0-9 ]{0,26}\^|=\d{4,}/i.test(value)) throw new PosOfflineSyncError(`${label} contém trilha de cartão.`);
  for (const match of value.match(/(?:\d[ -]?){13,19}/g) ?? []) {
    const digits = match.replace(/\D/g, "");
    if (digits.length >= 13 && digits.length <= 19 && luhn(digits)) throw new PosOfflineSyncError(`${label} contém número de cartão.`);
  }
}

function luhn(value: string) {
  let sum = 0, alternate = false;
  for (let index = value.length - 1; index >= 0; index--) {
    let digit = Number(value[index]);
    if (alternate && (digit *= 2) > 9) digit -= 9;
    sum += digit;
    alternate = !alternate;
  }
  return sum % 10 === 0;
}

function canonicalJson(value: unknown): string {
  if (value instanceof Date) return JSON.stringify(value.toISOString());
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map(key => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(",")}}`;
}

function occurredAtValue(value: unknown, now: Date, window: { maxPastMs: number; maxFutureMs: number }) {
  if (typeof value !== "string" || value.length > 40 || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/.test(value)) throw new PosOfflineSyncError("Data da operação offline inválida.");
  const result = new Date(value);
  if (Number.isNaN(result.valueOf())) throw new PosOfflineSyncError("Data da operação offline inválida.");
  if (result.valueOf() < now.valueOf() - window.maxPastMs || result.valueOf() > now.valueOf() + window.maxFutureMs) throw new PosOfflineSyncError("Operação offline fora da janela configurada.");
  return result;
}

function validateWindow(maxPastMs: number, maxFutureMs: number) {
  if (!Number.isSafeInteger(maxPastMs) || maxPastMs < 3_600_000 || maxPastMs > 720 * 3_600_000 || !Number.isSafeInteger(maxFutureMs) || maxFutureMs < 0 || maxFutureMs > 3_600_000) {
    throw new PosOfflineSyncError("Janela de sincronização offline inválida.", 500);
  }
}

function configuredInteger(value: string | undefined, fallback: number, minimum: number, maximum: number, name: string) {
  if (value == null || value === "") return fallback;
  const result = Number(value);
  if (!Number.isSafeInteger(result) || result < minimum || result > maximum) throw new PosOfflineSyncError(`${name} possui configuração inválida.`, 500);
  return result;
}

function sequenceValue(value: unknown) {
  const text = typeof value === "number" && Number.isSafeInteger(value) ? String(value) : typeof value === "string" ? value : "";
  if (!/^[1-9]\d{0,18}$/.test(text)) throw new PosOfflineSyncError("Sequência offline inválida.");
  const result = BigInt(text);
  if (result > BigInt("9223372036854775807")) throw new PosOfflineSyncError("Sequência offline excede o limite permitido.");
  return result;
}

function nonnegativeSequenceValue(value: unknown, label: string) {
  const text = typeof value === "number" && Number.isSafeInteger(value) ? String(value) : typeof value === "string" ? value : "";
  if (!/^\d{1,19}$/.test(text)) throw new PosOfflineSyncError(`${label} inválido.`);
  const result = BigInt(text);
  if (result > BigInt("9223372036854775807")) throw new PosOfflineSyncError(`${label} excede o limite permitido.`);
  return result;
}

function optionalVersion(value: unknown, label: string) {
  if (value == null || value === "") return null;
  const result = String(value).trim().toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(result)) throw new PosOfflineSyncError(`${label} inválida.`);
  return result;
}

function revisionValue(value: unknown, allowZero: boolean) {
  const result = Number(value);
  if (!Number.isSafeInteger(result) || result < (allowZero ? 0 : 1) || result > 2_147_483_647) throw new PosOfflineSyncError("Revisão do rascunho inválida.");
  return result;
}

function quantityMicros(value: unknown) {
  const text = typeof value === "number" && Number.isSafeInteger(value) ? String(value) : typeof value === "string" ? value : "";
  if (!/^[1-9]\d{0,11}$/.test(text)) throw new PosOfflineSyncError("Quantidade do item inválida.");
  return text;
}

function operationType(value: unknown) {
  const result = String(value ?? "").trim();
  if (!/^[a-z][a-z0-9]*(?:\.[a-z][a-z0-9]*){1,3}$/.test(result) || result.length > 64) throw new PosOfflineSyncError("Tipo de operação offline inválido.");
  return result;
}

function uuid(value: unknown, label: string) {
  const result = String(value ?? "").trim().toLowerCase();
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(result)) throw new PosOfflineSyncError(`${label} inválido.`);
  return result;
}

function object(value: unknown, label: string) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new PosOfflineSyncError(`${label} deve ser um objeto.`);
  return value as Record<string, unknown>;
}

function onlyKeys(value: Record<string, unknown>, allowed: string[], label: string) {
  const extra = Object.keys(value).find(key => !allowed.includes(key));
  if (extra) throw new PosOfflineSyncError(`${label} contém campo não permitido: ${extra}.`);
}

function text(value: unknown, minimum: number, maximum: number, label: string) {
  const result = String(value ?? "").trim();
  if (result.length < minimum || result.length > maximum) throw new PosOfflineSyncError(`${label} inválida.`);
  return result;
}

function integer(value: unknown, minimum: number, maximum: number, label: string) {
  const result = Number(value);
  if (!Number.isSafeInteger(result) || result < minimum || result > maximum) throw new PosOfflineSyncError(`${label} inválido.`);
  return result;
}
