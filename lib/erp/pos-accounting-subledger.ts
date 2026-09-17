import { createHash, randomUUID } from "node:crypto";
import { Prisma, type PrismaClient } from "@/generated/tenant/client";
import { containsPosPaymentPanInIdentifier } from "@/lib/erp/pos-payment-persistence";
import { closePosT2AccountingPeriodBoundary, putPosT2AccountingPeriodBoundary, toPosT2BoundaryIdempotencyKey } from "@/lib/erp/pos-t2-boundary";

export const POS_ACCOUNTING_SOURCE_TYPES = [
  "sale",
  "refund_compensation",
  "cash_ledger",
  "inventory_cogs",
  "fiscal_tax",
  "mdr",
  "value_account",
] as const;

export type PosAccountingSourceType = typeof POS_ACCOUNTING_SOURCE_TYPES[number];

export type PosAccountingSourceSnapshot = {
  schemaVersion: 1;
  sourceType: PosAccountingSourceType;
  sourceId: string;
  sourceVersion: number;
  competenceDate: string;
  facts: Record<string, unknown>;
  factsHash: string;
};

export type PosAccountingJournalRequest = {
  branchId: number;
  costCenterId: number;
  periodId: string;
  policyId: string;
  occurredAt: Date;
  currency: "BRL";
  description: string;
  source: PosAccountingSourceSnapshot;
  postings: Array<{
    mappingKey: string;
    amountCents: number;
    description?: string | null;
    dimensions?: Record<string, unknown> | null;
  }>;
  idempotencyKey: string;
  createdBy: string;
};

export type PosAccountingReversalRequest = {
  originalJournalId: string;
  periodId: string;
  competenceDate: string;
  occurredAt: Date;
  reason: string;
  idempotencyKey: string;
  createdBy: string;
};

export class PosAccountingError extends Error {
  constructor(message: string, public readonly status = 422) {
    super(message);
    this.name = "PosAccountingError";
  }
}

type RootDb = PrismaClient;

/**
 * Creates a source-only snapshot. It intentionally contains no chart account,
 * direction, or posting policy: those are resolved exclusively from an active,
 * accountant-homologated policy at journal creation time.
 */
export function buildPosAccountingSourceSnapshot(input: {
  sourceType: PosAccountingSourceType;
  sourceId: string;
  sourceVersion: number;
  competenceDate: string;
  facts: Record<string, unknown>;
}): PosAccountingSourceSnapshot {
  if (!POS_ACCOUNTING_SOURCE_TYPES.includes(input.sourceType)) throw new PosAccountingError("Origem contábil não suportada.", 400);
  const sourceId = safeIdentifier(input.sourceId, "Origem", 1, 160);
  const sourceVersion = integer(input.sourceVersion, "Versão da origem", 0, 2_147_483_647);
  const competenceDate = dateOnly(input.competenceDate, "Competência");
  rejectSensitiveData(input.facts);
  const facts = canonicalClone(input.facts) as Record<string, unknown>;
  return {
    schemaVersion: 1,
    sourceType: input.sourceType,
    sourceId,
    sourceVersion,
    competenceDate,
    facts,
    factsHash: hashPosAccountingPayload(facts),
  };
}

export function buildPosSaleAccountingSnapshot(input: { saleId: number; saleVersion: number; competenceDate: string; status: string; subtotalCents: number; discountCents: number; surchargeCents: number; totalCents: number; paymentIds: string[] }) {
  return buildPosAccountingSourceSnapshot({ sourceType: "sale", sourceId: String(integer(input.saleId, "Venda", 1, 2_147_483_647)), sourceVersion: input.saleVersion, competenceDate: input.competenceDate, facts: { saleId: input.saleId, status: input.status, subtotalCents: input.subtotalCents, discountCents: input.discountCents, surchargeCents: input.surchargeCents, totalCents: input.totalCents, paymentIds: input.paymentIds } });
}

export function buildPosRefundAccountingSnapshot(input: { compensationId: string; compensationVersion: number; competenceDate: string; saleId: number; originalPaymentId: string; refundPaymentId: string; amountCents: number; evidenceHash: string }) {
  return buildPosAccountingSourceSnapshot({ sourceType: "refund_compensation", sourceId: safeIdentifier(input.compensationId, "Compensação", 1, 160), sourceVersion: input.compensationVersion, competenceDate: input.competenceDate, facts: { compensationId: input.compensationId, saleId: input.saleId, originalPaymentId: input.originalPaymentId, refundPaymentId: input.refundPaymentId, amountCents: input.amountCents, evidenceHash: sha256(input.evidenceHash, "Evidência") } });
}

export function buildPosCashAccountingSnapshot(input: { ledgerEntryId: string; ledgerVersion: number; competenceDate: string; branchId: number; registerId: number; sessionId: number; entryType: string; deltaCents: number }) {
  return buildPosAccountingSourceSnapshot({ sourceType: "cash_ledger", sourceId: safeIdentifier(input.ledgerEntryId, "Lançamento de caixa", 1, 160), sourceVersion: input.ledgerVersion, competenceDate: input.competenceDate, facts: { ledgerEntryId: input.ledgerEntryId, branchId: input.branchId, registerId: input.registerId, sessionId: input.sessionId, entryType: input.entryType, deltaCents: input.deltaCents } });
}

export function buildPosInventoryCogsAccountingSnapshot(input: { sourceId: string; sourceVersion: number; competenceDate: string; saleId: number | null; warehouseLedgerEntryIds: string[]; costCents: number; quantityMicros: string }) {
  return buildPosAccountingSourceSnapshot({ sourceType: "inventory_cogs", sourceId: input.sourceId, sourceVersion: input.sourceVersion, competenceDate: input.competenceDate, facts: { saleId: input.saleId, warehouseLedgerEntryIds: input.warehouseLedgerEntryIds, costCents: input.costCents, quantityMicros: input.quantityMicros } });
}

export function buildPosFiscalTaxAccountingSnapshot(input: { fiscalDocumentId: string; fiscalVersion: number; competenceDate: string; saleId: number; documentStatus: string; totalCents: number; taxFacts: Record<string, number> }) {
  return buildPosAccountingSourceSnapshot({ sourceType: "fiscal_tax", sourceId: input.fiscalDocumentId, sourceVersion: input.fiscalVersion, competenceDate: input.competenceDate, facts: { fiscalDocumentId: input.fiscalDocumentId, saleId: input.saleId, documentStatus: input.documentStatus, totalCents: input.totalCents, taxFacts: input.taxFacts } });
}

export function buildPosMdrAccountingSnapshot(input: { reconciliationLineId: string; reconciliationVersion: number; competenceDate: string; paymentId: string; grossCents: number; feeCents: number; netCents: number; provider: string }) {
  return buildPosAccountingSourceSnapshot({ sourceType: "mdr", sourceId: input.reconciliationLineId, sourceVersion: input.reconciliationVersion, competenceDate: input.competenceDate, facts: { reconciliationLineId: input.reconciliationLineId, paymentId: input.paymentId, grossCents: input.grossCents, feeCents: input.feeCents, netCents: input.netCents, provider: input.provider } });
}

export function buildPosValueAccountAccountingSnapshot(input: { ledgerEntryId: string; ledgerVersion: number; competenceDate: string; valueAccountId: string; kind: string; deltaUnits: number; monetaryValueCents: number }) {
  return buildPosAccountingSourceSnapshot({ sourceType: "value_account", sourceId: input.ledgerEntryId, sourceVersion: input.ledgerVersion, competenceDate: input.competenceDate, facts: { ledgerEntryId: input.ledgerEntryId, valueAccountId: input.valueAccountId, kind: input.kind, deltaUnits: input.deltaUnits, monetaryValueCents: input.monetaryValueCents } });
}

export function hashPosAccountingPayload(value: unknown) {
  return createHash("sha256").update(canonicalJson(value), "utf8").digest("hex");
}

export function hashPosAccountingPolicyMappings(mappings: Array<{ id: string; sourceType: string; entryKey: string; accountId: string; direction: string }>) {
  return hashPosAccountingPayload(mappings.map((item) => ({ id: item.id, sourceType: item.sourceType, entryKey: item.entryKey, accountId: item.accountId, direction: item.direction })).sort((left, right) => `${left.sourceType}:${left.entryKey}:${left.id}`.localeCompare(`${right.sourceType}:${right.entryKey}:${right.id}`)));
}

export async function activatePosAccountingPolicy(db: RootDb, input: { policyId: string; accountantApprovalRef: string; homologatedBy: string; now?: Date }) {
  const policyId = safeIdentifier(input.policyId, "Política", 8, 160);
    const accountantApprovalRef = safeIdentifier(input.accountantApprovalRef, "Aprovação contábil", 8, 160);
    const homologatedBy = safeActorIdentifier(input.homologatedBy, "Responsável pela homologação");
  const now = validDate(input.now ?? new Date());
  return serializableRetry(db, async (tx) => {
    await tx.$queryRaw(Prisma.sql`SELECT "id" FROM "pos_accounting_policies" WHERE "id" = ${policyId} FOR UPDATE`);
    const policy = await tx.posAccountingPolicy.findUnique({ where: { id: policyId }, include: { mappings: { include: { account: true } } } });
    if (!policy) throw new PosAccountingError("Política contábil não encontrada.", 404);
    if (policy.status === "active") {
      if (policy.accountantApprovalRef !== accountantApprovalRef || policy.homologatedBy !== homologatedBy) throw new PosAccountingError("A política já foi ativada com outra homologação.", 409);
      return { policy, replayed: true };
    }
    if (policy.status !== "draft") throw new PosAccountingError("A política contábil não pode ser ativada neste estado.", 409);
    if (policy.mappings.length < 2 || !policy.mappings.some((item) => item.direction === "debit") || !policy.mappings.some((item) => item.direction === "credit")) throw new PosAccountingError("A política exige mappings explícitos de débito e crédito.", 409);
    if (policy.mappings.some((item) => item.account.status !== "active")) throw new PosAccountingError("Todas as contas mapeadas precisam estar ativas.", 409);
    const mappingHash = hashPosAccountingPolicyMappings(policy.mappings);
    const activated = await tx.posAccountingPolicy.update({ where: { id: policy.id }, data: { status: "active", mappingHash, accountantApprovalRef, homologatedBy, homologatedAt: now } });
    await tx.tenantAuditEvent.create({ data: { actorId: homologatedBy, action: "pos.accounting.policy.activated", entityType: "pos_accounting_policy", entityId: policy.id, correlationId: randomUUID(), beforeData: { status: policy.status, mappingHash: policy.mappingHash }, afterData: { status: activated.status, mappingHash, accountantApprovalRef, version: activated.version } } });
    return { policy: activated, replayed: false };
  });
}

export async function postPosAccountingJournal(db: RootDb, inputValue: PosAccountingJournalRequest) {
  const input = normalizeJournalRequest(inputValue);
  const requestHash = hashPosAccountingPayload(input);
  const existing = await db.posAccountingJournal.findUnique({ where: { idempotencyKey: input.idempotencyKey }, include: { postings: { orderBy: { sequence: "asc" } }, exportOutbox: true } });
  if (existing) return replayJournal(existing, input, requestHash);
  return serializableRetry(db, async (tx) => {
    await tx.$queryRaw(Prisma.sql`SELECT "id" FROM "pos_accounting_periods" WHERE "id" = ${input.periodId} FOR KEY SHARE`);
    await tx.$queryRaw(Prisma.sql`SELECT "id" FROM "pos_accounting_policies" WHERE "id" = ${input.policyId} FOR KEY SHARE`);
    const concurrent = await tx.posAccountingJournal.findUnique({ where: { idempotencyKey: input.idempotencyKey }, include: { postings: { orderBy: { sequence: "asc" } }, exportOutbox: true } });
    if (concurrent) return replayJournal(concurrent, input, requestHash);
    const originReplay = await tx.posAccountingJournal.findUnique({ where: { originType_originId_originVersion: { originType: input.source.sourceType, originId: input.source.sourceId, originVersion: input.source.sourceVersion } }, include: { postings: { orderBy: { sequence: "asc" } }, exportOutbox: true } });
    if (originReplay) return replayJournal(originReplay, input, requestHash);
    const [period, policy, costCenter] = await Promise.all([
      tx.posAccountingPeriod.findFirst({ where: { id: input.periodId, branchId: input.branchId } }),
      tx.posAccountingPolicy.findFirst({ where: { id: input.policyId, branchId: input.branchId }, include: { mappings: { where: { sourceType: input.source.sourceType }, include: { account: true } } } }),
      tx.costCenter.findFirst({ where: { id: input.costCenterId, active: true } }),
    ]);
    if (!period || period.status !== "open" || period.currency !== "BRL") throw new PosAccountingError("Período contábil aberto não encontrado para a filial.", 409);
    const competence = dateOnlyDate(input.source.competenceDate);
    if (competence < period.startsAt || competence > period.endsAt) throw new PosAccountingError("A competência está fora do período contábil.", 409);
    if (!costCenter) throw new PosAccountingError("Centro de custo ativo não encontrado.", 409);
    if (!policy || policy.status !== "active" || policy.currency !== "BRL" || !policy.accountantApprovalRef || !policy.homologatedAt) throw new PosAccountingError("Política contábil ativa e homologada não encontrada.", 409);
    if (competence < policy.effectiveFrom || policy.effectiveUntil && competence > policy.effectiveUntil) throw new PosAccountingError("Política contábil fora da vigência da competência.", 409);
    const allMappings = await tx.posAccountingPolicyMapping.findMany({ where: { policyId: policy.id }, select: { id: true, sourceType: true, entryKey: true, accountId: true, direction: true } });
    if (hashPosAccountingPolicyMappings(allMappings) !== policy.mappingHash) throw new PosAccountingError("Hash da política contábil diverge dos mappings persistidos.", 409);
    const mappings = new Map(policy.mappings.map((item) => [item.entryKey, item]));
    if (policy.mappings.some((item) => item.account.status !== "active")) throw new PosAccountingError("A política referencia conta contábil inativa.", 409);
    const resolved = input.postings.map((posting, index) => {
      const mapping = mappings.get(posting.mappingKey);
      if (!mapping) throw new PosAccountingError(`Mapping contábil ausente: ${posting.mappingKey}.`, 409);
      return { sequence: index + 1, mapping, posting };
    });
    let debitCents = BigInt(0);
    let creditCents = BigInt(0);
    for (const item of resolved) {
      if (item.mapping.direction === "debit") debitCents += BigInt(item.posting.amountCents);
      else creditCents += BigInt(item.posting.amountCents);
    }
    if (debitCents <= BigInt(0) || debitCents !== creditCents) throw new PosAccountingError("Débitos e créditos do journal precisam fechar exatamente.", 409);
    const journalId = randomUUID();
    const sourceSnapshotHash = hashPosAccountingPayload(input.source);
    const journal = await tx.posAccountingJournal.create({ data: {
      id: journalId,
      branchId: input.branchId,
      costCenterId: input.costCenterId,
      periodId: period.id,
      policyId: policy.id,
      policyHash: policy.mappingHash,
      originType: input.source.sourceType,
      originId: input.source.sourceId,
      originVersion: input.source.sourceVersion,
      competenceDate: competence,
      occurredAt: input.occurredAt,
      currency: "BRL",
      description: input.description,
      sourceSnapshot: json(input.source),
      sourceSnapshotHash,
      totalDebitCents: debitCents,
      totalCreditCents: creditCents,
      idempotencyKey: input.idempotencyKey,
      requestHash,
      createdBy: input.createdBy,
      postings: { create: resolved.map(({ sequence, mapping, posting }) => ({
        sequence,
        policyMappingId: mapping.id,
        accountId: mapping.accountId,
        accountCodeSnapshot: mapping.account.code,
        accountNameSnapshot: mapping.account.name,
        direction: mapping.direction,
        amountCents: BigInt(posting.amountCents),
        amount: new Prisma.Decimal(posting.amountCents).div(100),
        description: posting.description,
        dimensions: posting.dimensions ? json(posting.dimensions) : undefined,
      })) },
      exportOutbox: { create: {} },
    }, include: { postings: { orderBy: { sequence: "asc" } }, exportOutbox: true } });
    await tx.tenantAuditEvent.create({ data: { actorId: input.createdBy, action: "pos.accounting.journal.posted", entityType: "pos_accounting_journal", entityId: journal.id, correlationId: randomUUID(), afterData: { originType: journal.originType, originId: journal.originId, originVersion: journal.originVersion, branchId: journal.branchId, costCenterId: journal.costCenterId, periodId: journal.periodId, policyId: journal.policyId, policyHash: journal.policyHash, sourceSnapshotHash, totalDebitCents: debitCents.toString(), totalCreditCents: creditCents.toString() } } });
    return { journal: accountingJournalDto(journal), replayed: false };
  }).catch(async (error) => {
    if (isUniqueOrSerialization(error)) {
      const replay = await db.posAccountingJournal.findFirst({ where: { OR: [{ idempotencyKey: input.idempotencyKey }, { originType: input.source.sourceType, originId: input.source.sourceId, originVersion: input.source.sourceVersion }] }, include: { postings: { orderBy: { sequence: "asc" } }, exportOutbox: true } });
      if (replay) return replayJournal(replay, input, requestHash);
    }
    throw error;
  });
}

export async function reversePosAccountingJournal(db: RootDb, inputValue: PosAccountingReversalRequest) {
  const input = normalizeReversalRequest(inputValue);
  const requestHash = hashPosAccountingPayload(input);
  const replay = await db.posAccountingJournal.findUnique({ where: { idempotencyKey: input.idempotencyKey }, include: { postings: { orderBy: { sequence: "asc" } }, exportOutbox: true } });
  if (replay) return replayReversal(replay, input, requestHash);
  return serializableRetry(db, async (tx) => {
    await tx.$queryRaw(Prisma.sql`SELECT "id" FROM "pos_accounting_journals" WHERE "id" = ${input.originalJournalId} FOR KEY SHARE`);
    const original = await tx.posAccountingJournal.findUnique({ where: { id: input.originalJournalId }, include: { postings: { orderBy: { sequence: "asc" } }, reversal: true } });
    if (!original) throw new PosAccountingError("Journal original não encontrado.", 404);
    if (original.reversalOfId) throw new PosAccountingError("Um journal de reversão não pode ser revertido novamente.", 409);
    if (original.reversal) return replayReversal(await tx.posAccountingJournal.findUniqueOrThrow({ where: { id: original.reversal.id }, include: { postings: { orderBy: { sequence: "asc" } }, exportOutbox: true } }), input, requestHash);
    await tx.$queryRaw(Prisma.sql`SELECT "id" FROM "pos_accounting_periods" WHERE "id" = ${input.periodId} FOR KEY SHARE`);
    const period = await tx.posAccountingPeriod.findFirst({ where: { id: input.periodId, branchId: original.branchId } });
    const competence = dateOnlyDate(input.competenceDate);
    if (!period || period.status !== "open" || competence < period.startsAt || competence > period.endsAt) throw new PosAccountingError("A reversão exige período contábil aberto na competência informada.", 409);
    const reversalFacts = { reversalOfJournalId: original.id, originalOriginType: original.originType, originalOriginId: original.originId, originalOriginVersion: original.originVersion, originalRequestHash: original.requestHash, originalSourceSnapshotHash: original.sourceSnapshotHash, reason: input.reason };
    rejectSensitiveData(reversalFacts);
    const reversalId = randomUUID();
    const reversalSource = { schemaVersion: 1, sourceType: "accounting_reversal" as const, sourceId: original.id, sourceVersion: 1, competenceDate: input.competenceDate, facts: reversalFacts, factsHash: hashPosAccountingPayload(reversalFacts) };
    const sourceSnapshotHash = hashPosAccountingPayload(reversalSource);
    const reversal = await tx.posAccountingJournal.create({ data: {
      id: reversalId,
      branchId: original.branchId,
      costCenterId: original.costCenterId,
      periodId: period.id,
      policyId: original.policyId,
      policyHash: original.policyHash,
      originType: "accounting_reversal",
      originId: original.id,
      originVersion: 1,
      competenceDate: competence,
      occurredAt: input.occurredAt,
      currency: "BRL",
      description: `Reversão: ${original.description}`.slice(0, 300),
      sourceSnapshot: json(reversalSource),
      sourceSnapshotHash,
      totalDebitCents: original.totalCreditCents,
      totalCreditCents: original.totalDebitCents,
      idempotencyKey: input.idempotencyKey,
      requestHash,
      reversalOfId: original.id,
      reversalReason: input.reason,
      createdBy: input.createdBy,
      postings: { create: original.postings.map((posting) => ({ sequence: posting.sequence, policyMappingId: posting.policyMappingId, accountId: posting.accountId, accountCodeSnapshot: posting.accountCodeSnapshot, accountNameSnapshot: posting.accountNameSnapshot, direction: posting.direction === "debit" ? "credit" : "debit", amountCents: posting.amountCents, amount: posting.amount, description: posting.description, dimensions: posting.dimensions ?? undefined })) },
      exportOutbox: { create: {} },
    }, include: { postings: { orderBy: { sequence: "asc" } }, exportOutbox: true } });
    await tx.tenantAuditEvent.create({ data: { actorId: input.createdBy, action: "pos.accounting.journal.reversed", entityType: "pos_accounting_journal", entityId: reversal.id, correlationId: randomUUID(), afterData: { reversalOfId: original.id, periodId: period.id, competenceDate: input.competenceDate, reason: input.reason, totalDebitCents: reversal.totalDebitCents.toString(), totalCreditCents: reversal.totalCreditCents.toString() } } });
    return { journal: accountingJournalDto(reversal), replayed: false };
  }).catch(async (error) => {
    if (isUniqueOrSerialization(error)) {
      const concurrent = await db.posAccountingJournal.findFirst({ where: { OR: [{ idempotencyKey: input.idempotencyKey }, { reversalOfId: input.originalJournalId }] }, include: { postings: { orderBy: { sequence: "asc" } }, exportOutbox: true } });
      if (concurrent) return replayReversal(concurrent, input, requestHash);
    }
    throw error;
  });
}

export async function closePosAccountingPeriod(db: RootDb, input: { periodId: string; closedBy: string; reason: string; idempotencyKey?: string }) {
  const periodId = safeIdentifier(input.periodId, "Período", 8, 160);
  const closedBy = safeActorIdentifier(input.closedBy, "Responsável");
  const reason = safeText(input.reason, "Motivo", 3, 300);
  const idempotencyKey = input.idempotencyKey ? toPosT2BoundaryIdempotencyKey(safeKey(input.idempotencyKey, "Chave idempotente")) : hashPosAccountingPayload({ closedBy, periodId, reason, schemaVersion: 1 });
  return serializableRetry(db, async (tx) => {
    await tx.$queryRaw(Prisma.sql`SELECT "id" FROM "pos_accounting_periods" WHERE "id" = ${periodId} FOR UPDATE`);
    const period = await tx.posAccountingPeriod.findUnique({ where: { id: periodId } });
    if (!period) throw new PosAccountingError("Período contábil não encontrado.", 404);
    if (period.status === "closed") {
      if (period.closedBy !== closedBy || period.closeReason !== reason) throw new PosAccountingError("O período já foi fechado com outro conteúdo.", 409);
      return { period, replayed: true };
    }
    const boundary = await closePosT2AccountingPeriodBoundary(tx, { periodId, expectedRevision: period.revision, expectedConfigHash: period.configHash, closedBy, reason, idempotencyKey });
    const closed = await tx.posAccountingPeriod.findUniqueOrThrow({ where: { id: boundary.periodId } });
    await tx.tenantAuditEvent.create({ data: { actorId: closedBy, action: "pos.accounting.period.closed", entityType: "pos_accounting_period", entityId: period.id, correlationId: randomUUID(), beforeData: { status: period.status }, afterData: { status: closed.status, closedAt: closed.closedAt, reason, operationId: boundary.operationId } } });
    return { period: closed, replayed: boundary.replayed };
  });
}

export async function createPosAccountingPeriod(db: RootDb, input: { branchId: number; year: number; month: number; startsOn: string; endsOn: string; currency?: "BRL"; actorUserId: string; idempotencyKey: string }) {
  const branchId = integer(input.branchId, "Filial", 1, 2_147_483_647);
  const year = integer(input.year, "Ano", 2000, 2200);
  const month = integer(input.month, "Mês", 1, 12);
  const startsOn = dateOnly(input.startsOn, "Início do período");
  const endsOn = dateOnly(input.endsOn, "Fim do período");
  const actorUserId = safeActorIdentifier(input.actorUserId, "Responsável");
  const idempotencyKey = toPosT2BoundaryIdempotencyKey(safeKey(input.idempotencyKey, "Chave idempotente"));
  if ((input.currency ?? "BRL") !== "BRL") throw new PosAccountingError("Período contábil exige moeda BRL.", 400);
  return serializableRetry(db, async tx => {
    const boundary = await putPosT2AccountingPeriodBoundary(tx, { branchId, year, month, startsOn, endsOn, currency: "BRL", actorUserId, idempotencyKey });
    const period = await tx.posAccountingPeriod.findUniqueOrThrow({ where: { id: boundary.periodId } });
    if (!boundary.replayed) await tx.tenantAuditEvent.create({ data: { actorId: actorUserId, action: "pos.accounting.period.created", entityType: "pos_accounting_period", entityId: period.id, correlationId: randomUUID(), afterData: { branchId, year, month, startsOn, endsOn, currency: "BRL", operationId: boundary.operationId } } });
    return { period, replayed: boundary.replayed };
  });
}

function normalizeJournalRequest(input: PosAccountingJournalRequest): PosAccountingJournalRequest {
  if (!input || typeof input !== "object") throw new PosAccountingError("Journal contábil inválido.", 400);
  const source = buildPosAccountingSourceSnapshot(input.source);
  if (source.factsHash !== input.source.factsHash) throw new PosAccountingError("Snapshot da origem diverge do hash informado.", 409);
  if (!Array.isArray(input.postings) || input.postings.length < 2 || input.postings.length > 100) throw new PosAccountingError("Journal exige de 2 a 100 postings.", 400);
  const seen = new Set<string>();
  const postings = input.postings.map((posting) => {
    const mappingKey = entryKey(posting.mappingKey);
    if (seen.has(mappingKey)) throw new PosAccountingError("Cada mapping pode aparecer uma única vez no journal; agregue o valor antes de postar.", 400);
    seen.add(mappingKey);
    if (posting.dimensions) rejectSensitiveData(posting.dimensions);
    return { mappingKey, amountCents: integer(posting.amountCents, "Valor do posting", 1, Number.MAX_SAFE_INTEGER), description: posting.description == null ? null : safeText(posting.description, "Descrição do posting", 1, 300), dimensions: posting.dimensions ? canonicalClone(posting.dimensions) as Record<string, unknown> : null };
  });
  return { branchId: integer(input.branchId, "Filial", 1, 2_147_483_647), costCenterId: integer(input.costCenterId, "Centro de custo", 1, 2_147_483_647), periodId: safeIdentifier(input.periodId, "Período", 8, 160), policyId: safeIdentifier(input.policyId, "Política", 8, 160), occurredAt: validDate(input.occurredAt), currency: input.currency === "BRL" ? "BRL" : invalidCurrency(), description: safeText(input.description, "Descrição", 1, 300), source, postings, idempotencyKey: safeKey(input.idempotencyKey, "Chave idempotente"), createdBy: safeActorIdentifier(input.createdBy, "Ator") };
}

function normalizeReversalRequest(input: PosAccountingReversalRequest): PosAccountingReversalRequest {
  return { originalJournalId: safeIdentifier(input.originalJournalId, "Journal original", 8, 160), periodId: safeIdentifier(input.periodId, "Período", 8, 160), competenceDate: dateOnly(input.competenceDate, "Competência"), occurredAt: validDate(input.occurredAt), reason: safeText(input.reason, "Motivo", 3, 300), idempotencyKey: safeKey(input.idempotencyKey, "Chave idempotente"), createdBy: safeActorIdentifier(input.createdBy, "Ator") };
}

function replayJournal(journal: Prisma.PosAccountingJournalGetPayload<{ include: { postings: true; exportOutbox: true } }>, input: PosAccountingJournalRequest, requestHash: string) {
  if (journal.requestHash !== requestHash || journal.branchId !== input.branchId || journal.originType !== input.source.sourceType || journal.originId !== input.source.sourceId || journal.originVersion !== input.source.sourceVersion) throw new PosAccountingError("Idempotência/origem contábil já usada com outro conteúdo.", 409);
  return { journal: accountingJournalDto(journal), replayed: true };
}

function replayReversal(journal: Prisma.PosAccountingJournalGetPayload<{ include: { postings: true; exportOutbox: true } }>, input: PosAccountingReversalRequest, requestHash: string) {
  if (journal.requestHash !== requestHash || journal.originType !== "accounting_reversal" || journal.reversalOfId !== input.originalJournalId) throw new PosAccountingError("A reversão já existe com outro conteúdo.", 409);
  return { journal: accountingJournalDto(journal), replayed: true };
}

function accountingJournalDto(journal: Prisma.PosAccountingJournalGetPayload<{ include: { postings: true; exportOutbox: true } }>) {
  return { id: journal.id, branchId: journal.branchId, costCenterId: journal.costCenterId, periodId: journal.periodId, policyId: journal.policyId, policyHash: journal.policyHash, originType: journal.originType, originId: journal.originId, originVersion: journal.originVersion, competenceDate: journal.competenceDate, occurredAt: journal.occurredAt, postedAt: journal.postedAt, currency: journal.currency, description: journal.description, sourceSnapshotHash: journal.sourceSnapshotHash, totalDebitCents: journal.totalDebitCents.toString(), totalCreditCents: journal.totalCreditCents.toString(), reversalOfId: journal.reversalOfId, reversalReason: journal.reversalReason, createdBy: journal.createdBy, createdAt: journal.createdAt, postings: journal.postings.map((posting) => ({ id: posting.id.toString(), sequence: posting.sequence, policyMappingId: posting.policyMappingId, accountId: posting.accountId, accountCode: posting.accountCodeSnapshot, accountName: posting.accountNameSnapshot, direction: posting.direction, amountCents: posting.amountCents.toString(), amount: posting.amount.toFixed(2), description: posting.description, dimensions: posting.dimensions })), export: journal.exportOutbox ? { id: journal.exportOutbox.id.toString(), state: journal.exportOutbox.state, deliveryCount: journal.exportOutbox.deliveryCount, exportedAt: journal.exportOutbox.exportedAt } : null };
}

function invalidCurrency(): never { throw new PosAccountingError("Somente BRL é aceito no subledger POS.", 400); }
function isUniqueOrSerialization(error: unknown) { const code = error && typeof error === "object" && "code" in error ? String((error as { code?: unknown }).code || "") : ""; return ["P2002", "P2034", "40001", "40P01"].includes(code); }
async function serializableRetry<T>(db: RootDb, operation: (tx: Prisma.TransactionClient) => Promise<T>) { for (let attempt = 1; attempt <= 3; attempt += 1) { try { return await db.$transaction(operation, { isolationLevel: "Serializable", maxWait: 10_000, timeout: 30_000 }); } catch (error) { if (!isUniqueOrSerialization(error) || attempt === 3 || (error as { code?: string }).code === "P2002") throw error; } } throw new PosAccountingError("Conflito de serialização contábil.", 409); }
function json(value: unknown): Prisma.InputJsonValue { return value as Prisma.InputJsonValue; }
function integer(value: unknown, label: string, minimum: number, maximum: number) { const result = Number(value); if (!Number.isSafeInteger(result) || result < minimum || result > maximum) throw new PosAccountingError(`${label} inválido.`, 400); return result; }
function safeIdentifier(value: unknown, label: string, minimum: number, maximum: number) { const result = String(value ?? "").normalize("NFKC").trim(); if (result.length < minimum || result.length > maximum || !/^[A-Za-z0-9._:-]+$/.test(result) || containsPosPaymentPanInIdentifier(result)) throw new PosAccountingError(`${label} inválido.`, 400); rejectPiiText(result); return result; }
function safeActorIdentifier(value: unknown, label: string) { const result = safeIdentifier(value, label, 1, 160); rejectPiiText(result); return result; }
function safeKey(value: unknown, label: string) { return safeIdentifier(value, label, 16, 160); }
function entryKey(value: unknown) { const result = String(value ?? "").normalize("NFKC").trim(); if (result.length < 1 || result.length > 120 || !/^[a-z][a-z0-9._-]*$/.test(result)) throw new PosAccountingError("Mapping contábil inválido.", 400); return result; }
function safeText(value: unknown, label: string, minimum: number, maximum: number) { const result = String(value ?? "").normalize("NFKC").trim(); if (result.length < minimum || result.length > maximum || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(result) || containsPosPaymentPanInIdentifier(result)) throw new PosAccountingError(`${label} inválido.`, 400); rejectPiiText(result); return result; }
function sha256(value: unknown, label: string) { const result = String(value ?? "").toLowerCase(); if (!/^[0-9a-f]{64}$/.test(result)) throw new PosAccountingError(`${label} inválido.`, 400); return result; }
function validDate(value: Date) { if (!(value instanceof Date) || !Number.isFinite(value.valueOf())) throw new PosAccountingError("Data inválida.", 400); return new Date(value); }
function dateOnly(value: unknown, label: string) { const result = String(value ?? ""); if (!/^\d{4}-\d{2}-\d{2}$/.test(result) || dateOnlyDate(result).toISOString().slice(0, 10) !== result) throw new PosAccountingError(`${label} inválida.`, 400); return result; }
function dateOnlyDate(value: string) { return new Date(`${value}T00:00:00.000Z`); }
function rejectSensitiveData(value: unknown, depth = 0, fieldName = ""): void {
  if (depth > 8) throw new PosAccountingError("Snapshot contábil excede a profundidade permitida.", 400);
  if (value === undefined || typeof value === "function" || typeof value === "symbol" || typeof value === "bigint" || typeof value === "number" && !Number.isFinite(value)) throw new PosAccountingError("Snapshot contábil deve conter somente JSON finito.", 400);
  if (typeof value === "string") {
    if (value.length > 2_000) throw new PosAccountingError("Campo textual do snapshot contábil excede o limite.", 400);
    if (/(?:reference|transaction|authorization|nsu|evidence|failure|id|key)/i.test(fieldName) && containsPosPaymentPanInIdentifier(value)) throw new PosAccountingError("Snapshot contábil contém dado de cartão proibido.", 400);
    rejectPiiText(value);
  }
  if (Array.isArray(value)) {
    if (value.length > 500) throw new PosAccountingError("Snapshot contábil excede o limite.", 400);
    for (const item of value) rejectSensitiveData(item, depth + 1, fieldName);
    return;
  }
  if (!value || typeof value !== "object") return;
  if (Object.getPrototypeOf(value) !== Object.prototype) throw new PosAccountingError("Snapshot contábil aceita somente objetos JSON simples.", 400);
  const entries = Object.entries(value as Record<string, unknown>);
  if (entries.length > 500) throw new PosAccountingError("Snapshot contábil excede o limite.", 400);
  for (const [field, item] of entries) {
    const normalized = field.normalize("NFKC").toLowerCase().replace(/[^a-z0-9]/g, "");
    if (["pan", "cvv", "cvc", "track", "track1", "track2", "pinblock", "cardnumber", "numerocartao", "fullcard", "cpf", "email", "phone", "telephone", "mobile", "address", "street", "zip", "zipcode", "name", "customer", "customerid", "customername", "consumer", "buyer", "recipient", "documentnumber", "taxpayerid"].includes(normalized)) throw new PosAccountingError("Snapshot contábil contém PII ou dado sensível proibido.", 400);
    rejectSensitiveData(item, depth + 1, field);
  }
}
function rejectPiiText(value: string): void {
  const normalized = value.normalize("NFKC");
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(normalized)) return;
  if (/[^\s@]+@[^\s@]+\.[^\s@]+/.test(normalized)
    || /(?:^|[\s,;([{])(?:cpf|e-?mail|telefone|celular|phone|nome(?:\s+do\s+cliente)?|cliente|customer|buyer|recipient|destinat[aá]rio|endere[cç]o|logradouro|cep)\s*(?::|=|-)\s*\S/iu.test(normalized)
    || /\b(?:rua|avenida|travessa|alameda)\s+[A-Za-zÀ-ÿ]/iu.test(normalized)
    || /(?:\+?55\s*)?\(?\d{2}\)?[\s.-]+9?\d{4}[-.\s]+\d{4}/.test(normalized)
    || containsValidCpf(normalized)) {
    throw new PosAccountingError("Subledger contábil não aceita PII em texto livre ou identificadores de ator.", 400);
  }
}
function containsValidCpf(value: string): boolean {
  const candidates = value.match(/(?:^|\D)(\d{3}\.?\d{3}\.?\d{3}-?\d{2})(?!\d)/g) ?? [];
  return candidates.some((candidate) => {
    const digits = candidate.replace(/\D/g, "");
    if (digits.length !== 11 || /^(\d)\1{10}$/.test(digits)) return false;
    const check = (length: number) => {
      let sum = 0;
      for (let index = 0; index < length; index += 1) sum += Number(digits[index]) * (length + 1 - index);
      const remainder = sum % 11;
      return remainder < 2 ? 0 : 11 - remainder;
    };
    return check(9) === Number(digits[9]) && check(10) === Number(digits[10]);
  });
}
function canonicalClone(value: unknown): unknown { rejectSensitiveData(value); return JSON.parse(canonicalJson(value)); }
function canonicalJson(value: unknown): string {
  if (value === null || typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "number") { if (!Number.isFinite(value)) throw new PosAccountingError("Valor não finito no payload contábil.", 400); return JSON.stringify(value); }
  if (value instanceof Date) { if (!Number.isFinite(value.valueOf())) throw new PosAccountingError("Data inválida no payload contábil.", 400); return JSON.stringify(value.toISOString()); }
  if (typeof value === "bigint") return JSON.stringify(value.toString());
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (!value || typeof value !== "object" || Object.getPrototypeOf(value) !== Object.prototype) throw new PosAccountingError("Payload contábil não é JSON canônico.", 400);
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) => { if (record[key] === undefined) throw new PosAccountingError("Payload contábil contém valor indefinido.", 400); return `${JSON.stringify(key)}:${canonicalJson(record[key])}`; }).join(",")}}`;
}
