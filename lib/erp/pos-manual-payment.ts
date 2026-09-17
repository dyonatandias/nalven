import { createHash } from "node:crypto";
import { PosDomainError } from "@/lib/erp/pos-domain";
import { containsPosPaymentPanInIdentifier } from "@/lib/erp/pos-payment-persistence";

export const POS_MANUAL_PAYMENT_METHODS = ["pix", "credit", "debit", "voucher"] as const;
export type PosManualPaymentMethod = typeof POS_MANUAL_PAYMENT_METHODS[number];

export type PosManualPaymentApprovalContext = {
  manualReferenceId: string;
  saleDraftId: string;
  quoteHash: string;
  sessionId: number;
  registerId: number;
  paymentIndex: number;
  method: PosManualPaymentMethod;
  amountCents: number;
  installments: number;
  provider: string;
  referenceHash: string;
  referenceLastFour: string;
  occurredAt: string;
};

export type NormalizedPosManualPaymentRequest = {
  id: string;
  sessionId: number;
  saleDraftId: string;
  quoteHash: string;
  paymentIndex: number;
  method: PosManualPaymentMethod;
  amountCents: number;
  installments: number;
  provider: string;
  reference: string;
  referenceHash: string;
  referenceLastFour: string;
  occurredAt: Date;
  reason: string;
  idempotencyKey: string;
  requestHash: string;
};

export function normalizePosManualPaymentRequest(
  input: Record<string, unknown>,
  scope: { id: string; branchId: number; registerId: number; requesterUserId: string; now?: Date },
): NormalizedPosManualPaymentRequest {
  const now = scope.now ?? new Date();
  const sessionId = integer(input.sessionId, 1, 2_147_483_647, "Turno");
  const paymentIndex = integer(input.paymentIndex, 0, 9, "Índice do pagamento");
  const amountCents = integer(input.amountCents, 1, 2_147_483_647, "Valor do pagamento");
  const installments = integer(input.installments ?? 1, 1, 24, "Parcelas");
  const saleDraftId = identifier(input.saleDraftId, 8, 100, "Rascunho da venda");
  const quoteHash = hexHash(input.quoteHash);
  const idempotencyKey = identifier(input.idempotencyKey, 8, 120, "Chave de idempotência");
  const method = String(input.method ?? "") as PosManualPaymentMethod;
  if (!POS_MANUAL_PAYMENT_METHODS.includes(method)) throw new PosDomainError("Forma de pagamento manual inválida.");
  if (method !== "credit" && installments !== 1) throw new PosDomainError("Somente crédito aceita parcelamento na referência manual.");
  const provider = normalizedProvider(input.provider);
  const reference = normalizedReference(input.reference, method);
  const occurredAt = date(input.occurredAt, "Ocorrência da confirmação");
  if (occurredAt.valueOf() > now.valueOf() + 5 * 60_000 || occurredAt.valueOf() < now.valueOf() - 24 * 60 * 60_000) {
    throw new PosDomainError("A confirmação manual deve ter ocorrido nas últimas 24 horas.");
  }
  const reason = bounded(input.reason, 8, 500, "Justificativa");
  if (containsPosPaymentPanInIdentifier(reason)) throw new PosDomainError("Justificativa contém número de cartão proibido.");
  const referenceHash = hashPosManualPaymentReference(method, provider, reference);
  const normalizedForHash = {
    branchId: scope.branchId,
    registerId: scope.registerId,
    requesterUserId: scope.requesterUserId,
    sessionId,
    saleDraftId,
    quoteHash,
    paymentIndex,
    method,
    amountCents,
    installments,
    provider,
    reference,
    occurredAt: occurredAt.toISOString(),
    reason,
  };
  return {
    id: scope.id,
    sessionId,
    saleDraftId,
    quoteHash,
    paymentIndex,
    method,
    amountCents,
    installments,
    provider,
    reference,
    referenceHash,
    referenceLastFour: reference.slice(-4),
    occurredAt,
    reason,
    idempotencyKey,
    requestHash: sha256(canonicalJson(normalizedForHash)),
  };
}

export function posManualPaymentApprovalContext(
  value: Pick<NormalizedPosManualPaymentRequest, "id" | "saleDraftId" | "quoteHash" | "sessionId" | "paymentIndex" | "method" | "amountCents" | "installments" | "provider" | "referenceHash" | "referenceLastFour" | "occurredAt">,
  registerId: number,
): PosManualPaymentApprovalContext {
  return {
    manualReferenceId: value.id,
    saleDraftId: value.saleDraftId,
    quoteHash: value.quoteHash,
    sessionId: value.sessionId,
    registerId,
    paymentIndex: value.paymentIndex,
    method: value.method,
    amountCents: value.amountCents,
    installments: value.installments,
    provider: value.provider,
    referenceHash: value.referenceHash,
    referenceLastFour: value.referenceLastFour,
    occurredAt: value.occurredAt.toISOString(),
  };
}

export function normalizePosManualPaymentApprovalContext(value: Record<string, unknown>, entityId?: string | null): PosManualPaymentApprovalContext {
  const context: PosManualPaymentApprovalContext = {
    manualReferenceId: identifier(value.manualReferenceId, 8, 120, "Referência manual"),
    saleDraftId: identifier(value.saleDraftId, 8, 100, "Rascunho da venda"),
    quoteHash: hexHash(value.quoteHash),
    sessionId: integer(value.sessionId, 1, 2_147_483_647, "Turno"),
    registerId: integer(value.registerId, 1, 2_147_483_647, "Caixa"),
    paymentIndex: integer(value.paymentIndex, 0, 9, "Índice do pagamento"),
    method: manualMethod(value.method),
    amountCents: integer(value.amountCents, 1, 2_147_483_647, "Valor do pagamento"),
    installments: integer(value.installments, 1, 24, "Parcelas"),
    provider: normalizedProvider(value.provider),
    referenceHash: hexHash(value.referenceHash),
    referenceLastFour: bounded(value.referenceLastFour, 1, 4, "Final da referência"),
    occurredAt: date(value.occurredAt, "Ocorrência da confirmação").toISOString(),
  };
  if (context.method !== "credit" && context.installments !== 1) throw new PosDomainError("Somente crédito aceita parcelamento na referência manual.");
  if (entityId && context.saleDraftId !== entityId) throw new PosDomainError("O rascunho da referência manual não corresponde à aprovação.");
  const allowed = new Set(Object.keys(context));
  if (Object.keys(value).some((key) => !allowed.has(key))) throw new PosDomainError("Contexto da referência manual contém campos não permitidos.");
  return context;
}

export function assertPosManualPaymentApprovalContext(actual: unknown, expected: PosManualPaymentApprovalContext) {
  if (!actual || typeof actual !== "object" || Array.isArray(actual)) throw new PosDomainError("A aprovação não possui contexto de pagamento íntegro.");
  const normalized = normalizePosManualPaymentApprovalContext(actual as Record<string, unknown>, expected.saleDraftId);
  if (canonicalJson(normalized) !== canonicalJson(expected)) throw new PosDomainError("A aprovação não corresponde ao pagamento manual atual.");
  return normalized;
}

export function hashPosManualPaymentReference(method: PosManualPaymentMethod, provider: string, reference: string) {
  return sha256(`${method}\u0000${provider.toLocaleLowerCase("en-US")}\u0000${reference}`);
}

export function assertPosManualPaymentReplay(existingHash: string, expectedHash: string) {
  if (existingHash !== expectedHash) throw new PosDomainError("A chave idempotente já foi usada com outra referência manual.");
}

function manualMethod(value: unknown): PosManualPaymentMethod {
  const method = String(value ?? "") as PosManualPaymentMethod;
  if (!POS_MANUAL_PAYMENT_METHODS.includes(method)) throw new PosDomainError("Forma de pagamento manual inválida.");
  return method;
}

function normalizedProvider(value: unknown) {
  const provider = bounded(value, 2, 80, "Instituição/adquirente").normalize("NFKC").toLocaleLowerCase("en-US");
  if (!/^[a-z0-9][a-z0-9._:-]*$/.test(provider) || ["manual_pos", "cash", "pos_value"].includes(provider)) {
    throw new PosDomainError("Instituição/adquirente inválida.");
  }
  return provider;
}

function normalizedReference(value: unknown, method: PosManualPaymentMethod) {
  const reference = bounded(value, 6, 160, "Referência externa").normalize("NFKC");
  if (method === "pix") {
    const normalized = reference.toUpperCase();
    if (!/^E\d{16}[A-Z0-9]{15}$/.test(normalized)) throw new PosDomainError("EndToEndId Pix inválido.");
    return normalized;
  }
  if (containsPosPaymentPanInIdentifier(reference)) throw new PosDomainError("Número de cartão não pode ser usado como referência manual.");
  if (!/^[\p{L}\p{N}._:+/-]+$/u.test(reference)) throw new PosDomainError("Referência externa inválida.");
  return reference;
}

function identifier(value: unknown, minimum: number, maximum: number, label: string) {
  const result = bounded(value, minimum, maximum, label).normalize("NFKC");
  if (!/^[A-Za-z0-9._:-]+$/.test(result)) throw new PosDomainError(`${label} inválido.`);
  if (containsPosPaymentPanInIdentifier(result)) throw new PosDomainError(`${label} contém número de cartão proibido.`);
  return result;
}

function bounded(value: unknown, minimum: number, maximum: number, label: string) {
  const result = String(value ?? "").trim();
  if (result.length < minimum || result.length > maximum) throw new PosDomainError(`${label} inválida.`);
  return result;
}

function integer(value: unknown, minimum: number, maximum: number, label: string) {
  const result = Number(value);
  if (!Number.isSafeInteger(result) || result < minimum || result > maximum) throw new PosDomainError(`${label} inválido.`);
  return result;
}

function date(value: unknown, label: string) {
  const result = new Date(String(value ?? ""));
  if (!Number.isFinite(result.valueOf())) throw new PosDomainError(`${label} inválida.`);
  return result;
}

function hexHash(value: unknown) {
  const result = String(value ?? "");
  if (!/^[a-f0-9]{64}$/.test(result)) throw new PosDomainError("Hash da referência manual inválido.");
  return result;
}

function sha256(value: string) {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(",")}}`;
}
