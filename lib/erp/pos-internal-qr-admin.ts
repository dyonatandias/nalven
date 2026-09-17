import { createHash } from "node:crypto";
import { normalizePosInternalQrReference, type PosInternalQrKind, PosInternalQrError } from "@/lib/erp/pos-internal-qr";

const MAX_LIFETIME_BY_KIND: Record<PosInternalQrKind, number> = {
  customer: 366 * 86_400,
  held_cart: 86_400,
  coupon: 30 * 86_400,
  gift_card: 366 * 86_400,
  order: 30 * 86_400,
  receipt: 366 * 86_400,
};

export type PosInternalQrIssueInput = {
  action: "qr.issue";
  branchId: number;
  kind: PosInternalQrKind;
  reference: string;
  entityId: string;
  expiresAt: Date;
  idempotencyKey: string;
};

export type PosInternalQrRevokeInput = {
  action: "qr.revoke";
  qrId: string;
  reason: string;
  idempotencyKey: string;
};

export type PosInternalQrResolveInput = {
  action: "qr.resolve";
  sessionId: number;
  token: string;
};

export type PosInternalQrAdminInput = PosInternalQrIssueInput | PosInternalQrRevokeInput | PosInternalQrResolveInput;

export function parsePosInternalQrAdminInput(value: Record<string, unknown>, now = new Date()): PosInternalQrAdminInput {
  const action = String(value.action ?? "");
  if (action === "qr.issue") {
    onlyKeys(value, ["action", "branchId", "kind", "reference", "expiresAt", "idempotencyKey"]);
    const normalized = normalizePosInternalQrReference(value.kind, value.reference);
    const expiresAt = isoDate(value.expiresAt, "Expiração");
    const lifetime = Math.ceil((expiresAt.valueOf() - validDate(now).valueOf()) / 1_000);
    if (lifetime < 60 || lifetime > MAX_LIFETIME_BY_KIND[normalized.kind]) throw new PosInternalQrError(`Vigência inválida para QR do tipo ${normalized.kind}.`);
    return {
      action,
      branchId: positiveInteger(value.branchId, "Filial"),
      kind: normalized.kind,
      reference: normalized.reference,
      entityId: normalized.entityId,
      expiresAt,
      idempotencyKey: idempotency(value.idempotencyKey),
    };
  }
  if (action === "qr.revoke") {
    onlyKeys(value, ["action", "qrId", "reason", "idempotencyKey"]);
    return { action, qrId: entityId(value.qrId, "QR"), reason: text(value.reason, 8, 500, "Motivo"), idempotencyKey: idempotency(value.idempotencyKey) };
  }
  if (action === "qr.resolve") {
    onlyKeys(value, ["action", "sessionId", "token"]);
    const token = String(value.token ?? "").trim();
    if (token.length < 80 || Buffer.byteLength(token, "utf8") > 2_048) throw new PosInternalQrError("Token do QR interno inválido.");
    return { action, sessionId: positiveInteger(value.sessionId, "Turno"), token };
  }
  throw new PosInternalQrError("Ação de QR interno inválida.");
}

export function hashPosInternalQrMutation(input: PosInternalQrIssueInput | PosInternalQrRevokeInput, scope: { organizationId: string; actorId: string }) {
  return createHash("sha256").update(canonicalJson({
    purpose: "pos.internal-qr.mutation",
    version: 1,
    organizationId: entityId(scope.organizationId, "Organização"),
    actorId: entityId(scope.actorId, "Ator"),
    ...input,
    ...(input.action === "qr.issue" ? { expiresAt: input.expiresAt.toISOString() } : {}),
  }), "utf8").digest("hex");
}

function onlyKeys(value: Record<string, unknown>, allowed: readonly string[]) {
  const extra = Object.keys(value).find(key => !allowed.includes(key));
  if (extra) throw new PosInternalQrError(`Campo não permitido no QR interno: ${extra}.`);
}

function positiveInteger(value: unknown, label: string) {
  const result = Number(value);
  if (!Number.isSafeInteger(result) || result <= 0 || result > 2_147_483_647) throw new PosInternalQrError(`${label} inválido.`);
  return result;
}

function entityId(value: unknown, label: string) {
  const result = String(value ?? "").trim();
  if (result.length < 1 || result.length > 160 || !/^[A-Za-z0-9][A-Za-z0-9._:@/-]*$/.test(result)) throw new PosInternalQrError(`${label} inválido.`);
  return result;
}

function idempotency(value: unknown) {
  const result = entityId(value, "Chave idempotente");
  if (result.length < 16) throw new PosInternalQrError("Chave idempotente inválida.");
  return result;
}

function text(value: unknown, minimum: number, maximum: number, label: string) {
  const result = String(value ?? "").trim().replace(/\s+/g, " ");
  if (result.length < minimum || result.length > maximum || /[\u0000-\u001f]/.test(result)) throw new PosInternalQrError(`${label} inválido.`);
  return result;
}

function isoDate(value: unknown, label: string) {
  if (typeof value !== "string" || value.length > 40 || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/.test(value)) throw new PosInternalQrError(`${label} inválida.`);
  const result = new Date(value);
  if (Number.isNaN(result.valueOf())) throw new PosInternalQrError(`${label} inválida.`);
  return result;
}

function validDate(value: Date) {
  if (!(value instanceof Date) || Number.isNaN(value.valueOf())) throw new PosInternalQrError("Relógio do servidor inválido.");
  return value;
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map(key => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(",")}}`;
}
