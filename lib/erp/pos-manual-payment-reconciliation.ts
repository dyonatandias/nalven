import { createHash, randomUUID } from "node:crypto";
import { Prisma, type PrismaClient } from "@/generated/tenant/client";

type Db = PrismaClient;
type Tx = Prisma.TransactionClient;

export const POS_MANUAL_RECONCILIATION_LIMITS = Object.freeze({ defaultBatchSize: 10, maximumBatchSize: 50, defaultLeaseSeconds: 60, maximumLeaseSeconds: 300, maximumQueryCycles: 12, serializationRetries: 3 });
const POS_MANUAL_LEGACY_OPEN_DISABLED: boolean = true;
export type ManualProviderOutcome = "confirmed_paid" | "not_found" | "voided" | "refunded" | "unknown";

export class PosManualReconciliationError extends Error {
  constructor(message: string, public readonly status = 409, options?: ErrorOptions) { super(message, options); this.name = "PosManualReconciliationError"; }
}

/** The adapter owns a durable retry when orphan reconciliation returns deferred. */
export interface PosManualReferenceVaultAdapter {
  readonly adapterId: string;
  bindReference(input: { provider: string; rawReference: string; retentionExpiresAt: Date; idempotencyKey: string }): Promise<{
    vaultReference: string; vaultKeyId: string; bindingHash: string; stableReferenceIndex: string; referenceHash: string;
    referenceKeyId: string; referenceLastFour: string; retentionExpiresAt: Date; created: boolean;
  }>;
  reconcileOrphanBinding(input: { vaultReference: string; bindingHash: string; idempotencyKey: string; reason: "database_write_rejected" }): Promise<"released" | "already_absent" | "deferred">;
}

export type OpenManualPaymentCaseInput = { paymentPlanId: string; paymentIndex: 0; makerProfileId: number; makerUserId: string; rawReference: string; occurredAt: Date; reasonCode: string; idempotencyKey: string };
export type ManualPaymentQueryCompletionPayload = { attemptId: string; claimToken: string; provider: string; connectorRevision: number; credentialRevision: number; providerAdapterVersion: string; gateConfigHash: string; outcome: ManualProviderOutcome; referenceHash: string; method: string; amountCents: number; currency: string; evidenceHash: string; providerSequence?: bigint; providerOccurredAt?: Date; authKeyId: string };
export type CompleteManualPaymentQueryInput = ManualPaymentQueryCompletionPayload & { responseHash: string };

export async function openPosManualPaymentCase(db: Db, adapter: PosManualReferenceVaultAdapter | null, rawInput: OpenManualPaymentCaseInput) {
  if (POS_MANUAL_LEGACY_OPEN_DISABLED) throw new PosManualReconciliationError("A abertura legada com referência aberta foi desativada; use o boundary 321f isolado.", 503);
  if (!adapter) throw new PosManualReconciliationError("O cofre homologado de referência manual não está disponível.", 503);
  const input = normalizeOpenInput(rawInput);
  // 321f cutover: rawReference must never reach the application database path
  // or cause a vault mutation. Only the isolated prepare/claim/finalize
  // capabilities may open new cases; this legacy API remains as a hard-failed
  // compatibility symbol until its callers migrate.
  /* c8 ignore start -- unreachable legacy implementation retained for a later removal-only release. */
  const preview = await db.posPaymentPlan.findUnique({ where: { id: input.paymentPlanId }, include: { slots: true } });
  const previewSlot = preview?.slots[0];
  if (!preview || preview.slots.length !== 1 || previewSlot?.paymentIndex !== 0 || previewSlot.proofKind !== "manual" || !previewSlot.provider || !previewSlot.connectorId || !previewSlot.credentialRef) throw new PosManualReconciliationError("O plano não possui divisão manual única autoritativa.");
  // Avoid a vault mutation while the migration's deliberate hard-disable is active.
  const previewGate = await db.posManualPaymentReconciliationGate.findUnique({ where: { connectorId: previewSlot.connectorId } });
  if (!previewGate?.enabled || previewGate.vaultAdapterId !== adapter.adapterId) throw new PosManualReconciliationError("A reconciliação manual permanece desabilitada até a homologação integral do boundary.", 503);
  const vaultIdempotencyKey = `manual-vault:${input.idempotencyKey}`;
  const requestedRetentionExpiresAt = new Date(preview.expiresAt.valueOf() + 60_000);
  let binding: Awaited<ReturnType<PosManualReferenceVaultAdapter["bindReference"]>>;
  try { binding = await adapter.bindReference({ provider: previewSlot.provider, rawReference: input.rawReference, retentionExpiresAt: requestedRetentionExpiresAt, idempotencyKey: vaultIdempotencyKey }); }
  catch { throw new PosManualReconciliationError("O vault recusou o binding da referência manual.", 503); }
  try {
    validateVaultBinding(binding);
    if (binding.retentionExpiresAt > requestedRetentionExpiresAt) throw new PosManualReconciliationError("O vault excedeu a retenção máxima solicitada.", 503);
  } catch (validationError) {
    if (binding && typeof binding === "object" && binding.created === true) {
      if (!validVaultCleanupHandle(binding)) throw new PosManualReconciliationError("O binding inválido exige reconciliação segura pendente no vault.", 503);
      await reconcileVaultOrphan(adapter, binding, vaultIdempotencyKey);
    }
    if (validationError instanceof PosManualReconciliationError) throw validationError;
    throw new PosManualReconciliationError("O vault retornou um binding inválido.", 503);
  }
  const requestHash = digest({ paymentPlanId: input.paymentPlanId, paymentIndex: 0, makerProfileId: input.makerProfileId, makerUserId: input.makerUserId, occurredAt: input.occurredAt, reasonCode: input.reasonCode, stableReferenceIndex: binding.stableReferenceIndex });
  const caseId = randomUUID();
  let committed = false;
  try {
    const result = await transactionRetry(db, async tx => {
      const graph = await lockManualGraph(tx, { planId: input.paymentPlanId });
      const { plan, slot, connector, credential, now } = graph;
      assertLiveManualOperator(graph, input.makerProfileId, input.makerUserId, true);
      if (plan.state !== "active" || plan.expiresAt <= now) throw new PosManualReconciliationError("O plano manual não está ativo.");
      assertManualFoundationBoundary(graph, adapter.adapterId);
      if (input.occurredAt > new Date(now.valueOf() + 300_000) || input.occurredAt > plan.expiresAt) throw new PosManualReconciliationError("A data da referência manual é causalmente inválida.", 422);
      const persistedCaseExpiresAt = new Date(Math.min(plan.expiresAt.valueOf(), now.valueOf() + 15 * 60_000));
      if (binding.retentionExpiresAt <= persistedCaseExpiresAt || binding.retentionExpiresAt > new Date(plan.expiresAt.valueOf() + 60_000)) throw new PosManualReconciliationError("A retenção retornada pelo vault não cobre o TTL persistido ou excede a política.", 503);
      const replay = await tx.posManualPaymentCase.findUnique({ where: { branchId_makerUserId_idempotencyKey: { branchId: plan.branchId, makerUserId: input.makerUserId, idempotencyKey: input.idempotencyKey } } });
      if (replay) return replayManualCase(replay, requestHash, input.paymentPlanId);
      const draft = await tx.posHeldSale.findUniqueOrThrow({ where: { id: plan.saleDraftId } });
      if (draft.revision !== plan.draftRevision || draft.requestHash !== plan.draftRequestHash) throw new PosManualReconciliationError("O rascunho mudou durante a abertura do caso.");
      const created = await tx.posManualPaymentCase.create({ data: {
        id: caseId, branchId: plan.branchId, registerId: plan.registerId, sessionId: plan.sessionId, operatorProfileId: plan.operatorProfileId,
        terminalId: plan.terminalId, saleDraftId: plan.saleDraftId, draftRevision: plan.draftRevision, draftRequestHash: plan.draftRequestHash,
        quoteHash: plan.quoteHash, orderClaimId: plan.orderClaimId, paymentPlanId: plan.id, paymentIndex: 0, method: slot.method,
        amountCents: slot.amountCents, currency: plan.currency, installments: slot.installments, provider: slot.provider!, connectorId: connector.id,
        connectorRevision: connector.revision, credentialRef: credential.id, credentialRevision: credential.revision, referenceHash: binding.referenceHash,
        referenceKeyId: binding.referenceKeyId, referenceLastFour: binding.referenceLastFour, occurredAt: input.occurredAt, reasonCode: input.reasonCode,
        makerProfileId: input.makerProfileId, makerUserId: input.makerUserId, lifecycleTxid: 0, idempotencyKey: input.idempotencyKey, requestHash, expiresAt: plan.expiresAt,
      } });
      await tx.posManualPaymentVaultBinding.create({ data: { caseId, vaultProvider: adapter.adapterId, vaultReference: binding.vaultReference, vaultKeyId: binding.vaultKeyId, bindingHash: binding.bindingHash, stableReferenceIndex: binding.stableReferenceIndex, retentionExpiresAt: binding.retentionExpiresAt } });
      const operation = await tx.posManualPaymentOperation.create({ data: { caseId, action: "open", expectedVersion: -1, resultingVersion: 0, resultingState: "review_pending", idempotencyKey: `manual-open:${input.idempotencyKey}`, requestHash, writeTxid: 0 } });
      await tx.posManualPaymentStateEvent.create({ data: { caseId, operationId: operation.id, fromState: null, toState: "review_pending", resultingVersion: 0, source: "api", sourceId: operation.id.toString(), writeTxid: 0 } });
      return { case: manualCaseDto(created), replayed: false };
    });
    committed = true;
    return result;
  } catch (error) {
    // A transport failure may happen after COMMIT. Never release the vault
    // binding until the primary database has authoritatively disproved it.
    let replay: Prisma.PosManualPaymentCaseGetPayload<{ include: { vaultBinding: true } }> | null;
    try { replay = await db.posManualPaymentCase.findUnique({ where: { branchId_makerUserId_idempotencyKey: { branchId: preview.branchId, makerUserId: input.makerUserId, idempotencyKey: input.idempotencyKey } }, include: { vaultBinding: true } }); }
    catch (lookupError) { throw new PosManualReconciliationError("Resultado do commit é ambíguo; binding do vault preservado para reconciliação.", 503, { cause: lookupError }); }
    if (replay && replay.requestHash === requestHash && replay.paymentPlanId === input.paymentPlanId) {
      if (binding.created && replay.vaultBinding?.bindingHash !== binding.bindingHash) await reconcileVaultOrphan(adapter, binding, vaultIdempotencyKey);
      committed = true;
      return replayManualCase(replay, requestHash, input.paymentPlanId);
    }
    if (binding.created && !committed) await reconcileVaultOrphan(adapter, binding, vaultIdempotencyKey);
    throw error;
  }
  /* c8 ignore stop */
}

export async function reviewPosManualPaymentCase(db: Db, raw: { caseId: string; checkerProfileId: number; checkerUserId: string; assertionHash: string; decision: "authorize_query" | "reject"; reasonCode: string; idempotencyKey: string }) {
  const input = { caseId: uuid(raw.caseId, "Caso"), checkerProfileId: positiveInteger(raw.checkerProfileId, "Perfil checker"), checkerUserId: identifier(raw.checkerUserId, "Checker"), assertionHash: hex(raw.assertionHash, "Assertion"), decision: choice(raw.decision, ["authorize_query", "reject"] as const, "Decisão"), reasonCode: code(raw.reasonCode, "Motivo"), idempotencyKey: identifier(raw.idempotencyKey, "Idempotência") };
  const requestHash = digest({ caseId: input.caseId, checkerProfileId: input.checkerProfileId, checkerUserId: input.checkerUserId, assertionHash: input.assertionHash, decision: input.decision, reasonCode: input.reasonCode });
  const operationKey = `manual-review:${input.idempotencyKey}`;
  const prior = await db.posManualPaymentOperation.findUnique({ where: { idempotencyKey: operationKey }, include: { case: true, review: true } });
  if (prior) return replayReviewOperation(prior, prior.case, requestHash, input);
  try {
    return await transactionRetry(db, async tx => {
      const graph = await lockManualGraph(tx, { caseId: input.caseId, additionalAccessProfileIds: [input.checkerProfileId] });
      const current = graph.manualCase!;
      const operationReplay = await tx.posManualPaymentOperation.findUnique({ where: { idempotencyKey: operationKey } });
      if (operationReplay) {
        const reviewReplay = await tx.posManualPaymentReview.findUnique({ where: { id: operationReplay.reviewId! } });
        return replayReviewOperation({ ...operationReplay, review: reviewReplay }, current, requestHash, input);
      }
      // A committed replay remains readable after revocation, but only to the
      // exact checker identity and assertion already persisted in the review.
      assertLiveManualOperator(graph, current.makerProfileId, current.makerUserId, true);
      assertLiveManualReviewer(graph, input.checkerProfileId, input.checkerUserId, current.amountCents);
      if (current.state !== "review_pending" || current.expiresAt <= graph.now) throw new PosManualReconciliationError("O caso não aguarda revisão ou expirou.");
      if (current.makerProfileId === input.checkerProfileId || current.makerUserId === input.checkerUserId) throw new PosManualReconciliationError("Maker e checker devem ser pessoas e perfis distintos.", 403);
      const assertion = await tx.posManualPaymentStepUpAssertion.findUnique({ where: { assertionHash: input.assertionHash } });
      if (!assertion || assertion.caseId !== current.id || assertion.checkerProfileId !== input.checkerProfileId || assertion.checkerUserId !== input.checkerUserId || assertion.purpose !== "manual_payment.review" || assertion.requestHash !== requestHash || assertion.consumedReviewId || assertion.expiresAt <= graph.now) throw new PosManualReconciliationError("Assertion de step-up inválida, expirada ou já consumida.", 403);
      const branchGrant = await tx.branchUserAccess.findUnique({ where: { branchId_userProfileId: { branchId: current.branchId, userProfileId: input.checkerProfileId } } });
      const registerGrant = await tx.posRegisterAccess.findUnique({ where: { registerId_userProfileId: { registerId: current.registerId, userProfileId: input.checkerProfileId } } });
      if (!branchGrant?.canSell || !registerGrant?.active || !registerGrant.canReviewManualPayment || registerGrant.manualPaymentReviewLimitCents < current.amountCents || registerGrant.validFrom && registerGrant.validFrom > graph.now || registerGrant.validUntil && registerGrant.validUntil < graph.now) throw new PosManualReconciliationError("O checker não possui autoridade vigente para este valor.", 403);
      const reviewId = randomUUID(), nextState = input.decision === "reject" ? "rejected" : "unknown", nextVersion = current.version + 1;
      const review = await tx.posManualPaymentReview.create({ data: { id: reviewId, caseId: current.id, decision: input.decision, makerProfileId: current.makerProfileId, makerUserId: current.makerUserId, checkerProfileId: input.checkerProfileId, checkerUserId: input.checkerUserId, stepUpEvidenceId: assertion.id, stepUpProofHash: assertion.assertionHash, stepUpVerifiedAt: assertion.verifiedAt, stepUpExpiresAt: assertion.expiresAt, branchGrantId: branchGrant.id, registerGrantId: registerGrant.id, grantValidFrom: registerGrant.validFrom, grantValidUntil: registerGrant.validUntil, authorityLimitCents: registerGrant.manualPaymentReviewLimitCents, reasonCode: input.reasonCode, idempotencyKey: input.idempotencyKey, requestHash, writeTxid: 0 } });
      const operation = await tx.posManualPaymentOperation.create({ data: { caseId: current.id, action: input.decision === "reject" ? "reject" : "authorize_query", expectedVersion: current.version, resultingVersion: nextVersion, resultingState: nextState, actorProfileId: input.checkerProfileId, reviewId: review.id, idempotencyKey: operationKey, requestHash, writeTxid: 0 } });
      await tx.posManualPaymentStateEvent.create({ data: { caseId: current.id, operationId: operation.id, fromState: current.state, toState: nextState, resultingVersion: nextVersion, source: "api", sourceId: review.id, writeTxid: 0 } });
      await tx.posManualPaymentCase.update({ where: { id: current.id }, data: { state: nextState, version: nextVersion, reviewedAt: graph.now, ...(nextState === "unknown" ? { providerOutcome: "unknown", unknownSince: graph.now, nextReconcileAt: graph.now } : { rejectedAt: graph.now }) } });
      if (input.decision === "authorize_query") await tx.posManualPaymentAttempt.create({ data: { id: randomUUID(), caseId: current.id, sequence: 1, providerIdempotencyKey: `manual-query:${current.id}:1`, requestHash, outbox: { create: { nextAttemptAt: graph.now } } } });
      return { case: manualCaseDto(await tx.posManualPaymentCase.findUniqueOrThrow({ where: { id: current.id } })), replayed: false };
    });
  } catch (error) {
    if (prismaCode(error) === "P2002") {
      const replay = await db.posManualPaymentOperation.findUnique({ where: { idempotencyKey: operationKey }, include: { case: true, review: true } });
      if (replay) return replayReviewOperation(replay, replay.case, requestHash, input);
    }
    throw error;
  }
}

export async function claimPosManualPaymentQueries(db: Db, raw: { workerId: string; limit?: number; leaseSeconds?: number }) {
  const workerId = identifier(raw.workerId, "Worker");
  const limit = bounded(raw.limit ?? POS_MANUAL_RECONCILIATION_LIMITS.defaultBatchSize, 1, POS_MANUAL_RECONCILIATION_LIMITS.maximumBatchSize, "Lote");
  const leaseSeconds = bounded(raw.leaseSeconds ?? POS_MANUAL_RECONCILIATION_LIMITS.defaultLeaseSeconds, 15, POS_MANUAL_RECONCILIATION_LIMITS.maximumLeaseSeconds, "Lease");
  return transactionRetry(db, async tx => {
    const selectionNow = await databaseClock(tx), candidateLimit = Math.min(500, Math.max(limit * 8, limit + 16));
    const candidates = await tx.$queryRaw<Array<{ caseId: string; attemptId: string; outboxId: bigint }>>(Prisma.sql`
      WITH due_sessions AS MATERIALIZED (
        SELECT session."id",MIN(outbox."next_attempt_at") first_due,MIN(outbox."id") first_outbox
        FROM "cash_register_sessions" session
        JOIN "pos_manual_payment_cases" manual_case ON manual_case."session_id"=session."id"
        JOIN "pos_manual_payment_attempts" attempt ON attempt."case_id"=manual_case."id"
        JOIN "pos_manual_payment_outbox" outbox ON outbox."attempt_id"=attempt."id"
        WHERE manual_case."state"='unknown' AND ((attempt."state" IN ('queued','retry') AND outbox."state" IN ('pending','retry') AND outbox."next_attempt_at"<=${selectionNow})
          OR (attempt."state"='claimed' AND outbox."state"='claimed' AND outbox."claim_expires_at"<=${selectionNow}))
        GROUP BY session."id"
      ), locked_sessions AS MATERIALIZED (
        SELECT session."id" FROM "cash_register_sessions" session JOIN due_sessions due ON due."id"=session."id"
        ORDER BY due.first_due,due.first_outbox,session."id" FOR UPDATE OF session SKIP LOCKED LIMIT ${candidateLimit}
      ), ranked_candidates AS MATERIALIZED (
        SELECT manual_case."id" "caseId",attempt."id" "attemptId",outbox."id" "outboxId",manual_case."session_id" "sessionId",
          row_number() OVER (PARTITION BY manual_case."session_id" ORDER BY outbox."next_attempt_at",outbox."id") "sessionRank",
          outbox."next_attempt_at" "nextAttemptAt"
        FROM "pos_manual_payment_outbox" outbox
        JOIN "pos_manual_payment_attempts" attempt ON attempt."id"=outbox."attempt_id"
        JOIN "pos_manual_payment_cases" manual_case ON manual_case."id"=attempt."case_id"
        JOIN locked_sessions locked_session ON locked_session."id"=manual_case."session_id"
        WHERE manual_case."state"='unknown' AND ((attempt."state" IN ('queued','retry') AND outbox."state" IN ('pending','retry') AND outbox."next_attempt_at"<=${selectionNow})
          OR (attempt."state"='claimed' AND outbox."state"='claimed' AND outbox."claim_expires_at"<=${selectionNow}))
      )
      SELECT "caseId","attemptId","outboxId" FROM ranked_candidates WHERE "sessionRank"=1
      ORDER BY "nextAttemptAt","outboxId" LIMIT ${candidateLimit}`);
    const claimed: Array<{ attemptId: string; attemptSequence: number; providerIdempotencyKey: string; claimToken: string; claimExpiresAt: Date; caseId: string; vaultReference: string; provider: string; connectorRevision: number; credentialRevision: number; providerAdapterVersion: string; gateConfigHash: string }> = [];
    let blockedCount = 0;
    for (const candidate of candidates) {
      if (claimed.length >= limit) break;
      const graph = await lockManualGraph(tx, { caseId: candidate.caseId, attemptId: candidate.attemptId, outboxId: candidate.outboxId });
      const current = graph.manualCase!, attempt = graph.attempt!, outbox = graph.outbox!, now = graph.now;
      const expiredClaim = attempt.state === "claimed" && outbox.state === "claimed" && Boolean(outbox.claimExpiresAt && outbox.claimExpiresAt <= now);
      const dueQueued = ["queued", "retry"].includes(attempt.state) && ["pending", "retry"].includes(outbox.state) && outbox.nextAttemptAt <= now;
      if (current.state !== "unknown" || !expiredClaim && !dueQueued) continue;
      const failure = manualDispatchBoundaryFailure(graph, now);
      if (failure || outbox.deliveryCount >= outbox.maxDeliveries) {
        await blockQueuedManualCase(tx, graph, failure ?? "maximum_deliveries_reached", now);
        blockedCount += 1;
        continue;
      }
      const claimToken = `${workerId}:${randomUUID()}`, claimExpiresAt = new Date(now.valueOf() + leaseSeconds * 1_000), deliveryCount = outbox.deliveryCount + 1;
      // A timed-out query is safe to redispatch only because the provider key is immutable and idempotent.
      await tx.posManualPaymentAttempt.update({ where: { id: attempt.id }, data: { state: "claimed", dispatchCount: { increment: 1 }, outcomeUnknown: expiredClaim || attempt.outcomeUnknown, startedAt: now } });
      await tx.posManualPaymentOutbox.update({ where: { id: outbox.id }, data: { state: "claimed", claimToken, claimExpiresAt, deliveryCount, lastErrorCode: null } });
      const vault = await tx.posManualPaymentVaultBinding.findUniqueOrThrow({ where: { caseId: current.id } });
      claimed.push({ attemptId: attempt.id, attemptSequence: attempt.sequence, providerIdempotencyKey: attempt.providerIdempotencyKey, claimToken, claimExpiresAt, caseId: current.id, vaultReference: vault.vaultReference, provider: current.provider, connectorRevision: graph.connector.revision, credentialRevision: graph.credential.revision, providerAdapterVersion: graph.gate!.providerAdapterVersion!, gateConfigHash: graph.gate!.configHash! });
    }
    const accountingNow = await databaseClock(tx);
    const remainingDue = await tx.posManualPaymentOutbox.count({ where: { OR: [
      { state: { in: ["pending", "retry"] }, nextAttemptAt: { lte: accountingNow }, attempt: { state: { in: ["queued", "retry"] }, case: { state: "unknown" } } },
      { state: "claimed", claimExpiresAt: { lte: accountingNow }, attempt: { state: "claimed", case: { state: "unknown" } } },
    ] } });
    return { workerId, claimed, claimedCount: claimed.length, blockedCount, remainingDue, hasMore: remainingDue > 0 };
  }, Prisma.TransactionIsolationLevel.ReadCommitted);
}

export async function completePosManualPaymentQuery(db: Db, raw: CompleteManualPaymentQueryInput) {
  const input = normalizeCompletionInput(raw), canonicalResponseHash = hashManualPaymentQueryCompletion(input);
  if (canonicalResponseHash !== input.responseHash) throw new PosManualReconciliationError("O hash da resposta não corresponde ao payload canônico.", 422);
  // Legacy callers cannot manufacture a provider proof. Until they migrate to
  // the authenticated boundary procedures, the only safe interpretation is a
  // transport whose outcome is unknown; no provider fact or T1 confirmation is
  // accepted through this API.
  if (input.outcome !== "unknown") throw new PosManualReconciliationError("Resultados do provider exigem prova autenticada persistida pelo boundary.", 503);
  const claimTokenHash = digest(input.claimToken);
  return transactionRetry(db, async tx => {
    const locator = await tx.posManualPaymentAttempt.findUnique({ where: { id: input.attemptId }, select: { caseId: true, outbox: { select: { id: true } } } });
    if (!locator?.outbox) throw new PosManualReconciliationError("Tentativa manual não encontrada.", 404);
    const graph = await lockManualGraph(tx, { caseId: locator.caseId, attemptId: input.attemptId, outboxId: locator.outbox.id });
    const current = graph.manualCase!, attempt = graph.attempt!, outbox = graph.outbox!;
    const replay = await tx.posManualPaymentDeliveryResult.findUnique({ where: { claimTokenHash } });
    if (replay) {
      if (replay.attemptId !== input.attemptId || replay.responseHash !== canonicalResponseHash) throw new PosManualReconciliationError("O claim já foi concluído com outro conteúdo.");
      return { case: manualCaseDto(current), replayed: true, retryScheduled: replay.retryable, superseded: replay.superseded };
    }
    if (current.state !== "unknown") throw new PosManualReconciliationError("O caso manual não está em estado unknown para conclusão do worker.");
    if (attempt.state !== "claimed" || outbox.state !== "claimed" || outbox.claimToken !== input.claimToken || !outbox.claimExpiresAt || outbox.claimExpiresAt <= graph.now) throw new PosManualReconciliationError("O lease expirou ou pertence a outro worker.");
    if (input.connectorRevision !== current.connectorRevision || input.connectorRevision !== graph.connector.revision || input.connectorRevision !== graph.gate?.connectorRevision
      || input.credentialRevision !== current.credentialRevision || input.credentialRevision !== graph.credential.revision || input.credentialRevision !== graph.gate?.credentialRevision
      || input.providerAdapterVersion !== graph.gate?.providerAdapterVersion || input.gateConfigHash !== graph.gate?.configHash) throw new PosManualReconciliationError("A attestation do worker diverge das revisões autoritativas.");
    const allowedAuthKeyIds = manualCallbackAuthKeyIds(graph.credential.config);
    if (!allowedAuthKeyIds.includes(input.authKeyId)) throw new PosManualReconciliationError("A chave autenticadora não pertence à credencial atestada.", 403);
    if (input.provider !== current.provider || input.referenceHash !== current.referenceHash || input.method !== current.method || input.amountCents !== current.amountCents || input.currency !== current.currency) throw new PosManualReconciliationError("O resultado do provider diverge do caso manual autoritativo.");
    assertProviderCausality(input, current.occurredAt, graph.now, current.expiresAt);
    const maximum = await tx.$queryRaw<Array<{ maximum: bigint | null }>>(Prisma.sql`SELECT max(delivery."provider_sequence") maximum FROM "pos_manual_payment_delivery_results" delivery JOIN "pos_manual_payment_attempts" prior ON prior."id"=delivery."attempt_id" WHERE prior."case_id"=${current.id}::uuid`);
    if (input.providerSequence != null && maximum[0]?.maximum != null && input.providerSequence <= maximum[0].maximum) throw new PosManualReconciliationError("A sequência do provider não é monotônica.");

    const boundaryFailure = manualDispatchBoundaryFailure(graph, graph.now);
    if (boundaryFailure) throw new PosManualReconciliationError("O boundary manual mudou; transporte legado não pode ser concluído.", 503);
    if (attempt.sequence < POS_MANUAL_RECONCILIATION_LIMITS.maximumQueryCycles && current.expiresAt > graph.now) {
      const nextAttemptAt = new Date(graph.now.valueOf() + retryDelayMs(attempt.sequence));
      await tx.posManualPaymentDeliveryResult.create({ data: { attemptId: attempt.id, deliveryNumber: outbox.deliveryCount, claimTokenHash, responseHash: canonicalResponseHash, resultKind: "transport_outcome_unknown", outcome: "unknown", evidenceHash: input.evidenceHash, providerSequence: null, occurredAt: null, retryable: true, superseded: false, resultingState: current.state, resultingVersion: current.version, processingResult: "retry_scheduled", completionIdempotencyKey: `legacy-transport:${claimTokenHash}` } });
      await tx.posManualPaymentAttempt.update({ where: { id: attempt.id }, data: { state: "unknown", outcomeUnknown: true, finishedAt: graph.now } });
      await tx.posManualPaymentOutbox.update({ where: { id: outbox.id }, data: { state: "completed", claimToken: null, claimExpiresAt: null, completedAt: graph.now, lastErrorCode: "provider_outcome_unknown" } });
      const nextSequence = attempt.sequence + 1;
      await tx.posManualPaymentAttempt.create({ data: { id: randomUUID(), caseId: current.id, sequence: nextSequence, providerIdempotencyKey: `manual-query:${current.id}:${nextSequence}`, requestHash: digest({ caseId: current.id, sequence: nextSequence, reason: "provider_outcome_unknown" }), outbox: { create: { nextAttemptAt } } } });
      await tx.posManualPaymentCase.update({ where: { id: current.id }, data: { providerOutcome: "unknown", unknownSince: current.unknownSince ?? graph.now, nextReconcileAt: nextAttemptAt } });
      return { case: manualCaseDto(await tx.posManualPaymentCase.findUniqueOrThrow({ where: { id: current.id } })), replayed: false, retryScheduled: true, superseded: false };
    }
    throw new PosManualReconciliationError("O limite de sondagens foi atingido; o fechamento exige a procedure de transporte autenticada.", 503);
  });
}

type LockedManualGraph = Awaited<ReturnType<typeof lockManualGraph>>;

/** Canonical order: session -> terminal -> access -> claim -> draft -> plan/slot -> connector -> credential -> gate -> case -> attempt -> outbox. */
async function lockManualGraph(tx: Tx, input: { planId?: string; caseId?: string; attemptId?: string; outboxId?: bigint; additionalAccessProfileIds?: number[] }) {
  const caseLocator = input.caseId ? await tx.posManualPaymentCase.findUnique({ where: { id: input.caseId }, select: { paymentPlanId: true, connectorId: true, credentialRef: true } }) : null;
  if (input.caseId && !caseLocator) throw new PosManualReconciliationError("Caso manual não encontrado.", 404);
  const planId = input.planId ?? caseLocator!.paymentPlanId;
  const locator = await tx.posPaymentPlan.findUnique({ where: { id: planId }, select: { branchId: true, registerId: true, sessionId: true, operatorProfileId: true, terminalId: true, orderClaimId: true, saleDraftId: true } });
  if (!locator) throw new PosManualReconciliationError("Plano manual não encontrado.", 404);
  await tx.$queryRaw(Prisma.sql`SELECT "id" FROM "cash_register_sessions" WHERE "id"=${locator.sessionId} FOR UPDATE`);
  await tx.$queryRaw(Prisma.sql`SELECT "id" FROM "pos_terminals" WHERE "id"=${locator.terminalId} FOR UPDATE`);
  const profiles = [...new Set([locator.operatorProfileId, ...(input.additionalAccessProfileIds ?? [])])].sort((a, b) => a - b);
  for (const profileId of profiles) {
    await tx.$queryRaw(Prisma.sql`SELECT "id" FROM "tenant_user_profiles" WHERE "id"=${profileId} FOR SHARE`);
    await tx.$queryRaw(Prisma.sql`SELECT "id" FROM "branches" WHERE "id"=${locator.branchId} FOR SHARE`);
    await tx.$queryRaw(Prisma.sql`SELECT "id" FROM "pos_registers" WHERE "id"=${locator.registerId} FOR SHARE`);
    await tx.$queryRaw(Prisma.sql`SELECT "id" FROM "branch_user_accesses" WHERE "branch_id"=${locator.branchId} AND "user_profile_id"=${profileId} FOR SHARE`);
    await tx.$queryRaw(Prisma.sql`SELECT "id" FROM "pos_register_accesses" WHERE "register_id"=${locator.registerId} AND "user_profile_id"=${profileId} FOR SHARE`);
  }
  if (locator.orderClaimId) await tx.$queryRaw(Prisma.sql`SELECT "id" FROM "pos_order_claims" WHERE "id"=${locator.orderClaimId} FOR UPDATE`);
  await tx.$queryRaw(Prisma.sql`SELECT "id" FROM "pos_held_sales" WHERE "id"=${locator.saleDraftId} FOR UPDATE`);
  await tx.$queryRaw(Prisma.sql`SELECT "id" FROM "pos_payment_plans" WHERE "id"=${planId} FOR UPDATE`);
  const plan = await tx.posPaymentPlan.findUniqueOrThrow({ where: { id: planId } });
  await tx.$queryRaw(Prisma.sql`SELECT "plan_id" FROM "pos_payment_plan_slots" WHERE "plan_id"=${planId} AND "payment_index"=0 FOR UPDATE`);
  const slot = await tx.posPaymentPlanSlot.findUniqueOrThrow({ where: { planId_paymentIndex: { planId, paymentIndex: 0 } } });
  const connectorId = caseLocator?.connectorId ?? slot.connectorId, credentialRef = caseLocator?.credentialRef ?? slot.credentialRef;
  if (!connectorId || !credentialRef) throw new PosManualReconciliationError("O slot manual não possui boundary completo.");
  await tx.$queryRaw(Prisma.sql`SELECT "id" FROM "pos_connectors" WHERE "id"=${connectorId} FOR SHARE`);
  const connector = await tx.posConnector.findUniqueOrThrow({ where: { id: connectorId } });
  await tx.$queryRaw(Prisma.sql`SELECT "id" FROM "integration_credentials" WHERE "id"=${credentialRef} FOR SHARE`);
  const credential = await tx.integrationCredential.findUniqueOrThrow({ where: { id: credentialRef }, include: { provider: true } });
  await tx.$queryRaw(Prisma.sql`SELECT "connector_id" FROM "pos_manual_payment_reconciliation_gates" WHERE "connector_id"=${connectorId} FOR SHARE`);
  const gate = await tx.posManualPaymentReconciliationGate.findUnique({ where: { connectorId } });
  if (input.caseId) await tx.$queryRaw(Prisma.sql`SELECT "id" FROM "pos_manual_payment_cases" WHERE "id"=${input.caseId}::uuid FOR UPDATE`);
  const manualCase = input.caseId ? await tx.posManualPaymentCase.findUniqueOrThrow({ where: { id: input.caseId } }) : null;
  if (input.attemptId) await tx.$queryRaw(Prisma.sql`SELECT "id" FROM "pos_manual_payment_attempts" WHERE "id"=${input.attemptId}::uuid FOR UPDATE`);
  const attempt = input.attemptId ? await tx.posManualPaymentAttempt.findUniqueOrThrow({ where: { id: input.attemptId } }) : null;
  if (input.outboxId != null) await tx.$queryRaw(Prisma.sql`SELECT "id" FROM "pos_manual_payment_outbox" WHERE "id"=${input.outboxId} FOR UPDATE`);
  const outbox = input.outboxId != null ? await tx.posManualPaymentOutbox.findUniqueOrThrow({ where: { id: input.outboxId } }) : null;
  const now = await databaseClock(tx);
  const session = await tx.cashRegisterSession.findUnique({ where: { id: locator.sessionId } });
  const terminal = await tx.posTerminal.findUnique({ where: { id: locator.terminalId }, include: { register: { include: { branch: true } } } });
  const access = [];
  for (const profileId of profiles) {
    const profile = await tx.tenantUserProfile.findUnique({ where: { id: profileId } });
    const branchGrant = await tx.branchUserAccess.findUnique({ where: { branchId_userProfileId: { branchId: locator.branchId, userProfileId: profileId } } });
    const registerGrant = await tx.posRegisterAccess.findUnique({ where: { registerId_userProfileId: { registerId: locator.registerId, userProfileId: profileId } } });
    access.push({ profileId, profile, branchGrant, registerGrant });
  }
  return { plan, slot, connector, credential, gate, manualCase, attempt, outbox, now, session, terminal, access };
}

function assertLiveManualOperator(graph: LockedManualGraph, profileId: number, userId: string, requireManualPayment: boolean) {
  const { plan, session, terminal, now } = graph, snapshot = graph.access.find(item => item.profileId === profileId);
  if (plan.operatorProfileId !== profileId || snapshot?.profile?.userId !== userId || snapshot.profile.status !== "active"
    || !session || session.id !== plan.sessionId || session.registerId !== plan.registerId || session.operatorProfileId !== profileId || session.status !== "open"
    || !terminal || terminal.id !== plan.terminalId || terminal.registerId !== plan.registerId || terminal.status !== "online" || !terminal.pairedAt || terminal.revokedAt
    || !terminal.tokenHash || !terminal.tokenExpiresAt || terminal.tokenExpiresAt <= now || !terminal.lastSeenAt || terminal.lastSeenAt <= new Date(now.valueOf() - 300_000) || !terminal.appVersion?.trim()
    || terminal.register.status !== "active" || terminal.register.branchId !== plan.branchId || terminal.register.branch.status !== "active"
    || snapshot.branchGrant?.canSell !== true || snapshot.registerGrant?.active !== true || snapshot.registerGrant.canSell !== true
    || requireManualPayment && snapshot.registerGrant.canManualPayment !== true
    || snapshot.registerGrant.validFrom && snapshot.registerGrant.validFrom > now || snapshot.registerGrant.validUntil && snapshot.registerGrant.validUntil < now) {
    throw new PosManualReconciliationError("A identidade, o turno, o terminal ou o acesso manual do operador não estão vigentes.", 403);
  }
}

function assertLiveManualReviewer(graph: LockedManualGraph, profileId: number, userId: string, amountCents: number) {
  const snapshot = graph.access.find(item => item.profileId === profileId);
  if (snapshot?.profile?.userId !== userId || snapshot.profile.status !== "active" || snapshot.branchGrant?.canSell !== true || snapshot.registerGrant?.active !== true
    || snapshot.registerGrant.canReviewManualPayment !== true || snapshot.registerGrant.manualPaymentReviewLimitCents < amountCents
    || snapshot.registerGrant.validFrom && snapshot.registerGrant.validFrom > graph.now || snapshot.registerGrant.validUntil && snapshot.registerGrant.validUntil < graph.now) {
    throw new PosManualReconciliationError("A identidade ou a autoridade do checker não estão vigentes.", 403);
  }
}

export function assertManualFoundationBoundary(graph: Pick<LockedManualGraph, "plan" | "slot" | "connector" | "credential" | "gate" | "now">, adapterId?: string) {
  const { plan, slot, connector, credential, gate, now } = graph, settings = jsonRecord(connector.settings), manual = jsonRecord(settings?.manualReconciliation), capabilities = settings?.capabilities;
  if (!gate?.enabled || !gate.vaultAdapterId || !gate.providerAdapterVersion || !gate.configHash || !/^[0-9a-f]{64}$/.test(gate.configHash)
    || adapterId != null && gate.vaultAdapterId !== adapterId || gate.connectorRevision !== connector.revision || gate.credentialRef !== credential.id || gate.credentialRevision !== credential.revision
    || connector.id !== slot.connectorId || connector.credentialRef !== slot.credentialRef || connector.credentialRef !== credential.id || connector.branchId !== plan.branchId || connector.registerId != null && connector.registerId !== plan.registerId
    || connector.provider !== slot.provider || credential.providerId !== connector.provider || credential.provider.family !== "payment" || connector.status !== "active" || !credential.enabled || credential.revokedAt !== null || credential.expiresAt !== null && credential.expiresAt <= now
    || manual?.enabled !== true || manual.vaultBindingRequired !== true || !Array.isArray(capabilities) || !capabilities.includes("manual_reference_query")
    || manualCallbackAuthKeyIds(credential.config).length === 0) throw new PosManualReconciliationError("O boundary manual está desabilitado, mudou de revisão ou perdeu capacidade.", 503);
}

function manualCallbackAuthKeyIds(config: Prisma.JsonValue) {
  const root = jsonRecord(config), manual = jsonRecord(root?.manualReconciliation), value = manual?.callbackAuthKeyIds;
  if (!Array.isArray(value) || value.length === 0 || value.length > 16 || value.some(item => typeof item !== "string" || !/^[A-Za-z][A-Za-z0-9._:-]{2,79}$/.test(item))) return [];
  return [...new Set(value as string[])];
}

function manualDispatchBoundaryFailure(graph: LockedManualGraph, now: Date) {
  const { manualCase, plan, slot, connector, credential, gate } = graph;
  if (!manualCase || !gate?.enabled) return "manual_gate_disabled";
  try { assertManualFoundationBoundary(graph); } catch { return "manual_boundary_changed"; }
  try { assertLiveManualOperator(graph, manualCase.makerProfileId, manualCase.makerUserId, true); } catch { return "manual_operational_boundary_changed"; }
  if (manualCase.connectorRevision !== connector.revision || manualCase.credentialRevision !== credential.revision || gate.connectorRevision !== manualCase.connectorRevision || gate.credentialRevision !== manualCase.credentialRevision) return "manual_boundary_revision_changed";
  if (manualCase.paymentPlanId !== plan.id || manualCase.paymentIndex !== slot.paymentIndex) return "manual_case_identity_changed";
  if (manualCase.expiresAt <= now || plan.expiresAt <= now || plan.state !== "active") return "manual_case_expired";
  return null;
}

async function blockQueuedManualCase(tx: Tx, graph: LockedManualGraph, reason: string, now: Date) {
  const current = graph.manualCase!, attempt = graph.attempt!, outbox = graph.outbox!, nextVersion = current.version + 1, requestHash = digest({ caseId: current.id, attemptId: attempt.id, reason });
  const operation = await tx.posManualPaymentOperation.create({ data: { caseId: current.id, action: "block", expectedVersion: current.version, resultingVersion: nextVersion, resultingState: "blocked", idempotencyKey: `manual-block:${attempt.id}:${reason}`, requestHash, writeTxid: 0 } });
  await tx.posManualPaymentStateEvent.create({ data: { caseId: current.id, operationId: operation.id, fromState: current.state, toState: "blocked", resultingVersion: nextVersion, source: "worker", sourceId: attempt.id, writeTxid: 0 } });
  await tx.posManualPaymentCase.update({ where: { id: current.id }, data: { state: "blocked", version: nextVersion, blockedAt: now, nextReconcileAt: null } });
  await tx.posManualPaymentAttempt.update({ where: { id: attempt.id }, data: { state: "failed", finishedAt: now } });
  await tx.posManualPaymentOutbox.update({ where: { id: outbox.id }, data: { state: "dead", claimToken: null, claimExpiresAt: null, completedAt: now, lastErrorCode: reason } });
}

function replayManualCase(value: Prisma.PosManualPaymentCaseGetPayload<object>, requestHash: string, planId: string) {
  if (value.requestHash !== requestHash || value.paymentPlanId !== planId) throw new PosManualReconciliationError("A chave idempotente já foi usada com outro conteúdo.");
  return { case: manualCaseDto(value), replayed: true };
}
function replayReviewOperation(operation: { caseId: string; action: string; requestHash: string; actorProfileId: number | null; review: { checkerProfileId: number; checkerUserId: string; stepUpProofHash: string } | null }, value: Prisma.PosManualPaymentCaseGetPayload<object>, requestHash: string, input: { caseId: string; checkerProfileId: number; checkerUserId: string; assertionHash: string; decision: "authorize_query" | "reject" }) {
  const action = input.decision === "reject" ? "reject" : "authorize_query";
  if (operation.caseId !== input.caseId || operation.action !== action || operation.requestHash !== requestHash || operation.actorProfileId !== input.checkerProfileId
    || operation.review?.checkerProfileId !== input.checkerProfileId || operation.review.checkerUserId !== input.checkerUserId || operation.review.stepUpProofHash !== input.assertionHash) throw new PosManualReconciliationError("A chave idempotente já foi usada por outro ator ou com outro conteúdo.");
  return { case: manualCaseDto(value), replayed: true };
}
async function reconcileVaultOrphan(adapter: PosManualReferenceVaultAdapter, binding: Awaited<ReturnType<PosManualReferenceVaultAdapter["bindReference"]>>, idempotencyKey: string) {
  try {
    const status = await adapter.reconcileOrphanBinding({ vaultReference: binding.vaultReference, bindingHash: binding.bindingHash, idempotencyKey, reason: "database_write_rejected" });
    if (status === "deferred") throw new PosManualReconciliationError("O caso não foi persistido e o vault registrou uma reconciliação órfã pendente.", 503);
    if (status !== "released" && status !== "already_absent") throw new Error("invalid orphan reconciliation status");
  } catch (cleanupError) {
    if (cleanupError instanceof PosManualReconciliationError) throw cleanupError;
    throw new PosManualReconciliationError("O caso não foi persistido e a reconciliação do token órfão falhou.", 503);
  }
}

function manualCaseDto(value: { id: string; state: string; version: number; paymentPlanId: string; paymentIndex: number; method: string; amountCents: number; currency: string; provider: string; referenceLastFour: string; expiresAt: Date; confirmationExpiresAt: Date | null; nextReconcileAt: Date | null }) {
  return { id: value.id, state: value.state, version: value.version, paymentPlanId: value.paymentPlanId, paymentIndex: value.paymentIndex, method: value.method, amountCents: value.amountCents, currency: value.currency, provider: value.provider, referenceMasked: `••••${value.referenceLastFour}`, expiresAt: value.expiresAt, confirmationExpiresAt: value.confirmationExpiresAt, nextReconcileAt: value.nextReconcileAt };
}

function normalizeOpenInput(input: OpenManualPaymentCaseInput) {
  if (input.paymentIndex !== 0) throw new PosManualReconciliationError("Índice manual inválido.", 422);
  return { paymentPlanId: identifier(input.paymentPlanId, "Plano"), paymentIndex: 0 as const, makerProfileId: positiveInteger(input.makerProfileId, "Perfil maker"), makerUserId: identifier(input.makerUserId, "Maker"), rawReference: secretReference(input.rawReference), occurredAt: validDate(input.occurredAt, "Ocorrência"), reasonCode: code(input.reasonCode, "Motivo"), idempotencyKey: identifier(input.idempotencyKey, "Idempotência") };
}
function normalizeCompletionInput(input: CompleteManualPaymentQueryInput) {
  return { attemptId: uuid(input.attemptId, "Tentativa"), claimToken: identifier(input.claimToken, "Claim"), provider: code(input.provider, "Provider"), connectorRevision: nonNegativeInteger(input.connectorRevision, "Revisão do conector"), credentialRevision: nonNegativeInteger(input.credentialRevision, "Revisão da credencial"), providerAdapterVersion: versionIdentifier(input.providerAdapterVersion), gateConfigHash: hex(input.gateConfigHash, "Configuração do gate"), outcome: choice(input.outcome, ["confirmed_paid", "not_found", "voided", "refunded", "unknown"] as const, "Outcome"), referenceHash: keyedHash(input.referenceHash, "Referência"), method: code(input.method, "Método"), amountCents: positiveInteger(input.amountCents, "Valor"), currency: currency(input.currency), evidenceHash: hex(input.evidenceHash, "Evidência"), responseHash: hex(input.responseHash, "Resposta"), providerSequence: input.providerSequence == null ? undefined : positiveBigInt(input.providerSequence, "Sequência"), providerOccurredAt: input.providerOccurredAt == null ? undefined : validDate(input.providerOccurredAt, "Ocorrência do provider"), authKeyId: identifier(input.authKeyId, "Chave de autenticação") };
}

/** Canonical hash expected in `responseHash`; excludes the hash field itself. */
export function hashManualPaymentQueryCompletion(input: ManualPaymentQueryCompletionPayload) {
  return digest({ attemptId: input.attemptId, claimToken: input.claimToken, provider: input.provider, connectorRevision: input.connectorRevision, credentialRevision: input.credentialRevision, providerAdapterVersion: input.providerAdapterVersion, gateConfigHash: input.gateConfigHash, outcome: input.outcome, referenceHash: input.referenceHash, method: input.method, amountCents: input.amountCents, currency: input.currency, evidenceHash: input.evidenceHash, providerSequence: input.providerSequence, providerOccurredAt: input.providerOccurredAt, authKeyId: input.authKeyId });
}

export function assertProviderCausality(input: Pick<CompleteManualPaymentQueryInput, "outcome" | "providerSequence" | "providerOccurredAt">, caseOccurredAt: Date, now: Date, caseExpiresAt = new Date(8_640_000_000_000_000)) {
  if (input.outcome !== "unknown" && !input.providerOccurredAt) throw new PosManualReconciliationError("Resultado conclusivo sem data causal do provider.", 422);
  const maximumOccurredAt = new Date(Math.min(now.valueOf() + 300_000, caseExpiresAt.valueOf()));
  if (input.providerOccurredAt && (input.providerOccurredAt < new Date(caseOccurredAt.valueOf() - 300_000) || input.providerOccurredAt > maximumOccurredAt)) throw new PosManualReconciliationError("A data causal do provider diverge da referência manual ou excede a expiração do caso.", 422);
  if (input.providerSequence != null && input.providerSequence <= BigInt(0)) throw new PosManualReconciliationError("Sequência do provider inválida.", 422);
}

function validateVaultBinding(value: Awaited<ReturnType<PosManualReferenceVaultAdapter["bindReference"]>>) {
  if (!value || typeof value !== "object" || !/^vault-blind:v\d+:[0-9a-f]{64}$/.test(value.stableReferenceIndex) || !/^hmac-sha256:v\d+:[0-9a-f]{64}$/.test(value.referenceHash) || !/^[0-9a-f]{64}$/.test(value.bindingHash)
    || !/^[A-Za-z0-9]{4}$/.test(value.referenceLastFour) || !/^[A-Za-z0-9._:@/-]{8,256}$/.test(value.vaultReference) || !/^[A-Za-z0-9._:@/-]{3,160}$/.test(value.vaultKeyId)
    || !/^[A-Za-z0-9._:@/-]{3,160}$/.test(value.referenceKeyId) || !(value.retentionExpiresAt instanceof Date) || !Number.isFinite(value.retentionExpiresAt.valueOf())
    || typeof value.created !== "boolean" || !isTypedCryptographicVaultReference(value.vaultReference) && containsManualPaymentPan(value.vaultReference)) throw new PosManualReconciliationError("O cofre não retornou um binding autenticado válido.", 503);
}
function isTypedCryptographicVaultReference(value: string) { return /^vault[-_:][0-9a-f]{64}$/.test(value); }
function validVaultCleanupHandle(value: unknown): value is Awaited<ReturnType<PosManualReferenceVaultAdapter["bindReference"]>> {
  return !!value && typeof value === "object" && "vaultReference" in value && "bindingHash" in value
    && typeof value.vaultReference === "string" && /^[A-Za-z0-9._:@/-]{8,256}$/.test(value.vaultReference)
    && typeof value.bindingHash === "string" && /^[0-9a-f]{64}$/.test(value.bindingHash);
}
function secretReference(value: string) {
  if (typeof value !== "string") throw new PosManualReconciliationError("Referência externa inválida.", 422);
  const normalized = value.normalize("NFKC").trim();
  if (normalized.length < 4 || normalized.length > 256 || /[\u0000-\u001f\u007f]/.test(normalized) || /(?:cvv|cvc|pin|password|senha|track|magnetic|card.?number|numero.?cartao)/i.test(normalized) || containsManualPaymentPan(normalized) || /;\d{12,19}=/.test(normalized)) throw new PosManualReconciliationError("Referência externa contém dado sensível ou formato inválido.", 422);
  return normalized;
}
export function containsManualPaymentPan(value: string) {
  const normalized = value.normalize("NFKC");
  for (const match of normalized.matchAll(/[0-9](?:[^A-Za-z0-9]*[0-9])+/g)) {
    const digits = match[0].replace(/[^0-9]/g, "");
    if (digits.length < 12 || digits.length > 19) continue;
    let sum = 0, alternate = false;
    for (let index = digits.length - 1; index >= 0; index -= 1) { let digit = Number(digits[index]); if (alternate) { digit *= 2; if (digit > 9) digit -= 9; } sum += digit; alternate = !alternate; }
    if (sum % 10 === 0) return true;
  }
  return false;
}

async function databaseClock(tx: Tx) {
  const rows = await tx.$queryRaw<Array<{ now: Date }>>(Prisma.sql`SELECT clock_timestamp() AS "now"`);
  if (!rows[0]?.now) throw new PosManualReconciliationError("O relógio autoritativo do banco não está disponível.", 503);
  return rows[0].now;
}
async function transactionRetry<T>(db: Db, operation: (tx: Tx) => Promise<T>, isolationLevel: Prisma.TransactionIsolationLevel = Prisma.TransactionIsolationLevel.Serializable): Promise<T> {
  for (let attempt = 1; ; attempt += 1) {
    try { return await db.$transaction(operation, { isolationLevel, maxWait: 10_000, timeout: 30_000 }); }
    catch (error) { if (!isTransactionConflict(error) || attempt >= POS_MANUAL_RECONCILIATION_LIMITS.serializationRetries) throw error; }
  }
}
export function isTransactionConflict(error: unknown) {
  const candidate = error as { code?: unknown; meta?: { code?: unknown; database_error?: unknown }; message?: unknown };
  const values = [candidate?.code, candidate?.meta?.code, candidate?.meta?.database_error, candidate?.message].filter(value => typeof value === "string") as string[];
  return values.some(value => value === "P2034" || value === "40001" || value === "40P01" || /(?:SQLSTATE\s*)?(?:40001|40P01)|serialization failure|deadlock detected/i.test(value));
}

function retryDelayMs(sequence: number) { return Math.min(900_000, 30_000 * 2 ** Math.min(sequence - 1, 5)); }
function validDate(value: Date, label: string) { if (!(value instanceof Date) || !Number.isFinite(value.valueOf())) throw new PosManualReconciliationError(`${label} inválida.`, 422); return value; }
function positiveInteger(value: number, label: string) { if (!Number.isSafeInteger(value) || value < 1 || value > 2_147_483_647) throw new PosManualReconciliationError(`${label} inválido.`, 422); return value; }
function nonNegativeInteger(value: number, label: string) { if (!Number.isSafeInteger(value) || value < 0 || value > 2_147_483_647) throw new PosManualReconciliationError(`${label} inválida.`, 422); return value; }
function positiveBigInt(value: bigint, label: string) { if (typeof value !== "bigint" || value <= BigInt(0) || value > BigInt("9223372036854775807")) throw new PosManualReconciliationError(`${label} inválida.`, 422); return value; }
function bounded(value: number, minimum: number, maximum: number, label: string) { if (!Number.isSafeInteger(value) || value < minimum || value > maximum) throw new PosManualReconciliationError(`${label} inválido.`, 422); return value; }
function identifier(value: string, label: string) { if (typeof value !== "string" || value.length < 3 || value.length > 160 || !/^[A-Za-z0-9._:@/-]+$/.test(value) || containsManualPaymentPan(value)) throw new PosManualReconciliationError(`${label} inválido.`, 422); return value; }
function versionIdentifier(value: string) { if (typeof value !== "string" || value.length < 1 || value.length > 80 || !/^[A-Za-z0-9][A-Za-z0-9._:+/-]*$/.test(value)) throw new PosManualReconciliationError("Versão do adapter inválida.", 422); return value; }
function uuid(value: string, label: string) { if (typeof value !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)) throw new PosManualReconciliationError(`${label} inválido.`, 422); return value; }
function code(value: string, label: string) { if (typeof value !== "string" || !/^[a-z][a-z0-9._:-]{1,79}$/.test(value)) throw new PosManualReconciliationError(`${label} inválido.`, 422); return value; }
function choice<const T extends readonly string[]>(value: unknown, choices: T, label: string): T[number] { if (typeof value !== "string" || !choices.includes(value)) throw new PosManualReconciliationError(`${label} inválida.`, 422); return value as T[number]; }
function hex(value: string, label: string) { if (typeof value !== "string" || !/^[0-9a-f]{64}$/.test(value)) throw new PosManualReconciliationError(`${label} inválido.`, 422); return value; }
function keyedHash(value: string, label: string) { if (typeof value !== "string" || !/^hmac-sha256:v\d+:[0-9a-f]{64}$/.test(value)) throw new PosManualReconciliationError(`${label} inválida.`, 422); return value; }
function currency(value: string) { if (typeof value !== "string" || !/^[A-Z]{3}$/.test(value)) throw new PosManualReconciliationError("Moeda inválida.", 422); return value; }
function jsonRecord(value: unknown): Record<string, unknown> | null { return value != null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null; }
function digest(value: unknown) { return createHash("sha256").update(canonicalJson(value)).digest("hex"); }
function canonicalJson(value: unknown): string { if (typeof value === "bigint") return JSON.stringify(value.toString()); if (value instanceof Date) return JSON.stringify(value.toISOString()); if (value === null || typeof value !== "object") return JSON.stringify(value); if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`; const record = value as Record<string, unknown>; return `{${Object.keys(record).filter(key => record[key] !== undefined).sort().map(key => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(",")}}`; }
function prismaCode(error: unknown) { return typeof error === "object" && error !== null && "code" in error ? String((error as { code: unknown }).code) : null; }
