import { createHash } from "node:crypto";
import { hashPosValueRequestSecret } from "@/lib/erp/pos-value-secrets";
import type { PosValueKind } from "@/lib/erp/pos-value-accounts";

export const POS_VALUE_ADMIN_ACTIONS = [
  "value.program.create", "value.program.deactivate",
  "value.account.issue", "value.account.credit", "value.account.debit", "value.account.expire",
  "value.reservation.create", "value.reservation.capture", "value.reservation.release",
  "value.entry.reverse",
] as const;

export type PosValueAdminAction = typeof POS_VALUE_ADMIN_ACTIONS[number];
type Common = { action: PosValueAdminAction; idempotencyKey: string };

export type PosValueAdminInput =
  | Common & { action: "value.program.create"; branchId: number; name: string; kind: "loyalty_points" | "cashback"; earnUnits: number; spendCents: number; redeemCentsPerUnit: number; expiresAfterDays: number | null }
  | Common & { action: "value.program.deactivate"; programId: string }
  | Common & { action: "value.account.issue"; branchId: number; customerId: number | null; programId: string | null; kind: PosValueKind; label: string; initialUnits: number; expiresAt: Date | null; pin: string | null }
  | Common & { action: "value.account.credit" | "value.account.debit"; branchId: number; accountId: string; amountUnits: number; reason: string }
  | Common & { action: "value.account.expire"; branchId: number; accountId: string; reason: string }
  | Common & { action: "value.reservation.create"; branchId: number; accountId: string; amountUnits: number; referenceType: string; referenceId: string; expiresAt: Date; reason: string }
  | Common & { action: "value.reservation.capture" | "value.reservation.release"; branchId: number; reservationId: string; referenceType: string; referenceId: string; reason: string }
  | Common & { action: "value.entry.reverse"; branchId: number; entryId: bigint; reason: string };

export class PosValueAdminError extends Error {
  constructor(message: string, public readonly status = 422) {
    super(message);
    this.name = "PosValueAdminError";
  }
}

export function parsePosValueAdminInput(body: Record<string, unknown>): PosValueAdminInput {
  const action = choice(body.action, POS_VALUE_ADMIN_ACTIONS, "Ação"), idempotencyKey = key(body.idempotencyKey);
  if (action === "value.program.create") {
    onlyKeys(body, ["action", "idempotencyKey", "branchId", "name", "kind", "earnUnits", "spendCents", "redeemCentsPerUnit", "expiresAfterDays"]);
    return {
      action, idempotencyKey, branchId: id(body.branchId, "Filial"), name: text(body.name, "Nome", 2, 160),
      kind: choice(body.kind, ["loyalty_points", "cashback"] as const, "Tipo"),
      earnUnits: integer(body.earnUnits, "Unidades ganhas", 1, 2_147_483_647), spendCents: integer(body.spendCents, "Base em centavos", 1, 2_147_483_647),
      redeemCentsPerUnit: integer(body.redeemCentsPerUnit, "Valor de resgate", 1, 2_147_483_647),
      expiresAfterDays: nullableInteger(body.expiresAfterDays, "Validade em dias", 1, 36_500),
    };
  }
  if (action === "value.program.deactivate") {
    onlyKeys(body, ["action", "idempotencyKey", "programId"]);
    return { action, idempotencyKey, programId: stringId(body.programId, "Programa") };
  }
  if (action === "value.account.issue") {
    onlyKeys(body, ["action", "idempotencyKey", "branchId", "customerId", "programId", "kind", "label", "initialUnits", "expiresAt", "pin"]);
    const kind = choice(body.kind, ["loyalty_points", "cashback", "gift_card", "store_credit"] as const, "Tipo da conta");
    const pin = nullableText(body.pin, "PIN", 12);
    if (kind === "gift_card" && (!pin || !/^\d{6,12}$/.test(pin))) throw new PosValueAdminError("Gift card exige PIN de 6 a 12 dígitos.");
    if (kind !== "gift_card" && pin) throw new PosValueAdminError("Somente gift card aceita PIN.");
    const customerId = nullableId(body.customerId, "Cliente"), programId = nullableStringId(body.programId, "Programa");
    if (kind !== "gift_card" && customerId == null) throw new PosValueAdminError("Esta conta exige cliente.");
    if (["loyalty_points", "cashback"].includes(kind) !== (programId != null)) throw new PosValueAdminError("Programa é obrigatório somente para pontos e cashback.");
    return {
      action, idempotencyKey, branchId: id(body.branchId, "Filial"), customerId, programId, kind,
      label: text(body.label, "Identificação", 2, 160), initialUnits: integer(body.initialUnits, "Saldo inicial", 0, 9_000_000_000_000_000),
      expiresAt: nullableDate(body.expiresAt, "Expiração"), pin,
    };
  }
  if (action === "value.account.credit" || action === "value.account.debit") {
    onlyKeys(body, ["action", "idempotencyKey", "branchId", "accountId", "amountUnits", "reason"]);
    return { action, idempotencyKey, branchId: id(body.branchId, "Filial"), accountId: stringId(body.accountId, "Conta"), amountUnits: integer(body.amountUnits, "Valor", 1, 9_000_000_000_000_000), reason: text(body.reason, "Motivo", 4, 500) };
  }
  if (action === "value.account.expire") {
    onlyKeys(body, ["action", "idempotencyKey", "branchId", "accountId", "reason"]);
    return { action, idempotencyKey, branchId: id(body.branchId, "Filial"), accountId: stringId(body.accountId, "Conta"), reason: text(body.reason, "Motivo", 4, 500) };
  }
  if (action === "value.reservation.create") {
    onlyKeys(body, ["action", "idempotencyKey", "branchId", "accountId", "amountUnits", "referenceType", "referenceId", "expiresAt", "reason"]);
    return {
      action, idempotencyKey, branchId: id(body.branchId, "Filial"), accountId: stringId(body.accountId, "Conta"), amountUnits: integer(body.amountUnits, "Valor", 1, 9_000_000_000_000_000),
      referenceType: text(body.referenceType, "Tipo de referência", 1, 80), referenceId: text(body.referenceId, "Referência", 1, 160),
      expiresAt: date(body.expiresAt, "Expiração da reserva"), reason: text(body.reason, "Motivo", 4, 500),
    };
  }
  if (action === "value.reservation.capture" || action === "value.reservation.release") {
    onlyKeys(body, ["action", "idempotencyKey", "branchId", "reservationId", "referenceType", "referenceId", "reason"]);
    return {
      action, idempotencyKey, branchId: id(body.branchId, "Filial"), reservationId: stringId(body.reservationId, "Reserva"),
      referenceType: text(body.referenceType, "Tipo de referência", 1, 80), referenceId: text(body.referenceId, "Referência", 1, 160), reason: text(body.reason, "Motivo", 4, 500),
    };
  }
  onlyKeys(body, ["action", "idempotencyKey", "branchId", "entryId", "reason"]);
  return { action, idempotencyKey, branchId: id(body.branchId, "Filial"), entryId: bigintId(body.entryId, "Lançamento"), reason: text(body.reason, "Motivo", 4, 500) };
}

export function hashPosValueAdminInput(input: PosValueAdminInput) {
  const payload = { ...input } as Record<string, unknown>;
  delete payload.idempotencyKey;
  if (typeof payload.pin === "string") {
    payload.pinDigest = hashPosValueRequestSecret(payload.pin);
    delete payload.pin;
  }
  return createHash("sha256").update(canonicalJson(payload)).digest("hex");
}

function onlyKeys(body: Record<string, unknown>, allowed: readonly string[]) { const extra = Object.keys(body).find(field => !allowed.includes(field)); if (extra) throw new PosValueAdminError(`Campo não permitido: ${extra}.`); }
function key(value: unknown) { if (typeof value !== "string") throw new PosValueAdminError("Chave de idempotência inválida."); const result = value.trim(); if (result.length < 16 || result.length > 160 || !/^[A-Za-z0-9._:-]+$/.test(result)) throw new PosValueAdminError("Chave de idempotência inválida."); return result; }
function id(value: unknown, label: string) { return integer(value, label, 1, 2_147_483_647); }
function nullableId(value: unknown, label: string) { return value == null || value === "" ? null : id(value, label); }
function integer(value: unknown, label: string, minimum: number, maximum: number) { if (typeof value !== "number" || !Number.isSafeInteger(value) || value < minimum || value > maximum) throw new PosValueAdminError(`${label} inválido.`); return value; }
function nullableInteger(value: unknown, label: string, minimum: number, maximum: number) { return value == null || value === "" ? null : integer(value, label, minimum, maximum); }
function text(value: unknown, label: string, minimum: number, maximum: number) { if (typeof value !== "string") throw new PosValueAdminError(`${label} inválido.`); const result = value.trim(); if (result.length < minimum || result.length > maximum) throw new PosValueAdminError(`${label} inválido.`); return result; }
function nullableText(value: unknown, label: string, maximum: number) { return value == null || value === "" ? null : text(value, label, 1, maximum); }
function stringId(value: unknown, label: string) { return text(value, label, 1, 160); }
function nullableStringId(value: unknown, label: string) { return value == null || value === "" ? null : stringId(value, label); }
function bigintId(value: unknown, label: string) { if (typeof value !== "string" || !/^[1-9]\d{0,18}$/.test(value)) throw new PosValueAdminError(`${label} inválido.`); const result = BigInt(value); if (result > BigInt("9223372036854775807")) throw new PosValueAdminError(`${label} inválido.`); return result; }
function date(value: unknown, label: string) { if (typeof value !== "string" || value.length > 64 || !/(?:Z|[+-]\d{2}:\d{2})$/i.test(value)) throw new PosValueAdminError(`${label} deve ser uma data ISO com fuso horário.`); const result = new Date(value); if (!Number.isFinite(result.getTime())) throw new PosValueAdminError(`${label} inválido.`); return result; }
function nullableDate(value: unknown, label: string) { return value == null || value === "" ? null : date(value, label); }
function choice<const T extends readonly string[]>(value: unknown, choices: T, label: string): T[number] { if (typeof value !== "string" || !choices.includes(value)) throw new PosValueAdminError(`${label} inválido.`); return value as T[number]; }
function canonicalJson(value: unknown): string { if (typeof value === "bigint") return JSON.stringify(value.toString()); if (value instanceof Date) return JSON.stringify(value.toISOString()); if (value === null || typeof value !== "object") return JSON.stringify(value); if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`; const record = value as Record<string, unknown>; return `{${Object.keys(record).sort().map(field => `${JSON.stringify(field)}:${canonicalJson(record[field])}`).join(",")}}`; }
