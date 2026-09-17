import assert from "node:assert/strict";
import test from "node:test";
import {
  authorizePosOperationalAction,
  PosOperationalAccessError,
  type PosOperationalBreakGlass,
  type PosOperationalRegisterAccess,
} from "../lib/erp/pos-operational-access";

const now = new Date("2026-08-29T08:00:00.000Z");

function access(overrides: Partial<PosOperationalRegisterAccess> = {}): PosOperationalRegisterAccess {
  return {
    id: 41,
    branchId: 10,
    registerId: 20,
    userProfileId: 30,
    active: true,
    canOpen: true,
    canClose: true,
    canSell: true,
    canSupply: true,
    canWithdraw: false,
    canCancel: false,
    canRefund: false,
    canReprint: true,
    canManualPayment: false,
    canTransferHeld: true,
    maxDiscountBasisPoints: 500,
    validFrom: new Date(now.valueOf() - 60_000),
    validUntil: new Date(now.valueOf() + 60_000),
    ...overrides,
  };
}

function breakGlass(overrides: Partial<PosOperationalBreakGlass> = {}): PosOperationalBreakGlass {
  return {
    id: "bg_01",
    state: "approved",
    actorUserId: "user_operator",
    actorProfileId: 30,
    branchId: 10,
    registerId: 20,
    action: "cash.withdraw",
    operationKey: "withdrawal_operation_01",
    requestedByUserId: "user_operator",
    approvedByUserId: "user_checker",
    approvalId: "approval_01",
    stepUpEvidenceId: "stepup_01",
    reasonCode: "emergency_cash",
    requestHash: "a".repeat(64),
    approvedAt: new Date(now.valueOf() - 30_000),
    expiresAt: new Date(now.valueOf() + 60_000),
    usesRemaining: 1,
    ...overrides,
  };
}

function authorize(overrides: Record<string, unknown> = {}) {
  return authorizePosOperationalAction({
    action: "sale.commit",
    actorUserId: "user_operator",
    actorProfileId: 30,
    actorProfileActive: true,
    branchId: 10,
    branchActive: true,
    registerId: 20,
    registerActive: true,
    branchCanSell: true,
    registerAccess: access(),
    now,
    ...overrides,
  });
}

test("acesso explícito exato autoriza somente a permissão concedida", () => {
  const result = authorize();
  assert.deepEqual(result, {
    source: "explicit_access",
    action: "sale.commit",
    branchId: 10,
    registerId: 20,
    actorProfileId: 30,
    registerAccessId: 41,
    breakGlassId: null,
    operationKey: null,
    maxDiscountBasisPoints: 500,
  });
  assert.throws(() => authorize({ action: "cash.withdraw" }), PosOperationalAccessError);
});

test("nenhum papel gerencial implícito existe quando faltam acessos operacionais", () => {
  assert.throws(() => authorize({ registerAccess: null }), /acesso explícito vigente/i);
  assert.throws(() => authorize({ branchCanSell: false }), /acesso explícito vigente/i);
  assert.throws(() => authorize({ registerAccess: access({ id: 0 }) }), /acesso explícito vigente/i);
});

test("contexto, vigência e revogação do acesso são fail-closed", () => {
  assert.throws(() => authorize({ registerAccess: access({ registerId: 21 }) }), PosOperationalAccessError);
  assert.throws(() => authorize({ registerAccess: access({ userProfileId: 31 }) }), PosOperationalAccessError);
  assert.throws(() => authorize({ registerAccess: access({ active: false }) }), PosOperationalAccessError);
  assert.throws(() => authorize({ actorProfileActive: false }), PosOperationalAccessError);
  assert.throws(() => authorize({ branchActive: false }), PosOperationalAccessError);
  assert.throws(() => authorize({ registerActive: false }), PosOperationalAccessError);
  assert.throws(() => authorize({ registerAccess: access({ validUntil: new Date(now.valueOf() - 1) }) }), PosOperationalAccessError);
  assert.throws(() => authorize({ registerAccess: access({ validFrom: new Date(now.valueOf() + 1) }) }), PosOperationalAccessError);
});

test("break-glass exato exige checker distinto, step-up, TTL curto e uso único", () => {
  const result = authorize({
    action: "cash.withdraw",
    registerAccess: access({ canWithdraw: false }),
    operationKey: "withdrawal_operation_01",
    breakGlass: breakGlass(),
  });
  assert.equal(result.source, "break_glass");
  assert.equal(result.breakGlassId, "bg_01");
  assert.equal(result.maxDiscountBasisPoints, 0);

  assert.throws(() => authorize({ action: "cash.withdraw", registerAccess: null, operationKey: "withdrawal_operation_01", breakGlass: breakGlass({ approvedByUserId: "user_operator" }) }), PosOperationalAccessError);
  assert.throws(() => authorize({ action: "cash.withdraw", registerAccess: null, operationKey: "withdrawal_operation_01", breakGlass: breakGlass({ usesRemaining: 0 }) }), PosOperationalAccessError);
  assert.throws(() => authorize({ action: "cash.withdraw", registerAccess: null, operationKey: "withdrawal_operation_01", breakGlass: breakGlass({ expiresAt: new Date(now.valueOf() + 16 * 60_000) }) }), PosOperationalAccessError);
  assert.throws(() => authorize({ action: "cash.withdraw", registerAccess: null, operationKey: "different_operation_01", breakGlass: breakGlass() }), PosOperationalAccessError);
});

test("break-glass não é transferível entre ação, pessoa, caixa ou tempo", () => {
  const base = { registerAccess: null, operationKey: "withdrawal_operation_01", breakGlass: breakGlass() };
  assert.throws(() => authorize({ ...base, action: "sale.refund" }), PosOperationalAccessError);
  assert.throws(() => authorize({ ...base, actorProfileId: 31 }), PosOperationalAccessError);
  assert.throws(() => authorize({ ...base, registerId: 21 }), PosOperationalAccessError);
  assert.throws(() => authorize({ ...base, now: new Date(now.valueOf() + 61_000) }), PosOperationalAccessError);
});
