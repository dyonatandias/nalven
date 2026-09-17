export const POS_OPERATIONAL_ACTIONS = [
  "session.open",
  "session.close",
  "sale.prepare",
  "sale.commit",
  "cash.supply",
  "cash.withdraw",
  "sale.cancel",
  "sale.refund",
  "receipt.reprint",
  "payment.manual",
  "cart.transfer",
] as const;

export type PosOperationalAction = typeof POS_OPERATIONAL_ACTIONS[number];

export type PosOperationalRegisterAccess = Readonly<{
  id: number;
  branchId: number;
  registerId: number;
  userProfileId: number;
  active: boolean;
  canOpen: boolean;
  canClose: boolean;
  canSell: boolean;
  canSupply: boolean;
  canWithdraw: boolean;
  canCancel: boolean;
  canRefund: boolean;
  canReprint: boolean;
  canManualPayment: boolean;
  canTransferHeld: boolean;
  maxDiscountBasisPoints: number;
  validFrom: Date | null;
  validUntil: Date | null;
}>;

export type PosOperationalBreakGlass = Readonly<{
  id: string;
  state: "approved" | "consumed" | "expired" | "rejected" | "revoked";
  actorUserId: string;
  actorProfileId: number;
  branchId: number;
  registerId: number;
  action: PosOperationalAction;
  operationKey: string;
  requestedByUserId: string;
  approvedByUserId: string;
  approvalId: string;
  stepUpEvidenceId: string;
  reasonCode: string;
  requestHash: string;
  approvedAt: Date;
  expiresAt: Date;
  usesRemaining: number;
}>;

export type PosOperationalAuthorization = Readonly<{
  source: "explicit_access" | "break_glass";
  action: PosOperationalAction;
  branchId: number;
  registerId: number;
  actorProfileId: number;
  registerAccessId: number | null;
  breakGlassId: string | null;
  operationKey: string | null;
  maxDiscountBasisPoints: number;
}>;

export class PosOperationalAccessError extends Error {
  readonly status = 403;

  constructor(message: string) {
    super(message);
    this.name = "PosOperationalAccessError";
  }
}

/**
 * Operational authority is intentionally independent from the tenant's
 * management role. Callers must provide a live branch/register grant or an
 * exact, single-use, independently approved break-glass record.
 */
export function authorizePosOperationalAction(input: Readonly<{
  action: PosOperationalAction;
  actorUserId: string;
  actorProfileId: number;
  actorProfileActive: boolean;
  branchId: number;
  branchActive: boolean;
  registerId: number;
  registerActive: boolean;
  branchCanSell: boolean;
  registerAccess: PosOperationalRegisterAccess | null;
  operationKey?: string | null;
  breakGlass?: PosOperationalBreakGlass | null;
  now?: Date;
}>): PosOperationalAuthorization {
  const now = validDate(input.now ?? new Date(), "Relógio operacional");
  const action = operationalAction(input.action);
  const actorUserId = identifier(input.actorUserId, "Usuário operacional", 1, 160);
  const actorProfileId = positiveInteger(input.actorProfileId, "Perfil operacional");
  const branchId = positiveInteger(input.branchId, "Filial operacional");
  const registerId = positiveInteger(input.registerId, "Caixa operacional");
  if (!input.actorProfileActive || !input.branchActive || !input.registerActive) throw denied();

  const access = input.registerAccess;
  if (input.branchCanSell && access && liveExplicitAccess(access, { actorProfileId, branchId, registerId, now }) && permits(access, action)) {
    return Object.freeze({
      source: "explicit_access",
      action,
      branchId,
      registerId,
      actorProfileId,
      registerAccessId: access.id,
      breakGlassId: null,
      operationKey: null,
      maxDiscountBasisPoints: access.maxDiscountBasisPoints,
    });
  }

  const grant = input.breakGlass;
  if (!grant) throw denied();
  const operationKey = identifier(input.operationKey, "Operação excepcional", 16, 160);
  validateBreakGlass(grant, { action, actorUserId, actorProfileId, branchId, registerId, operationKey, now });
  return Object.freeze({
    source: "break_glass",
    action,
    branchId,
    registerId,
    actorProfileId,
    registerAccessId: null,
    breakGlassId: grant.id,
    operationKey,
    maxDiscountBasisPoints: 0,
  });
}

function liveExplicitAccess(access: PosOperationalRegisterAccess, expected: { actorProfileId: number; branchId: number; registerId: number; now: Date }) {
  if (!Number.isSafeInteger(access.id) || access.id <= 0 || !access.active || !access.canSell) return false;
  if (access.userProfileId !== expected.actorProfileId || access.branchId !== expected.branchId || access.registerId !== expected.registerId) return false;
  if (access.validFrom && validDate(access.validFrom, "Início do acesso") > expected.now) return false;
  if (access.validUntil && validDate(access.validUntil, "Fim do acesso") < expected.now) return false;
  return Number.isSafeInteger(access.maxDiscountBasisPoints) && access.maxDiscountBasisPoints >= 0 && access.maxDiscountBasisPoints <= 10_000;
}

function permits(access: PosOperationalRegisterAccess, action: PosOperationalAction) {
  const permissions: Record<PosOperationalAction, boolean> = {
    "session.open": access.canOpen,
    "session.close": access.canClose,
    "sale.prepare": access.canSell,
    "sale.commit": access.canSell,
    "cash.supply": access.canSupply,
    "cash.withdraw": access.canWithdraw,
    "sale.cancel": access.canCancel,
    "sale.refund": access.canRefund,
    "receipt.reprint": access.canReprint,
    "payment.manual": access.canManualPayment,
    "cart.transfer": access.canTransferHeld,
  };
  return permissions[action];
}

function validateBreakGlass(grant: PosOperationalBreakGlass, expected: {
  action: PosOperationalAction;
  actorUserId: string;
  actorProfileId: number;
  branchId: number;
  registerId: number;
  operationKey: string;
  now: Date;
}) {
  identifier(grant.id, "Autorização excepcional", 1, 160);
  identifier(grant.approvalId, "Aprovação excepcional", 1, 160);
  identifier(grant.stepUpEvidenceId, "Evidência de step-up", 1, 160);
  identifier(grant.reasonCode, "Motivo excepcional", 2, 80);
  sha256(grant.requestHash, "Hash da autorização excepcional");
  const approvedAt = validDate(grant.approvedAt, "Aprovação excepcional");
  const expiresAt = validDate(grant.expiresAt, "Expiração excepcional");
  const exactContext = grant.actorUserId === expected.actorUserId
    && grant.actorProfileId === expected.actorProfileId
    && grant.branchId === expected.branchId
    && grant.registerId === expected.registerId
    && grant.action === expected.action
    && grant.operationKey === expected.operationKey;
  const independent = grant.requestedByUserId === expected.actorUserId && grant.approvedByUserId !== expected.actorUserId;
  const live = grant.state === "approved"
    && grant.usesRemaining === 1
    && approvedAt <= expected.now
    && expiresAt >= expected.now
    && expiresAt.valueOf() - approvedAt.valueOf() <= 15 * 60_000;
  if (!exactContext || !independent || !live) throw denied();
}

function operationalAction(value: unknown): PosOperationalAction {
  if (!POS_OPERATIONAL_ACTIONS.includes(value as PosOperationalAction)) throw denied();
  return value as PosOperationalAction;
}

function validDate(value: unknown, label: string) {
  if (!(value instanceof Date) || !Number.isFinite(value.valueOf())) throw new PosOperationalAccessError(`${label} inválido.`);
  return value;
}

function positiveInteger(value: unknown, label: string) {
  if (!Number.isSafeInteger(value) || Number(value) <= 0) throw new PosOperationalAccessError(`${label} inválido.`);
  return Number(value);
}

function identifier(value: unknown, label: string, minimum: number, maximum: number) {
  const result = typeof value === "string" ? value.normalize("NFKC").trim() : "";
  if (result.length < minimum || result.length > maximum || !/^[A-Za-z0-9._:-]+$/.test(result)) throw new PosOperationalAccessError(`${label} inválido.`);
  return result;
}

function sha256(value: unknown, label: string) {
  const result = String(value ?? "").toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(result)) throw new PosOperationalAccessError(`${label} inválido.`);
  return result;
}

function denied() {
  return new PosOperationalAccessError("A operação exige acesso explícito vigente ao caixa ou autorização excepcional exata.");
}
