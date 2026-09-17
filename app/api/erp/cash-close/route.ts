import type { Prisma } from "@/generated/tenant/client";
import { currentOrganization, tenantDb } from "@/db";
import { AuthError, authErrorResponse } from "@/lib/auth";
import { LicenseDeniedError } from "@/lib/billing/license";
import {
  cashCloseCsv,
  cashCloseRanking,
  CashCloseReportError,
  type CashCloseReportRow,
  cashCloseSummary,
  cashCloseTrend,
  parseCashCloseQuery,
  signedCashMovement,
} from "@/lib/erp/cash-close-report";
import { assertSameOrigin, CustomerInputError } from "@/lib/erp/customer-input";
import { FinancialOperationsInputError } from "@/lib/erp/financial-operations-input";
import { assertTenantPermission } from "@/lib/erp/permissions";
import { assertPosMutationRequest } from "@/lib/erp/pos-http";
import { assertTenantWriteAccess } from "@/lib/tenant-access";

type Db = Awaited<ReturnType<typeof tenantDb>>;
const noStoreHeaders = { "cache-control": "no-store, max-age=0", expires: "0", pragma: "no-cache" };
const unresolvedPaymentStatuses = ["created", "processing", "pending", "unknown", "manual_review"];
const unresolvedIntentStatuses = ["created", "processing", "authorized", "captured", "unknown", "manual_review"];

export async function GET(request: Request) {
  try {
    const organization = await currentOrganization();
    const actor = await assertTenantPermission(organization.id, "cash-close.read");
    const query = parseCashCloseQuery(new URL(request.url).searchParams);
    const db = await tenantDb(organization.id);
    const scope = await cashCloseScope(db, actor.user.id, actor.membership.role, query.branchId);
    const settings = await db.tenantSettings.findUnique({ where: { id: 1 }, select: { posCloseToleranceCents: true } });
    const toleranceCents = settings?.posCloseToleranceCents || 0;
    const where = sessionWhere(query, scope.selectedBranchIds, toleranceCents);
    const orderBy = query.sort === "oldest"
      ? [{ openedAt: "asc" as const }, { id: "asc" as const }]
      : query.sort === "difference_desc"
        ? [{ absoluteDifferenceCents: "desc" as const }, { openedAt: "desc" as const }]
        : [{ openedAt: "desc" as const }, { id: "desc" as const }];

    const [total, reportSessions, sessions, registers, operators] = await Promise.all([
      db.cashRegisterSession.count({ where }),
      db.cashRegisterSession.findMany({ where, select: reportSessionSelect, orderBy }),
      query.format === "csv" ? Promise.resolve([]) : db.cashRegisterSession.findMany({
        where, select: detailSessionSelect, orderBy, skip: (query.page - 1) * query.pageSize, take: query.pageSize,
      }),
      db.posRegister.findMany({ where: { branchId: { in: scope.selectedBranchIds } }, select: { id: true, code: true, name: true, branchId: true, status: true }, orderBy: [{ branchId: "asc" }, { name: "asc" }] }),
      db.tenantUserProfile.findMany({ where: { posCashSessions: { some: { register: { branchId: { in: scope.selectedBranchIds } } } } }, select: { id: true, displayName: true, status: true }, orderBy: { displayName: "asc" } }),
    ]);

    const reportIds = reportSessions.map((session) => session.id);
    const closedIds = reportSessions.filter((session) => ["closed", "reconciled"].includes(session.status)).map((session) => session.id);
    const [saleGroups, eventGroups, tenderGroups] = await Promise.all([
      reportIds.length ? db.sale.groupBy({ by: ["sessionId"], where: { sessionId: { in: reportIds }, status: { in: ["completed", "partially_returned"] } }, _sum: { totalCents: true }, _count: { _all: true } }) : [],
      reportIds.length ? db.cashRegisterEvent.groupBy({ by: ["sessionId", "type"], where: { sessionId: { in: reportIds } }, _sum: { amountCents: true } }) : [],
      closedIds.length ? db.posSessionPaymentCount.groupBy({ by: ["method"], where: { sessionId: { in: closedIds } }, _sum: { expectedCents: true, declaredCents: true, differenceCents: true }, _count: { _all: true } }) : [],
    ]);
    const sales = new Map(saleGroups.map((group) => [group.sessionId, { cents: group._sum.totalCents || 0, count: group._count._all }]));
    const eventTotals = new Map<number, { supplies: number; withdrawals: number }>();
    for (const group of eventGroups) {
      const item = eventTotals.get(group.sessionId) || { supplies: 0, withdrawals: 0 };
      const amount = Math.abs(group._sum.amountCents || 0);
      if (group.type === "supply") item.supplies += amount;
      if (group.type === "withdrawal") item.withdrawals += amount;
      eventTotals.set(group.sessionId, item);
    }
    const rows = reportSessions.map((session) => reportRow(session, sales, eventTotals));
    if (query.format === "csv") {
      return new Response(cashCloseCsv(rows), {
        headers: { ...noStoreHeaders, "content-type": "text/csv; charset=utf-8", "content-disposition": `attachment; filename="fechamentos-${query.from.toISOString().slice(0, 10)}-${query.to.toISOString().slice(0, 10)}.csv"` },
      });
    }

    const pageIds = sessions.map((session) => session.id);
    const blockers = await sessionBlockers(db, pageIds);
    const items = sessions.map((session) => {
      const isClosed = ["closed", "reconciled"].includes(session.status);
      const totals = eventTotals.get(session.id) || { supplies: 0, withdrawals: 0 };
      const sale = sales.get(session.id) || { cents: 0, count: 0 };
      const latestLedger = session.cashLedgerEntries[0];
      return {
        id: session.id, number: session.number, status: session.status, businessDate: session.businessDate,
        registerName: session.registerName, register: session.register, operator: session.operatorProfile, terminal: session.terminal,
        openedBy: session.openedBy, closedBy: session.closedBy, openedAt: session.openedAt, closedAt: session.closedAt,
        suspendedAt: session.suspendedAt, suspendedBy: session.suspendedBy, suspendedReason: session.suspendedReason,
        openingNotes: session.openingNotes, closeNotes: session.closeNotes, openingAmountCents: session.openingAmountCents,
        expectedAmountCents: isClosed ? session.expectedAmountCents : null, closingAmountCents: isClosed ? session.closingAmountCents : null,
        differenceCents: isClosed ? session.differenceCents : null, absoluteDifferenceCents: isClosed ? session.absoluteDifferenceCents : null,
        expectedMasked: !isClosed, salesCents: sale.cents, salesCount: sale.count, suppliesCents: totals.supplies,
        withdrawalsCents: totals.withdrawals, closeApproval: session.closeApproval,
        paymentCounts: isClosed ? session.paymentCounts : [], blockers: blockers.get(session.id) || emptyBlockers(),
        events: session.events.map((event) => ({ id: event.id, type: event.type, amountCents: event.amountCents,
          signedAmountCents: signedCashMovement(event.type, event.amountCents), description: event.description, actor: event.actor,
          approvedBy: event.approvedBy, reasonCode: event.reasonCode, paymentMethod: event.paymentMethod, createdAt: event.createdAt })),
        cashLedger: session.cashLedgerEntries.map((entry) => ({ id: entry.id.toString(), sequence: entry.sequence,
          entryType: entry.entryType, amountCents: entry.amountCents, deltaCents: entry.deltaCents,
          balanceAfterCents: isClosed ? entry.balanceAfterCents : null, referenceType: entry.referenceType,
          reasonCode: entry.reasonCode, description: entry.description, occurredAt: entry.occurredAt })),
        lastLedgerBalanceCents: isClosed && latestLedger ? latestLedger.balanceAfterCents : null,
        custody: session.cashCustodyBags.map((bag) => ({ id: bag.id, sealNumber: bag.sealNumber,
          amountCents: bag.amountCents, sealedAt: bag.sealedAt, state: bag.events[0]?.toState || "sealed",
          incident: bag.incident ? { id: bag.incident.id, differenceCents: bag.incident.differenceCents,
            reasonCode: bag.incident.reasonCode, description: bag.incident.description, openedAt: bag.incident.openedAt,
            resolved: Boolean(bag.incident.resolution) } : null })),
      };
    });
    const summary = cashCloseSummary(rows, toleranceCents);
    return Response.json({
      generatedAt: new Date(), window: { from: query.from, to: query.to },
      filters: { search: query.search, status: query.status, branchId: query.branchId, registerId: query.registerId,
        operatorProfileId: query.operatorProfileId, divergentOnly: query.divergentOnly, sort: query.sort },
      scope: { branches: scope.branches, registers, operators },
      policy: { closeToleranceCents: toleranceCents, blindClose: true, mutationsInPdvOnly: true },
      summary: { ...summary, blockingSessions: items.filter((item) => blockerTotal(item.blockers) > 0).length,
        custodyIncidents: items.reduce((sum, item) => sum + item.custody.filter((bag) => bag.incident && !bag.incident.resolved).length, 0) },
      tenderSummary: tenderGroups.map((group) => ({ method: group.method, sessions: group._count._all,
        expectedCents: group._sum.expectedCents || 0, declaredCents: group._sum.declaredCents || 0,
        differenceCents: group._sum.differenceCents || 0 })),
      trend: cashCloseTrend(rows), ranking: { registers: cashCloseRanking(rows, "register"), operators: cashCloseRanking(rows, "operator") },
      items, pagination: { page: query.page, pageSize: query.pageSize, total, pages: Math.max(1, Math.ceil(total / query.pageSize)) },
    }, { headers: noStoreHeaders });
  } catch (error) { return failure(error); }
}

export async function POST(request: Request) {
  try {
    assertSameOrigin(request);
    assertPosMutationRequest(request);
    const organization = await currentOrganization();
    await assertTenantPermission(organization.id, "cash-close.write");
    await assertTenantWriteAccess(organization.id);
    return Response.json(
      { error: "As mutações do fechamento legado foram desativadas. Use o PDV operacional para abrir turno, sangria, suprimento, passagem e fechamento." },
      { status: 410, headers: noStoreHeaders },
    );
  } catch (error) { return failure(error); }
}

const reportSessionSelect = {
  id: true, status: true, businessDate: true, openedAt: true, closedAt: true, registerId: true, registerName: true,
  operatorProfileId: true, expectedAmountCents: true, closingAmountCents: true, differenceCents: true,
  register: { select: { branchId: true, branch: { select: { name: true } } } },
  operatorProfile: { select: { displayName: true } },
} satisfies Prisma.CashRegisterSessionSelect;

const detailSessionSelect = {
  id: true, number: true, registerName: true, status: true, openingAmountCents: true, expectedAmountCents: true,
  closingAmountCents: true, differenceCents: true, absoluteDifferenceCents: true, openedBy: true, closedBy: true,
  openedAt: true, closedAt: true, businessDate: true, openingNotes: true, closeNotes: true, suspendedAt: true,
  suspendedBy: true, suspendedReason: true,
  register: { select: { id: true, code: true, name: true, status: true, branch: { select: { id: true, code: true, name: true, timezone: true } } } },
  operatorProfile: { select: { id: true, displayName: true, status: true } },
  terminal: { select: { id: true, code: true, name: true, status: true, lastSeenAt: true } },
  closeApproval: { select: { id: true, status: true, requesterName: true, approverName: true, reason: true, decisionReason: true, createdAt: true, decidedAt: true, consumedAt: true } },
  paymentCounts: { select: { id: true, method: true, provider: true, expectedCents: true, declaredCents: true, differenceCents: true, details: true, countedAt: true }, orderBy: [{ method: "asc" as const }, { provider: "asc" as const }] },
  events: { select: { id: true, type: true, amountCents: true, description: true, actor: true, approvedBy: true, reasonCode: true, paymentMethod: true, createdAt: true }, orderBy: { createdAt: "desc" as const }, take: 40 },
  cashLedgerEntries: { select: { id: true, sequence: true, entryType: true, amountCents: true, deltaCents: true, balanceAfterCents: true, referenceType: true, reasonCode: true, description: true, occurredAt: true }, orderBy: { sequence: "desc" as const }, take: 40 },
  cashCustodyBags: { select: { id: true, sealNumber: true, amountCents: true, sealedAt: true,
    events: { select: { toState: true }, orderBy: { sequence: "desc" as const }, take: 1 },
    incident: { select: { id: true, differenceCents: true, reasonCode: true, description: true, openedAt: true,
      resolution: { select: { id: true } } } } }, orderBy: { sealedAt: "desc" as const } },
} satisfies Prisma.CashRegisterSessionSelect;

function sessionWhere(query: ReturnType<typeof parseCashCloseQuery>, branchIds: number[], toleranceCents: number) {
  const filters: Prisma.CashRegisterSessionWhereInput[] = [
    { register: { branchId: { in: branchIds } } }, { businessDate: { gte: query.from, lte: query.to } },
  ];
  if (query.status) filters.push({ status: query.status });
  if (query.registerId) filters.push({ registerId: query.registerId });
  if (query.operatorProfileId) filters.push({ operatorProfileId: query.operatorProfileId });
  if (query.divergentOnly) filters.push({ status: { in: ["closed", "reconciled"] }, absoluteDifferenceCents: { gt: toleranceCents } });
  if (query.search) filters.push({ OR: [
    { number: { contains: query.search, mode: "insensitive" } }, { registerName: { contains: query.search, mode: "insensitive" } },
    { openedBy: { contains: query.search, mode: "insensitive" } }, { closedBy: { contains: query.search, mode: "insensitive" } },
    { operatorProfile: { displayName: { contains: query.search, mode: "insensitive" } } },
  ] });
  return { AND: filters } satisfies Prisma.CashRegisterSessionWhereInput;
}

async function cashCloseScope(db: Db, userId: string, role: string, requestedBranchId: number | null) {
  const privileged = ["owner", "admin"].includes(role);
  const branches = await db.branch.findMany({ select: { id: true, code: true, name: true, status: true, timezone: true }, orderBy: [{ primary: "desc" }, { name: "asc" }] });
  let allowedIds = branches.map((branch) => branch.id);
  if (!privileged) {
    const profile = await db.tenantUserProfile.findUnique({ where: { userId }, select: { activeBranchId: true, branchAccesses: { select: { branchId: true } } } });
    allowedIds = [...new Set([...(profile?.branchAccesses.map((access) => access.branchId) || []), ...(profile?.activeBranchId ? [profile.activeBranchId] : [])])];
  }
  if (!allowedIds.length) throw new CashCloseReportError("Você não possui acesso a uma filial com operação de caixa.", 403);
  if (requestedBranchId && !allowedIds.includes(requestedBranchId)) throw new CashCloseReportError("Você não possui acesso à filial selecionada.", 403);
  const visibleBranches = branches.filter((branch) => allowedIds.includes(branch.id));
  return { branches: visibleBranches, selectedBranchIds: requestedBranchId ? [requestedBranchId] : visibleBranches.map((branch) => branch.id) };
}

function reportRow(session: Prisma.CashRegisterSessionGetPayload<{ select: typeof reportSessionSelect }>, sales: Map<number | null, { cents: number; count: number }>, events: Map<number, { supplies: number; withdrawals: number }>): CashCloseReportRow {
  const sale = sales.get(session.id) || { cents: 0, count: 0 };
  const event = events.get(session.id) || { supplies: 0, withdrawals: 0 };
  return { id: session.id, status: session.status, businessDate: session.businessDate, openedAt: session.openedAt,
    closedAt: session.closedAt, registerId: session.registerId, registerName: session.registerName,
    branchId: session.register?.branchId || null, branchName: session.register?.branch.name || null,
    operatorProfileId: session.operatorProfileId, operatorName: session.operatorProfile?.displayName || "Operador não vinculado",
    salesCents: sale.cents, salesCount: sale.count, suppliesCents: event.supplies, withdrawalsCents: event.withdrawals,
    expectedAmountCents: session.expectedAmountCents, closingAmountCents: session.closingAmountCents,
    differenceCents: session.differenceCents };
}

async function sessionBlockers(db: Db, sessionIds: number[]) {
  if (!sessionIds.length) return new Map<number, ReturnType<typeof emptyBlockers>>();
  const [held, payments, intents, plans, references, claims, incidents] = await Promise.all([
    db.posHeldSale.groupBy({ by: ["sessionId"], where: { sessionId: { in: sessionIds }, status: { in: ["held", "draft"] } }, _count: { _all: true } }),
    db.posSalePayment.groupBy({ by: ["processingSessionId"], where: { processingSessionId: { in: sessionIds }, status: { in: unresolvedPaymentStatuses } }, _count: { _all: true } }),
    db.posPaymentIntent.groupBy({ by: ["sessionId"], where: { sessionId: { in: sessionIds }, consumedAt: null, status: { in: unresolvedIntentStatuses } }, _count: { _all: true } }),
    db.posPaymentPlan.groupBy({ by: ["sessionId"], where: { sessionId: { in: sessionIds }, state: { in: ["quoted", "active"] } }, _count: { _all: true } }),
    db.posManualPaymentReference.groupBy({ by: ["sessionId"], where: { sessionId: { in: sessionIds }, consumedSalePaymentId: null }, _count: { _all: true } }),
    db.posOrderClaim.groupBy({ by: ["sessionId"], where: { sessionId: { in: sessionIds }, state: "active" }, _count: { _all: true } }),
    db.posPaymentIntegrityIncident.findMany({ where: { status: "open", productionBlocking: true, intent: { sessionId: { in: sessionIds } } }, select: { intent: { select: { sessionId: true } } } }),
  ]);
  const result = new Map(sessionIds.map((id) => [id, emptyBlockers()]));
  for (const item of held) result.get(item.sessionId)!.heldSales = item._count._all;
  for (const item of payments) if (item.processingSessionId) result.get(item.processingSessionId)!.payments = item._count._all;
  for (const item of intents) result.get(item.sessionId)!.paymentIntents = item._count._all;
  for (const item of plans) result.get(item.sessionId)!.paymentPlans = item._count._all;
  for (const item of references) result.get(item.sessionId)!.manualReferences = item._count._all;
  for (const item of claims) result.get(item.sessionId)!.orderClaims = item._count._all;
  for (const incident of incidents) result.get(incident.intent.sessionId)!.integrityIncidents += 1;
  return result;
}

function emptyBlockers() { return { heldSales: 0, payments: 0, paymentIntents: 0, paymentPlans: 0, manualReferences: 0, orderClaims: 0, integrityIncidents: 0 }; }
function blockerTotal(value: ReturnType<typeof emptyBlockers>) { return Object.values(value).reduce((sum, count) => sum + count, 0); }

function failure(error: unknown) {
  if (error instanceof CashCloseReportError) return Response.json({ error: error.message }, { status: error.status, headers: noStoreHeaders });
  if (error instanceof FinancialOperationsInputError || error instanceof CustomerInputError)
    return Response.json({ error: error.message }, { status: error.message.includes("Origem") ? 403 : 400, headers: noStoreHeaders });
  if (error instanceof LicenseDeniedError) return Response.json({ error: error.message }, { status: error.status, headers: noStoreHeaders });
  if (error instanceof AuthError) return authErrorResponse(error);
  console.error("Cash close report failed", { error: error instanceof Error ? error.name : typeof error });
  return Response.json({ error: "Não foi possível consultar o fechamento de caixa." }, { status: 500, headers: noStoreHeaders });
}
