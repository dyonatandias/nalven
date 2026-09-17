import { createHash, randomUUID } from "node:crypto";
import { Prisma, type PrismaClient } from "@/generated/tenant/client";
import { applyPosValueMaintenanceCommand, hashPosValueCommand } from "@/lib/erp/pos-value-accounts";

export const POS_VALUE_LIFECYCLE_ACTOR = "system:pos-value-lifecycle";
export const POS_VALUE_LIFECYCLE_LIMITS = Object.freeze({ defaultBatchSize: 50, maximumBatchSize: 100, serializationRetries: 3 });

export type PosValueLifecycleResult = {
  correlationId: string;
  releasedReservations: number;
  expiredAccounts: number;
  skippedConcurrent: number;
  remainingDueReservations: number;
  remainingDueAccounts: number;
  hasMore: boolean;
};

export async function sweepPosValueLifecycle(db: PrismaClient, options: { now?: Date; batchSize?: number; correlationId?: string } = {}): Promise<PosValueLifecycleResult> {
  const now = options.now ? validDate(options.now) : new Date();
  const batchSize = boundedInteger(options.batchSize ?? POS_VALUE_LIFECYCLE_LIMITS.defaultBatchSize, 1, POS_VALUE_LIFECYCLE_LIMITS.maximumBatchSize, "Lote do ciclo de valores");
  const correlationId = options.correlationId ? boundedIdentifier(options.correlationId, "Correlação") : randomUUID();
  return serializableRetry(db, tx => sweepLocked(tx, now, batchSize, correlationId));
}

async function sweepLocked(tx: Prisma.TransactionClient, now: Date, batchSize: number, correlationId: string): Promise<PosValueLifecycleResult> {
  const [claim] = await tx.$queryRaw<Array<{ acquired: boolean }>>(Prisma.sql`SELECT pg_try_advisory_xact_lock(hashtextextended('nalven:pos-value-lifecycle', 0)) AS "acquired"`);
  if (!claim?.acquired) {
    const [remainingDueReservations, remainingDueAccounts] = await dueCounts(tx, now);
    return { correlationId, releasedReservations: 0, expiredAccounts: 0, skippedConcurrent: 1, remainingDueReservations, remainingDueAccounts, hasMore: remainingDueReservations > 0 || remainingDueAccounts > 0 };
  }
  let releasedReservations = 0, expiredAccounts = 0, skippedConcurrent = 0;

  const reservationCandidates = await tx.posValueReservation.findMany({
    where: dueReservationWhere(now),
    select: { id: true },
    orderBy: [{ accountId: "asc" }, { expiresAt: "asc" }, { id: "asc" }],
    take: batchSize,
  });
  for (const candidate of reservationCandidates) {
    const outcome = await releaseDueReservation(tx, candidate.id, now, correlationId);
    if (outcome === "released") releasedReservations += 1;
    else skippedConcurrent += 1;
  }

  const accountCandidates = await tx.posValueAccount.findMany({
    where: { status: "active", expiresAt: { lte: now }, reservedUnits: BigInt(0) },
    select: { id: true },
    orderBy: [{ expiresAt: "asc" }, { id: "asc" }],
    take: batchSize,
  });
  for (const candidate of accountCandidates) {
    const outcome = await expireDueAccount(tx, candidate.id, now, correlationId);
    if (outcome === "expired") expiredAccounts += 1;
    else skippedConcurrent += 1;
  }

  const [remainingDueReservations, remainingDueAccounts] = await dueCounts(tx, now);
  const result = {
    correlationId,
    releasedReservations,
    expiredAccounts,
    skippedConcurrent,
    remainingDueReservations,
    remainingDueAccounts,
    hasMore: remainingDueReservations > 0 || remainingDueAccounts > 0,
  };
  await tx.tenantAuditEvent.create({ data: {
    actorId: null,
    action: "pos.value.lifecycle.sweep",
    entityType: "pos_value_lifecycle",
    entityId: correlationId,
    correlationId,
    afterData: result,
  } });
  return result;
}

function dueCounts(tx: Prisma.TransactionClient, now: Date) {
  return Promise.all([
    tx.posValueReservation.count({ where: dueReservationWhere(now) }),
    tx.posValueAccount.count({ where: { status: "active", expiresAt: { lte: now } } }),
  ]);
}

async function releaseDueReservation(tx: Prisma.TransactionClient, reservationId: string, now: Date, correlationId: string) {
  await tx.$queryRaw(Prisma.sql`SELECT "id" FROM "pos_value_reservations" WHERE "id" = ${reservationId} FOR UPDATE`);
  const reservation = await tx.posValueReservation.findUnique({
    where: { id: reservationId },
    include: { account: { select: { id: true, status: true, expiresAt: true } } },
  });
  if (!reservation || reservation.state !== "active" || !isReservationDue(reservation, now)) return "skipped" as const;
  const operationKey = lifecycleOperationKey("release", reservation.id);
  const result = await applyPosValueMaintenanceCommand(tx, {
    type: "release",
    reservationId: reservation.id,
    branchId: reservation.branchId,
    operationKey,
    requestHash: hashPosValueCommand({ purpose: "pos.value.lifecycle.release", version: 1, reservationId: reservation.id, expiresAt: reservation.expiresAt }),
    referenceType: reservation.referenceType,
    referenceId: reservation.referenceId,
    reason: "Liberação automática por fim da vigência da reserva ou conta",
  }, { actor: POS_VALUE_LIFECYCLE_ACTOR, now });
  if (result.replayed) return "skipped" as const;
  await tx.tenantAuditEvent.create({ data: {
    actorId: null,
    action: "pos.value.reservation.expired",
    entityType: "pos_value_reservation",
    entityId: reservation.id,
    correlationId,
    beforeData: { state: reservation.state, amountUnits: reservation.amountUnits.toString() },
    afterData: { state: result.reservation?.state || "expired", accountId: reservation.accountId, entryId: result.entry.id, operationKey },
  } });
  return "released" as const;
}

async function expireDueAccount(tx: Prisma.TransactionClient, accountId: string, now: Date, correlationId: string) {
  await tx.$queryRaw(Prisma.sql`SELECT "id" FROM "pos_value_accounts" WHERE "id" = ${accountId} FOR UPDATE`);
  const account = await tx.posValueAccount.findUnique({ where: { id: accountId } });
  if (!account || account.status !== "active" || !account.expiresAt || account.expiresAt > now || account.reservedUnits !== BigInt(0)) return "skipped" as const;
  const operationKey = lifecycleOperationKey("expire", account.id);
  const result = await applyPosValueMaintenanceCommand(tx, {
    type: "expire",
    accountId: account.id,
    branchId: account.branchId,
    operationKey,
    requestHash: hashPosValueCommand({ purpose: "pos.value.lifecycle.expire", version: 1, accountId: account.id, expiresAt: account.expiresAt }),
    referenceType: "pos_value_lifecycle",
    referenceId: account.id,
    reason: "Expiração automática da conta conforme vigência",
  }, { actor: POS_VALUE_LIFECYCLE_ACTOR, now });
  if (result.replayed) return "skipped" as const;
  await tx.tenantAuditEvent.create({ data: {
    actorId: null,
    action: "pos.value.account.expired",
    entityType: "pos_value_account",
    entityId: account.id,
    correlationId,
    beforeData: { status: account.status, balanceUnits: account.balanceUnits.toString(), reservedUnits: account.reservedUnits.toString() },
    afterData: { status: result.account.status, balanceUnits: result.account.balanceUnits, entryId: result.entry.id, operationKey },
  } });
  return "expired" as const;
}

function dueReservationWhere(now: Date): Prisma.PosValueReservationWhereInput {
  return {
    state: "active",
    OR: [
      { expiresAt: { lte: now } },
      { account: { status: "active", expiresAt: { lte: now } } },
    ],
  };
}

function isReservationDue(value: { expiresAt: Date; account: { status: string; expiresAt: Date | null } }, now: Date) {
  return value.expiresAt <= now || value.account.status === "active" && value.account.expiresAt != null && value.account.expiresAt <= now;
}

export function lifecycleOperationKey(operation: "release" | "expire", entityId: string) {
  const id = boundedIdentifier(entityId, "Entidade do ciclo de valores");
  return `value.lifecycle.${operation}:${createHash("sha256").update(id, "utf8").digest("hex").slice(0, 48)}`;
}

async function serializableRetry<T>(db: PrismaClient, execute: (tx: Prisma.TransactionClient) => Promise<T>) {
  for (let attempt = 1; attempt <= POS_VALUE_LIFECYCLE_LIMITS.serializationRetries; attempt += 1) {
    try {
      return await db.$transaction(execute, { isolationLevel: "Serializable", maxWait: 10_000, timeout: 30_000 });
    } catch (error) {
      if (!isPosValueLifecycleSerializationConflict(error) || attempt === POS_VALUE_LIFECYCLE_LIMITS.serializationRetries) throw error;
    }
  }
  throw new Error("Retry serializável do ciclo de valores esgotado.");
}

function validDate(value: Date) {
  if (!(value instanceof Date) || Number.isNaN(value.valueOf())) throw new Error("Relógio do ciclo de valores inválido.");
  return new Date(value);
}

function boundedInteger(value: number, minimum: number, maximum: number, label: string) {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) throw new Error(`${label} deve estar entre ${minimum} e ${maximum}.`);
  return value;
}

function boundedIdentifier(value: string, label: string) {
  if (typeof value !== "string" || value.length < 1 || value.length > 160 || /[\u0000-\u001f]/.test(value)) throw new Error(`${label} inválida.`);
  return value;
}

export function isPosValueLifecycleSerializationConflict(error: unknown) {
  if (!error || typeof error !== "object") return false;
  const record = error as { code?: unknown; meta?: unknown; cause?: unknown };
  if (String(record.code || "") === "P2034") return true;
  const meta = record.meta && typeof record.meta === "object" ? record.meta as { code?: unknown } : null;
  const cause = record.cause && typeof record.cause === "object" ? record.cause as { code?: unknown } : null;
  return new Set(["40001", "40P01"]).has(String(meta?.code || cause?.code || ""));
}
