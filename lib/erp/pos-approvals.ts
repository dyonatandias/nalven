import { createHash } from "node:crypto";
import { PosDomainError } from "@/lib/erp/pos-domain";
import { normalizePosDiscountApprovalContext } from "@/lib/erp/pos-discount-approval";
import { normalizePosManualPaymentApprovalContext } from "@/lib/erp/pos-manual-payment";
import { isPosPostSaleApprovalAction, normalizePosPostSaleApprovalIntent, posReturnApprovalIntentToRequestContext, type PosReturnApprovalIntent } from "@/lib/erp/pos-post-sale-approval";

export const POS_APPROVAL_ACTIONS = {
  "discount.override": { entityType: "sale_draft", entityRequired: true },
  "session.close.divergence": { entityType: "cash_register_session", entityRequired: true },
  "cash.withdrawal": { entityType: "cash_register_session", entityRequired: true },
  "sale.cancel": { entityType: "sale", entityRequired: true },
  "return.create": { entityType: "sale", entityRequired: true },
  "payment.manual_reference": { entityType: "sale_draft", entityRequired: true },
} as const;

export type PosApprovalAction = keyof typeof POS_APPROVAL_ACTIONS;
export type PosApprovalDecision = "approved" | "rejected";

export type NormalizedPosApprovalRequest = {
  action: PosApprovalAction;
  entityType: string;
  entityId: string | null;
  reason: string;
  context: Record<string, unknown>;
  idempotencyKey: string;
  requestHash: string;
  expiresAt: Date;
  expiryMinutes: number;
};

export function normalizePosApprovalRequest(
  input: Record<string, unknown>,
  scope: { branchId: number; requesterId: string; now?: Date },
): NormalizedPosApprovalRequest {
  const action = approvalAction(input.approvalAction);
  const rule = POS_APPROVAL_ACTIONS[action];
  const entityId = optionalText(input.entityId, 120);
  if (rule.entityRequired && !entityId) throw new PosDomainError("A aprovação exige a identificação da operação.");
  const reason = requiredText(input.reason, 8, 500, "Justificativa");
  const idempotencyKey = requiredText(input.idempotencyKey, 8, 120, "Chave de idempotência");
  if (!/^[A-Za-z0-9._:-]+$/.test(idempotencyKey)) throw new PosDomainError("Chave de idempotência inválida.");
  const expiryMinutes = integer(input.expiryMinutes ?? 10, 1, 60, "Validade da aprovação");
  let context = safeContext(input.context, isPosPostSaleApprovalAction(action) ? { maximumBytes: 32_768, maximumArrayItems: 200 } : undefined);
  if (action === "discount.override") normalizePosDiscountApprovalContext(context, entityId);
  if (action === "payment.manual_reference") normalizePosManualPaymentApprovalContext(context, entityId);
  if (isPosPostSaleApprovalAction(action)) {
    const intent = normalizePosPostSaleApprovalIntent(action, context, entityId, reason);
    context = action === "sale.cancel"
      ? { sessionId: intent.sessionId }
      : posReturnApprovalIntentToRequestContext(intent as PosReturnApprovalIntent);
  }
  return {
    action,
    entityType: rule.entityType,
    entityId,
    reason,
    context,
    idempotencyKey,
    requestHash: approvalRequestHash({ action, branchId: scope.branchId, requesterId: scope.requesterId, entityType: rule.entityType, entityId, reason, context, expiryMinutes }),
    expiresAt: new Date((scope.now ?? new Date()).valueOf() + expiryMinutes * 60_000),
    expiryMinutes,
  };
}

export function bindAuthoritativePosApprovalContext(
  request: NormalizedPosApprovalRequest,
  scope: { branchId: number; requesterId: string },
  context: Record<string, unknown>,
): NormalizedPosApprovalRequest {
  return {
    ...request,
    context,
    requestHash: approvalRequestHash({
      action: request.action,
      branchId: scope.branchId,
      requesterId: scope.requesterId,
      entityType: request.entityType,
      entityId: request.entityId,
      reason: request.reason,
      context,
      expiryMinutes: request.expiryMinutes,
    }),
  };
}

export function normalizePosApprovalDecision(input: Record<string, unknown>) {
  const decision = String(input.decision ?? "") as PosApprovalDecision;
  if (decision !== "approved" && decision !== "rejected") throw new PosDomainError("Decisão de aprovação inválida.");
  const decisionReason = optionalText(input.decisionReason, 500);
  if (decision === "rejected" && (!decisionReason || decisionReason.length < 4)) {
    throw new PosDomainError("Informe o motivo da rejeição.");
  }
  return { decision, decisionReason };
}

export function effectivePosApprovalStatus(status: string, expiresAt: Date, now = new Date()) {
  return status === "pending" && expiresAt.valueOf() <= now.valueOf() ? "expired" : status;
}

export function assertApprovalReplay(existingHash: string | null, requestHash: string) {
  if (!existingHash || existingHash !== requestHash) {
    throw new PosDomainError("A chave de idempotência já foi usada com outro pedido de aprovação.");
  }
}

function approvalAction(value: unknown): PosApprovalAction {
  const action = String(value ?? "") as PosApprovalAction;
  if (!Object.hasOwn(POS_APPROVAL_ACTIONS, action)) throw new PosDomainError("Tipo de aprovação inválido.");
  return action;
}

function safeContext(value: unknown, limits: { maximumBytes: number; maximumArrayItems: number } = { maximumBytes: 4096, maximumArrayItems: 50 }): Record<string, unknown> {
  if (value == null) return {};
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new PosDomainError("Contexto da aprovação inválido.");
  validateJsonValue(value, 0, limits.maximumArrayItems);
  const serialized = JSON.stringify(value);
  if (new TextEncoder().encode(serialized).byteLength > limits.maximumBytes) throw new PosDomainError("Contexto da aprovação excede o limite permitido.");
  return JSON.parse(serialized) as Record<string, unknown>;
}

function validateJsonValue(value: unknown, depth: number, maximumArrayItems: number): void {
  if (depth > 6) throw new PosDomainError("Contexto da aprovação é muito profundo.");
  if (value == null || typeof value === "boolean" || typeof value === "string") {
    if (typeof value === "string" && value.length > 1000) throw new PosDomainError("Contexto da aprovação contém texto muito longo.");
    return;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new PosDomainError("Contexto da aprovação contém número inválido.");
    return;
  }
  if (Array.isArray(value)) {
    if (value.length > maximumArrayItems) throw new PosDomainError("Contexto da aprovação contém lista muito grande.");
    for (const item of value) validateJsonValue(item, depth + 1, maximumArrayItems);
    return;
  }
  if (typeof value !== "object") throw new PosDomainError("Contexto da aprovação não é serializável.");
  const entries = Object.entries(value as Record<string, unknown>);
  if (entries.length > 50) throw new PosDomainError("Contexto da aprovação contém campos demais.");
  for (const [key, item] of entries) {
    const normalizedKey = key.toLowerCase().replace(/[^a-z0-9]/g, "");
    if (["pan", "cardnumber", "cvv", "cvc", "track1", "track2", "password", "secret", "token", "authorization"].some((forbidden) => normalizedKey.includes(forbidden))) {
      throw new PosDomainError("Contexto da aprovação contém dado sensível proibido.");
    }
    validateJsonValue(item, depth + 1, maximumArrayItems);
  }
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(",")}}`;
}

function approvalRequestHash(value: unknown) {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

function requiredText(value: unknown, minimum: number, maximum: number, label: string) {
  const result = String(value ?? "").trim();
  if (result.length < minimum || result.length > maximum) throw new PosDomainError(`${label} inválida.`);
  return result;
}

function optionalText(value: unknown, maximum: number) {
  const result = String(value ?? "").trim();
  if (!result) return null;
  if (result.length > maximum) throw new PosDomainError("Texto excede o limite permitido.");
  return result;
}

function integer(value: unknown, minimum: number, maximum: number, label: string) {
  const result = Number(value);
  if (!Number.isSafeInteger(result) || result < minimum || result > maximum) throw new PosDomainError(`${label} inválida.`);
  return result;
}
