import type { Prisma } from "@/generated/tenant/client";
import { currentOrganization, tenantDb } from "@/db";
import { AuthError } from "@/lib/auth";
import { posBusinessDate } from "@/lib/erp/pos-inventory-operations";
import {
  classifyPosCouponCounter,
  classifyPosLot,
  classifyPosPayment,
  classifyPosPrintJob,
  classifyPosPromotionUsage,
  classifyPosSession,
  classifyPosSync,
  classifyPosTerminal,
  parsePosObservabilityQuery,
  posAgeMinutes,
  POS_OBSERVABILITY_DEFAULTS,
  POS_OBSERVABILITY_THRESHOLDS,
  PosObservabilityError,
} from "@/lib/erp/pos-observability";
import { assertTenantPermission } from "@/lib/erp/permissions";

type Db = Awaited<ReturnType<typeof tenantDb>>;

const noStoreHeaders = {
  "cache-control": "no-store, max-age=0",
  expires: "0",
  pragma: "no-cache",
};

export async function GET(request: Request) {
  try {
    const organization = await currentOrganization();
    const actor = await assertTenantPermission(organization.id, "pdv.read");
    if (!["owner", "admin"].includes(actor.membership.role)) throw new PosObservabilityError("Somente proprietários e administradores podem consultar detalhes operacionais do PDV.", 403);
    const query = parsePosObservabilityQuery(new URL(request.url).searchParams);
    const db = await tenantDb(organization.id);
    const branch = await selectedActiveBranch(db, actor.user.id, query.branchId);
    const now = new Date();
    const windowStart = new Date(now.valueOf() - query.windowHours * 60 * 60_000);
    const report = await branchReport(db, branch, now, windowStart, query.limit);
    return Response.json({
      generatedAt: now,
      window: { from: windowStart, to: now, hours: query.windowHours },
      thresholds: POS_OBSERVABILITY_THRESHOLDS,
      limits: { detail: query.limit, diagnosticScan: POS_OBSERVABILITY_DEFAULTS.diagnosticScanLimit },
      branch: { id: branch.id, code: branch.code, name: branch.name, timezone: branch.timezone },
      ...report,
    }, { headers: noStoreHeaders });
  } catch (error) {
    return failure(error);
  }
}

async function branchReport(db: Db, branch: { id: number; timezone: string }, now: Date, windowStart: Date, limit: number) {
  const sessionCutoff = cutoff(now, POS_OBSERVABILITY_THRESHOLDS.sessionStaleMinutes);
  const paymentCutoff = cutoff(now, POS_OBSERVABILITY_THRESHOLDS.paymentPendingMinutes);
  const terminalStaleCutoff = cutoff(now, POS_OBSERVABILITY_THRESHOLDS.terminalStaleMinutes);
  const terminalOfflineCutoff = cutoff(now, POS_OBSERVABILITY_THRESHOLDS.terminalOfflineMinutes);
  const syncCutoff = cutoff(now, POS_OBSERVABILITY_THRESHOLDS.syncProcessingMinutes);
  const businessDate = posBusinessDate(branch.timezone);
  const businessDateValue = new Date(`${businessDate}T00:00:00.000Z`);
  const activeRegister = { branchId: branch.id, status: "active" } as const;
  const operationalTerminal = { register: activeRegister } as const;

  const pendingPaymentWhere = {
    sale: { branchId: branch.id },
    OR: [
      { status: "pending" },
      { status: { in: ["created", "processing"] }, createdAt: { lte: paymentCutoff } },
    ],
  } satisfies Prisma.PosSalePaymentWhereInput;
  const sessionIncidentWhere = {
    register: { branchId: branch.id }, status: { in: ["open", "closing"] }, openedAt: { lte: sessionCutoff },
  } satisfies Prisma.CashRegisterSessionWhereInput;
  const paymentIncidentWhere = {
    sale: { branchId: branch.id },
    OR: [...pendingPaymentWhere.OR!, { status: { in: ["unknown", "manual_review"] } }],
  } satisfies Prisma.PosSalePaymentWhereInput;
  const printIncidentWhere = {
    terminal: operationalTerminal, status: { in: ["queued", "processing", "failed"] },
  } satisfies Prisma.PosPrintJobWhereInput;
  const terminalIncidentWhere = {
    register: activeRegister,
    OR: [
      { status: "revoked" }, { revokedAt: { not: null } }, { status: "offline" },
      { status: { notIn: ["unpaired", "revoked", "offline"] }, revokedAt: null, OR: [{ lastSeenAt: null }, { lastSeenAt: { lte: terminalStaleCutoff } }] },
    ],
  } satisfies Prisma.PosTerminalWhereInput;
  const syncIncidentWhere = {
    terminal: operationalTerminal,
    OR: [
      { state: { in: ["rejected", "conflict"] }, receivedAt: { gte: windowStart } },
      { state: { in: ["received", "processing"] }, receivedAt: { lte: syncCutoff } },
    ],
  } satisfies Prisma.PosSyncOperationWhereInput;
  const lotIncidentWhere = {
    warehouse: { branchId: branch.id }, quantityMicros: { gt: BigInt(0) },
    OR: [{ status: { in: ["quarantine", "expired"] } }, { bucketKey: "quarantine" }, { expiresOn: { lt: businessDateValue } }],
  } satisfies Prisma.PosInventoryLotWhereInput;

  const [
    sessionRows, openStale, closingStale,
    paymentRows, pendingPayments, unknownPayments, manualReviewPayments,
    integrityIncidentRows, openBlockingIntegrityIncidents,
    printRows, queuedPrints, processingPrints, failedPrints, expiredPrintLeases,
    terminalRows, staleTerminals, offlineTerminals, revokedTerminals,
    deviceRows, offlineDevices, errorDevices,
    syncRows, rejectedSync, conflictSync, staleSync,
    lotRows, quarantineLots, expiredLots, uniqueLotSignals,
    recentSessions,
  ] = await Promise.all([
    db.cashRegisterSession.findMany({ where: sessionIncidentWhere, select: { id: true, number: true, registerId: true, operatorProfileId: true, status: true, openedAt: true }, orderBy: [{ openedAt: "asc" }, { id: "asc" }], take: limit }),
    db.cashRegisterSession.count({ where: { ...sessionIncidentWhere, status: "open" } }),
    db.cashRegisterSession.count({ where: { ...sessionIncidentWhere, status: "closing" } }),
    db.posSalePayment.findMany({ where: paymentIncidentWhere, select: { id: true, saleId: true, processingSessionId: true, type: true, method: true, status: true, amountCents: true, createdAt: true }, orderBy: [{ createdAt: "asc" }, { id: "asc" }], take: limit }),
    db.posSalePayment.count({ where: pendingPaymentWhere }),
    db.posSalePayment.count({ where: { sale: { branchId: branch.id }, status: "unknown" } }),
    db.posSalePayment.count({ where: { sale: { branchId: branch.id }, status: "manual_review" } }),
    db.posPaymentIntegrityIncident.findMany({ where: { status: "open", productionBlocking: true, intent: { branchId: branch.id } }, select: { id: true, kind: true, status: true, productionBlocking: true, expectedAmountCents: true, reportedAmountCents: true, expectedCurrency: true, reportedCurrency: true, createdAt: true, intent: { select: { sessionId: true, registerId: true } } }, orderBy: [{ createdAt: "asc" }, { id: "asc" }], take: limit }),
    db.posPaymentIntegrityIncident.count({ where: { status: "open", productionBlocking: true, intent: { branchId: branch.id } } }),
    db.posPrintJob.findMany({ where: printIncidentWhere, select: { id: true, terminalId: true, type: true, referenceType: true, referenceId: true, status: true, attempts: true, claimedAt: true, claimExpiresAt: true, createdAt: true }, orderBy: [{ createdAt: "asc" }, { id: "asc" }], take: limit }),
    db.posPrintJob.count({ where: { terminal: operationalTerminal, status: "queued" } }),
    db.posPrintJob.count({ where: { terminal: operationalTerminal, status: "processing" } }),
    db.posPrintJob.count({ where: { terminal: operationalTerminal, status: "failed" } }),
    db.posPrintJob.count({ where: { terminal: operationalTerminal, status: "processing", claimExpiresAt: { lte: now } } }),
    db.posTerminal.findMany({ where: terminalIncidentWhere, select: { id: true, registerId: true, code: true, name: true, status: true, appVersion: true, lastSeenAt: true, revokedAt: true }, orderBy: [{ lastSeenAt: "asc" }, { id: "asc" }], take: limit }),
    db.posTerminal.count({ where: { register: activeRegister, status: { notIn: ["unpaired", "revoked", "offline"] }, revokedAt: null, lastSeenAt: { gt: terminalOfflineCutoff, lte: terminalStaleCutoff } } }),
    db.posTerminal.count({ where: { register: activeRegister, status: { notIn: ["unpaired", "revoked"] }, revokedAt: null, OR: [{ status: "offline" }, { lastSeenAt: null }, { lastSeenAt: { lte: terminalOfflineCutoff } }] } }),
    db.posTerminal.count({ where: { register: activeRegister, OR: [{ status: "revoked" }, { revokedAt: { not: null } }] } }),
    db.posDevice.findMany({ where: { terminal: { ...operationalTerminal, status: { not: "revoked" } }, status: { in: ["offline", "error"] } }, select: { id: true, terminalId: true, type: true, name: true, status: true, lastSeenAt: true }, orderBy: [{ status: "asc" }, { lastSeenAt: "asc" }, { id: "asc" }], take: limit }),
    db.posDevice.count({ where: { terminal: { ...operationalTerminal, status: { not: "revoked" } }, status: "offline" } }),
    db.posDevice.count({ where: { terminal: { ...operationalTerminal, status: { not: "revoked" } }, status: "error" } }),
    db.posSyncOperation.findMany({ where: syncIncidentWhere, select: { id: true, terminalId: true, operationId: true, sequence: true, type: true, state: true, occurredAt: true, receivedAt: true, processedAt: true }, orderBy: [{ receivedAt: "asc" }, { id: "asc" }], take: limit }),
    db.posSyncOperation.count({ where: { terminal: operationalTerminal, state: "rejected", receivedAt: { gte: windowStart } } }),
    db.posSyncOperation.count({ where: { terminal: operationalTerminal, state: "conflict", receivedAt: { gte: windowStart } } }),
    db.posSyncOperation.count({ where: { terminal: operationalTerminal, state: { in: ["received", "processing"] }, receivedAt: { lte: syncCutoff } } }),
    db.posInventoryLot.findMany({ where: lotIncidentWhere, select: { id: true, warehouseId: true, productId: true, variationId: true, status: true, bucketKey: true, quantityMicros: true, reservedMicros: true, expiresOn: true, receivedAt: true }, orderBy: [{ expiresOn: "asc" }, { receivedAt: "asc" }, { id: "asc" }], take: limit }),
    db.posInventoryLot.count({ where: { warehouse: { branchId: branch.id }, quantityMicros: { gt: BigInt(0) }, OR: [{ status: "quarantine" }, { bucketKey: "quarantine" }] } }),
    db.posInventoryLot.count({ where: { warehouse: { branchId: branch.id }, quantityMicros: { gt: BigInt(0) }, OR: [{ status: "expired" }, { expiresOn: { lt: businessDateValue } }] } }),
    db.posInventoryLot.count({ where: lotIncidentWhere }),
    db.cashRegisterSession.findMany({ where: { register: { branchId: branch.id }, OR: [{ openedAt: { gte: windowStart } }, { closedAt: { gte: windowStart } }] }, select: { id: true, number: true, registerId: true, operatorProfileId: true, status: true, openingAmountCents: true, expectedAmountCents: true, closingAmountCents: true, differenceCents: true, absoluteDifferenceCents: true, openedAt: true, closedAt: true }, orderBy: [{ openedAt: "desc" }, { id: "desc" }], take: limit + 1 }),
  ]);

  const sessionSummary = await recentSessionSummary(db, recentSessions.slice(0, limit));
  const promotionDiagnostics = await promotionCounterDiagnostics(db, branch.id, limit);
  const details = {
    sessions: sessionRows.flatMap(row => {
      const incident = classifyPosSession(row.status, row.openedAt, now);
      return incident ? [{ ...row, incident, ageMinutes: posAgeMinutes(now, row.openedAt), resource: { type: "cash_session", id: String(row.id) } }] : [];
    }),
    payments: paymentRows.flatMap(row => {
      const incident = classifyPosPayment(row.status, row.createdAt, now);
      return incident ? [{ ...row, incident, ageMinutes: posAgeMinutes(now, row.createdAt), resource: { type: row.type === "refund" ? "refund" : "payment", id: row.id } }] : [];
    }),
    paymentIntegrity: integrityIncidentRows.map(row => ({ id: row.id, incident: row.kind, status: row.status, productionBlocking: row.productionBlocking, expectedAmountCents: row.expectedAmountCents, reportedAmountCents: row.reportedAmountCents, expectedCurrency: row.expectedCurrency, reportedCurrency: row.reportedCurrency, sessionId: row.intent.sessionId, registerId: row.intent.registerId, ageMinutes: posAgeMinutes(now, row.createdAt), resource: { type: "payment_integrity_incident", id: row.id } })),
    printJobs: printRows.flatMap(row => {
      const incident = classifyPosPrintJob(row, now);
      return incident ? [{ ...row, incident, ageMinutes: posAgeMinutes(now, row.createdAt), resource: { type: "print_job", id: row.id } }] : [];
    }),
    terminals: terminalRows.flatMap(row => {
      const incident = classifyPosTerminal(row, now);
      return incident ? [{ ...row, incident, ageMinutes: row.lastSeenAt ? posAgeMinutes(now, row.lastSeenAt) : null, resource: { type: "terminal", id: row.id } }] : [];
    }),
    devices: deviceRows.map(row => ({ ...row, incident: row.status, ageMinutes: row.lastSeenAt ? posAgeMinutes(now, row.lastSeenAt) : null, resource: { type: "device", id: row.id } })),
    sync: syncRows.flatMap(row => {
      const incident = classifyPosSync(row, now, windowStart);
      return incident ? [{ ...row, id: row.id.toString(), sequence: row.sequence.toString(), incident, ageMinutes: posAgeMinutes(now, row.receivedAt), resource: { type: "sync_operation", id: row.id.toString() } }] : [];
    }),
    lots: lotRows.map(row => ({ ...row, quantityMicros: row.quantityMicros.toString(), reservedMicros: row.reservedMicros.toString(), incidents: classifyPosLot(row, businessDateValue), resource: { type: "inventory_lot", id: row.id } })),
    promotions: promotionDiagnostics.details,
  };
  const summary = {
    sessions: { openStale, closingStale },
    payments: { pending: pendingPayments, unknown: unknownPayments, manualReview: manualReviewPayments },
    paymentIntegrity: { openProductionBlocking: openBlockingIntegrityIncidents },
    printJobs: { queued: queuedPrints, processing: processingPrints, failed: failedPrints, expiredLeases: expiredPrintLeases },
    terminals: { stale: staleTerminals, offline: offlineTerminals, revoked: revokedTerminals },
    devices: { offline: offlineDevices, error: errorDevices },
    offlineSync: { rejected: rejectedSync, conflict: conflictSync, processingStale: staleSync },
    inventoryLots: { quarantineWithBalance: quarantineLots, expiredWithBalance: expiredLots },
    promotions: promotionDiagnostics.summary,
  };
  return {
    businessDate,
    summary,
    details,
    recentSessions: sessionSummary,
    truncated: {
      sessions: openStale + closingStale > details.sessions.length,
      payments: pendingPayments + unknownPayments + manualReviewPayments > details.payments.length,
      paymentIntegrity: openBlockingIntegrityIncidents > details.paymentIntegrity.length,
      printJobs: queuedPrints + processingPrints + failedPrints > details.printJobs.length,
      terminals: staleTerminals + offlineTerminals + revokedTerminals > details.terminals.length,
      devices: offlineDevices + errorDevices > details.devices.length,
      sync: rejectedSync + conflictSync + staleSync > details.sync.length,
      lots: uniqueLotSignals > details.lots.length,
      recentSessions: recentSessions.length > limit,
      promotions: promotionDiagnostics.truncated,
    },
  };
}

async function recentSessionSummary(db: Db, sessions: Array<{ id: number; number: string; registerId: number | null; operatorProfileId: number | null; status: string; openingAmountCents: number; expectedAmountCents: number | null; closingAmountCents: number | null; differenceCents: number | null; absoluteDifferenceCents: number | null; openedAt: Date; closedAt: Date | null }>) {
  const ids = sessions.map(item => item.id);
  if (!ids.length) return [];
  const [sales, payments, events] = await Promise.all([
    db.sale.groupBy({ by: ["sessionId", "status"], where: { sessionId: { in: ids } }, _count: { _all: true }, _sum: { totalCents: true }, orderBy: [{ sessionId: "asc" }, { status: "asc" }] }),
    db.posSalePayment.groupBy({ by: ["processingSessionId", "type", "method", "status"], where: { processingSessionId: { in: ids } }, _count: { _all: true }, _sum: { amountCents: true }, orderBy: [{ processingSessionId: "asc" }, { type: "asc" }, { method: "asc" }, { status: "asc" }] }),
    db.cashRegisterEvent.groupBy({ by: ["sessionId", "type"], where: { sessionId: { in: ids }, type: { in: ["supply", "withdrawal"] } }, _count: { _all: true }, _sum: { amountCents: true }, orderBy: [{ sessionId: "asc" }, { type: "asc" }] }),
  ]);
  return sessions.map(session => {
    const sessionSales = sales.filter(item => item.sessionId === session.id);
    return {
      ...session,
      resource: { type: "cash_session", id: String(session.id) },
      sales: {
        count: sessionSales.reduce((sum, item) => sum + item._count._all, 0),
        amountCents: sessionSales.reduce((sum, item) => sum + (item._sum.totalCents || 0), 0),
        byStatus: sessionSales.map(item => ({ status: item.status, count: item._count._all, amountCents: item._sum.totalCents || 0 })),
      },
      payments: payments.filter(item => item.processingSessionId === session.id).map(item => ({ type: item.type, method: item.method, status: item.status, count: item._count._all, amountCents: item._sum.amountCents || 0 })),
      cashEvents: events.filter(item => item.sessionId === session.id).map(item => ({ type: item.type, count: item._count._all, amountCents: item._sum.amountCents || 0 })),
    };
  });
}

async function promotionCounterDiagnostics(db: Db, branchId: number, limit: number) {
  const scanLimit = POS_OBSERVABILITY_DEFAULTS.diagnosticScanLimit;
  const promotions = await db.posPromotion.findMany({
    where: { OR: [{ branchId: null }, { branchId }] },
    select: { id: true, branchId: true, status: true, usageLimit: true, perCustomerLimit: true, _count: { select: { redemptions: { where: { reversedAt: null } } } } },
    orderBy: { id: "asc" }, take: scanLimit + 1,
  });
  const selectedPromotions = promotions.slice(0, scanLimit);
  const promotionIds = selectedPromotions.map(item => item.id);
  const coupons = promotionIds.length ? await db.posCoupon.findMany({
    where: { promotionId: { in: promotionIds } },
    select: { id: true, promotionId: true, status: true, usageLimit: true, usedCount: true, _count: { select: { redemptions: { where: { reversedAt: null } } } } },
    orderBy: { id: "asc" }, take: scanLimit + 1,
  }) : [];
  const limitedPromotions = new Map(selectedPromotions.filter(item => item.perCustomerLimit != null).map(item => [item.id, item.perCustomerLimit!]));
  const customerGroups = limitedPromotions.size ? await db.posPromotionRedemption.groupBy({
    by: ["promotionId", "customerId"],
    where: { promotionId: { in: [...limitedPromotions.keys()] }, customerId: { not: null }, reversedAt: null },
    _count: { _all: true }, orderBy: [{ promotionId: "asc" }, { customerId: "asc" }], take: scanLimit + 1,
  }) : [];
  const exceededByPromotion = new Map<string, number>();
  for (const group of customerGroups.slice(0, scanLimit)) {
    const maximum = limitedPromotions.get(group.promotionId);
    if (maximum != null && group._count._all > maximum) exceededByPromotion.set(group.promotionId, (exceededByPromotion.get(group.promotionId) || 0) + 1);
  }
  const promotionDetails = selectedPromotions.flatMap(item => {
    const activeRedemptions = item._count.redemptions;
    const incidents = classifyPosPromotionUsage({ activeRedemptions, usageLimit: item.usageLimit, exceededCustomerGroups: exceededByPromotion.get(item.id) });
    return incidents.length ? [{ kind: "promotion" as const, id: item.id, branchId: item.branchId, status: item.status, usageLimit: item.usageLimit, perCustomerLimit: item.perCustomerLimit, activeRedemptions, exceededCustomerGroups: exceededByPromotion.get(item.id) || 0, incidents, resource: { type: "promotion", id: item.id } }] : [];
  });
  const couponDetails = coupons.slice(0, scanLimit).flatMap(item => {
    const activeRedemptions = item._count.redemptions;
    const incidents = classifyPosCouponCounter({ usedCount: item.usedCount, activeRedemptions, usageLimit: item.usageLimit });
    return incidents.length ? [{ kind: "coupon" as const, id: item.id, promotionId: item.promotionId, status: item.status, usageLimit: item.usageLimit, usedCount: item.usedCount, activeRedemptions, incidents, resource: { type: "coupon", id: item.id } }] : [];
  });
  const all = [...promotionDetails, ...couponDetails];
  return {
    summary: {
      counterMismatch: couponDetails.filter(item => item.incidents.includes("counter_mismatch")).length,
      limitExceeded: all.filter(item => item.incidents.includes("limit_exceeded")).length,
      perCustomerLimitExceeded: promotionDetails.filter(item => item.incidents.includes("per_customer_limit_exceeded")).length,
    },
    details: all.slice(0, limit),
    truncated: promotions.length > scanLimit || coupons.length > scanLimit || customerGroups.length > scanLimit || all.length > limit,
  };
}

async function selectedActiveBranch(db: Db, actorId: string, branchId: number | null) {
  const select = { id: true, code: true, name: true, timezone: true } as const;
  if (branchId) {
    // Owner/admin is tenant-wide by design. tenantDb already isolates the organization;
    // BranchUserAccess is an operator scope and must not hide another branch from incident response.
    const branch = await db.branch.findFirst({ where: { id: branchId, status: "active" }, select });
    if (!branch) throw new PosObservabilityError("Filial ativa não encontrada.", 404);
    return branch;
  }
  const profile = await db.tenantUserProfile.findUnique({ where: { userId: actorId }, select: { activeBranch: { select: { ...select, status: true } } } });
  if (profile?.activeBranch?.status === "active") return profile.activeBranch;
  const branch = await db.branch.findFirst({ where: { status: "active" }, select, orderBy: [{ primary: "desc" }, { id: "asc" }] });
  if (!branch) throw new PosObservabilityError("Cadastre uma filial ativa antes de consultar a operação do PDV.", 409);
  return branch;
}

function cutoff(now: Date, minutes: number) {
  return new Date(now.valueOf() - minutes * 60_000);
}

function failure(error: unknown) {
  if (error instanceof PosObservabilityError) return Response.json({ error: error.message }, { status: error.status, headers: noStoreHeaders });
  if (error instanceof AuthError) return Response.json({ error: error.message }, { status: error.status, headers: noStoreHeaders });
  console.error("POS observability failed", { error: error instanceof Error ? error.name : typeof error });
  return Response.json({ error: "Não foi possível consultar a observabilidade do PDV." }, { status: 500, headers: noStoreHeaders });
}
