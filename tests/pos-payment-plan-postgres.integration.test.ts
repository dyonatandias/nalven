import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import { PrismaPg } from "@prisma/adapter-pg";
import { Prisma, PrismaClient, type Prisma as PrismaTypes } from "../generated/tenant/client";
import { acceptPosPaymentCallback, claimPosPaymentOutbox, completePosPaymentOutbox, maintainPosPaymentPersistence } from "../lib/erp/pos-payment-persistence";

const connectionString = process.env.POS_TEST_DATABASE_URL;

test("310000 fecha fases, acesso, allowlist, provas e claim justo no PostgreSQL", { skip: !connectionString }, async () => {
  const db = client(), peer = client(), token = safeToken(), compact = token.replaceAll("-", ""), hash = digest(token);
  try {
    const fixture = await baseFixture(db, token, hash);
    const input = (suffix: string, overrides: Partial<PlanInput> = {}): PlanInput => ({
      token: `${suffix}-${token}`, fixture, amountCents: 1_000, method: "credit", installments: 1,
      nextAttemptAt: new Date(), ...overrides,
    });

    await assert.rejects(createQuotedPlan(db, input("no-lines"), false), /exact contiguous relational quote lines/);

    const late = await createQuotedPlan(db, input("late-line"));
    await assert.rejects(db.posPaymentPlanQuoteLine.create({ data: quoteLine(late.planId, 1, late.heldSaleItemId, fixture.product.id, 1_000) }), /initial quote transaction/);

    const slotOnly = await createQuotedPlan(db, input("slot-only"));
    await assert.rejects(db.$transaction(tx => tx.posPaymentPlanSlot.create({ data: cashSlot(slotOnly.planId, 1_000) })), /require activation in the same transaction/);

    await db.posConnector.update({ where: { id: fixture.connector.id }, data: { settings: { methods: ["pix"] } } });
    const methodMismatch = await createQuotedPlan(db, input("method-mismatch"));
    await assert.rejects(activateElectronicPlan(db, methodMismatch.planId, input("method-mismatch")), /connector is not active in the plan context/);
    await db.posConnector.update({ where: { id: fixture.connector.id }, data: { settings: {} } });

    const artifactMethod = await createQuotedPlan(db, input("artifact-method"));
    await activateElectronicPlan(db, artifactMethod.planId, input("artifact-method"));
    await db.posConnector.update({ where: { id: fixture.connector.id }, data: { settings: { methods: ["pix"] } } });
    await assert.rejects(insertElectronicIntent(db, input("artifact-method"), artifactMethod), /intent diverges from authoritative plan context/);
    await db.posConnector.update({ where: { id: fixture.connector.id }, data: { settings: {} } });

    const artifactAccess = await createQuotedPlan(db, input("artifact-access"));
    await activateElectronicPlan(db, artifactAccess.planId, input("artifact-access"));
    await db.posRegisterAccess.update({ where: { registerId_userProfileId: { registerId: fixture.register.id, userProfileId: fixture.profile.id } }, data: { canSell: false } });
    await assert.rejects(insertElectronicIntent(db, input("artifact-access"), artifactAccess), /requires live explicit branch\/register sale access/);
    await db.posRegisterAccess.update({ where: { registerId_userProfileId: { registerId: fixture.register.id, userProfileId: fixture.profile.id } }, data: { canSell: true } });

    await db.posConnector.update({ where: { id: fixture.connector.id }, data: { settings: {
      capabilities: ["manual_reference_query"],
      manualReconciliation: { enabled: true, vaultBindingRequired: true },
    } } });
    const manual = await createQuotedPlan(db, input("manual-disabled"));
    await assert.rejects(db.$transaction(async tx => {
      await tx.posPaymentPlanSlot.create({ data: {
        planId: manual.planId, paymentIndex: 0, method: "credit", amountCents: 1_000, installments: 1,
        proofKind: "manual", connectorId: fixture.connector.id, credentialRef: fixture.credential.id, provider: fixture.provider,
      } });
      await transitionPlan(tx, manual.planId, "activate", 0, "active", `manual-${token}`, hash);
    }), /manual reconciliation feature gate is disabled/);
    await db.posConnector.update({ where: { id: fixture.connector.id }, data: { settings: {} } });

    const noGrant = await createQuotedPlan(db, input("no-grant"));
    await db.posRegisterAccess.update({ where: { registerId_userProfileId: { registerId: fixture.register.id, userProfileId: fixture.profile.id } }, data: { active: false } });
    await assert.rejects(db.$transaction(async tx => {
      await tx.posPaymentPlanSlot.create({ data: cashSlot(noGrant.planId, 1_000) });
      await transitionPlan(tx, noGrant.planId, "activate", 0, "active", `no-grant-${token}`, hash);
    }), /requires live explicit branch\/register sale access/);
    await db.posRegisterAccess.update({ where: { registerId_userProfileId: { registerId: fixture.register.id, userProfileId: fixture.profile.id } }, data: { active: true } });

    const revoked = await createElectronicIntent(db, input("revoked-dispatch"));
    await db.posRegisterAccess.update({ where: { registerId_userProfileId: { registerId: fixture.register.id, userProfileId: fixture.profile.id } }, data: { canSell: false } });
    const refused = await claimPosPaymentOutbox(db, { workerId: `revoked-${compact}`, limit: 1, leaseSeconds: 60, now: new Date() });
    assert.equal(refused.claimed.some(command => command.intent.id === revoked.intentId), false);
    assert.equal((await db.posPaymentIntent.findUniqueOrThrow({ where: { id: revoked.intentId } })).status, "cancelled");
    await db.posRegisterAccess.update({ where: { registerId_userProfileId: { registerId: fixture.register.id, userProfileId: fixture.profile.id } }, data: { canSell: true } });

    const cash = await createQuotedPlan(db, input("cash-consumed", { amountCents: 700, method: "credit" }));
    await activateCashPlan(db, cash.planId, 700, `cash-active-${token}`, hash);
    const consumed = await db.$transaction(async tx => {
      const sale = await tx.sale.create({ data: saleData(fixture, cash.saleDraftId, `cash-${token}`, 700, hash) });
      const payment = await tx.posSalePayment.create({ data: {
        saleId: sale.id, processingSessionId: fixture.session.id, type: "payment", method: "cash", status: "captured",
        amountCents: 700, tenderedCents: 800, changeCents: 100, provider: "cash", installments: 1,
        paymentPlanId: cash.planId, paymentIndex: 0, idempotencyKey: `cash-payment-${token}`, capturedAt: new Date(),
      } });
      await transitionPlan(tx, cash.planId, "consume", 1, "consumed", `cash-consume-${token}`, hash, sale.id);
      return { sale, payment };
    });
    await assert.rejects(db.posSalePayment.update({ where: { id: consumed.payment.id }, data: { valueAmountUnits: BigInt(1) } }), /value proof identity is immutable/);
    await assert.rejects(db.posSalePayment.create({ data: {
      saleId: consumed.sale.id, originalPaymentId: consumed.payment.id, processingSessionId: fixture.session.id,
      type: "refund", method: "cash", status: "refunded", amountCents: 1, tenderedCents: 0, changeCents: 0,
      provider: "cash", installments: 1, idempotencyKey: `refund-value-${token}`, valueAmountUnits: BigInt(1), refundedAt: new Date(),
    } }), /must not claim authoritative plan or value proof fields/);

    const lockedConnector = await createQuotedPlan(db, input("connector-lock"));
    let releaseConnector!: () => void, connectorLocked!: () => void;
    const connectorReady = new Promise<void>(resolve => { connectorLocked = resolve; });
    const connectorHold = new Promise<void>(resolve => { releaseConnector = resolve; });
    const activating = db.$transaction(async tx => {
      await tx.posPaymentPlanSlot.create({ data: { planId: lockedConnector.planId, paymentIndex: 0, method: "credit", amountCents: 1_000, installments: 1, proofKind: "intent", connectorId: fixture.connector.id, credentialRef: fixture.credential.id, provider: fixture.provider } });
      await transitionPlan(tx, lockedConnector.planId, "activate", 0, "active", `connector-lock-${token}`, hash);
      connectorLocked();
      await connectorHold;
    }, { timeout: 10_000 });
    await connectorReady;
    try {
      await assert.rejects(peer.$transaction(async tx => {
        await tx.$executeRaw(Prisma.sql`SET LOCAL lock_timeout = '300ms'`);
        await tx.posConnector.update({ where: { id: fixture.connector.id }, data: { settings: { methods: ["pix"] } } });
      }), /lock timeout|canceling statement due to lock timeout/i);
    } finally {
      releaseConnector();
      await activating;
    }

    const second = await secondaryContext(db, fixture, `${token}-second`, hash);
    const firstDue = await createElectronicIntent(db, input("hol-first", { nextAttemptAt: new Date("2000-01-01T00:00:00.000Z") }));
    const secondDueInput: PlanInput = { token: `hol-second-${token}`, fixture: second, amountCents: 900, method: "debit", installments: 1, nextAttemptAt: new Date("2000-01-01T00:00:01.000Z") };
    const secondDue = await createElectronicIntent(db, secondDueInput);
    let release!: () => void, locked!: () => void;
    const ready = new Promise<void>(resolve => { locked = resolve; });
    const hold = new Promise<void>(resolve => { release = resolve; });
    const holder = db.$transaction(async tx => {
      await tx.$queryRaw(Prisma.sql`SELECT "id" FROM "cash_register_sessions" WHERE "id" = ${fixture.session.id} FOR UPDATE`);
      locked();
      await hold;
    }, { timeout: 10_000 });
    await ready;
    let fairClaim: Awaited<ReturnType<typeof claimPosPaymentOutbox>> | undefined;
    try {
      fairClaim = await Promise.race([
        claimPosPaymentOutbox(peer, { workerId: `fair-${compact}`, limit: 1, leaseSeconds: 60, now: new Date() }),
        delay(2_000).then(() => { throw new Error("claim bloqueou atrás da primeira session"); }),
      ]);
    } finally {
      release();
      await holder;
    }
    assert.equal(fairClaim?.claimedCount, 1);
    const claimedSecond = fairClaim?.claimed[0];
    assert.ok(claimedSecond);
    assert.equal(claimedSecond.intent.id, secondDue.intentId);
    assert.notEqual(claimedSecond.intent.id, firstDue.intentId);
    await db.posPaymentOutbox.update({ where: { attemptId: firstDue.attemptId }, data: { nextAttemptAt: new Date("2100-01-01T00:00:00.000Z") } });
    await completePosPaymentOutbox(db, { attemptId: claimedSecond.attemptId, claimToken: claimedSecond.claimToken, result: {
      kind: "result", provider: second.provider, providerReference: `hol-declined-${token}`, state: "declined", amountCents: 900, currency: "BRL",
      providerSequence: BigInt(1), occurredAt: new Date(), evidenceId: `hol-evidence-${token}`, transactionId: null, endToEndId: null,
      nsu: null, authorizationCode: null, cardBrand: null, cardLastFour: null, failureCode: "declined", failureMessage: "Declined",
    } });
  } finally {
    await Promise.all([db.$disconnect(), peer.$disconnect()]);
  }
});

test("310000 maintenance não avança a mesma intent duas vezes no mesmo ciclo", { skip: !connectionString }, async () => {
  const db = client(), token = safeToken(), hash = digest(token);
  try {
    const fixture = await baseFixture(db, `${token}-maintenance`, hash);
    const input: PlanInput = { token: `maintenance-${token}`, fixture, amountCents: 650, method: "debit", installments: 1, nextAttemptAt: new Date() };
    const created = await createElectronicIntent(db, input);
    const claimedAt = new Date();
    await db.$transaction(async tx => {
      await tx.posPaymentAttempt.update({ where: { id: created.attemptId }, data: { state: "claimed", dispatchCount: 1, startedAt: claimedAt } });
      await tx.posPaymentOutbox.update({ where: { attemptId: created.attemptId }, data: { state: "claimed", deliveryCount: 1, claimToken: `expired-lease-${token}`, claimExpiresAt: new Date(claimedAt.valueOf() + 1_000) } });
    });
    const maintenanceNow = new Date(claimedAt.valueOf() + 600_000);
    const first = await maintainPosPaymentPersistence(db, { now: maintenanceNow, batchSize: 20, correlationId: `lease-first-${token}` });
    assert.ok(first.uncertainLeases >= 1);
    assert.equal(await db.posPaymentAttempt.count({ where: { intentId: created.intentId, operation: "query" } }), 0);
    const uncertain = await db.posPaymentIntent.findUniqueOrThrow({ where: { id: created.intentId } });
    assert.equal(uncertain.status, "unknown");
    assert.equal(uncertain.version, 1);
    await maintainPosPaymentPersistence(db, { now: maintenanceNow, batchSize: 20, correlationId: `lease-second-${token}` });
    assert.equal(await db.posPaymentAttempt.count({ where: { intentId: created.intentId, operation: "query" } }), 1);
    assert.equal((await db.posPaymentIntent.findUniqueOrThrow({ where: { id: created.intentId } })).version, 2);
  } finally {
    await db.$disconnect();
  }
});

test("310000 expiração não sofre starvation atrás de evidência bloqueada", { skip: !connectionString }, async () => {
  const db = client(), token = safeToken(), hash = digest(token);
  try {
    const fixture = await baseFixture(db, `${token}-expiry-fair`, hash);
    const blocked = [];
    for (let index = 0; index < 5; index += 1) {
      blocked.push(await createShortClaimedPlan(db, fixture, `blocked-${index}-${token}`, hash, "captured"));
    }
    const safe = await createShortClaimedPlan(db, fixture, `safe-behind-${token}`, hash, "quote");
    const waitMs = Math.max(safe.expiresAt.valueOf(), ...blocked.map(plan => plan.expiresAt.valueOf())) - Date.now() + 300;
    await delay(Math.max(0, waitMs));
    const first = await maintainPosPaymentPersistence(db, { batchSize: 5, correlationId: `expiry-fair-first-${token}` });
    const second = await maintainPosPaymentPersistence(db, { batchSize: 5, correlationId: `expiry-fair-second-${token}` });
    assert.ok(first.expiredPaymentPlans + second.expiredPaymentPlans >= 1);
    assert.equal(second.remainingExpiredPaymentPlans, 0);
    assert.ok(second.remainingBlockedExpiredPaymentPlans >= 5);
    assert.equal(second.hasMore, false);
    assert.equal((await db.posPaymentPlan.findUniqueOrThrow({ where: { id: safe.planId } })).state, "expired");
    for (const plan of blocked) {
      assert.equal((await db.posPaymentPlan.findUniqueOrThrow({ where: { id: plan.planId } })).state, "active");
    }
  } finally {
    await db.$disconnect();
  }
});

test("310000 DML direto preserva session→plan sem deadlock", { skip: !connectionString }, async () => {
  const db = client(), peer = client(), token = safeToken(), hash = digest(token);
  try {
    const fixture = await baseFixture(db, `${token}-lock-order`, hash);
    const input: PlanInput = { token: `lock-order-${token}`, fixture, amountCents: 500, method: "credit", installments: 1, nextAttemptAt: new Date() };
    const quoted = await createQuotedPlan(db, input);
    let sessionLocked!: () => void, slotStarted!: () => void;
    const sessionReady = new Promise<void>(resolve => { sessionLocked = resolve; });
    const slotReady = new Promise<void>(resolve => { slotStarted = resolve; });
    const holder = db.$transaction(async tx => {
      await tx.$executeRaw(Prisma.sql`SET LOCAL lock_timeout = '5s'`);
      await tx.$queryRaw(Prisma.sql`SELECT "id" FROM "cash_register_sessions" WHERE "id" = ${fixture.session.id} FOR UPDATE`);
      sessionLocked();
      await slotReady;
      await delay(200);
      await tx.$queryRaw(Prisma.sql`SELECT "id" FROM "pos_payment_plans" WHERE "id" = ${quoted.planId} FOR UPDATE`);
    }, { timeout: 10_000 });
    await sessionReady;
    const activator = peer.$transaction(async tx => {
      await tx.$executeRaw(Prisma.sql`SET LOCAL lock_timeout = '5s'`);
      slotStarted();
      await tx.posPaymentPlanSlot.create({ data: { planId: quoted.planId, paymentIndex: 0, method: "credit", amountCents: 500, installments: 1, proofKind: "intent", connectorId: fixture.connector.id, credentialRef: fixture.credential.id, provider: fixture.provider } });
      await transitionPlan(tx, quoted.planId, "activate", 0, "active", `lock-order-${token}`, hash);
    }, { timeout: 10_000 });
    const settled = await Promise.allSettled([holder, activator]);
    const rejected = settled.filter((result): result is PromiseRejectedResult => result.status === "rejected");
    assert.equal(rejected.length, 0, rejected.map(result => String(result.reason)).join("\n"));
    assert.equal((await db.posPaymentPlan.findUniqueOrThrow({ where: { id: quoted.planId } })).state, "active");
  } finally {
    await Promise.all([db.$disconnect(), peer.$disconnect()]);
  }
});

test("310000 expira plano seguro e preserva captured/artefato incompleto", { skip: !connectionString }, async () => {
  const db = client(), token = safeToken(), hash = digest(token);
  try {
    const fixture = await baseFixture(db, `${token}-expiry`, hash);
    const safe = await createShortClaimedPlan(db, fixture, `safe-${token}`, hash, "quote");
    const captured = await createShortClaimedPlan(db, fixture, `captured-${token}`, hash, "captured");
    const incomplete = await createShortClaimedPlan(db, fixture, `incomplete-${token}`, hash, "incomplete_attempt");
    const declined = await createShortClaimedPlan(db, fixture, `declined-${token}`, hash, "declined_callback");
    const waitMs = Math.max(0, safe.expiresAt.valueOf() - Date.now(), captured.expiresAt.valueOf() - Date.now(), incomplete.expiresAt.valueOf() - Date.now(), declined.expiresAt.valueOf() - Date.now()) + 300;
    await delay(waitMs);
    const maintenance = await maintainPosPaymentPersistence(db, { batchSize: 20, correlationId: `expiry-${token}` });
    assert.ok(maintenance.expiredPaymentPlans >= 1);
    assert.equal((await db.posPaymentPlan.findUniqueOrThrow({ where: { id: safe.planId } })).state, "expired");
    const expiryOperation = await db.posPaymentPlanOperation.findFirst({ where: { planId: safe.planId, action: "expire" }, orderBy: { id: "desc" } });
    assert.equal(expiryOperation?.actorUserId, "system:pos-payment-maintenance");
    assert.equal((await db.posPaymentPlan.findUniqueOrThrow({ where: { id: captured.planId } })).state, "active");
    assert.equal((await db.posPaymentPlan.findUniqueOrThrow({ where: { id: incomplete.planId } })).state, "active");
    assert.equal((await db.posPaymentPlan.findUniqueOrThrow({ where: { id: declined.planId } })).state, "expired");
    await assert.rejects(db.$transaction(tx => transitionPlan(tx, incomplete.planId, "expire", 1, "expired", `expire-incomplete-${token}`, hash)), /unresolved financial evidence/);
  } finally {
    await db.$disconnect();
  }
});

type Fixture = Awaited<ReturnType<typeof baseFixture>>;
type PlanInput = { token: string; fixture: Fixture; amountCents: number; method: "pix" | "credit" | "debit" | "voucher"; installments: number; nextAttemptAt: Date };

function client() {
  if (!connectionString) throw new Error("POS_TEST_DATABASE_URL ausente");
  return new PrismaClient({ adapter: new PrismaPg({ connectionString }) });
}

async function baseFixture(db: PrismaClient, token: string, hash: string) {
  const compact = token.replaceAll("-", "").slice(0, 40);
  const role = await db.tenantRole.findFirstOrThrow({ where: { active: true } });
  const branch = await db.branch.create({ data: { code: `PLAN${compact}`, name: `Plan ${compact}`, legalName: `Plan ${compact} Ltda`, document: `PLANDOC${compact}` } });
  const register = await db.posRegister.create({ data: { branchId: branch.id, code: `REG${compact}`, name: `Register ${compact}` } });
  const now = new Date();
  const terminal = await db.posTerminal.create({ data: { id: `terminal-${token}`, registerId: register.id, code: `TERM${compact}`, name: `Terminal ${compact}`, status: "online", tokenHash: `hmac-sha256:v1:${hash}`, tokenIssuedAt: now, tokenExpiresAt: new Date(now.valueOf() + 3_600_000), credentialVersion: 1, pairedAt: now, lastSeenAt: now, appVersion: "test" } });
  const profile = await db.tenantUserProfile.create({ data: { userId: `plan-user-${token}`, roleId: role.id, displayName: "Operador plano", email: `${compact}@example.invalid`, activeBranchId: branch.id } });
  await db.branchUserAccess.create({ data: { branchId: branch.id, userProfileId: profile.id, canSell: true } });
  await db.posRegisterAccess.create({ data: { registerId: register.id, userProfileId: profile.id, active: true, canSell: true } });
  const session = await db.cashRegisterSession.create({ data: { number: `PLAN-${token}`, registerName: register.name, status: "open", openingAmount: 0, openingAmountCents: 0, openedBy: profile.displayName, registerId: register.id, operatorProfileId: profile.id } });
  const provider = `plan_${compact}`;
  await db.integrationProvider.create({ data: { id: provider, family: "payment", label: "Plan PSP", description: "fixture", recipientType: "none", authType: "api_key", capabilities: {}, credentialSchema: {} } });
  const credential = await db.integrationCredential.create({ data: { id: `credential-${token}`, providerId: provider, label: "Plan credential", enabled: true, config: {} } });
  const connector = await db.posConnector.create({ data: { id: `connector-${token}`, branchId: branch.id, registerId: register.id, type: `payment_${compact}`, provider, credentialRef: credential.id, status: "active", settings: {} } });
  const product = await db.product.create({ data: { name: `Product ${compact}`, slug: `product-${compact}`, sku: `SKU-${compact}`, category: "Teste", price: 10, regularPrice: 10, manageStock: false } });
  return { role, branch, register, terminal, profile, session, provider, credential, connector, product };
}

async function secondaryContext(db: PrismaClient, fixture: Fixture, token: string, hash: string): Promise<Fixture> {
  const compact = token.replaceAll("-", "").slice(0, 40), now = new Date();
  const register = await db.posRegister.create({ data: { branchId: fixture.branch.id, code: `REG${compact}`, name: `Register ${compact}` } });
  const terminal = await db.posTerminal.create({ data: { id: `terminal-${token}`, registerId: register.id, code: `TERM${compact}`, name: `Terminal ${compact}`, status: "online", tokenHash: `hmac-sha256:v1:${hash}`, tokenIssuedAt: now, tokenExpiresAt: new Date(now.valueOf() + 3_600_000), credentialVersion: 1, pairedAt: now, lastSeenAt: now, appVersion: "test" } });
  const profile = await db.tenantUserProfile.create({ data: { userId: `plan-user-${token}`, roleId: fixture.role.id, displayName: "Operador secundário", email: `${compact}@example.invalid`, activeBranchId: fixture.branch.id } });
  await db.branchUserAccess.create({ data: { branchId: fixture.branch.id, userProfileId: profile.id, canSell: true } });
  await db.posRegisterAccess.create({ data: { registerId: register.id, userProfileId: profile.id, active: true, canSell: true } });
  const session = await db.cashRegisterSession.create({ data: { number: `PLAN-${token}`, registerName: register.name, status: "open", openingAmount: 0, openingAmountCents: 0, openedBy: profile.displayName, registerId: register.id, operatorProfileId: profile.id } });
  const connector = await db.posConnector.create({ data: { id: `connector-${token}`, branchId: fixture.branch.id, registerId: register.id, type: `payment_${compact}`, provider: fixture.provider, credentialRef: fixture.credential.id, status: "active", settings: {} } });
  return { ...fixture, register, terminal, profile, session, connector };
}

async function createQuotedPlan(db: PrismaClient, input: PlanInput, includeLine = true) {
  const { fixture } = input, planId = `plan-${input.token}`, saleDraftId = `draft-${input.token}`, evaluatedAt = new Date(), expiresAt = new Date(evaluatedAt.valueOf() + 300_000), hash = digest(input.token);
  return db.$transaction(async tx => {
    const draft = await tx.posHeldSale.create({ data: { id: saleDraftId, registerId: fixture.register.id, sessionId: fixture.session.id, operatorProfileId: fixture.profile.id, status: "draft", idempotencyKey: `draft-key-${input.token}`, requestHash: hash, items: { create: { productId: fixture.product.id, quantity: 1, unitPriceCents: input.amountCents, discountCents: 0 } } }, include: { items: true } });
    await tx.posPaymentPlan.create({ data: { id: planId, branchId: fixture.branch.id, registerId: fixture.register.id, sessionId: fixture.session.id, operatorProfileId: fixture.profile.id, terminalId: fixture.terminal.id, saleDraftId, draftRevision: 0, draftRequestHash: hash, draftStatus: "draft", quoteHash: hash, evaluatedAt, expiresAt, totalCents: input.amountCents, idempotencyKey: `quote-plan-${input.token}`, requestHash: hash } });
    if (includeLine) await tx.posPaymentPlanQuoteLine.create({ data: quoteLine(planId, 0, draft.items[0].id, fixture.product.id, input.amountCents) });
    await tx.posPaymentPlanOperation.create({ data: { planId, action: "quote", expectedVersion: -1, resultingVersion: 0, resultingState: "quoted", idempotencyKey: `quote-plan-${input.token}`, requestHash: hash } });
    return { planId, saleDraftId, heldSaleItemId: draft.items[0].id, expiresAt };
  });
}

async function createElectronicIntent(db: PrismaClient, input: PlanInput) {
  const quoted = await createQuotedPlan(db, input);
  await activateElectronicPlan(db, quoted.planId, input);
  const artifact = await insertElectronicIntent(db, input, quoted);
  return { ...quoted, ...artifact };
}

async function insertElectronicIntent(db: PrismaClient, input: PlanInput, quoted: { planId: string; saleDraftId: string; expiresAt: Date }) {
  const hash = digest(input.token), intentId = `intent-${input.token}`, attemptId = `attempt-${input.token}`, intentKey = `intent-key-${input.token}`;
  await db.posPaymentIntent.create({ data: { id: intentId, branchId: input.fixture.branch.id, registerId: input.fixture.register.id, sessionId: input.fixture.session.id, operatorProfileId: input.fixture.profile.id, terminalId: input.fixture.terminal.id, connectorId: input.fixture.connector.id, credentialRef: input.fixture.credential.id, saleDraftId: quoted.saleDraftId, paymentPlanId: quoted.planId, paymentIndex: 0, amountCents: input.amountCents, currency: "BRL", method: input.method, installments: input.installments, provider: input.fixture.provider, expiresAt: quoted.expiresAt, idempotencyKey: intentKey, requestHash: hash, attempts: { create: { id: attemptId, sequence: 1, operation: "create", operationKey: intentKey, requestHash: hash, providerIdempotencyKey: intentKey, outbox: { create: { nextAttemptAt: input.nextAttemptAt } } } }, stateEvents: { create: { eventKey: `created-${input.token}`, source: "api", sourceId: intentKey, toState: "created", resultingVersion: 0 } } } });
  return { intentId, attemptId };
}

async function activateElectronicPlan(db: PrismaClient, planId: string, input: PlanInput) {
  const hash = digest(input.token);
  return db.$transaction(async tx => {
    await tx.posPaymentPlanSlot.create({ data: { planId, paymentIndex: 0, method: input.method, amountCents: input.amountCents, installments: input.installments, proofKind: "intent", connectorId: input.fixture.connector.id, credentialRef: input.fixture.credential.id, provider: input.fixture.provider } });
    await transitionPlan(tx, planId, "activate", 0, "active", `activate-${input.token}`, hash);
  });
}

async function activateCashPlan(db: PrismaClient, planId: string, amountCents: number, key: string, hash: string) {
  await db.$transaction(async tx => {
    await tx.posPaymentPlanSlot.create({ data: cashSlot(planId, amountCents) });
    await transitionPlan(tx, planId, "activate", 0, "active", key, hash);
  });
}

async function transitionPlan(tx: PrismaTypes.TransactionClient, planId: string, action: "activate" | "consume" | "expire", version: number, state: "active" | "consumed" | "expired", key: string, hash: string, saleId?: number) {
  await tx.posPaymentPlanOperation.create({ data: { planId, action, expectedVersion: version, resultingVersion: version + 1, resultingState: state, idempotencyKey: key, requestHash: hash, saleId } });
  await tx.posPaymentPlan.update({ where: { id: planId }, data: { state, version: version + 1, ...(saleId ? { consumedSaleId: saleId } : {}) } });
}

async function createShortClaimedPlan(db: PrismaClient, fixture: Fixture, token: string, hash: string, mode: "quote" | "captured" | "incomplete_attempt" | "declined_callback") {
  const claimId = `claim-draft-${token}`, planId = `claim-plan-${token}`, evaluatedAt = new Date(), expiresAt = new Date(evaluatedAt.valueOf() + 8_000);
  const order = await db.salesOrder.create({ data: { number: `ORDER-${token}`, kind: "order", status: "approved", branchId: fixture.branch.id, customerName: "Cliente", createdBy: fixture.profile.userId, total: 10, approvedAt: evaluatedAt } });
  await db.$transaction(async tx => {
    const draft = await tx.posHeldSale.create({ data: { id: claimId, registerId: fixture.register.id, sessionId: fixture.session.id, operatorProfileId: fixture.profile.id, status: "draft", idempotencyKey: `short-draft-${token}`, requestHash: hash, items: { create: { productId: fixture.product.id, quantity: 1, unitPriceCents: 1_000, discountCents: 0 } } }, include: { items: true } });
    await tx.posOrderClaim.create({ data: { id: claimId, salesOrderId: order.id, branchId: fixture.branch.id, registerId: fixture.register.id, sessionId: fixture.session.id, operatorProfileId: fixture.profile.id, terminalId: fixture.terminal.id, leaseExpiresAt: expiresAt, idempotencyKey: `claim-key-${token}`, requestHash: hash } });
    await tx.posOrderClaimOperation.create({ data: { claimId, action: "claim", expectedVersion: 0, resultingVersion: 0, resultingState: "active", idempotencyKey: `claim-op-${token}`, requestHash: hash, leaseExpiresAt: expiresAt } });
    await tx.posPaymentPlan.create({ data: { id: planId, branchId: fixture.branch.id, registerId: fixture.register.id, sessionId: fixture.session.id, operatorProfileId: fixture.profile.id, terminalId: fixture.terminal.id, saleDraftId: claimId, draftRevision: 0, draftRequestHash: hash, draftStatus: "draft", orderClaimId: claimId, quoteHash: hash, evaluatedAt, expiresAt, totalCents: 1_000, idempotencyKey: `short-quote-${token}`, requestHash: hash } });
    await tx.posPaymentPlanQuoteLine.create({ data: quoteLine(planId, 0, draft.items[0].id, fixture.product.id, 1_000) });
    await tx.posPaymentPlanOperation.create({ data: { planId, action: "quote", expectedVersion: -1, resultingVersion: 0, resultingState: "quoted", idempotencyKey: `short-quote-${token}`, requestHash: hash } });
  });
  if (mode === "quote") return { planId, expiresAt };
  const electronicInput: PlanInput = { token, fixture, amountCents: 1_000, method: "credit", installments: 1, nextAttemptAt: new Date() };
  await activateElectronicPlan(db, planId, electronicInput);
  const intentId = `short-intent-${token}`, attemptId = `short-attempt-${token}`, intentKey = `short-intent-key-${token}`;
  await db.posPaymentIntent.create({ data: { id: intentId, branchId: fixture.branch.id, registerId: fixture.register.id, sessionId: fixture.session.id, operatorProfileId: fixture.profile.id, terminalId: fixture.terminal.id, connectorId: fixture.connector.id, credentialRef: fixture.credential.id, saleDraftId: claimId, paymentPlanId: planId, paymentIndex: 0, amountCents: 1_000, currency: "BRL", method: "credit", installments: 1, provider: fixture.provider, expiresAt, idempotencyKey: intentKey, requestHash: hash, attempts: { create: { id: attemptId, sequence: 1, operation: "create", operationKey: intentKey, requestHash: hash, providerIdempotencyKey: intentKey, outbox: { create: { nextAttemptAt: new Date() } } } }, stateEvents: { create: { eventKey: `short-created-${token}`, source: "api", sourceId: intentKey, toState: "created", resultingVersion: 0 } } } });
  if (mode === "captured") {
    await acceptPosPaymentCallback(db, fixture.provider, `short-callback-${token}`, "test", hash, { intentId, provider: fixture.provider, providerReference: `ref-${token}`, state: "captured", amountCents: 1_000, currency: "BRL", providerSequence: BigInt(1), occurredAt: new Date(), evidenceId: `evidence-${token}`, transactionId: `transaction-${token}`, endToEndId: null, nsu: `nsu-${token}`, authorizationCode: `auth-${token}`, cardBrand: "test", cardLastFour: "4242", failureCode: null, failureMessage: null });
  } else if (mode === "declined_callback") {
    const claimedAt = new Date();
    await db.$transaction(async tx => {
      await tx.posPaymentAttempt.update({ where: { id: attemptId }, data: { state: "claimed", dispatchCount: 1, startedAt: claimedAt } });
      await tx.posPaymentOutbox.update({ where: { attemptId }, data: { state: "claimed", deliveryCount: 1, claimToken: `callback-claim-${token}`, claimExpiresAt: new Date(claimedAt.valueOf() + 60_000) } });
      await tx.posPaymentAttempt.update({ where: { id: attemptId }, data: { state: "succeeded", finishedAt: claimedAt } });
      await tx.posPaymentOutbox.update({ where: { attemptId }, data: { state: "completed", claimToken: null, claimExpiresAt: null, completedAt: claimedAt } });
    });
    await acceptPosPaymentCallback(db, fixture.provider, `declined-callback-${token}`, "test", hash, { intentId, provider: fixture.provider, providerReference: `declined-ref-${token}`, state: "declined", amountCents: 1_000, currency: "BRL", providerSequence: BigInt(1), occurredAt: new Date(), evidenceId: `declined-evidence-${token}`, transactionId: null, endToEndId: null, nsu: null, authorizationCode: null, cardBrand: null, cardLastFour: null, failureCode: "insufficient_funds", failureMessage: "Declined" });
  } else {
    await db.$transaction(async tx => {
      await tx.posPaymentAttempt.update({ where: { id: attemptId }, data: { state: "failed", failureCode: "expired_before_dispatch", finishedAt: new Date() } });
      await tx.posPaymentOutbox.update({ where: { attemptId }, data: { state: "dead", completedAt: new Date(), lastErrorCode: "expired_before_dispatch" } });
      await tx.posPaymentIntent.update({ where: { id: intentId }, data: { status: "cancelled", version: 1, failureCode: "expired_before_dispatch" } });
      await tx.posPaymentStateEvent.create({ data: { intentId, attemptId, eventKey: `short-cancel-${token}`, source: "maintenance", sourceId: `short-cancel-${token}`, fromState: "created", toState: "cancelled", resultingVersion: 1 } });
      await tx.posPaymentAttempt.create({ data: { id: `orphan-attempt-${token}`, intentId, sequence: 2, operation: "query", state: "failed", operationKey: `orphan-operation-${token}`, requestHash: hash, providerIdempotencyKey: `orphan-provider-${token}`, dispatchCount: 0, outcomeUnknown: false, failureCode: "expired_before_dispatch", finishedAt: new Date() } });
    });
  }
  return { planId, expiresAt };
}

function quoteLine(planId: string, lineIndex: number, heldSaleItemId: number, productId: number, amountCents: number) {
  return { planId, lineIndex, heldSaleItemId, productId, quantity: 1, unitPriceCents: amountCents, grossCents: amountCents, baseDiscountCents: 0, orderDiscountCents: 0, promotionDiscountCents: 0, surchargeCents: 0, totalCents: amountCents };
}

function cashSlot(planId: string, amountCents: number) {
  return { planId, paymentIndex: 0, method: "cash", amountCents, installments: 1, proofKind: "cash" };
}

function saleData(fixture: Fixture, saleDraftId: string, suffix: string, amountCents: number, hash: string) {
  return { saleNumber: `SALE-${suffix}`, branchId: fixture.branch.id, sessionId: fixture.session.id, operatorProfileId: fixture.profile.id, customer: "Cliente", seller: fixture.profile.displayName, cashRegister: fixture.register.name, paymentMethod: "cash", total: amountCents / 100, subtotalCents: amountCents, discountCents: 0, surchargeCents: 0, totalCents: amountCents, changeCents: 100, idempotencyKey: saleDraftId, requestHash: hash, items: { create: { productId: fixture.product.id, productName: fixture.product.name, quantity: 1, unitPrice: amountCents / 100, total: amountCents / 100, unitPriceCents: amountCents, grossCents: amountCents, discountCents: 0, surchargeCents: 0, totalCents: amountCents } } };
}

function digest(value: string) {
  return createHash("sha256").update(value).digest("hex");
}

function safeToken() {
  return randomUUID().replace(/[0-9]/g, digit => String.fromCharCode(103 + Number(digit)));
}
