import { randomUUID } from "node:crypto";
import { Prisma, type PrismaClient } from "@/generated/tenant/client";
import {
  hashPosPaymentCompensationPayload,
  parsePosPaymentCompensationObservation,
  PosPaymentCompensationError,
  type PosPaymentCompensationObservation,
} from "@/lib/erp/pos-payment-compensations";
import { containsPosPaymentPanInIdentifier } from "@/lib/erp/pos-payment-persistence";
import { posSalePaymentWriteTarget, preparePosSalePaymentWrite } from "@/lib/erp/pos-payment-artifact-capability";
import { prelockPosSalePaymentWriteGraph } from "@/lib/erp/pos-sale-payment-prelock";

export const POS_PAYMENT_COMPENSATION_WORK_LIMITS = Object.freeze({
  defaultBatchSize: 25,
  maximumBatchSize: 100,
  defaultLeaseSeconds: 60,
  maximumLeaseSeconds: 300,
  serializationRetries: 3,
});

export type PosPaymentCompensationOutboxCompletion = {
  attemptId: string;
  claimToken: string;
  result:
    | ({ kind: "result" } & PosPaymentCompensationObservation)
    | { kind: "unknown"; failureCode: string; failureMessage: string | null }
    | { kind: "known_failure"; retryable: boolean; failureCode: string; failureMessage: string | null };
};

export type PosPaymentCompensationCallbackInput = PosPaymentCompensationObservation;

type RootDb = PrismaClient;
type LockedGraph = Prisma.PosPaymentCompensationAttemptGetPayload<{
  include: { outbox: true; compensation: true };
}>;

export function parsePosPaymentCompensationOutboxCompletion(body: Record<string, unknown>): PosPaymentCompensationOutboxCompletion {
  rejectSensitiveData(body);
  onlyKeys(body, ["action", "attemptId", "claimToken", "result"]);
  if (body.action !== "compensation.outbox.complete") throw new PosPaymentCompensationError("Ação do worker compensatório inválida.", 400);
  const result = record(body.result, "Resultado");
  const kind = choice(result.kind, ["result", "unknown", "known_failure"] as const, "Tipo de resultado");
  if (kind === "result") {
    onlyKeys(result, ["kind", "compensationId", "provider", "originalReference", "operationReference", "state", "requestedAmountCents", "confirmedAmountCents", "currency", "sequence", "occurredAt", "evidenceHash", "failureCode", "failureMessage"]);
    const { kind: _kind, ...observationBody } = result;
    void _kind;
    return {
      attemptId: safeKey(body.attemptId, "Tentativa"),
      claimToken: safeKey(body.claimToken, "Token de claim"),
      result: { kind, ...parsePosPaymentCompensationObservation(observationBody) },
    };
  }
  onlyKeys(result, kind === "known_failure" ? ["kind", "retryable", "failureCode", "failureMessage"] : ["kind", "failureCode", "failureMessage"]);
  return {
    attemptId: safeKey(body.attemptId, "Tentativa"),
    claimToken: safeKey(body.claimToken, "Token de claim"),
    result: {
      kind,
      ...(kind === "known_failure" ? { retryable: result.retryable === true } : {}),
      failureCode: safeCode(result.failureCode, "Falha"),
      failureMessage: nullableText(result.failureMessage, "Descrição da falha", 300),
    } as PosPaymentCompensationOutboxCompletion["result"],
  };
}

export async function claimPosPaymentCompensationOutbox(db: RootDb, options: {
  workerId: string;
  limit?: number;
  leaseSeconds?: number;
  now?: Date;
}) {
  const workerId = safeIdentifier(options.workerId, "Worker", 3, 120);
  const limit = bounded(options.limit ?? POS_PAYMENT_COMPENSATION_WORK_LIMITS.defaultBatchSize, 1, POS_PAYMENT_COMPENSATION_WORK_LIMITS.maximumBatchSize, "Lote");
  const leaseSeconds = bounded(options.leaseSeconds ?? POS_PAYMENT_COMPENSATION_WORK_LIMITS.defaultLeaseSeconds, 15, POS_PAYMENT_COMPENSATION_WORK_LIMITS.maximumLeaseSeconds, "Lease");
  const now = validDate(options.now ?? new Date());
  return serializableRetry(db, async (tx) => {
    const rows = await tx.$queryRaw<Array<{ compensationId: string; attemptId: string; outboxId: bigint }>>(Prisma.sql`
      SELECT c."id" AS "compensationId", a."id" AS "attemptId", o."id" AS "outboxId"
      FROM "pos_payment_compensation_outbox" o
      JOIN "pos_payment_compensation_attempts" a ON a."id" = o."attempt_id"
      JOIN "pos_payment_compensations" c ON c."id" = a."compensation_id"
      WHERE o."state" IN ('pending', 'retry')
        AND o."next_attempt_at" <= ${now}
        AND o."delivery_count" < o."max_deliveries"
        AND a."state" IN ('queued', 'retry')
        AND (
          (a."operation" IN ('void', 'refund') AND a."operation" = c."kind" AND c."status" IN ('requested', 'processing'))
          OR (a."operation" = 'query' AND c."status" IN ('processing', 'unknown', 'manual_review'))
        )
      ORDER BY o."next_attempt_at", o."id"
      LIMIT ${limit}
      FOR UPDATE OF c SKIP LOCKED
    `);
    const claimed: Array<ReturnType<typeof compensationOutboxCommand>> = [];
    for (const row of rows) {
      await lockAttempt(tx, row.attemptId);
      await lockOutbox(tx, row.outboxId);
      const attempt = await tx.posPaymentCompensationAttempt.findUnique({
        where: { id: row.attemptId },
        include: { outbox: true, compensation: true },
      });
      if (!attempt?.outbox || !isClaimEligible(attempt, now)) continue;
      const claimToken = `${workerId}:${randomUUID()}`;
      const claimExpiresAt = new Date(now.valueOf() + leaseSeconds * 1_000);
      const deliveryCount = attempt.outbox.deliveryCount + 1;
      await tx.posPaymentCompensationAttempt.update({
        where: { id: attempt.id },
        data: { state: "claimed", dispatchCount: { increment: 1 }, startedAt: now, failureCode: null },
      });
      await tx.posPaymentCompensationOutbox.update({
        where: { id: attempt.outbox.id },
        data: { state: "claimed", deliveryCount, claimToken, claimExpiresAt, lastErrorCode: null },
      });
      let compensation = attempt.compensation;
      if (attempt.operation !== "query" && compensation.status === "requested") {
        const version = compensation.version + 1;
        compensation = await tx.posPaymentCompensation.update({
          where: { id: compensation.id },
          data: { status: "processing", providerState: "processing", version, failureCode: null, failureMessage: null },
        });
        await createStateEvent(tx, compensation.id, attempt.id, `compensation-claim:${attempt.id}:${deliveryCount}`, "worker", workerId, "requested", "processing", version, null, null);
      }
      claimed.push(compensationOutboxCommand({ ...attempt, compensation, outbox: { ...attempt.outbox, deliveryCount } }, claimToken, claimExpiresAt));
    }
    return { workerId, claimed, claimedCount: claimed.length };
  });
}

/**
 * T1: closes one leased provider delivery and persists only the provider fact.
 * It never creates a local refund. A successful result becomes
 * application_pending and is applied later by applyPosPaymentCompensation.
 */
export async function completePosPaymentCompensationOutbox(db: RootDb, input: PosPaymentCompensationOutboxCompletion, nowValue = new Date()) {
  const now = validDate(nowValue);
  const responseHash = hashPosPaymentCompensationPayload(input.result);
  const claimTokenHash = hashPosPaymentCompensationPayload(input.claimToken);
  return serializableRetry(db, async (tx) => {
    let graph = await lockCompensationGraph(tx, input.attemptId);
    const outbox = graph.outbox;
    if (!outbox) throw new PosPaymentCompensationError("Tentativa compensatória sem outbox.", 409);
    const deliveryReplay = await tx.posPaymentCompensationDeliveryResult.findUnique({ where: { claimTokenHash } });
    if (deliveryReplay) {
      if (deliveryReplay.attemptId !== input.attemptId || deliveryReplay.responseHash !== responseHash) {
        throw new PosPaymentCompensationError("O claim compensatório já foi concluído com outro conteúdo.", 409);
      }
      return completionDto(graph, { replayed: true, retryScheduled: deliveryReplay.retryScheduled, superseded: deliveryReplay.superseded });
    }
    if (["succeeded", "unknown", "failed"].includes(graph.state)) {
      throw new PosPaymentCompensationError("A tentativa compensatória já foi concluída; o token informado não corresponde à entrega persistida.", 409);
    }
    if (graph.state !== "claimed" || outbox.state !== "claimed" || outbox.claimToken !== input.claimToken || !outbox.claimExpiresAt || outbox.claimExpiresAt <= now) {
      throw new PosPaymentCompensationError("O claim compensatório expirou ou pertence a outro worker.", 409);
    }

    if (!isOperationCurrent(graph)) {
      graph = await closeSuperseded(tx, graph, input, claimTokenHash, responseHash, now);
      return completionDto(graph, { replayed: false, retryScheduled: false, superseded: true });
    }

    if (input.result.kind === "known_failure") {
      const retryScheduled = input.result.retryable && outbox.deliveryCount < outbox.maxDeliveries;
      if (retryScheduled) {
        await tx.posPaymentCompensationAttempt.update({ where: { id: graph.id }, data: { state: "retry", responseHash: null, failureCode: input.result.failureCode, startedAt: null } });
        await tx.posPaymentCompensationOutbox.update({ where: { id: outbox.id }, data: { state: "retry", claimToken: null, claimExpiresAt: null, lastErrorCode: input.result.failureCode, nextAttemptAt: new Date(now.valueOf() + retryDelayMs(outbox.deliveryCount)) } });
        await recordDelivery(tx, graph, input, claimTokenHash, responseHash, { retryScheduled: true, superseded: false, attemptState: "retry", compensation: graph.compensation });
        graph = { ...graph, state: "retry", responseHash: null, failureCode: input.result.failureCode, startedAt: null, outbox: { ...outbox, state: "retry", claimToken: null, claimExpiresAt: null, lastErrorCode: input.result.failureCode } };
        return completionDto(graph, { replayed: false, retryScheduled: true, superseded: false });
      }
      const queryFailure = graph.operation === "query";
      const version = graph.compensation.version + 1;
      const compensation = await tx.posPaymentCompensation.update({ where: { id: graph.compensationId }, data: queryFailure ? {
        status: "manual_review", providerState: "manual_review", applicationState: "not_ready", version,
        failureCode: input.result.failureCode, failureMessage: input.result.failureMessage,
        unknownSince: null, nextReconcileAt: null,
      } : {
        status: "declined", providerState: "declined", applicationState: "not_ready", version,
        confirmedAmountCents: null, failureCode: input.result.failureCode, failureMessage: input.result.failureMessage,
        unknownSince: null, nextReconcileAt: null, providerResultPersistedAt: now,
      } });
      await tx.posPaymentCompensationAttempt.update({ where: { id: graph.id }, data: { state: "failed", responseHash, failureCode: input.result.failureCode, finishedAt: now } });
      await completeOutbox(tx, outbox.id, now, input.result.failureCode, false);
      await createStateEvent(tx, compensation.id, graph.id, `compensation-failure:${graph.id}:${outbox.deliveryCount}`, "worker", graph.id, graph.compensation.status, queryFailure ? "manual_review" : "declined", version, null, null);
      graph = { ...graph, state: "failed", responseHash, failureCode: input.result.failureCode, finishedAt: now, compensation, outbox: { ...outbox, state: "dead", claimToken: null, claimExpiresAt: null, completedAt: now } };
      await recordDelivery(tx, graph, input, claimTokenHash, responseHash, { retryScheduled: false, superseded: false, attemptState: "failed", compensation });
      return completionDto(graph, { replayed: false, retryScheduled: false, superseded: false });
    }

    if (input.result.kind === "unknown") {
      graph = await persistUnknown(tx, graph, input, claimTokenHash, responseHash, now, input.result.failureCode, input.result.failureMessage);
      return completionDto(graph, { replayed: false, retryScheduled: false, superseded: false });
    }

    const observation = input.result;
    const mismatch = observationMismatch(graph.compensation, observation);
    if (mismatch) {
      graph = await persistWorkerIncident(tx, graph, input, claimTokenHash, responseHash, now, mismatch);
      return completionDto(graph, { replayed: false, retryScheduled: false, superseded: false });
    }
    if (isObservationStale(graph.compensation, observation)) {
      graph = await closeSuperseded(tx, graph, input, claimTokenHash, responseHash, now);
      return completionDto(graph, { replayed: false, retryScheduled: false, superseded: true });
    }
    if (observation.state === "unknown") {
      graph = await persistUnknown(tx, graph, input, claimTokenHash, responseHash, now, observation.failureCode || "provider_unknown", observation.failureMessage);
      return completionDto(graph, { replayed: false, retryScheduled: false, superseded: false });
    }

    const before = graph.compensation.status;
    if (observation.state === "succeeded") {
      const providerVersion = graph.compensation.version + 1;
      const providerSucceeded = await tx.posPaymentCompensation.update({ where: { id: graph.compensationId }, data: {
        status: "provider_succeeded", providerState: "succeeded", applicationState: "not_ready", version: providerVersion,
        confirmedAmountCents: observation.confirmedAmountCents,
        providerOperationReference: observation.providerOperationReference,
        providerSequence: observation.providerSequence,
        providerOccurredAt: observation.occurredAt,
        evidenceHash: observation.evidenceHash,
        failureCode: observation.failureCode,
        failureMessage: observation.failureMessage,
        unknownSince: null,
        nextReconcileAt: null,
        providerResultPersistedAt: now,
      } });
      await createStateEvent(tx, providerSucceeded.id, graph.id, `compensation-result:${graph.id}:${outbox.deliveryCount}`, "worker", graph.id, before, "provider_succeeded", providerVersion, observation.occurredAt, observation.evidenceHash);
      const applicationVersion = providerVersion + 1;
      const compensation = await tx.posPaymentCompensation.update({ where: { id: graph.compensationId }, data: { status: "application_pending", applicationState: "pending", version: applicationVersion } });
      await createStateEvent(tx, compensation.id, graph.id, `compensation-application-pending:${graph.id}:${outbox.deliveryCount}`, "worker", graph.id, "provider_succeeded", "application_pending", applicationVersion, observation.occurredAt, observation.evidenceHash);
      await tx.posPaymentCompensationAttempt.update({ where: { id: graph.id }, data: { state: "succeeded", outcomeUnknown: false, responseHash, failureCode: observation.failureCode, finishedAt: now } });
      await completeOutbox(tx, outbox.id, now, null, true);
      graph = { ...graph, state: "succeeded", outcomeUnknown: false, responseHash, failureCode: observation.failureCode, finishedAt: now, compensation, outbox: { ...outbox, state: "completed", claimToken: null, claimExpiresAt: null, completedAt: now } };
      await recordDelivery(tx, graph, input, claimTokenHash, responseHash, { retryScheduled: false, superseded: false, attemptState: "succeeded", compensation });
      await audit(tx, "pos.payment.compensation.provider_succeeded", compensation.id, { attemptId: graph.id, provider: compensation.provider, operationReference: compensation.providerOperationReference, evidenceHash: compensation.evidenceHash, providerVersion, applicationVersion });
      return completionDto(graph, { replayed: false, retryScheduled: false, superseded: false });
    }
    let status: string;
    let providerState: string;
    const applicationState = "not_ready";
    const confirmedAmountCents: number | null = null;
    let providerResultPersistedAt: Date | null = null;
    let nextReconcileAt: Date | null = null;
    if (observation.state === "declined") {
      status = "declined";
      providerState = "declined";
      providerResultPersistedAt = now;
    } else {
      status = "processing";
      providerState = "processing";
      nextReconcileAt = new Date(now.valueOf() + 30_000);
    }
    const version = graph.compensation.version + 1;
    const compensation = await tx.posPaymentCompensation.update({ where: { id: graph.compensationId }, data: {
      status, providerState, applicationState, version,
      confirmedAmountCents,
      providerOperationReference: observation.state === "processing" ? graph.compensation.providerOperationReference : observation.providerOperationReference,
      providerSequence: observation.providerSequence,
      providerOccurredAt: observation.state === "processing" ? graph.compensation.providerOccurredAt : observation.occurredAt,
      evidenceHash: observation.state === "processing" ? graph.compensation.evidenceHash : observation.evidenceHash,
      failureCode: observation.failureCode,
      failureMessage: observation.failureMessage,
      unknownSince: null,
      nextReconcileAt,
      providerResultPersistedAt,
    } });
    await tx.posPaymentCompensationAttempt.update({ where: { id: graph.id }, data: { state: "succeeded", outcomeUnknown: false, responseHash, failureCode: observation.failureCode, finishedAt: now } });
    await completeOutbox(tx, outbox.id, now, null, true);
    await createStateEvent(tx, compensation.id, graph.id, `compensation-result:${graph.id}:${outbox.deliveryCount}`, "worker", graph.id, before, status, version, observation.occurredAt, observation.evidenceHash);
    if (observation.state === "processing") await ensureQueryAttempt(tx, compensation, now, 30_000);
    graph = { ...graph, state: "succeeded", outcomeUnknown: false, responseHash, failureCode: observation.failureCode, finishedAt: now, compensation, outbox: { ...outbox, state: "completed", claimToken: null, claimExpiresAt: null, completedAt: now } };
    await recordDelivery(tx, graph, input, claimTokenHash, responseHash, { retryScheduled: false, superseded: false, attemptState: "succeeded", compensation });
    await audit(tx, `pos.payment.compensation.provider_${observation.state}`, compensation.id, { attemptId: graph.id, provider: compensation.provider, operationReference: compensation.providerOperationReference, evidenceHash: compensation.evidenceHash, version });
    return completionDto(graph, { replayed: false, retryScheduled: false, superseded: false });
  }).catch((error) => {
    if (prismaCode(error) === "P2002") throw new PosPaymentCompensationError("A referência do provedor já pertence a outra compensação.", 409);
    throw error;
  });
}

/** T2: materializes exactly one local refund after an immutable provider success. */
export async function applyPosPaymentCompensation(db: RootDb, compensationIdValue: string, nowValue = new Date()) {
  const compensationId = safeIdentifier(compensationIdValue, "Compensação", 1, 160);
  const now = validDate(nowValue);
  // This is allocated outside serializableRetry so a retry of this logical
  // application retains the same local refund identity.
  const refundPaymentId = randomUUID();
  try {
    return await serializableRetry(db, async (tx) => {
      const locator = await tx.posPaymentCompensation.findUnique({ where: { id: compensationId }, select: { originalPaymentId: true, saleId: true } });
      if (!locator) throw new PosPaymentCompensationError("Compensação não encontrada.", 404);
      await prelockPosSalePaymentWriteGraph(tx, {
        mode: "historical_refund",
        existingPaymentIds: [locator.originalPaymentId],
        allowLegacyNoPlanPayments: true,
        refundOriginalPaymentIds: [locator.originalPaymentId],
        insertIdempotencyKeys: [`pos-compensation:${compensationId}`],
      });
      await lockCompensation(tx, compensationId);
      const compensation = await tx.posPaymentCompensation.findUnique({ where: { id: compensationId } });
      if (!compensation) throw new PosPaymentCompensationError("Compensação não encontrada.", 404);
      if (compensation.originalPaymentId !== locator.originalPaymentId) throw new PosPaymentCompensationError("O pagamento original da compensação mudou durante o pré-lock.", 409);
      const [original, existingRefund, blockingIncident] = await Promise.all([
        tx.posSalePayment.findUnique({ where: { id: compensation.originalPaymentId } }),
        tx.posSalePayment.findUnique({ where: { compensationId } }),
        tx.posPaymentCompensationIncident.findFirst({ where: { compensationId, productionBlocking: true, status: { not: "resolved" } }, select: { id: true } }),
      ]);
      if (existingRefund) {
        assertAppliedReplay(compensation, original, existingRefund);
        return applicationDto(compensation, existingRefund, true);
      }
      if (!original || original.type !== "payment") throw new PosPaymentCompensationError("Pagamento original da compensação não encontrado.", 409);
      if (blockingIncident) throw new PosPaymentCompensationError("A compensação possui incidente de integridade bloqueante.", 409);
      if (compensation.status !== "application_pending" || compensation.providerState !== "succeeded" || compensation.applicationState !== "pending"
        || !compensation.confirmedAmountCents || compensation.confirmedAmountCents !== compensation.requestedAmountCents
        || !compensation.providerOperationReference || !compensation.providerOccurredAt || !compensation.evidenceHash || !compensation.providerResultPersistedAt) {
        throw new PosPaymentCompensationError("A compensação ainda não possui sucesso imutável do provedor para aplicação.", 409);
      }
      if (original.saleId !== compensation.saleId || original.method !== compensation.method || original.provider !== compensation.provider
        || original.connectorId !== compensation.connectorId || !["captured", "partially_refunded"].includes(original.status)) {
        throw new PosPaymentCompensationError("O pagamento original mudou ou não está elegível para aplicação.", 409);
      }
      await tx.$queryRaw(Prisma.sql`SELECT "id" FROM "pos_sale_payments" WHERE "original_payment_id" = ${original.id} FOR UPDATE`);
      const refundBalance = await tx.posSalePayment.aggregate({ where: { originalPaymentId: original.id, type: "refund" }, _sum: { amountCents: true } });
      const previousRefundedCents = refundBalance._sum.amountCents ?? 0;
      const refundedCents = previousRefundedCents + compensation.confirmedAmountCents;
      if (refundedCents > original.amountCents) throw new PosPaymentCompensationError("A aplicação excederia o saldo do pagamento original.", 409);
      const originalStatus = refundedCents === original.amountCents ? "refunded" : "partially_refunded";
      const version = compensation.version + 1;
      await tx.posPaymentCompensation.update({ where: { id: compensation.id }, data: { status: "applied", applicationState: "applied", version, appliedAt: now } });
      const refundIdempotencyKey = `pos-compensation:${compensation.id}`;
      const refundMetadata = json({ compensationId: compensation.id, kind: compensation.kind, evidenceHash: compensation.evidenceHash, providerSequence: compensation.providerSequence?.toString() ?? null, providerOccurredAt: compensation.providerOccurredAt.toISOString() });
      await preparePosSalePaymentWrite(tx, {
        action: "insert_refund_compensation", id: refundPaymentId, expectedVersion: -1,
        actorUserId: "system:pos-payment-compensation-application", idempotencyKey: refundIdempotencyKey,
        target: posSalePaymentWriteTarget({
          id: refundPaymentId, saleId: compensation.saleId, connectorId: compensation.connectorId,
          originalPaymentId: original.id, processingSessionId: compensation.sessionId, type: "refund",
          method: compensation.method, status: "refunded", amountCents: compensation.confirmedAmountCents,
          tenderedCents: 0, changeCents: 0, provider: compensation.provider,
          transactionId: compensation.providerOperationReference, installments: 1,
          idempotencyKey: refundIdempotencyKey, compensationId: compensation.id,
          refundedAt: compensation.providerOccurredAt, metadata: refundMetadata,
        }),
      });
      const refund = await tx.posSalePayment.create({ data: {
        id: refundPaymentId,
        saleId: compensation.saleId,
        connectorId: compensation.connectorId,
        originalPaymentId: original.id,
        processingSessionId: compensation.sessionId,
        paymentPlanId: null,
        paymentIndex: null,
        type: "refund",
        method: compensation.method,
        status: "refunded",
        amountCents: compensation.confirmedAmountCents,
        tenderedCents: 0,
        changeCents: 0,
        provider: compensation.provider,
        transactionId: compensation.providerOperationReference,
        installments: 1,
        idempotencyKey: refundIdempotencyKey,
        compensationId: compensation.id,
        refundedAt: compensation.providerOccurredAt,
        metadata: refundMetadata,
      } });
      const originalUpdateKey = `${refundIdempotencyKey}:original-status`;
      await preparePosSalePaymentWrite(tx, {
        action: "update_refund_status", id: original.id, expectedVersion: -1,
        actorUserId: "system:pos-payment-compensation-application", idempotencyKey: originalUpdateKey,
        target: posSalePaymentWriteTarget({ ...original, status: originalStatus,
          metadata: original.metadata == null ? null : json(original.metadata),
          refundedAt: null }),
      });
      await tx.posSalePayment.update({ where: { id: original.id }, data: { status: originalStatus, refundedAt: originalStatus === "refunded" ? now : null } });
      await createStateEvent(tx, compensation.id, null, `compensation-applied:${compensation.id}`, "application", compensation.id, compensation.status, "applied", version, compensation.providerOccurredAt, compensation.evidenceHash);
      await audit(tx, "pos.payment.compensation.applied", compensation.id, { originalPaymentId: original.id, refundPaymentId: refund.id, amountCents: refund.amountCents, previousRefundedCents, resultingRefundedCents: refundedCents, resultingOriginalStatus: originalStatus, evidenceHash: compensation.evidenceHash });
      return applicationDto({ ...compensation, status: "applied", applicationState: "applied", version, appliedAt: now }, refund, false);
    });
  } catch (error) {
    if (prismaCode(error) === "P2002") {
      const replay = await db.posPaymentCompensation.findUnique({ where: { id: compensationId }, include: { materializedRefund: true, originalPayment: true } });
      if (replay?.materializedRefund) {
        assertAppliedReplay(replay, replay.originalPayment, replay.materializedRefund);
        return applicationDto(replay, replay.materializedRefund, true);
      }
    }
    if (!isSerializationConflict(error) && isApplicationFailure(error)) await markApplicationBlocked(db, compensationId, error);
    throw error;
  }
}

export async function maintainPosPaymentCompensations(db: RootDb, options: { now?: Date; batchSize?: number; correlationId?: string } = {}) {
  const now = validDate(options.now ?? new Date());
  const batchSize = bounded(options.batchSize ?? POS_PAYMENT_COMPENSATION_WORK_LIMITS.defaultBatchSize, 1, POS_PAYMENT_COMPENSATION_WORK_LIMITS.maximumBatchSize, "Lote");
  const correlationId = options.correlationId ? safeIdentifier(options.correlationId, "Correlação", 1, 160) : randomUUID();
  const maintenance = await serializableRetry(db, async (tx) => {
    const lock = await tx.$queryRaw<Array<{ acquired: boolean }>>(Prisma.sql`SELECT pg_try_advisory_xact_lock(hashtextextended('pos-payment-compensation-maintenance', 0)) AS acquired`);
    if (!lock[0]?.acquired) return { correlationId, skippedConcurrent: 1, recoveredLeases: 0, scheduledQueries: 0, deadAttempts: 0, applicationIds: [] as string[] };
    const expired = await tx.$queryRaw<Array<{ compensationId: string; attemptId: string; outboxId: bigint }>>(Prisma.sql`
      SELECT c."id" AS "compensationId", a."id" AS "attemptId", o."id" AS "outboxId"
      FROM "pos_payment_compensation_outbox" o
      JOIN "pos_payment_compensation_attempts" a ON a."id" = o."attempt_id"
      JOIN "pos_payment_compensations" c ON c."id" = a."compensation_id"
      WHERE o."state" = 'claimed' AND o."claim_expires_at" <= ${now}
      ORDER BY o."claim_expires_at", o."id" LIMIT ${batchSize}
      FOR UPDATE OF c SKIP LOCKED
    `);
    let recoveredLeases = 0;
    let scheduledQueries = 0;
    for (const row of expired) {
      await lockAttempt(tx, row.attemptId);
      await lockOutbox(tx, row.outboxId);
      const graph = await tx.posPaymentCompensationAttempt.findUnique({ where: { id: row.attemptId }, include: { outbox: true, compensation: true } });
      if (!graph?.outbox || graph.outbox.state !== "claimed" || !graph.outbox.claimExpiresAt || graph.outbox.claimExpiresAt > now) continue;
      const responseHash = hashPosPaymentCompensationPayload({ kind: "unknown", failureCode: "claim_expired" });
      await tx.posPaymentCompensationAttempt.update({ where: { id: graph.id }, data: { state: "unknown", outcomeUnknown: true, responseHash, failureCode: "claim_expired", finishedAt: now } });
      await completeOutbox(tx, graph.outbox.id, now, "claim_expired", true);
      if (!graph.compensation.providerResultPersistedAt && !["applied", "declined", "cancelled"].includes(graph.compensation.status)) {
        const version = graph.compensation.version + 1;
        const compensation = await tx.posPaymentCompensation.update({ where: { id: graph.compensation.id }, data: { status: "unknown", providerState: "unknown", applicationState: "not_ready", version, unknownSince: graph.compensation.unknownSince ?? now, nextReconcileAt: new Date(now.valueOf() + 60_000), failureCode: "claim_expired", failureMessage: null } });
        await createStateEvent(tx, compensation.id, graph.id, `compensation-lease-expired:${graph.id}`, "maintenance", correlationId, graph.compensation.status, "unknown", version, null, null);
        if (await ensureQueryAttempt(tx, compensation, now, 60_000)) scheduledQueries += 1;
      }
      recoveredLeases += 1;
    }

    const due = await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`
      SELECT c."id" FROM "pos_payment_compensations" c
      WHERE c."provider_state" = 'unknown' AND c."next_reconcile_at" <= ${now}
      ORDER BY c."next_reconcile_at", c."id" LIMIT ${batchSize}
      FOR UPDATE SKIP LOCKED
    `);
    for (const row of due) {
      const compensation = await tx.posPaymentCompensation.findUniqueOrThrow({ where: { id: row.id } });
      if (await ensureQueryAttempt(tx, compensation, now, 0)) scheduledQueries += 1;
    }

    const exhausted = await tx.$queryRaw<Array<{ compensationId: string; attemptId: string; outboxId: bigint }>>(Prisma.sql`
      SELECT c."id" AS "compensationId", a."id" AS "attemptId", o."id" AS "outboxId"
      FROM "pos_payment_compensation_outbox" o
      JOIN "pos_payment_compensation_attempts" a ON a."id" = o."attempt_id"
      JOIN "pos_payment_compensations" c ON c."id" = a."compensation_id"
      WHERE o."state" IN ('pending', 'retry') AND o."delivery_count" >= o."max_deliveries"
      ORDER BY o."id" LIMIT ${batchSize} FOR UPDATE OF c SKIP LOCKED
    `);
    let deadAttempts = 0;
    for (const row of exhausted) {
      await lockAttempt(tx, row.attemptId);
      await lockOutbox(tx, row.outboxId);
      const graph = await tx.posPaymentCompensationAttempt.findUnique({ where: { id: row.attemptId }, include: { outbox: true, compensation: true } });
      if (!graph?.outbox || !["pending", "retry"].includes(graph.outbox.state) || graph.outbox.deliveryCount < graph.outbox.maxDeliveries) continue;
      await tx.posPaymentCompensationAttempt.update({ where: { id: graph.id }, data: { state: "failed", outcomeUnknown: false, responseHash: graph.responseHash ?? hashPosPaymentCompensationPayload({ kind: "known_failure", failureCode: "delivery_exhausted" }), failureCode: "delivery_exhausted", finishedAt: now } });
      await tx.posPaymentCompensationOutbox.update({ where: { id: graph.outbox.id }, data: { state: "dead", completedAt: now, claimToken: null, claimExpiresAt: null, lastErrorCode: "delivery_exhausted" } });
      if (!graph.compensation.providerResultPersistedAt && !["applied", "declined", "cancelled"].includes(graph.compensation.status)) {
        const version = graph.compensation.version + 1;
        await tx.posPaymentCompensation.update({ where: { id: graph.compensation.id }, data: { status: "manual_review", providerState: "manual_review", applicationState: "not_ready", version, unknownSince: null, nextReconcileAt: null, failureCode: "delivery_exhausted", failureMessage: null } });
        await createStateEvent(tx, graph.compensation.id, graph.id, `compensation-delivery-dead:${graph.id}`, "maintenance", correlationId, graph.compensation.status, "manual_review", version, null, null);
      }
      deadAttempts += 1;
    }
    const applications = await tx.posPaymentCompensation.findMany({ where: { status: "application_pending", providerState: "succeeded", applicationState: "pending", integrityIncidents: { none: { productionBlocking: true, status: { not: "resolved" } } } }, select: { id: true }, orderBy: { providerResultPersistedAt: "asc" }, take: batchSize });
    const result = { correlationId, skippedConcurrent: 0, recoveredLeases, scheduledQueries, deadAttempts, applicationIds: applications.map((item) => item.id) };
    await audit(tx, "pos.payment.compensation.maintenance", correlationId, { ...result, applicationIds: result.applicationIds.length });
    return result;
  });
  let applied = 0;
  let applicationFailures = 0;
  for (const compensationId of maintenance.applicationIds) {
    try { await applyPosPaymentCompensation(db, compensationId, now); applied += 1; }
    catch { applicationFailures += 1; }
  }
  return { ...maintenance, applicationIds: undefined, applied, applicationFailures };
}

export async function acceptPosPaymentCompensationCallback(db: RootDb, providerValue: string, eventIdValue: string, signatureKeyIdValue: string, payloadHashValue: string, input: PosPaymentCompensationCallbackInput) {
  const provider = providerKey(providerValue);
  const eventId = safeIdentifier(eventIdValue, "Evento", 8, 160);
  const signatureKeyId = safeIdentifier(signatureKeyIdValue, "Chave de assinatura", 1, 160);
  const payloadHash = sha256(payloadHashValue, "Hash do payload");
  const receivedAt = new Date();
  const replay = await db.posPaymentCompensationCallback.findUnique({ where: { provider_eventId: { provider, eventId } }, include: { integrityIncident: true } });
  if (replay) return replayCallback(replay, payloadHash);
  return serializableRetry(db, async (tx) => {
    await lockCompensation(tx, input.compensationId);
    const concurrent = await tx.posPaymentCompensationCallback.findUnique({ where: { provider_eventId: { provider, eventId } }, include: { integrityIncident: true } });
    if (concurrent) return replayCallback(concurrent, payloadHash);
    let compensation = await tx.posPaymentCompensation.findUnique({ where: { id: input.compensationId } });
    if (!compensation) throw new PosPaymentCompensationError("Compensação do callback não encontrada.", 404);
    const beforeStatus = compensation.status;
    const evidence = observationEvidence(input);
    const mismatch = observationMismatch(compensation, { ...input, provider });
    let processingResult: "applied" | "no_change" | "ignored_stale" | "rejected_context" | "rejected_transition" | "manual_review" = "no_change";
    let incidentKind: "amount_mismatch" | "reference_mismatch" | null = null;
    if (mismatch) {
      const version = compensation.version + 1;
      compensation = compensation.providerResultPersistedAt
        ? await tx.posPaymentCompensation.update({ where: { id: compensation.id }, data: {
          status: "manual_review",
          applicationState: compensation.providerState === "succeeded" ? "blocked" : compensation.applicationState,
          version,
          failureCode: mismatch.kind,
          failureMessage: null,
        } })
        : await tx.posPaymentCompensation.update({ where: { id: compensation.id }, data: {
          status: "manual_review", providerState: "manual_review", applicationState: "not_ready", version,
          failureCode: mismatch.kind, failureMessage: null, unknownSince: null, nextReconcileAt: null,
        } });
      await createStateEvent(tx, compensation.id, null, `compensation-callback-review:${provider}:${eventId}`, "callback", eventId, beforeStatus, "manual_review", version, input.occurredAt, input.evidenceHash);
      processingResult = "manual_review";
      incidentKind = mismatch.kind;
    } else if (compensation.providerResultPersistedAt) {
      const agrees = input.state === (compensation.providerState === "succeeded" ? "succeeded" : compensation.providerState)
        && input.providerOperationReference === compensation.providerOperationReference
        && input.confirmedAmountCents === (compensation.confirmedAmountCents ?? input.confirmedAmountCents)
        && input.evidenceHash === compensation.evidenceHash;
      processingResult = agrees ? "no_change" : "manual_review";
      if (!agrees) {
        incidentKind = "reference_mismatch";
        const version = compensation.version + 1;
        compensation = await tx.posPaymentCompensation.update({ where: { id: compensation.id }, data: {
          status: "manual_review",
          applicationState: compensation.providerState === "succeeded" ? "blocked" : compensation.applicationState,
          version,
          failureCode: "contradictory_result",
          failureMessage: null,
        } });
        await createStateEvent(tx, compensation.id, null, `compensation-callback-review:${provider}:${eventId}`, "callback", eventId, beforeStatus, "manual_review", version, input.occurredAt, input.evidenceHash);
      }
    } else if (isObservationStale(compensation, input)) {
      processingResult = "ignored_stale";
    } else {
      let version = compensation.version + 1;
      if (input.state === "succeeded") {
        const providerSucceeded = await tx.posPaymentCompensation.update({ where: { id: compensation.id }, data: { status: "provider_succeeded", providerState: "succeeded", applicationState: "not_ready", version, confirmedAmountCents: input.confirmedAmountCents, providerOperationReference: input.providerOperationReference, providerSequence: input.providerSequence, providerOccurredAt: input.occurredAt, evidenceHash: input.evidenceHash, failureCode: input.failureCode, failureMessage: input.failureMessage, unknownSince: null, nextReconcileAt: null, providerResultPersistedAt: receivedAt } });
        await createStateEvent(tx, providerSucceeded.id, null, `compensation-callback:${provider}:${eventId}:provider`, "callback", eventId, beforeStatus, "provider_succeeded", version, input.occurredAt, input.evidenceHash);
        version += 1;
        compensation = await tx.posPaymentCompensation.update({ where: { id: compensation.id }, data: { status: "application_pending", applicationState: "pending", version } });
        await createStateEvent(tx, compensation.id, null, `compensation-callback:${provider}:${eventId}:application`, "callback", eventId, "provider_succeeded", "application_pending", version, input.occurredAt, input.evidenceHash);
      } else if (input.state === "declined") {
        compensation = await tx.posPaymentCompensation.update({ where: { id: compensation.id }, data: { status: "declined", providerState: "declined", applicationState: "not_ready", version, confirmedAmountCents: null, providerOperationReference: input.providerOperationReference, providerSequence: input.providerSequence, providerOccurredAt: input.occurredAt, evidenceHash: input.evidenceHash, failureCode: input.failureCode, failureMessage: input.failureMessage, unknownSince: null, nextReconcileAt: null, providerResultPersistedAt: receivedAt } });
      } else if (input.state === "unknown") {
        compensation = await tx.posPaymentCompensation.update({ where: { id: compensation.id }, data: { status: "unknown", providerState: "unknown", applicationState: "not_ready", version, failureCode: input.failureCode, failureMessage: input.failureMessage, unknownSince: compensation.unknownSince ?? receivedAt, nextReconcileAt: new Date(receivedAt.valueOf() + 60_000) } });
        await ensureQueryAttempt(tx, compensation, receivedAt, 60_000);
      } else {
        compensation = await tx.posPaymentCompensation.update({ where: { id: compensation.id }, data: { status: "processing", providerState: "processing", applicationState: "not_ready", version, failureCode: input.failureCode, failureMessage: input.failureMessage, unknownSince: null, nextReconcileAt: new Date(receivedAt.valueOf() + 30_000) } });
        await ensureQueryAttempt(tx, compensation, receivedAt, 30_000);
      }
      if (input.state !== "succeeded") await createStateEvent(tx, compensation.id, null, `compensation-callback:${provider}:${eventId}`, "callback", eventId, beforeStatus, compensation.status, version, input.occurredAt, input.evidenceHash);
      processingResult = "applied";
    }
    const callback = await tx.posPaymentCompensationCallback.create({ data: { compensationId: compensation.id, provider, eventId, payloadHash, signatureKeyId, originalProviderReference: input.originalProviderReference, providerOperationReference: input.providerOperationReference, reportedState: input.state, providerSequence: input.providerSequence, providerOccurredAt: input.occurredAt, requestedAmountCents: input.requestedAmountCents, confirmedAmountCents: input.confirmedAmountCents, currency: input.currency, evidenceHash: input.evidenceHash, evidence: json(evidence), processingResult, resultingState: compensation.status, resultingVersion: compensation.version } });
    const incident = incidentKind ? await tx.posPaymentCompensationIncident.create({ data: { compensationId: compensation.id, callbackId: callback.id, kind: incidentKind, status: "open", productionBlocking: true, expectedAmountCents: compensation.requestedAmountCents, reportedAmountCents: input.confirmedAmountCents, expectedEvidenceHash: authoritativeEvidenceHash(compensation), reportedEvidenceHash: hashPosPaymentCompensationPayload(evidence), details: json({ eventId, provider, reportedState: input.state, mismatch: mismatch?.reason ?? "contradictory persisted result" }) } }) : null;
    await audit(tx, `pos.payment.compensation.callback.${processingResult}`, compensation.id, { provider, eventId, reportedState: input.state, resultingState: compensation.status, resultingVersion: compensation.version, payloadHash, incidentId: incident?.id ?? null });
    return { accepted: true, duplicate: false, applied: processingResult === "applied", result: processingResult, compensationId: compensation.id, state: compensation.status, version: compensation.version, callbackId: callback.id.toString(), incident: incident ? { id: incident.id, kind: incident.kind, productionBlocking: incident.productionBlocking } : null };
  }).catch(async (error) => {
    if (isSerializationConflict(error) || prismaCode(error) === "P2002") {
      const concurrent = await db.posPaymentCompensationCallback.findUnique({ where: { provider_eventId: { provider, eventId } }, include: { integrityIncident: true } });
      if (concurrent) return replayCallback(concurrent, payloadHash);
    }
    if (prismaCode(error) === "P2002") throw new PosPaymentCompensationError("A referência do provedor já pertence a outra compensação.", 409);
    throw error;
  });
}

function isClaimEligible(graph: LockedGraph, now: Date) {
  if (!graph.outbox || !["pending", "retry"].includes(graph.outbox.state) || graph.outbox.nextAttemptAt > now || graph.outbox.deliveryCount >= graph.outbox.maxDeliveries || !["queued", "retry"].includes(graph.state)) return false;
  if (graph.operation === "query") return ["processing", "unknown", "manual_review"].includes(graph.compensation.status);
  return graph.operation === graph.compensation.kind && ["requested", "processing"].includes(graph.compensation.status);
}

function isOperationCurrent(graph: LockedGraph) {
  if (graph.operation === "query") return ["processing", "unknown", "manual_review"].includes(graph.compensation.status) && !graph.compensation.providerResultPersistedAt;
  return graph.operation === graph.compensation.kind && ["requested", "processing"].includes(graph.compensation.status) && !graph.compensation.providerResultPersistedAt;
}

async function persistUnknown(tx: Prisma.TransactionClient, graph: LockedGraph, input: PosPaymentCompensationOutboxCompletion, claimTokenHash: string, responseHash: string, now: Date, failureCode: string, failureMessage: string | null) {
  const outbox = graph.outbox!;
  const version = graph.compensation.version + 1;
  const compensation = await tx.posPaymentCompensation.update({ where: { id: graph.compensationId }, data: { status: "unknown", providerState: "unknown", applicationState: "not_ready", version, failureCode, failureMessage, unknownSince: graph.compensation.unknownSince ?? now, nextReconcileAt: new Date(now.valueOf() + 60_000) } });
  await tx.posPaymentCompensationAttempt.update({ where: { id: graph.id }, data: { state: "unknown", outcomeUnknown: true, responseHash, failureCode, finishedAt: now } });
  await completeOutbox(tx, outbox.id, now, failureCode, true);
  await createStateEvent(tx, compensation.id, graph.id, `compensation-unknown:${graph.id}:${outbox.deliveryCount}`, "worker", graph.id, graph.compensation.status, "unknown", version, null, null);
  await ensureQueryAttempt(tx, compensation, now, 60_000);
  const result = { ...graph, state: "unknown", outcomeUnknown: true, responseHash, failureCode, finishedAt: now, compensation, outbox: { ...outbox, state: "completed", claimToken: null, claimExpiresAt: null, completedAt: now } };
  await recordDelivery(tx, result, input, claimTokenHash, responseHash, { retryScheduled: false, superseded: false, attemptState: "unknown", compensation });
  await audit(tx, "pos.payment.compensation.provider_unknown", compensation.id, { attemptId: graph.id, failureCode, version });
  return result;
}

async function persistWorkerIncident(tx: Prisma.TransactionClient, graph: LockedGraph, input: PosPaymentCompensationOutboxCompletion, claimTokenHash: string, responseHash: string, now: Date, mismatch: { kind: "amount_mismatch" | "reference_mismatch"; reason: string }) {
  const outbox = graph.outbox!;
  const observation = input.result as Extract<PosPaymentCompensationOutboxCompletion["result"], { kind: "result" }>;
  const version = graph.compensation.version + 1;
  const compensation = await tx.posPaymentCompensation.update({ where: { id: graph.compensationId }, data: { status: "manual_review", providerState: "manual_review", applicationState: "not_ready", version, failureCode: mismatch.kind, failureMessage: null, unknownSince: null, nextReconcileAt: null } });
  await tx.posPaymentCompensationAttempt.update({ where: { id: graph.id }, data: { state: "failed", outcomeUnknown: false, responseHash, failureCode: mismatch.kind, finishedAt: now } });
  await completeOutbox(tx, outbox.id, now, mismatch.kind, true);
  await tx.posPaymentCompensationIncident.create({ data: { compensationId: compensation.id, kind: mismatch.kind, status: "open", productionBlocking: true, expectedAmountCents: compensation.requestedAmountCents, reportedAmountCents: observation.confirmedAmountCents, expectedEvidenceHash: authoritativeEvidenceHash(compensation), reportedEvidenceHash: hashPosPaymentCompensationPayload(observationEvidence(observation)), details: json({ source: "worker", attemptId: graph.id, reason: mismatch.reason }) } });
  await createStateEvent(tx, compensation.id, graph.id, `compensation-incident:${graph.id}:${outbox.deliveryCount}`, "worker", graph.id, graph.compensation.status, "manual_review", version, observation.occurredAt, observation.evidenceHash);
  const result = { ...graph, state: "failed", outcomeUnknown: false, responseHash, failureCode: mismatch.kind, finishedAt: now, compensation, outbox: { ...outbox, state: "completed", claimToken: null, claimExpiresAt: null, completedAt: now } };
  await recordDelivery(tx, result, input, claimTokenHash, responseHash, { retryScheduled: false, superseded: false, attemptState: "failed", compensation });
  return result;
}

async function closeSuperseded(tx: Prisma.TransactionClient, graph: LockedGraph, input: PosPaymentCompensationOutboxCompletion, claimTokenHash: string, responseHash: string, now: Date) {
  const outbox = graph.outbox!;
  await tx.posPaymentCompensationAttempt.update({ where: { id: graph.id }, data: { state: "failed", outcomeUnknown: false, responseHash, failureCode: "compensation_state_advanced", finishedAt: now } });
  await completeOutbox(tx, outbox.id, now, "compensation_state_advanced", true);
  const result = { ...graph, state: "failed", outcomeUnknown: false, responseHash, failureCode: "compensation_state_advanced", finishedAt: now, outbox: { ...outbox, state: "completed", claimToken: null, claimExpiresAt: null, completedAt: now } };
  await recordDelivery(tx, result, input, claimTokenHash, responseHash, { retryScheduled: false, superseded: true, attemptState: "failed", compensation: graph.compensation });
  return result;
}

async function ensureQueryAttempt(tx: Prisma.TransactionClient, compensation: Prisma.PosPaymentCompensationGetPayload<object>, now: Date, delayMs: number) {
  const active = await tx.posPaymentCompensationAttempt.findFirst({ where: { compensationId: compensation.id, operation: "query", state: { in: ["queued", "claimed", "retry"] } }, select: { id: true } });
  if (active) return false;
  const maximum = await tx.posPaymentCompensationAttempt.aggregate({ where: { compensationId: compensation.id }, _max: { sequence: true } });
  const sequence = (maximum._max.sequence ?? 0) + 1;
  const attemptId = randomUUID();
  const operationKey = `comp:${compensation.id}:query:${sequence}`;
  const requestHash = hashPosPaymentCompensationPayload({ compensationId: compensation.id, operation: "query", sequence, originalProviderReference: compensation.originalProviderReference, providerOperationReference: compensation.providerOperationReference });
  await tx.posPaymentCompensationAttempt.create({ data: { id: attemptId, compensationId: compensation.id, sequence, operation: "query", operationKey, requestHash, providerIdempotencyKey: operationKey, outbox: { create: { nextAttemptAt: new Date(now.valueOf() + delayMs) } } } });
  return true;
}

async function markApplicationBlocked(db: RootDb, compensationId: string, error: unknown) {
  try {
    await serializableRetry(db, async (tx) => {
      await lockCompensation(tx, compensationId);
      const compensation = await tx.posPaymentCompensation.findUnique({ where: { id: compensationId } });
      if (!compensation || compensation.status !== "application_pending" || compensation.providerState !== "succeeded" || compensation.applicationState !== "pending") return;
      const existing = await tx.posPaymentCompensationIncident.findFirst({ where: { compensationId, kind: "application_failure", status: { not: "resolved" } }, select: { id: true } });
      const version = compensation.version + 1;
      await tx.posPaymentCompensation.update({ where: { id: compensation.id }, data: { status: "manual_review", applicationState: "blocked", version, failureCode: "application_failure", failureMessage: null } });
      if (!existing) await tx.posPaymentCompensationIncident.create({ data: { compensationId, kind: "application_failure", status: "open", productionBlocking: true, expectedAmountCents: compensation.confirmedAmountCents ?? compensation.requestedAmountCents, reportedAmountCents: 0, expectedEvidenceHash: authoritativeEvidenceHash(compensation), reportedEvidenceHash: hashPosPaymentCompensationPayload({ code: safeErrorCode(error) }), details: json({ code: safeErrorCode(error) }) } });
      await createStateEvent(tx, compensation.id, null, `compensation-application-failed:${compensation.id}:${version}`, "application", compensation.id, compensation.status, "manual_review", version, compensation.providerOccurredAt, compensation.evidenceHash);
      await audit(tx, "pos.payment.compensation.application_blocked", compensation.id, { version, errorCode: safeErrorCode(error) });
    });
  } catch {
    // Preserve the original T2 error. Maintenance will retry or surface the
    // still-pending item if even the fail-closed marker cannot be persisted.
  }
}

async function lockCompensationGraph(tx: Prisma.TransactionClient, attemptId: string) {
  const locator = await tx.posPaymentCompensationAttempt.findUnique({ where: { id: attemptId }, select: { compensationId: true, outbox: { select: { id: true } } } });
  if (!locator?.outbox) throw new PosPaymentCompensationError("Tentativa compensatória não encontrada.", 404);
  await lockCompensation(tx, locator.compensationId);
  await lockAttempt(tx, attemptId);
  await lockOutbox(tx, locator.outbox.id);
  const graph = await tx.posPaymentCompensationAttempt.findUnique({ where: { id: attemptId }, include: { outbox: true, compensation: true } });
  if (!graph?.outbox) throw new PosPaymentCompensationError("Tentativa compensatória não encontrada.", 404);
  return graph;
}

async function lockCompensation(tx: Prisma.TransactionClient, id: string) { await tx.$queryRaw(Prisma.sql`SELECT "id" FROM "pos_payment_compensations" WHERE "id" = ${id} FOR UPDATE`); }
async function lockAttempt(tx: Prisma.TransactionClient, id: string) { await tx.$queryRaw(Prisma.sql`SELECT "id" FROM "pos_payment_compensation_attempts" WHERE "id" = ${id} FOR UPDATE`); }
async function lockOutbox(tx: Prisma.TransactionClient, id: bigint) { await tx.$queryRaw(Prisma.sql`SELECT "id" FROM "pos_payment_compensation_outbox" WHERE "id" = ${id} FOR UPDATE`); }
async function completeOutbox(tx: Prisma.TransactionClient, id: bigint, now: Date, errorCode: string | null, completed: boolean) {
  await tx.posPaymentCompensationOutbox.update({ where: { id }, data: { state: completed ? "completed" : "dead", claimToken: null, claimExpiresAt: null, lastErrorCode: errorCode, completedAt: now } });
}

async function recordDelivery(tx: Prisma.TransactionClient, graph: LockedGraph, input: PosPaymentCompensationOutboxCompletion, claimTokenHash: string, responseHash: string, outcome: { retryScheduled: boolean; superseded: boolean; attemptState: string; compensation: { id: string; status: string; version: number } }) {
  if (!graph.outbox) throw new PosPaymentCompensationError("Outbox ausente no registro da entrega.", 409);
  await tx.posPaymentCompensationDeliveryResult.create({ data: { compensationId: outcome.compensation.id, attemptId: graph.id, outboxId: graph.outbox.id, deliveryNumber: graph.outbox.deliveryCount, claimTokenHash, responseHash, resultKind: input.result.kind, retryScheduled: outcome.retryScheduled, superseded: outcome.superseded, resultingAttemptState: outcome.attemptState, resultingCompensationState: outcome.compensation.status, resultingCompensationVersion: outcome.compensation.version } });
}

async function createStateEvent(tx: Prisma.TransactionClient, compensationId: string, attemptId: string | null, eventKey: string, source: string, sourceId: string, fromState: string | null, toState: string, resultingVersion: number, providerOccurredAt: Date | null, evidenceHash: string | null) {
  await tx.posPaymentCompensationStateEvent.create({ data: { compensationId, attemptId, eventKey, source, sourceId, fromState, toState, resultingVersion, providerOccurredAt, evidenceHash } });
}

async function audit(tx: Prisma.TransactionClient, action: string, entityId: string, afterData: Record<string, unknown>) {
  await tx.tenantAuditEvent.create({ data: { actorId: null, action, entityType: "pos_payment_compensation", entityId, correlationId: randomUUID(), afterData: json(afterData) } });
}

function compensationOutboxCommand(graph: LockedGraph, claimToken: string, claimExpiresAt: Date) {
  const compensation = graph.compensation;
  return { outboxId: graph.outbox!.id.toString(), attemptId: graph.id, operation: graph.operation, claimToken, claimExpiresAt, providerIdempotencyKey: graph.providerIdempotencyKey, compensation: { id: compensation.id, provider: compensation.provider, originalProviderReference: compensation.originalProviderReference, providerOperationReference: compensation.providerOperationReference, requestedAmountCents: compensation.requestedAmountCents, currency: compensation.currency, method: compensation.method, kind: compensation.kind, branchId: compensation.branchId, registerId: compensation.registerId, sessionId: compensation.sessionId, terminalId: compensation.terminalId, connectorId: compensation.connectorId, credentialRef: compensation.credentialRef } };
}

function completionDto(graph: LockedGraph, outcome: { replayed: boolean; retryScheduled: boolean; superseded: boolean }) {
  return { ...outcome, compensation: compensationDto(graph.compensation), attempt: { id: graph.id, sequence: graph.sequence, operation: graph.operation, state: graph.state, outcomeUnknown: graph.outcomeUnknown, failureCode: graph.failureCode, finishedAt: graph.finishedAt } };
}

function compensationDto(compensation: { id: string; status: string; providerState: string; applicationState: string; version: number; requestedAmountCents: number; confirmedAmountCents: number | null; providerOperationReference: string | null; providerOccurredAt: Date | null; evidenceHash: string | null; unknownSince: Date | null; nextReconcileAt: Date | null; providerResultPersistedAt: Date | null; appliedAt: Date | null }) {
  return { id: compensation.id, status: compensation.status, providerState: compensation.providerState, applicationState: compensation.applicationState, version: compensation.version, requestedAmountCents: compensation.requestedAmountCents, confirmedAmountCents: compensation.confirmedAmountCents, providerOperationReference: compensation.providerOperationReference, providerOccurredAt: compensation.providerOccurredAt, evidenceHash: compensation.evidenceHash, unknownSince: compensation.unknownSince, nextReconcileAt: compensation.nextReconcileAt, providerResultPersistedAt: compensation.providerResultPersistedAt, appliedAt: compensation.appliedAt };
}

function applicationDto(compensation: { id: string; status: string; providerState: string; applicationState: string; version: number; appliedAt: Date | null }, refund: { id: string; originalPaymentId: string | null; compensationId: string | null; amountCents: number; status: string }, replayed: boolean) {
  return { replayed, compensation: { id: compensation.id, status: compensation.status, providerState: compensation.providerState, applicationState: compensation.applicationState, version: compensation.version, appliedAt: compensation.appliedAt }, refund: { id: refund.id, originalPaymentId: refund.originalPaymentId, compensationId: refund.compensationId, amountCents: refund.amountCents, status: refund.status } };
}

function assertAppliedReplay(compensation: { id: string; status: string; providerState: string; applicationState: string; confirmedAmountCents: number | null }, original: { id: string; status: string; amountCents: number } | null, refund: { originalPaymentId: string | null; compensationId: string | null; amountCents: number; type: string; status: string }) {
  if (!original || compensation.status !== "applied" || compensation.providerState !== "succeeded" || compensation.applicationState !== "applied" || refund.compensationId !== compensation.id || refund.originalPaymentId !== original.id || refund.type !== "refund" || refund.amountCents !== compensation.confirmedAmountCents || !["partially_refunded", "refunded"].includes(original.status)) throw new PosPaymentCompensationError("O replay da aplicação diverge da compensação persistida.", 409);
}

function observationMismatch(compensation: { id: string; provider: string; originalProviderReference: string; requestedAmountCents: number; currency: string }, observation: PosPaymentCompensationObservation) {
  if (observation.compensationId !== compensation.id) return { kind: "reference_mismatch" as const, reason: "compensation_id" };
  if (observation.provider !== compensation.provider || observation.originalProviderReference !== compensation.originalProviderReference) return { kind: "reference_mismatch" as const, reason: "provider_reference" };
  if (observation.requestedAmountCents !== compensation.requestedAmountCents || observation.currency !== compensation.currency || observation.state === "succeeded" && observation.confirmedAmountCents !== compensation.requestedAmountCents) return { kind: "amount_mismatch" as const, reason: "amount_or_currency" };
  return null;
}

function isObservationStale(compensation: { providerSequence: bigint | null; providerOccurredAt: Date | null }, observation: PosPaymentCompensationObservation) {
  if (observation.providerSequence != null && compensation.providerSequence != null) return observation.providerSequence <= compensation.providerSequence;
  return compensation.providerOccurredAt != null && observation.occurredAt <= compensation.providerOccurredAt;
}

function authoritativeEvidenceHash(compensation: { id: string; provider: string; originalProviderReference: string; requestedAmountCents: number; currency: string; providerOperationReference: string | null; evidenceHash: string | null }) {
  return hashPosPaymentCompensationPayload({ compensationId: compensation.id, provider: compensation.provider, originalProviderReference: compensation.originalProviderReference, requestedAmountCents: compensation.requestedAmountCents, currency: compensation.currency, providerOperationReference: compensation.providerOperationReference, evidenceHash: compensation.evidenceHash });
}

function observationEvidence(value: PosPaymentCompensationObservation) {
  return { compensationId: value.compensationId, provider: value.provider, originalProviderReference: value.originalProviderReference, providerOperationReference: value.providerOperationReference, state: value.state, requestedAmountCents: value.requestedAmountCents, confirmedAmountCents: value.confirmedAmountCents, currency: value.currency, providerSequence: value.providerSequence?.toString() ?? null, occurredAt: value.occurredAt.toISOString(), evidenceHash: value.evidenceHash, failureCode: value.failureCode };
}

function replayCallback(callback: { id: bigint; compensationId: string; payloadHash: string; processingResult: string; resultingState: string; resultingVersion: number; integrityIncident?: { id: string; kind: string; productionBlocking: boolean } | null }, payloadHash: string) {
  if (callback.payloadHash !== payloadHash) throw new PosPaymentCompensationError("O evento do callback já foi usado com outro conteúdo.", 409);
  return { accepted: true, duplicate: true, applied: false, result: callback.processingResult, compensationId: callback.compensationId, state: callback.resultingState, version: callback.resultingVersion, callbackId: callback.id.toString(), incident: callback.integrityIncident ? { id: callback.integrityIncident.id, kind: callback.integrityIncident.kind, productionBlocking: callback.integrityIncident.productionBlocking } : null };
}

function json(value: unknown): Prisma.InputJsonValue { return value as Prisma.InputJsonValue; }
function retryDelayMs(delivery: number) { return Math.min(15 * 60_000, 2 ** Math.min(delivery, 8) * 1_000); }
function safeErrorCode(error: unknown) { const code = error && typeof error === "object" && "code" in error ? String((error as { code?: unknown }).code || "") : ""; return code && code.length <= 80 ? code : "application_failure"; }
function prismaCode(error: unknown) { return error && typeof error === "object" && "code" in error ? String((error as { code?: unknown }).code || "") : ""; }
function isSerializationConflict(error: unknown) { return ["P2034", "40001", "40P01"].includes(prismaCode(error)); }
function isApplicationFailure(error: unknown) { return error instanceof PosPaymentCompensationError ? error.status === 409 : true; }

async function serializableRetry<T>(db: RootDb, operation: (tx: Prisma.TransactionClient) => Promise<T>): Promise<T> {
  for (let attempt = 1; attempt <= POS_PAYMENT_COMPENSATION_WORK_LIMITS.serializationRetries; attempt += 1) {
    try { return await db.$transaction(operation, { isolationLevel: "Serializable", maxWait: 10_000, timeout: 30_000 }); }
    catch (error) { if (!isSerializationConflict(error) || attempt === POS_PAYMENT_COMPENSATION_WORK_LIMITS.serializationRetries) throw error; }
  }
  throw new PosPaymentCompensationError("A transação compensatória não pôde ser serializada.", 409);
}

function rejectSensitiveData(value: unknown, depth = 0, fieldName = ""): void {
  if (depth > 8) throw new PosPaymentCompensationError("Payload compensatório excede a profundidade permitida.", 400);
  if (typeof value === "string" && /(?:reference|operation|evidence|failure|event|key|token|worker)/i.test(fieldName) && containsPosPaymentPanInIdentifier(value)) throw new PosPaymentCompensationError("Dados de cartão não são aceitos no payload compensatório.", 400);
  if (Array.isArray(value)) { for (const item of value) rejectSensitiveData(item, depth + 1, fieldName); return; }
  if (!value || typeof value !== "object") return;
  for (const [field, item] of Object.entries(value as Record<string, unknown>)) {
    if (/(?:pan|cvv|cvc|track|pin_?block|card_?number|numero_?cartao|full_?card)/i.test(field)) throw new PosPaymentCompensationError("Dados de cartão não são aceitos no payload compensatório.", 400);
    rejectSensitiveData(item, depth + 1, field);
  }
}
function onlyKeys(value: Record<string, unknown>, allowed: readonly string[]) { const extra = Object.keys(value).find((key) => !allowed.includes(key)); if (extra) throw new PosPaymentCompensationError(`Campo compensatório não permitido: ${extra}.`, 400); }
function record(value: unknown, label: string) { if (!value || typeof value !== "object" || Array.isArray(value)) throw new PosPaymentCompensationError(`${label} inválido.`, 400); return value as Record<string, unknown>; }
function choice<const T extends readonly string[]>(value: unknown, choices: T, label: string): T[number] { const result = String(value ?? "") as T[number]; if (!choices.includes(result)) throw new PosPaymentCompensationError(`${label} inválido.`, 400); return result; }
function safeIdentifier(value: unknown, label: string, minimum: number, maximum: number) { const result = String(value ?? "").normalize("NFKC").trim(); if (result.length < minimum || result.length > maximum || !/^[A-Za-z0-9._:-]+$/.test(result) || containsPosPaymentPanInIdentifier(result)) throw new PosPaymentCompensationError(`${label} inválido.`, 400); return result; }
function safeKey(value: unknown, label: string) { return safeIdentifier(value, label, 16, 160); }
function safeCode(value: unknown, label: string) { return safeIdentifier(value, label, 1, 80); }
function nullableText(value: unknown, label: string, maximum: number) { if (value == null || value === "") return null; const result = String(value).normalize("NFKC").trim(); if (!result || result.length > maximum || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(result) || containsPosPaymentPanInIdentifier(result)) throw new PosPaymentCompensationError(`${label} inválida.`, 400); return result; }
function providerKey(value: unknown) { const result = safeIdentifier(value, "Provedor", 2, 80).toLowerCase(); if (!/^[a-z0-9][a-z0-9._-]*$/.test(result)) throw new PosPaymentCompensationError("Provedor inválido.", 400); return result; }
function sha256(value: unknown, label: string) { const result = String(value ?? "").toLowerCase(); if (!/^[0-9a-f]{64}$/.test(result)) throw new PosPaymentCompensationError(`${label} inválido.`, 400); return result; }
function bounded(value: number, minimum: number, maximum: number, label: string) { if (!Number.isSafeInteger(value) || value < minimum || value > maximum) throw new PosPaymentCompensationError(`${label} inválido.`, 400); return value; }
function validDate(value: Date) { if (!(value instanceof Date) || !Number.isFinite(value.valueOf())) throw new PosPaymentCompensationError("Data inválida.", 400); return value; }
