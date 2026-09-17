import { createHash } from "node:crypto";
import { Prisma } from "@/generated/tenant/client";
import { hashPosGiftCode, verifyPosGiftPin } from "@/lib/erp/pos-value-secrets";

export type PosValueKind = "loyalty_points" | "cashback" | "gift_card" | "store_credit";
export type PosValueUnit = "points" | "cents";
export type PosValueEntryType = "issue" | "credit" | "debit" | "reserve" | "capture" | "release" | "expire" | "reversal";
export type PosValueContext = { actor: string; now: Date };

type CommandBase = {
  operationKey: string;
  requestHash: string;
  referenceType: string;
  referenceId: string;
  reason?: string | null;
};

export type IssuePosValueAccountInput = CommandBase & {
  branchId: number;
  customerId: number | null;
  programId: string | null;
  kind: PosValueKind;
  label: string;
  initialUnits: number;
  expiresAt: Date | null;
  giftCredential?: { codeHash: string; codeLastFour: string; pinHash: string } | null;
};

export type PosValueCommand =
  | CommandBase & { type: "credit" | "debit"; accountId: string; branchId: number; amountUnits: number; expectedCustomerId?: number | null }
  | CommandBase & { type: "reserve"; accountId: string; branchId: number; amountUnits: number; expectedCustomerId?: number | null; expiresAt: Date }
  | CommandBase & { type: "capture" | "release"; reservationId: string; branchId: number }
  | CommandBase & { type: "expire"; accountId: string; branchId: number }
  | CommandBase & { type: "reverse"; entryId: bigint; branchId: number };

export type PosValueMaintenanceCommand =
  | Extract<PosValueCommand, { type: "expire" }>
  | Extract<PosValueCommand, { reservationId: string }> & { type: "release" };

export class PosValueError extends Error {
  constructor(message: string, public readonly status = 422) {
    super(message);
    this.name = "PosValueError";
  }
}

export function hashPosValueCommand(value: unknown) {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

export function calculatePosValueTransition(balance: bigint, reserved: bigint, type: Exclude<PosValueEntryType, "reversal">, amount: bigint) {
  if (balance < BigInt(0) || reserved < BigInt(0) || reserved > balance) throw new PosValueError("Estado de saldo inválido.", 409);
  if (amount < BigInt(0) || (amount === BigInt(0) && !["issue", "expire"].includes(type))) throw new PosValueError("Valor da movimentação inválido.");
  let balanceDelta = BigInt(0), reservedDelta = BigInt(0);
  if (type === "issue" || type === "credit") balanceDelta = amount;
  else if (type === "debit" || type === "expire") balanceDelta = -amount;
  else if (type === "reserve") reservedDelta = amount;
  else if (type === "capture") { balanceDelta = -amount; reservedDelta = -amount; }
  else if (type === "release") reservedDelta = -amount;
  const balanceAfter = balance + balanceDelta, reservedAfter = reserved + reservedDelta;
  if (balanceAfter < BigInt(0) || reservedAfter < BigInt(0) || reservedAfter > balanceAfter) throw new PosValueError("Saldo disponível insuficiente.", 409);
  return { balanceDelta, reservedDelta, balanceAfter, reservedAfter };
}

export async function issuePosValueAccount(tx: Prisma.TransactionClient, input: IssuePosValueAccountInput, context: PosValueContext) {
  validateCommandBase(input);
  const replay = await replayEntry(tx, input.operationKey, input.requestHash);
  if (replay) return valueMutationResult(tx, replay.accountId, replay.id, true, replay.reservationId || undefined);
  const initialUnits = units(input.initialUnits), branch = await activeBranch(tx, input.branchId);
  const customer = input.customerId == null ? null : await tx.customer.findFirst({ where: { id: input.customerId, status: "active" }, select: { id: true } });
  if (input.customerId != null && !customer) throw new PosValueError("Cliente ativo não encontrado.", 404);
  let program: { id: string; kind: string; branchId: number; status: string; expiresAfterDays: number | null } | null = null;
  if (input.programId) program = await tx.posValueProgram.findUnique({ where: { id: input.programId }, select: { id: true, kind: true, branchId: true, status: true, expiresAfterDays: true } });
  const programKind = input.kind === "loyalty_points" || input.kind === "cashback";
  if (programKind && (!program || program.status !== "active" || program.branchId !== branch.id || program.kind !== input.kind)) throw new PosValueError("Programa de fidelidade ativo e compatível não encontrado.", 404);
  if (!programKind && input.programId != null) throw new PosValueError("Gift card e crédito-loja não podem ser vinculados a programa.");
  if (input.kind !== "gift_card" && !customer) throw new PosValueError("Esta conta de valor exige cliente ativo.");
  if (input.kind === "gift_card" && !input.giftCredential) throw new PosValueError("Credencial segura do gift card ausente.", 503);
  if (input.kind !== "gift_card" && input.giftCredential) throw new PosValueError("Credencial de gift card incompatível.");
  if (input.kind === "gift_card" && initialUnits <= BigInt(0)) throw new PosValueError("Gift card deve ser emitido com saldo inicial positivo.");
  const derivedExpiry = input.expiresAt || (program?.expiresAfterDays ? new Date(context.now.getTime() + program.expiresAfterDays * 86_400_000) : null);
  if (derivedExpiry && derivedExpiry <= context.now) throw new PosValueError("A expiração deve estar no futuro.");
  const account = await tx.posValueAccount.create({ data: {
    branchId: branch.id, customerId: customer?.id ?? null, programId: program?.id ?? null, kind: input.kind,
    unit: input.kind === "loyalty_points" ? "points" : "cents", label: input.label,
    codeHash: input.giftCredential?.codeHash, codeLastFour: input.giftCredential?.codeLastFour, pinHash: input.giftCredential?.pinHash,
    expiresAt: derivedExpiry, balanceUnits: BigInt(0), reservedUnits: BigInt(0), metadata: { issuedBy: context.actor },
  } });
  const entry = await appendEntry(tx, account, {
    type: "issue", amount: initialUnits, operationKey: input.operationKey, requestHash: input.requestHash,
    referenceType: input.referenceType, referenceId: input.referenceId, actor: context.actor, reason: input.reason || null,
  });
  return valueMutationResult(tx, account.id, entry.id, false);
}

export async function applyPosValueCommand(tx: Prisma.TransactionClient, input: PosValueCommand, context: PosValueContext) {
  return applyPosValueCommandInternal(tx, input, context, false);
}

export async function applyPosValueMaintenanceCommand(tx: Prisma.TransactionClient, input: PosValueMaintenanceCommand, context: PosValueContext) {
  return applyPosValueCommandInternal(tx, input, context, true);
}

async function applyPosValueCommandInternal(tx: Prisma.TransactionClient, input: PosValueCommand, context: PosValueContext, maintenance: boolean) {
  validateCommandBase(input);
  const replay = await replayEntry(tx, input.operationKey, input.requestHash);
  if (replay) return valueMutationResult(tx, replay.accountId, replay.id, true, replay.reservationId || undefined);
  if (!maintenance) await activeBranch(tx, input.branchId);
  if (input.type === "capture" || input.type === "release") return settleReservation(tx, input, context, maintenance);
  if (input.type === "reverse") return reverseEntry(tx, input, context);
  const accountCommand = input as Extract<PosValueCommand, { accountId: string }>;
  const account = await lockedAccount(tx, accountCommand.accountId);
  assertAccountScope(account, accountCommand.branchId, "expectedCustomerId" in accountCommand ? accountCommand.expectedCustomerId : undefined, accountCommand.type === "expire", context.now);
  if (input.type === "expire") {
    if (!account.expiresAt || account.expiresAt > context.now) throw new PosValueError("A conta ainda não atingiu sua expiração.", 409);
    if (account.reservedUnits !== BigInt(0)) throw new PosValueError("Libere ou capture as reservas antes de expirar a conta.", 409);
    const entry = await appendEntry(tx, account, {
      type: "expire", amount: account.balanceUnits, operationKey: input.operationKey, requestHash: input.requestHash,
      referenceType: input.referenceType, referenceId: input.referenceId, actor: context.actor, reason: input.reason || null, status: "expired",
    });
    return valueMutationResult(tx, account.id, entry.id, false);
  }
  const movementCommand = accountCommand as Extract<PosValueCommand, { amountUnits: number }>;
  const amount = units(movementCommand.amountUnits);
  if (input.type === "reserve") {
    if (input.expiresAt <= context.now) throw new PosValueError("A reserva deve expirar no futuro.");
    const reservation = await tx.posValueReservation.create({ data: {
      accountId: account.id, branchId: account.branchId, amountUnits: amount, operationKey: input.operationKey,
      requestHash: input.requestHash, referenceType: input.referenceType, referenceId: input.referenceId, expiresAt: input.expiresAt,
    } });
    const entry = await appendEntry(tx, account, {
      type: "reserve", amount, reservationId: reservation.id, operationKey: input.operationKey, requestHash: input.requestHash,
      referenceType: input.referenceType, referenceId: input.referenceId, actor: context.actor, reason: input.reason || null,
    });
    return valueMutationResult(tx, account.id, entry.id, false, reservation.id);
  }
  const entry = await appendEntry(tx, account, {
    type: input.type, amount, operationKey: input.operationKey, requestHash: input.requestHash,
    referenceType: input.referenceType, referenceId: input.referenceId, actor: context.actor, reason: input.reason || null,
  });
  return valueMutationResult(tx, account.id, entry.id, false);
}

export async function resolvePosGiftCard(tx: Prisma.TransactionClient, input: { branchId: number; code: string; pin: string; expectedCustomerId?: number | null; now: Date }) {
  const codeHash = hashPosGiftCode(input.code);
  const account = await tx.posValueAccount.findUnique({ where: { codeHash } });
  if (!account || account.kind !== "gift_card" || account.branchId !== input.branchId || !account.pinHash) throw new PosValueError("Gift card ou PIN inválido.", 404);
  if (!await verifyPosGiftPin(input.pin, account.pinHash)) throw new PosValueError("Gift card ou PIN inválido.", 404);
  if (account.customerId != null && account.customerId !== input.expectedCustomerId) throw new PosValueError("Gift card ou PIN inválido.", 404);
  assertAccountScope(account, input.branchId, input.expectedCustomerId, false, input.now);
  return posValueAccountDto(account);
}

async function settleReservation(tx: Prisma.TransactionClient, input: Extract<PosValueCommand, { type: "capture" | "release" }>, context: PosValueContext, maintenance: boolean) {
  const found = await tx.posValueReservation.findUnique({ where: { id: input.reservationId } });
  if (!found) throw new PosValueError("Reserva não encontrada.", 404);
  await tx.$queryRaw(Prisma.sql`SELECT "id" FROM "pos_value_reservations" WHERE "id" = ${found.id} FOR UPDATE`);
  const reservation = await tx.posValueReservation.findUniqueOrThrow({ where: { id: found.id } });
  if (reservation.branchId !== input.branchId) throw new PosValueError("Reserva não pertence à filial.", 404);
  if (reservation.state !== "active") throw new PosValueError("Reserva já foi finalizada.", 409);
  if (reservation.referenceType !== input.referenceType || reservation.referenceId !== input.referenceId) throw new PosValueError("A reserva pertence a outra referência.", 409);
  if (input.type === "capture" && reservation.expiresAt <= context.now) throw new PosValueError("Reserva expirada; libere o saldo antes de tentar novamente.", 409);
  const account = await lockedAccount(tx, reservation.accountId);
  assertAccountScope(account, input.branchId, undefined, input.type === "release", context.now, maintenance && input.type === "release");
  const entry = await appendEntry(tx, account, {
    type: input.type, amount: reservation.amountUnits, reservationId: reservation.id, operationKey: input.operationKey, requestHash: input.requestHash,
    referenceType: input.referenceType, referenceId: input.referenceId, actor: context.actor, reason: input.reason || null,
  });
  const state = input.type === "capture" ? "captured" : reservation.expiresAt <= context.now || maintenance && account.expiresAt != null && account.expiresAt <= context.now ? "expired" : "released";
  const changed = await tx.posValueReservation.updateMany({ where: { id: reservation.id, state: "active", updatedAt: reservation.updatedAt }, data: { state, completedAt: context.now } });
  if (changed.count !== 1) throw conflict();
  return valueMutationResult(tx, account.id, entry.id, false, reservation.id);
}

async function reverseEntry(tx: Prisma.TransactionClient, input: Extract<PosValueCommand, { type: "reverse" }>, context: PosValueContext) {
  const original = await tx.posValueLedgerEntry.findUnique({ where: { id: input.entryId } });
  if (!original) throw new PosValueError("Lançamento original não encontrado.", 404);
  await tx.$queryRaw(Prisma.sql`SELECT "id" FROM "pos_value_ledger_entries" WHERE "id" = ${original.id} FOR UPDATE`);
  const current = await tx.posValueLedgerEntry.findUniqueOrThrow({ where: { id: original.id }, include: { reversedBy: { select: { id: true } } } });
  if (!new Set(["issue", "credit", "debit", "capture"]).has(current.type)) throw new PosValueError("Este tipo de lançamento não admite estorno compensatório.", 409);
  if (current.reversedBy.length) throw new PosValueError("Lançamento já estornado.", 409);
  const account = await lockedAccount(tx, current.accountId);
  assertAccountScope(account, input.branchId, undefined, false, context.now);
  const debit = current.type === "issue" || current.type === "credit";
  const amount = current.amountUnits;
  if (amount === BigInt(0)) throw new PosValueError("Lançamento sem valor não admite estorno.", 409);
  const balanceDelta = debit ? -amount : amount;
  if (balanceDelta < BigInt(0) && account.balanceUnits - account.reservedUnits < amount) throw new PosValueError("Saldo disponível insuficiente para estornar o crédito.", 409);
  const entry = await appendEntry(tx, account, {
    type: "reversal", amount, balanceDelta, reservedDelta: BigInt(0), reversalOfId: current.id,
    operationKey: input.operationKey, requestHash: input.requestHash, referenceType: input.referenceType, referenceId: input.referenceId,
    actor: context.actor, reason: input.reason || null, metadata: { originalType: current.type },
  });
  return valueMutationResult(tx, account.id, entry.id, false);
}

async function appendEntry(tx: Prisma.TransactionClient, account: LockedAccount, input: {
  type: PosValueEntryType; amount: bigint; operationKey: string; requestHash: string; referenceType: string; referenceId: string; actor: string;
  reason: string | null; reservationId?: string; reversalOfId?: bigint; balanceDelta?: bigint; reservedDelta?: bigint; status?: string; metadata?: Prisma.InputJsonObject;
}) {
  const transition = input.type === "reversal"
    ? customTransition(account.balanceUnits, account.reservedUnits, input.balanceDelta || BigInt(0), input.reservedDelta || BigInt(0))
    : calculatePosValueTransition(account.balanceUnits, account.reservedUnits, input.type, input.amount);
  const changed = await tx.posValueAccount.updateMany({
    where: { id: account.id, balanceUnits: account.balanceUnits, reservedUnits: account.reservedUnits, version: account.version, status: account.status },
    data: { balanceUnits: transition.balanceAfter, reservedUnits: transition.reservedAfter, version: { increment: 1 }, ...(input.status ? { status: input.status } : {}) },
  });
  if (changed.count !== 1) throw conflict();
  return tx.posValueLedgerEntry.create({ data: {
    accountId: account.id, reservationId: input.reservationId, reversalOfId: input.reversalOfId, type: input.type, amountUnits: input.amount,
    balanceDeltaUnits: transition.balanceDelta, reservedDeltaUnits: transition.reservedDelta,
    balanceBeforeUnits: account.balanceUnits, balanceAfterUnits: transition.balanceAfter,
    reservedBeforeUnits: account.reservedUnits, reservedAfterUnits: transition.reservedAfter,
    operationKey: input.operationKey, requestHash: input.requestHash, referenceType: input.referenceType, referenceId: input.referenceId,
    actor: input.actor, reason: input.reason, metadata: input.metadata,
  } });
}

function customTransition(balance: bigint, reserved: bigint, balanceDelta: bigint, reservedDelta: bigint) {
  const balanceAfter = balance + balanceDelta, reservedAfter = reserved + reservedDelta;
  if (balanceAfter < BigInt(0) || reservedAfter < BigInt(0) || reservedAfter > balanceAfter) throw new PosValueError("Saldo disponível insuficiente.", 409);
  return { balanceDelta, reservedDelta, balanceAfter, reservedAfter };
}

async function lockedAccount(tx: Prisma.TransactionClient, accountId: string) {
  const found = await tx.posValueAccount.findUnique({ where: { id: accountId } });
  if (!found) throw new PosValueError("Conta de valor não encontrada.", 404);
  await tx.$queryRaw(Prisma.sql`SELECT "id" FROM "pos_value_accounts" WHERE "id" = ${accountId} FOR UPDATE`);
  return tx.posValueAccount.findUniqueOrThrow({ where: { id: accountId } });
}

type LockedAccount = Prisma.PosValueAccountGetPayload<Record<string, never>>;

function assertAccountScope(account: LockedAccount, branchId: number, expectedCustomerId: number | null | undefined, allowDueExpiry: boolean, now: Date, allowMaintenanceRelease = false) {
  if (account.branchId !== branchId) throw new PosValueError("Conta de valor não pertence à filial.", 404);
  if (expectedCustomerId !== undefined && account.customerId != null && account.customerId !== expectedCustomerId) throw new PosValueError("Conta de valor vinculada a outro cliente.", 403);
  if (account.status !== "active" && !allowMaintenanceRelease) throw new PosValueError("Conta de valor não está ativa.", 409);
  if (!allowDueExpiry && account.expiresAt && account.expiresAt <= now) throw new PosValueError("Conta de valor expirada; processe a expiração antes de movimentar.", 409);
}

async function activeBranch(tx: Prisma.TransactionClient, branchId: number) {
  const branch = await tx.branch.findFirst({ where: { id: branchId, status: "active" }, select: { id: true } });
  if (!branch) throw new PosValueError("Filial ativa não encontrada.", 404);
  return branch;
}

async function replayEntry(tx: Prisma.TransactionClient, operationKey: string, requestHash: string) {
  const entry = await tx.posValueLedgerEntry.findUnique({ where: { operationKey } });
  if (entry && entry.requestHash !== requestHash) throw new PosValueError("A chave idempotente já foi usada com outro payload.", 409);
  return entry;
}

async function valueMutationResult(tx: Prisma.TransactionClient, accountId: string, entryId: bigint, replayed: boolean, reservationId?: string) {
  const [account, entry, reservation] = await Promise.all([
    tx.posValueAccount.findUniqueOrThrow({ where: { id: accountId } }),
    tx.posValueLedgerEntry.findUniqueOrThrow({ where: { id: entryId } }),
    reservationId ? tx.posValueReservation.findUnique({ where: { id: reservationId } }) : null,
  ]);
  return { account: posValueAccountDto(account), entry: posValueEntryDto(entry), reservation: reservation ? posValueReservationDto(reservation) : null, replayed };
}

export function posValueAccountDto(value: LockedAccount) {
  return {
    id: value.id, branchId: value.branchId, customerId: value.customerId, programId: value.programId, kind: value.kind, unit: value.unit,
    label: value.label, status: value.status, codeLastFour: value.codeLastFour, balanceUnits: value.balanceUnits.toString(),
    reservedUnits: value.reservedUnits.toString(), availableUnits: (value.balanceUnits - value.reservedUnits).toString(),
    expiresAt: value.expiresAt, createdAt: value.createdAt, updatedAt: value.updatedAt,
  };
}

export function posValueEntryDto(value: Prisma.PosValueLedgerEntryGetPayload<Record<string, never>>) {
  return {
    id: value.id.toString(), accountId: value.accountId, reservationId: value.reservationId, reversalOfId: value.reversalOfId?.toString() || null,
    type: value.type, amountUnits: value.amountUnits.toString(), balanceDeltaUnits: value.balanceDeltaUnits.toString(), reservedDeltaUnits: value.reservedDeltaUnits.toString(),
    balanceBeforeUnits: value.balanceBeforeUnits.toString(), balanceAfterUnits: value.balanceAfterUnits.toString(),
    reservedBeforeUnits: value.reservedBeforeUnits.toString(), reservedAfterUnits: value.reservedAfterUnits.toString(),
    referenceType: value.referenceType, referenceId: value.referenceId, actor: value.actor, reason: value.reason, createdAt: value.createdAt,
  };
}

export function posValueReservationDto(value: Prisma.PosValueReservationGetPayload<Record<string, never>>) {
  return {
    id: value.id, accountId: value.accountId, branchId: value.branchId, amountUnits: value.amountUnits.toString(), state: value.state,
    referenceType: value.referenceType, referenceId: value.referenceId, expiresAt: value.expiresAt, completedAt: value.completedAt, createdAt: value.createdAt,
  };
}

function units(value: number) {
  if (!Number.isSafeInteger(value) || value < 0 || value > 9_000_000_000_000_000) throw new PosValueError("Valor em unidades inválido.");
  return BigInt(value);
}

function validateCommandBase(value: CommandBase) {
  if (value.operationKey.length < 16 || value.operationKey.length > 200 || !/^[A-Za-z0-9._:-]+$/.test(value.operationKey)) throw new PosValueError("Chave idempotente inválida.");
  if (!/^[0-9a-f]{64}$/.test(value.requestHash)) throw new PosValueError("Hash da requisição inválido.");
  text(value.referenceType, "Tipo de referência", 1, 80);
  text(value.referenceId, "Referência", 1, 160);
  if (value.reason != null) text(value.reason, "Motivo", 4, 500);
}

function text(value: string, label: string, minimum: number, maximum: number) {
  if (value.trim().length < minimum || value.trim().length > maximum) throw new PosValueError(`${label} inválido.`);
}

function conflict() { return new PosValueError("O saldo mudou durante a operação. Atualize e tente novamente.", 409); }

function canonicalJson(value: unknown): string {
  if (typeof value === "bigint") return JSON.stringify(value.toString());
  if (value instanceof Date) return JSON.stringify(value.toISOString());
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map(field => `${JSON.stringify(field)}:${canonicalJson(record[field])}`).join(",")}}`;
}
