import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../generated/tenant/client";

const connectionString = process.env.POS_TEST_DATABASE_URL;

test("PostgreSQL mantém posse exclusiva e aceita uma passagem de turno uma única vez", { skip: !connectionString }, async () => {
  const first = client(), second = client(), token = randomUUID(), compact = token.replaceAll("-", "");
  let branchId: number | null = null;
  try {
    const role = await first.tenantRole.findFirst({ where: { active: true }, select: { id: true } });
    assert.ok(role, "a base descartável deve possuir um papel ativo");
    const branch = await first.branch.create({ data: { code: `PG-HANDOFF-${compact}`, name: "Filial passagem PostgreSQL", legalName: "Filial passagem PostgreSQL Ltda", document: `PGHO${compact}` } });
    branchId = branch.id;
    const profiles = await Promise.all(["A", "B"].map((suffix) => first.tenantUserProfile.create({ data: { userId: `pg-handoff-${suffix}-${token}`, roleId: role.id, displayName: `Operador ${suffix}`, email: `pg-handoff-${suffix}-${compact}@example.invalid`, activeBranchId: branch.id } })));
    await first.branchUserAccess.createMany({ data: profiles.map((profile) => ({ branchId: branch.id, userProfileId: profile.id, canSell: true })) });
    const register = await first.posRegister.create({ data: { branchId: branch.id, code: `CX-${compact}`, name: "Caixa passagem" } });
    await first.posRegisterAccess.createMany({ data: profiles.map((profile) => ({ registerId: register.id, userProfileId: profile.id, canOpen: true, canClose: true, canSell: true })) });
    const session = await first.cashRegisterSession.create({ data: { number: `PG-HANDOFF-${token}`, registerName: register.name, status: "open", openingAmount: 0, openingAmountCents: 0, openedBy: profiles[0].displayName, registerId: register.id, operatorProfileId: profiles[0].id } });
    await first.cashRegisterEvent.create({ data: { sessionId: session.id, type: "session_suspended", amount: 0, amountCents: 0, description: "Marcador de lifecycle", actor: profiles[0].displayName, reasonCode: "session_suspended", correlationId: randomUUID(), idempotencyKey: `lifecycle-zero-${token}`, requestHash: "f".repeat(64) } });
    await assert.rejects(first.cashRegisterEvent.create({ data: { sessionId: session.id, type: "supply", amount: 0, amountCents: 0, description: "Movimento monetário inválido", actor: profiles[0].displayName, reasonCode: "supply", correlationId: randomUUID(), idempotencyKey: `money-zero-${token}`, requestHash: "e".repeat(64) } }), /positive_amount|check constraint/i, "evento monetário zero continua proibido");
    const heldSale = await first.posHeldSale.create({ data: { registerId: register.id, sessionId: session.id, operatorProfileId: profiles[0].id, label: "Carrinho levado com o turno", status: "held" } });
    const suspended = await first.cashRegisterSession.update({ where: { id: session.id }, data: { status: "suspended", suspendedAt: new Date(), suspendedBy: profiles[0].displayName, suspendedReason: "Troca de operador", version: { increment: 1 } } });

    await assert.rejects(first.cashRegisterSession.create({ data: { number: `PG-HANDOFF-DUP-${token}`, registerName: register.name, status: "open", openingAmount: 0, openingAmountCents: 0, openedBy: "Intruso", registerId: register.id } }), "turno suspenso continua ocupando o caixa");
    await assert.rejects(first.posSessionHandoff.create({ data: { id: `self_${compact}`, sessionId: session.id, branchId: branch.id, registerId: register.id, fromOperatorProfileId: profiles[0].id, toOperatorProfileId: profiles[0].id, reason: "Passagem inválida", expiresAt: new Date(Date.now() + 60_000), requestIdempotencyKey: `self-${token}`, requestHash: "s".repeat(64), heldSaleSnapshot: [], requestedByActorId: `actor-${token}` } }), "origem e destino devem ser diferentes");

    const handoff = await first.posSessionHandoff.create({ data: { id: `handoff_${compact}`, sessionId: session.id, branchId: branch.id, registerId: register.id, fromOperatorProfileId: profiles[0].id, toOperatorProfileId: profiles[1].id, reason: "Troca programada de operador", expiresAt: new Date(Date.now() + 60_000), requestIdempotencyKey: `request-${token}`, requestHash: "r".repeat(64), heldSaleSnapshot: [{ id: heldSale.id, revision: heldSale.revision }], requestedByActorId: `actor-a-${token}` } });
    await assert.rejects(first.posSessionHandoff.create({ data: { id: `handoff_dup_${compact}`, sessionId: session.id, branchId: branch.id, registerId: register.id, fromOperatorProfileId: profiles[0].id, toOperatorProfileId: profiles[1].id, reason: "Passagem duplicada", expiresAt: new Date(Date.now() + 60_000), requestIdempotencyKey: `request-dup-${token}`, requestHash: "d".repeat(64), heldSaleSnapshot: [{ id: heldSale.id, revision: heldSale.revision }], requestedByActorId: `actor-a-${token}` } }), "somente uma passagem pode ficar pendente");

    const accept = (db: ReturnType<typeof client>) => db.$transaction(async (tx) => {
      const claimed = await tx.posSessionHandoff.updateMany({ where: { id: handoff.id, state: "requested", revision: 1 }, data: { state: "accepted", revision: { increment: 1 }, transferredHeldSaleCount: 1, resolvedAt: new Date(), resolvedByActorId: `actor-b-${token}`, resolutionIdempotencyKey: `accept-${randomUUID()}`, resolutionRequestHash: "a".repeat(64) } });
      if (claimed.count !== 1) throw new Error("handoff already resolved");
      const movedHeld = await tx.posHeldSale.updateMany({ where: { id: heldSale.id, sessionId: session.id, registerId: register.id, operatorProfileId: profiles[0].id, status: "held", revision: heldSale.revision }, data: { operatorProfileId: profiles[1].id, revision: { increment: 1 } } });
      if (movedHeld.count !== 1) throw new Error("held cart already moved");
      const moved = await tx.cashRegisterSession.updateMany({ where: { id: session.id, status: "suspended", operatorProfileId: profiles[0].id, version: suspended.version }, data: { status: "open", operatorProfileId: profiles[1].id, suspendedAt: null, suspendedBy: null, suspendedReason: null, version: { increment: 1 } } });
      if (moved.count !== 1) throw new Error("session already moved");
    }, { isolationLevel: "Serializable" });
    const accepted = await Promise.allSettled([accept(first), accept(second)]);
    assert.equal(accepted.filter((result) => result.status === "fulfilled").length, 1);
    assert.equal(accepted.filter((result) => result.status === "rejected").length, 1);

    const [finalSession, finalHandoff, finalHeldSale] = await Promise.all([
      first.cashRegisterSession.findUniqueOrThrow({ where: { id: session.id } }),
      first.posSessionHandoff.findUniqueOrThrow({ where: { id: handoff.id } }),
      first.posHeldSale.findUniqueOrThrow({ where: { id: heldSale.id } }),
    ]);
    assert.deepEqual({ status: finalSession.status, operator: finalSession.operatorProfileId, version: finalSession.version, suspendedAt: finalSession.suspendedAt }, { status: "open", operator: profiles[1].id, version: suspended.version + 1, suspendedAt: null });
    assert.equal(finalHandoff.state, "accepted");
    assert.equal(finalHandoff.revision, 2);
    assert.equal(finalHandoff.transferredHeldSaleCount, 1);
    assert.deepEqual({ operator: finalHeldSale.operatorProfileId, revision: finalHeldSale.revision }, { operator: profiles[1].id, revision: heldSale.revision + 1 });
    await assert.rejects(first.cashRegisterSession.create({ data: { number: `PG-HANDOFF-OP-DUP-${token}`, registerName: "Outro caixa", status: "open", openingAmount: 0, openingAmountCents: 0, openedBy: profiles[1].displayName, operatorProfileId: profiles[1].id } }), "operador não pode possuir dois turnos ativos");
  } finally {
    if (branchId) {
      await first.posSessionHandoff.deleteMany({ where: { branchId } }).catch(() => undefined);
      await first.cashRegisterSession.deleteMany({ where: { register: { branchId } } }).catch(() => undefined);
      await first.posRegisterAccess.deleteMany({ where: { register: { branchId } } }).catch(() => undefined);
      await first.posRegister.deleteMany({ where: { branchId } }).catch(() => undefined);
      await first.branchUserAccess.deleteMany({ where: { branchId } }).catch(() => undefined);
      await first.tenantUserProfile.deleteMany({ where: { activeBranchId: branchId } }).catch(() => undefined);
      await first.branch.deleteMany({ where: { id: branchId } }).catch(() => undefined);
    }
    await Promise.all([first.$disconnect(), second.$disconnect()]);
  }
});

function client() {
  if (!connectionString) throw new Error("POS_TEST_DATABASE_URL não definida");
  return new PrismaClient({ adapter: new PrismaPg({ connectionString }) });
}
