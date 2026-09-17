import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import test from "node:test";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../generated/tenant/client";
import { consumePosPaymentPlan } from "../lib/erp/pos-payment-plan";
import { acceptPosPaymentCallback, consumeCapturedPosPaymentIntent } from "../lib/erp/pos-payment-persistence";
import { DEFAULT_POS_RECONCILIATION_COLUMNS, DEFAULT_POS_RECONCILIATION_KINDS } from "../lib/erp/pos-reconciliation-admin";
import { createPosReconciliationLayout, importPosReconciliationBatch, posReconciliationReport, reprocessPosReconciliationBatch, updatePosReconciliationLayout } from "../lib/erp/pos-reconciliation-persistence";

const connectionString = process.env.POS_TEST_DATABASE_URL;

test("PostgreSQL deduplica import/reprocess concorrente, aplica CAS e preserva evidência", { skip: !connectionString }, async () => {
  // These identifiers intentionally exercise the PCI rejector. Replace UUID
  // digits so a random run cannot accidentally form a valid 12–19 digit PAN
  // across otherwise harmless separators.
  const first = client(), second = client(), token = randomUUID().replace(/[0-9]/g, "q"), actor = `postgres:reconciliation:${token}`;
  try {
    const branch = await first.branch.create({ data: { code: `PG-REC-${token}`, name: "Filial reconciliação PostgreSQL", legalName: "Filial reconciliação PostgreSQL Ltda", document: `PGREC${token.replaceAll("-", "")}` } });
    const layoutInput = {
      action: "layout.create" as const, branchId: branch.id, provider: `psp-${token.slice(0, 8)}`, name: "Layout PostgreSQL", delimiter: "," as const,
      amountMode: "integer_cents" as const, decimalSeparator: "." as const, dateMode: "iso8601" as const,
      columns: { ...DEFAULT_POS_RECONCILIATION_COLUMNS }, kindMapping: { ...DEFAULT_POS_RECONCILIATION_KINDS }, matchWindowHours: 1,
      idempotencyKey: `layout:create:${token}`,
    };
    const createdLayout = await createPosReconciliationLayout(first, layoutInput, actor), layout = createdLayout.layout;
    const occurredAt = new Date(Date.now() - 2 * 60 * 60_000);
    const settledAt = new Date(occurredAt.valueOf() + 60 * 60_000);
    await createAuthoritativeReconciliationSale(first, {
      token,
      branchId: branch.id,
      provider: layoutInput.provider,
      occurredAt,
      transactions: [`TX-1-${token}`, `TX-MISSING-${token}`],
    });
    const header = "settlement_id,transaction_id,kind,gross_cents,fee_cents,net_cents,occurred_at,settled_at";
    const secondOccurredAt = new Date(occurredAt.valueOf() + 10 * 60_000);
    const csv = `${header}\nSET-1-${token},TX-1-${token},payment,9000,90,8910,${occurredAt.toISOString()},${settledAt.toISOString()}\nSET-X-${token},TX-X-${token},payment,500,0,500,${secondOccurredAt.toISOString()},${settledAt.toISOString()}\n`;
    const imported = await Promise.all([
      importPosReconciliationBatch(first, { action: "batch.import", branchId: branch.id, layoutId: layout.id, csv, idempotencyKey: `batch:import:a:${token}` }, actor),
      importPosReconciliationBatch(second, { action: "batch.import", branchId: branch.id, layoutId: layout.id, csv, idempotencyKey: `batch:import:b:${token}` }, actor),
    ]);
    const batchId = imported[0].batch.id;
    assert.equal(imported[1].batch.id, batchId);
    assert.equal(await first.posReconciliationBatch.count({ where: { provider: layoutInput.provider } }), 1);
    assert.equal(await first.posReconciliationLine.count({ where: { batchId } }), 2);
    assert.equal(await first.posReconciliationRun.count({ where: { batchId } }), 1);
    assert.equal(await first.posReconciliationIssue.count({ where: { run: { batchId } } }), 3);
    const batch = await first.posReconciliationBatch.findUniqueOrThrow({ where: { id: batchId } });
    assert.deepEqual({ status: batch.status, version: batch.version, matched: batch.matchedCount, issues: batch.issueCount, blocking: batch.productionBlocking }, { status: "completed", version: 1, matched: 1, issues: 3, blocking: true });

    const replayKey = `batch:reprocess:${token}`;
    const reprocessed = await Promise.all([
      reprocessPosReconciliationBatch(first, { action: "batch.reprocess", batchId, expectedVersion: 1, idempotencyKey: replayKey }, actor),
      reprocessPosReconciliationBatch(second, { action: "batch.reprocess", batchId, expectedVersion: 1, idempotencyKey: replayKey }, actor),
    ]);
    assert.equal(reprocessed[0].run.id, reprocessed[1].run.id);
    assert.equal(await first.posReconciliationRun.count({ where: { batchId } }), 2);
    assert.equal((await first.posReconciliationBatch.findUniqueOrThrow({ where: { id: batchId } })).version, 2);

    const updates = await Promise.allSettled([
      updatePosReconciliationLayout(first, { ...layoutInput, action: "layout.update", layoutId: layout.id, expectedVersion: 0, idempotencyKey: `layout:update:a:${token}` }, actor),
      updatePosReconciliationLayout(second, { ...layoutInput, action: "layout.update", layoutId: layout.id, expectedVersion: 0, idempotencyKey: `layout:update:b:${token}` }, actor),
    ]);
    assert.deepEqual(updates.map(result => result.status).sort(), ["fulfilled", "rejected"]);

    const evidence = await first.posReconciliationLine.findFirstOrThrow({ where: { batchId } }), run = await first.posReconciliationRun.findFirstOrThrow({ where: { batchId } }), issue = await first.posReconciliationIssue.findFirstOrThrow({ where: { run: { batchId } } });
    await assert.rejects(first.posReconciliationLine.update({ where: { id: evidence.id }, data: { settlementId: "tampered" } }));
    await assert.rejects(first.posReconciliationRun.delete({ where: { id: run.id } }));
    await assert.rejects(first.posReconciliationIssue.update({ where: { id: issue.id }, data: { code: "amount_mismatch" } }));
    assert.match(issue.referenceHash, /^[0-9a-f]{64}$/);

    const audits = await first.tenantAuditEvent.findMany({ where: { entityId: { in: [batchId, layout.id] } } });
    assert.equal(audits.filter(event => event.action === "pos.reconciliation.batch.imported").length, 1);
    assert.equal(audits.filter(event => event.action === "pos.reconciliation.batch.processed").length, 2);
    assert.doesNotMatch(JSON.stringify(audits, (_key, value) => typeof value === "bigint" ? value.toString() : value), /TX-1-/);
    const report = await posReconciliationReport(first, branch.id, 10);
    assert.equal(report.batches.length, 1);
    assert.equal(report.batches[0].issueCount, 3);
    assert.doesNotMatch(JSON.stringify(report), /TX-1-/);
  } finally {
    await Promise.all([first.$disconnect(), second.$disconnect()]);
  }
});

function client() {
  if (!connectionString) throw new Error("POS_TEST_DATABASE_URL não definida");
  return new PrismaClient({ adapter: new PrismaPg({ connectionString }) });
}

async function createAuthoritativeReconciliationSale(db: PrismaClient, input: {
  token: string;
  branchId: number;
  provider: string;
  occurredAt: Date;
  transactions: [string, string];
}) {
  const compact = input.token.replaceAll("-", "");
  const requestHash = createHash("sha256").update(`reconciliation:${input.token}`).digest("hex");
  const now = new Date();
  const expiresAt = new Date(now.valueOf() + 300_000);
  const role = await db.tenantRole.findFirstOrThrow({ where: { active: true }, select: { id: true } });
  const register = await db.posRegister.create({ data: { branchId: input.branchId, code: `PGRECREG${compact}`, name: "Caixa reconciliação PostgreSQL" } });
  const terminal = await db.posTerminal.create({ data: {
    id: `reconciliation-terminal-${input.token}`,
    registerId: register.id,
    code: `PGRECTERM${compact}`,
    name: "Terminal reconciliação PostgreSQL",
    status: "online",
    tokenHash: `hmac-sha256:v1:${requestHash}`,
    tokenIssuedAt: now,
    tokenExpiresAt: new Date(now.valueOf() + 3_600_000),
    credentialVersion: 1,
    pairedAt: now,
    lastSeenAt: now,
    appVersion: "test",
  } });
  const operator = await db.tenantUserProfile.create({ data: {
    userId: `pg-reconciliation-${input.token}`,
    roleId: role.id,
    displayName: "Operador reconciliação",
    email: `pg-reconciliation-${compact}@example.invalid`,
    activeBranchId: input.branchId,
  } });
  await db.branchUserAccess.create({ data: { branchId: input.branchId, userProfileId: operator.id, canSell: true } });
  await db.posRegisterAccess.create({ data: { registerId: register.id, userProfileId: operator.id, active: true, canSell: true } });
  const session = await db.cashRegisterSession.create({ data: {
    number: `PG-REC-${input.token}`,
    registerName: register.name,
    status: "open",
    openingAmount: 0,
    openingAmountCents: 0,
    openedBy: operator.displayName,
    registerId: register.id,
    operatorProfileId: operator.id,
  } });
  await db.integrationProvider.create({ data: {
    id: input.provider,
    family: "payment",
    label: "PSP reconciliação PostgreSQL",
    description: "Fixture descartável de reconciliação",
    recipientType: "none",
    authType: "api_key",
    capabilities: {},
    credentialSchema: {},
  } });
  const credential = await db.integrationCredential.create({ data: {
    id: `reconciliation-credential-${input.token}`,
    providerId: input.provider,
    label: "Credencial reconciliação PostgreSQL",
    enabled: true,
    config: {},
  } });
  const connector = await db.posConnector.create({ data: {
    id: `reconciliation-connector-${input.token}`,
    branchId: input.branchId,
    registerId: register.id,
    type: `payment_reconciliation_${compact}`,
    provider: input.provider,
    credentialRef: credential.id,
    status: "active",
    settings: { methods: ["credit"] },
  } });
  const product = await db.product.create({ data: {
    name: "Produto reconciliação PostgreSQL",
    slug: `produto-reconciliacao-${compact}`,
    sku: `PGREC${compact}`,
    category: "Teste",
    price: 120,
    regularPrice: 120,
    manageStock: false,
  } });
  const saleDraftId = `reconciliation-draft-${input.token}`;
  const planId = `reconciliation-plan-${input.token}`;
  const intents = [
    { paymentIndex: 0, amountCents: 10_000, transactionId: input.transactions[0] },
    { paymentIndex: 1, amountCents: 2_000, transactionId: input.transactions[1] },
  ].map((value) => ({ ...value, intentId: `reconciliation-intent-${value.paymentIndex}-${input.token}` }));

  await db.$transaction(async (tx) => {
    const draft = await tx.posHeldSale.create({ data: {
      id: saleDraftId,
      registerId: register.id,
      sessionId: session.id,
      operatorProfileId: operator.id,
      status: "draft",
      idempotencyKey: `reconciliation-held-${input.token}`,
      requestHash,
      items: { create: { productId: product.id, quantity: 1, unitPriceCents: 12_000, discountCents: 0 } },
    }, include: { items: true } });
    await tx.posPaymentPlan.create({ data: {
      id: planId,
      branchId: input.branchId,
      registerId: register.id,
      sessionId: session.id,
      operatorProfileId: operator.id,
      terminalId: terminal.id,
      saleDraftId,
      draftRevision: draft.revision,
      draftRequestHash: requestHash,
      draftStatus: draft.status,
      quoteHash: requestHash,
      evaluatedAt: now,
      expiresAt,
      totalCents: 12_000,
      idempotencyKey: `reconciliation-quote-${input.token}`,
      requestHash,
    } });
    await tx.posPaymentPlanQuoteLine.create({ data: {
      planId,
      lineIndex: 0,
      heldSaleItemId: draft.items[0].id,
      productId: product.id,
      quantity: 1,
      unitPriceCents: 12_000,
      grossCents: 12_000,
      baseDiscountCents: 0,
      orderDiscountCents: 0,
      promotionDiscountCents: 0,
      surchargeCents: 0,
      totalCents: 12_000,
    } });
    await tx.posPaymentPlanOperation.create({ data: {
      planId,
      action: "quote",
      expectedVersion: -1,
      resultingVersion: 0,
      resultingState: "quoted",
      idempotencyKey: `reconciliation-quote-${input.token}`,
      requestHash,
      actorUserId: operator.userId,
    } });
  });

  await db.$transaction(async (tx) => {
    await tx.posPaymentPlanSlot.createMany({ data: intents.map(({ paymentIndex, amountCents }) => ({
      planId,
      paymentIndex,
      method: "credit",
      amountCents,
      installments: 1,
      proofKind: "intent",
      connectorId: connector.id,
      credentialRef: credential.id,
      provider: input.provider,
    })) });
    await tx.posPaymentPlanOperation.create({ data: {
      planId,
      action: "activate",
      expectedVersion: 0,
      resultingVersion: 1,
      resultingState: "active",
      idempotencyKey: `reconciliation-activate-${input.token}`,
      requestHash,
      actorUserId: operator.userId,
    } });
    await tx.posPaymentPlan.update({ where: { id: planId }, data: { state: "active", version: 1 } });
    for (const intent of intents) {
      const intentKey = `reconciliation-intent-create-${intent.paymentIndex}-${input.token}`;
      await tx.posPaymentIntent.create({ data: {
        id: intent.intentId,
        branchId: input.branchId,
        registerId: register.id,
        sessionId: session.id,
        operatorProfileId: operator.id,
        terminalId: terminal.id,
        connectorId: connector.id,
        credentialRef: credential.id,
        saleDraftId,
        paymentPlanId: planId,
        paymentIndex: intent.paymentIndex,
        amountCents: intent.amountCents,
        currency: "BRL",
        method: "credit",
        installments: 1,
        provider: input.provider,
        expiresAt,
        idempotencyKey: intentKey,
        requestHash,
        attempts: { create: {
          id: `reconciliation-attempt-${intent.paymentIndex}-${input.token}`,
          sequence: 1,
          operation: "create",
          operationKey: intentKey,
          requestHash,
          providerIdempotencyKey: intentKey,
          outbox: { create: { nextAttemptAt: now } },
        } },
        stateEvents: { create: {
          eventKey: `reconciliation-created-${intent.paymentIndex}-${input.token}`,
          source: "api",
          sourceId: intentKey,
          toState: "created",
          resultingVersion: 0,
        } },
      } });
    }
  });

  for (const intent of intents) {
    const eventId = `reconciliation-captured-${intent.paymentIndex}-${input.token}`;
    const callbackHash = createHash("sha256").update(eventId).digest("hex");
    const captured = await acceptPosPaymentCallback(db, input.provider, eventId, `reconciliation-key-${input.token}`, callbackHash, {
      intentId: intent.intentId,
      provider: input.provider,
      providerReference: `reconciliation-reference-${intent.paymentIndex}-${input.token}`,
      state: "captured",
      amountCents: intent.amountCents,
      currency: "BRL",
      providerSequence: BigInt(intent.paymentIndex + 1),
      occurredAt: input.occurredAt,
      evidenceId: `reconciliation-evidence-${intent.paymentIndex}-${input.token}`,
      transactionId: intent.transactionId,
      endToEndId: null,
      nsu: `REC${intent.paymentIndex}${compact}`,
      authorizationCode: `AUTH${intent.paymentIndex}${compact}`,
      cardBrand: "test",
      cardLastFour: intent.paymentIndex === 0 ? "4242" : "4444",
      failureCode: null,
      failureMessage: null,
    });
    assert.equal(captured.state, "captured");
  }

  return db.$transaction(async (tx) => {
    const sale = await tx.sale.create({ data: {
      saleNumber: `PG-REC-SALE-${input.token}`,
      customer: "Consumidor não identificado",
      seller: operator.displayName,
      cashRegister: register.name,
      paymentMethod: "credit",
      total: 120,
      branchId: input.branchId,
      sessionId: session.id,
      operatorProfileId: operator.id,
      status: "completed",
      subtotalCents: 12_000,
      discountCents: 0,
      surchargeCents: 0,
      totalCents: 12_000,
      changeCents: 0,
      idempotencyKey: saleDraftId,
      requestHash,
      items: { create: {
        productId: product.id,
        productName: product.name,
        skuSnapshot: product.sku,
        quantity: 1,
        unitPrice: 120,
        total: 120,
        unitPriceCents: 12_000,
        grossCents: 12_000,
        discountCents: 0,
        surchargeCents: 0,
        totalCents: 12_000,
      } },
    } });
    for (const intent of intents) {
      await consumeCapturedPosPaymentIntent(tx, {
        intentId: intent.intentId,
        branchId: input.branchId,
        registerId: register.id,
        terminalId: terminal.id,
        sessionId: session.id,
        operatorProfileId: operator.id,
        saleDraftId,
        paymentPlanId: planId,
        paymentIndex: intent.paymentIndex,
        amountCents: intent.amountCents,
        method: "credit",
        installments: 1,
        saleId: sale.id,
        paymentIdempotencyKey: `pg-rec:payment:${intent.paymentIndex + 1}:${input.token}`,
      });
    }
    await consumePosPaymentPlan(tx, { id: planId, state: "active", version: 1 }, sale.id, operator.userId, `reconciliation-consume-${input.token}`);
    return sale;
  });
}
