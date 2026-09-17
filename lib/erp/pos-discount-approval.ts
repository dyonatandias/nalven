import { PosDomainError } from "@/lib/erp/pos-domain";

export type PosDiscountApprovalContext = {
  saleDraftId: string;
  sessionId: number;
  grossCents: number;
  manualDiscountCents: number;
  basisPoints: number;
};

export function buildPosDiscountApproval(input: {
  saleDraftId: string;
  sessionId: number;
  grossCents: number;
  orderDiscountCents: number;
  lineDiscountCents: number;
  settingsMaximumPercent: number;
  accessMaximumBasisPoints: number;
}) {
  const saleDraftId = saleDraft(input.saleDraftId);
  const sessionId = positiveInteger(input.sessionId, "Turno");
  const grossCents = positiveCents(input.grossCents, "Valor bruto");
  const orderDiscountCents = nonNegativeCents(input.orderDiscountCents, "Desconto da venda");
  const lineDiscountCents = nonNegativeCents(input.lineDiscountCents, "Desconto dos itens");
  const manualDiscountCents = orderDiscountCents + lineDiscountCents;
  if (!Number.isSafeInteger(manualDiscountCents) || manualDiscountCents > grossCents) throw new PosDomainError("O desconto manual não pode superar o valor bruto da venda.");
  const settingsMaximumPercent = percent(input.settingsMaximumPercent);
  const accessMaximumBasisPoints = basisPoints(input.accessMaximumBasisPoints, "Alçada do operador");
  const maximumPercent = Math.min(settingsMaximumPercent, accessMaximumBasisPoints / 100);
  const actualBasisPoints = Math.round(manualDiscountCents * 10_000 / grossCents);
  const context: PosDiscountApprovalContext = { saleDraftId, sessionId, grossCents, manualDiscountCents, basisPoints: actualBasisPoints };
  return {
    context,
    maximumPercent,
    maximumBasisPoints: Math.round(maximumPercent * 100),
    requiresApproval: manualDiscountCents * 10_000 > grossCents * maximumPercent * 100,
  };
}

export function normalizePosDiscountApprovalContext(value: unknown, entityId?: string | null): PosDiscountApprovalContext {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new PosDomainError("Contexto do desconto excepcional inválido.");
  const record = value as Record<string, unknown>;
  const allowed = ["saleDraftId", "sessionId", "grossCents", "manualDiscountCents", "basisPoints"];
  const extra = Object.keys(record).find((key) => !allowed.includes(key));
  const missing = allowed.find((key) => !Object.hasOwn(record, key));
  if (extra || missing || Object.keys(record).length !== allowed.length) throw new PosDomainError("O contexto do desconto excepcional deve conter somente os valores comerciais exigidos.");
  const context = {
    saleDraftId: saleDraft(record.saleDraftId),
    sessionId: positiveInteger(record.sessionId, "Turno"),
    grossCents: positiveCents(record.grossCents, "Valor bruto"),
    manualDiscountCents: nonNegativeCents(record.manualDiscountCents, "Desconto manual"),
    basisPoints: basisPoints(record.basisPoints, "Percentual do desconto"),
  };
  if (context.manualDiscountCents <= 0 || context.manualDiscountCents > context.grossCents) throw new PosDomainError("Valor do desconto excepcional inválido.");
  if (context.basisPoints !== Math.round(context.manualDiscountCents * 10_000 / context.grossCents)) throw new PosDomainError("Percentual do desconto excepcional não corresponde aos valores informados.");
  if (entityId != null && context.saleDraftId !== entityId) throw new PosDomainError("O contexto do desconto não corresponde ao rascunho da venda.");
  return context;
}

export function assertPosDiscountApprovalContext(value: unknown, expected: PosDiscountApprovalContext) {
  const actual = normalizePosDiscountApprovalContext(value, expected.saleDraftId);
  if (actual.saleDraftId !== expected.saleDraftId
    || actual.sessionId !== expected.sessionId
    || actual.grossCents !== expected.grossCents
    || actual.manualDiscountCents !== expected.manualDiscountCents
    || actual.basisPoints !== expected.basisPoints) {
    throw new PosDomainError("A aprovação de desconto não corresponde aos valores atuais da venda.");
  }
  return actual;
}

function saleDraft(value: unknown) {
  const result = String(value ?? "").trim();
  if (result.length < 8 || result.length > 100 || !/^[A-Za-z0-9._:-]+$/.test(result)) throw new PosDomainError("Identificador do rascunho da venda inválido.");
  return result;
}

function positiveInteger(value: unknown, label: string) {
  const result = Number(value);
  if (!Number.isSafeInteger(result) || result <= 0 || result > 2_147_483_647) throw new PosDomainError(`${label} inválido.`);
  return result;
}

function positiveCents(value: unknown, label: string) {
  const result = nonNegativeCents(value, label);
  if (result <= 0) throw new PosDomainError(`${label} deve ser positivo.`);
  return result;
}

function nonNegativeCents(value: unknown, label: string) {
  const result = Number(value);
  if (!Number.isSafeInteger(result) || result < 0 || result > 2_147_483_647) throw new PosDomainError(`${label} inválido.`);
  return result;
}

function basisPoints(value: unknown, label: string) {
  const result = Number(value);
  if (!Number.isSafeInteger(result) || result < 0 || result > 10_000) throw new PosDomainError(`${label} inválido.`);
  return result;
}

function percent(value: unknown) {
  const result = Number(value);
  if (!Number.isFinite(result) || result < 0 || result > 100) throw new PosDomainError("Alçada global de desconto inválida.");
  return result;
}
