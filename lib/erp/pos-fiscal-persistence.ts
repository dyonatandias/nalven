import { createHash, randomUUID } from "node:crypto";
import { Prisma, type PrismaClient } from "@/generated/tenant/client";
import {
  canonicalPosJson,
  fiscalSnapshotDigest,
  validateFiscalResult,
  validateFiscalSaleSnapshot,
  type PosFiscalResult,
  type PosFiscalSaleSnapshot,
} from "@/lib/erp/pos-connectors";
import { isValidGtin, PosDomainError } from "@/lib/erp/pos-domain";

export const POS_FISCAL_SALE_COMMIT_MODES = ["disabled", "queue"] as const;
export const POS_FISCAL_PRODUCT_FIELDS = ["ncm", "cest", "origin", "gtin", "gtinTributary", "cfop", "csosn", "cst"] as const;

type FiscalCommitMode = typeof POS_FISCAL_SALE_COMMIT_MODES[number];
type FiscalProductField = typeof POS_FISCAL_PRODUCT_FIELDS[number];
type RootDb = PrismaClient;

export type PosFiscalQueueResult =
  | { state: "not_configured" | "not_effective" | "disabled"; documentId: null; profileId: string | null }
  | { state: "queued" | "replayed"; documentId: string; profileId: string };

export type PosFiscalWorkerArtifact = {
  type: "authorized_xml" | "contingency_xml" | "authorization_protocol" | "cancellation_protocol" | "danfe" | "qr" | "provider_response_redacted";
  providerArtifactId: string | null;
  storageKey: string;
  mimeType: "application/xml" | "text/xml" | "application/pdf" | "application/json" | "text/plain" | "image/png";
  sizeBytes: number;
  sha256: string;
  encryptionKeyId: string | null;
  retentionUntil: Date | null;
};

export type PosFiscalOutboxCompletion = {
  attemptId: string;
  claimToken: string;
  result:
    | {
        kind: "result";
        provider: string;
        reference: string;
        state: "processing" | "authorized" | "rejected" | "contingency" | "cancelled" | "unknown";
        accessKey: string | null;
        protocol: string | null;
        rejectionCode: string | null;
        rejectionMessage: string | null;
        providerSequence: bigint | null;
        occurredAt: Date;
        totalCents: number;
        currency: "BRL";
        artifacts: readonly PosFiscalWorkerArtifact[];
      }
    | { kind: "unknown"; failureCode: string; failureMessage: string | null }
    | { kind: "known_failure"; retryable: boolean; failureCode: string; failureMessage: string | null };
};

type PosFiscalProviderResult = Extract<PosFiscalOutboxCompletion["result"], { kind: "result" }>;

export type PosFiscalCallbackInput = Omit<PosFiscalProviderResult, "kind"> & { documentId: string };

export const POS_FISCAL_WORK_LIMITS = Object.freeze({
  defaultBatchSize: 25,
  maximumBatchSize: 100,
  defaultLeaseSeconds: 60,
  maximumLeaseSeconds: 300,
  serializationRetries: 3,
});

export class PosFiscalPersistenceError extends PosDomainError {
  constructor(message: string, public readonly status = 422) {
    super(message);
    this.name = "PosFiscalPersistenceError";
  }
}

type QueueContext = {
  saleId: number;
  branchId: number;
  registerId: number;
  sessionId: number;
  operatorProfileId: number;
  actorUserId: string;
  actorName: string;
  correlationId: string;
  terminalId?: string | null;
  now?: Date;
};

type FiscalPolicy = {
  saleCommitMode: FiscalCommitMode;
  requiredProductFields: readonly FiscalProductField[];
  defaultCfop: string;
  defaultCsosn: string | null;
  defaultCst: string | null;
};

type FiscalSaleInput = {
  id: number;
  saleNumber: string;
  branchId: number | null;
  sessionId: number | null;
  operatorProfileId: number | null;
  status: string;
  totalCents: number;
  createdAt: Date;
  customerRecord: { document: string } | null;
  items: Array<{
    productId: number;
    productName: string;
    gtinSnapshot: string | null;
    unit: string;
    quantity: number;
    unitPriceCents: number;
    discountCents: number;
    surchargeCents: number;
    totalCents: number;
    product: {
      fiscalType: string;
      ncm: string | null;
      cest: string | null;
      cestNotApplicable: boolean;
      origin: string | null;
      csosn: string | null;
      gtinTributary: string | null;
      taxStatus: string;
      taxClass: string | null;
    };
  }>;
  payments: Array<{ method: string; amountCents: number }>;
};

type FiscalProfileInput = {
  id: string;
  version: number;
  branchId: number;
  connectorId: string;
  credentialRef: string;
  documentModel: string;
  environment: string;
  provider: string;
  numberingOwner: string;
  series: number | null;
  taxRegime: string;
  schemaVersion: string;
  policySnapshot: Prisma.JsonValue;
  policyDigest: string;
};

/**
 * Creates the immutable fiscal snapshot, first attempt and outbox entry inside
 * the caller's sale transaction. It never invokes a provider and therefore
 * cannot turn local preparation into a fabricated authorization.
 */
export async function queuePosFiscalIssuanceForSale(
  tx: Prisma.TransactionClient,
  context: QueueContext,
): Promise<PosFiscalQueueResult> {
  const now = context.now ?? new Date();
  const branch = await tx.branch.findUnique({
    where: { id: context.branchId },
    select: { id: true, settings: { select: { fiscalEnvironment: true } } },
  });
  if (!branch) throw new PosFiscalPersistenceError("Filial da venda fiscal não encontrada.", 404);

  const activeProfiles = await tx.posFiscalProfileVersion.findMany({
    where: {
      branchId: context.branchId,
      documentModel: "nfce",
      status: "active",
    },
    orderBy: [{ version: "desc" }, { createdAt: "desc" }],
  });
  if (!activeProfiles.length) return { state: "not_configured", documentId: null, profileId: null };

  const environment = branch.settings?.fiscalEnvironment;
  const environmentProfiles = environment
    ? activeProfiles.filter((profile) => profile.environment === environment)
    : activeProfiles;
  if (!environmentProfiles.length) {
    throw new PosFiscalPersistenceError(`O ambiente fiscal da filial (${environment}) não possui perfil NFC-e ativo.`, 409);
  }
  const profile = environmentProfiles.find((candidate) =>
    candidate.effectiveFrom != null
    && candidate.effectiveFrom <= now
    && (candidate.effectiveUntil == null || candidate.effectiveUntil > now));
  if (!profile) return { state: "not_effective", documentId: null, profileId: environmentProfiles[0].id };
  if (profile.environment !== "homologation") {
    throw new PosFiscalPersistenceError("Emissão fiscal de produção permanece bloqueada até homologação externa explícita.", 409);
  }

  const policy = parseFiscalPolicy(profile);
  if (policy.saleCommitMode !== "queue") return { state: "disabled", documentId: null, profileId: profile.id };

  const [connector, credential] = await Promise.all([
    tx.posConnector.findFirst({
      where: {
        id: profile.connectorId,
        branchId: context.branchId,
        provider: profile.provider,
        credentialRef: profile.credentialRef,
        status: "active",
        type: { startsWith: "fiscal" },
        OR: [{ registerId: null }, { registerId: context.registerId }],
      },
      select: { id: true },
    }),
    tx.integrationCredential.findFirst({
      where: {
        id: profile.credentialRef,
        providerId: profile.provider,
        enabled: true,
        provider: { family: "fiscal" },
      },
      select: { id: true },
    }),
  ]);
  if (!connector || !credential) throw new PosFiscalPersistenceError("Perfil fiscal ativo perdeu o conector ou a credencial vigentes.", 409);

  if (context.terminalId) {
    const terminal = await tx.posTerminal.findFirst({
      where: { id: context.terminalId, registerId: context.registerId, status: { not: "revoked" } },
      select: { id: true },
    });
    if (!terminal) throw new PosFiscalPersistenceError("Terminal fiscal não pertence ao caixa ou foi revogado.", 409);
  }

  const sale = await tx.sale.findFirst({
    where: {
      id: context.saleId,
      branchId: context.branchId,
      sessionId: context.sessionId,
      operatorProfileId: context.operatorProfileId,
      status: "completed",
    },
    select: {
      id: true,
      saleNumber: true,
      branchId: true,
      sessionId: true,
      operatorProfileId: true,
      status: true,
      totalCents: true,
      createdAt: true,
      customerRecord: { select: { document: true } },
      items: {
        orderBy: { id: "asc" },
        select: {
          productId: true,
          productName: true,
          gtinSnapshot: true,
          unit: true,
          quantity: true,
          unitPriceCents: true,
          discountCents: true,
          surchargeCents: true,
          totalCents: true,
          product: {
            select: {
              fiscalType: true,
              ncm: true,
              cest: true,
              cestNotApplicable: true,
              origin: true,
              csosn: true,
              gtinTributary: true,
              taxStatus: true,
              taxClass: true,
            },
          },
        },
      },
      payments: {
        where: { type: "payment" },
        orderBy: { createdAt: "asc" },
        select: { method: true, amountCents: true },
      },
    },
  });
  if (!sale) throw new PosFiscalPersistenceError("Venda concluída não encontrada no contexto fiscal autoritativo.", 404);

  const snapshot = buildPosFiscalSaleSnapshot(sale, profile, policy);
  const snapshotHash = fiscalSnapshotDigest(snapshot);
  const idempotencyKey = `pos-fiscal:${sale.id}:nfce:issue:1`;
  const requestHash = sha256(canonicalPosJson({
    idempotencyKey,
    snapshotHash,
    profileId: profile.id,
    profileVersion: profile.version,
    connectorId: profile.connectorId,
    credentialRef: profile.credentialRef,
    provider: profile.provider,
  }));

  const replay = await tx.posFiscalDocument.findUnique({
    where: { saleId_documentModel_purpose_revision: { saleId: sale.id, documentModel: "nfce", purpose: "issue", revision: 1 } },
    select: { id: true, profileId: true, requestHash: true, snapshotHash: true },
  });
  if (replay) {
    if (replay.profileId !== profile.id || replay.requestHash !== requestHash || replay.snapshotHash !== snapshotHash) {
      throw new PosFiscalPersistenceError("A venda já possui preparação fiscal com contexto divergente.", 409);
    }
    return { state: "replayed", documentId: replay.id, profileId: replay.profileId };
  }

  const documentId = randomUUID();
  const attemptId = randomUUID();
  const storedSnapshot = JSON.parse(canonicalPosJson(snapshot)) as Prisma.InputJsonObject;
  await tx.posFiscalDocument.create({
    data: {
      id: documentId,
      saleId: sale.id,
      branchId: context.branchId,
      registerId: context.registerId,
      sessionId: context.sessionId,
      operatorProfileId: context.operatorProfileId,
      terminalId: context.terminalId ?? null,
      connectorId: profile.connectorId,
      credentialRef: profile.credentialRef,
      profileId: profile.id,
      profileVersion: profile.version,
      purpose: "issue",
      revision: 1,
      status: "queued",
      version: 0,
      documentModel: "nfce",
      environment: profile.environment,
      provider: profile.provider,
      numberingOwner: profile.numberingOwner,
      series: profile.numberingOwner === "local" ? profile.series : null,
      currency: "BRL",
      totalCents: sale.totalCents,
      saleSnapshot: storedSnapshot,
      snapshotHash,
      idempotencyKey,
      requestHash,
      nextReconcileAt: now,
      attempts: {
        create: {
          id: attemptId,
          sequence: 1,
          operation: "issue",
          state: "queued",
          operationKey: `${idempotencyKey}:attempt:1`,
          requestHash,
          providerIdempotencyKey: `${idempotencyKey}:provider:1`,
          outbox: { create: { nextAttemptAt: now } },
        },
      },
      stateEvents: {
        create: {
          eventKey: `pos-fiscal:${documentId}:queued:0`,
          source: "sale_commit",
          sourceId: String(sale.id),
          fromState: null,
          toState: "queued",
          resultingVersion: 0,
          evidenceHash: snapshotHash,
        },
      },
    },
  });
  await tx.tenantAuditEvent.create({
    data: {
      actorId: context.actorUserId,
      action: "pos.fiscal.document.queued",
      entityType: "pos_fiscal_document",
      entityId: documentId,
      correlationId: context.correlationId,
      afterData: {
        saleId: sale.id,
        branchId: context.branchId,
        registerId: context.registerId,
        sessionId: context.sessionId,
        operatorProfileId: context.operatorProfileId,
        terminalId: context.terminalId ?? null,
        profileId: profile.id,
        profileVersion: profile.version,
        provider: profile.provider,
        environment: profile.environment,
        documentModel: profile.documentModel,
        schemaVersion: profile.schemaVersion,
        totalCents: sale.totalCents,
        snapshotHash,
        requestHash,
        actorName: context.actorName,
      },
    },
  });
  return { state: "queued", documentId, profileId: profile.id };
}

export async function claimPosFiscalOutbox(
  db: RootDb,
  options: { workerId: string; limit?: number; leaseSeconds?: number; now?: Date },
) {
  const workerId = boundedIdentifier(options.workerId, "Worker", 3, 120);
  const limit = boundedInteger(options.limit ?? POS_FISCAL_WORK_LIMITS.defaultBatchSize, 1, POS_FISCAL_WORK_LIMITS.maximumBatchSize, "Lote");
  const leaseSeconds = boundedInteger(options.leaseSeconds ?? POS_FISCAL_WORK_LIMITS.defaultLeaseSeconds, 15, POS_FISCAL_WORK_LIMITS.maximumLeaseSeconds, "Lease");
  const now = validDate(options.now ?? new Date(), "Data do claim");
  return serializableFiscalRetry(db, async (tx) => {
    const rows = await tx.$queryRaw<Array<{ documentId: string; attemptId: string; outboxId: bigint }>>(Prisma.sql`
      SELECT d."id" AS "documentId", a."id" AS "attemptId", o."id" AS "outboxId"
        FROM "pos_fiscal_outbox" o
        JOIN "pos_fiscal_attempts" a ON a."id" = o."attempt_id"
        JOIN "pos_fiscal_documents" d ON d."id" = a."document_id"
       WHERE o."state" IN ('pending', 'retry')
         AND o."next_attempt_at" <= ${now}
         AND a."state" IN ('queued', 'retry')
         AND (
           (a."operation" = 'issue' AND d."status" = 'queued')
           OR (a."operation" = 'query' AND d."status" IN ('processing', 'unknown', 'contingency_pending', 'contingency', 'cancellation_pending'))
           OR (a."operation" = 'contingency' AND d."status" = 'contingency_pending')
           OR (a."operation" = 'cancel' AND d."status" = 'cancellation_pending')
         )
       ORDER BY o."next_attempt_at", o."id"
       LIMIT ${limit}
       FOR UPDATE OF d SKIP LOCKED
    `);
    const claimed: Array<ReturnType<typeof fiscalOutboxCommand>> = [];
    for (const row of rows) {
      const graph = await lockFiscalGraph(tx, row.attemptId);
      const outbox = graph.outbox;
      if (!outbox || !["pending", "retry"].includes(outbox.state) || outbox.nextAttemptAt > now || !["queued", "retry"].includes(graph.state) || !fiscalOperationEligible(graph.operation, graph.document.status)) continue;
      const deliveryCount = outbox.deliveryCount + 1;
      if (deliveryCount > outbox.maxDeliveries) continue;
      const claimToken = `${workerId}:${randomUUID()}`;
      const claimExpiresAt = new Date(now.valueOf() + leaseSeconds * 1_000);
      await tx.posFiscalAttempt.update({
        where: { id: graph.id },
        data: { state: "claimed", dispatchCount: { increment: 1 }, startedAt: now, failureCode: null },
      });
      await tx.posFiscalOutbox.update({
        where: { id: outbox.id },
        data: { state: "claimed", deliveryCount, claimToken, claimExpiresAt, lastErrorCode: null },
      });
      claimed.push(fiscalOutboxCommand(graph, claimToken, claimExpiresAt));
    }
    return { workerId, claimed, claimedCount: claimed.length };
  });
}

export async function completePosFiscalOutbox(
  db: RootDb,
  input: PosFiscalOutboxCompletion,
  nowValue = new Date(),
) {
  validateFiscalCompletionInput(input);
  const now = validDate(nowValue, "Data de conclusão");
  const responseHash = hashFiscalPayload(input.result);
  const claimTokenHash = hashFiscalPayload(input.claimToken);
  return serializableFiscalRetry(db, async (tx) => {
    const attempt = await lockFiscalGraph(tx, input.attemptId);
    const outbox = attempt.outbox;
    if (!outbox) throw new PosFiscalPersistenceError("Tentativa fiscal do worker sem outbox.", 409);
    const replay = await tx.posFiscalDeliveryResult.findUnique({ where: { claimTokenHash } });
    if (replay) {
      if (replay.attemptId !== input.attemptId || replay.responseHash !== responseHash) throw new PosFiscalPersistenceError("O claim fiscal já foi concluído com outro conteúdo.", 409);
      return fiscalCompletionDto(attempt.document, attempt, replay.retryScheduled, replay.superseded, true, replay.deliveryNumber);
    }
    if (["succeeded", "unknown", "failed", "dead"].includes(attempt.state)) {
      if (attempt.responseHash !== responseHash) throw new PosFiscalPersistenceError("A tentativa fiscal já foi concluída com outro conteúdo.", 409);
      return fiscalCompletionDto(attempt.document, attempt, false, false, true, outbox.deliveryCount);
    }
    if (attempt.state !== "claimed" || outbox.state !== "claimed" || outbox.claimToken !== input.claimToken || !outbox.claimExpiresAt || outbox.claimExpiresAt <= now) {
      throw new PosFiscalPersistenceError("O claim fiscal expirou ou pertence a outro worker.", 409);
    }
    if (!fiscalOperationEligible(attempt.operation, attempt.document.status)) {
      await tx.posFiscalAttempt.update({ where: { id: attempt.id }, data: { state: "failed", responseHash, failureCode: "document_state_advanced", finishedAt: now } });
      await tx.posFiscalOutbox.update({ where: { id: outbox.id }, data: { state: "completed", claimToken: null, claimExpiresAt: null, completedAt: now, lastErrorCode: "document_state_advanced" } });
      await recordFiscalDelivery(tx, attempt, input, claimTokenHash, responseHash, { retryScheduled: false, superseded: true, attemptState: "failed", document: attempt.document });
      return fiscalCompletionDto(attempt.document, { ...attempt, state: "failed", failureCode: "document_state_advanced", finishedAt: now }, false, true, false, outbox.deliveryCount);
    }
    if (input.result.kind === "known_failure") {
      const retryScheduled = input.result.retryable && outbox.deliveryCount < outbox.maxDeliveries;
      if (retryScheduled) {
        await tx.posFiscalAttempt.update({ where: { id: attempt.id }, data: { state: "retry", failureCode: input.result.failureCode, startedAt: null } });
        await tx.posFiscalOutbox.update({ where: { id: outbox.id }, data: { state: "retry", claimToken: null, claimExpiresAt: null, nextAttemptAt: new Date(now.valueOf() + fiscalRetryDelayMs(outbox.deliveryCount)), lastErrorCode: input.result.failureCode } });
        await recordFiscalDelivery(tx, attempt, input, claimTokenHash, responseHash, { retryScheduled: true, superseded: false, attemptState: "retry", document: attempt.document });
        return fiscalCompletionDto(attempt.document, { ...attempt, state: "retry", failureCode: input.result.failureCode }, true, false, false, outbox.deliveryCount);
      }
      await tx.posFiscalAttempt.update({ where: { id: attempt.id }, data: { state: "failed", responseHash, failureCode: input.result.failureCode, finishedAt: now } });
      await tx.posFiscalOutbox.update({ where: { id: outbox.id }, data: { state: "dead", claimToken: null, claimExpiresAt: null, completedAt: now, lastErrorCode: input.result.failureCode } });
      const document = await transitionFiscalDocument(tx, attempt, {
        status: attempt.document.status === "cancellation_pending" ? "manual_review" : "technical_error",
        failureCode: input.result.failureCode,
        evidenceHash: responseHash,
        now,
      });
      await recordFiscalDelivery(tx, attempt, input, claimTokenHash, responseHash, { retryScheduled: false, superseded: false, attemptState: "failed", document });
      return fiscalCompletionDto(document, { ...attempt, state: "failed", failureCode: input.result.failureCode, finishedAt: now }, false, false, false, outbox.deliveryCount);
    }
    if (input.result.kind === "unknown") {
      await tx.posFiscalAttempt.update({ where: { id: attempt.id }, data: { state: "unknown", outcomeUnknown: true, responseHash, failureCode: input.result.failureCode, finishedAt: now } });
      await tx.posFiscalOutbox.update({ where: { id: outbox.id }, data: { state: "completed", claimToken: null, claimExpiresAt: null, completedAt: now, lastErrorCode: input.result.failureCode } });
      const document = await transitionFiscalDocument(tx, attempt, { status: attempt.operation === "cancel" ? "cancellation_pending" : "unknown", failureCode: input.result.failureCode, evidenceHash: responseHash, now });
      await recordFiscalDelivery(tx, attempt, input, claimTokenHash, responseHash, { retryScheduled: false, superseded: false, attemptState: "unknown", document });
      return fiscalCompletionDto(document, { ...attempt, state: "unknown", outcomeUnknown: true, failureCode: input.result.failureCode, finishedAt: now }, false, false, false, outbox.deliveryCount);
    }

    let observation: ReturnType<typeof validateFiscalWorkerResult>;
    try {
      input.result.artifacts.forEach(validateFiscalArtifactMetadata);
      observation = validateFiscalWorkerResult(attempt, input.result);
    } catch (error) {
      const failureCode = "boundary_context_mismatch";
      await tx.posFiscalAttempt.update({ where: { id: attempt.id }, data: { state: "failed", responseHash, failureCode, finishedAt: now } });
      await tx.posFiscalOutbox.update({ where: { id: outbox.id }, data: { state: "completed", claimToken: null, claimExpiresAt: null, completedAt: now, lastErrorCode: failureCode } });
      let document: Prisma.PosFiscalDocumentGetPayload<object> = attempt.document;
      if (!["cancellation_pending", "contingency", "manual_review"].includes(document.status)) {
        document = await transitionFiscalDocumentRecord(tx, document, {
          status: "technical_error",
          evidenceHash: responseHash,
          now,
          source: "worker",
          sourceId: attempt.id,
          eventKey: `pos-fiscal-worker-mismatch:${attempt.id}:technical`,
          attemptId: attempt.id,
        });
      }
      if (document.status !== "manual_review") {
        document = await transitionFiscalDocumentRecord(tx, document, {
          status: "manual_review",
          evidenceHash: responseHash,
          now,
          source: "worker",
          sourceId: attempt.id,
          eventKey: `pos-fiscal-worker-mismatch:${attempt.id}:review`,
          attemptId: attempt.id,
        });
      }
      const incident = await tx.posFiscalIntegrityIncident.create({
        data: {
          id: randomUUID(),
          documentId: document.id,
          kind: "snapshot_mismatch",
          status: "open",
          productionBlocking: true,
          expectedEvidenceHash: hashFiscalPayload({ provider: attempt.document.provider, providerReference: attempt.document.providerReference, totalCents: attempt.document.totalCents, currency: attempt.document.currency, snapshotHash: attempt.document.snapshotHash }),
          reportedEvidenceHash: responseHash,
          details: jsonFiscal({ attemptId: attempt.id, operation: attempt.operation, failureCode, validationError: error instanceof Error ? error.message.slice(0, 500) : "invalid_boundary_result" }),
        },
      });
      await recordFiscalDelivery(tx, attempt, input, claimTokenHash, responseHash, { retryScheduled: false, superseded: true, attemptState: "failed", document });
      await tx.tenantAuditEvent.create({ data: { actorId: null, action: "pos.fiscal.worker.incident_opened", entityType: "pos_fiscal_document", entityId: document.id, correlationId: randomUUID(), beforeData: { status: attempt.document.status, version: attempt.document.version }, afterData: { status: document.status, version: document.version, attemptId: attempt.id, incidentId: incident.id, failureCode, responseHash, productionBlocking: true } } });
      return fiscalCompletionDto(document, { ...attempt, state: "failed", failureCode, finishedAt: now }, false, true, false, outbox.deliveryCount);
    }
    await persistFiscalArtifacts(tx, attempt.document.id, input.result.artifacts);
    const attemptState = observation.state === "unknown" ? "unknown" : "succeeded";
    await tx.posFiscalAttempt.update({
      where: { id: attempt.id },
      data: { state: attemptState, outcomeUnknown: attemptState === "unknown", responseHash, finishedAt: now },
    });
    await tx.posFiscalOutbox.update({ where: { id: outbox.id }, data: { state: "completed", claimToken: null, claimExpiresAt: null, completedAt: now } });
    const document = await transitionFiscalDocument(tx, attempt, { status: observation.state, observation, evidenceHash: responseHash, now });
    await recordFiscalDelivery(tx, attempt, input, claimTokenHash, responseHash, { retryScheduled: false, superseded: false, attemptState, document });
    await tx.tenantAuditEvent.create({
      data: {
        actorId: null,
        action: `pos.fiscal.worker.${observation.state}`,
        entityType: "pos_fiscal_document",
        entityId: document.id,
        correlationId: randomUUID(),
        beforeData: { status: attempt.document.status, version: attempt.document.version },
        afterData: { status: document.status, version: document.version, attemptId: attempt.id, deliveryNumber: outbox.deliveryCount, provider: observation.provider, providerReference: observation.reference, responseHash },
      },
    });
    return fiscalCompletionDto(document, { ...attempt, state: attemptState, outcomeUnknown: attemptState === "unknown", finishedAt: now }, false, false, false, outbox.deliveryCount);
  });
}

export async function maintainPosFiscalPersistence(
  db: RootDb,
  options: { now?: Date; batchSize?: number; correlationId?: string } = {},
) {
  const now = validDate(options.now ?? new Date(), "Data da manutenção fiscal");
  const batchSize = boundedInteger(options.batchSize ?? POS_FISCAL_WORK_LIMITS.defaultBatchSize, 1, POS_FISCAL_WORK_LIMITS.maximumBatchSize, "Lote");
  const correlationId = options.correlationId ? boundedIdentifier(options.correlationId, "Correlação", 1, 160, true) : randomUUID();
  return serializableFiscalRetry(db, async (tx) => {
    const [lock] = await tx.$queryRaw<Array<{ acquired: boolean }>>(Prisma.sql`SELECT pg_try_advisory_xact_lock(hashtextextended('nalven:pos-fiscal-maintenance', 0)) AS "acquired"`);
    if (!lock?.acquired) return { correlationId, recoveredLeases: 0, supersededLeases: 0, scheduledQueries: 0, skippedConcurrent: 1, hasMore: true };

    const expired = await tx.posFiscalOutbox.findMany({
      where: { state: "claimed", claimExpiresAt: { lte: now } },
      include: { attempt: { include: { document: true } } },
      orderBy: { claimExpiresAt: "asc" },
      take: batchSize,
    });
    let recoveredLeases = 0;
    let supersededLeases = 0;
    for (const candidate of expired) {
      const attempt = await lockFiscalGraph(tx, candidate.attemptId);
      const outbox = attempt.outbox;
      if (!outbox || outbox.state !== "claimed" || attempt.state !== "claimed" || !outbox.claimExpiresAt || outbox.claimExpiresAt > now) continue;
      if (!fiscalOperationEligible(attempt.operation, attempt.document.status)) {
        await tx.posFiscalAttempt.update({ where: { id: attempt.id }, data: { state: "failed", failureCode: "document_state_advanced", finishedAt: now } });
        await tx.posFiscalOutbox.update({ where: { id: outbox.id }, data: { state: "completed", claimToken: null, claimExpiresAt: null, completedAt: now, lastErrorCode: "document_state_advanced" } });
        recoveredLeases += 1;
        supersededLeases += 1;
        continue;
      }
      await tx.posFiscalAttempt.update({ where: { id: attempt.id }, data: { state: "unknown", outcomeUnknown: true, failureCode: "lease_outcome_unknown", finishedAt: now } });
      await tx.posFiscalOutbox.update({ where: { id: outbox.id }, data: { state: "dead", claimToken: null, claimExpiresAt: null, completedAt: now, lastErrorCode: "lease_outcome_unknown" } });
      const targetStatus = attempt.document.status === "cancellation_pending" ? "cancellation_pending" : attempt.document.status === "contingency" ? "contingency" : "unknown";
      await transitionFiscalDocument(tx, attempt, {
        status: targetStatus,
        failureCode: "lease_outcome_unknown",
        evidenceHash: hashFiscalPayload({ attemptId: attempt.id, result: "lease_outcome_unknown" }),
        now,
        source: "maintenance",
        sourceId: correlationId,
        eventKey: `pos-fiscal-lease-unknown:${attempt.id}`,
      });
      recoveredLeases += 1;
    }

    const due = await tx.posFiscalDocument.findMany({
      where: {
        status: { in: ["processing", "unknown", "contingency", "cancellation_pending"] },
        nextReconcileAt: { lte: now },
        attempts: { none: { operation: "query", outbox: { state: { in: ["pending", "claimed", "retry"] } } } },
      },
      orderBy: [{ nextReconcileAt: "asc" }, { id: "asc" }],
      take: batchSize,
    });
    let scheduledQueries = 0;
    for (const candidate of due) {
      await tx.$queryRaw(Prisma.sql`SELECT "id" FROM "pos_fiscal_documents" WHERE "id" = ${candidate.id} FOR UPDATE`);
      const document = await tx.posFiscalDocument.findUniqueOrThrow({ where: { id: candidate.id } });
      if (!["processing", "unknown", "contingency", "cancellation_pending"].includes(document.status) || !document.nextReconcileAt || document.nextReconcileAt > now) continue;
      const activeQuery = await tx.posFiscalAttempt.findFirst({ where: { documentId: document.id, operation: "query", outbox: { state: { in: ["pending", "claimed", "retry"] } } }, select: { id: true } });
      if (activeQuery) continue;
      const latest = await tx.posFiscalAttempt.findFirst({ where: { documentId: document.id }, orderBy: { sequence: "desc" }, select: { sequence: true } });
      const sequence = (latest?.sequence ?? 0) + 1;
      const attemptId = randomUUID();
      const operationKey = `pos-fiscal-query:${sha256(`${document.id}:${document.version}:${sequence}`).slice(0, 48)}`;
      const requestHash = hashFiscalPayload({ documentId: document.id, documentVersion: document.version, sequence, operation: "query", providerReference: document.providerReference });
      await tx.posFiscalAttempt.create({
        data: {
          id: attemptId,
          documentId: document.id,
          sequence,
          operation: "query",
          operationKey,
          requestHash,
          providerIdempotencyKey: operationKey,
          outbox: { create: { nextAttemptAt: now } },
        },
      });
      const changed = await tx.posFiscalDocument.updateMany({
        where: { id: document.id, version: document.version, status: document.status },
        data: { version: { increment: 1 }, nextReconcileAt: new Date(now.valueOf() + fiscalRetryDelayMs(sequence)) },
      });
      if (changed.count !== 1) throw new PosFiscalPersistenceError("O documento fiscal mudou durante o agendamento da consulta.", 409);
      await tx.posFiscalStateEvent.create({
        data: {
          documentId: document.id,
          attemptId,
          eventKey: `pos-fiscal-maintenance:${document.id}:${document.version + 1}`,
          source: "maintenance",
          sourceId: correlationId,
          fromState: document.status,
          toState: document.status,
          resultingVersion: document.version + 1,
        },
      });
      scheduledQueries += 1;
    }
    const [remainingClaims, remainingDue] = await Promise.all([
      tx.posFiscalOutbox.count({ where: { state: "claimed", claimExpiresAt: { lte: now } } }),
      tx.posFiscalDocument.count({ where: { status: { in: ["processing", "unknown", "contingency", "cancellation_pending"] }, nextReconcileAt: { lte: now } } }),
    ]);
    const result = { correlationId, recoveredLeases, supersededLeases, scheduledQueries, skippedConcurrent: 0, remainingExpiredClaims: remainingClaims, remainingDueDocuments: remainingDue, hasMore: remainingClaims > 0 || remainingDue > 0 };
    await tx.tenantAuditEvent.create({ data: { actorId: null, action: "pos.fiscal.persistence.maintenance", entityType: "pos_fiscal_worker", entityId: correlationId, correlationId, afterData: result } });
    return result;
  });
}

export async function acceptPosFiscalCallback(
  db: RootDb,
  provider: string,
  eventId: string,
  signatureKeyId: string,
  payloadHash: string,
  input: PosFiscalCallbackInput,
) {
  boundedIdentifier(provider, "Provider fiscal", 2, 80);
  boundedIdentifier(eventId, "Evento fiscal", 8, 160);
  boundedIdentifier(signatureKeyId, "Chave da assinatura fiscal", 1, 160, true);
  if (!/^[0-9a-f]{64}$/.test(payloadHash)) throw new PosFiscalPersistenceError("Hash do callback fiscal inválido.", 400);
  boundedIdentifier(input.documentId, "Documento fiscal", 1, 160, true);
  validateFiscalCompletionInput({ attemptId: input.documentId, claimToken: `callback:${eventId}`, result: { kind: "result", ...input } });
  const prior = await db.posFiscalCallback.findUnique({ where: { provider_eventId: { provider, eventId } }, include: { integrityIncident: true } });
  if (prior) return replayFiscalCallback(prior, payloadHash);
  return serializableFiscalRetry(db, async (tx) => {
    await tx.$queryRaw(Prisma.sql`SELECT "id" FROM "pos_fiscal_documents" WHERE "id" = ${input.documentId} FOR UPDATE`);
    const duplicate = await tx.posFiscalCallback.findUnique({ where: { provider_eventId: { provider, eventId } }, include: { integrityIncident: true } });
    if (duplicate) return replayFiscalCallback(duplicate, payloadHash);
    const document = await tx.posFiscalDocument.findUnique({ where: { id: input.documentId } });
    if (!document) throw new PosFiscalPersistenceError("Documento do callback fiscal não encontrado.", 404);

    let processingResult: "applied" | "no_change" | "ignored_stale" | "incident_opened" = "applied";
    let incidentKind: "callback_context_mismatch" | "final_state_contradiction" | "artifact_mismatch" | null = null;
    const referenceOwner = await tx.posFiscalDocument.findFirst({ where: { provider, providerReference: input.reference, id: { not: document.id } }, select: { id: true } });
    if (provider !== document.provider || input.provider !== provider || input.totalCents !== document.totalCents || input.currency !== document.currency || referenceOwner || document.providerReference && document.providerReference !== input.reference) {
      incidentKind = "callback_context_mismatch";
    } else if (input.providerSequence != null && document.providerSequence != null && input.providerSequence < document.providerSequence) {
      processingResult = "ignored_stale";
    }

    const existingArtifacts = await tx.posFiscalArtifact.findMany({ where: { documentId: document.id } });
    if (!incidentKind && processingResult !== "ignored_stale") {
      const incomingByType = new Map<string, PosFiscalWorkerArtifact>();
      for (const artifact of input.artifacts) {
        validateFiscalArtifactMetadata(artifact);
        if (incomingByType.has(artifact.type)) throw new PosFiscalPersistenceError(`Artefato fiscal duplicado: ${artifact.type}.`, 409);
        incomingByType.set(artifact.type, artifact);
        const existing = existingArtifacts.find((candidate) => candidate.type === artifact.type);
        if (existing && (existing.sha256 !== artifact.sha256 || existing.storageKey !== artifact.storageKey || existing.sizeBytes !== artifact.sizeBytes)) incidentKind = "artifact_mismatch";
      }
      const artifactId = (type: PosFiscalWorkerArtifact["type"]) => {
        const incoming = incomingByType.get(type);
        const existing = existingArtifacts.find((candidate) => candidate.type === type);
        return incoming?.providerArtifactId || incoming?.storageKey || existing?.providerArtifactId || existing?.storageKey || null;
      };
      if (!incidentKind) {
        try {
          validateFiscalResult({
            provider,
            reference: input.reference,
            state: input.state,
            accessKey: input.accessKey,
            protocol: input.protocol,
            xmlArtifactId: input.state === "authorized" ? artifactId("authorized_xml") : input.state === "contingency" ? artifactId("contingency_xml") : null,
            danfeArtifactId: artifactId("danfe"),
            rejectionCode: input.rejectionCode,
            rejectionMessage: input.rejectionMessage,
            occurredAt: input.occurredAt,
          }, { provider: document.provider, reference: document.providerReference ?? undefined });
          if (input.state === "cancelled" && !artifactId("cancellation_protocol")) throw new PosFiscalPersistenceError("Callback de cancelamento fiscal sem artefato de protocolo.", 409);
          assertFiscalDocumentResultTransition(document.status, input.state);
        } catch {
          incidentKind = "final_state_contradiction";
        }
      }
      if (!incidentKind && input.providerSequence != null && document.providerSequence != null && input.providerSequence === document.providerSequence && input.state !== document.status) incidentKind = "final_state_contradiction";
      if (!incidentKind && (document.accessKey && input.accessKey !== document.accessKey
        || document.authorizationProtocol && input.state === "authorized" && input.protocol !== document.authorizationProtocol
        || document.cancellationProtocol && input.state === "cancelled" && input.protocol !== document.cancellationProtocol)) incidentKind = "final_state_contradiction";
      if (!incidentKind && input.state === document.status) processingResult = "no_change";
    }

    let current = document;
    if (!incidentKind && processingResult === "applied") {
      const missing = input.artifacts.filter((artifact) => !existingArtifacts.some((candidate) => candidate.type === artifact.type));
      await persistFiscalArtifacts(tx, document.id, missing);
      current = await transitionFiscalDocumentRecord(tx, document, {
        status: input.state,
        observation: {
          provider,
          reference: input.reference,
          state: input.state,
          accessKey: input.accessKey,
          protocol: input.protocol,
          xmlArtifactId: null,
          danfeArtifactId: null,
          rejectionCode: input.rejectionCode,
          rejectionMessage: input.rejectionMessage,
          occurredAt: input.occurredAt,
          providerSequence: input.providerSequence,
        },
        evidenceHash: payloadHash,
        now: new Date(),
        source: "callback",
        sourceId: eventId,
        eventKey: `pos-fiscal-callback:${provider}:${eventId}`,
        attemptId: null,
      });
    }
    if (incidentKind) processingResult = "incident_opened";
    const evidence = jsonFiscal({
      accessKey: input.accessKey,
      protocol: input.protocol,
      rejectionCode: input.rejectionCode,
      rejectionMessage: input.rejectionMessage,
      artifacts: input.artifacts,
    });
    const callback = await tx.posFiscalCallback.create({
      data: {
        documentId: document.id,
        provider,
        eventId,
        payloadHash,
        signatureKeyId,
        providerReference: input.reference,
        reportedState: input.state,
        providerSequence: input.providerSequence,
        providerOccurredAt: input.occurredAt,
        totalCents: input.totalCents,
        currency: input.currency,
        evidence,
        processingResult,
        resultingState: current.status,
        resultingVersion: current.version,
      },
    });
    const incident = incidentKind ? await tx.posFiscalIntegrityIncident.create({
      data: {
        id: randomUUID(),
        documentId: document.id,
        callbackId: callback.id,
        kind: incidentKind,
        status: "open",
        productionBlocking: true,
        expectedEvidenceHash: hashFiscalPayload({ provider: document.provider, providerReference: document.providerReference, totalCents: document.totalCents, currency: document.currency, status: document.status, version: document.version, snapshotHash: document.snapshotHash }),
        reportedEvidenceHash: hashFiscalPayload(input),
        details: jsonFiscal({ eventId, signatureKeyId, payloadHash, reportedState: input.state, reportedReference: input.reference, referenceOwnerId: referenceOwner?.id ?? null }),
      },
    }) : null;
    await tx.tenantAuditEvent.create({
      data: {
        actorId: null,
        action: `pos.fiscal.callback.${processingResult}`,
        entityType: "pos_fiscal_document",
        entityId: document.id,
        correlationId: randomUUID(),
        beforeData: { status: document.status, version: document.version },
        afterData: { provider, eventId, reportedState: input.state, resultingState: current.status, resultingVersion: current.version, payloadHash, providerSequence: input.providerSequence?.toString() ?? null, incidentId: incident?.id ?? null, productionBlocking: incident?.productionBlocking ?? false },
      },
    });
    return { accepted: true, duplicate: false, applied: processingResult === "applied", result: processingResult, documentId: document.id, state: current.status, version: current.version, callbackId: callback.id.toString(), incident: incident ? { id: incident.id, kind: incident.kind, productionBlocking: incident.productionBlocking } : null };
  }).catch(async (error) => {
    if (isSerializationConflict(error) || prismaCode(error) === "P2002") {
      const concurrent = await db.posFiscalCallback.findUnique({ where: { provider_eventId: { provider, eventId } }, include: { integrityIncident: true } });
      if (concurrent) return replayFiscalCallback(concurrent, payloadHash);
    }
    throw error;
  });
}

function validateFiscalWorkerResult(
  attempt: Awaited<ReturnType<typeof lockFiscalGraph>>,
  result: Extract<PosFiscalOutboxCompletion["result"], { kind: "result" }>,
) {
  if (result.provider !== attempt.document.provider || result.totalCents !== attempt.document.totalCents || result.currency !== attempt.document.currency) {
    throw new PosFiscalPersistenceError("O resultado do boundary diverge do documento fiscal persistido.", 409);
  }
  const allowedStates: Record<string, readonly PosFiscalResult["state"][]> = {
    issue: ["processing", "authorized", "rejected", "unknown"],
    query: ["processing", "authorized", "rejected", "contingency", "cancelled", "unknown"],
    contingency: ["processing", "authorized", "rejected", "contingency", "unknown"],
    cancel: ["authorized", "cancelled", "unknown"],
  };
  if (!allowedStates[attempt.operation]?.includes(result.state)) throw new PosFiscalPersistenceError("Estado fiscal incompatível com a operação reivindicada.", 409);
  const authorizedXml = result.artifacts.find((artifact) => artifact.type === "authorized_xml");
  const contingencyXml = result.artifacts.find((artifact) => artifact.type === "contingency_xml");
  const danfe = result.artifacts.find((artifact) => artifact.type === "danfe");
  const validated = validateFiscalResult({
    provider: result.provider,
    reference: result.reference,
    state: result.state,
    accessKey: result.accessKey,
    protocol: result.protocol,
    xmlArtifactId: result.state === "authorized" ? authorizedXml?.providerArtifactId || authorizedXml?.storageKey : result.state === "contingency" ? contingencyXml?.providerArtifactId || contingencyXml?.storageKey : null,
    danfeArtifactId: danfe?.providerArtifactId || danfe?.storageKey || null,
    rejectionCode: result.rejectionCode,
    rejectionMessage: result.rejectionMessage,
    occurredAt: result.occurredAt,
  }, { provider: attempt.document.provider, reference: attempt.document.providerReference ?? undefined, states: allowedStates[attempt.operation] });
  assertFiscalDocumentResultTransition(attempt.document.status, validated.state);
  return { ...validated, providerSequence: result.providerSequence };
}

async function transitionFiscalDocument(
  tx: Prisma.TransactionClient,
  attempt: Awaited<ReturnType<typeof lockFiscalGraph>>,
  input: { status: string; failureCode?: string; observation?: PosFiscalResult & { providerSequence?: bigint | null }; evidenceHash: string; now: Date; source?: "worker" | "maintenance"; sourceId?: string; eventKey?: string },
) {
  return transitionFiscalDocumentRecord(tx, attempt.document, {
    ...input,
    attemptId: attempt.id,
    source: input.source ?? "worker",
    sourceId: input.sourceId ?? attempt.id,
    eventKey: input.eventKey ?? `pos-fiscal-worker:${attempt.id}:${attempt.document.version + 1}`,
  });
}

async function transitionFiscalDocumentRecord(
  tx: Prisma.TransactionClient,
  document: Prisma.PosFiscalDocumentGetPayload<object>,
  input: { status: string; observation?: PosFiscalResult & { providerSequence?: bigint | null }; evidenceHash: string; now: Date; source: "worker" | "callback" | "maintenance"; sourceId: string; eventKey: string; attemptId?: string | null },
) {
  const status = input.status;
  const version = document.version + 1;
  const observation = input.observation;
  const data: Prisma.PosFiscalDocumentUpdateManyMutationInput = {
    status,
    version: { increment: 1 },
    nextReconcileAt: ["processing", "unknown", "contingency_pending", "contingency", "cancellation_pending"].includes(status) ? new Date(input.now.valueOf() + 60_000) : null,
    unknownSince: status === "unknown" ? document.unknownSince ?? input.now : null,
  };
  if (observation) {
    data.providerReference = observation.reference;
    data.providerOccurredAt = observation.occurredAt;
    data.providerSequence = observation.providerSequence ?? document.providerSequence;
  }
  if (status === "authorized" && observation) {
    data.accessKey = observation.accessKey;
    data.authorizationProtocol = observation.protocol;
    data.authorizedAt = observation.occurredAt;
    data.rejectionCode = null;
    data.rejectionMessage = null;
    if (document.status === "cancellation_pending") {
      data.cancelRequestedAt = null;
      data.cancellationReason = null;
      data.cancellationProtocol = null;
      data.cancelledAt = null;
    }
  } else if (status === "rejected" && observation) {
    data.rejectionCode = observation.rejectionCode;
    data.rejectionMessage = observation.rejectionMessage;
  } else if (status === "cancelled" && observation) {
    data.cancellationProtocol = observation.protocol;
    data.cancelledAt = observation.occurredAt;
  }
  if (["contingency_pending", "contingency"].includes(document.status) && status !== "contingency_pending" && status !== "contingency") {
    data.contingencyStartedAt = null;
    data.contingencyReason = null;
  }
  if (document.status === "cancellation_pending" && status !== "cancellation_pending" && status !== "cancelled") {
    data.cancelRequestedAt = null;
    data.cancellationReason = null;
    data.cancellationProtocol = null;
    data.cancelledAt = null;
  }
  const changed = await tx.posFiscalDocument.updateMany({
    where: { id: document.id, version: document.version, status: document.status },
    data,
  });
  if (changed.count !== 1) throw new PosFiscalPersistenceError("O documento fiscal mudou durante a aplicação do resultado.", 409);
  await tx.posFiscalStateEvent.create({
    data: {
      documentId: document.id,
      attemptId: input.attemptId ?? null,
      eventKey: input.eventKey,
      source: input.source,
      sourceId: input.sourceId,
      fromState: document.status,
      toState: status,
      resultingVersion: version,
      providerOccurredAt: observation?.occurredAt ?? null,
      evidenceHash: input.evidenceHash,
    },
  });
  return tx.posFiscalDocument.findUniqueOrThrow({ where: { id: document.id } });
}

async function persistFiscalArtifacts(tx: Prisma.TransactionClient, documentId: string, artifacts: readonly PosFiscalWorkerArtifact[]) {
  const seen = new Set<string>();
  for (const artifact of artifacts) {
    if (seen.has(artifact.type)) throw new PosFiscalPersistenceError(`Artefato fiscal duplicado: ${artifact.type}.`, 409);
    seen.add(artifact.type);
    validateFiscalArtifactMetadata(artifact);
    await tx.posFiscalArtifact.create({
      data: {
        id: randomUUID(),
        documentId,
        type: artifact.type,
        providerArtifactId: artifact.providerArtifactId,
        storageKey: artifact.storageKey,
        mimeType: artifact.mimeType,
        sizeBytes: artifact.sizeBytes,
        sha256: artifact.sha256,
        encryptionKeyId: artifact.encryptionKeyId,
        retentionUntil: artifact.retentionUntil,
      },
    });
  }
}

function validateFiscalArtifactMetadata(artifact: PosFiscalWorkerArtifact) {
  const types = new Set(["authorized_xml", "contingency_xml", "authorization_protocol", "cancellation_protocol", "danfe", "qr", "provider_response_redacted"]);
  const mimeTypes = new Set(["application/xml", "text/xml", "application/pdf", "application/json", "text/plain", "image/png"]);
  if (!types.has(artifact.type) || !mimeTypes.has(artifact.mimeType) || !/^[0-9a-f]{64}$/.test(artifact.sha256) || !Number.isSafeInteger(artifact.sizeBytes) || artifact.sizeBytes < 1 || artifact.sizeBytes > 52_428_800) throw new PosFiscalPersistenceError("Metadados do artefato fiscal são inválidos.", 409);
  boundedIdentifier(artifact.storageKey, "Chave de armazenamento fiscal", 8, 500, true);
  if (artifact.providerArtifactId) boundedIdentifier(artifact.providerArtifactId, "Artefato do provedor", 1, 160, true);
  if (artifact.encryptionKeyId) boundedIdentifier(artifact.encryptionKeyId, "Chave de criptografia", 1, 160, true);
  if (artifact.retentionUntil) validDate(artifact.retentionUntil, "Retenção fiscal");
}

async function recordFiscalDelivery(
  tx: Prisma.TransactionClient,
  attempt: Awaited<ReturnType<typeof lockFiscalGraph>>,
  input: PosFiscalOutboxCompletion,
  claimTokenHash: string,
  responseHash: string,
  result: { retryScheduled: boolean; superseded: boolean; attemptState: string; document: { id: string; status: string; version: number } },
) {
  if (!attempt.outbox) throw new PosFiscalPersistenceError("Outbox fiscal ausente durante o registro da entrega.", 409);
  await tx.posFiscalDeliveryResult.create({
    data: {
      documentId: result.document.id,
      attemptId: attempt.id,
      outboxId: attempt.outbox.id,
      deliveryNumber: attempt.outbox.deliveryCount,
      claimTokenHash,
      responseHash,
      resultKind: input.result.kind,
      retryScheduled: result.retryScheduled,
      superseded: result.superseded,
      resultingAttemptState: result.attemptState,
      resultingDocumentState: result.document.status,
      resultingDocumentVersion: result.document.version,
    },
  });
}

async function lockFiscalGraph(tx: Prisma.TransactionClient, attemptId: string) {
  await tx.$queryRaw(Prisma.sql`
    SELECT d."id" FROM "pos_fiscal_documents" d
    JOIN "pos_fiscal_attempts" a ON a."document_id" = d."id"
    WHERE a."id" = ${attemptId} FOR UPDATE OF d
  `);
  await tx.$queryRaw(Prisma.sql`SELECT "id" FROM "pos_fiscal_attempts" WHERE "id" = ${attemptId} FOR UPDATE`);
  const attempt = await tx.posFiscalAttempt.findUnique({
    where: { id: attemptId },
    include: { outbox: true, document: { include: { profile: true } } },
  });
  if (!attempt) throw new PosFiscalPersistenceError("Tentativa fiscal não encontrada.", 404);
  if (attempt.outbox) await tx.$queryRaw(Prisma.sql`SELECT "id" FROM "pos_fiscal_outbox" WHERE "id" = ${attempt.outbox.id} FOR UPDATE`);
  return attempt;
}

function fiscalOutboxCommand(
  attempt: Awaited<ReturnType<typeof lockFiscalGraph>>,
  claimToken: string,
  claimExpiresAt: Date,
) {
  if (!attempt.outbox) throw new PosFiscalPersistenceError("Tentativa fiscal sem outbox.", 409);
  const document = attempt.document;
  return {
    outboxId: attempt.outbox.id.toString(),
    attemptId: attempt.id,
    operation: attempt.operation,
    claimToken,
    claimExpiresAt,
    providerIdempotencyKey: attempt.providerIdempotencyKey,
    document: {
      id: document.id,
      saleId: document.saleId,
      branchId: document.branchId,
      registerId: document.registerId,
      sessionId: document.sessionId,
      terminalId: document.terminalId,
      connectorId: document.connectorId,
      credentialRef: document.credentialRef,
      profileId: document.profileId,
      profileVersion: document.profileVersion,
      schemaVersion: document.profile.schemaVersion,
      documentModel: document.documentModel,
      environment: document.environment,
      provider: document.provider,
      providerReference: document.providerReference,
      totalCents: document.totalCents,
      currency: document.currency,
      snapshotHash: document.snapshotHash,
      saleSnapshot: document.saleSnapshot,
    },
  };
}

function fiscalCompletionDto(
  document: { id: string; status: string; version: number; providerReference: string | null; accessKey: string | null; authorizationProtocol: string | null; rejectionCode: string | null; rejectionMessage: string | null; nextReconcileAt: Date | null },
  attempt: { id: string; state: string; operation: string; outcomeUnknown: boolean; failureCode: string | null; finishedAt: Date | null },
  retryScheduled: boolean,
  superseded: boolean,
  replayed: boolean,
  deliveryNumber: number,
) {
  return {
    replayed,
    retryScheduled,
    superseded,
    deliveryNumber,
    document: {
      id: document.id,
      status: document.status,
      version: document.version,
      providerReference: document.providerReference,
      accessKey: document.accessKey,
      authorizationProtocol: document.authorizationProtocol,
      rejectionCode: document.rejectionCode,
      rejectionMessage: document.rejectionMessage,
      nextReconcileAt: document.nextReconcileAt,
    },
    attempt: { id: attempt.id, operation: attempt.operation, state: attempt.state, outcomeUnknown: attempt.outcomeUnknown, failureCode: attempt.failureCode, finishedAt: attempt.finishedAt },
  };
}

function validateFiscalCompletionInput(input: PosFiscalOutboxCompletion) {
  boundedIdentifier(input.attemptId, "Tentativa fiscal", 1, 160, true);
  boundedIdentifier(input.claimToken, "Token do claim fiscal", 16, 320, true);
  if (input.result.kind === "known_failure" || input.result.kind === "unknown") {
    boundedIdentifier(input.result.failureCode, "Código de falha fiscal", 1, 80, true);
    if (input.result.failureMessage) boundedIdentifier(input.result.failureMessage, "Mensagem de falha fiscal", 1, 500, true);
  } else {
    boundedInteger(input.result.totalCents, 1, 2_147_483_647, "Total fiscal");
    validDate(input.result.occurredAt, "Data do provedor fiscal");
    if (input.result.providerSequence != null && input.result.providerSequence <= BigInt(0)) throw new PosFiscalPersistenceError("Sequência do provedor fiscal inválida.", 400);
    if (!Array.isArray(input.result.artifacts) || input.result.artifacts.length > 7) throw new PosFiscalPersistenceError("Lista de artefatos fiscais inválida.", 400);
  }
}

function fiscalOperationEligible(operation: string, status: string) {
  return operation === "issue" && status === "queued"
    || operation === "query" && ["processing", "unknown", "contingency_pending", "contingency", "cancellation_pending"].includes(status)
    || operation === "contingency" && status === "contingency_pending"
    || operation === "cancel" && status === "cancellation_pending";
}

function assertFiscalDocumentResultTransition(current: string, next: PosFiscalResult["state"]) {
  if (current === next) return;
  const allowed: Record<string, readonly string[]> = {
    queued: ["processing", "authorized", "rejected", "unknown"],
    processing: ["authorized", "rejected", "unknown"],
    unknown: ["processing", "authorized", "rejected"],
    contingency_pending: ["processing", "authorized", "rejected", "contingency", "unknown"],
    contingency: ["authorized", "rejected", "contingency"],
    cancellation_pending: ["authorized", "cancelled"],
  };
  if (!allowed[current]?.includes(next)) throw new PosFiscalPersistenceError(`Resultado fiscal incompatível com a transição ${current} → ${next}.`, 409);
}

async function serializableFiscalRetry<T>(db: RootDb, operation: (tx: Prisma.TransactionClient) => Promise<T>) {
  for (let attempt = 1; attempt <= POS_FISCAL_WORK_LIMITS.serializationRetries; attempt += 1) {
    try {
      return await db.$transaction(operation, { isolationLevel: "Serializable", maxWait: 10_000, timeout: 30_000 });
    } catch (error) {
      if (!isSerializationConflict(error) || attempt === POS_FISCAL_WORK_LIMITS.serializationRetries) throw error;
    }
  }
  throw new PosFiscalPersistenceError("A operação fiscal serializável não pôde ser concluída.", 409);
}

function isSerializationConflict(error: unknown) {
  const code = error && typeof error === "object" && "code" in error ? String((error as { code?: unknown }).code || "") : "";
  const metaCode = error && typeof error === "object" && "meta" in error && (error as { meta?: unknown }).meta && typeof (error as { meta: Record<string, unknown> }).meta === "object" ? String((error as { meta: Record<string, unknown> }).meta.database_error || "") : "";
  return ["P2034", "40001", "40P01"].includes(code) || /40001|40P01|serialization|deadlock/i.test(metaCode);
}

function fiscalRetryDelayMs(deliveryCount: number) {
  return Math.min(300_000, 1_000 * 2 ** Math.min(Math.max(deliveryCount - 1, 0), 8));
}

function hashFiscalPayload(value: unknown) {
  const normalized = JSON.parse(JSON.stringify(value, (_, item) => typeof item === "bigint" ? item.toString() : item));
  return sha256(canonicalPosJson(normalized));
}

function jsonFiscal(value: unknown) {
  return JSON.parse(JSON.stringify(value, (_, item) => typeof item === "bigint" ? item.toString() : item)) as Prisma.InputJsonValue;
}

function replayFiscalCallback(
  callback: { id: bigint; documentId: string; payloadHash: string; processingResult: string; resultingState: string; resultingVersion: number; integrityIncident: { id: string; kind: string; productionBlocking: boolean } | null },
  payloadHash: string,
) {
  if (callback.payloadHash !== payloadHash) throw new PosFiscalPersistenceError("Evento fiscal duplicado com payload divergente.", 409);
  return { accepted: true, duplicate: true, applied: callback.processingResult === "applied", result: callback.processingResult, documentId: callback.documentId, state: callback.resultingState, version: callback.resultingVersion, callbackId: callback.id.toString(), incident: callback.integrityIncident ? { id: callback.integrityIncident.id, kind: callback.integrityIncident.kind, productionBlocking: callback.integrityIncident.productionBlocking } : null };
}

function prismaCode(error: unknown) {
  return error && typeof error === "object" && "code" in error ? String((error as { code?: unknown }).code || "") : "";
}

function boundedIdentifier(value: unknown, label: string, minimum: number, maximum: number, allowPunctuation = false) {
  if (typeof value !== "string") throw new PosFiscalPersistenceError(`${label} inválido.`, 400);
  const result = value.normalize("NFKC").trim();
  const pattern = allowPunctuation ? /^[^\u0000-\u001f]+$/ : /^[A-Za-z0-9._:-]+$/;
  if (result.length < minimum || result.length > maximum || !pattern.test(result)) throw new PosFiscalPersistenceError(`${label} inválido.`, 400);
  return result;
}

function boundedInteger(value: unknown, minimum: number, maximum: number, label: string) {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < minimum || value > maximum) throw new PosFiscalPersistenceError(`${label} inválido.`, 400);
  return value;
}

function validDate(value: unknown, label: string) {
  if (!(value instanceof Date) || Number.isNaN(value.valueOf())) throw new PosFiscalPersistenceError(`${label} inválida.`, 400);
  return value;
}

export function buildPosFiscalSaleSnapshot(
  sale: FiscalSaleInput,
  profile: Pick<FiscalProfileInput, "taxRegime" | "policyDigest">,
  policy: FiscalPolicy,
): PosFiscalSaleSnapshot {
  if (sale.status !== "completed" || sale.branchId == null || sale.sessionId == null || sale.operatorProfileId == null) {
    throw new PosFiscalPersistenceError("A venda não possui contexto operacional completo para preparação fiscal.");
  }
  const customerTaxId = sale.customerRecord?.document.replace(/\D/g, "") || null;
  const items = sale.items.map((item, index) => {
    const fiscal = {
      fiscalType: item.product.fiscalType,
      ncm: clean(item.product.ncm),
      cest: clean(item.product.cest),
      cestNotApplicable: item.product.cestNotApplicable,
      origin: clean(item.product.origin),
      gtin: clean(item.gtinSnapshot),
      gtinTributary: clean(item.product.gtinTributary),
      cfop: policy.defaultCfop,
      csosn: clean(item.product.csosn) || policy.defaultCsosn,
      cst: policy.defaultCst,
      taxStatus: item.product.taxStatus,
      taxClass: clean(item.product.taxClass),
      taxRegime: profile.taxRegime,
      profilePolicyDigest: profile.policyDigest,
    } as const;
    validateFiscalProduct(index + 1, item.productName, fiscal, policy.requiredProductFields, profile.taxRegime);
    return {
      sequence: index + 1,
      productId: item.productId,
      description: item.productName,
      unit: item.unit.trim().toUpperCase(),
      quantity: item.quantity,
      unitPriceCents: item.unitPriceCents,
      discountCents: item.discountCents,
      surchargeCents: item.surchargeCents,
      totalCents: item.totalCents,
      fiscal,
    };
  });
  return validateFiscalSaleSnapshot({
    saleId: sale.id,
    saleNumber: sale.saleNumber,
    branchId: sale.branchId,
    currency: "BRL",
    totalCents: sale.totalCents,
    issuedAt: sale.createdAt,
    customerTaxId,
    items,
    payments: sale.payments.map((payment) => ({ method: payment.method, amountCents: payment.amountCents })),
  }) as PosFiscalSaleSnapshot;
}

function parseFiscalPolicy(profile: FiscalProfileInput): FiscalPolicy {
  const policy = jsonRecord(profile.policySnapshot, "Política fiscal");
  const calculatedDigest = sha256(canonicalPosJson(policy));
  if (calculatedDigest !== profile.policyDigest) throw new PosFiscalPersistenceError("O digest da política fiscal ativa não confere com seu snapshot.", 409);
  const saleCommitMode = policy.saleCommitMode == null ? "disabled" : String(policy.saleCommitMode);
  if (!POS_FISCAL_SALE_COMMIT_MODES.includes(saleCommitMode as FiscalCommitMode)) throw new PosFiscalPersistenceError("Modo de preparação fiscal da venda inválido.", 409);
  const required = policy.requiredProductFields == null ? ["ncm", "origin"] : policy.requiredProductFields;
  if (!Array.isArray(required) || !required.length || required.length > POS_FISCAL_PRODUCT_FIELDS.length) throw new PosFiscalPersistenceError("Campos obrigatórios da política fiscal são inválidos.", 409);
  const requiredProductFields = [...new Set(required.map((field) => String(field)))] as FiscalProductField[];
  if (requiredProductFields.some((field) => !POS_FISCAL_PRODUCT_FIELDS.includes(field))) throw new PosFiscalPersistenceError("A política fiscal exige um campo de produto desconhecido.", 409);
  const taxRules = policy.taxRules == null ? {} : jsonRecord(policy.taxRules, "Regras tributárias fiscais");
  const defaultCfop = clean(taxRules.defaultCfop);
  const defaultCsosn = clean(taxRules.defaultCsosn);
  const defaultCst = clean(taxRules.defaultCst);
  if (saleCommitMode === "queue" && !/^\d{4}$/.test(defaultCfop || "")) throw new PosFiscalPersistenceError("Perfil fiscal ativo precisa de CFOP padrão validado para enfileirar a venda.", 409);
  if (defaultCsosn && !/^\d{3}$/.test(defaultCsosn)) throw new PosFiscalPersistenceError("CSOSN padrão do perfil fiscal é inválido.", 409);
  if (defaultCst && !/^\d{2,3}$/.test(defaultCst)) throw new PosFiscalPersistenceError("CST padrão do perfil fiscal é inválido.", 409);
  return { saleCommitMode: saleCommitMode as FiscalCommitMode, requiredProductFields, defaultCfop: defaultCfop || "", defaultCsosn, defaultCst };
}

function validateFiscalProduct(
  sequence: number,
  name: string,
  fiscal: Record<FiscalProductField | "cestNotApplicable" | "fiscalType" | "taxStatus" | "taxClass" | "taxRegime" | "profilePolicyDigest", string | boolean | null>,
  required: readonly FiscalProductField[],
  taxRegime: string,
) {
  for (const field of required) {
    if (field === "cest" && fiscal.cestNotApplicable === true) continue;
    if (!fiscal[field]) throw new PosFiscalPersistenceError(`Item fiscal ${sequence} (${name}) não possui ${field}.`);
  }
  if (!/^\d{8}$/.test(String(fiscal.ncm || ""))) throw new PosFiscalPersistenceError(`NCM inválido no item fiscal ${sequence} (${name}).`);
  if (fiscal.cest && !/^\d{7}$/.test(String(fiscal.cest))) throw new PosFiscalPersistenceError(`CEST inválido no item fiscal ${sequence} (${name}).`);
  if (!/^[0-8]$/.test(String(fiscal.origin || ""))) throw new PosFiscalPersistenceError(`Origem inválida no item fiscal ${sequence} (${name}).`);
  if (!/^\d{4}$/.test(String(fiscal.cfop || ""))) throw new PosFiscalPersistenceError(`CFOP inválido no item fiscal ${sequence} (${name}).`);
  for (const field of ["gtin", "gtinTributary"] as const) {
    const value = fiscal[field];
    if (value && !isValidGtin(String(value))) throw new PosFiscalPersistenceError(`${field} inválido no item fiscal ${sequence} (${name}).`);
  }
  if (["simples_nacional", "mei"].includes(taxRegime) && !/^\d{3}$/.test(String(fiscal.csosn || ""))) {
    throw new PosFiscalPersistenceError(`CSOSN ausente ou inválido no item fiscal ${sequence} (${name}).`);
  }
  if (!["simples_nacional", "mei"].includes(taxRegime) && !/^\d{2,3}$/.test(String(fiscal.cst || ""))) {
    throw new PosFiscalPersistenceError(`CST ausente ou inválido no item fiscal ${sequence} (${name}).`);
  }
}

function jsonRecord(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new PosFiscalPersistenceError(`${label} deve ser um objeto.`);
  return value as Record<string, unknown>;
}

function clean(value: unknown) {
  const normalized = String(value ?? "").trim();
  return normalized || null;
}

function sha256(value: string) {
  return createHash("sha256").update(value, "utf8").digest("hex");
}
