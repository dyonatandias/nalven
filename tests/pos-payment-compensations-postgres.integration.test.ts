import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../generated/tenant/client";
import { requestPosPaymentCompensation } from "../lib/erp/pos-payment-compensations";
import {
  applyPosPaymentCompensation,
  claimPosPaymentCompensationOutbox,
  completePosPaymentCompensationOutbox,
} from "../lib/erp/pos-payment-compensation-persistence";
import { acceptPosPaymentCallback, consumeCapturedPosPaymentIntent } from "../lib/erp/pos-payment-persistence";
import { consumePosPaymentPlan } from "../lib/erp/pos-payment-plan";
import { buildPosCancelApprovalContext } from "../lib/erp/pos-post-sale-approval";

const connectionString = process.env.POS_TEST_DATABASE_URL;

test("PostgreSQL serializa reservas, bloqueia over-refund e exige dois commits", { skip: !connectionString }, async () => {
  const first = client(), second = client();
  const token = randomUUID().replaceAll("-", "").toLowerCase();
  const provider = `comp-${token}`;
  try {
    const branch = await first.branch.findFirstOrThrow({ where: { status: "active" } });
    const role = await first.tenantRole.create({ data: {
      key: `compensation-${token}`,
      name: "Compensation test role",
      permissions: { pdv: ["read", "write", "refund"] },
      active: true,
    } });
    const profile = await first.tenantUserProfile.create({ data: {
      userId: `compensation-user-${token}`,
      roleId: role.id,
      displayName: "Compensation requester",
      email: `compensation-${token}@example.invalid`,
      status: "active",
      activeBranchId: branch.id,
    } });
    const integrationProvider = await first.integrationProvider.create({ data: {
      id: provider,
      family: "payment",
      label: "Compensation PostgreSQL test",
      description: "Disposable provider",
      capabilities: { refund: true, void: true, query: true },
      credentialSchema: {},
    } });
    const credential = await first.integrationCredential.create({ data: {
      providerId: integrationProvider.id,
      label: "Disposable credential",
      enabled: true,
      config: {},
    } });
    const register = await first.posRegister.create({ data: {
      branchId: branch.id,
      code: `COM${token.slice(0, 12)}`,
      name: "Compensation test register",
    } });
    await first.branchUserAccess.create({ data: { branchId: branch.id, userProfileId: profile.id, canSell: true } });
    await first.posRegisterAccess.create({ data: { registerId: register.id, userProfileId: profile.id, active: true, canSell: true } });
    const terminal = await first.posTerminal.create({ data: {
      id: `terminal-${token}`,
      registerId: register.id,
      code: `TERM${token.slice(0, 12)}`,
      name: "Compensation test terminal",
      status: "online",
      tokenHash: `hmac-sha256:v1:${"9".repeat(64)}`,
      tokenIssuedAt: new Date("2026-08-29T11:00:00.000Z"),
      tokenExpiresAt: new Date("2027-08-29T12:00:00.000Z"),
      credentialVersion: 1,
      appVersion: "1.0.0-test",
      pairedAt: new Date(),
      lastSeenAt: new Date(),
    } });
    const connector = await first.posConnector.create({ data: {
      id: `connector-${token}`,
      branchId: branch.id,
      registerId: register.id,
      type: "payment_server",
      provider,
      mode: "server",
      status: "active",
      credentialRef: credential.id,
      settings: { methods: ["credit"], capabilities: ["refund", "void", "query"] },
    } });
    const session = await first.cashRegisterSession.create({ data: {
      number: `COMP-${token}`,
      registerId: register.id,
      registerName: register.name,
      operatorProfileId: profile.id,
      status: "open",
      openingAmount: 0,
      openingAmountCents: 0,
      openedBy: profile.displayName,
      openIdempotencyKey: `comp-open-${token}`,
      openRequestHash: "a".repeat(64),
    } });
    const product = await first.product.create({ data: { name: `Compensation product ${token}`, slug: `compensation-product-${token}`, sku: `COMP-${token}`, category: "Teste", price: 10, regularPrice: 10, manageStock: false } });
    const saleDraftId = `sale-draft-${token}`, planId = `plan-${token}`, intentId = `intent-${token}`, attemptId = `attempt-${token}`, requestHash = "b".repeat(64);
    const evaluatedAt = new Date(), expiresAt = new Date(evaluatedAt.valueOf() + 300_000), occurredAt = new Date();
    await first.$transaction(async tx => {
      const draft = await tx.posHeldSale.create({ data: { id: saleDraftId, registerId: register.id, sessionId: session.id, operatorProfileId: profile.id, status: "draft", idempotencyKey: `draft-${token}`, requestHash, items: { create: { productId: product.id, quantity: 1, unitPriceCents: 1_000, discountCents: 0 } } }, include: { items: true } });
      await tx.posPaymentPlan.create({ data: { id: planId, branchId: branch.id, registerId: register.id, sessionId: session.id, operatorProfileId: profile.id, terminalId: terminal.id, saleDraftId, draftRevision: draft.revision, draftRequestHash: requestHash, draftStatus: "draft", quoteHash: requestHash, evaluatedAt, expiresAt, totalCents: 1_000, idempotencyKey: `plan-quote-${token}`, requestHash } });
      await tx.posPaymentPlanQuoteLine.create({ data: { planId, lineIndex: 0, heldSaleItemId: draft.items[0].id, productId: product.id, quantity: 1, unitPriceCents: 1_000, grossCents: 1_000, baseDiscountCents: 0, orderDiscountCents: 0, promotionDiscountCents: 0, surchargeCents: 0, totalCents: 1_000 } });
      await tx.posPaymentPlanOperation.create({ data: { planId, action: "quote", expectedVersion: -1, resultingVersion: 0, resultingState: "quoted", idempotencyKey: `plan-quote-${token}`, requestHash } });
    });
    const intentKey = `intent-create-${token}`;
    await first.$transaction(async tx => {
      await tx.posPaymentPlanSlot.create({ data: { planId, paymentIndex: 0, method: "credit", amountCents: 1_000, installments: 1, proofKind: "intent", connectorId: connector.id, credentialRef: credential.id, provider } });
      await tx.posPaymentPlanOperation.create({ data: { planId, action: "activate", expectedVersion: 0, resultingVersion: 1, resultingState: "active", idempotencyKey: `plan-activate-${token}`, requestHash } });
      await tx.posPaymentPlan.update({ where: { id: planId }, data: { state: "active", version: 1 } });
      await tx.posPaymentIntent.create({ data: { id: intentId, branchId: branch.id, registerId: register.id, sessionId: session.id, operatorProfileId: profile.id, terminalId: terminal.id, connectorId: connector.id, credentialRef: credential.id, saleDraftId, paymentPlanId: planId, paymentIndex: 0, amountCents: 1_000, currency: "BRL", method: "credit", installments: 1, provider, expiresAt, idempotencyKey: intentKey, requestHash, attempts: { create: { id: attemptId, sequence: 1, operation: "create", operationKey: intentKey, requestHash, providerIdempotencyKey: intentKey, outbox: { create: { nextAttemptAt: new Date("2100-01-01T00:00:00.000Z") } } } }, stateEvents: { create: { eventKey: `created-${token}`, source: "api", sourceId: intentKey, toState: "created", resultingVersion: 0 } } } });
    });
    await acceptPosPaymentCallback(first, provider, `capture-${token}`, "pg-key", "c".repeat(64), { intentId, provider, providerReference: `provider-original-${token}`, state: "captured", amountCents: 1_000, currency: "BRL", providerSequence: BigInt(1), occurredAt, evidenceId: `evidence-${token}`, transactionId: `transaction-original-${token}`, endToEndId: null, nsu: `nsu-${token.slice(0, 12)}`, authorizationCode: `auth-${token.slice(0, 12)}`, cardBrand: "visa", cardLastFour: "4242", failureCode: null, failureMessage: null });
    const { sale, payment: originalPayment } = await first.$transaction(async tx => {
      const sale = await tx.sale.create({ data: { saleNumber: `COMP-SALE-${token}`, branchId: branch.id, sessionId: session.id, operatorProfileId: profile.id, customer: "Compensation test", seller: profile.displayName, cashRegister: register.name, paymentMethod: "credit", total: 10, status: "completed", subtotalCents: 1_000, discountCents: 0, surchargeCents: 0, totalCents: 1_000, changeCents: 0, idempotencyKey: saleDraftId, requestHash, items: { create: { productId: product.id, productName: product.name, quantity: 1, unitPrice: 10, total: 10, unitPriceCents: 1_000, grossCents: 1_000, discountCents: 0, surchargeCents: 0, totalCents: 1_000 } } } });
      const consumed = await consumeCapturedPosPaymentIntent(tx, { intentId, branchId: branch.id, registerId: register.id, terminalId: terminal.id, sessionId: session.id, operatorProfileId: profile.id, saleDraftId, paymentPlanId: planId, paymentIndex: 0, amountCents: 1_000, method: "credit", installments: 1, saleId: sale.id, paymentIdempotencyKey: `sale-payment-${token}` });
      await consumePosPaymentPlan(tx, { id: planId, state: "active", version: 1 }, sale.id, profile.userId, `consume-${token}`);
      return { sale, payment: consumed.payment };
    });
    const intent = await first.posPaymentIntent.findUniqueOrThrow({ where: { id: intentId } });
    const approvalContext = buildPosCancelApprovalContext({
      sale: {
        ...sale,
        items: [],
        payments: [{
          id: originalPayment.id,
          method: originalPayment.method,
          status: originalPayment.status,
          amountCents: originalPayment.amountCents,
          provider: originalPayment.provider,
          metadata: originalPayment.metadata,
          refunds: [],
        }],
      },
      branchId: branch.id,
      processingSessionId: session.id,
      registerId: register.id,
      reason: "Cancelamento integral controlado",
    });
    const approval = await first.posApproval.create({ data: {
      id: `approval-${token}`,
      branchId: branch.id,
      action: "sale.cancel",
      entityType: "sale",
      entityId: String(sale.id),
      status: "approved",
      requesterId: profile.userId,
      requesterName: profile.displayName,
      approverId: `supervisor-${token}`,
      approverName: "Independent supervisor",
      reason: "Cancelamento integral controlado",
      context: approvalContext,
      correlationId: `correlation-${token}`,
      expiresAt: new Date("2027-08-29T12:00:00.000Z"),
      decidedAt: occurredAt,
    } });

    const compensationContext = {
      branchId: branch.id,
      actorUserId: profile.userId,
      actorProfileId: profile.id,
      actorName: profile.displayName,
      privileged: true,
    };
    const compensationRequest = (suffix: string) => ({
      action: "compensation.request" as const,
      sessionId: session.id,
      terminalId: terminal.id,
      originalPaymentId: originalPayment.id,
      returnId: null,
      approvalId: approval.id,
      kind: "refund" as const,
      amountCents: 1_000,
      currency: "BRL" as const,
      idempotencyKey: `compensation-request-${token}-${suffix}`,
    });
    const raced = await Promise.allSettled([
      requestPosPaymentCompensation(first, compensationContext, compensationRequest("a")),
      requestPosPaymentCompensation(second, compensationContext, compensationRequest("b")),
    ]);
    assert.equal(raced.filter((result) => result.status === "fulfilled").length, 1);
    assert.equal(raced.filter((result) => result.status === "rejected").length, 1);
    const compensation = await first.posPaymentCompensation.findFirstOrThrow({ where: { originalPaymentId: originalPayment.id } });

    await assert.rejects(first.posSalePayment.create({ data: {
      saleId: sale.id,
      connectorId: connector.id,
      originalPaymentId: originalPayment.id,
      processingSessionId: session.id,
      type: "refund",
      method: "credit",
      status: "refunded",
      amountCents: 1,
      provider,
      idempotencyKey: `fake-refund-${token}`,
      refundedAt: new Date(),
    } }), /electronic refund requires a persisted compensation/);

    // The outbox row is created with the database clock. Keep the worker clock
    // causally after that row instead of pinning the test to a past wall clock.
    const providerPersistedAt = new Date(Date.now() + 60_000);
    const claimed = await claimPosPaymentCompensationOutbox(first, { workerId: `worker-${token}`, now: providerPersistedAt });
    assert.equal(claimed.claimedCount, 1);
    const command = claimed.claimed[0]!;
    const t1 = await completePosPaymentCompensationOutbox(first, {
      attemptId: command.attemptId,
      claimToken: command.claimToken,
      result: {
        kind: "result",
        compensationId: compensation.id,
        provider,
        originalProviderReference: intent.providerReference!,
        providerOperationReference: `refund-operation-${token}`,
        state: "succeeded",
        requestedAmountCents: 1_000,
        confirmedAmountCents: 1_000,
        currency: "BRL",
        providerSequence: BigInt(2),
        occurredAt: providerPersistedAt,
        evidenceHash: "f".repeat(64),
        failureCode: null,
        failureMessage: null,
      },
    }, new Date(providerPersistedAt.getTime() + 1_000));
    assert.equal(t1.compensation.status, "application_pending");
    assert.equal(await first.posSalePayment.count({ where: { compensationId: compensation.id } }), 0, "T1 não pode materializar refund local");

    const appliedAt = new Date(providerPersistedAt.getTime() + 60_000);
    const applied = await applyPosPaymentCompensation(first, compensation.id, appliedAt);
    assert.equal(applied.replayed, false);
    const replayedApplication = await applyPosPaymentCompensation(first, compensation.id, new Date(providerPersistedAt.getTime() + 120_000));
    assert.equal(replayedApplication.replayed, true);
    assert.equal(replayedApplication.refund.id, applied.refund.id);

    assert.equal((await first.posPaymentCompensation.findUniqueOrThrow({ where: { id: compensation.id } })).applicationState, "applied");
    assert.equal((await first.posSalePayment.findUniqueOrThrow({ where: { id: originalPayment.id } })).status, "refunded");
    assert.equal(await first.posSalePayment.count({ where: { compensationId: compensation.id, amountCents: 1_000 } }), 1);
    await assert.rejects(first.posPaymentCompensation.update({ where: { id: compensation.id }, data: { evidenceHash: "0".repeat(64) } }), /provider compensation result is immutable/);
  } finally {
    await Promise.all([first.$disconnect(), second.$disconnect()]);
  }
});

function client() {
  if (!connectionString) throw new Error("POS_TEST_DATABASE_URL não definida");
  return new PrismaClient({ adapter: new PrismaPg({ connectionString }) });
}
