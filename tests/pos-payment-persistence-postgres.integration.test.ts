import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import test from "node:test";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../generated/tenant/client";
import {
  acceptPosPaymentCallback,
  claimPosPaymentOutbox,
  completePosPaymentOutbox,
  consumeCapturedPosPaymentIntent,
  maintainPosPaymentPersistence,
} from "../lib/erp/pos-payment-persistence";
import { consumePosPaymentPlan } from "../lib/erp/pos-payment-plan";

const connectionString = process.env.POS_TEST_DATABASE_URL;

test("PostgreSQL serializa claim, preserva unknown sem identidade sintética e captura callback uma vez", { skip: !connectionString }, async () => {
  const first = client(), second = client(), token = safeToken(), compact = token.replaceAll("-", "");
  const provider = `pg_${compact}`, hash = createHash("sha256").update(token).digest("hex"), now = new Date();
  try {
    const role = await first.tenantRole.findFirst({ where: { active: true }, select: { id: true } });
    assert.ok(role, "a base descartável deve possuir papel ativo");
    const branch = await first.branch.create({ data: { code: `PGPAY${compact}`, name: "Filial payment isolada", legalName: "Filial payment isolada Ltda", document: `PGPAYDOC${compact}` } });
    const register = await first.posRegister.create({ data: { branchId: branch.id, code: `PGPAYREG${compact}`, name: "Caixa payment isolado" } });
    const terminal = await first.posTerminal.create({ data: { id: `terminal-${token}`, registerId: register.id, code: `PGPAYTERM${compact}`, name: "Terminal payment isolado", status: "online", tokenHash: `hmac-sha256:v1:${hash}`, tokenIssuedAt: now, tokenExpiresAt: new Date(now.valueOf() + 3_600_000), credentialVersion: 1, pairedAt: now, lastSeenAt: now, appVersion: "test" } });
    const profile = await first.tenantUserProfile.create({ data: { userId: `pg-payment-${token}`, roleId: role.id, displayName: "Operador payment isolado", email: `pg-payment-${compact}@example.invalid`, activeBranchId: branch.id } });
    await first.branchUserAccess.create({ data: { branchId: branch.id, userProfileId: profile.id, canSell: true } });
    await first.posRegisterAccess.create({ data: { registerId: register.id, userProfileId: profile.id, active: true, canSell: true } });
    const session = await first.cashRegisterSession.create({ data: { number: `PG-PAY-${token}`, registerName: register.name, status: "open", openingAmount: 0, openingAmountCents: 0, openedBy: profile.displayName, registerId: register.id, operatorProfileId: profile.id } });
    await first.integrationProvider.create({ data: { id: provider, family: "payment", label: "PSP PostgreSQL isolado", description: "Fixture descartável", recipientType: "none", authType: "api_key", capabilities: {}, credentialSchema: {} } });
    const credential = await first.integrationCredential.create({ data: { id: `credential-${token}`, providerId: provider, label: "Credencial PostgreSQL isolada", enabled: true, config: {} } });
    const connector = await first.posConnector.create({ data: { id: `connector-${token}`, branchId: register.branchId, registerId: register.id, type: `payment_pg_${compact}`, provider, credentialRef: credential.id, status: "active" } });
    const product = await first.product.create({ data: { name: "Produto payment isolado", slug: `pg-payment-${compact}`, sku: `PGPAY-${compact}`, category: "Teste", price: 12.34, regularPrice: 12.34, manageStock: false } });
    const intentId = `payment-intent-${token}`, saleDraftId = `sale-draft-${token}`, attemptId = `payment-attempt-${token}`;
    const primary = await createPlanIntent(first, { token: `primary-${token}`, branchId: register.branchId, registerId: register.id, terminalId: terminal.id, sessionId: session.id, profileId: profile.id, connectorId: connector.id, credentialId: credential.id, provider, productId: product.id, intentId, attemptId, saleDraftId, amountCents: 1_234, method: "credit", installments: 2, hash, now });

    const claimAt = new Date(now.valueOf() + 1_000);
    const claims = await Promise.all([
      claimPosPaymentOutbox(first, { workerId: `worker-a-${compact}`, limit: 1, leaseSeconds: 60, now: claimAt }),
      claimPosPaymentOutbox(second, { workerId: `worker-b-${compact}`, limit: 1, leaseSeconds: 60, now: claimAt }),
    ]);
    const targetClaims = claims.flatMap(result => result.claimed).filter(command => command.intent.id === intentId);
    assert.equal(targetClaims.length, 1);
    const command = targetClaims[0];
    assert.ok(command);

    const unknownPayload = { attemptId, claimToken: command.claimToken, result: { kind: "unknown" as const, failureCode: "transport_timeout", failureMessage: "sem resultado conclusivo" } };
    const unknown = await completePosPaymentOutbox(first, unknownPayload, new Date(claimAt.valueOf() + 1_000));
    assert.equal(unknown.intent.status, "unknown");
    assert.equal(unknown.intent.providerReference, null);
    assert.equal(unknown.intent.providerSequence, null);
    assert.equal(unknown.intent.providerOccurredAt, null);
    assert.ok(unknown.intent.unknownSince);
    assert.ok(unknown.intent.nextReconcileAt);

    const retryIntentId = `payment-retry-${token}`, retryAttemptId = `payment-retry-attempt-${token}`;
    await createPlanIntent(first, { token: `retry-${token}`, branchId: register.branchId, registerId: register.id, terminalId: terminal.id, sessionId: session.id, profileId: profile.id, connectorId: connector.id, credentialId: credential.id, provider, productId: product.id, intentId: retryIntentId, attemptId: retryAttemptId, saleDraftId: `retry-draft-${token}`, amountCents: 777, method: "debit", installments: 1, hash, now });
    const retryClaim = (await claimPosPaymentOutbox(first, { workerId: `worker-retry-${compact}`, limit: 1, leaseSeconds: 60, now: new Date(claimAt.valueOf() + 2_000) })).claimed[0];
    assert.ok(retryClaim);
    const retryFailure = { attemptId: retryAttemptId, claimToken: retryClaim.claimToken, result: { kind: "known_failure" as const, retryable: true, failureCode: "provider_unavailable", failureMessage: null } };
    const firstFailure = await completePosPaymentOutbox(first, retryFailure, new Date(claimAt.valueOf() + 3_000));
    assert.equal(firstFailure.retryScheduled, true);
    const replayedFailure = await completePosPaymentOutbox(second, retryFailure, new Date(claimAt.valueOf() + 4_000));
    assert.equal(replayedFailure.replayed, true);
    assert.equal(replayedFailure.deliveryNumber, firstFailure.deliveryNumber);
    assert.equal(await first.posPaymentDeliveryResult.count({ where: { attemptId: retryAttemptId } }), 1);
    const secondRetryClaim = (await claimPosPaymentOutbox(first, { workerId: `worker-retry-2-${compact}`, limit: 1, leaseSeconds: 60, now: new Date(claimAt.valueOf() + 20_000) })).claimed[0];
    assert.ok(secondRetryClaim);
    const lateReplay = await completePosPaymentOutbox(second, retryFailure, new Date(claimAt.valueOf() + 21_000));
    assert.equal(lateReplay.replayed, true);
    assert.equal((await first.posPaymentOutbox.findUniqueOrThrow({ where: { attemptId: retryAttemptId } })).state, "claimed");
    await completePosPaymentOutbox(first, { attemptId: retryAttemptId, claimToken: secondRetryClaim.claimToken, result: { kind: "known_failure", retryable: false, failureCode: "provider_rejected", failureMessage: null } }, new Date(claimAt.valueOf() + 22_000));
    assert.equal(await first.posPaymentDeliveryResult.count({ where: { attemptId: retryAttemptId } }), 2);

    const occurredAt = new Date(claimAt.valueOf() + 2_000), providerReference = `capture-${token}`;
    const callbackInput = {
      intentId, provider, providerReference, state: "captured" as const, amountCents: 1_234, currency: "BRL" as const,
      providerSequence: BigInt(1), occurredAt, evidenceId: `evidence-${token}`, transactionId: `transaction-${token}`,
      endToEndId: null, nsu: `nsu-${compact}`, authorizationCode: `auth-${compact}`, cardBrand: "test", cardLastFour: "4242",
      failureCode: null, failureMessage: null,
    };
    const callbackHash = createHash("sha256").update(JSON.stringify({ token, state: "captured" })).digest("hex");
    const captured = await acceptPosPaymentCallback(first, provider, `event-capture-${token}`, "pg-key", callbackHash, callbackInput);
    assert.equal(captured.state, "captured");
    assert.equal(captured.applied, true);
    const replay = await acceptPosPaymentCallback(second, provider, `event-capture-${token}`, "pg-key", callbackHash, callbackInput);
    assert.equal(replay.duplicate, true);
    assert.equal(replay.state, "captured");
    await assert.rejects(acceptPosPaymentCallback(second, provider, `event-capture-${token}`, "pg-key", "f".repeat(64), callbackInput), /outro conteúdo/);

    const stale = await acceptPosPaymentCallback(first, provider, `event-stale-${token}`, "pg-key", "e".repeat(64), { ...callbackInput, state: "processing", occurredAt: new Date(occurredAt.valueOf() - 1_000) });
    assert.equal(stale.result, "ignored_stale");
    assert.equal(stale.state, "captured");

    const duplicateCardIntentId = `payment-card-duplicate-${token}`;
    await createPlanIntent(first, { token: `card-duplicate-${token}`, branchId: register.branchId, registerId: register.id, terminalId: terminal.id, sessionId: session.id, profileId: profile.id, connectorId: connector.id, credentialId: credential.id, provider, productId: product.id, intentId: duplicateCardIntentId, attemptId: `card-duplicate-attempt-${token}`, saleDraftId: `card-duplicate-draft-${token}`, amountCents: 1_234, method: "credit", installments: 2, hash, now: new Date(now.valueOf() + 86_400_000) });
    await assert.rejects(acceptPosPaymentCallback(first, provider, `event-card-duplicate-${token}`, "pg-key", "c".repeat(64), { ...callbackInput, intentId: duplicateCardIntentId, providerReference: `card-duplicate-reference-${token}`, transactionId: `TRANSACTION-${token.toUpperCase()}`, providerSequence: BigInt(2), occurredAt: new Date(occurredAt.valueOf() + 500) }), /evidência do provedor já foi vinculada/);
    assert.equal((await first.posPaymentIntent.findUniqueOrThrow({ where: { id: duplicateCardIntentId } })).status, "created");

    const racedIntentId = `payment-race-${token}`, racedAttemptId = `attempt-race-${token}`;
    await createPlanIntent(first, { token: `race-${token}`, branchId: register.branchId, registerId: register.id, terminalId: terminal.id, sessionId: session.id, profileId: profile.id, connectorId: connector.id, credentialId: credential.id, provider, productId: product.id, intentId: racedIntentId, attemptId: racedAttemptId, saleDraftId: `race-draft-${token}`, amountCents: 500, method: "pix", installments: 1, hash, now });
    const racedClaim = (await claimPosPaymentOutbox(first, { workerId: `worker-race-${compact}`, limit: 1, leaseSeconds: 60, now: claimAt })).claimed[0];
    assert.ok(racedClaim);
    const racedObservation = { ...callbackInput, intentId: racedIntentId, providerReference: `race-reference-${token}`, amountCents: 500, transactionId: `race-transaction-${token}`, endToEndId: `E1234567820260829${compact.slice(0, 15).toUpperCase()}`, nsu: null, authorizationCode: null, cardBrand: null, cardLastFour: null, providerSequence: BigInt(1), occurredAt: new Date(occurredAt.valueOf() + 1_000) };
    await acceptPosPaymentCallback(second, provider, `event-race-${token}`, "pg-key", "d".repeat(64), racedObservation);
    const duplicatePixIntentId = `payment-pix-duplicate-${token}`;
    await createPlanIntent(first, { token: `pix-duplicate-${token}`, branchId: register.branchId, registerId: register.id, terminalId: terminal.id, sessionId: session.id, profileId: profile.id, connectorId: connector.id, credentialId: credential.id, provider, productId: product.id, intentId: duplicatePixIntentId, attemptId: `pix-duplicate-attempt-${token}`, saleDraftId: `pix-duplicate-draft-${token}`, amountCents: 500, method: "pix", installments: 1, hash, now: new Date(now.valueOf() + 86_400_000) });
    await assert.rejects(acceptPosPaymentCallback(first, provider, `event-pix-duplicate-${token}`, "pg-key", "b".repeat(64), { ...racedObservation, intentId: duplicatePixIntentId, providerReference: `pix-duplicate-reference-${token}`, transactionId: `pix-duplicate-transaction-${token}`, providerSequence: BigInt(2), occurredAt: new Date(occurredAt.valueOf() + 1_500) }), /evidência do provedor já foi vinculada/);
    assert.equal((await first.posPaymentIntent.findUniqueOrThrow({ where: { id: duplicatePixIntentId } })).status, "created");
    const superseded = await completePosPaymentOutbox(first, { attemptId: racedAttemptId, claimToken: racedClaim.claimToken, result: { kind: "known_failure", retryable: true, failureCode: "transport_error", failureMessage: null } }, new Date(claimAt.valueOf() + 3_000));
    assert.equal(superseded.retryScheduled, false);
    assert.equal(superseded.superseded, true);
    assert.equal((await first.posPaymentAttempt.findUniqueOrThrow({ where: { id: racedAttemptId } })).state, "failed");
    assert.equal((await first.posPaymentOutbox.findUniqueOrThrow({ where: { attemptId: racedAttemptId } })).state, "completed");

    const expiredIntentId = `payment-expired-${token}`, expiredAttemptId = `attempt-expired-${token}`;
    await createPlanIntent(first, { token: `expired-${token}`, branchId: register.branchId, registerId: register.id, terminalId: terminal.id, sessionId: session.id, profileId: profile.id, connectorId: connector.id, credentialId: credential.id, provider, productId: product.id, intentId: expiredIntentId, attemptId: expiredAttemptId, saleDraftId: `expired-draft-${token}`, amountCents: 300, method: "debit", installments: 1, hash, now });
    const maintenance = await maintainPosPaymentPersistence(first, { now: new Date(Date.now() + 600_000), batchSize: 10, correlationId: `maintenance-${token}` });
    assert.ok(maintenance.expiredBeforeDispatch >= 1);
    assert.equal((await first.posPaymentIntent.findUniqueOrThrow({ where: { id: expiredIntentId } })).status, "cancelled");
    assert.equal((await first.posPaymentOutbox.findUniqueOrThrow({ where: { attemptId: expiredAttemptId } })).state, "dead");

    const saleData = (suffix: string) => ({ saleNumber: `PG-PAY-${suffix}-${token}`, branchId: register.branchId, sessionId: session.id, operatorProfileId: profile.id, customer: "Teste", seller: profile.displayName, cashRegister: register.name, paymentMethod: "credit", total: 12.34, status: "completed", subtotalCents: 1_234, discountCents: 0, surchargeCents: 0, totalCents: 1_234, changeCents: 0, idempotencyKey: saleDraftId, requestHash: hash, items: { create: { productId: product.id, productName: product.name, quantity: 1, unitPrice: 12.34, total: 12.34, unitPriceCents: 1_234, grossCents: 1_234, discountCents: 0, surchargeCents: 0, totalCents: 1_234 } } });
    await assert.rejects(first.$transaction(tx => tx.sale.create({ data: saleData("sale-only") })), /must consume that exact plan atomically/);
    await assert.rejects(first.$transaction(async tx => {
      const sale = await tx.sale.create({ data: saleData("payment-only") });
      await tx.posSalePayment.create({ data: {
        saleId: sale.id, connectorId: connector.id, paymentIntentId: intentId, paymentPlanId: primary.planId, paymentIndex: 0,
        processingSessionId: session.id, type: "payment", method: "credit", status: "captured", amountCents: 1_234,
        tenderedCents: 1_234, changeCents: 0, provider, transactionId: callbackInput.transactionId,
        nsu: callbackInput.nsu, authorizationCode: callbackInput.authorizationCode, cardBrand: callbackInput.cardBrand,
        cardLastFour: callbackInput.cardLastFour, installments: 2, idempotencyKey: `payment-only-${token}`,
        authorizedAt: occurredAt, capturedAt: occurredAt,
      } });
    }), /must be consumed by the same sale atomically|must consume that exact plan atomically/);
    const beforeIntentOnly = await first.posPaymentIntent.findUniqueOrThrow({ where: { id: intentId } });
    await assert.rejects(first.$transaction(async tx => {
      await tx.posPaymentIntent.update({ where: { id: intentId }, data: { consumedAt: new Date(), version: { increment: 1 } } });
      await tx.posPaymentStateEvent.create({ data: { intentId, eventKey: `intent-only-${token}`, source: "sale_commit", sourceId: `intent-only-${token}`, fromState: "captured", toState: "captured", resultingVersion: beforeIntentOnly.version + 1 } });
    }), /consumed pos payment evidence does not match sale payment|requires its exact sale payment and plan consumption atomically/);
    const consume = (db: PrismaClient, suffix: string) => db.$transaction(async tx => {
      const sale = await tx.sale.create({ data: saleData(suffix) });
      const payment = await consumeCapturedPosPaymentIntent(tx, { intentId, branchId: register.branchId, registerId: register.id, terminalId: terminal.id, sessionId: session.id, operatorProfileId: profile.id, saleDraftId, paymentPlanId: primary.planId, paymentIndex: 0, amountCents: 1_234, method: "credit", installments: 2, saleId: sale.id, paymentIdempotencyKey: `sale-payment-${suffix}-${token}` });
      await consumePosPaymentPlan(tx, { id: primary.planId, state: "active", version: 1 }, sale.id, profile.userId, `consume-plan-${suffix}-${token}`);
      return { sale, payment };
    });
    const consumed = await Promise.allSettled([consume(first, "A"), consume(second, "B")]);
    assert.equal(consumed.filter(result => result.status === "fulfilled").length, 1);
    assert.equal(consumed.filter(result => result.status === "rejected").length, 1);
    assert.equal(await first.posSalePayment.count({ where: { paymentIntentId: intentId } }), 1);
    assert.ok((await first.posPaymentIntent.findUniqueOrThrow({ where: { id: intentId } })).consumedAt);
    assert.equal((await first.posPaymentPlan.findUniqueOrThrow({ where: { id: primary.planId } })).state, "consumed");

    const consumedIntent = await first.posPaymentIntent.findUniqueOrThrow({ where: { id: intentId } });
    const supplemental = await acceptPosPaymentCallback(first, provider, `event-supplemental-${token}`, "pg-key", "a".repeat(64), { ...callbackInput, providerSequence: BigInt(2), occurredAt: new Date(occurredAt.valueOf() + 2_000), evidenceId: `supplemental-evidence-${token}` });
    assert.equal(supplemental.result, "supplemental_after_consumption");
    assert.equal(supplemental.incident, null);
    assert.deepEqual(await first.posPaymentIntent.findUniqueOrThrow({ where: { id: intentId } }), consumedIntent);
    const contradictory = await acceptPosPaymentCallback(first, provider, `event-contradictory-${token}`, "pg-key", "9".repeat(64), { ...callbackInput, amountCents: 1_235, providerSequence: BigInt(3), occurredAt: new Date(occurredAt.valueOf() + 3_000) });
    assert.equal(contradictory.incident?.productionBlocking, true);
    assert.equal(await first.posPaymentIntegrityIncident.count({ where: { intentId, status: "open", productionBlocking: true } }), 1);
    await assert.rejects(first.posPaymentIntent.update({ where: { id: intentId }, data: { transactionId: `mutated-${token}`, version: { increment: 1 } } }), /consumed pos payment evidence is immutable/);

    const callback = await first.posPaymentCallback.findFirstOrThrow({ where: { intentId, eventId: `event-capture-${token}` } });
    await assert.rejects(first.posPaymentCallback.update({ where: { id: callback.id }, data: { processingResult: "no_change" } }), /immutable/);
    await assert.rejects(first.posPaymentCallback.delete({ where: { id: callback.id } }), /immutable/);

    const refusedIntentId = `payment-refused-${token}`, refusedAttemptId = `attempt-refused-${token}`;
    const refusedPlan = await createPlanIntent(first, { token: `refused-${token}`, branchId: register.branchId, registerId: register.id, terminalId: terminal.id, sessionId: session.id, profileId: profile.id, connectorId: connector.id, credentialId: credential.id, provider, productId: product.id, intentId: refusedIntentId, attemptId: refusedAttemptId, saleDraftId: `refused-draft-${token}`, amountCents: 888, method: "credit", installments: 1, hash, now: new Date() });
    await first.integrationCredential.update({ where: { id: credential.id }, data: { enabled: false } });
    const refusedClaim = await claimPosPaymentOutbox(first, { workerId: `worker-refused-${compact}`, limit: 10, leaseSeconds: 60, now: new Date() });
    assert.equal(refusedClaim.claimedCount, 0);
    assert.equal((await first.posPaymentIntent.findUniqueOrThrow({ where: { id: refusedIntentId } })).status, "cancelled");
    assert.equal((await first.posPaymentOutbox.findUniqueOrThrow({ where: { attemptId: refusedAttemptId } })).state, "dead");
    await first.$transaction(async tx => {
      await tx.posPaymentPlanOperation.create({ data: { planId: refusedPlan.planId, action: "supersede", expectedVersion: 1, resultingVersion: 2, resultingState: "superseded", idempotencyKey: `supersede-refused-${token}`, requestHash: hash } });
      await tx.posPaymentPlan.update({ where: { id: refusedPlan.planId }, data: { state: "superseded", version: 2 } });
    });
    const lateConflict = await acceptPosPaymentCallback(first, provider, `event-late-refused-${token}`, "pg-key", "8".repeat(64), {
      ...callbackInput,
      intentId: refusedIntentId,
      providerReference: `late-refused-${token}`,
      amountCents: 888,
      transactionId: `late-refused-transaction-${token}`,
      providerSequence: BigInt(1),
      occurredAt: new Date(),
    });
    assert.equal(lateConflict.result, "rejected_transition");
    assert.equal(lateConflict.incident?.productionBlocking, true);
    assert.equal(await first.posPaymentCallback.count({ where: { intentId: refusedIntentId } }), 1);
  } finally {
    await Promise.all([first.$disconnect(), second.$disconnect()]);
  }
});

function safeToken() {
  return randomUUID().replace(/[0-9]/g, digit => String.fromCharCode(103 + Number(digit)));
}

function client() {
  if (!connectionString) throw new Error("POS_TEST_DATABASE_URL ausente");
  return new PrismaClient({ adapter: new PrismaPg({ connectionString }) });
}

type PlanFixtureInput = {
  token: string;
  branchId: number;
  registerId: number;
  terminalId: string;
  sessionId: number;
  profileId: number;
  connectorId: string;
  credentialId: string;
  provider: string;
  productId: number;
  intentId: string;
  attemptId: string;
  saleDraftId: string;
  amountCents: number;
  method: "pix" | "credit" | "debit" | "voucher";
  installments: number;
  hash: string;
  now: Date;
};

async function createQuotedPlan(db: PrismaClient, input: PlanFixtureInput, includeLine = true) {
  const planId = `plan-${input.token}`, planKey = `plan-quote-${input.token}`;
  const evaluatedAt = new Date(), expiresAt = new Date(evaluatedAt.valueOf() + 300_000);
  const draft = await db.$transaction(async tx => {
    const createdDraft = await tx.posHeldSale.create({ data: {
      id: input.saleDraftId,
      registerId: input.registerId,
      sessionId: input.sessionId,
      operatorProfileId: input.profileId,
      status: "draft",
      idempotencyKey: `draft-${input.token}`,
      requestHash: input.hash,
      expiresAt: new Date(evaluatedAt.valueOf() + 86_400_000),
      items: { create: { productId: input.productId, quantity: 1, unitPriceCents: input.amountCents, discountCents: 0 } },
    }, include: { items: true } });
    await tx.posPaymentPlan.create({ data: {
      id: planId,
      branchId: input.branchId,
      registerId: input.registerId,
      sessionId: input.sessionId,
      operatorProfileId: input.profileId,
      terminalId: input.terminalId,
      saleDraftId: input.saleDraftId,
      draftRevision: createdDraft.revision,
      draftRequestHash: input.hash,
      draftStatus: createdDraft.status,
      quoteHash: input.hash,
      evaluatedAt,
      expiresAt,
      totalCents: input.amountCents,
      idempotencyKey: planKey,
      requestHash: input.hash,
    } });
    if (includeLine) await tx.posPaymentPlanQuoteLine.create({ data: {
      planId, lineIndex: 0, heldSaleItemId: createdDraft.items[0].id, productId: input.productId, quantity: 1,
      unitPriceCents: input.amountCents, grossCents: input.amountCents, baseDiscountCents: 0,
      orderDiscountCents: 0, promotionDiscountCents: 0, surchargeCents: 0, totalCents: input.amountCents,
    } });
    await tx.posPaymentPlanOperation.create({ data: { planId, action: "quote", expectedVersion: -1, resultingVersion: 0, resultingState: "quoted", idempotencyKey: planKey, requestHash: input.hash } });
    return createdDraft;
  });
  return { planId, draft, expiresAt };
}

async function createPlanIntent(db: PrismaClient, input: PlanFixtureInput) {
  const { planId, draft, expiresAt } = await createQuotedPlan(db, input);
  const intentKey = `intent-create-${input.token}`;
  await db.$transaction(async tx => {
    await tx.posPaymentPlanSlot.create({ data: { planId, paymentIndex: 0, method: input.method, amountCents: input.amountCents, installments: input.installments, proofKind: "intent", connectorId: input.connectorId, credentialRef: input.credentialId, provider: input.provider } });
    await tx.posPaymentPlanOperation.create({ data: { planId, action: "activate", expectedVersion: 0, resultingVersion: 1, resultingState: "active", idempotencyKey: `plan-activate-${input.token}`, requestHash: input.hash } });
    await tx.posPaymentPlan.update({ where: { id: planId }, data: { state: "active", version: 1 } });
    await tx.posPaymentIntent.create({ data: {
      id: input.intentId,
      branchId: input.branchId,
      registerId: input.registerId,
      terminalId: input.terminalId,
      sessionId: input.sessionId,
      operatorProfileId: input.profileId,
      connectorId: input.connectorId,
      credentialRef: input.credentialId,
      saleDraftId: input.saleDraftId,
      paymentPlanId: planId,
      paymentIndex: 0,
      amountCents: input.amountCents,
      currency: "BRL",
      method: input.method,
      installments: input.installments,
      provider: input.provider,
      expiresAt,
      idempotencyKey: intentKey,
      requestHash: input.hash,
      attempts: { create: { id: input.attemptId, sequence: 1, operation: "create", operationKey: intentKey, requestHash: input.hash, providerIdempotencyKey: intentKey, outbox: { create: { nextAttemptAt: input.now } } } },
      stateEvents: { create: { eventKey: `payment-created-${input.token}`, source: "api", sourceId: intentKey, toState: "created", resultingVersion: 0 } },
    } });
  });
  return { planId, draft, expiresAt };
}
