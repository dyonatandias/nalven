import { Prisma } from "@/generated/tenant/client";

type TransactionClient = Prisma.TransactionClient;

type PaymentLocator = {
  id: string;
  paymentPlanId: string | null;
  idempotencyKey: string;
  saleId: number;
  processingSessionId: number | null;
};

type PlanLocator = {
  id: string;
  version: number;
  branchId: number;
  registerId: number;
  sessionId: number;
  operatorProfileId: number;
  terminalId: string;
  orderClaimId: string | null;
  saleDraftId: string;
};

type ClaimLocator = {
  id: string;
  salesOrderId: number;
  branchId: number;
  registerId: number;
  sessionId: number;
  operatorProfileId: number;
  terminalId: string;
};

export class PosSalePaymentPrelockError extends Error {}

/**
 * Locks the roots which authorize a plan-linked pos_sale_payments write.
 *
 * The order is global across all plans: session -> terminal -> access roots ->
 * sales order -> claim -> held sale -> plan -> existing sale payment. A caller must opt in
 * when an original payment predates authoritative plans; the legacy payment is
 * still locked, but this helper never fabricates a plan association for it.
 */
export async function prelockPosSalePaymentWriteGraph(tx: TransactionClient, input: {
  mode: "operational" | "historical_refund";
  preRootAdvisoryNamespaces?: readonly string[];
  paymentPlanIds?: readonly string[];
  existingPaymentIds?: readonly string[];
  allowLegacyNoPlanPayments?: boolean;
  insertIdempotencyKeys?: readonly string[];
  saleIds?: readonly number[];
  historicalActorProfileIds?: readonly number[];
  refundOriginalPaymentIds?: readonly string[];
}) {
  const requestedPaymentIds = uniqueStrings(input.existingPaymentIds ?? []);
  const paymentLocators = requestedPaymentIds.length
    ? await tx.posSalePayment.findMany({
      where: { id: { in: requestedPaymentIds } },
      select: { id: true, paymentPlanId: true, idempotencyKey: true, saleId: true, processingSessionId: true },
    })
    : [];
  assertAllPaymentsFound(requestedPaymentIds, paymentLocators);

  const legacyPaymentIds = paymentLocators
    .filter((payment) => payment.paymentPlanId === null)
    .map((payment) => payment.id)
    .sort();
  if (legacyPaymentIds.length && input.allowLegacyNoPlanPayments !== true) {
    throw new PosSalePaymentPrelockError("Pagamento legado sem plano exige autorização explícita do escritor.");
  }

  const planIds = uniqueStrings([
    ...(input.paymentPlanIds ?? []),
    ...paymentLocators.flatMap((payment) => payment.paymentPlanId ? [payment.paymentPlanId] : []),
  ]);
  const plans = planIds.length
    ? await tx.posPaymentPlan.findMany({
      where: { id: { in: planIds } },
      select: {
        id: true,
        version: true,
        branchId: true,
        registerId: true,
        sessionId: true,
        operatorProfileId: true,
        terminalId: true,
        orderClaimId: true,
        saleDraftId: true,
      },
    })
    : [];
  assertAllPlansFound(planIds, plans);
  const slotLocators = planIds.length ? await tx.posPaymentPlanSlot.findMany({
    where: { planId: { in: planIds } },
    select: { planId: true, paymentIndex: true, connectorId: true, credentialRef: true, provider: true },
    orderBy: [{ planId: "asc" }, { paymentIndex: "asc" }],
  }) : [];
  const claimIds = uniqueStrings(plans.flatMap((plan) => plan.orderClaimId ? [plan.orderClaimId] : []));
  // Locator only: the sales-order identity chooses which root to lock. Every
  // field is reread and compared after both the order and claim are locked.
  const claimLocators = claimIds.length ? await tx.posOrderClaim.findMany({
    where: { id: { in: claimIds } },
    select: { id: true, salesOrderId: true, branchId: true, registerId: true, sessionId: true, operatorProfileId: true, terminalId: true },
  }) : [];
  const historicalSessionIds = uniqueNumbers(paymentLocators.flatMap((payment) => payment.processingSessionId == null ? [] : [payment.processingSessionId]));
  const historicalSessionLocators = historicalSessionIds.length ? await tx.cashRegisterSession.findMany({
    where: { id: { in: historicalSessionIds } }, select: { id: true, registerId: true }, orderBy: { id: "asc" },
  }) : [];

  // All reads above are non-locking locators used only to close the namespace
  // set. Every SQL capability acquires this same set before canonical roots.
  const advisoryNamespaces = uniqueStrings([
    ...(input.preRootAdvisoryNamespaces ?? []),
    ...(input.insertIdempotencyKeys ?? []).map((key) => `pos-sale-payment-insert:${key}`),
    ...paymentLocators.map((payment) => `pos-sale-payment-insert:${payment.idempotencyKey}`),
    ...(input.existingPaymentIds ?? []).map((id) => `pos-sale-payment-refund-range:${id}`),
    ...(input.refundOriginalPaymentIds ?? []).map((id) => `pos-sale-payment-refund-range:${id}`),
    ...plans.flatMap((plan) => [
      `t2-payment-plan:aggregate:${plan.id}`,
      `t2-payment-plan:draft:${plan.saleDraftId}`,
      `pos-held-sale-items:v1:held-sale:${plan.saleDraftId}`,
      ...(plan.orderClaimId ? [
        `pos-order-claim:v1:claim:${plan.orderClaimId}`,
        `pos-order-claim:v1:artifacts:${plan.orderClaimId}`,
      ] : []),
    ]),
    ...claimLocators.map((claim) => `pos-order-claim:v1:order:${claim.salesOrderId}`),
  ]);
  for (const namespace of advisoryNamespaces) {
    await tx.$executeRaw(Prisma.sql`SELECT pg_advisory_xact_lock(hashtextextended(${namespace}, 0))`);
  }

  await lockNumberIds(tx, "cash_register_sessions", uniqueNumbers([...plans.map((plan) => plan.sessionId), ...historicalSessionIds]), "UPDATE");
  await lockStringIds(tx, "pos_terminals", uniqueStrings(plans.map((plan) => plan.terminalId)), "UPDATE");

  await lockNumberIds(tx, "tenant_user_profiles", uniqueNumbers([...plans.map((plan) => plan.operatorProfileId), ...(input.historicalActorProfileIds ?? [])]), "SHARE");
  await lockNumberIds(tx, "branches", uniqueNumbers(plans.map((plan) => plan.branchId)), "SHARE");
  await lockNumberIds(tx, "pos_registers", uniqueNumbers([...plans.map((plan) => plan.registerId), ...historicalSessionLocators.flatMap((session) => session.registerId == null ? [] : [session.registerId])]), "SHARE");
  await lockBranchAccess(tx, plans, input.mode);
  await lockRegisterAccess(tx, plans, input.mode);

  await lockNumberIds(tx, "sales_orders", uniqueNumbers(claimLocators.map((claim) => claim.salesOrderId)), "UPDATE");
  await lockStringIds(tx, "pos_order_claims", claimIds, "UPDATE");
  const lockedClaims = claimIds.length ? await tx.posOrderClaim.findMany({
    where: { id: { in: claimIds } },
    select: { id: true, salesOrderId: true, branchId: true, registerId: true, sessionId: true, operatorProfileId: true, terminalId: true },
  }) : [];
  assertClaimBindingsUnchanged(plans, claimIds, claimLocators, lockedClaims);
  await lockStringIds(tx, "pos_held_sales", uniqueStrings(plans.map((plan) => plan.saleDraftId)), "UPDATE");
  await lockHeldSaleItems(tx, plans.map((plan) => plan.saleDraftId));
  await lockStringIds(tx, "pos_connectors", uniqueStrings(slotLocators.flatMap((slot) => slot.connectorId ? [slot.connectorId] : [])), "SHARE");
  await lockStringIds(tx, "integration_providers", uniqueStrings(slotLocators.flatMap((slot) => slot.provider ? [slot.provider] : [])), "SHARE");
  await lockStringIds(tx, "integration_credentials", uniqueStrings(slotLocators.flatMap((slot) => slot.credentialRef ? [slot.credentialRef] : [])), "SHARE");
  await lockStringIds(tx, "pos_payment_plans", planIds, "UPDATE");
  const lockedPlans = planIds.length ? await tx.posPaymentPlan.findMany({
    where: { id: { in: planIds } },
    select: { id: true, version: true, branchId: true, registerId: true, sessionId: true, operatorProfileId: true, terminalId: true, orderClaimId: true, saleDraftId: true },
  }) : [];
  assertPlanBindingsUnchanged(plans, lockedPlans);
  await lockPlanSlots(tx, planIds);
  const lockedSlots = planIds.length ? await tx.posPaymentPlanSlot.findMany({
    where: { planId: { in: planIds } },
    select: { planId: true, paymentIndex: true, connectorId: true, credentialRef: true, provider: true },
    orderBy: [{ planId: "asc" }, { paymentIndex: "asc" }],
  }) : [];
  if (JSON.stringify(slotLocators) !== JSON.stringify(lockedSlots)) throw new PosSalePaymentPrelockError("Os slots do plano mudaram durante o pré-lock.");
  if (input.mode === "operational") {
    for (const plan of lockedPlans.sort((left, right) => left.id.localeCompare(right.id))) {
      const boundary = await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`
        SELECT p."id"
        FROM "pos_payment_plans" p
        JOIN "cash_register_sessions" s ON s."id" = p."session_id" AND s."register_id" = p."register_id"
        JOIN "pos_registers" r ON r."id" = p."register_id" AND r."branch_id" = p."branch_id" AND r."status" = 'active'
        JOIN "branches" b ON b."id" = p."branch_id" AND b."status" = 'active'
        JOIN "pos_terminals" t ON t."id" = p."terminal_id" AND t."register_id" = p."register_id"
        JOIN "tenant_user_profiles" profile ON profile."id" = p."operator_profile_id" AND profile."status" = 'active'
        WHERE p."id" = ${plan.id}
          AND s."status" = 'open'
          AND t."status" = 'online'
          AND t."paired_at" IS NOT NULL
          AND t."revoked_at" IS NULL
          AND t."token_hash" IS NOT NULL
          AND t."token_expires_at" > clock_timestamp()
          AND t."last_seen_at" > clock_timestamp() - interval '5 minutes'
          AND NULLIF(btrim(t."app_version"), '') IS NOT NULL
      `);
      if (boundary.length !== 1) throw new PosSalePaymentPrelockError("O boundary branch/register/session do plano mudou durante o pré-lock.");
    }
  }

  await lockNumberIds(tx, "sales", uniqueNumbers([...(input.saleIds ?? []), ...paymentLocators.map((payment) => payment.saleId)]), "UPDATE");
  const existingForPlans = planIds.length
    ? await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`
      SELECT "id"
      FROM "pos_sale_payments"
      WHERE "payment_plan_id" IN (${Prisma.join(planIds)})
      ORDER BY "id"
      FOR UPDATE
    `)
    : [];
  const allPaymentIds = uniqueStrings([
    ...requestedPaymentIds,
    ...existingForPlans.map((payment) => payment.id),
  ]);
  await lockStringIds(tx, "pos_sale_payments", allPaymentIds, "UPDATE");
  for (const originalPaymentId of uniqueStrings(input.refundOriginalPaymentIds ?? requestedPaymentIds)) {
    await tx.$queryRaw(Prisma.sql`SELECT "id" FROM "pos_sale_payments" WHERE "original_payment_id" = ${originalPaymentId} ORDER BY "id" FOR UPDATE`);
  }

  if (requestedPaymentIds.length) {
    const lockedPayments = await tx.posSalePayment.findMany({
      where: { id: { in: requestedPaymentIds } },
      select: { id: true, paymentPlanId: true, idempotencyKey: true, saleId: true, processingSessionId: true },
    });
    assertPaymentBindingsUnchanged(paymentLocators, lockedPayments);
  }

  return { plans: lockedPlans, planIds, paymentIds: allPaymentIds, legacyPaymentIds };
}

async function lockBranchAccess(tx: TransactionClient, plans: readonly PlanLocator[], mode: "operational" | "historical_refund") {
  const keys = uniquePairs(plans.map((plan) => [plan.branchId, plan.operatorProfileId] as const));
  for (const [branchId, operatorProfileId] of keys) {
    const rows = await tx.$queryRaw<Array<{ id: number }>>(Prisma.sql`
      SELECT "id" FROM "branch_user_accesses"
      WHERE "branch_id" = ${branchId} AND "user_profile_id" = ${operatorProfileId}
        ${mode === "operational" ? Prisma.sql`AND "can_sell" = true` : Prisma.empty}
      FOR SHARE
    `);
    if (mode === "operational" && rows.length !== 1) throw new PosSalePaymentPrelockError("Acesso ativo à filial mudou durante o pré-lock.");
  }
}

async function lockRegisterAccess(tx: TransactionClient, plans: readonly PlanLocator[], mode: "operational" | "historical_refund") {
  const keys = uniquePairs(plans.map((plan) => [plan.registerId, plan.operatorProfileId] as const));
  for (const [registerId, operatorProfileId] of keys) {
    const rows = await tx.$queryRaw<Array<{ id: number }>>(Prisma.sql`
      SELECT "id" FROM "pos_register_accesses"
      WHERE "register_id" = ${registerId} AND "user_profile_id" = ${operatorProfileId}
        ${mode === "operational" ? Prisma.sql`
          AND "active" = true AND "can_sell" = true
          AND ("valid_from" IS NULL OR "valid_from" <= clock_timestamp())
          AND ("valid_until" IS NULL OR "valid_until" >= clock_timestamp())
        ` : Prisma.empty}
      FOR SHARE
    `);
    if (mode === "operational" && rows.length !== 1) throw new PosSalePaymentPrelockError("Acesso ativo ao caixa mudou durante o pré-lock.");
  }
}

async function lockNumberIds(tx: TransactionClient, table: "cash_register_sessions" | "tenant_user_profiles" | "branches" | "pos_registers" | "sales_orders" | "sales", ids: readonly number[], mode: "UPDATE" | "SHARE") {
  if (!ids.length) return;
  const rows = await tx.$queryRaw<Array<{ id: number }>>(Prisma.sql`
    SELECT "id" FROM ${Prisma.raw(`"${table}"`)}
    WHERE "id" IN (${Prisma.join(ids)})
    ORDER BY "id"
    ${Prisma.raw(`FOR ${mode}`)}
  `);
  if (rows.length !== ids.length) throw new PosSalePaymentPrelockError(`Root ${table} mudou durante o pré-lock.`);
}

async function lockStringIds(tx: TransactionClient, table: "pos_terminals" | "pos_order_claims" | "pos_held_sales" | "integration_providers" | "pos_connectors" | "integration_credentials" | "pos_payment_plans" | "pos_sale_payments", ids: readonly string[], mode: "UPDATE" | "SHARE") {
  if (!ids.length) return;
  const rows = await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`
    SELECT "id" FROM ${Prisma.raw(`"${table}"`)}
    WHERE "id" IN (${Prisma.join(ids)})
    ORDER BY "id"
    ${Prisma.raw(`FOR ${mode}`)}
  `);
  if (rows.length !== ids.length) throw new PosSalePaymentPrelockError(`Root ${table} mudou durante o pré-lock.`);
}

async function lockHeldSaleItems(tx: TransactionClient, heldSaleIds: readonly string[]) {
  const ids = uniqueStrings(heldSaleIds);
  if (!ids.length) return;
  await tx.$queryRaw(Prisma.sql`SELECT "id" FROM "pos_held_sale_items" WHERE "held_sale_id" IN (${Prisma.join(ids)}) ORDER BY "id" FOR UPDATE`);
}

async function lockPlanSlots(tx: TransactionClient, planIds: readonly string[]) {
  const ids = uniqueStrings(planIds);
  if (!ids.length) return;
  await tx.$queryRaw(Prisma.sql`SELECT "plan_id", "payment_index" FROM "pos_payment_plan_slots" WHERE "plan_id" IN (${Prisma.join(ids)}) ORDER BY "plan_id", "payment_index" FOR UPDATE`);
}

function assertAllPaymentsFound(requestedIds: readonly string[], payments: readonly PaymentLocator[]) {
  if (payments.length !== requestedIds.length) throw new PosSalePaymentPrelockError("Pagamento original não encontrado para pré-lock.");
}

function assertAllPlansFound(requestedIds: readonly string[], plans: readonly PlanLocator[]) {
  if (plans.length !== requestedIds.length) throw new PosSalePaymentPrelockError("Plano autoritativo não encontrado para pré-lock do pagamento.");
}

function assertPaymentBindingsUnchanged(before: readonly PaymentLocator[], after: readonly PaymentLocator[]) {
  const current = new Map(after.map((payment) => [payment.id, payment]));
  if (before.some((payment) => {
    const locked = current.get(payment.id);
    return !locked || locked.paymentPlanId !== payment.paymentPlanId || locked.idempotencyKey !== payment.idempotencyKey
      || locked.saleId !== payment.saleId || locked.processingSessionId !== payment.processingSessionId;
  })) {
    throw new PosSalePaymentPrelockError("O vínculo autoritativo do pagamento mudou durante o pré-lock.");
  }
}

function assertPlanBindingsUnchanged(before: readonly PlanLocator[], after: readonly PlanLocator[]) {
  const current = new Map(after.map((plan) => [plan.id, plan]));
  if (before.length !== after.length || before.some((plan) => {
    const locked = current.get(plan.id);
    return !locked || plan.version !== locked.version || plan.branchId !== locked.branchId || plan.registerId !== locked.registerId
      || plan.sessionId !== locked.sessionId || plan.operatorProfileId !== locked.operatorProfileId
      || plan.terminalId !== locked.terminalId || plan.orderClaimId !== locked.orderClaimId
      || plan.saleDraftId !== locked.saleDraftId;
  })) throw new PosSalePaymentPrelockError("Os bindings autoritativos do plano mudaram durante o pré-lock.");
}

function assertClaimBindingsUnchanged(
  plans: readonly PlanLocator[],
  requestedIds: readonly string[],
  before: readonly ClaimLocator[],
  after: readonly ClaimLocator[],
) {
  const previous = new Map(before.map((claim) => [claim.id, claim]));
  const current = new Map(after.map((claim) => [claim.id, claim]));
  if (before.length !== requestedIds.length || after.length !== requestedIds.length || requestedIds.some((id) => {
    const locator = previous.get(id), locked = current.get(id);
    return !locator || !locked || locator.salesOrderId !== locked.salesOrderId
      || locator.branchId !== locked.branchId || locator.registerId !== locked.registerId
      || locator.sessionId !== locked.sessionId || locator.operatorProfileId !== locked.operatorProfileId
      || locator.terminalId !== locked.terminalId;
  }) || plans.some((plan) => {
    if (!plan.orderClaimId) return false;
    const claim = current.get(plan.orderClaimId);
    return !claim || claim.id !== plan.saleDraftId || claim.branchId !== plan.branchId
      || claim.registerId !== plan.registerId || claim.sessionId !== plan.sessionId
      || claim.operatorProfileId !== plan.operatorProfileId || claim.terminalId !== plan.terminalId;
  })) throw new PosSalePaymentPrelockError("O vínculo claim/pedido do plano mudou durante o pré-lock.");
}

function uniqueStrings(values: readonly string[]) {
  return [...new Set(values)].sort();
}

function uniqueNumbers(values: readonly number[]) {
  return [...new Set(values)].sort((left, right) => left - right);
}

function uniquePairs(values: ReadonlyArray<readonly [number, number]>) {
  return [...new Map(values.map((value) => [`${value[0]}:${value[1]}`, value])).values()]
    .sort((left, right) => left[0] - right[0] || left[1] - right[1]);
}
