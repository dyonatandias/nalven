import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { PrismaPg } from "@prisma/adapter-pg";
import { Prisma, PrismaClient } from "../generated/tenant/client";
import { createAgentToken, hashAgentToken } from "../lib/erp/pos-agent-auth";
import { acceptPosCashCustodyBag, deliverPosCashCustodyBag, reportPosCashCustodyDivergence, resolvePosCashCustodyDivergence, sealPosCashCustodyBag } from "../lib/erp/pos-cash-custody";
import { hashPosCashLedgerRequest, postPosCashLedgerEntry, reversePosCashLedgerEntry } from "../lib/erp/pos-cash-ledger";
import { authenticatePosOperationalTerminal, posOperationalTerminalSelect } from "../lib/erp/pos-terminal-boundary";

const connectionString = process.env.POS_TEST_DATABASE_URL;

test("PostgreSQL preserva ledger append-only, aprovação consumível e dupla custódia", { skip: !connectionString, timeout: 90_000 }, async () => {
  process.env.POS_AGENT_TOKEN_PEPPER ||= "postgres-cash-ledger-test-pepper-at-least-32-bytes";
  const db = client(), token = randomUUID(), compact = token.replaceAll("-", ""), now = new Date();
  try {
    const role = await db.tenantRole.create({ data: { key: `cash_${compact}`, name: "Cash ledger test", permissions: {}, active: true } });
    const branch = await db.branch.create({ data: { code: `CASH${compact}`, name: "Cash ledger branch", legalName: "Cash ledger branch Ltda", document: `CASHDOC${compact}` } });
    const register = await db.posRegister.create({ data: { branchId: branch.id, code: `REG${compact}`, name: "Cash ledger register" } });
    const actor = await profile(db, role.id, branch.id, `actor-${token}`, `actor-${compact}@example.invalid`, "Cash actor");
    const recipient = await profile(db, role.id, branch.id, `recipient-${token}`, `recipient-${compact}@example.invalid`, "Cash recipient");
    const resolver = await profile(db, role.id, branch.id, `resolver-${token}`, `resolver-${compact}@example.invalid`, "Cash resolver");
    await db.posRegisterAccess.create({ data: { registerId: register.id, userProfileId: actor.id, canOpen: true, canClose: true, canSell: true, canSupply: true, canWithdraw: true, canCancel: true, canRefund: true } });
    const session = await db.cashRegisterSession.create({ data: { number: `CASH-${token}`, registerName: register.name, status: "open", openingAmount: 0, openingAmountCents: 0, openedBy: actor.displayName, registerId: register.id, operatorProfileId: actor.id } });
    const agentToken = createAgentToken();
    const terminal = await db.posTerminal.create({ data: {
      id: `terminal-${token}`, registerId: register.id, code: `TERM${compact}`, name: "Cash terminal", status: "online",
      tokenHash: hashAgentToken("cash-ledger-test-org", `terminal-${token}`, agentToken), tokenIssuedAt: now,
      tokenExpiresAt: new Date(now.valueOf() + 3_600_000), credentialVersion: 1, appVersion: "test-1", lastSeenAt: now, pairedAt: now,
    } });
    const terminalRecord = await db.posTerminal.findUnique({ where: { id: terminal.id }, select: posOperationalTerminalSelect });
    const terminalProof = authenticatePosOperationalTerminal(terminalRecord, { organizationId: "cash-ledger-test-org", terminalId: terminal.id, token: agentToken, now, expectedBranchId: branch.id, expectedRegisterId: register.id });
    const context = { branchId: branch.id, registerId: register.id, sessionId: session.id, terminalId: terminal.id, actorProfileId: actor.id, actorUserId: actor.userId, terminalProof };

    const openingInput = { entryType: "opening" as const, deltaCents: 0, referenceType: "cash_session", referenceId: String(session.id), idempotencyKey: `cash-opening-${token}`, correlationId: randomUUID(), reasonCode: "opening", description: "Abertura zero", occurredAt: new Date(now.valueOf() + 1_000) };
    const opening = await postPosCashLedgerEntry(db, context, openingInput);
    assert.equal(opening.sequence, 1); assert.equal(opening.balanceAfterCents, 0); assert.equal(opening.amountCents, 0);
    assert.equal((await postPosCashLedgerEntry(db, context, openingInput)).id, opening.id, "replay deve retornar a mesma linha");

    const concurrent = await Promise.all([
      postPosCashLedgerEntry(db, context, { entryType: "sale", deltaCents: 700, referenceType: "sale", referenceId: `sale-a-${token}`, idempotencyKey: `cash-sale-a-${token}`, correlationId: randomUUID(), reasonCode: "sale", description: "Venda A", occurredAt: new Date(now.valueOf() + 2_000) }),
      postPosCashLedgerEntry(db, context, { entryType: "supply", deltaCents: 300, referenceType: "cash_supply", referenceId: `supply-b-${token}`, idempotencyKey: `cash-supply-b-${token}`, correlationId: randomUUID(), reasonCode: "supply", description: "Suprimento B", occurredAt: new Date(now.valueOf() + 2_000) }),
    ]);
    assert.deepEqual(concurrent.map(entry => entry.sequence).sort((a, b) => a - b), [2, 3]);
    assert.equal((await latest(db, session.id)).balanceAfterCents, 1_000);

    await assert.rejects(postPosCashLedgerEntry(db, context, { entryType: "sale", deltaCents: -1, referenceType: "sale", referenceId: `bad-sale-${token}`, idempotencyKey: `cash-bad-sale-${token}`, correlationId: randomUUID(), reasonCode: "sale", description: "Sinal inválido" }), /devem aumentar/);
    const latestBeforeRaw = await latest(db, session.id);
    await assert.rejects(db.posCashLedgerEntry.create({ data: {
      branchId: branch.id, registerId: register.id, sessionId: session.id, terminalId: terminal.id, actorProfileId: actor.id,
      sequence: latestBeforeRaw.sequence + 1, entryType: "sale", amountCents: 1, deltaCents: -1,
      balanceBeforeCents: latestBeforeRaw.balanceAfterCents, balanceAfterCents: latestBeforeRaw.balanceAfterCents - 1,
      referenceType: "sale", referenceId: `raw-bad-${token}`, referenceSequence: 1, idempotencyKey: `cash-raw-bad-${token}`,
      requestHash: "a".repeat(64), correlationId: randomUUID(), reasonCode: "sale", description: "Direção inválida", occurredAt: new Date(now.valueOf() + 3_000),
    } }), /constraint|direction|check/i);
    await assert.rejects(db.posCashLedgerEntry.update({ where: { id: opening.id }, data: { description: "mutated" } }), /append-only/i);
    await assert.rejects(db.posCashLedgerEntry.delete({ where: { id: opening.id } }), /append-only/i);

    const adjustmentReference = `adjustment-${token}`, adjustmentDelta = 100;
    const adjustmentApproval = await approval(db, {
      branchId: branch.id, requesterId: actor.userId, approverId: resolver.userId, action: "cash.ledger.adjustment", entityType: "cash_register_session", entityId: String(session.id),
      context: { branchId: branch.id, registerId: register.id, sessionId: session.id, terminalId: terminal.id, deltaCents: adjustmentDelta, referenceType: "cash_adjustment", referenceId: adjustmentReference, referenceSequence: 1 },
      token: `adjustment-${token}`, now,
    });
    const adjustment = await postPosCashLedgerEntry(db, context, { entryType: "adjustment", deltaCents: adjustmentDelta, referenceType: "cash_adjustment", referenceId: adjustmentReference, idempotencyKey: `cash-adjustment-${token}`, correlationId: randomUUID(), approvalId: adjustmentApproval.id, reasonCode: "recount", description: "Ajuste aprovado", occurredAt: new Date(now.valueOf() + 4_000) });
    assert.ok((await db.posApproval.findUniqueOrThrow({ where: { id: adjustmentApproval.id } })).consumedAt);

    const reversalApproval = await approval(db, {
      branchId: branch.id, requesterId: actor.userId, approverId: resolver.userId, action: "cash.ledger.reversal", entityType: "cash_ledger_entry", entityId: adjustment.id.toString(),
      context: { branchId: branch.id, registerId: register.id, sessionId: session.id, terminalId: terminal.id, entryId: adjustment.id.toString(), deltaCents: -adjustment.deltaCents },
      token: `reversal-${token}`, now,
    });
    const reversalInput = { entryId: adjustment.id, approvalId: reversalApproval.id, idempotencyKey: `cash-reversal-${token}`, correlationId: randomUUID(), reasonCode: "operator_error", description: "Reversão compensatória", occurredAt: new Date(now.valueOf() + 5_000) };
    const reversal = await reversePosCashLedgerEntry(db, context, reversalInput);
    assert.equal(reversal.deltaCents, -adjustment.deltaCents); assert.equal(reversal.reversalForId, adjustment.id);
    assert.ok((await db.posApproval.findUniqueOrThrow({ where: { id: reversalApproval.id } })).consumedAt);
    assert.equal((await reversePosCashLedgerEntry(db, context, reversalInput)).id, reversal.id);
    await assert.rejects(postPosCashLedgerEntry(db, context, { entryType: "adjustment", deltaCents: 1, referenceType: "cash_adjustment", referenceId: `reuse-${token}`, idempotencyKey: `cash-reuse-approval-${token}`, correlationId: randomUUID(), approvalId: reversalApproval.id, reasonCode: "reuse", description: "Reuso proibido", occurredAt: new Date(now.valueOf() + 5_500) }), /aprovação/i);

    const bag = await sealPosCashCustodyBag(db, context, { sealNumber: `SEAL-${compact}`, amountCents: 400, idempotencyKey: `cash-bag-${token}`, correlationId: randomUUID(), occurredAt: new Date(now.valueOf() + 6_000) });
    await deliverPosCashCustodyBag(db, { branchId: branch.id, actorProfileId: actor.id, actorUserId: actor.userId }, { bagId: bag.id, recipientProfileId: recipient.id, idempotencyKey: `cash-deliver-${token}`, correlationId: randomUUID(), occurredAt: new Date(now.valueOf() + 7_000) });
    await assert.rejects(acceptPosCashCustodyBag(db, { branchId: branch.id, actorProfileId: actor.id, actorUserId: actor.userId }, { bagId: bag.id, observedAmountCents: 400, idempotencyKey: `cash-wrong-accept-${token}`, correlationId: randomUUID(), occurredAt: new Date(now.valueOf() + 8_000) }), /destinatário independente/);
    const accepted = await acceptPosCashCustodyBag(db, { branchId: branch.id, actorProfileId: recipient.id, actorUserId: recipient.userId }, { bagId: bag.id, observedAmountCents: 400, idempotencyKey: `cash-accept-${token}`, correlationId: randomUUID(), occurredAt: new Date(now.valueOf() + 8_000) });
    assert.equal(accepted.toState, "accepted");

    const disputedBag = await sealPosCashCustodyBag(db, context, { sealNumber: `SEAL2-${compact}`, amountCents: 200, idempotencyKey: `cash-bag2-${token}`, correlationId: randomUUID(), occurredAt: new Date(now.valueOf() + 9_000) });
    await deliverPosCashCustodyBag(db, { branchId: branch.id, actorProfileId: actor.id, actorUserId: actor.userId }, { bagId: disputedBag.id, recipientProfileId: recipient.id, idempotencyKey: `cash-deliver2-${token}`, correlationId: randomUUID(), occurredAt: new Date(now.valueOf() + 10_000) });
    const incident = await reportPosCashCustodyDivergence(db, { branchId: branch.id, actorProfileId: recipient.id, actorUserId: recipient.userId }, { bagId: disputedBag.id, observedAmountCents: 190, reasonCode: "seal_divergence", description: "Faltam dez centavos", idempotencyKey: `cash-incident-${token}`, correlationId: randomUUID(), occurredAt: new Date(now.valueOf() + 11_000) });
    await assert.rejects(acceptPosCashCustodyBag(db, { branchId: branch.id, actorProfileId: recipient.id, actorUserId: recipient.userId }, { bagId: disputedBag.id, observedAmountCents: 200, idempotencyKey: `cash-accept-incident-${token}`, correlationId: randomUUID(), occurredAt: new Date(now.valueOf() + 12_000) }), /incidente/);
    const resolutionSnapshot = { branchId: branch.id, bagId: disputedBag.id, incidentId: incident.id, expectedAmountCents: 200, observedAmountCents: 190, differenceCents: -10, finalAmountCents: 190, resolutionType: "accepted_difference" };
    const resolutionApproval = await approval(db, { branchId: branch.id, requesterId: resolver.userId, approverId: actor.userId, action: "cash.custody.divergence.resolve", entityType: "cash_custody_incident", entityId: incident.id, context: resolutionSnapshot, token: `resolution-${token}`, now });
    const resolution = await resolvePosCashCustodyDivergence(db, { branchId: branch.id, actorProfileId: resolver.id, actorUserId: resolver.userId }, { incidentId: incident.id, approvalId: resolutionApproval.id, resolutionType: "accepted_difference", finalAmountCents: 190, notes: "Diferença aceita pela tesouraria", idempotencyKey: `cash-resolution-${token}`, correlationId: randomUUID(), occurredAt: new Date(now.valueOf() + 13_000) });
    assert.equal(resolution.incidentId, incident.id);
    assert.ok((await db.posApproval.findUniqueOrThrow({ where: { id: resolutionApproval.id } })).consumedAt);
    assert.equal((await db.posCashCustodyEvent.findFirstOrThrow({ where: { bagId: disputedBag.id }, orderBy: { sequence: "desc" } })).toState, "accepted");
  } finally {
    await db.$disconnect();
  }
});

function client() { return new PrismaClient({ adapter: new PrismaPg({ connectionString: connectionString! }) }); }
async function profile(db: PrismaClient, roleId: number, branchId: number, userId: string, email: string, displayName: string) { return db.tenantUserProfile.create({ data: { userId, roleId, displayName, email, activeBranchId: branchId } }); }
async function latest(db: PrismaClient, sessionId: number) { return db.posCashLedgerEntry.findFirstOrThrow({ where: { sessionId }, orderBy: { sequence: "desc" } }); }
async function approval(db: PrismaClient, input: { branchId: number; requesterId: string; approverId: string; action: string; entityType: string; entityId: string; context: Prisma.InputJsonObject; token: string; now: Date }) {
  return db.posApproval.create({ data: {
    id: randomUUID(), branchId: input.branchId, action: input.action, entityType: input.entityType, entityId: input.entityId,
    status: "approved", requesterId: input.requesterId, requesterName: input.requesterId, approverId: input.approverId, approverName: input.approverId,
    reason: "Fixture PostgreSQL", context: input.context, correlationId: randomUUID(), idempotencyKey: `approval-${input.token}`,
    requestHash: hashPosCashLedgerRequest(input.context), decidedAt: input.now, expiresAt: new Date(input.now.valueOf() + 3_600_000),
  } });
}
