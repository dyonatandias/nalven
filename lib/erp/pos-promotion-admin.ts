import { createHash } from "node:crypto";
import {
  buildPosPromotionRule,
  hashPosCouponCode,
  normalizePosCouponCode,
  PosPromotionDomainError,
  type PosPromotionConditions,
  type PosPromotionEffect,
} from "@/lib/erp/pos-promotions";

export const POS_PROMOTION_ADMIN_ACTIONS = [
  "promotion.create", "promotion.update", "promotion.deactivate",
  "coupon.create", "coupon.update", "coupon.rotate", "coupon.deactivate",
] as const;

export type PosPromotionAdminAction = typeof POS_PROMOTION_ADMIN_ACTIONS[number];
type Common = { action: PosPromotionAdminAction; idempotencyKey: string };
type PromotionFields = {
  branchId: number | null;
  name: string;
  description: string | null;
  priority: number;
  status: "draft" | "active" | "inactive";
  startsAt: Date;
  endsAt: Date | null;
  usageLimit: number | null;
  perCustomerLimit: number | null;
  conditions: PosPromotionConditions;
  effect: PosPromotionEffect;
};

export type PosPromotionAdminInput =
  | Common & PromotionFields & { action: "promotion.create" }
  | Common & Partial<PromotionFields> & { action: "promotion.update"; promotionId: string }
  | Common & { action: "promotion.deactivate"; promotionId: string }
  | Common & { action: "coupon.create"; promotionId: string; code: string; status: "active" | "inactive"; usageLimit: number | null; expiresAt: Date | null }
  | Common & { action: "coupon.update"; couponId: string; status?: "active" | "inactive"; usageLimit?: number | null; expiresAt?: Date | null }
  | Common & { action: "coupon.rotate"; couponId: string; code: string }
  | Common & { action: "coupon.deactivate"; couponId: string };

export class PosPromotionAdminError extends Error {
  constructor(message: string, public readonly status = 422) {
    super(message);
    this.name = "PosPromotionAdminError";
  }
}

const promotionFields = ["branchId", "name", "description", "priority", "status", "startsAt", "endsAt", "usageLimit", "perCustomerLimit", "conditions", "effect"] as const;

export function parsePosPromotionAdminInput(body: Record<string, unknown>): PosPromotionAdminInput {
  const action = choice(body.action, POS_PROMOTION_ADMIN_ACTIONS, "Ação") as PosPromotionAdminAction;
  const idempotencyKey = key(body.idempotencyKey);
  try {
    if (action === "promotion.create") {
      onlyKeys(body, ["action", "idempotencyKey", ...promotionFields]);
      const fields = parsePromotionFields(body, true) as PromotionFields;
      validatePromotion(fields);
      return { action, idempotencyKey, ...fields };
    }
    if (action === "promotion.update") {
      onlyKeys(body, ["action", "idempotencyKey", "promotionId", ...promotionFields]);
      const fields = parsePromotionFields(body, false);
      requirePatch(fields);
      return { action, idempotencyKey, promotionId: stringId(body.promotionId, "Promoção"), ...fields };
    }
    if (action === "promotion.deactivate") {
      onlyKeys(body, ["action", "idempotencyKey", "promotionId"]);
      return { action, idempotencyKey, promotionId: stringId(body.promotionId, "Promoção") };
    }
    if (action === "coupon.create") {
      onlyKeys(body, ["action", "idempotencyKey", "promotionId", "code", "status", "usageLimit", "expiresAt"]);
      return {
        action,
        idempotencyKey,
        promotionId: stringId(body.promotionId, "Promoção"),
        code: normalizePosCouponCode(body.code),
        status: choice(body.status ?? "active", ["active", "inactive"] as const, "Status do cupom"),
        usageLimit: nullableLimit(body.usageLimit, "Limite do cupom"),
        expiresAt: nullableDate(body.expiresAt, "Expiração do cupom"),
      };
    }
    if (action === "coupon.update") {
      onlyKeys(body, ["action", "idempotencyKey", "couponId", "status", "usageLimit", "expiresAt"]);
      const result: PosPromotionAdminInput = {
        action,
        idempotencyKey,
        couponId: stringId(body.couponId, "Cupom"),
        ...(has(body, "status") ? { status: choice(body.status, ["active", "inactive"] as const, "Status do cupom") } : {}),
        ...(has(body, "usageLimit") ? { usageLimit: nullableLimit(body.usageLimit, "Limite do cupom") } : {}),
        ...(has(body, "expiresAt") ? { expiresAt: nullableDate(body.expiresAt, "Expiração do cupom") } : {}),
      };
      requirePatch(result, ["status", "usageLimit", "expiresAt"]);
      return result;
    }
    if (action === "coupon.rotate") {
      onlyKeys(body, ["action", "idempotencyKey", "couponId", "code"]);
      return { action, idempotencyKey, couponId: stringId(body.couponId, "Cupom"), code: normalizePosCouponCode(body.code) };
    }
    onlyKeys(body, ["action", "idempotencyKey", "couponId"]);
    return { action, idempotencyKey, couponId: stringId(body.couponId, "Cupom") };
  } catch (error) {
    if (error instanceof PosPromotionDomainError) throw new PosPromotionAdminError(error.message);
    throw error;
  }
}

/** Hashes the normalized request without retaining the administrator-provided coupon code. */
export function hashPosPromotionAdminInput(input: PosPromotionAdminInput) {
  const payload = { ...input } as Record<string, unknown>;
  delete payload.idempotencyKey;
  if (typeof payload.code === "string") {
    payload.couponCodeHash = hashPosCouponCode(payload.code);
    delete payload.code;
  }
  return createHash("sha256").update(canonicalJson(payload)).digest("hex");
}

export function couponCodeMetadata(code: string) {
  const normalized = normalizePosCouponCode(code);
  return { codeHash: hashPosCouponCode(normalized), codeLastFour: [...normalized].slice(-4).join("") };
}

function parsePromotionFields(body: Record<string, unknown>, required: boolean): Partial<PromotionFields> {
  const result: Partial<PromotionFields> = {};
  if (required || has(body, "branchId")) result.branchId = nullableId(body.branchId, "Filial");
  if (required || has(body, "name")) result.name = text(body.name, "Nome", 2, 160);
  if (required || has(body, "description")) result.description = nullableText(body.description, "Descrição", 1_000);
  if (required || has(body, "priority")) result.priority = integer(body.priority ?? 0, "Prioridade", -1_000_000, 1_000_000);
  if (required || has(body, "status")) result.status = choice(body.status ?? "draft", ["draft", "active", "inactive"] as const, "Status da promoção");
  if (required || has(body, "startsAt")) result.startsAt = date(body.startsAt, "Início da promoção");
  if (required || has(body, "endsAt")) result.endsAt = nullableDate(body.endsAt, "Término da promoção");
  if (required || has(body, "usageLimit")) result.usageLimit = nullableLimit(body.usageLimit, "Limite global de uso");
  if (required || has(body, "perCustomerLimit")) result.perCustomerLimit = nullableLimit(body.perCustomerLimit, "Limite por cliente");
  if (required || has(body, "conditions")) result.conditions = validateConditions(body.conditions);
  if (required || has(body, "effect")) result.effect = validateEffect(body.effect);
  return result;
}

function validatePromotion(value: PromotionFields) {
  buildPosPromotionRule({
    id: "promotion_admin_validation",
    name: value.name,
    priority: value.priority,
    status: value.status,
    stackMode: "exclusive",
    branchId: value.branchId,
    conditions: value.conditions,
    effects: value.effect,
    startsAt: value.startsAt,
    endsAt: value.endsAt,
    usageLimit: value.usageLimit,
    perCustomerLimit: value.perCustomerLimit,
  });
}

function validateConditions(value: unknown) {
  return buildPosPromotionRule(validationRecord({ conditions: value })).conditions;
}

function validateEffect(value: unknown) {
  return buildPosPromotionRule(validationRecord({ effects: value })).effect;
}

function validationRecord(overrides: { conditions?: unknown; effects?: unknown }) {
  return {
    id: "promotion_admin_validation",
    name: "Validação",
    priority: 0,
    status: "draft",
    stackMode: "exclusive",
    branchId: null,
    conditions: overrides.conditions ?? {},
    effects: overrides.effects ?? { type: "fixed", discountCents: 1 },
    startsAt: new Date(0),
    endsAt: null,
    usageLimit: null,
    perCustomerLimit: null,
  };
}

function onlyKeys(body: Record<string, unknown>, allowed: readonly string[]) {
  const extra = Object.keys(body).find((field) => !allowed.includes(field));
  if (extra) throw new PosPromotionAdminError(`Campo não permitido: ${extra}.`);
}
function requirePatch(value: object, fields = promotionFields as readonly string[]) {
  if (!fields.some((field) => field in value)) throw new PosPromotionAdminError("Informe ao menos um campo para atualizar.");
}
function key(value: unknown) { const result = String(value ?? "").trim(); if (result.length < 16 || result.length > 160 || !/^[A-Za-z0-9._:-]+$/.test(result)) throw new PosPromotionAdminError("Chave de idempotência inválida."); return result; }
function stringId(value: unknown, label: string) { return text(value, label, 1, 100); }
function nullableText(value: unknown, label: string, maximum: number) { return value == null || value === "" ? null : text(value, label, 1, maximum); }
function text(value: unknown, label: string, minimum: number, maximum: number) { if (typeof value !== "string") throw new PosPromotionAdminError(`${label} inválido.`); const result = value.trim(); if (result.length < minimum || result.length > maximum) throw new PosPromotionAdminError(`${label} inválido.`); return result; }
function nullableId(value: unknown, label: string) { return value == null || value === "" ? null : integer(value, label, 1, 2_147_483_647); }
function nullableLimit(value: unknown, label: string) { return value == null || value === "" ? null : integer(value, label, 0, 2_147_483_647); }
function integer(value: unknown, label: string, minimum: number, maximum: number) { if (typeof value !== "number" || !Number.isSafeInteger(value) || value < minimum || value > maximum) throw new PosPromotionAdminError(`${label} inválido.`); return value; }
function date(value: unknown, label: string) { if (typeof value !== "string" || value.length > 64 || !/(?:Z|[+-]\d{2}:\d{2})$/i.test(value)) throw new PosPromotionAdminError(`${label} deve ser uma data ISO com fuso horário.`); const result = new Date(value); if (!Number.isFinite(result.getTime())) throw new PosPromotionAdminError(`${label} inválido.`); return result; }
function nullableDate(value: unknown, label: string) { return value == null || value === "" ? null : date(value, label); }
function choice<const T extends readonly string[]>(value: unknown, choices: T, label: string): T[number] { if (typeof value !== "string" || !choices.includes(value)) throw new PosPromotionAdminError(`${label} inválido.`); return value as T[number]; }
function has(value: object, field: string) { return Object.prototype.hasOwnProperty.call(value, field); }

function canonicalJson(value: unknown): string {
  if (value instanceof Date) return JSON.stringify(value.toISOString());
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((field) => `${JSON.stringify(field)}:${canonicalJson(record[field])}`).join(",")}}`;
}
