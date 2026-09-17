import assert from "node:assert/strict";
import test from "node:test";
import {
  applyPosHeldCartTransfer,
  assertPosHeldCartTransferReplay,
  hashPosHeldCartTransfer,
  listPosHeldCartTransferTargets,
  parsePosHeldCartTransferInput,
  PosHeldCartTransferError,
  type PosHeldCartTransferContext,
  type PosHeldCartTransferInput,
} from "../lib/erp/pos-held-cart-transfer";

const context: PosHeldCartTransferContext = { branchId: 7, actorUserId: "user-a", actorProfileId: 11, actorName: "Operador A", privileged: true };
const input: PosHeldCartTransferInput = {
  heldSaleId: "held-cart-1",
  sourceSessionId: 101,
  targetSessionId: 202,
  expectedRevision: 3,
  idempotencyKey: "transfer:held-cart-1:0001",
  reason: "Continuidade do atendimento",
};

test("parser de transferência é estrito e impede self/revisão/chave fracas", () => {
  assert.deepEqual(parsePosHeldCartTransferInput(input), input);
  assert.throws(() => parsePosHeldCartTransferInput({ ...input, targetSessionId: input.sourceSessionId }), /diferente/);
  assert.throws(() => parsePosHeldCartTransferInput({ ...input, expectedRevision: -1 }), /Revisão/);
  assert.throws(() => parsePosHeldCartTransferInput({ ...input, idempotencyKey: "curta" }), /idempotente/);
  assert.throws(() => parsePosHeldCartTransferInput({ ...input, injected: true }), /Campo não permitido/);
});

test("hash e replay vinculam ator, filial, destino, revisão e motivo", () => {
  const hash = hashPosHeldCartTransfer(input);
  assert.match(hash, /^[0-9a-f]{64}$/);
  assert.equal(hashPosHeldCartTransfer({ ...input, idempotencyKey: "outra-chave-idempotente-0001" }), hash, "a chave identifica o registro, não muda a identidade do comando");
  assert.notEqual(hashPosHeldCartTransfer({ ...input, targetSessionId: 303 }), hash);
  assert.notEqual(hashPosHeldCartTransfer({ ...input, expectedRevision: 4 }), hash);
  assert.doesNotThrow(() => assertPosHeldCartTransferReplay({ actorUserId: context.actorUserId, actorProfileId: context.actorProfileId, branchId: context.branchId, requestHash: hash }, context, hash));
  assert.throws(() => assertPosHeldCartTransferReplay({ actorUserId: "other", actorProfileId: context.actorProfileId, branchId: context.branchId, requestHash: hash }, context, hash), /outro contexto/);
  assert.throws(() => assertPosHeldCartTransferReplay({ actorUserId: context.actorUserId, actorProfileId: context.actorProfileId, branchId: context.branchId, requestHash: "0".repeat(64) }, context, hash), /outro destino/);
});

test("lista somente turnos receptores autorizados da filial", async () => {
  const target = (id: number, profileId: number, role: string, branchCanSell: boolean, registerCanSell: boolean) => ({
    id,
    number: `CX-${id}`,
    registerId: id + 1000,
    operatorProfileId: profileId,
    register: { id: id + 1000, name: `Caixa ${id}`, code: `C${id}`, branchId: 7, status: "active" },
    operatorProfile: {
      id: profileId,
      displayName: `Operador ${profileId}`,
      status: "active",
      role: { key: role, active: true },
      branchAccesses: [{ canSell: branchCanSell }],
      posRegisterAccesses: registerCanSell ? [{ registerId: id + 1000, canSell: true }] : [],
    },
  });
  const db = {
    posHeldSale: { findFirst: async () => ({ id: input.heldSaleId, registerId: 10, sessionId: input.sourceSessionId, revision: 3, expiresAt: null }) },
    cashRegisterSession: { findMany: async () => [target(202, 22, "seller", true, true), target(303, 33, "seller", true, false), target(404, 44, "admin", false, false)] },
    posHeldSaleTransfer: {}, branchUserAccess: {}, posRegisterAccess: {},
  };
  const result = await listPosHeldCartTransferTargets(db as never, context, input.heldSaleId, input.sourceSessionId);
  assert.equal(result.revision, 3);
  assert.deepEqual(result.targets.map(target => target.sessionId), [202, 404]);
});

test("aplica troca de posse por CAS e grava ledger e auditoria no mesmo fluxo", async () => {
  const calls: Array<{ kind: string; value: unknown }> = [];
  let sessionLookup = 0;
  const transferRecord = {
    id: BigInt(9), heldSaleId: input.heldSaleId, branchId: 7,
    fromRegisterId: 10, fromSessionId: 101, fromOperatorProfileId: 11,
    toRegisterId: 20, toSessionId: 202, toOperatorProfileId: 22,
    actorProfileId: 11, actorUserId: "user-a", expectedRevision: 3, resultingRevision: 4,
    idempotencyKey: input.idempotencyKey, requestHash: hashPosHeldCartTransfer(input), reason: input.reason, createdAt: new Date("2026-08-29T12:00:00Z"),
  };
  const tx = {
    $queryRaw: async () => [],
    posHeldSale: {
      findUnique: async () => ({ id: input.heldSaleId, registerId: 10, sessionId: 101, operatorProfileId: 11, status: "held", revision: 3, expiresAt: null }),
      updateMany: async (value: unknown) => { calls.push({ kind: "cas", value }); return { count: 1 }; },
    },
    cashRegisterSession: {
      findFirst: async () => {
        sessionLookup += 1;
        return sessionLookup === 1 ? { id: 101 } : {
          id: 202, number: "CX-202", registerId: 20, operatorProfileId: 22,
          register: { id: 20, name: "Caixa B", code: "B", branchId: 7, status: "active" },
          operatorProfile: { id: 22, displayName: "Operador B", status: "active", role: { key: "admin", active: true }, branchAccesses: [], posRegisterAccesses: [] },
        };
      },
    },
    posHeldSaleTransfer: { create: async ({ data }: { data: unknown }) => { calls.push({ kind: "ledger", value: data }); return transferRecord; } },
    tenantAuditEvent: { create: async ({ data }: { data: unknown }) => { calls.push({ kind: "audit", value: data }); return {}; } },
    branchUserAccess: {}, posRegisterAccess: {},
  };
  const saved = await applyPosHeldCartTransfer(tx as never, context, input);
  assert.equal(saved.resultingRevision, 4);
  assert.deepEqual(calls.map(call => call.kind), ["cas", "ledger", "audit"]);
  assert.match(JSON.stringify(calls[0].value), /"revision":\{"increment":1\}/);
  assert.match(JSON.stringify(calls[2].value), /pos\.held_cart\.transferred/);
});

test("falha fechado em revisão obsoleta antes de trocar posse", async () => {
  const tx = {
    $queryRaw: async () => [],
    posHeldSale: { findUnique: async () => ({ id: input.heldSaleId, registerId: 10, sessionId: 101, operatorProfileId: 11, status: "held", revision: 4, expiresAt: null }) },
  };
  await assert.rejects(() => applyPosHeldCartTransfer(tx as never, context, input), (error) => error instanceof PosHeldCartTransferError && error.status === 409 && /desatualizada/.test(error.message));
});
