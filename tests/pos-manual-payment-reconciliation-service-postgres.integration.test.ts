import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import test from "node:test";
import { promisify } from "node:util";
import { PrismaPg } from "@prisma/adapter-pg";
import { Client, type DatabaseError } from "pg";
import { Prisma, PrismaClient } from "../generated/tenant/client";
import {
  claimPosManualPaymentQueries,
  completePosManualPaymentQuery,
  hashManualPaymentQueryCompletion,
  openPosManualPaymentCase,
  reviewPosManualPaymentCase,
  type ManualPaymentQueryCompletionPayload,
  type PosManualReferenceVaultAdapter,
} from "../lib/erp/pos-manual-payment-reconciliation";

const connectionString = process.env.POS_TEST_DATABASE_URL;
const execFileAsync = promisify(execFile);

type OpenPreparedResult = {
  requestId: string;
  ticket: string;
  state: string;
};

type OpenClaimResult = {
  claimToken: string;
  fencingToken: string | number | bigint;
  vaultIdempotencyKey: string;
};

type OpenCaseResult = {
  caseId: string;
  replayed?: boolean;
};

test("320000 serviço executa aggregate real, fencing, fairness, replay, attestation e cleanup", { skip: !connectionString, timeout: 60_000 }, async () => {
  const db = client(), peer = client(), token = randomUUID(), compact = token.replaceAll("-", "").slice(0, 32), vault = vaultAdapter();
  let gateTriggerDisabled = false;
  const installedConnectorIds: string[] = [];
  try {
    const primary = await baseContext(db, token, compact);
    const secondary = await secondaryContext(db, primary, `${token}-secondary`, `${compact}b`);
    gateTriggerDisabled = true;
    await db.$executeRawUnsafe(`ALTER TABLE "pos_manual_payment_reconciliation_gates" DISABLE TRIGGER "pos_manual_reconciliation_gate_guard"`);
    try {
      await installGate(db, primary.connector.id, primary.connector.revision, primary.credential.id, primary.credential.revision);
      installedConnectorIds.push(primary.connector.id);
      await installGate(db, secondary.connector.id, secondary.connector.revision, secondary.credential.id, secondary.credential.revision);
      installedConnectorIds.push(secondary.connector.id);
    } finally {
      await db.$executeRawUnsafe(`ALTER TABLE "pos_manual_payment_reconciliation_gates" ENABLE TRIGGER "pos_manual_reconciliation_gate_guard"`);
      gateTriggerDisabled = false;
    }

    const unknownRawReference = `manual-ref-unknown-${compact}-9876`;
    const unknownPlan = await createActiveManualPlan(db, primary, `${token}-unknown`, 1_000);
    const unknownInput = openInput(unknownPlan.planId, primary, unknownRawReference, `${compact}-open-unknown`);
    const openedUnknown = await openVia321f(db, primary, unknownInput);
    caseReferenceHashes.set(openedUnknown.case.id, referenceHash(unknownRawReference));
    assert.equal(openedUnknown.replayed, false);
    const openedReplay = await openVia321f(db, primary, unknownInput);
    assert.equal(openedReplay.replayed, true);
    await rejectExpiredGrantUnderContention(db, peer, openedUnknown.case.id, primary, `${compact}-expired-review`);
    await authorize(db, openedUnknown.case.id, primary, `${compact}-review-unknown`);
    const unknownClaim = await claimAfterTerminalContention(db, peer, primary.terminal.id, { workerId: `worker-${compact}`, limit: 1, leaseSeconds: 30 });
    assert.equal(unknownClaim.claimedCount, 1);
    const unknownCommand = unknownClaim.claimed[0];
    const unknownAttempt = await db.posManualPaymentAttempt.findUniqueOrThrow({ where: { id: unknownCommand.attemptId } });
    assert.equal(unknownCommand.attemptSequence, unknownAttempt.sequence);
    assert.equal(unknownCommand.providerIdempotencyKey, unknownAttempt.providerIdempotencyKey);
    assert.equal(unknownCommand.connectorRevision, primary.connector.revision);
    assert.equal(unknownCommand.credentialRevision, primary.credential.revision);
    const unknownCompletion = completion(unknownCommand, openedUnknown.case, "unknown", 1, `unknown-${token}`);
    const unknownResult = await completePosManualPaymentQuery(db, withResponseHash(unknownCompletion));
    assert.equal(unknownResult.retryScheduled, true);
    assert.equal((await db.posManualPaymentCase.findUniqueOrThrow({ where: { id: openedUnknown.case.id } })).state, "unknown");
    assert.equal(await db.posManualPaymentAttempt.count({ where: { caseId: openedUnknown.case.id } }), 2);

    const fairA1 = await openAndAuthorize(db, vault, primary, `${token}-fair-a1`, `manual-ref-fair-a1-${compact}-1111`, 1_100);
    const fairA2 = await openAndAuthorize(db, vault, primary, `${token}-fair-a2`, `manual-ref-fair-a2-${compact}-2222`, 1_200);
    const fairB1 = await openAndAuthorize(db, vault, secondary, `${token}-fair-b1`, `manual-ref-fair-b1-${compact}-3333`, 1_300);
    const fair = await claimPosManualPaymentQueries(db, { workerId: `fair-${compact}`, limit: 3, leaseSeconds: 30 });
    assert.equal(fair.claimedCount, 2, "cada sweep deve trazer no máximo um job por sessão");
    const fairCases = await db.posManualPaymentCase.findMany({ where: { id: { in: fair.claimed.map(item => item.caseId) } }, select: { id: true, sessionId: true } });
    assert.equal(new Set(fairCases.map(item => item.sessionId)).size, 2);
    assert.equal(fair.claimed.filter(item => [fairA1.case.id, fairA2.case.id].includes(item.caseId)).length, 1);
    assert.equal(fair.claimed.some(item => item.caseId === fairB1.case.id), true);

    const firstCommand = fair.claimed[0], firstCase = [fairA1.case, fairA2.case, fairB1.case].find(item => item.id === firstCommand.caseId)!;
    const firstContext = firstCommand.caseId === fairB1.case.id ? secondary : primary;
    const confirmed = completion(firstCommand, firstCase, "confirmed_paid", 1, `confirmed-${token}`);
    await db.posRegisterAccess.update({ where: { registerId_userProfileId: { registerId: firstContext.register.id, userProfileId: firstContext.maker.id } }, data: { canManualPayment: false } });
    await assert.rejects(attestProviderResult(db, firstCommand, confirmed, `revoked-grant-${token}`), /boundary diverged/);
    await db.posRegisterAccess.update({ where: { registerId_userProfileId: { registerId: firstContext.register.id, userProfileId: firstContext.maker.id } }, data: { canManualPayment: true } });
    await assert.rejects(attestProviderResult(db, firstCommand, { ...confirmed, authKeyId: "untrusted-key" }, `bad-key-${token}`), /boundary diverged/);
    await assert.rejects(attestProviderResult(db, firstCommand, { ...confirmed, credentialRevision: confirmed.credentialRevision + 1 }, `bad-revision-${token}`), /boundary diverged/);
    const ownerProof = await attestProviderResult(db, firstCommand, confirmed, `confirmed-${token}`);
    const confirmedProof = await attestProviderResult(db, firstCommand, confirmed, `confirmed-${token}`, "semantic-replay");
    assert.notEqual(confirmedProof, ownerProof, "replay semântico deve devolver proof vinculado à delivery atual");
    const crossCommandKey = `cross-command-${token}`;
    await assert.rejects(db.$transaction(async tx => {
      await tx.posManualPaymentDeliveryResult.create({ data: {
        attemptId: firstCommand.attemptId, deliveryNumber: (await tx.posManualPaymentOutbox.findUniqueOrThrow({ where: { attemptId: firstCommand.attemptId } })).deliveryCount,
        claimTokenHash: digest(firstCommand.claimToken), responseHash: digest(`cross-response:${token}`), resultKind: "transport_outcome_unknown",
        outcome: "unknown", evidenceHash: digest(`cross-evidence:${token}`), retryable: true, superseded: false,
        resultingState: "unknown", resultingVersion: 1, processingResult: "retry_scheduled", completionIdempotencyKey: crossCommandKey,
      } });
      await tx.$queryRaw(Prisma.sql`SELECT public."pos_manual_complete_delivery_v1"(
        ${firstCommand.attemptId}::uuid, ${firstCommand.claimToken}, ${confirmedProof}::uuid, ${crossCommandKey}
      )`);
    }), /delivery completion idempotency conflict/);
    const regressedPayload = { ...confirmed, providerSequence: BigInt(2), providerOccurredAt: new Date(confirmed.providerOccurredAt!.valueOf() - 1) };
    await assert.rejects(db.$transaction(async tx => {
      const regressedProof = await attestProviderResult(tx, firstCommand, regressedPayload, `regressed-time-${token}`);
      const regressed = await completeProviderDelivery(tx, firstCommand, regressedProof, `regressed-time-${token}`);
      assert.equal(regressed.resultingState, "blocked", "sequence crescente não aceita relógio causal regressivo");
      throw new Error("rollback-regressed-provider-time");
    }), /rollback-regressed-provider-time/);
    await assert.rejects(completeProviderDelivery(db, firstCommand, confirmedProof, `confirm-${token}`, `${firstCommand.claimToken}-wrong`), /exact live unconsumed provider proof/);
    const confirmedResult = await completeProviderDelivery(db, firstCommand, confirmedProof, `confirm-${token}`);
    assert.equal(confirmedResult.resultingState, "confirmed_paid");
    const confirmedReplay = await completeProviderDelivery(db, firstCommand, confirmedProof, `confirm-${token}`);
    assert.equal(confirmedReplay.replayed, true);
    await assert.rejects(db.$queryRaw(Prisma.sql`SELECT public."pos_manual_report_transport_v1"(
      ${firstCommand.attemptId}::uuid, ${firstCommand.claimToken}, 'outcome_unknown', ${`confirm-${token}`}
    )`), /transport report idempotency conflict/);

    for (const command of fair.claimed.slice(1)) {
      const current = [fairA1.case, fairA2.case, fairB1.case].find(item => item.id === command.caseId)!;
      await authenticatedComplete(db, command, current, "confirmed_paid", 1, `fair-confirm-${command.caseId}`);
    }

    const dueA = fairA1.case.id === firstCommand.caseId || fairA1.case.id === fair.claimed[1]?.caseId ? fairA2 : fairA1;
    const concurrent = await Promise.all([
      claimPosManualPaymentQueries(db, { workerId: `race-a-${compact}`, limit: 1, leaseSeconds: 30 }),
      claimPosManualPaymentQueries(peer, { workerId: `race-b-${compact}`, limit: 1, leaseSeconds: 30 }),
    ]);
    const racedClaims = concurrent.flatMap(result => result.claimed).filter(item => item.caseId === dueA.case.id);
    assert.equal(racedClaims.length, 1, "dois workers não podem obter o mesmo lease");
    if (racedClaims[0]) await authenticatedComplete(db, racedClaims[0], dueA.case, "confirmed_paid", 1, `race-confirm-${token}`);

    const exhausted = await openAndAuthorize(db, vault, primary, `${token}-callback-exhausted`, `manual-ref-exhausted-${compact}-8811`, 1_450);
    const exhaustedAttempt = await db.posManualPaymentAttempt.findFirstOrThrow({ where: { caseId: exhausted.case.id } });
    await db.posManualPaymentAttempt.update({ where: { id: exhaustedAttempt.id }, data: { sequence: 12 } });
    await recordCaseCallback(db, exhausted.case, `callback-exhausted-${token}`, "unknown", 1);
    assert.equal((await db.posManualPaymentCase.findUniqueOrThrow({ where: { id: exhausted.case.id } })).state, "blocked");
    assert.equal(await db.posManualPaymentIncident.count({ where: { caseId: exhausted.case.id, code: "provider_unknown_retry_exhausted" } }), 1);
    assert.equal(await db.posManualPaymentAttempt.count({ where: { caseId: exhausted.case.id, sequence: { gt: 12 } } }), 0);
    assert.equal(await db.posManualPaymentOutbox.count({ where: { attempt: { caseId: exhausted.case.id }, state: { in: ["pending", "retry", "claimed"] } } }), 0);

    const retained = await db.posManualPaymentCase.findUniqueOrThrow({ where: { id: fairA1.case.id }, include: { vaultBinding: true, paymentPlan: true } });
    assert.ok(retained.vaultBinding);
    assert.ok(retained.vaultBinding.retentionExpiresAt > retained.expiresAt);
    assert.ok(retained.vaultBinding.retentionExpiresAt <= new Date(retained.paymentPlan.expiresAt.valueOf() + 60_000));

    const duplicatePlan = await createActiveManualPlan(db, primary, `${token}-duplicate`, 1_400);
    await assert.rejects(openVia321f(db, primary, openInput(duplicatePlan.planId, primary, unknownRawReference, `${compact}-duplicate-reference`)));
    assert.equal(vault.reconciled.length, 0, "cutover 321f não pode mutar o adapter legado nem criar órfão");

    await disableInstalledGates(db, installedConnectorIds);
    const gate = await db.posManualPaymentReconciliationGate.findUniqueOrThrow({ where: { connectorId: primary.connector.id } });
    assert.equal(gate.enabled, false);
    const triggers = await db.$queryRawUnsafe<Array<{ name: string; enabled: string }>>(`SELECT tgname AS name,tgenabled::text AS enabled FROM pg_trigger WHERE tgname IN ('pos_manual_reconciliation_gate_guard','pos_manual_review_guard','pos_manual_step_up_assertion_guard')`);
    assert.deepEqual(new Map(triggers.map(item => [item.name, item.enabled])), new Map([
      ["pos_manual_reconciliation_gate_guard", "O"],
      ["pos_manual_review_guard", "O"],
      ["pos_manual_step_up_assertion_guard", "O"],
    ]), "hard-disable, review e assertion devem permanecer habilitados");
  } finally {
    if (gateTriggerDisabled) await db.$executeRawUnsafe(`ALTER TABLE "pos_manual_payment_reconciliation_gates" ENABLE TRIGGER "pos_manual_reconciliation_gate_guard"`).catch(() => undefined);
    await disableInstalledGates(db, installedConnectorIds).catch(() => undefined);
    await Promise.all([db.$disconnect(), peer.$disconnect()]);
  }
});

test("321000 issuer/review SECURITY DEFINER preservam causalidade, replay e concorrência", { skip: !connectionString, timeout: 60_000 }, async () => {
  const db = client(), peer = client(), token = randomUUID(), compact = token.replaceAll("-", "").slice(0, 32), vault = vaultAdapter();
  const installedConnectorIds: string[] = [];
  let authenticatedRoles: Awaited<ReturnType<typeof installAuthenticatedProcedureRoles>> | null = null;
  let gateTriggerDisabled = false;
  try {
    const context = await baseContext(db, token, compact);
    gateTriggerDisabled = true;
    await db.$executeRawUnsafe(`ALTER TABLE "pos_manual_payment_reconciliation_gates" DISABLE TRIGGER "pos_manual_reconciliation_gate_guard"`);
    try {
      await installGate(db, context.connector.id, context.connector.revision, context.credential.id, context.credential.revision);
      installedConnectorIds.push(context.connector.id);
    } finally {
      await db.$executeRawUnsafe(`ALTER TABLE "pos_manual_payment_reconciliation_gates" ENABLE TRIGGER "pos_manual_reconciliation_gate_guard"`);
      gateTriggerDisabled = false;
    }

    const opened = await openProcedureCase(db, vault, context, `${token}-procedure-authorize`, `manual-procedure-${compact}-4421`, 2_100);
    authenticatedRoles = await installAuthenticatedProcedureRoles(db);
    const assertionHash = digest(`procedure-assertion-${token}`), reasonCode = "manual.query_authorized";
    const requestHash = digestCanonical({ caseId: opened.case.id, checkerProfileId: context.checker.id, checkerUserId: context.checker.userId, assertionHash, decision: "authorize_query", reasonCode });
    const issued = await issueStepUpPg(authenticatedRoles.issuer, opened.case.id, context.checker.id, context.checker.userId, requestHash, assertionHash, `${compact}-issuer`, "authorize_query", reasonCode);
    assert.equal(issued.replayed, false);
    assert.equal((await issueStepUpPg(authenticatedRoles.issuer, opened.case.id, context.checker.id, context.checker.userId, requestHash, assertionHash, `${compact}-issuer`, "authorize_query", reasonCode)).replayed, true);
    await assertPgState(authenticatedRoles.issuer, `SELECT public."pos_manual_review_case_v1"($1::uuid,0,$2,$3,$4,'authorize_query',$5,$6,$7)`, "42501", [opened.case.id, context.checker.id, context.checker.userId, assertionHash, reasonCode, `${compact}-cross-issuer`, requestHash]);
    await assertPgState(authenticatedRoles.runtime, `SELECT public."pos_manual_issue_step_up_v1"($1::uuid,0,$2,$3,'manual_payment.review','authorize_query',$4,$5,$6,$7)`, "42501", [opened.case.id, context.checker.id, context.checker.userId, reasonCode, requestHash, assertionHash, `${compact}-cross-runtime`]);
    await assertPgState(authenticatedRoles.issuer, `SELECT * FROM public."pos_manual_payment_step_up_assertions"`, "42501");
    await assertPgState(authenticatedRoles.runtime, `SELECT * FROM public."pos_manual_payment_cases"`, "42501");
    await assert.rejects(
      issueStepUp(db, opened.case.id, context.checker.id, context.checker.userId, requestHash, digest(`conflict-${token}`), `${compact}-issuer`),
      /idempotency key conflicts/i,
    );
    await assert.rejects(
      issueStepUp(db, opened.case.id, context.checker.id, `${context.checker.userId}-wrong`, requestHash, digest(`wrong-user-${token}`), `${compact}-wrong-user`),
      /profile\/user binding/i,
    );

    await assert.rejects(
      reviewProcedure(db, opened.case.id, 0, context.checker.id, context.checker.userId, assertionHash, "reject", reasonCode, `${compact}-semantic-decision`, requestHash),
      /live matching one-shot assertion/i,
    );
    await assert.rejects(
      reviewProcedure(db, opened.case.id, 0, context.checker.id, context.checker.userId, assertionHash, "authorize_query", "manual.reason_swapped", `${compact}-semantic-reason`, requestHash),
      /live matching one-shot assertion/i,
    );
    await db.posRegisterAccess.update({ where: { registerId_userProfileId: { registerId: context.register.id, userProfileId: context.maker.id } }, data: { canManualPayment: false } });
    await assert.rejects(
      reviewProcedure(db, opened.case.id, 0, context.checker.id, context.checker.userId, assertionHash, "authorize_query", reasonCode, `${compact}-maker-revoked`, requestHash),
      /temporal authority expired/i,
    );
    await db.posRegisterAccess.update({ where: { registerId_userProfileId: { registerId: context.register.id, userProfileId: context.maker.id } }, data: { canManualPayment: true } });
    await db.posTerminal.update({ where: { id: context.terminal.id }, data: { appVersion: "" } });
    await assert.rejects(
      reviewProcedure(db, opened.case.id, 0, context.checker.id, context.checker.userId, assertionHash, "authorize_query", reasonCode, `${compact}-terminal-stale`, requestHash),
      /temporal authority expired/i,
    );
    await db.posTerminal.update({ where: { id: context.terminal.id }, data: { appVersion: "test", lastSeenAt: new Date() } });

    const reviewed = await reviewProcedurePg(authenticatedRoles.runtime, opened.case.id, 0, context.checker.id, context.checker.userId, assertionHash, "authorize_query", reasonCode, `${compact}-review`, requestHash);
    assert.equal(reviewed.replayed, false);
    assert.equal(reviewed.resultingState, "unknown");
    assert.ok(reviewed.attemptId);
    assert.ok(reviewed.outboxId);
    assert.equal((await reviewProcedurePg(authenticatedRoles.runtime, opened.case.id, 0, context.checker.id, context.checker.userId, assertionHash, "authorize_query", reasonCode, `${compact}-review`, requestHash)).replayed, true);
    const consumedReplay = await issueStepUpPg(authenticatedRoles.issuer, opened.case.id, context.checker.id, context.checker.userId, requestHash, assertionHash, `${compact}-issuer`, "authorize_query", reasonCode);
    assert.equal(consumedReplay.consumed, true);
    assert.equal(consumedReplay.currentlyValid, false);
    await assert.rejects(
      reviewProcedure(db, opened.case.id, 0, context.checker.id, context.checker.userId, assertionHash, "authorize_query", "manual.conflict", `${compact}-review`, requestHash),
      /idempotency key conflicts/i,
    );
    const graph = await db.$queryRaw<Array<{ lifecycle_txid: string; review_txid: string; operation_txid: string; event_txid: string }>>(Prisma.sql`
      SELECT c."lifecycle_txid"::text, r."write_txid"::text AS "review_txid",
             o."write_txid"::text AS "operation_txid", e."write_txid"::text AS "event_txid"
        FROM "pos_manual_payment_cases" c
        JOIN "pos_manual_payment_reviews" r ON r."case_id"=c."id"
        JOIN "pos_manual_payment_operations" o ON o."review_id"=r."id"
        JOIN "pos_manual_payment_state_events" e ON e."operation_id"=o."id"
       WHERE c."id"=${opened.case.id}::uuid
    `);
    assert.deepEqual(new Set(Object.values(graph[0]!)), new Set([graph[0]!.lifecycle_txid]), "review/op/event/case devem compartilhar writeTxid");

    const claimRequestKey = `role-claim-${compact}`;
    const [roleClaimBatch, roleClaimReplay] = await Promise.all([
      claimQueriesPg(authenticatedRoles.worker, `role-${compact}`, 10, 30, claimRequestKey),
      claimQueriesPg(authenticatedRoles.workerPeer, `role-${compact}`, 10, 30, claimRequestKey),
    ]);
    assert.equal(roleClaimReplay.batchId, roleClaimBatch.batchId);
    assert.deepEqual(roleClaimReplay.claimed, roleClaimBatch.claimed, "lost-response replay deve devolver os mesmos fences live");
    assert.equal(roleClaimReplay.replayed || roleClaimBatch.replayed, true);
    assert.equal(roleClaimBatch.vaultOpenAvailable, false);
    assert.doesNotMatch(JSON.stringify(roleClaimBatch), /vaultReference|referenceHash|bindingHash|vaultKeyId|stableReferenceIndex/i);
    await assertPgState(authenticatedRoles.worker, `SELECT public."pos_manual_claim_queries_v1"($1,9,30,$2)`, "23505", [`role-${compact}`, claimRequestKey]);
    await assertPgState(authenticatedRoles.callback, `SELECT public."pos_manual_claim_queries_v1"('worker-safe',1,30,'callback-denied')`, "42501");
    const roleClaim = roleClaimBatch.claimed.find(item => item.caseId === opened.case.id);
    assert.ok(roleClaim, "o caso revisado deve ser claimado para o teste funcional de roles");
    await db.posRegisterAccess.update({ where: { registerId_userProfileId: { registerId: context.register.id, userProfileId: context.maker.id } }, data: { canManualPayment: false } });
    await assertPgState(authenticatedRoles.worker, `SELECT public."pos_manual_claim_queries_v1"($1,10,30,$2)`, "23514", [`role-${compact}`, claimRequestKey]);
    await db.posRegisterAccess.update({ where: { registerId_userProfileId: { registerId: context.register.id, userProfileId: context.maker.id } }, data: { canManualPayment: true } });
    const rolePayload = completion(roleClaim, opened.case, "confirmed_paid", 1, `role-proof-${token}`);
    const roleDeliveryCount = (await db.posManualPaymentOutbox.findUniqueOrThrow({ where: { attemptId: roleClaim.attemptId } })).deliveryCount;
    const roleProof = await attestProviderResultPg(authenticatedRoles.callback, roleClaim, roleDeliveryCount, rolePayload, `role-proof-${token}`);
    const roleCompleted = await completeProviderDeliveryPg(authenticatedRoles.worker, roleClaim, roleProof, `role-complete-${token}`);
    assert.equal(roleCompleted.resultingState, "confirmed_paid");
    const completedBatchReplay = await claimQueriesPg(authenticatedRoles.worker, `role-${compact}`, 10, 30, claimRequestKey);
    assert.equal(completedBatchReplay.replayExpired, true);
    assert.deepEqual(completedBatchReplay.claimed, []);

    const fairnessContext = await secondaryContext(db, context, `${token}-claim-fairness`, `${compact}f`);
    gateTriggerDisabled = true;
    await db.$executeRawUnsafe(`ALTER TABLE "pos_manual_payment_reconciliation_gates" DISABLE TRIGGER "pos_manual_reconciliation_gate_guard"`);
    try {
      await installGate(db, fairnessContext.connector.id, fairnessContext.connector.revision, fairnessContext.credential.id, fairnessContext.credential.revision);
      installedConnectorIds.push(fairnessContext.connector.id);
    } finally {
      await db.$executeRawUnsafe(`ALTER TABLE "pos_manual_payment_reconciliation_gates" ENABLE TRIGGER "pos_manual_reconciliation_gate_guard"`);
      gateTriggerDisabled = false;
    }
    const fairPrimary = await openAndAuthorize(db, vault, context, `${token}-claim-fair-primary`, `manual-role-fair-a-${compact}-8844`, 2_175);
    const fairSecondary = await openAndAuthorize(db, vault, fairnessContext, `${token}-claim-fair-secondary`, `manual-role-fair-b-${compact}-9955`, 2_180);
    const fairClaims = await Promise.all([
      claimQueriesPg(authenticatedRoles.worker, `fair-a-${compact}`, 1, 30, `fair-a-${compact}`),
      claimQueriesPg(authenticatedRoles.workerPeer, `fair-b-${compact}`, 1, 30, `fair-b-${compact}`),
    ]);
    assert.deepEqual(fairClaims.map(batch => batch.claimedCount), [1, 1]);
    const fairCaseIds = fairClaims.flatMap(batch => batch.claimed.map(command => command.caseId));
    assert.equal(new Set(fairCaseIds).size, 2, "workers concorrentes não podem reter sessões além do orçamento");
    assert.deepEqual(new Set(fairCaseIds), new Set([fairPrimary.case.id, fairSecondary.case.id]));

    await assertPgState(authenticatedRoles.callback, `SELECT public."pos_manual_complete_delivery_v1"(NULL,NULL,NULL,NULL)`, "42501");
    await assertPgState(authenticatedRoles.worker, `SELECT public."pos_manual_attest_query_response_v1"(NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL)`, "42501");
    await assertPgState(authenticatedRoles.callback, `SELECT * FROM public."pos_manual_payment_provider_proofs"`, "42501");
    await assertPgState(authenticatedRoles.worker, `SELECT * FROM public."pos_manual_payment_proof_consumptions"`, "42501");
    await assertPgState(authenticatedRoles.worker, `SELECT last_value FROM public."pos_manual_payment_delivery_results_id_seq"`, "42501");

    const orphan = await recordOrphanCallbackPg(authenticatedRoles.callback, `orphan-${token}`);
    assert.equal(orphan.disposition, "orphan_reference");
    assert.equal(orphan.quarantined, true);
    await assertPgState(authenticatedRoles.worker, `SELECT public."pos_manual_record_callback_v1"(NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL)`, "42501");

    const transportCase = await openAndAuthorize(db, vault, context, `${token}-role-transport`, `manual-role-transport-${compact}-7733`, 2_150);
    const transportAttemptId = (await db.posManualPaymentAttempt.findFirstOrThrow({ where: { caseId: transportCase.case.id } })).id;
    await db.posManualPaymentOutbox.update({ where: { attemptId: transportAttemptId }, data: { nextAttemptAt: new Date(0) } });
    const transportBatch = await claimQueriesPg(authenticatedRoles.worker, `transport-${compact}`, 10, 30, `transport-claim-${compact}`);
    const transportClaim = transportBatch.claimed.find(item => item.caseId === transportCase.case.id);
    assert.ok(transportClaim);
    const transported = await reportTransportPg(authenticatedRoles.worker, transportClaim, "pre_dispatch_failure", `transport-${token}`);
    assert.equal(transported.processingResult, "retry_scheduled");
    const transportAttempt = await db.posManualPaymentAttempt.findUniqueOrThrow({ where: { id: transportClaim.attemptId } });
    assert.equal(transportAttempt.state, "queued");
    assert.equal(transportAttempt.finishedAt, null);
    await db.posManualPaymentOutbox.update({ where: { attemptId: transportAttempt.id }, data: { nextAttemptAt: new Date(0) } });
    const leaseTwo = await claimQueriesPg(authenticatedRoles.worker, `transport-${compact}`, 10, 30, `transport-lease-two-${compact}`);
    const leaseTwoClaim = leaseTwo.claimed.find(item => item.caseId === transportCase.case.id);
    assert.ok(leaseTwoClaim);
    await db.posManualPaymentOutbox.update({ where: { attemptId: leaseTwoClaim.attemptId }, data: { claimExpiresAt: new Date(Date.now() - 1_000) } });
    const reclaimed = await claimQueriesPg(authenticatedRoles.worker, `transport-peer-${compact}`, 10, 30, `transport-reclaim-${compact}`);
    const reclaimedClaim = reclaimed.claimed.find(item => item.caseId === transportCase.case.id);
    assert.ok(reclaimedClaim);
    assert.notEqual(reclaimedClaim.claimToken, leaseTwoClaim.claimToken);
    assert.equal(reclaimedClaim.deliveryNumber, leaseTwoClaim.deliveryNumber + 1);
    assert.equal((await db.posManualPaymentClaimReceipt.findUniqueOrThrow({ where: { attemptId_deliveryNumber: { attemptId: reclaimedClaim.attemptId, deliveryNumber: reclaimedClaim.deliveryNumber } } })).reclaimedExpiredLease, true);
    assert.equal((await db.posManualPaymentDeliveryResult.findUniqueOrThrow({ where: { attemptId_deliveryNumber: { attemptId: leaseTwoClaim.attemptId, deliveryNumber: leaseTwoClaim.deliveryNumber } } })).resultKind, "transport_outcome_unknown");
    await assertPgState(authenticatedRoles.worker, `SELECT public."pos_manual_report_transport_v1"($1::uuid,$2,'pre_dispatch_failure',$3)`, "23514", [leaseTwoClaim.attemptId, leaseTwoClaim.claimToken, `stale-fence-${compact}`]);
    const expiredBatchReplay = await claimQueriesPg(authenticatedRoles.worker, `transport-${compact}`, 10, 30, `transport-lease-two-${compact}`);
    assert.equal(expiredBatchReplay.replayExpired, true);
    assert.deepEqual(expiredBatchReplay.claimed, []);
    await assertPgState(authenticatedRoles.callback, `SELECT public."pos_manual_report_transport_v1"(NULL,NULL,NULL,NULL)`, "42501");

    const versionCase = await openProcedureCase(db, vault, context, `${token}-procedure-version`, `manual-procedure-${compact}-5522`, 2_200);
    const versionAssertion = digest(`version-assertion-${token}`), versionReason = "manual.review_rejected";
    const versionHash = digestCanonical({ caseId: versionCase.case.id, checkerProfileId: context.checker.id, checkerUserId: context.checker.userId, assertionHash: versionAssertion, decision: "reject", reasonCode: versionReason });
    await issueStepUp(db, versionCase.case.id, context.checker.id, context.checker.userId, versionHash, versionAssertion, `${compact}-version-issuer`, "reject", versionReason);
    await assert.rejects(
      reviewProcedure(db, versionCase.case.id, 1, context.checker.id, context.checker.userId, versionAssertion, "reject", versionReason, `${compact}-wrong-version`, versionHash),
      /expected live review-pending case version/i,
    );
    assert.equal((await db.posManualPaymentStepUpAssertion.findUniqueOrThrow({ where: { assertionHash: versionAssertion } })).consumedAt, null);

    const raceCase = await openProcedureCase(db, vault, context, `${token}-procedure-race`, `manual-procedure-${compact}-6623`, 2_300);
    const raceAssertion = digest(`race-assertion-${token}`), raceReason = "manual.review_rejected";
    const raceHash = digestCanonical({ caseId: raceCase.case.id, checkerProfileId: context.checker.id, checkerUserId: context.checker.userId, assertionHash: raceAssertion, decision: "reject", reasonCode: raceReason });
    await issueStepUp(db, raceCase.case.id, context.checker.id, context.checker.userId, raceHash, raceAssertion, `${compact}-race-issuer`, "reject", raceReason);
    const raced = await Promise.allSettled([
      reviewProcedure(db, raceCase.case.id, 0, context.checker.id, context.checker.userId, raceAssertion, "reject", raceReason, `${compact}-race-a`, raceHash),
      reviewProcedure(peer, raceCase.case.id, 0, context.checker.id, context.checker.userId, raceAssertion, "reject", raceReason, `${compact}-race-b`, raceHash),
    ]);
    assert.equal(raced.filter(item => item.status === "fulfilled").length, 1, "somente uma revisão concorrente pode consumir a assertion/case version");
    assert.equal(await db.posManualPaymentReview.count({ where: { caseId: raceCase.case.id } }), 1);
    assert.equal((await db.posManualPaymentStepUpAssertion.findUniqueOrThrow({ where: { assertionHash: raceAssertion } })).consumedReviewId !== null, true);

    const vaultBinding = await db.posManualPaymentVaultBinding.findUniqueOrThrow({ where: { caseId: opened.case.id } });
    await assert.rejects(db.posManualPaymentVaultBinding.update({ where: { id: vaultBinding.id }, data: { vaultKeyId: `${vaultBinding.vaultKeyId}-changed` } }), /append-only|immutable/i);
    await assert.rejects(db.posManualPaymentVaultBinding.delete({ where: { id: vaultBinding.id } }), /append-only|immutable/i);
  } finally {
    if (gateTriggerDisabled) await db.$executeRawUnsafe(`ALTER TABLE "pos_manual_payment_reconciliation_gates" ENABLE TRIGGER "pos_manual_reconciliation_gate_guard"`).catch(() => undefined);
    await disableInstalledGates(db, installedConnectorIds).catch(() => undefined);
    if (authenticatedRoles) await Promise.all([authenticatedRoles.issuer.end(), authenticatedRoles.runtime.end(), authenticatedRoles.callback.end(), authenticatedRoles.worker.end(), authenticatedRoles.workerPeer.end()]).catch(() => undefined);
    await Promise.all([db.$disconnect(), peer.$disconnect()]);
  }
});

type Context = Awaited<ReturnType<typeof baseContext>>;
type CaseDto = Awaited<ReturnType<typeof openPosManualPaymentCase>>["case"];
type Claim = Awaited<ReturnType<typeof claimPosManualPaymentQueries>>["claimed"][number];
type SqlClaim = Claim & { deliveryNumber: number; vaultBindingId: string; requiresVaultOpen: true };
type ProcedureResult = { caseId: string; assertionId?: string; reviewId?: string; operationId?: number; attemptId?: string; outboxId?: number; resultingState?: string; resultingVersion?: number; consumed?: boolean; currentlyValid?: boolean; replayed: boolean };
type ProviderProofResult = { proofId: string; deliveryProofId?: string; disposition: string; duplicate: boolean; quarantined: boolean };
type DeliveryCompletionResult = { deliveryResultId: string; proofId: string; resultingState: string; resultingVersion: number; processingResult: string; replayed: boolean };
type ClaimQueriesResult = { batchId: string; claimed: SqlClaim[]; claimedCount: number; blockedCount: number; remainingDue: number; hasMore: boolean; vaultOpenAvailable: boolean; replayed: boolean; replayExpired: boolean };

function client() {
  if (!connectionString) throw new Error("POS_TEST_DATABASE_URL ausente");
  return new PrismaClient({ adapter: new PrismaPg({ connectionString }) });
}

async function installAuthenticatedProcedureRoles(db: PrismaClient) {
  if (!connectionString) throw new Error("POS_TEST_DATABASE_URL ausente");
  const identity = await db.$queryRaw<Array<{ database: string; migrator: string }>>(Prisma.sql`SELECT current_database() AS database,current_user AS migrator`);
  const database = identity[0]!.database, migrator = identity[0]!.migrator;
  const names = {
    runtime: `${database}_runtime`, worker: `${database}_mw`, callback: `${database}_mc`, issuer: `${database}_si`, homologator: `${database}_mh`, binder: `${database}_mb`,
  };
  for (const name of [database, migrator, ...Object.values(names)]) {
    if (!/^[a-z_][a-z0-9_]{0,62}$/i.test(name)) throw new Error(`identificador PostgreSQL inseguro: ${name}`);
  }
  const passwords = Object.fromEntries(Object.entries(names).map(([key]) => [key, randomUUID().replaceAll("-", "")])) as Record<keyof typeof names, string>;
  for (const [key, name] of Object.entries(names) as Array<[keyof typeof names, string]>) {
    const exists = await db.$queryRaw<Array<{ exists: boolean }>>(Prisma.sql`SELECT EXISTS(SELECT 1 FROM pg_roles WHERE rolname=${name}) AS exists`);
    if (exists[0]!.exists) await db.$executeRawUnsafe(`ALTER ROLE "${name}" PASSWORD '${passwords[key]}'`);
    else await db.$executeRawUnsafe(`CREATE ROLE "${name}" LOGIN PASSWORD '${passwords[key]}' NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS`);
  }
  const connection = new URL(connectionString);
  await execFileAsync("psql", [
    "--no-psqlrc", "--no-password", "-v", "ON_ERROR_STOP=1",
    "-v", `database_name=${database}`, "-v", `runtime_role=${names.runtime}`, "-v", `migrator_role=${migrator}`,
    "-v", `manual_worker_role=${names.worker}`, "-v", `manual_callback_role=${names.callback}`,
    "-v", `stepup_issuer_role=${names.issuer}`, "-v", `manual_homologator_role=${names.homologator}`,
    "-v", `manual_vault_binder_role=${names.binder}`,
    "-f", "deploy/reconcile-tenant-runtime-grants.sql",
  ], { env: { ...process.env, PGHOST: connection.hostname, PGPORT: connection.port, PGUSER: decodeURIComponent(connection.username), PGPASSWORD: decodeURIComponent(connection.password), PGDATABASE: database } });
  const roleConnection = (role: keyof typeof names) => {
    const url = new URL(connectionString);
    url.username = names[role]; url.password = passwords[role]; url.pathname = `/${database}`;
    return new Client({ connectionString: url.toString() });
  };
  const issuer = roleConnection("issuer"), runtime = roleConnection("runtime"), callback = roleConnection("callback"), worker = roleConnection("worker"), workerPeer = roleConnection("worker");
  await issuer.connect(); await runtime.connect(); await callback.connect(); await worker.connect(); await workerPeer.connect();
  return { issuer, runtime, callback, worker, workerPeer };
}

async function assertPgState(db: Client, sql: string, expectedCode: string, values: unknown[] = []) {
  await assert.rejects(db.query(sql, values), (error: DatabaseError) => {
    assert.equal(error.code, expectedCode, error.message);
    return true;
  });
}

async function issueStepUp(db: PrismaClient, caseId: string, checkerProfileId: number, checkerUserId: string, requestHash: string, assertionHash: string, idempotencyKey: string, decision: "authorize_query" | "reject" = "authorize_query", reasonCode = "manual.query_authorized", expectedCaseVersion = 0) {
  const rows = await db.$queryRaw<Array<{ result: ProcedureResult }>>(Prisma.sql`
    SELECT public."pos_manual_issue_step_up_v1"(
      ${caseId}::uuid, ${expectedCaseVersion}, ${checkerProfileId}, ${checkerUserId}, 'manual_payment.review',
      ${decision}, ${reasonCode}, ${requestHash}, ${assertionHash}, ${idempotencyKey}
    ) AS result
  `);
  return rows[0]!.result;
}

async function reviewProcedure(db: PrismaClient, caseId: string, expectedVersion: number, checkerProfileId: number, checkerUserId: string, assertionHash: string, decision: "authorize_query" | "reject", reasonCode: string, idempotencyKey: string, requestHash: string) {
  const rows = await db.$queryRaw<Array<{ result: ProcedureResult }>>(Prisma.sql`
    SELECT public."pos_manual_review_case_v1"(
      ${caseId}::uuid, ${expectedVersion}, ${checkerProfileId}, ${checkerUserId},
      ${assertionHash}, ${decision}, ${reasonCode}, ${idempotencyKey}, ${requestHash}
    ) AS result
  `);
  return rows[0]!.result;
}

async function attestProviderResult(db: PrismaClient | Prisma.TransactionClient, command: Claim, payload: ManualPaymentQueryCompletionPayload, label: string, transportVariant = "original") {
  const outbox = await db.posManualPaymentOutbox.findUniqueOrThrow({ where: { attemptId: command.attemptId } });
  const eventId = `evt:${digest(label)}`;
  const rows = await db.$queryRaw<Array<{ result: ProviderProofResult }>>(Prisma.sql`
    SELECT public."pos_manual_attest_query_response_v1"(
      ${command.attemptId}::uuid, ${outbox.deliveryCount}, ${command.providerIdempotencyKey},
      ${payload.provider}, ${eventId}, ${digest(`nonce:${label}:${transportVariant}`)}, ${digest(`payload:${label}`)},
      ${digest(`signature:${label}:${transportVariant}`)}, ${digest(`canonical:${label}`)}, ${payload.evidenceHash},
      ${payload.authKeyId}, ${new Date()}, ${payload.outcome}, ${payload.referenceHash}, ${payload.method},
      ${payload.amountCents}, ${payload.currency}, ${payload.providerSequence!}, ${payload.providerOccurredAt!},
      ${payload.credentialRevision}, 'test-verifier-v1'
    ) AS result
  `);
  const result = rows[0]!.result;
  assert.equal(result.quarantined, false);
  return result.deliveryProofId ?? result.proofId;
}

async function completeProviderDelivery(db: PrismaClient | Prisma.TransactionClient, command: Claim, proofId: string, idempotencyKey: string, claimToken = command.claimToken) {
  const rows = await db.$queryRaw<Array<{ result: DeliveryCompletionResult }>>(Prisma.sql`
    SELECT public."pos_manual_complete_delivery_v1"(
      ${command.attemptId}::uuid, ${claimToken}, ${proofId}::uuid, ${idempotencyKey}
    ) AS result
  `);
  return rows[0]!.result;
}

async function attestProviderResultPg(db: Client, command: Claim, deliveryNumber: number, payload: ManualPaymentQueryCompletionPayload, label: string) {
  const result = await db.query<{ result: ProviderProofResult }>(`
    SELECT public."pos_manual_attest_query_response_v1"(
      $1::uuid,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12::timestamptz,$13,$14,$15,$16,$17,$18::bigint,$19::timestamptz,$20,$21
    ) AS result
  `, [command.attemptId, deliveryNumber, command.providerIdempotencyKey, payload.provider, `evt:${digest(label)}`,
    digest(`nonce:${label}`), digest(`payload:${label}`), digest(`signature:${label}`), digest(`canonical:${label}`),
    payload.evidenceHash, payload.authKeyId, new Date(), payload.outcome, payload.referenceHash, payload.method,
    payload.amountCents, payload.currency, payload.providerSequence!.toString(), payload.providerOccurredAt!,
    payload.credentialRevision, "test-verifier-v1"]);
  const proof = result.rows[0]!.result;
  assert.equal(proof.quarantined, false);
  return proof.deliveryProofId ?? proof.proofId;
}

async function completeProviderDeliveryPg(db: Client, command: Claim, proofId: string, idempotencyKey: string) {
  const result = await db.query<{ result: DeliveryCompletionResult }>(
    `SELECT public."pos_manual_complete_delivery_v1"($1::uuid,$2,$3::uuid,$4) AS result`,
    [command.attemptId, command.claimToken, proofId, idempotencyKey],
  );
  return result.rows[0]!.result;
}

async function claimQueriesPg(db: Client, workerId: string, limit: number, leaseSeconds: number, requestIdempotencyKey: string) {
  const result = await db.query<{ result: ClaimQueriesResult }>(
    `SELECT public."pos_manual_claim_queries_v1"($1,$2,$3,$4) AS result`,
    [workerId, limit, leaseSeconds, requestIdempotencyKey],
  );
  return result.rows[0]!.result;
}

async function reportTransportPg(db: Client, command: Claim, kind: "pre_dispatch_failure" | "outcome_unknown" | "protocol_rejected", idempotencyKey: string) {
  const result = await db.query<{ result: DeliveryCompletionResult }>(
    `SELECT public."pos_manual_report_transport_v1"($1::uuid,$2,$3,$4) AS result`,
    [command.attemptId, command.claimToken, kind, idempotencyKey],
  );
  return result.rows[0]!.result;
}

async function recordOrphanCallbackPg(db: Client, label: string) {
  const result = await db.query<{ result: ProviderProofResult }>(`
    SELECT public."pos_manual_record_callback_v1"(
      $1,$2,$3,$4,$5,$6,$7,$8,$9::timestamptz,$10,$11,$12,$13,$14,$15::bigint,$16::timestamptz,$17,$18
    ) AS result
  `, ["orphan-provider", `evt:${digest(label)}`, digest(`nonce:${label}`), digest(`payload:${label}`),
    digest(`signature:${label}`), digest(`canonical:${label}`), digest(`evidence:${label}`), "manual-auth-v1",
    new Date(), "unknown", `hmac-sha256:v1:${digest(`reference:${label}`)}`, "credit", 100, "BRL", "1",
    new Date(), 1, "test-verifier-v1"]);
  return result.rows[0]!.result;
}

async function authenticatedComplete(db: PrismaClient, command: Claim, current: CaseDto, outcome: "unknown" | "confirmed_paid", sequence: number, label: string) {
  const proofId = await attestProviderResult(db, command, completion(command, current, outcome, sequence, label), label);
  return completeProviderDelivery(db, command, proofId, `delivery:${label}`);
}

async function recordCaseCallback(db: PrismaClient, current: CaseDto, label: string, outcome: "unknown" | "confirmed_paid", sequence: number) {
  const stored = await db.posManualPaymentCase.findUniqueOrThrow({ where: { id: current.id } });
  const rows = await db.$queryRaw<Array<{ result: ProviderProofResult }>>(Prisma.sql`
    SELECT public."pos_manual_record_callback_v1"(
      ${current.provider}, ${`evt:${digest(label)}`}, ${digest(`nonce:${label}`)}, ${digest(`payload:${label}`)},
      ${digest(`signature:${label}`)}, ${digest(`canonical:${label}`)}, ${digest(`evidence:${label}`)},
      'manual-auth-v1', ${new Date()}, ${outcome}, ${vaultReferenceHash(current.id)}, ${current.method},
      ${current.amountCents}, ${current.currency}, ${BigInt(sequence)}, ${new Date()}, ${stored.credentialRevision}, 'test-verifier-v1'
    ) AS result
  `);
  return rows[0]!.result;
}

async function issueStepUpPg(db: Client, caseId: string, checkerProfileId: number, checkerUserId: string, requestHash: string, assertionHash: string, idempotencyKey: string, decision: "authorize_query" | "reject", reasonCode: string, expectedCaseVersion = 0) {
  const result = await db.query<{ result: ProcedureResult }>(`
    SELECT public."pos_manual_issue_step_up_v1"($1::uuid,$2,$3,$4,'manual_payment.review',$5,$6,$7,$8,$9) AS result
  `, [caseId, expectedCaseVersion, checkerProfileId, checkerUserId, decision, reasonCode, requestHash, assertionHash, idempotencyKey]);
  return result.rows[0]!.result;
}

async function reviewProcedurePg(db: Client, caseId: string, expectedVersion: number, checkerProfileId: number, checkerUserId: string, assertionHash: string, decision: "authorize_query" | "reject", reasonCode: string, idempotencyKey: string, requestHash: string) {
  const result = await db.query<{ result: ProcedureResult }>(`
    SELECT public."pos_manual_review_case_v1"($1::uuid,$2,$3,$4,$5,$6,$7,$8,$9) AS result
  `, [caseId, expectedVersion, checkerProfileId, checkerUserId, assertionHash, decision, reasonCode, idempotencyKey, requestHash]);
  return result.rows[0]!.result;
}

async function openProcedureCase(db: PrismaClient, vault: ReturnType<typeof vaultAdapter>, context: Context, token: string, rawReference: string, amountCents: number) {
  const plan = await createActiveManualPlan(db, context, token, amountCents);
  const opened = await openVia321f(db, context, openInput(plan.planId, context, rawReference, `open-${token}`));
  caseReferenceHashes.set(opened.case.id, referenceHash(rawReference));
  return opened;
}

async function baseContext(db: PrismaClient, token: string, compact: string) {
  const role = await db.tenantRole.findFirstOrThrow({ where: { active: true } });
  const branch = await db.branch.create({ data: { code: `MS${compact}`, name: `Manual service ${compact}`, legalName: `Manual service ${compact} Ltda`, document: `MSDOC${compact}` } });
  const register = await db.posRegister.create({ data: { branchId: branch.id, code: `MR${compact}`, name: `Manual register ${compact}` } });
  const maker = await db.tenantUserProfile.create({ data: { userId: `maker-${token}`, roleId: role.id, displayName: "Maker", email: `${compact}.maker@example.invalid`, activeBranchId: branch.id } });
  const checker = await db.tenantUserProfile.create({ data: { userId: `checker-${token}`, roleId: role.id, displayName: "Checker", email: `${compact}.checker@example.invalid`, activeBranchId: branch.id } });
  await db.branchUserAccess.createMany({ data: [{ branchId: branch.id, userProfileId: maker.id, canSell: true }, { branchId: branch.id, userProfileId: checker.id, canSell: true }] });
  await db.posRegisterAccess.createMany({ data: [
    { registerId: register.id, userProfileId: maker.id, active: true, canSell: true, canManualPayment: true },
    { registerId: register.id, userProfileId: checker.id, active: true, canSell: true, canReviewManualPayment: true, manualPaymentReviewLimitCents: 100_000 },
  ] });
  const now = new Date(), terminal = await db.posTerminal.create({ data: { id: `manual-terminal-${token}`, registerId: register.id, code: `MT${compact}`, name: "Manual terminal", status: "online", tokenHash: `hmac-sha256:v1:${digest(token)}`, tokenIssuedAt: now, tokenExpiresAt: new Date(now.valueOf() + 3_600_000), credentialVersion: 1, pairedAt: now, lastSeenAt: now, appVersion: "test" } });
  const session = await db.cashRegisterSession.create({ data: { number: `MANUAL-${token}`, registerName: register.name, status: "open", openingAmount: 0, openingAmountCents: 0, openedBy: maker.displayName, registerId: register.id, operatorProfileId: maker.id } });
  const provider = `manual_${compact}`;
  await db.integrationProvider.create({ data: { id: provider, family: "payment", label: "Manual provider", description: "fixture", recipientType: "none", authType: "api_key", capabilities: {}, credentialSchema: {} } });
  const credential = await db.integrationCredential.create({ data: { id: `manual-credential-${token}`, providerId: provider, label: "Manual credential", enabled: true, config: { manualReconciliation: { callbackAuthKeyIds: ["manual-auth-v1"] } } } });
  const connector = await db.posConnector.create({ data: { id: `manual-connector-${token}`, branchId: branch.id, registerId: register.id, type: `manual_${compact}`, provider, credentialRef: credential.id, status: "active", settings: { capabilities: ["manual_reference_query"], manualReconciliation: { enabled: true, vaultBindingRequired: true } } } });
  const product = await db.product.create({ data: { name: `Manual product ${compact}`, slug: `manual-product-${compact}`, sku: `MSKU-${compact}`, category: "Teste", price: 10, regularPrice: 10, manageStock: false } });
  return { role, branch, register, maker, checker, terminal, session, provider, credential, connector, product };
}

async function secondaryContext(db: PrismaClient, base: Context, token: string, compact: string): Promise<Context> {
  const register = await db.posRegister.create({ data: { branchId: base.branch.id, code: `MR${compact}`, name: `Manual register ${compact}` } });
  const maker = await db.tenantUserProfile.create({ data: { userId: `maker-${token}`, roleId: base.role.id, displayName: "Maker secondary", email: `${compact}.maker@example.invalid`, activeBranchId: base.branch.id } });
  const checker = await db.tenantUserProfile.create({ data: { userId: `checker-${token}`, roleId: base.role.id, displayName: "Checker secondary", email: `${compact}.checker@example.invalid`, activeBranchId: base.branch.id } });
  await db.branchUserAccess.createMany({ data: [{ branchId: base.branch.id, userProfileId: maker.id, canSell: true }, { branchId: base.branch.id, userProfileId: checker.id, canSell: true }] });
  await db.posRegisterAccess.createMany({ data: [
    { registerId: register.id, userProfileId: maker.id, active: true, canSell: true, canManualPayment: true },
    { registerId: register.id, userProfileId: checker.id, active: true, canSell: true, canReviewManualPayment: true, manualPaymentReviewLimitCents: 100_000 },
  ] });
  const now = new Date(), terminal = await db.posTerminal.create({ data: { id: `manual-terminal-${token}`, registerId: register.id, code: `MT${compact}`, name: "Manual terminal secondary", status: "online", tokenHash: `hmac-sha256:v1:${digest(token)}`, tokenIssuedAt: now, tokenExpiresAt: new Date(now.valueOf() + 3_600_000), credentialVersion: 1, pairedAt: now, lastSeenAt: now, appVersion: "test" } });
  const session = await db.cashRegisterSession.create({ data: { number: `MANUAL-${token}`, registerName: register.name, status: "open", openingAmount: 0, openingAmountCents: 0, openedBy: maker.displayName, registerId: register.id, operatorProfileId: maker.id } });
  const connector = await db.posConnector.create({ data: { id: `manual-connector-${token}`, branchId: base.branch.id, registerId: register.id, type: `manual_${compact}`, provider: base.provider, credentialRef: base.credential.id, status: "active", settings: { capabilities: ["manual_reference_query"], manualReconciliation: { enabled: true, vaultBindingRequired: true } } } });
  return { ...base, register, maker, checker, terminal, session, connector };
}

async function installGate(db: PrismaClient, connectorId: string, connectorRevision: number, credentialRef: string, credentialRevision: number) {
  await db.posManualPaymentReconciliationGate.create({ data: { connectorId, connectorRevision, credentialRef, credentialRevision, enabled: true, vaultAdapterId: "vault-test", providerAdapterVersion: "adapter-v1", enabledBy: "postgres-service-test", enabledAt: new Date(), configHash: "c".repeat(64) } });
}

async function disableInstalledGates(db: PrismaClient, connectorIds: string[]) {
  for (const connectorId of connectorIds) await db.posManualPaymentReconciliationGate.updateMany({ where: { connectorId, enabled: true }, data: { enabled: false } });
}

async function createActiveManualPlan(db: PrismaClient, context: Context, token: string, amountCents: number) {
  const planId = `manual-plan-${token}`, draftId = `manual-draft-${token}`, requestHash = digest(token), evaluatedAt = new Date(), expiresAt = new Date(evaluatedAt.valueOf() + 5 * 60_000);
  await db.$transaction(async tx => {
    const draft = await tx.posHeldSale.create({ data: { id: draftId, registerId: context.register.id, sessionId: context.session.id, operatorProfileId: context.maker.id, status: "draft", idempotencyKey: `draft-${token}`, requestHash, items: { create: { productId: context.product.id, quantity: 1, unitPriceCents: amountCents, discountCents: 0 } } }, include: { items: true } });
    await tx.posPaymentPlan.create({ data: { id: planId, branchId: context.branch.id, registerId: context.register.id, sessionId: context.session.id, operatorProfileId: context.maker.id, terminalId: context.terminal.id, saleDraftId: draftId, draftRevision: 0, draftRequestHash: requestHash, draftStatus: "draft", quoteHash: requestHash, evaluatedAt, expiresAt, totalCents: amountCents, idempotencyKey: `quote-${token}`, requestHash } });
    await tx.posPaymentPlanQuoteLine.create({ data: { planId, lineIndex: 0, heldSaleItemId: draft.items[0].id, productId: context.product.id, quantity: 1, unitPriceCents: amountCents, grossCents: amountCents, baseDiscountCents: 0, orderDiscountCents: 0, promotionDiscountCents: 0, surchargeCents: 0, totalCents: amountCents } });
    await tx.posPaymentPlanOperation.create({ data: { planId, action: "quote", expectedVersion: -1, resultingVersion: 0, resultingState: "quoted", idempotencyKey: `quote-${token}`, requestHash } });
  });
  await db.$transaction(async tx => {
    await tx.posPaymentPlanSlot.create({ data: { planId, paymentIndex: 0, method: "credit", amountCents, installments: 1, proofKind: "manual", connectorId: context.connector.id, credentialRef: context.credential.id, provider: context.provider } });
    await transitionPlan(tx, planId, `activate-${token}`, requestHash);
  });
  return { planId, expiresAt };
}

async function openVia321f(db: PrismaClient, context: Context, input: ReturnType<typeof openInput>) {
  const prepareKey=digest(`prepare:${input.idempotencyKey}`), intent=digestCanonical({paymentPlanId:input.paymentPlanId,paymentIndex:0,makerProfileId:input.makerProfileId,makerUserId:input.makerUserId,occurredAt:input.occurredAt,reasonCode:input.reasonCode,stableReferenceIndex:`vault-blind:v1:${digest(`blind:${input.rawReference}`)}`});
  const prepared=(await db.$queryRaw<Array<{result:OpenPreparedResult}>>(Prisma.sql`SELECT public."pos_manual_prepare_open_v1"(${input.paymentPlanId},0,${input.makerProfileId},${input.makerUserId},${input.occurredAt},${input.reasonCode},${prepareKey},${intent}) result`))[0]!.result;
  if(prepared.state==="finalized"){const existing=await db.posManualPaymentCase.findUniqueOrThrow({where:{paymentPlanId_paymentIndex:{paymentPlanId:input.paymentPlanId,paymentIndex:0}}});return {case:{...existing,referenceMasked:`•••• ${existing.referenceLastFour}`},replayed:true};}
  const claimKey=digest(`claim:${input.idempotencyKey}`),claim=(await db.$queryRaw<Array<{result:OpenClaimResult}>>(Prisma.sql`SELECT public."pos_manual_claim_open_for_vault_v1"(${prepared.requestId}::uuid,${prepared.ticket},'service-pg-binder',${claimKey},30) result`))[0]!.result;
  await db.posManualVaultVerifier.upsert({where:{verifierVersion:"service-pg-verifier-v1"},create:{verifierVersion:"service-pg-verifier-v1",enabled:true,maxFutureSkewSeconds:30},update:{enabled:true}});
  const plan=await db.posPaymentPlan.findUniqueOrThrow({where:{id:input.paymentPlanId}}),issuedAt=new Date(),retentionExpiresAt=new Date(plan.expiresAt.valueOf()+30_000),externalProofId=`proof-${digest(input.idempotencyKey).slice(0,48)}`,stableReferenceIndex=`vault-blind:v1:${digest(`blind:${input.rawReference}`)}`,reference=referenceHash(input.rawReference),binding=digest(`binding:${input.idempotencyKey}`),signature=digest(`signature:${input.idempotencyKey}`);
  const proof=(await db.$queryRaw<Array<{hash:string}>>(Prisma.sql`SELECT encode(sha256(convert_to('pos-manual-vault-proof-v1'||jsonb_build_array(${prepared.requestId}::uuid,${BigInt(claim.fencingToken)}::bigint,${claim.vaultIdempotencyKey}::text,'vault-test'::text,${context.provider}::text,${externalProofId}::text,${stableReferenceIndex}::text,${reference}::text,'reference-key-v1'::text,${input.rawReference.slice(-4)}::text,'vault-key-v1'::text,${binding}::text,${signature}::text,extract(epoch FROM ${issuedAt}::timestamptz),extract(epoch FROM ${retentionExpiresAt}::timestamptz),'service-pg-verifier-v1'::text)::text,'UTF8')),'hex') hash`))[0]!.hash;
  const opened=(await db.$queryRaw<Array<{result:OpenCaseResult}>>(Prisma.sql`SELECT public."pos_manual_open_case_v1"(${prepared.requestId}::uuid,${claim.claimToken},${BigInt(claim.fencingToken)},${digest(`finalize:${input.idempotencyKey}`)},${externalProofId},${stableReferenceIndex},${reference},'reference-key-v1',${input.rawReference.slice(-4)},'vault-key-v1',${binding},${proof},${signature},${issuedAt},${retentionExpiresAt},'service-pg-verifier-v1') result`))[0]!.result;
  const stored=await db.posManualPaymentCase.findUniqueOrThrow({where:{id:opened.caseId}});return {case:{...stored,referenceMasked:`•••• ${stored.referenceLastFour}`},replayed:Boolean(opened.replayed)};
}

async function transitionPlan(tx: Prisma.TransactionClient, planId: string, idempotencyKey: string, requestHash: string) {
  await tx.posPaymentPlanOperation.create({ data: { planId, action: "activate", expectedVersion: 0, resultingVersion: 1, resultingState: "active", idempotencyKey, requestHash } });
  await tx.posPaymentPlan.update({ where: { id: planId }, data: { state: "active", version: 1 } });
}

function openInput(planId: string, context: Context, rawReference: string, idempotencyKey: string) {
  return { paymentPlanId: planId, paymentIndex: 0 as const, makerProfileId: context.maker.id, makerUserId: context.maker.userId, rawReference, occurredAt: new Date(), reasonCode: "manual.external_terminal", idempotencyKey };
}

async function openAndAuthorize(db: PrismaClient, vault: ReturnType<typeof vaultAdapter>, context: Context, token: string, rawReference: string, amountCents: number) {
  const plan = await createActiveManualPlan(db, context, token, amountCents);
  const opened = await openVia321f(db, context, openInput(plan.planId, context, rawReference, `open-${token}`));
  caseReferenceHashes.set(opened.case.id, referenceHash(rawReference));
  await authorize(db, opened.case.id, context, `review-${token}`);
  return opened;
}

async function authorize(db: PrismaClient, caseId: string, context: Context, idempotencyKey: string) {
  const assertionHash = digest(`assertion-${idempotencyKey}`), reasonCode = "manual.query_authorized";
  const requestHash = digestCanonical({ caseId, checkerProfileId: context.checker.id, checkerUserId: context.checker.userId, assertionHash, decision: "authorize_query", reasonCode });
  await db.posManualPaymentStepUpAssertion.create({ data: { caseId, expectedCaseVersion: 0, checkerProfileId: context.checker.id, checkerUserId: context.checker.userId, purpose: "manual_payment.review", decision: "authorize_query", reasonCode, requestHash, assertionHash, idempotencyKey: `step-up-${idempotencyKey}`, verifiedAt: new Date(), expiresAt: new Date(Date.now() + 300_000) } });
  const reviewed = await reviewPosManualPaymentCase(db, { caseId, checkerProfileId: context.checker.id, checkerUserId: context.checker.userId, assertionHash, decision: "authorize_query", reasonCode, idempotencyKey });
  const replay = await reviewPosManualPaymentCase(db, { caseId, checkerProfileId: context.checker.id, checkerUserId: context.checker.userId, assertionHash, decision: "authorize_query", reasonCode, idempotencyKey });
  assert.equal(reviewed.replayed, false);
  assert.equal(replay.replayed, true);
  const [storedReview, storedAssertion, branchGrant, registerGrant] = await Promise.all([
    db.posManualPaymentReview.findUniqueOrThrow({ where: { caseId } }),
    db.posManualPaymentStepUpAssertion.findUniqueOrThrow({ where: { assertionHash } }),
    db.branchUserAccess.findUniqueOrThrow({ where: { branchId_userProfileId: { branchId: context.branch.id, userProfileId: context.checker.id } } }),
    db.posRegisterAccess.findUniqueOrThrow({ where: { registerId_userProfileId: { registerId: context.register.id, userProfileId: context.checker.id } } }),
  ]);
  assert.equal(storedReview.makerProfileId, context.maker.id);
  assert.equal(storedReview.makerUserId, context.maker.userId);
  assert.equal(storedReview.checkerProfileId, context.checker.id);
  assert.equal(storedReview.checkerUserId, context.checker.userId);
  assert.equal(storedReview.branchGrantId, branchGrant.id);
  assert.equal(storedReview.registerGrantId, registerGrant.id);
  assert.equal(storedReview.authorityLimitCents, registerGrant.manualPaymentReviewLimitCents);
  assert.equal(storedReview.stepUpEvidenceId, storedAssertion.id);
  assert.equal(storedReview.stepUpVerifiedAt.valueOf(), storedAssertion.verifiedAt.valueOf());
  assert.equal(storedReview.stepUpExpiresAt.valueOf(), storedAssertion.expiresAt.valueOf());
  assert.equal(storedAssertion.consumedReviewId, storedReview.id);
  assert.ok(storedAssertion.consumedAt, "assertion one-shot deve ser consumida pela review");
}

async function claimAfterTerminalContention(db: PrismaClient, peer: PrismaClient, terminalId: string, input: { workerId: string; limit: number; leaseSeconds: number }) {
  let signalLockAcquired!: () => void, releaseLock!: () => void;
  const lockAcquired = new Promise<void>(resolve => { signalLockAcquired = resolve; });
  const lockRelease = new Promise<void>(resolve => { releaseLock = resolve; });
  const blocker = peer.$transaction(async tx => {
    await tx.$queryRaw(Prisma.sql`SELECT "id" FROM "pos_terminals" WHERE "id"=${terminalId} FOR UPDATE`);
    signalLockAcquired();
    await lockRelease;
  }, { maxWait: 5_000, timeout: 10_000 });
  await lockAcquired;
  const claimPromise = claimPosManualPaymentQueries(db, input);
  try {
    await new Promise(resolve => setTimeout(resolve, 2_000));
  } finally {
    releaseLock();
    await blocker;
  }
  const result = await claimPromise;
  const clock = await db.$queryRaw<Array<{ now: Date }>>(Prisma.sql`SELECT clock_timestamp() AS "now"`);
  assert.equal(result.claimedCount, 1);
  assert.ok(result.claimed[0].claimExpiresAt.valueOf() - clock[0].now.valueOf() > 29_000, "lease deve nascer do relógio pós-lock, não do instante de seleção");
  return result;
}

async function rejectExpiredGrantUnderContention(db: PrismaClient, peer: PrismaClient, caseId: string, context: Context, idempotencyKey: string) {
  const assertionHash = digest(`assertion-${idempotencyKey}`), reasonCode = "manual.query_authorized", reviewId = randomUUID();
  const requestHash = digestCanonical({ caseId, checkerProfileId: context.checker.id, checkerUserId: context.checker.userId, assertionHash, decision: "authorize_query", reasonCode });
  const grantExpiresAt = new Date(Date.now() + 1_500);
  await db.posRegisterAccess.update({ where: { registerId_userProfileId: { registerId: context.register.id, userProfileId: context.checker.id } }, data: { validUntil: grantExpiresAt } });
  await db.posManualPaymentStepUpAssertion.create({ data: { caseId, expectedCaseVersion: 0, checkerProfileId: context.checker.id, checkerUserId: context.checker.userId, purpose: "manual_payment.review", decision: "authorize_query", reasonCode, requestHash, assertionHash, idempotencyKey: `step-up-${idempotencyKey}`, verifiedAt: new Date(), expiresAt: new Date(Date.now() + 300_000) } });

  let signalLockAcquired!: () => void, releaseLock!: () => void;
  const lockAcquired = new Promise<void>(resolve => { signalLockAcquired = resolve; });
  const lockRelease = new Promise<void>(resolve => { releaseLock = resolve; });
  const blocker = peer.$transaction(async tx => {
    await tx.$queryRaw(Prisma.sql`SELECT "id" FROM "pos_register_accesses" WHERE "register_id"=${context.register.id} AND "user_profile_id"=${context.checker.id} FOR UPDATE`);
    signalLockAcquired();
    await lockRelease;
  }, { maxWait: 5_000, timeout: 10_000 });
  await lockAcquired;
  // Use a direct INSERT so contention happens inside validate_pos_manual_review,
  // rather than being rejected by the service's own preflight access locks.
  const reviewOutcome = db.$executeRaw(Prisma.sql`
    INSERT INTO "pos_manual_payment_reviews" (
      "id", "case_id", "decision", "maker_profile_id", "maker_user_id",
      "checker_profile_id", "checker_user_id", "step_up_evidence_id",
      "step_up_proof_hash", "step_up_verified_at", "step_up_expires_at",
      "branch_grant_id", "register_grant_id", "authority_limit_cents",
      "reason_code", "idempotency_key", "request_hash", "write_txid"
    ) VALUES (
      ${reviewId}::uuid, ${caseId}::uuid, 'authorize_query', ${context.maker.id}, ${context.maker.userId},
      ${context.checker.id}, ${context.checker.userId}, 'caller-sentinel-evidence',
      ${assertionHash}, clock_timestamp(), clock_timestamp() + interval '1 second',
      -1, -1, 0, ${reasonCode}, ${idempotencyKey}, ${requestHash}, txid_current()::numeric
    )
  `)
    .then(value => ({ value, error: null as unknown }), error => ({ value: null, error }));
  try {
    await new Promise(resolve => setTimeout(resolve, Math.max(0, grantExpiresAt.valueOf() - Date.now() + 150)));
  } finally {
    releaseLock();
    await blocker;
  }
  const outcome = await reviewOutcome;
  await db.posRegisterAccess.update({ where: { registerId_userProfileId: { registerId: context.register.id, userProfileId: context.checker.id } }, data: { validUntil: null } });
  assert.equal(outcome.value, null);
  assert.match(String(outcome.error), /manual payment review requires distinct checker, live grants and bounded step-up/i);
  const [assertion, review] = await Promise.all([
    db.posManualPaymentStepUpAssertion.findUniqueOrThrow({ where: { assertionHash } }),
    db.posManualPaymentReview.findUnique({ where: { caseId } }),
  ]);
  assert.equal(assertion.consumedAt, null);
  assert.equal(assertion.consumedReviewId, null);
  assert.equal(review, null);
}

function completion(command: Claim, current: CaseDto, outcome: "unknown" | "confirmed_paid", sequence: number, evidence: string): ManualPaymentQueryCompletionPayload {
  return { attemptId: command.attemptId, claimToken: command.claimToken, provider: command.provider, connectorRevision: command.connectorRevision, credentialRevision: command.credentialRevision, providerAdapterVersion: command.providerAdapterVersion, gateConfigHash: command.gateConfigHash, outcome, referenceHash: vaultReferenceHash(current.id), method: current.method, amountCents: current.amountCents, currency: current.currency, evidenceHash: digest(evidence), providerSequence: BigInt(sequence), providerOccurredAt: new Date(), authKeyId: "manual-auth-v1" };
}

function withResponseHash(payload: ManualPaymentQueryCompletionPayload) { return { ...payload, responseHash: hashManualPaymentQueryCompletion(payload) }; }

function vaultAdapter() {
  const bindings = new Map<string, Awaited<ReturnType<PosManualReferenceVaultAdapter["bindReference"]>>>(), reconciled: string[] = [];
  const adapter: PosManualReferenceVaultAdapter & { reconciled: string[] } = {
    adapterId: "vault-test",
    reconciled,
    bindReference: async input => {
      const existing = bindings.get(input.idempotencyKey);
      if (existing) return { ...existing, created: false };
      const value = { vaultReference: `vault-${digest(input.idempotencyKey)}`, vaultKeyId: "vault-key-v1", bindingHash: digest(`binding:${input.idempotencyKey}`), stableReferenceIndex: `vault-blind:v1:${digest(`blind:${input.rawReference}`)}`, referenceHash: referenceHash(input.rawReference), referenceKeyId: "reference-key-v1", referenceLastFour: input.rawReference.slice(-4), retentionExpiresAt: input.retentionExpiresAt, created: true };
      bindings.set(input.idempotencyKey, value);
      return value;
    },
    reconcileOrphanBinding: async input => { reconciled.push(input.vaultReference); return "released"; },
  };
  return adapter;
}

const caseReferenceHashes = new Map<string, string>();
function vaultReferenceHash(caseId: string) {
  const byCase = caseReferenceHashes.get(caseId);
  if (byCase) return byCase;
  throw new Error(`reference hash not registered for ${caseId}`);
}
function referenceHash(rawReference: string) { return `hmac-sha256:v1:${digest(`reference:${rawReference}`)}`; }

function digest(value: string) { return createHash("sha256").update(value).digest("hex"); }
function digestCanonical(value: unknown) { return createHash("sha256").update(canonicalJson(value)).digest("hex"); }
function canonicalJson(value: unknown): string { if (typeof value === "bigint") return JSON.stringify(value.toString()); if (value instanceof Date) return JSON.stringify(value.toISOString()); if (value === null || typeof value !== "object") return JSON.stringify(value); if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`; const record = value as Record<string, unknown>; return `{${Object.keys(record).filter(key => record[key] !== undefined).sort().map(key => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(",")}}`; }
