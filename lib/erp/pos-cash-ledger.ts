import { createHash } from "node:crypto";
import { Prisma, type PrismaClient } from "@/generated/tenant/client";
import { assertPosOperationalTerminalProof, posOperationalTerminalSelect, type PosOperationalTerminalProof } from "@/lib/erp/pos-terminal-boundary";

export class PosCashLedgerError extends Error {
  constructor(message: string, readonly status = 422) {
    super(message);
    this.name = "PosCashLedgerError";
  }
}

export const POS_CASH_LEDGER_ENTRY_TYPES = ["opening", "sale", "return", "supply", "withdrawal", "custody_seal", "adjustment"] as const;
export type PosCashLedgerEntryType = typeof POS_CASH_LEDGER_ENTRY_TYPES[number];

export type PosCashLedgerContext = {
  branchId: number;
  registerId: number;
  sessionId: number;
  terminalId: string;
  actorProfileId: number;
  actorUserId: string;
  terminalProof: PosOperationalTerminalProof;
};

export type PosCashLedgerAppendInput = {
  entryType: PosCashLedgerEntryType;
  deltaCents: number;
  referenceType: string;
  referenceId: string;
  referenceSequence?: number;
  idempotencyKey: string;
  correlationId: string;
  approvalId?: string | null;
  reasonCode: string;
  description: string;
  occurredAt?: Date;
};

type RootDb = PrismaClient;
type LedgerTx = Prisma.TransactionClient;
type PreviousEntry = { sequence: number; balanceAfterCents: number; occurredAt: Date } | null;

export function planPosCashLedgerAppend(previous: PreviousEntry, deltaCents: number, occurredAt: Date, allowZero = false) {
  const delta = signedCents(deltaCents, allowZero);
  const timestamp = validDate(occurredAt, "Data do movimento");
  if (previous && timestamp < previous.occurredAt) throw new PosCashLedgerError("A data do movimento não pode retroceder na cadeia do caixa.", 409);
  const sequence = (previous?.sequence ?? 0) + 1;
  const balanceBeforeCents = previous?.balanceAfterCents ?? 0;
  const balanceAfterCents = balanceBeforeCents + delta;
  if (!Number.isSafeInteger(balanceAfterCents) || balanceAfterCents < 0) throw new PosCashLedgerError("O movimento deixaria o saldo físico do caixa negativo.", 409);
  return { sequence, amountCents: Math.abs(delta), deltaCents: delta, balanceBeforeCents, balanceAfterCents, occurredAt: timestamp };
}

export function hashPosCashLedgerRequest(value: unknown) {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

export function posCashLedgerContextSnapshot(context: PosCashLedgerContext) {
  return { branchId: context.branchId, registerId: context.registerId, sessionId: context.sessionId, terminalId: context.terminalId, actorProfileId: context.actorProfileId, actorUserId: context.actorUserId };
}

function posCashLedgerPersistenceContext(context: PosCashLedgerContext) {
  return { branchId: context.branchId, registerId: context.registerId, sessionId: context.sessionId, terminalId: context.terminalId, actorProfileId: context.actorProfileId };
}

export async function postPosCashLedgerEntry(db: RootDb, contextValue: PosCashLedgerContext, inputValue: PosCashLedgerAppendInput) {
  const context = cashContext(contextValue), input = cashInput(inputValue);
  const requestHash = hashPosCashLedgerRequest({ context: posCashLedgerContextSnapshot(context), input: hashableInput(input) });
  const replay = await db.posCashLedgerEntry.findUnique({ where: { idempotencyKey: input.idempotencyKey } });
  if (replay) return replayLedger(replay, context, requestHash);
  return serializable(db, async (tx) => {
    await lockCashSession(tx, context.sessionId);
    const concurrent = await tx.posCashLedgerEntry.findUnique({ where: { idempotencyKey: input.idempotencyKey } });
    if (concurrent) return replayLedger(concurrent, context, requestHash);
    await assertCashLedgerContext(tx, context, input.entryType);
    return appendPosCashLedgerEntryInTransaction(tx, context, input, requestHash);
  }).catch(async (error) => {
    if (!isConflict(error)) throw error;
    const winner = await db.posCashLedgerEntry.findUnique({ where: { idempotencyKey: input.idempotencyKey } });
    if (winner) return replayLedger(winner, context, requestHash);
    throw new PosCashLedgerError("O caixa foi alterado concorrentemente. Consulte o ledger antes de repetir.", 409);
  });
}

export async function reversePosCashLedgerEntry(db: RootDb, contextValue: PosCashLedgerContext, inputValue: {
  entryId: bigint;
  approvalId: string;
  idempotencyKey: string;
  correlationId: string;
  reasonCode: string;
  description: string;
  occurredAt?: Date;
}) {
  const context = cashContext(contextValue);
  const input = {
    entryId: positiveBigInt(inputValue.entryId, "Lançamento"),
    approvalId: identifier(inputValue.approvalId, "Aprovação", 1, 160),
    idempotencyKey: identifier(inputValue.idempotencyKey, "Chave idempotente", 16, 160),
    correlationId: uuid(inputValue.correlationId, "Correlação"),
    reasonCode: slug(inputValue.reasonCode, "Motivo"),
    description: text(inputValue.description, "Descrição", 1, 500),
    occurredAt: validDate(inputValue.occurredAt ?? new Date(), "Data da reversão"),
  };
  const requestHash = hashPosCashLedgerRequest({ context: posCashLedgerContextSnapshot(context), input: { ...input, entryId: input.entryId.toString(), occurredAt: input.occurredAt.toISOString() } });
  const replay = await db.posCashLedgerEntry.findUnique({ where: { idempotencyKey: input.idempotencyKey } });
  if (replay) return replayLedger(replay, context, requestHash);
  return serializable(db, async (tx) => {
    await lockCashSession(tx, context.sessionId);
    const concurrent = await tx.posCashLedgerEntry.findUnique({ where: { idempotencyKey: input.idempotencyKey } });
    if (concurrent) return replayLedger(concurrent, context, requestHash);
    await assertCashLedgerContext(tx, context, "reversal");
    const target = await tx.posCashLedgerEntry.findFirst({ where: { id: input.entryId, branchId: context.branchId, registerId: context.registerId, sessionId: context.sessionId } });
    if (!target) throw new PosCashLedgerError("Lançamento de caixa não encontrado neste turno.", 404);
    if (target.reversalForId) throw new PosCashLedgerError("Não é permitido reverter uma reversão.", 409);
    if (await tx.posCashLedgerEntry.findUnique({ where: { reversalForId: target.id } })) throw new PosCashLedgerError("O lançamento já possui reversão compensatória.", 409);
    await assertLedgerApproval(tx, {
      branchId: context.branchId, actorUserId: context.actorUserId, approvalId: input.approvalId, action: "cash.ledger.reversal",
      entityType: "cash_ledger_entry", entityId: target.id.toString(), occurredAt: input.occurredAt,
      snapshot: { branchId: context.branchId, registerId: context.registerId, sessionId: context.sessionId, terminalId: context.terminalId, entryId: target.id.toString(), deltaCents: -target.deltaCents },
    });
    const previous = await latestCashEntry(tx, context.sessionId);
    const plan = planPosCashLedgerAppend(previous, -target.deltaCents, input.occurredAt);
    return tx.posCashLedgerEntry.create({ data: {
      ...posCashLedgerPersistenceContext(context), ...plan, entryType: "reversal", currency: "BRL",
      referenceType: "cash_ledger_reversal", referenceId: target.id.toString(), referenceSequence: 1,
      idempotencyKey: input.idempotencyKey, requestHash, correlationId: input.correlationId, approvalId: input.approvalId,
      reversalForId: target.id, reasonCode: input.reasonCode, description: input.description,
    } });
  }).catch(async (error) => {
    if (!isConflict(error)) throw error;
    const winner = await db.posCashLedgerEntry.findUnique({ where: { idempotencyKey: input.idempotencyKey } });
    if (winner) return replayLedger(winner, context, requestHash);
    throw new PosCashLedgerError("A reversão concorreu com outro lançamento. Consulte o ledger.", 409);
  });
}

export async function appendPosCashLedgerEntryInTransaction(
  tx: LedgerTx,
  context: PosCashLedgerContext,
  inputValue: PosCashLedgerAppendInput,
  requestHash: string,
) {
  const input = cashInput(inputValue);
  const previous = await latestCashEntry(tx, context.sessionId);
  const plan = planPosCashLedgerAppend(previous, input.deltaCents, input.occurredAt, input.entryType === "opening");
  if (input.entryType === "opening" && previous) throw new PosCashLedgerError("A abertura só pode ser o primeiro lançamento do turno.", 409);
  if (input.entryType !== "opening" && !previous) throw new PosCashLedgerError("O ledger exige um lançamento de abertura antes dos demais movimentos.", 409);
  if (input.entryType === "adjustment") {
    if (!input.approvalId) throw new PosCashLedgerError("Ajuste de caixa exige aprovação.", 403);
    await assertLedgerApproval(tx, {
      branchId: context.branchId, actorUserId: context.actorUserId, approvalId: input.approvalId, action: "cash.ledger.adjustment",
      entityType: "cash_register_session", entityId: String(context.sessionId), occurredAt: input.occurredAt,
      snapshot: { branchId: context.branchId, registerId: context.registerId, sessionId: context.sessionId, terminalId: context.terminalId, deltaCents: input.deltaCents, referenceType: input.referenceType, referenceId: input.referenceId, referenceSequence: input.referenceSequence },
    });
  }
  return tx.posCashLedgerEntry.create({ data: {
    ...posCashLedgerPersistenceContext(context), ...plan, entryType: input.entryType, currency: "BRL",
    referenceType: input.referenceType, referenceId: input.referenceId, referenceSequence: input.referenceSequence,
    idempotencyKey: input.idempotencyKey, requestHash, correlationId: input.correlationId, approvalId: input.approvalId,
    reasonCode: input.reasonCode, description: input.description,
  } });
}

export async function assertCashLedgerContext(tx: LedgerTx, context: PosCashLedgerContext, entryType: PosCashLedgerEntryType | "reversal") {
  const sessionStates = entryType === "custody_seal" || entryType === "reversal" ? ["open", "closing", "closed"] : ["open"];
  const [session, terminal, actor] = await Promise.all([
    tx.cashRegisterSession.findFirst({ where: { id: context.sessionId, registerId: context.registerId, status: { in: sessionStates }, register: { branchId: context.branchId, status: "active" } }, select: { id: true } }),
    tx.posTerminal.findUnique({ where: { id: context.terminalId }, select: posOperationalTerminalSelect }),
    tx.tenantUserProfile.findFirst({ where: { id: context.actorProfileId, userId: context.actorUserId, status: "active", OR: [{ activeBranchId: context.branchId }, { branchAccesses: { some: { branchId: context.branchId } } }] }, select: { id: true, role: { select: { key: true } } } }),
  ]);
  if (!session || !terminal || !actor) throw new PosCashLedgerError("Filial, caixa, turno, terminal ou ator não formam um contexto operacional vigente.", 403);
  assertPosOperationalTerminalProof(terminal, context.terminalProof, { expectedBranchId: context.branchId, expectedRegisterId: context.registerId });
  const privileged = actor.role.key === "owner" || actor.role.key === "admin";
  if (!privileged) {
    const now = new Date();
    const access = await tx.posRegisterAccess.findFirst({ where: {
      registerId: context.registerId, userProfileId: context.actorProfileId, active: true,
      AND: [{ OR: [{ validFrom: null }, { validFrom: { lte: now } }] }, { OR: [{ validUntil: null }, { validUntil: { gte: now } }] }],
    } });
    if (!access || !cashAccessAllowed(access, entryType)) throw new PosCashLedgerError("A alçada viva do ator não permite este movimento de caixa.", 403);
  }
}

async function latestCashEntry(tx: LedgerTx, sessionId: number) {
  return tx.posCashLedgerEntry.findFirst({ where: { sessionId }, select: { sequence: true, balanceAfterCents: true, occurredAt: true }, orderBy: { sequence: "desc" } });
}

async function assertLedgerApproval(tx: LedgerTx, expected: { branchId: number; actorUserId: string; approvalId: string; action: string; entityType: string; entityId: string; occurredAt: Date; snapshot: unknown }) {
  const approval = await tx.posApproval.findFirst({ where: {
    id: expected.approvalId, branchId: expected.branchId, action: expected.action, entityType: expected.entityType, entityId: expected.entityId,
    status: "approved", requesterId: expected.actorUserId, approverId: { not: expected.actorUserId }, consumedAt: null, expiresAt: { gt: expected.occurredAt },
  }, select: { context: true } });
  if (!approval || hashPosCashLedgerRequest(approval.context) !== hashPosCashLedgerRequest(expected.snapshot)) throw new PosCashLedgerError("A aprovação não corresponde ao ator, ação, entidade e snapshot exatos.", 403);
}

async function lockCashSession(tx: LedgerTx, sessionId: number) {
  await tx.$executeRaw(Prisma.sql`SELECT pg_advisory_xact_lock(27001, ${sessionId})`);
}

function cashContext(value: PosCashLedgerContext): PosCashLedgerContext {
  const context = {
    branchId: positiveInt(value.branchId, "Filial"), registerId: positiveInt(value.registerId, "Caixa"), sessionId: positiveInt(value.sessionId, "Turno"),
    terminalId: identifier(value.terminalId, "Terminal", 1, 160), actorProfileId: positiveInt(value.actorProfileId, "Ator"), actorUserId: identifier(value.actorUserId, "Usuário ator", 1, 160),
    terminalProof: value.terminalProof,
  };
  if (!context.terminalProof || context.terminalProof.terminalId !== context.terminalId || context.terminalProof.registerId !== context.registerId || context.terminalProof.branchId !== context.branchId) throw new PosCashLedgerError("A prova criptográfica não corresponde ao contexto do caixa.", 403);
  return context;
}

function cashInput(value: PosCashLedgerAppendInput) {
  if (!POS_CASH_LEDGER_ENTRY_TYPES.includes(value.entryType)) throw new PosCashLedgerError("Tipo de lançamento inválido.");
  const input = {
    entryType: value.entryType,
    deltaCents: signedCents(value.deltaCents, value.entryType === "opening"),
    referenceType: slug(value.referenceType, "Tipo de referência"), referenceId: identifier(value.referenceId, "Referência", 1, 160),
    referenceSequence: positiveInt(value.referenceSequence ?? 1, "Sequência da referência"),
    idempotencyKey: identifier(value.idempotencyKey, "Chave idempotente", 16, 160), correlationId: uuid(value.correlationId, "Correlação"),
    approvalId: value.approvalId ? identifier(value.approvalId, "Aprovação", 1, 160) : null,
    reasonCode: slug(value.reasonCode, "Motivo"), description: text(value.description, "Descrição", 1, 500),
    occurredAt: validDate(value.occurredAt ?? new Date(), "Data do movimento"),
  };
  assertPosCashLedgerDirection(input.entryType, input.deltaCents);
  if (input.entryType !== "adjustment" && input.approvalId) throw new PosCashLedgerError("Aprovação só é aceita no ajuste; reversões usam o fluxo compensatório próprio.");
  return input;
}

function hashableInput(input: ReturnType<typeof cashInput>) { return { ...input, occurredAt: input.occurredAt.toISOString() }; }
export function assertPosCashLedgerDirection(entryType: PosCashLedgerEntryType, deltaCents: number) {
  if (entryType === "opening" && deltaCents < 0) throw new PosCashLedgerError("A abertura não pode reduzir o saldo.");
  if (["sale", "supply"].includes(entryType) && deltaCents <= 0) throw new PosCashLedgerError("Venda e suprimento devem aumentar o saldo.");
  if (["return", "withdrawal", "custody_seal"].includes(entryType) && deltaCents >= 0) throw new PosCashLedgerError("Devolução, sangria e selagem devem reduzir o saldo.");
  if (entryType === "adjustment" && deltaCents === 0) throw new PosCashLedgerError("Ajuste não pode ser nulo.");
}
function cashAccessAllowed(access: { canOpen: boolean; canClose: boolean; canSell: boolean; canSupply: boolean; canWithdraw: boolean; canRefund: boolean }, entryType: PosCashLedgerEntryType | "reversal") {
  if (entryType === "opening") return access.canOpen;
  if (entryType === "sale") return access.canSell;
  if (entryType === "return") return access.canRefund;
  if (entryType === "supply") return access.canSupply;
  if (entryType === "withdrawal") return access.canWithdraw;
  if (entryType === "custody_seal") return access.canClose;
  return access.canClose;
}
function replayLedger<T extends { branchId: number; registerId: number; sessionId: number; terminalId: string; actorProfileId: number; requestHash: string }>(entry: T, context: PosCashLedgerContext, hash: string) {
  if (entry.branchId !== context.branchId || entry.registerId !== context.registerId || entry.sessionId !== context.sessionId || entry.terminalId !== context.terminalId || entry.actorProfileId !== context.actorProfileId || entry.requestHash !== hash) throw new PosCashLedgerError("A chave idempotente pertence a outro lançamento ou contexto.", 409);
  return entry;
}
function signedCents(value: unknown, allowZero = false) { const result = Number(value); if (!Number.isSafeInteger(result) || !allowZero && result === 0 || Math.abs(result) > 2_147_483_647) throw new PosCashLedgerError("Valor do movimento inválido."); return result; }
function positiveInt(value: unknown, label: string) { const result = Number(value); if (!Number.isSafeInteger(result) || result <= 0 || result > 2_147_483_647) throw new PosCashLedgerError(`${label} inválido.`); return result; }
function positiveBigInt(value: unknown, label: string) { try { const result = BigInt(value as bigint); if (result <= BigInt(0)) throw new Error(); return result; } catch { throw new PosCashLedgerError(`${label} inválido.`); } }
function identifier(value: unknown, label: string, minimum: number, maximum: number) { const result = typeof value === "string" ? value.normalize("NFKC").trim() : ""; if (result.length < minimum || result.length > maximum || /[\u0000-\u001f]/.test(result)) throw new PosCashLedgerError(`${label} inválido.`); return result; }
function slug(value: unknown, label: string) { const result = identifier(value, label, 2, 80).toLowerCase(); if (!/^[a-z0-9][a-z0-9._:-]*$/.test(result)) throw new PosCashLedgerError(`${label} inválido.`); return result; }
function text(value: unknown, label: string, minimum: number, maximum: number) { return identifier(value, label, minimum, maximum); }
function uuid(value: unknown, label: string) { const result = identifier(value, label, 36, 36); if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(result)) throw new PosCashLedgerError(`${label} inválida.`); return result.toLowerCase(); }
function validDate(value: Date, label: string) { if (!(value instanceof Date) || Number.isNaN(value.valueOf())) throw new PosCashLedgerError(`${label} inválida.`); return new Date(value); }
function canonicalJson(value: unknown): string { if (value === null || typeof value !== "object") return typeof value === "bigint" ? JSON.stringify(value.toString()) : JSON.stringify(value); if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`; const object = value as Record<string, unknown>; return `{${Object.keys(object).sort().map(key => `${JSON.stringify(key)}:${canonicalJson(object[key])}`).join(",")}}`; }
function prismaCode(error: unknown) { return error && typeof error === "object" && "code" in error ? String(error.code) : ""; }
function isConflict(error: unknown) { return new Set(["P2002", "P2034"]).has(prismaCode(error)); }
async function serializable<T>(db: RootDb, operation: (tx: LedgerTx) => Promise<T>) {
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      return await db.$transaction(operation, { isolationLevel: "Serializable", maxWait: 10_000, timeout: 30_000 });
    } catch (error) {
      if (prismaCode(error) !== "P2034" || attempt === 3) throw error;
    }
  }
  throw new PosCashLedgerError("O caixa permaneceu em conflito após as retentativas transacionais.", 409);
}
