import { Prisma } from "@/generated/tenant/client";

type TransactionClient = Prisma.TransactionClient;

type PlanLocator = {
  id: string;
  version: number;
  branchId: number;
  registerId: number;
  sessionId: number;
  operatorProfileId: number;
  terminalId: string;
  saleDraftId: string;
  orderClaimId: string | null;
};

export class PosManualReferencePrelockError extends Error {}

export function posManualReferenceAdvisoryNamespaces(input: {
  plans: readonly Pick<PlanLocator, "id" | "saleDraftId" | "orderClaimId">[];
  claims: readonly { id: string; salesOrderId: number }[];
  referenceIds: readonly string[];
  operationIdempotencyKeys: readonly string[];
  slots: readonly { planId: string; paymentIndex: number }[];
  salePaymentIds: readonly string[];
}) {
  return unique([
    ...input.plans.flatMap(plan => [
      `t2-payment-plan:aggregate:${plan.id}`,
      `t2-payment-plan:draft:${plan.saleDraftId}`,
      `pos-held-sale-items:v1:held-sale:${plan.saleDraftId}`,
      ...(plan.orderClaimId ? [
        `pos-order-claim:v1:claim:${plan.orderClaimId}`,
        `pos-order-claim:v1:artifacts:${plan.orderClaimId}`,
      ] : []),
    ]),
    ...input.claims.map(claim => `pos-order-claim:v1:order:${claim.salesOrderId}`),
    ...input.referenceIds.map(id => `pos-manual-payment-reference:v1:reference:${id}`),
    ...input.operationIdempotencyKeys.map(key => `pos-manual-payment-reference:v1:operation:${key}`),
    ...input.slots.map(slot => `pos-manual-payment-reference:v1:slot:${slot.planId}:${slot.paymentIndex}`),
    ...input.salePaymentIds.map(id => `pos-manual-payment-reference:v1:sale-payment:${id}`),
  ]);
}

/**
 * Canonical graph prelock for manual-reference create/revoke/consume.
 * Locator reads choose namespaces only. Every locator is reread after the
 * canonical row locks and must retain the same complete binding.
 */
export async function prelockPosManualReferenceWrite(tx: TransactionClient, input: {
  planIds?: readonly string[];
  referenceIds?: readonly string[];
  reservedReferenceIds?: readonly string[];
  slotCoordinates?: readonly { planId: string; paymentIndex: number }[];
  reservedSalePaymentIds?: readonly string[];
  operationIdempotencyKeys: readonly string[];
}) {
  const requestedReferenceIds = unique(input.referenceIds ?? []);
  const referenceLocators = requestedReferenceIds.length ? await tx.posManualPaymentReference.findMany({
    where: { id: { in: requestedReferenceIds } },
    select: referenceSelect,
    orderBy: { id: "asc" },
  }) : [];
  assertIds("referência manual", requestedReferenceIds, referenceLocators.map(value => value.id));
  const planIds = unique([
    ...(input.planIds ?? []),
    ...referenceLocators.flatMap(reference => reference.paymentPlanId ? [reference.paymentPlanId] : []),
  ]);
  const planLocators = planIds.length ? await tx.posPaymentPlan.findMany({ where: { id: { in: planIds } }, select: planSelect, orderBy: { id: "asc" } }) : [];
  assertIds("plano", planIds, planLocators.map(value => value.id));
  const claimIds = unique(planLocators.flatMap(plan => plan.orderClaimId ? [plan.orderClaimId] : []));
  const claimLocators = claimIds.length ? await tx.posOrderClaim.findMany({
    where: { id: { in: claimIds } }, select: { id: true, salesOrderId: true }, orderBy: { id: "asc" },
  }) : [];
  assertIds("claim", claimIds, claimLocators.map(value => value.id));

  const referenceIds = unique([...requestedReferenceIds, ...(input.reservedReferenceIds ?? [])]);
  const advisorySlots = uniqueSlots([
    ...referenceLocators.flatMap(reference => reference.paymentPlanId
      ? [{ planId: reference.paymentPlanId, paymentIndex: reference.paymentIndex }]
      : []),
    ...(input.slotCoordinates ?? []),
  ]);
  const salePaymentIds = unique([
    ...referenceLocators.flatMap(reference => reference.consumedSalePaymentId ? [reference.consumedSalePaymentId] : []),
    ...(input.reservedSalePaymentIds ?? []),
  ]);
  for (const namespace of posManualReferenceAdvisoryNamespaces({
    plans: planLocators, claims: claimLocators, referenceIds,
    operationIdempotencyKeys: input.operationIdempotencyKeys,
    slots: advisorySlots, salePaymentIds,
  })) {
    await tx.$executeRaw(Prisma.sql`SELECT pg_advisory_xact_lock(hashtextextended(${namespace}, 0))`);
  }

  // session -> terminal -> access
  await lockNumbers(tx, "cash_register_sessions", planLocators.map(plan => plan.sessionId), "UPDATE");
  await lockStrings(tx, "pos_terminals", planLocators.map(plan => plan.terminalId), "UPDATE");
  await lockNumbers(tx, "tenant_user_profiles", planLocators.map(plan => plan.operatorProfileId), "SHARE");
  await lockNumbers(tx, "branches", planLocators.map(plan => plan.branchId), "SHARE");
  await lockNumbers(tx, "pos_registers", planLocators.map(plan => plan.registerId), "SHARE");
  await lockPairs(tx, "branch_user_accesses", "branch_id", "user_profile_id", planLocators.map(plan => [plan.branchId, plan.operatorProfileId]));
  await lockPairs(tx, "pos_register_accesses", "register_id", "user_profile_id", planLocators.map(plan => [plan.registerId, plan.operatorProfileId]));
  // sales_order -> claim -> held/items
  await lockNumbers(tx, "sales_orders", claimLocators.map(claim => claim.salesOrderId), "UPDATE");
  await lockStrings(tx, "pos_order_claims", claimIds, "UPDATE");
  await lockStrings(tx, "pos_held_sales", planLocators.map(plan => plan.saleDraftId), "UPDATE");
  await lockForeignStrings(tx, "pos_held_sale_items", "held_sale_id", planLocators.map(plan => plan.saleDraftId));

  const slots = planIds.length ? await tx.posPaymentPlanSlot.findMany({
    where: { planId: { in: planIds } },
    select: { planId: true, paymentIndex: true, connectorId: true, credentialRef: true },
    orderBy: [{ planId: "asc" }, { paymentIndex: "asc" }],
  }) : [];
  // connector/credential -> plan/slot -> approval -> reference/sale-payment
  await lockStrings(tx, "pos_connectors", slots.flatMap(slot => slot.connectorId ? [slot.connectorId] : []), "SHARE");
  await lockStrings(tx, "integration_credentials", slots.flatMap(slot => slot.credentialRef ? [slot.credentialRef] : []), "SHARE");
  await lockStrings(tx, "pos_payment_plans", planIds, "UPDATE");
  await lockPlanSlots(tx, slots);
  await lockStrings(tx, "pos_approvals", referenceLocators.map(reference => reference.approvalId), "UPDATE");
  await lockStrings(tx, "pos_manual_payment_references", referenceIds, "UPDATE");
  await lockStrings(tx, "pos_sale_payments", salePaymentIds, "UPDATE");

  const lockedPlans = planIds.length ? await tx.posPaymentPlan.findMany({ where: { id: { in: planIds } }, select: planSelect, orderBy: { id: "asc" } }) : [];
  const lockedClaims = claimIds.length ? await tx.posOrderClaim.findMany({
    where: { id: { in: claimIds } }, select: { id: true, salesOrderId: true }, orderBy: { id: "asc" },
  }) : [];
  const lockedReferences = requestedReferenceIds.length ? await tx.posManualPaymentReference.findMany({ where: { id: { in: requestedReferenceIds } }, select: referenceSelect, orderBy: { id: "asc" } }) : [];
  if (canonical(planLocators) !== canonical(lockedPlans) || canonical(claimLocators) !== canonical(lockedClaims)
    || canonical(referenceLocators) !== canonical(lockedReferences)) {
    throw new PosManualReferencePrelockError("O grafo da referência manual mudou durante o pré-lock.");
  }
  for (const plan of lockedPlans) {
    if (plan.orderClaimId && plan.orderClaimId !== plan.saleDraftId) {
      throw new PosManualReferencePrelockError("O claim do plano deve ser a identidade exata do draft.");
    }
  }
  return { plans: lockedPlans, references: lockedReferences };
}

const planSelect = { id: true, version: true, branchId: true, registerId: true, sessionId: true, operatorProfileId: true, terminalId: true, saleDraftId: true, orderClaimId: true } as const;
const referenceSelect = { id: true, branchId: true, registerId: true, sessionId: true, requesterProfileId: true, saleDraftId: true, paymentPlanId: true, paymentIndex: true, approvalId: true, consumedSalePaymentId: true } as const;

function unique(values: readonly string[]) { return [...new Set(values)].sort(); }
function uniqueNumbers(values: readonly number[]) { return [...new Set(values)].sort((left, right) => left - right); }
function uniqueSlots(values: readonly { planId: string; paymentIndex: number }[]) {
  return [...new Map(values.map(value => [`${value.planId}\0${value.paymentIndex}`, value])).values()]
    .sort((left, right) => left.planId < right.planId ? -1 : left.planId > right.planId ? 1 : left.paymentIndex - right.paymentIndex);
}
function assertIds(kind: string, expected: readonly string[], actual: readonly string[]) {
  if (canonical(unique(expected)) !== canonical(unique(actual))) throw new PosManualReferencePrelockError(`${kind} ausente durante o locator.`);
}
function canonical(value: unknown) { return JSON.stringify(value, Object.keys((Array.isArray(value) ? value[0] : value) ?? {}).sort()); }

async function lockStrings(tx: TransactionClient, table: string, ids: readonly string[], mode: "UPDATE" | "SHARE") {
  for (const id of unique(ids)) await tx.$queryRawUnsafe(`SELECT "id" FROM "${table}" WHERE "id"=$1 FOR ${mode}`, id);
}
async function lockNumbers(tx: TransactionClient, table: string, ids: readonly number[], mode: "UPDATE" | "SHARE") {
  for (const id of uniqueNumbers(ids)) await tx.$queryRawUnsafe(`SELECT "id" FROM "${table}" WHERE "id"=$1 FOR ${mode}`, id);
}
async function lockForeignStrings(tx: TransactionClient, table: string, column: string, ids: readonly string[]) {
  for (const id of unique(ids)) await tx.$queryRawUnsafe(`SELECT "id" FROM "${table}" WHERE "${column}"=$1 ORDER BY "id" FOR UPDATE`, id);
}
async function lockPairs(tx: TransactionClient, table: string, leftColumn: string, rightColumn: string, pairs: readonly (readonly [number, number])[]) {
  const ordered = [...new Map(pairs.map(pair => [`${pair[0]}:${pair[1]}`, pair])).values()].sort((left, right) => left[0] - right[0] || left[1] - right[1]);
  for (const [left, right] of ordered) await tx.$queryRawUnsafe(`SELECT 1 FROM "${table}" WHERE "${leftColumn}"=$1 AND "${rightColumn}"=$2 FOR SHARE`, left, right);
}
async function lockPlanSlots(tx: TransactionClient, slots: readonly { planId: string; paymentIndex: number }[]) {
  for (const slot of [...slots].sort((left, right) => left.planId < right.planId ? -1 : left.planId > right.planId ? 1 : left.paymentIndex - right.paymentIndex)) {
    await tx.$queryRaw(Prisma.sql`SELECT "plan_id" FROM "pos_payment_plan_slots" WHERE "plan_id"=${slot.planId} AND "payment_index"=${slot.paymentIndex} FOR UPDATE`);
  }
}
