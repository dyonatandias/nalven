import { createHash, randomUUID } from "node:crypto";
import { Prisma, type PrismaClient } from "@/generated/tenant/client";
import { hashPosReconciliationRequest, posReconciliationLayoutConfig, reconciliationOperationKey, type PosReconciliationAdminInput, PosReconciliationAdminError } from "@/lib/erp/pos-reconciliation-admin";
import { parseConfiguredPosSettlementCsv, posReconciliationReferenceHash, POS_RECONCILIATION_IMPORT_LIMITS, type PosReconciliationLayoutConfig } from "@/lib/erp/pos-reconciliation-layout";
import { reconcilePosSettlements, type PosReconciliationIssue, type PosReconciliationTransaction, type PosSettlementEntry } from "@/lib/erp/pos-reconciliation";

type Db = PrismaClient | Prisma.TransactionClient;
type LayoutCreate = Extract<PosReconciliationAdminInput, { action: "layout.create" }>;
type LayoutUpdate = Extract<PosReconciliationAdminInput, { action: "layout.update" }>;
type LayoutDeactivate = Extract<PosReconciliationAdminInput, { action: "layout.deactivate" }>;
type BatchImport = Extract<PosReconciliationAdminInput, { action: "batch.import" }>;

export const POS_RECONCILIATION_JOB_ACTOR = "system:pos-reconciliation";
export const POS_RECONCILIATION_PROCESSING_LIMITS = Object.freeze({ defaultBatchSize: 10, maximumBatchSize: 50, serializationRetries: 3 });

export async function createPosReconciliationLayout(db: PrismaClient, input: LayoutCreate, actorId: string) {
  const config = posReconciliationLayoutConfig(input.provider, input), requestHash = layoutRequestHash(input, config), createKey = reconciliationOperationKey("layout", input.idempotencyKey);
  const replay = await db.posReconciliationLayout.findUnique({ where: { createKey } });
  if (replay) return replayLayout(replay, actorId, requestHash);
  const correlationId = randomUUID();
  try {
    const layout = await db.$transaction(async tx => {
      await activeBranch(tx, input.branchId);
      const created = await tx.posReconciliationLayout.create({ data: {
        branchId: input.branchId, provider: config.provider, name: input.name, delimiter: config.delimiter,
        amountMode: config.amountMode, decimalSeparator: config.decimalSeparator, dateMode: config.dateMode,
        columnMapping: json(config.columns), kindMapping: json(config.kindMapping), matchWindowHours: input.matchWindowHours,
        createKey, createRequestHash: requestHash, createdBy: actorId,
      } });
      await tx.tenantAuditEvent.create({ data: {
        actorId, action: "pos.reconciliation.layout.created", entityType: "pos_reconciliation_layout", entityId: created.id, correlationId,
        afterData: json({ layout: layoutDto(created), requestHash }),
      } });
      return created;
    }, { isolationLevel: "Serializable" });
    return { layout: layoutDto(layout), correlationId, replayed: false };
  } catch (error) {
    if (prismaCode(error) === "P2002") {
      const concurrent = await db.posReconciliationLayout.findUnique({ where: { createKey } });
      if (concurrent) return replayLayout(concurrent, actorId, requestHash);
    }
    throw error;
  }
}

export async function updatePosReconciliationLayout(db: PrismaClient, input: LayoutUpdate, actorId: string) {
  const correlationId = randomUUID();
  return db.$transaction(async tx => {
    await lockLayout(tx, input.layoutId);
    const before = await tx.posReconciliationLayout.findUnique({ where: { id: input.layoutId } });
    if (!before) throw new PosReconciliationAdminError("Layout de conciliação não encontrado.", 404);
    if (before.version !== input.expectedVersion) throw new PosReconciliationAdminError("O layout foi alterado por outro operador. Recarregue os dados.", 409);
    const config = posReconciliationLayoutConfig(before.provider, input);
    const updated = await tx.posReconciliationLayout.updateMany({
      where: { id: before.id, version: input.expectedVersion },
      data: {
        name: input.name, delimiter: config.delimiter, amountMode: config.amountMode, decimalSeparator: config.decimalSeparator,
        dateMode: config.dateMode, columnMapping: json(config.columns), kindMapping: json(config.kindMapping), matchWindowHours: input.matchWindowHours,
        version: { increment: 1 },
      },
    });
    if (updated.count !== 1) throw new PosReconciliationAdminError("O layout foi alterado por outro operador. Recarregue os dados.", 409);
    const result = await tx.posReconciliationLayout.findUniqueOrThrow({ where: { id: before.id } });
    await tx.tenantAuditEvent.create({ data: {
      actorId, action: "pos.reconciliation.layout.updated", entityType: "pos_reconciliation_layout", entityId: result.id, correlationId,
      beforeData: json({ layout: layoutDto(before) }), afterData: json({ layout: layoutDto(result), operationKey: reconciliationOperationKey("layout", input.idempotencyKey) }),
    } });
    return { layout: layoutDto(result), correlationId, replayed: false };
  }, { isolationLevel: "Serializable" });
}

export async function deactivatePosReconciliationLayout(db: PrismaClient, input: LayoutDeactivate, actorId: string) {
  const correlationId = randomUUID();
  return db.$transaction(async tx => {
    await lockLayout(tx, input.layoutId);
    const before = await tx.posReconciliationLayout.findUnique({ where: { id: input.layoutId } });
    if (!before) throw new PosReconciliationAdminError("Layout de conciliação não encontrado.", 404);
    if (before.version !== input.expectedVersion) throw new PosReconciliationAdminError("O layout foi alterado por outro operador. Recarregue os dados.", 409);
    if (before.status === "inactive") return { layout: layoutDto(before), correlationId, replayed: true };
    const updated = await tx.posReconciliationLayout.updateMany({ where: { id: before.id, version: input.expectedVersion, status: "active" }, data: { status: "inactive", version: { increment: 1 } } });
    if (updated.count !== 1) throw new PosReconciliationAdminError("O layout foi alterado por outro operador. Recarregue os dados.", 409);
    const result = await tx.posReconciliationLayout.findUniqueOrThrow({ where: { id: before.id } });
    await tx.tenantAuditEvent.create({ data: {
      actorId, action: "pos.reconciliation.layout.deactivated", entityType: "pos_reconciliation_layout", entityId: result.id, correlationId,
      beforeData: json({ status: before.status, version: before.version }), afterData: json({ status: result.status, version: result.version, operationKey: reconciliationOperationKey("layout", input.idempotencyKey) }),
    } });
    return { layout: layoutDto(result), correlationId, replayed: false };
  }, { isolationLevel: "Serializable" });
}

export async function importPosReconciliationBatch(db: PrismaClient, input: BatchImport, actorId: string) {
  const layout = await db.posReconciliationLayout.findFirst({ where: { id: input.layoutId, branchId: input.branchId, status: "active", branch: { status: "active" } } });
  if (!layout) throw new PosReconciliationAdminError("Layout ativo não encontrado para a filial.", 404);
  const snapshot = layoutSnapshot(layout);
  const parsed = parseConfiguredPosSettlementCsv(input.csv, snapshot.config);
  const requestKey = reconciliationOperationKey("import", input.idempotencyKey);
  const requestHash = hashPosReconciliationRequest({ action: input.action, branchId: input.branchId, layoutId: layout.id, layoutVersion: layout.version, provider: layout.provider, digest: parsed.digest });
  const byKey = await db.posReconciliationBatch.findUnique({ where: { requestKey } });
  if (byKey) {
    validateBatchReplay(byKey, actorId, requestHash);
    return processImportedBatch(db, byKey.id, byKey.version, actorId, true);
  }
  const byDigest = await db.posReconciliationBatch.findUnique({ where: { provider_digest: { provider: layout.provider, digest: parsed.digest } } });
  if (byDigest) {
    if (byDigest.branchId !== input.branchId) throw new PosReconciliationAdminError("Este arquivo do provedor já pertence a outra filial.", 409);
    return processImportedBatch(db, byDigest.id, byDigest.version, actorId, true);
  }
  const erpCount = await db.posSalePayment.count({ where: erpTransactionWhere(input.branchId, layout.provider, parsed.periodStart, parsed.periodEnd, snapshot.matchWindowHours) });
  if (erpCount > POS_RECONCILIATION_IMPORT_LIMITS.maximumErpTransactions) throw new PosReconciliationAdminError("O recorte do ERP excede 20.000 transações; reduza a janela do layout.", 409);
  const correlationId = randomUUID();
  let batchId: string;
  try {
    batchId = await db.$transaction(async tx => {
      await activeBranch(tx, input.branchId);
      const currentLayout = await tx.posReconciliationLayout.findFirst({ where: { id: layout.id, branchId: input.branchId, status: "active", version: layout.version } });
      if (!currentLayout) throw new PosReconciliationAdminError("O layout mudou durante a importação. Recarregue e tente novamente.", 409);
      const batch = await tx.posReconciliationBatch.create({ data: {
        branchId: input.branchId, layoutId: layout.id, layoutVersion: layout.version, layoutSnapshot: json(snapshot), provider: layout.provider,
        digest: parsed.digest, requestKey, requestHash, rowCount: parsed.entries.length, periodStart: parsed.periodStart, periodEnd: parsed.periodEnd,
        importedBy: actorId, correlationId,
      } });
      await tx.posReconciliationLine.createMany({ data: parsed.entries.map((entry, index) => ({
        batchId: batch.id, lineNumber: index + 2, settlementId: entry.settlementId, transactionId: entry.transactionId,
        referenceHash: posReconciliationReferenceHash(entry.provider, entry.transactionId), kind: entry.kind,
        grossCents: BigInt(entry.grossCents), feeCents: BigInt(entry.feeCents), netCents: BigInt(entry.netCents), occurredAt: entry.occurredAt, settledAt: entry.settledAt,
      })) });
      await tx.tenantAuditEvent.create({ data: {
        actorId, action: "pos.reconciliation.batch.imported", entityType: "pos_reconciliation_batch", entityId: batch.id, correlationId,
        afterData: json({ branchId: batch.branchId, provider: batch.provider, digest: batch.digest, rowCount: batch.rowCount, layoutId: batch.layoutId, layoutVersion: batch.layoutVersion, requestHash }),
      } });
      return batch.id;
    }, { isolationLevel: "Serializable" });
  } catch (error) {
    if (prismaCode(error) === "P2002") {
      const concurrent = await db.posReconciliationBatch.findFirst({ where: { OR: [{ requestKey }, { provider: layout.provider, digest: parsed.digest }] } });
      if (concurrent) {
        if (concurrent.requestKey === requestKey) validateBatchReplay(concurrent, actorId, requestHash);
        if (concurrent.branchId !== input.branchId) throw new PosReconciliationAdminError("Este arquivo do provedor já pertence a outra filial.", 409);
        return processImportedBatch(db, concurrent.id, concurrent.version, actorId, true);
      }
    }
    throw error;
  }
  return processImportedBatch(db, batchId, 0, actorId, false);
}

export async function reprocessPosReconciliationBatch(db: PrismaClient, input: Extract<PosReconciliationAdminInput, { action: "batch.reprocess" }>, actorId: string) {
  const operationKey = reconciliationOperationKey("reprocess", input.idempotencyKey);
  const requestHash = hashPosReconciliationRequest({ action: input.action, batchId: input.batchId, expectedVersion: input.expectedVersion });
  const run = await processPosReconciliationBatch(db, { batchId: input.batchId, expectedVersion: input.expectedVersion, operationKey, requestHash, actorId });
  return { batch: run.batch, run: run.run, replayed: run.replayed, correlationId: run.correlationId };
}

export async function processPendingPosReconciliationBatches(db: PrismaClient, options: { batchSize?: number; actorId?: string } = {}) {
  const batchSize = boundedBatchSize(options.batchSize ?? POS_RECONCILIATION_PROCESSING_LIMITS.defaultBatchSize);
  const actorId = options.actorId || POS_RECONCILIATION_JOB_ACTOR;
  const pending = await db.posReconciliationBatch.findMany({ where: { status: "pending" }, select: { id: true, version: true }, orderBy: [{ createdAt: "asc" }, { id: "asc" }], take: batchSize });
  let completed = 0, skipped = 0, failed = 0;
  const results: Array<{ batchId: string; status: string; errorCode?: string }> = [];
  for (const batch of pending) {
    const operationKey = jobOperationKey(batch.id, batch.version), requestHash = hashPosReconciliationRequest({ purpose: "job", batchId: batch.id, expectedVersion: batch.version });
    try {
      const result = await processPosReconciliationBatch(db, { batchId: batch.id, expectedVersion: batch.version, operationKey, requestHash, actorId });
      if (result.replayed) skipped += 1; else completed += 1;
      results.push({ batchId: batch.id, status: result.replayed ? "replayed" : "completed" });
    } catch (error) {
      if (error instanceof PosReconciliationAdminError && error.status === 409) { skipped += 1; results.push({ batchId: batch.id, status: "concurrent" }); }
      else { failed += 1; results.push({ batchId: batch.id, status: "failed", errorCode: safeProcessingErrorCode(error) }); }
    }
  }
  const remaining = await db.posReconciliationBatch.count({ where: { status: "pending" } });
  return { selected: pending.length, completed, skipped, failed, remaining, hasMore: remaining > 0, results };
}

export async function processPosReconciliationBatch(db: PrismaClient, input: { batchId: string; expectedVersion: number; operationKey: string; requestHash: string; actorId: string; allowActorReplay?: boolean }) {
  try {
    return await serializableRetry(db, tx => processLockedBatch(tx, input));
  } catch (error) {
    if (prismaCode(error) === "P2002") {
      const existing = await db.posReconciliationRun.findUnique({ where: { operationKey: input.operationKey }, include: { batch: true } });
      if (existing) return replayRun(existing, input);
    }
    throw error;
  }
}

async function processLockedBatch(tx: Prisma.TransactionClient, input: { batchId: string; expectedVersion: number; operationKey: string; requestHash: string; actorId: string; allowActorReplay?: boolean }) {
  const existing = await tx.posReconciliationRun.findUnique({ where: { operationKey: input.operationKey }, include: { batch: true } });
  if (existing) return replayRun(existing, input);
  await tx.$queryRaw(Prisma.sql`SELECT "id" FROM "pos_reconciliation_batches" WHERE "id" = ${input.batchId} FOR UPDATE`);
  const batch = await tx.posReconciliationBatch.findUnique({ where: { id: input.batchId }, include: { lines: { orderBy: { lineNumber: "asc" } } } });
  if (!batch) throw new PosReconciliationAdminError("Lote de conciliação não encontrado.", 404);
  if (batch.version !== input.expectedVersion) throw new PosReconciliationAdminError("O lote já foi processado por outro operador. Recarregue os dados.", 409);
  const snapshot = parseLayoutSnapshot(batch.layoutSnapshot, batch.provider);
  const entries = batch.lines.map(line => ({
    provider: batch.provider, settlementId: line.settlementId, transactionId: line.transactionId, kind: line.kind as PosSettlementEntry["kind"],
    grossCents: safeNumber(line.grossCents, "Valor bruto"), feeCents: safeNumber(line.feeCents, "Taxa"), netCents: safeNumber(line.netCents, "Valor líquido"),
    occurredAt: line.occurredAt, settledAt: line.settledAt,
  } satisfies PosSettlementEntry));
  const erpRows = await erpTransactions(tx, batch.branchId, batch.provider, batch.periodStart, batch.periodEnd, snapshot.matchWindowHours);
  const transactions = erpRows.map(row => ({ provider: batch.provider, transactionId: row.transactionId!, kind: row.type === "refund" ? "refund" : "payment", amountCents: row.amountCents, status: row.status } satisfies PosReconciliationTransaction));
  const result = reconcilePosSettlements(transactions, entries), correlationId = randomUUID(), sequence = batch.version + 1;
  const lineByKey = new Map<string, typeof batch.lines[number]>(), paymentByKey = new Map<string, typeof erpRows[number]>();
  for (const line of batch.lines) if (!lineByKey.has(line.transactionId)) lineByKey.set(line.transactionId, line);
  for (const payment of erpRows) if (payment.transactionId && !paymentByKey.has(payment.transactionId)) paymentByKey.set(payment.transactionId, payment);
  const run = await tx.posReconciliationRun.create({ data: {
    batchId: batch.id, sequence, inputVersion: batch.version, operationKey: input.operationKey, requestHash: input.requestHash,
    matchedCount: result.matched, issueCount: result.issueCount, productionBlocking: result.productionBlocking,
    grossCents: BigInt(result.totals.grossCents), feeCents: BigInt(result.totals.feeCents), netCents: BigInt(result.totals.netCents),
    processedBy: input.actorId, correlationId,
  } });
  if (result.issues.length) await tx.posReconciliationIssue.createMany({ data: result.issues.map(issue => issueRecord(issue, run.id, batch.provider, lineByKey, paymentByKey)) });
  const updated = await tx.posReconciliationBatch.updateMany({ where: { id: batch.id, version: batch.version }, data: {
    status: "completed", version: { increment: 1 }, matchedCount: result.matched, issueCount: result.issueCount, productionBlocking: result.productionBlocking,
    grossCents: BigInt(result.totals.grossCents), feeCents: BigInt(result.totals.feeCents), netCents: BigInt(result.totals.netCents),
    lastProcessedBy: input.actorId, lastErrorCode: null, completedAt: new Date(),
  } });
  if (updated.count !== 1) throw new PosReconciliationAdminError("O lote já foi processado por outro operador. Recarregue os dados.", 409);
  const issueCodes = result.issues.reduce<Record<string, number>>((counts, issue) => ({ ...counts, [issue.code]: (counts[issue.code] || 0) + 1 }), {});
  await tx.tenantAuditEvent.create({ data: {
    actorId: input.actorId === POS_RECONCILIATION_JOB_ACTOR ? null : input.actorId,
    action: "pos.reconciliation.batch.processed", entityType: "pos_reconciliation_batch", entityId: batch.id, correlationId,
    beforeData: json({ status: batch.status, version: batch.version }),
    afterData: json({ status: "completed", version: sequence, runId: run.id, matchedCount: result.matched, issueCount: result.issueCount, productionBlocking: result.productionBlocking, totals: result.totals, issueCodes, requestHash: input.requestHash }),
  } });
  const current = await tx.posReconciliationBatch.findUniqueOrThrow({ where: { id: batch.id } });
  return { batch: batchDto(current), run: runDto(run), replayed: false, correlationId };
}

export async function posReconciliationReport(db: PrismaClient, branchId: number, limit = 25) {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 50) throw new PosReconciliationAdminError("Limite do relatório deve estar entre 1 e 50.", 400);
  await activeBranch(db, branchId);
  const [layouts, batches, statusGroups, providerGroups, issueGroups, pendingCount] = await Promise.all([
    db.posReconciliationLayout.findMany({ where: { branchId }, orderBy: [{ status: "asc" }, { provider: "asc" }, { name: "asc" }], take: 100 }),
    db.posReconciliationBatch.findMany({ where: { branchId }, include: { layout: { select: { name: true } }, runs: { orderBy: [{ completedAt: "desc" }, { id: "desc" }], take: 1, include: { _count: { select: { issues: true } }, issues: { select: { code: true }, orderBy: { id: "asc" }, take: 100 } } } }, orderBy: [{ createdAt: "desc" }, { id: "desc" }], take: limit }),
    db.posReconciliationBatch.groupBy({ by: ["status"], where: { branchId }, _count: { _all: true }, _sum: { rowCount: true, matchedCount: true, issueCount: true } }),
    db.posReconciliationBatch.groupBy({ by: ["provider"], where: { branchId }, _count: { _all: true }, _sum: { grossCents: true, feeCents: true, netCents: true, issueCount: true } }),
    db.posReconciliationIssue.groupBy({ by: ["code"], where: { run: { batch: { branchId } } }, _count: { _all: true } }),
    db.posReconciliationBatch.count({ where: { branchId, status: "pending" } }),
  ]);
  return {
    generatedAt: new Date(), limits: { batches: limit, layouts: 100, issuesPerRun: 100 },
    summary: {
      pending: pendingCount,
      currentIssueCount: statusGroups.reduce((sum, group) => sum + (group._sum.issueCount || 0), 0),
      byStatus: statusGroups.map(group => ({ status: group.status, batchCount: group._count._all, rowCount: group._sum.rowCount || 0, matchedCount: group._sum.matchedCount || 0, issueCount: group._sum.issueCount || 0 })),
      byProvider: providerGroups.map(group => ({ provider: group.provider, batchCount: group._count._all, grossCents: (group._sum.grossCents || BigInt(0)).toString(), feeCents: (group._sum.feeCents || BigInt(0)).toString(), netCents: (group._sum.netCents || BigInt(0)).toString(), issueCount: group._sum.issueCount || 0 })),
      issueHistory: issueGroups.map(group => ({ code: group.code, count: group._count._all })),
    },
    layouts: layouts.map(layoutDto),
    batches: batches.map(batch => {
      const latest = batch.runs[0], codes = latest?.issues.reduce<Record<string, number>>((sum, issue) => ({ ...sum, [issue.code]: (sum[issue.code] || 0) + 1 }), {}) || {};
      return { ...batchDto(batch), layoutName: batch.layout.name, latestRun: latest ? { ...runDto(latest), issueCodes: codes, issueDetailsTruncated: latest._count.issues > latest.issues.length } : null };
    }),
  };
}

export function layoutDto(value: { id: string; branchId: number; provider: string; name: string; status: string; version: number; delimiter: string; amountMode: string; decimalSeparator: string; dateMode: string; columnMapping: Prisma.JsonValue; kindMapping: Prisma.JsonValue; matchWindowHours: number; createdAt: Date; updatedAt: Date }) {
  return { id: value.id, branchId: value.branchId, provider: value.provider, name: value.name, status: value.status, version: value.version, delimiter: value.delimiter, amountMode: value.amountMode, decimalSeparator: value.decimalSeparator, dateMode: value.dateMode, columns: value.columnMapping, kindMapping: value.kindMapping, matchWindowHours: value.matchWindowHours, createdAt: value.createdAt, updatedAt: value.updatedAt };
}

export function batchDto(value: { id: string; branchId: number; layoutId: string; layoutVersion: number; provider: string; digest: string; status: string; version: number; rowCount: number; matchedCount: number; issueCount: number; productionBlocking: boolean; grossCents: bigint; feeCents: bigint; netCents: bigint; periodStart: Date; periodEnd: Date; lastErrorCode: string | null; correlationId: string; completedAt: Date | null; createdAt: Date; updatedAt: Date }) {
  return { id: value.id, branchId: value.branchId, layoutId: value.layoutId, layoutVersion: value.layoutVersion, provider: value.provider, digestPrefix: value.digest.slice(0, 16), status: value.status, version: value.version, rowCount: value.rowCount, matchedCount: value.matchedCount, issueCount: value.issueCount, productionBlocking: value.productionBlocking, totals: { grossCents: value.grossCents.toString(), feeCents: value.feeCents.toString(), netCents: value.netCents.toString() }, periodStart: value.periodStart, periodEnd: value.periodEnd, lastErrorCode: value.lastErrorCode, correlationId: value.correlationId, completedAt: value.completedAt, createdAt: value.createdAt, updatedAt: value.updatedAt };
}

function runDto(value: { id: string; batchId: string; sequence: number; inputVersion: number; state: string; matchedCount: number; issueCount: number; productionBlocking: boolean; grossCents: bigint; feeCents: bigint; netCents: bigint; correlationId: string; completedAt: Date }) {
  return { id: value.id, batchId: value.batchId, sequence: value.sequence, inputVersion: value.inputVersion, state: value.state, matchedCount: value.matchedCount, issueCount: value.issueCount, productionBlocking: value.productionBlocking, totals: { grossCents: value.grossCents.toString(), feeCents: value.feeCents.toString(), netCents: value.netCents.toString() }, correlationId: value.correlationId, completedAt: value.completedAt };
}

function issueRecord(issue: PosReconciliationIssue, runId: string, provider: string, lines: Map<string, { id: bigint; grossCents: bigint }>, payments: Map<string, { id: string; amountCents: number }>) {
  const line = lines.get(issue.transactionId), payment = payments.get(issue.transactionId);
  return {
    runId, lineId: line?.id, erpPaymentId: payment?.id, code: issue.code, referenceHash: posReconciliationReferenceHash(provider, issue.transactionId),
    expectedCents: issue.code === "amount_mismatch" && payment ? BigInt(payment.amountCents) : undefined,
    actualCents: issue.code === "amount_mismatch" && line ? line.grossCents : undefined,
  };
}

async function erpTransactions(tx: Prisma.TransactionClient, branchId: number, provider: string, periodStart: Date, periodEnd: Date, windowHours: number) {
  const rows = await tx.posSalePayment.findMany({
    where: erpTransactionWhere(branchId, provider, periodStart, periodEnd, windowHours),
    select: { id: true, type: true, status: true, amountCents: true, transactionId: true }, orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    take: POS_RECONCILIATION_IMPORT_LIMITS.maximumErpTransactions + 1,
  });
  if (rows.length > POS_RECONCILIATION_IMPORT_LIMITS.maximumErpTransactions) throw new PosReconciliationAdminError("O recorte do ERP excede 20.000 transações; reduza a janela do layout.", 409);
  return rows;
}

function layoutSnapshot(value: { provider: string; version: number; delimiter: string; amountMode: string; decimalSeparator: string; dateMode: string; columnMapping: Prisma.JsonValue; kindMapping: Prisma.JsonValue; matchWindowHours: number }) {
  const config = posReconciliationLayoutConfig(value.provider, {
    name: "snapshot", delimiter: value.delimiter as "," | ";" | "\t", amountMode: value.amountMode as "integer_cents" | "decimal",
    decimalSeparator: value.decimalSeparator as "." | ",", dateMode: value.dateMode as "iso8601" | "epoch_millis",
    columns: value.columnMapping as never, kindMapping: value.kindMapping as never, matchWindowHours: value.matchWindowHours,
  });
  return { version: value.version, matchWindowHours: value.matchWindowHours, config };
}

function parseLayoutSnapshot(value: Prisma.JsonValue, provider: string) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new PosReconciliationAdminError("Snapshot do layout do lote está corrompido.", 409);
  const record = value as Record<string, unknown>, configValue = record.config;
  if (!configValue || typeof configValue !== "object" || Array.isArray(configValue)) throw new PosReconciliationAdminError("Snapshot do layout do lote está corrompido.", 409);
  const matchWindowHours = Number(record.matchWindowHours);
  if (!Number.isSafeInteger(matchWindowHours) || matchWindowHours < 0 || matchWindowHours > 168) throw new PosReconciliationAdminError("Snapshot do layout do lote está corrompido.", 409);
  const config = configValue as Record<string, unknown>;
  return { matchWindowHours, config: posReconciliationLayoutConfig(provider, {
    name: "snapshot", matchWindowHours,
    delimiter: config.delimiter as "," | ";" | "\t",
    amountMode: config.amountMode as "integer_cents" | "decimal",
    decimalSeparator: config.decimalSeparator as "." | ",",
    dateMode: config.dateMode as "iso8601" | "epoch_millis",
    columns: config.columns as never,
    kindMapping: config.kindMapping as never,
  }) };
}

async function processImportedBatch(db: PrismaClient, batchId: string, version: number, actorId: string, replayedImport: boolean) {
  const batch = await db.posReconciliationBatch.findUniqueOrThrow({ where: { id: batchId } });
  if (batch.status === "pending") {
    const operationKey = `reconciliation:initial:${batchId}`, requestHash = hashPosReconciliationRequest({ batchId, version: 0, purpose: "initial" });
    const result = await processPosReconciliationBatch(db, { batchId, expectedVersion: version, operationKey, requestHash, actorId, allowActorReplay: true });
    return { ...result, replayed: replayedImport || result.replayed };
  }
  const latest = await db.posReconciliationRun.findFirst({ where: { batchId }, orderBy: [{ sequence: "desc" }, { id: "desc" }] });
  return { batch: batchDto(batch), run: latest ? runDto(latest) : null, replayed: true, correlationId: batch.correlationId };
}

function validateBatchReplay(value: { importedBy: string; requestHash: string }, actorId: string, requestHash: string) {
  if (value.importedBy !== actorId || value.requestHash !== requestHash) throw new PosReconciliationAdminError("A chave de importação já foi usada com outro contexto ou arquivo.", 409);
}

function replayRun(existing: { batchId: string; requestHash: string; processedBy: string; correlationId: string; batch: Parameters<typeof batchDto>[0] } & Parameters<typeof runDto>[0], input: { batchId: string; requestHash: string; actorId: string; allowActorReplay?: boolean }) {
  if (existing.batchId !== input.batchId || existing.requestHash !== input.requestHash || !input.allowActorReplay && existing.processedBy !== input.actorId) throw new PosReconciliationAdminError("A chave de reprocessamento já foi usada com outro contexto.", 409);
  return { batch: batchDto(existing.batch), run: runDto(existing), replayed: true, correlationId: existing.correlationId };
}

function replayLayout(value: Parameters<typeof layoutDto>[0] & { createdBy: string; createRequestHash: string }, actorId: string, requestHash: string) {
  if (value.createdBy !== actorId || value.createRequestHash !== requestHash) throw new PosReconciliationAdminError("A chave de criação já foi usada com outro contexto ou layout.", 409);
  return { layout: layoutDto(value), correlationId: null, replayed: true };
}

function layoutRequestHash(input: LayoutCreate, config: PosReconciliationLayoutConfig) {
  return hashPosReconciliationRequest({ action: input.action, branchId: input.branchId, name: input.name, provider: config.provider, delimiter: config.delimiter, amountMode: config.amountMode, decimalSeparator: config.decimalSeparator, dateMode: config.dateMode, columns: config.columns, kindMapping: config.kindMapping, matchWindowHours: input.matchWindowHours });
}

async function activeBranch(db: Db, branchId: number) {
  const branch = await db.branch.findFirst({ where: { id: branchId, status: "active" }, select: { id: true } });
  if (!branch) throw new PosReconciliationAdminError("Filial ativa não encontrada.", 404);
  return branch;
}

async function lockLayout(tx: Prisma.TransactionClient, layoutId: string) {
  await tx.$queryRaw(Prisma.sql`SELECT "id" FROM "pos_reconciliation_layouts" WHERE "id" = ${layoutId} FOR UPDATE`);
}

function jobOperationKey(batchId: string, version: number) {
  return `reconciliation:job:${createHash("sha256").update(`${batchId}:${version}`, "utf8").digest("hex").slice(0, 48)}`;
}

function erpTransactionWhere(branchId: number, provider: string, periodStart: Date, periodEnd: Date, windowHours: number): Prisma.PosSalePaymentWhereInput {
  const from = new Date(periodStart.valueOf() - windowHours * 60 * 60_000), to = new Date(periodEnd.valueOf() + windowHours * 60 * 60_000);
  return {
    sale: { branchId }, provider: { equals: provider, mode: "insensitive" }, transactionId: { not: null },
    OR: [{ createdAt: { gte: from, lte: to } }, { authorizedAt: { gte: from, lte: to } }, { capturedAt: { gte: from, lte: to } }, { refundedAt: { gte: from, lte: to } }],
  };
}

async function serializableRetry<T>(db: PrismaClient, execute: (tx: Prisma.TransactionClient) => Promise<T>) {
  for (let attempt = 1; attempt <= POS_RECONCILIATION_PROCESSING_LIMITS.serializationRetries; attempt += 1) {
    try { return await db.$transaction(execute, { isolationLevel: "Serializable", maxWait: 10_000, timeout: 30_000 }); }
    catch (error) { if (!isSerializationConflict(error) || attempt === POS_RECONCILIATION_PROCESSING_LIMITS.serializationRetries) throw error; }
  }
  throw new Error("Retry serializável da conciliação esgotado.");
}

export function isPosReconciliationSerializationConflict(error: unknown) { return isSerializationConflict(error); }

function isSerializationConflict(error: unknown) {
  if (!error || typeof error !== "object") return false;
  const value = error as { code?: unknown; meta?: unknown; cause?: unknown; message?: unknown };
  if (String(value.code || "") === "P2034") return true;
  return hasPostgresRetryCode(value.meta) || hasPostgresRetryCode(value.cause) || /\b(?:40001|40P01)\b/.test(String(value.message || ""));
}

function hasPostgresRetryCode(value: unknown, depth = 0): boolean {
  if (!value || typeof value !== "object" || depth > 5) return false;
  const record = value as Record<string, unknown>;
  if (["40001", "40P01"].includes(String(record.code ?? record.originalCode ?? record.sqlState ?? ""))) return true;
  return ["meta", "cause", "driverAdapterError", "error"].some(key => hasPostgresRetryCode(record[key], depth + 1));
}

function safeProcessingErrorCode(error: unknown) {
  if (error instanceof PosReconciliationAdminError) return `INPUT_${error.status}`;
  if (isSerializationConflict(error)) return "SERIALIZATION_CONFLICT";
  return prismaCode(error).startsWith("P") ? "DATABASE_ERROR" : "PROCESSING_FAILED";
}

function boundedBatchSize(value: number) {
  if (!Number.isSafeInteger(value) || value < 1 || value > POS_RECONCILIATION_PROCESSING_LIMITS.maximumBatchSize) throw new PosReconciliationAdminError("Limite do job deve estar entre 1 e 50.", 400);
  return value;
}

function safeNumber(value: bigint, label: string) {
  const result = Number(value);
  if (!Number.isSafeInteger(result)) throw new PosReconciliationAdminError(`${label} do lote excede o limite seguro.`, 409);
  return result;
}

function json(value: unknown) { return value as Prisma.InputJsonValue; }
function prismaCode(error: unknown) { return error && typeof error === "object" && "code" in error ? String((error as { code?: unknown }).code || "") : ""; }
