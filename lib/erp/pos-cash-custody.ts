import { randomUUID } from "node:crypto";
import { Prisma, type PosCashCustodyEvent, type PrismaClient } from "@/generated/tenant/client";
import { appendPosCashLedgerEntryInTransaction, assertCashLedgerContext, hashPosCashLedgerRequest, posCashLedgerContextSnapshot, PosCashLedgerError, type PosCashLedgerContext } from "@/lib/erp/pos-cash-ledger";

export class PosCashCustodyError extends Error {
  constructor(message: string, readonly status = 422) {
    super(message);
    this.name = "PosCashCustodyError";
  }
}

export type PosCashCustodyState = "sealed" | "delivered" | "accepted" | "disputed";
export type PosCashCustodyEventType = "sealed" | "delivered" | "accepted" | "divergence_reported" | "divergence_resolved";
export type PosCashCustodyActorContext = { branchId: number; actorProfileId: number; actorUserId: string };

type RootDb = PrismaClient;
type Tx = Prisma.TransactionClient;
type LastEvent = { sequence: number; eventType: string; toState: string; actorProfileId: number; counterpartyProfileId: number | null; incidentId: string | null; occurredAt: Date };

export function assertPosCashCustodyTransition(last: LastEvent | null, input: {
  eventType: PosCashCustodyEventType;
  actorProfileId: number;
  counterpartyProfileId?: number | null;
  observedAmountCents?: number | null;
  expectedAmountCents: number;
  incidentId?: string | null;
  occurredAt: Date;
}) {
  const occurredAt = validDate(input.occurredAt, "Data do evento");
  if (!last) {
    if (input.eventType !== "sealed") throw new PosCashCustodyError("O primeiro evento do malote deve ser a selagem.", 409);
    return { sequence: 1, fromState: null, toState: "sealed" as const, occurredAt };
  }
  if (occurredAt < last.occurredAt) throw new PosCashCustodyError("A custódia não aceita eventos retroativos.", 409);
  if (input.eventType === "delivered") {
    if (last.eventType !== "sealed" || input.actorProfileId !== last.actorProfileId || !input.counterpartyProfileId || input.counterpartyProfileId === input.actorProfileId) throw new PosCashCustodyError("A entrega exige o custodiante atual e um destinatário diferente.", 409);
    return { sequence: last.sequence + 1, fromState: "sealed" as const, toState: "delivered" as const, occurredAt };
  }
  if (input.eventType === "accepted") {
    if (last.eventType !== "delivered" || input.actorProfileId !== last.counterpartyProfileId || input.actorProfileId === last.actorProfileId || input.observedAmountCents !== input.expectedAmountCents || input.incidentId) throw new PosCashCustodyError("O aceite exige o destinatário independente e o valor exato do lacre.", 409);
    return { sequence: last.sequence + 1, fromState: "delivered" as const, toState: "accepted" as const, occurredAt };
  }
  if (input.eventType === "divergence_reported") {
    if (last.eventType !== "delivered" || input.actorProfileId !== last.counterpartyProfileId || input.observedAmountCents === input.expectedAmountCents || !input.incidentId) throw new PosCashCustodyError("A divergência deve ser informada pelo destinatário e possuir valor divergente.", 409);
    return { sequence: last.sequence + 1, fromState: "delivered" as const, toState: "disputed" as const, occurredAt };
  }
  if (input.eventType === "divergence_resolved") {
    if (last.eventType !== "divergence_reported" || last.incidentId !== input.incidentId || input.actorProfileId === last.actorProfileId) throw new PosCashCustodyError("A resolução exige incidente vigente e ator independente.", 409);
    return { sequence: last.sequence + 1, fromState: "disputed" as const, toState: "accepted" as const, occurredAt };
  }
  throw new PosCashCustodyError("O malote já possui evento de selagem.", 409);
}

export async function sealPosCashCustodyBag(db: RootDb, contextValue: PosCashLedgerContext, inputValue: {
  sealNumber: string;
  amountCents: number;
  idempotencyKey: string;
  correlationId: string;
  notes?: string | null;
  occurredAt?: Date;
}) {
  const context = ledgerContext(contextValue), input = {
    sealNumber: sealNumber(inputValue.sealNumber), amountCents: positiveCents(inputValue.amountCents, "Valor do malote"),
    idempotencyKey: identifier(inputValue.idempotencyKey, "Chave idempotente", 16, 140), correlationId: uuid(inputValue.correlationId),
    notes: optionalText(inputValue.notes, 1000), occurredAt: validDate(inputValue.occurredAt ?? new Date(), "Data da selagem"),
  };
  const requestHash = hashPosCashLedgerRequest({ action: "cash.custody.seal", context: posCashLedgerContextSnapshot(context), input: dated(input) });
  const replay = await db.posCashCustodyBag.findUnique({ where: { idempotencyKey: input.idempotencyKey }, include: { ledgerEntry: true, events: true } });
  if (replay) return replayBag(replay, context, requestHash);
  const bagId = randomUUID();
  return serializable(db, async (tx) => {
    await lockSession(tx, context.sessionId);
    const concurrent = await tx.posCashCustodyBag.findUnique({ where: { idempotencyKey: input.idempotencyKey }, include: { ledgerEntry: true, events: true } });
    if (concurrent) return replayBag(concurrent, context, requestHash);
    await assertCashLedgerContext(tx, context, "custody_seal");
    const ledgerInput = {
      entryType: "custody_seal" as const, deltaCents: -input.amountCents, referenceType: "cash_custody_bag", referenceId: bagId,
      idempotencyKey: `${input.idempotencyKey}:ledger`, correlationId: input.correlationId, reasonCode: "custody_seal",
      description: `Selagem do malote ${input.sealNumber}`, occurredAt: input.occurredAt,
    };
    const ledgerHash = hashPosCashLedgerRequest({ action: "cash.custody.ledger", context: posCashLedgerContextSnapshot(context), input: dated(ledgerInput) });
    const ledgerEntry = await appendPosCashLedgerEntryInTransaction(tx, context, ledgerInput, ledgerHash);
    const bag = await tx.posCashCustodyBag.create({ data: {
      id: bagId, branchId: context.branchId, registerId: context.registerId, sessionId: context.sessionId, terminalId: context.terminalId,
      sealedByProfileId: context.actorProfileId, ledgerEntryId: ledgerEntry.id, sealNumber: input.sealNumber, amountCents: input.amountCents,
      currency: "BRL", idempotencyKey: input.idempotencyKey, requestHash, correlationId: input.correlationId, sealedAt: input.occurredAt,
    } });
    await tx.posCashCustodyEvent.create({ data: {
      bagId, sequence: 1, eventType: "sealed", fromState: null, toState: "sealed", actorProfileId: context.actorProfileId,
      idempotencyKey: `${input.idempotencyKey}:sealed`, requestHash, correlationId: input.correlationId, notes: input.notes, occurredAt: input.occurredAt,
    } });
    return { ...bag, ledgerEntry, events: await tx.posCashCustodyEvent.findMany({ where: { bagId }, orderBy: { sequence: "asc" } }) };
  }).catch(error => custodyConflict(error, "A selagem concorreu com outro movimento do caixa."));
}

export async function deliverPosCashCustodyBag(db: RootDb, contextValue: PosCashCustodyActorContext, inputValue: {
  bagId: string; recipientProfileId: number; idempotencyKey: string; correlationId: string; notes?: string | null; occurredAt?: Date;
}) {
  const context = actorContext(contextValue), input = eventInput(inputValue, "Data da entrega"), recipientProfileId = positiveInt(inputValue.recipientProfileId, "Destinatário");
  const requestHash = hashPosCashLedgerRequest({ action: "cash.custody.deliver", context, input: { ...dated(input), recipientProfileId } });
  return appendCustodyEvent(db, context, input, requestHash, async (tx, bag, last) => {
    await assertRecipientAtBranch(tx, context.branchId, recipientProfileId);
    const plan = assertPosCashCustodyTransition(last, { eventType: "delivered", actorProfileId: context.actorProfileId, counterpartyProfileId: recipientProfileId, expectedAmountCents: bag.amountCents, occurredAt: input.occurredAt });
    return tx.posCashCustodyEvent.create({ data: { bagId: bag.id, ...plan, eventType: "delivered", actorProfileId: context.actorProfileId, counterpartyProfileId: recipientProfileId, idempotencyKey: input.idempotencyKey, requestHash, correlationId: input.correlationId, notes: input.notes } });
  });
}

export async function acceptPosCashCustodyBag(db: RootDb, contextValue: PosCashCustodyActorContext, inputValue: {
  bagId: string; observedAmountCents: number; idempotencyKey: string; correlationId: string; notes?: string | null; occurredAt?: Date;
}) {
  const context = actorContext(contextValue), input = { ...eventInput(inputValue, "Data do aceite"), observedAmountCents: nonNegativeCents(inputValue.observedAmountCents, "Valor conferido") };
  const requestHash = hashPosCashLedgerRequest({ action: "cash.custody.accept", context, input: dated(input) });
  return appendCustodyEvent(db, context, input, requestHash, async (tx, bag, last) => {
    if (await tx.posCashCustodyIncident.count({ where: { bagId: bag.id } })) throw new PosCashCustodyError("O malote possui incidente e não pode seguir pelo aceite normal.", 409);
    const plan = assertPosCashCustodyTransition(last, { eventType: "accepted", actorProfileId: context.actorProfileId, observedAmountCents: input.observedAmountCents, expectedAmountCents: bag.amountCents, occurredAt: input.occurredAt });
    return tx.posCashCustodyEvent.create({ data: { bagId: bag.id, ...plan, eventType: "accepted", actorProfileId: context.actorProfileId, observedAmountCents: input.observedAmountCents, idempotencyKey: input.idempotencyKey, requestHash, correlationId: input.correlationId, notes: input.notes } });
  });
}

export async function reportPosCashCustodyDivergence(db: RootDb, contextValue: PosCashCustodyActorContext, inputValue: {
  bagId: string; observedAmountCents: number; reasonCode: string; description: string; idempotencyKey: string; correlationId: string; occurredAt?: Date;
}) {
  const context = actorContext(contextValue), input = {
    ...eventInput(inputValue, "Data da divergência"), observedAmountCents: nonNegativeCents(inputValue.observedAmountCents, "Valor conferido"),
    reasonCode: slug(inputValue.reasonCode, "Motivo"), description: identifier(inputValue.description, "Descrição", 1, 1000),
  };
  const requestHash = hashPosCashLedgerRequest({ action: "cash.custody.divergence", context, input: dated(input) });
  const replay = await db.posCashCustodyIncident.findUnique({ where: { idempotencyKey: input.idempotencyKey }, include: { events: true } });
  if (replay) return replayIncident(replay, input.bagId, context.actorProfileId, requestHash);
  return serializable(db, async (tx) => {
    await lockBag(tx, input.bagId);
    const concurrent = await tx.posCashCustodyIncident.findUnique({ where: { idempotencyKey: input.idempotencyKey }, include: { events: true } });
    if (concurrent) return replayIncident(concurrent, input.bagId, context.actorProfileId, requestHash);
    const bag = await ownedBag(tx, context.branchId, input.bagId);
    await assertActorAtBranch(tx, context);
    const last = await latestEvent(tx, bag.id);
    const incidentId = randomUUID();
    const plan = assertPosCashCustodyTransition(last, { eventType: "divergence_reported", actorProfileId: context.actorProfileId, observedAmountCents: input.observedAmountCents, expectedAmountCents: bag.amountCents, incidentId, occurredAt: input.occurredAt });
    const incident = await tx.posCashCustodyIncident.create({ data: {
      id: incidentId, bagId: bag.id, openedByProfileId: context.actorProfileId, expectedAmountCents: bag.amountCents,
      observedAmountCents: input.observedAmountCents, differenceCents: input.observedAmountCents - bag.amountCents,
      reasonCode: input.reasonCode, description: input.description, idempotencyKey: input.idempotencyKey, requestHash,
      correlationId: input.correlationId, openedAt: input.occurredAt,
    } });
    const event = await tx.posCashCustodyEvent.create({ data: {
      bagId: bag.id, ...plan, eventType: "divergence_reported", actorProfileId: context.actorProfileId, incidentId,
      observedAmountCents: input.observedAmountCents, idempotencyKey: `${input.idempotencyKey}:event`, requestHash,
      correlationId: input.correlationId, notes: input.description, occurredAt: input.occurredAt,
    } });
    return { ...incident, events: [event] };
  }).catch(error => custodyConflict(error, "A divergência concorreu com outro evento do malote."));
}

export async function resolvePosCashCustodyDivergence(db: RootDb, contextValue: PosCashCustodyActorContext, inputValue: {
  incidentId: string; approvalId: string; resolutionType: "accepted_difference" | "recount_confirmed" | "returned_to_origin";
  finalAmountCents: number; notes: string; idempotencyKey: string; correlationId: string; occurredAt?: Date;
}) {
  const context = actorContext(contextValue), input = {
    incidentId: identifier(inputValue.incidentId, "Incidente", 8, 160), approvalId: identifier(inputValue.approvalId, "Aprovação", 1, 160),
    resolutionType: resolutionType(inputValue.resolutionType), finalAmountCents: nonNegativeCents(inputValue.finalAmountCents, "Valor final"),
    notes: identifier(inputValue.notes, "Notas", 1, 1000), idempotencyKey: identifier(inputValue.idempotencyKey, "Chave idempotente", 16, 160),
    correlationId: uuid(inputValue.correlationId), occurredAt: validDate(inputValue.occurredAt ?? new Date(), "Data da resolução"),
  };
  const requestHash = hashPosCashLedgerRequest({ action: "cash.custody.resolve", context, input: dated(input) });
  const replay = await db.posCashCustodyIncidentResolution.findUnique({ where: { idempotencyKey: input.idempotencyKey } });
  if (replay) return replayResolution(replay, input.incidentId, context.actorProfileId, requestHash);
  return serializable(db, async (tx) => {
    const incident = await tx.posCashCustodyIncident.findUnique({ where: { id: input.incidentId }, include: { bag: true } });
    if (!incident || incident.bag.branchId !== context.branchId) throw new PosCashCustodyError("Incidente não encontrado nesta filial.", 404);
    await lockBag(tx, incident.bagId);
    const concurrent = await tx.posCashCustodyIncidentResolution.findUnique({ where: { idempotencyKey: input.idempotencyKey } });
    if (concurrent) return replayResolution(concurrent, input.incidentId, context.actorProfileId, requestHash);
    await assertActorAtBranch(tx, context);
    if (context.actorProfileId === incident.openedByProfileId) throw new PosCashCustodyError("O responsável pela divergência não pode resolvê-la.", 403);
    const last = await latestEvent(tx, incident.bagId);
    const plan = assertPosCashCustodyTransition(last, { eventType: "divergence_resolved", actorProfileId: context.actorProfileId, observedAmountCents: input.finalAmountCents, expectedAmountCents: incident.expectedAmountCents, incidentId: incident.id, occurredAt: input.occurredAt });
    await assertResolutionApproval(tx, context, incident, input);
    const resolution = await tx.posCashCustodyIncidentResolution.create({ data: {
      id: randomUUID(), incidentId: incident.id, resolvedByProfileId: context.actorProfileId, approvalId: input.approvalId,
      resolutionType: input.resolutionType, finalAmountCents: input.finalAmountCents, notes: input.notes,
      idempotencyKey: input.idempotencyKey, requestHash, correlationId: input.correlationId, resolvedAt: input.occurredAt,
    } });
    await tx.posCashCustodyEvent.create({ data: {
      bagId: incident.bagId, ...plan, eventType: "divergence_resolved", actorProfileId: context.actorProfileId, incidentId: incident.id,
      observedAmountCents: input.finalAmountCents, idempotencyKey: `${input.idempotencyKey}:event`, requestHash,
      correlationId: input.correlationId, notes: input.notes, occurredAt: input.occurredAt,
    } });
    return resolution;
  }).catch(error => custodyConflict(error, "A resolução concorreu com outro evento do malote."));
}

async function appendCustodyEvent<T extends { bagId: string; idempotencyKey: string; occurredAt: Date }>(db: RootDb, context: PosCashCustodyActorContext, input: T, requestHash: string, create: (tx: Tx, bag: Awaited<ReturnType<typeof ownedBag>>, last: LastEvent | null) => Promise<PosCashCustodyEvent>): Promise<PosCashCustodyEvent> {
  const replay = await db.posCashCustodyEvent.findUnique({ where: { idempotencyKey: input.idempotencyKey } });
  if (replay) return replayEvent(replay, input.bagId, context.actorProfileId, requestHash);
  return serializable(db, async (tx) => {
    await lockBag(tx, input.bagId);
    const concurrent = await tx.posCashCustodyEvent.findUnique({ where: { idempotencyKey: input.idempotencyKey } });
    if (concurrent) return replayEvent(concurrent, input.bagId, context.actorProfileId, requestHash);
    const bag = await ownedBag(tx, context.branchId, input.bagId);
    await assertActorAtBranch(tx, context);
    return create(tx, bag, await latestEvent(tx, bag.id));
  }).catch(error => custodyConflict(error, "A custódia concorreu com outro evento do malote."));
}

async function ownedBag(tx: Tx, branchId: number, bagId: string) {
  const bag = await tx.posCashCustodyBag.findFirst({ where: { id: bagId, branchId } });
  if (!bag) throw new PosCashCustodyError("Malote não encontrado nesta filial.", 404);
  return bag;
}
async function latestEvent(tx: Tx, bagId: string): Promise<LastEvent | null> { return tx.posCashCustodyEvent.findFirst({ where: { bagId }, select: { sequence: true, eventType: true, toState: true, actorProfileId: true, counterpartyProfileId: true, incidentId: true, occurredAt: true }, orderBy: { sequence: "desc" } }); }
async function assertActorAtBranch(tx: Tx, context: PosCashCustodyActorContext) {
  const actor = await tx.tenantUserProfile.findFirst({ where: { id: context.actorProfileId, userId: context.actorUserId, status: "active", OR: [{ activeBranchId: context.branchId }, { branchAccesses: { some: { branchId: context.branchId } } }] }, select: { id: true } });
  if (!actor) throw new PosCashCustodyError("Ator ativo não autorizado nesta filial.", 403);
}
async function assertRecipientAtBranch(tx: Tx, branchId: number, profileId: number) {
  const recipient = await tx.tenantUserProfile.findFirst({ where: { id: profileId, status: "active", OR: [{ activeBranchId: branchId }, { branchAccesses: { some: { branchId } } }] }, select: { id: true } });
  if (!recipient) throw new PosCashCustodyError("Destinatário ativo não autorizado nesta filial.", 403);
}
async function assertResolutionApproval(tx: Tx, context: PosCashCustodyActorContext, incident: { id: string; bagId: string; openedByProfileId: number; expectedAmountCents: number; observedAmountCents: number; differenceCents: number }, input: { approvalId: string; resolutionType: string; finalAmountCents: number; occurredAt: Date }) {
  const actor = await tx.tenantUserProfile.findUnique({ where: { id: context.actorProfileId }, select: { userId: true } });
  const expected = { branchId: context.branchId, bagId: incident.bagId, incidentId: incident.id, expectedAmountCents: incident.expectedAmountCents, observedAmountCents: incident.observedAmountCents, differenceCents: incident.differenceCents, finalAmountCents: input.finalAmountCents, resolutionType: input.resolutionType };
  const approval = await tx.posApproval.findFirst({ where: { id: input.approvalId, branchId: context.branchId, action: "cash.custody.divergence.resolve", entityType: "cash_custody_incident", entityId: incident.id, status: "approved", requesterId: actor?.userId, approverId: { not: actor?.userId }, consumedAt: null, expiresAt: { gt: input.occurredAt } }, select: { context: true } });
  if (!approval || hashPosCashLedgerRequest(approval.context) !== hashPosCashLedgerRequest(expected)) throw new PosCashCustodyError("A aprovação não corresponde ao snapshot exato da divergência.", 403);
}
async function lockSession(tx: Tx, sessionId: number) { await tx.$executeRaw(Prisma.sql`SELECT pg_advisory_xact_lock(27001, ${sessionId})`); }
async function lockBag(tx: Tx, bagId: string) { await tx.$executeRaw(Prisma.sql`SELECT pg_advisory_xact_lock(hashtextextended(${bagId}, 27002))`); }
function actorContext(value: PosCashCustodyActorContext) { return { branchId: positiveInt(value.branchId, "Filial"), actorProfileId: positiveInt(value.actorProfileId, "Ator"), actorUserId: identifier(value.actorUserId, "Usuário ator", 1, 160) }; }
function ledgerContext(value: PosCashLedgerContext): PosCashLedgerContext { return { ...actorContext(value), registerId: positiveInt(value.registerId, "Caixa"), sessionId: positiveInt(value.sessionId, "Turno"), terminalId: identifier(value.terminalId, "Terminal", 1, 160), terminalProof: value.terminalProof }; }
function eventInput(value: { bagId: string; idempotencyKey: string; correlationId: string; notes?: string | null; occurredAt?: Date }, label: string) { return { bagId: identifier(value.bagId, "Malote", 8, 160), idempotencyKey: identifier(value.idempotencyKey, "Chave idempotente", 16, 160), correlationId: uuid(value.correlationId), notes: optionalText(value.notes, 1000), occurredAt: validDate(value.occurredAt ?? new Date(), label) }; }
function replayBag<T extends { branchId: number; registerId: number; sessionId: number; terminalId: string; sealedByProfileId: number; requestHash: string }>(bag: T, context: PosCashLedgerContext, hash: string) { if (bag.branchId !== context.branchId || bag.registerId !== context.registerId || bag.sessionId !== context.sessionId || bag.terminalId !== context.terminalId || bag.sealedByProfileId !== context.actorProfileId || bag.requestHash !== hash) throw new PosCashCustodyError("A chave idempotente da selagem pertence a outro contexto.", 409); return bag; }
function replayEvent<T extends { bagId: string; actorProfileId: number; requestHash: string }>(event: T, bagId: string, actorId: number, hash: string) { if (event.bagId !== bagId || event.actorProfileId !== actorId || event.requestHash !== hash) throw new PosCashCustodyError("A chave idempotente pertence a outro evento de custódia.", 409); return event; }
function replayIncident<T extends { bagId: string; openedByProfileId: number; requestHash: string }>(incident: T, bagId: string, actorId: number, hash: string) { if (incident.bagId !== bagId || incident.openedByProfileId !== actorId || incident.requestHash !== hash) throw new PosCashCustodyError("A chave idempotente pertence a outro incidente.", 409); return incident; }
function replayResolution<T extends { incidentId: string; resolvedByProfileId: number; requestHash: string }>(resolution: T, incidentId: string, actorId: number, hash: string) { if (resolution.incidentId !== incidentId || resolution.resolvedByProfileId !== actorId || resolution.requestHash !== hash) throw new PosCashCustodyError("A chave idempotente pertence a outra resolução.", 409); return resolution; }
function custodyConflict(error: unknown, message: string): never { if (error instanceof PosCashCustodyError || error instanceof PosCashLedgerError) throw error; const code = error && typeof error === "object" && "code" in error ? String(error.code) : ""; if (["P2002", "P2034"].includes(code)) throw new PosCashCustodyError(message, 409); throw error; }
function sealNumber(value: unknown) { const result = identifier(value, "Lacre", 6, 100).toUpperCase(); if (!/^[A-Z0-9][A-Z0-9._/-]*$/.test(result)) throw new PosCashCustodyError("Lacre inválido."); return result; }
function resolutionType(value: unknown): "accepted_difference" | "recount_confirmed" | "returned_to_origin" { if (!new Set(["accepted_difference", "recount_confirmed", "returned_to_origin"]).has(String(value))) throw new PosCashCustodyError("Tipo de resolução inválido."); return value as "accepted_difference" | "recount_confirmed" | "returned_to_origin"; }
function positiveInt(value: unknown, label: string) { const result = Number(value); if (!Number.isSafeInteger(result) || result <= 0 || result > 2_147_483_647) throw new PosCashCustodyError(`${label} inválido.`); return result; }
function positiveCents(value: unknown, label: string) { const result = Number(value); if (!Number.isSafeInteger(result) || result <= 0 || result > 2_147_483_647) throw new PosCashCustodyError(`${label} inválido.`); return result; }
function nonNegativeCents(value: unknown, label: string) { const result = Number(value); if (!Number.isSafeInteger(result) || result < 0 || result > 2_147_483_647) throw new PosCashCustodyError(`${label} inválido.`); return result; }
function identifier(value: unknown, label: string, minimum: number, maximum: number) { const result = typeof value === "string" ? value.normalize("NFKC").trim() : ""; if (result.length < minimum || result.length > maximum || /[\u0000-\u001f]/.test(result)) throw new PosCashCustodyError(`${label} inválido.`); return result; }
function slug(value: unknown, label: string) { const result = identifier(value, label, 2, 80).toLowerCase(); if (!/^[a-z0-9][a-z0-9._:-]*$/.test(result)) throw new PosCashCustodyError(`${label} inválido.`); return result; }
function optionalText(value: unknown, maximum: number) { if (value == null || value === "") return null; return identifier(value, "Notas", 1, maximum); }
function uuid(value: unknown) { const result = identifier(value, "Correlação", 36, 36); if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(result)) throw new PosCashCustodyError("Correlação inválida."); return result.toLowerCase(); }
function validDate(value: Date, label: string) { if (!(value instanceof Date) || Number.isNaN(value.valueOf())) throw new PosCashCustodyError(`${label} inválida.`); return new Date(value); }
function dated<T extends Record<string, unknown>>(value: T) { return { ...value, occurredAt: value.occurredAt instanceof Date ? value.occurredAt.toISOString() : value.occurredAt }; }
async function serializable<T>(db: RootDb, operation: (tx: Tx) => Promise<T>) {
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      return await db.$transaction(operation, { isolationLevel: "Serializable", maxWait: 10_000, timeout: 30_000 });
    } catch (error) {
      const code = error && typeof error === "object" && "code" in error ? String(error.code) : "";
      if (code !== "P2034" || attempt === 3) throw error;
    }
  }
  throw new PosCashCustodyError("A custódia permaneceu em conflito após as retentativas transacionais.", 409);
}
