import { currentOrganization, tenantDb } from "@/db";
import { Prisma } from "@/generated/tenant/client";
import { AuthError, authErrorResponse } from "@/lib/auth";
import { LicenseDeniedError } from "@/lib/billing/license";
import {
  PAYMENT_EXPORT_LIMIT,
  isSuccessfulPayment,
  parsePaymentCenterQuery,
  paymentCsv,
} from "@/lib/erp/payment-center";
import { assertTenantPermission, matches } from "@/lib/erp/permissions";

type Db = Awaited<ReturnType<typeof tenantDb>>;
const noStore = { "cache-control": "no-store, max-age=0", expires: "0", pragma: "no-cache" };
const successfulStates = ["captured", "manual_confirmed", "paid", "partially_refunded", "refunded"];

export async function GET(request: Request) {
  try {
    const organization = await currentOrganization();
    const access = await assertTenantPermission(organization.id, "payments.read");
    const db = await tenantDb(organization.id);
    const query = parsePaymentCenterQuery(new URL(request.url).searchParams);
    const branch = await selectedBranch(db, access.user.id);
    const from = new Date(Date.now() - query.days * 86_400_000);

    if (new URL(request.url).searchParams.get("format") === "csv") {
      const rows = await transactionRows(db, branch.id, from, query, PAYMENT_EXPORT_LIMIT, 0);
      const csv = paymentCsv(rows.map((row) => ({ ...row, saleNumber: row.sale.saleNumber, customer: row.sale.customer })));
      return new Response(`\uFEFF${csv}`, {
        headers: {
          ...noStore,
          "content-type": "text/csv; charset=utf-8",
          "content-disposition": `attachment; filename="pagamentos-${new Date().toISOString().slice(0, 10)}.csv"`,
          "x-export-limit": String(PAYMENT_EXPORT_LIMIT),
        },
      });
    }

    const basePaymentWhere: Prisma.PosSalePaymentWhereInput = {
      createdAt: { gte: from },
      sale: { branchId: branch.id },
    };
    const intentWhere: Prisma.PosPaymentIntentWhereInput = { branchId: branch.id, createdAt: { gte: from } };
    const compensationWhere: Prisma.PosPaymentCompensationWhereInput = { branchId: branch.id, createdAt: { gte: from } };

    const [
      total,
      rows,
      paymentGroups,
      methodGroups,
      providerGroups,
      intentGroups,
      compensationGroups,
      daily,
      batches,
      reconciliationIssues,
      paymentIncidents,
      compensationIncidents,
      attentionIntents,
      credentials,
      routes,
      settlementTotals,
      legacySummary,
      legacyMethods,
    ] = await Promise.all([
      transactionCount(db, branch.id, from, query),
      transactionRows(db, branch.id, from, query, query.limit, (query.page - 1) * query.limit),
      db.posSalePayment.groupBy({ by: ["type", "status"], where: basePaymentWhere, _count: { _all: true }, _sum: { amountCents: true } }),
      db.posSalePayment.groupBy({ by: ["method"], where: { ...basePaymentWhere, type: "payment", status: { in: successfulStates } }, _count: { _all: true }, _sum: { amountCents: true } }),
      db.posSalePayment.groupBy({ by: ["provider"], where: { ...basePaymentWhere, type: "payment", status: { in: successfulStates } }, _count: { _all: true }, _sum: { amountCents: true } }),
      db.posPaymentIntent.groupBy({ by: ["status"], where: intentWhere, _count: { _all: true }, _sum: { amountCents: true } }),
      db.posPaymentCompensation.groupBy({ by: ["status"], where: compensationWhere, _count: { _all: true }, _sum: { requestedAmountCents: true, confirmedAmountCents: true } }),
      dailyVolume(db, branch.id, from),
      db.posReconciliationBatch.findMany({
        where: { branchId: branch.id, createdAt: { gte: from } },
        include: { layout: { select: { name: true } }, _count: { select: { lines: true, runs: true } } },
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
        take: 12,
      }),
      db.posReconciliationIssue.findMany({
        where: { run: { batch: { branchId: branch.id, createdAt: { gte: from } } } },
        include: { run: { select: { batch: { select: { id: true, provider: true } } } }, line: { select: { transactionId: true, settlementId: true } }, erpPayment: { select: { sale: { select: { saleNumber: true } } } } },
        orderBy: { createdAt: "desc" },
        take: 25,
      }),
      db.posPaymentIntegrityIncident.findMany({
        where: { intent: { branchId: branch.id }, createdAt: { gte: from }, status: "open" },
        select: { id: true, kind: true, status: true, productionBlocking: true, createdAt: true, intent: { select: { id: true, provider: true, amountCents: true } } },
        orderBy: { createdAt: "desc" }, take: 20,
      }),
      db.posPaymentCompensationIncident.findMany({
        where: { compensation: { branchId: branch.id }, createdAt: { gte: from }, status: "open" },
        select: { id: true, kind: true, status: true, productionBlocking: true, createdAt: true, compensation: { select: { id: true, provider: true, requestedAmountCents: true } } },
        orderBy: { createdAt: "desc" }, take: 20,
      }),
      db.posPaymentIntent.findMany({
        where: { ...intentWhere, status: { in: ["created", "processing", "authorized", "unknown", "manual_review", "declined"] } },
        select: { id: true, status: true, amountCents: true, method: true, provider: true, unknownSince: true, nextReconcileAt: true, createdAt: true, register: { select: { name: true } } },
        orderBy: [{ updatedAt: "desc" }, { id: "desc" }], take: 20,
      }),
      db.integrationCredential.findMany({
        where: { revokedAt: null, provider: { family: "payment" } },
        select: { id: true, providerId: true, enabled: true, sandbox: true, expiresAt: true, lastTestOk: true, lastTestAt: true },
      }),
      db.posConnector.findMany({
        where: { branchId: branch.id, type: { startsWith: "payment_" } },
        select: { id: true, status: true, credentialRef: true, lastHealthOk: true, lastCheckedAt: true },
      }),
      db.posReconciliationLine.aggregate({
        where: { batch: { branchId: branch.id, createdAt: { gte: from }, status: "completed" } },
        _sum: { grossCents: true, feeCents: true, netCents: true },
      }),
      db.sale.aggregate({ where: { branchId: branch.id, createdAt: { gte: from }, status: "completed", payments: { none: {} } }, _count: { _all: true }, _sum: { totalCents: true } }),
      db.sale.groupBy({ by: ["paymentMethod"], where: { branchId: branch.id, createdAt: { gte: from }, status: "completed", payments: { none: {} } }, _count: { _all: true }, _sum: { totalCents: true } }),
    ]);

    const transactionIds = rows.map((row) => row.transactionId).filter((value): value is string => Boolean(value));
    const matchedLines = transactionIds.length ? await db.posReconciliationLine.findMany({
      where: { transactionId: { in: transactionIds }, batch: { branchId: branch.id, status: "completed" } },
      select: { transactionId: true, batch: { select: { id: true, provider: true, completedAt: true } }, _count: { select: { issues: true } } },
      orderBy: { createdAt: "desc" },
    }) : [];
    const reconciliationByTransaction = new Map(matchedLines.map((line) => [line.transactionId, line]));

    const legacyGrossCents = legacySummary._sum.totalCents || 0;
    const legacyCount = legacySummary._count._all;
    const grossCents = legacyGrossCents + paymentGroups.filter((item) => item.type === "payment" && isSuccessfulPayment(item.status)).reduce((sum, item) => sum + (item._sum.amountCents || 0), 0);
    const refundCents = paymentGroups.filter((item) => item.type === "refund" && item.status === "refunded").reduce((sum, item) => sum + (item._sum.amountCents || 0), 0);
    const successfulCount = legacyCount + paymentGroups.filter((item) => item.type === "payment" && isSuccessfulPayment(item.status)).reduce((sum, item) => sum + item._count._all, 0);
    const capturedIntents = countGroup(intentGroups, ["captured", "partially_refunded", "refunded"]);
    const declinedIntents = countGroup(intentGroups, ["declined", "cancelled"]);
    const uncertainIntents = countGroup(intentGroups, ["processing", "authorized", "unknown", "manual_review"]);
    const openBlockingIncidents = [...paymentIncidents, ...compensationIncidents].filter((item) => item.productionBlocking).length;
    const staleRoutes = routes.filter((route) => route.status === "active" && (!route.lastCheckedAt || Date.now() - route.lastCheckedAt.getTime() > 86_400_000)).length;
    const activeCredentials = credentials.filter((credential) => credential.enabled && (!credential.expiresAt || credential.expiresAt > new Date()));
    const activeRoutes = routes.filter((route) => route.status === "active" && route.credentialRef);
    const blockers = [
      ...(activeCredentials.length ? [] : ["Nenhuma conta de pagamento ativa"]),
      ...(activeRoutes.length ? [] : ["Nenhuma rota de cobrança ativa"]),
      ...(openBlockingIncidents ? [`${openBlockingIncidents} incidente(s) bloqueante(s)`] : []),
      ...(uncertainIntents ? [`${uncertainIntents} operação(ões) aguardando definição`] : []),
      ...(staleRoutes ? [`${staleRoutes} rota(s) sem verificação nas últimas 24 horas`] : []),
    ];

    return Response.json({
      generatedAt: new Date(),
      branch,
      permissions: { canWrite: matches(access.permissions, "payments.write"), canConfigure: ["owner", "admin"].includes(access.membership.role) },
      filters: {
        methods: [...new Set([...methodGroups.map((item) => item.method), ...legacyMethods.map((item) => normalizedLegacyMethod(item.paymentMethod))])],
        providers: [...new Set([...providerGroups.map((item) => item.provider || "local"), ...(legacyCount ? ["local"] : [])])],
        statuses: [...new Set([...paymentGroups.map((item) => item.status), ...(legacyCount ? ["captured"] : [])])],
      },
      readiness: { state: blockers.length ? "attention" : "ready", blockers, activeCredentials: activeCredentials.length, activeRoutes: activeRoutes.length, staleRoutes, openBlockingIncidents },
      summary: {
        grossCents, refundCents, netCents: grossCents - refundCents,
        successfulCount, averageTicketCents: successfulCount ? Math.round(grossCents / successfulCount) : 0,
        approvalRate: capturedIntents + declinedIntents ? Math.round(capturedIntents / (capturedIntents + declinedIntents) * 10_000) / 100 : null,
        pendingCount: uncertainIntents,
        feesCents: cents(settlementTotals._sum.feeCents),
        settledNetCents: cents(settlementTotals._sum.netCents),
      },
      breakdown: {
        methods: mergeBreakdowns([
          ...methodGroups.map((item) => ({ key: item.method, count: item._count._all, amountCents: item._sum.amountCents || 0 })),
          ...legacyMethods.map((item) => ({ key: normalizedLegacyMethod(item.paymentMethod), count: item._count._all, amountCents: item._sum.totalCents || 0 })),
        ]),
        providers: mergeBreakdowns([
          ...providerGroups.map((item) => ({ key: item.provider || "local", count: item._count._all, amountCents: item._sum.amountCents || 0 })),
          ...(legacyCount ? [{ key: "local", count: legacyCount, amountCents: legacyGrossCents }] : []),
        ]),
        intents: intentGroups.map((item) => ({ key: item.status, count: item._count._all, amountCents: item._sum.amountCents || 0 })),
        compensations: compensationGroups.map((item) => ({ key: item.status, count: item._count._all, requestedCents: item._sum.requestedAmountCents || 0, confirmedCents: item._sum.confirmedAmountCents || 0 })),
        daily,
      },
      transactions: rows.map((row) => {
        const matched = row.transactionId ? reconciliationByTransaction.get(row.transactionId) : null;
        return {
          id: row.id, saleId: row.saleId, saleNumber: row.sale.saleNumber, customer: row.sale.customer,
          cashRegister: row.sale.cashRegister, branchName: row.sale.branch?.name || branch.name,
          type: row.type, method: row.method, status: row.status, amountCents: row.amountCents,
          provider: row.provider || "local", transactionId: row.transactionId, endToEndId: row.endToEndId,
          nsu: row.nsu, authorizationCode: row.authorizationCode, cardBrand: row.cardBrand,
          cardLastFour: row.cardLastFour, installments: row.installments, createdAt: row.createdAt,
          refunds: row._count.refunds, reconciliation: !row.transactionId ? "not_applicable" : matched ? (matched._count.issues ? "issue" : "matched") : row._count.reconciliationIssues ? "issue" : "pending",
          reconciliationBatchId: matched?.batch.id || null,
          connector: row.connector ? { id: row.connector.id, status: row.connector.status, healthy: row.connector.lastHealthOk, lastCheckedAt: row.connector.lastCheckedAt } : null,
        };
      }),
      pagination: { page: query.page, limit: query.limit, total, pages: Math.max(1, Math.ceil(total / query.limit)) },
      operations: attentionIntents,
      reconciliation: {
        batches: batches.map((batch) => ({
          id: batch.id, provider: batch.provider, layout: batch.layout.name, status: batch.status,
          rows: batch.rowCount, matched: batch.matchedCount, issues: batch.issueCount,
          grossCents: cents(batch.grossCents), feeCents: cents(batch.feeCents), netCents: cents(batch.netCents),
          periodStart: batch.periodStart, periodEnd: batch.periodEnd, completedAt: batch.completedAt,
          productionBlocking: batch.productionBlocking, runs: batch._count.runs,
        })),
        issues: reconciliationIssues.map((issue) => ({
          id: issue.id.toString(), code: issue.code, provider: issue.run.batch.provider,
          batchId: issue.run.batch.id, transactionId: issue.line?.transactionId || null,
          settlementId: issue.line?.settlementId || null, saleNumber: issue.erpPayment?.sale.saleNumber || null,
          expectedCents: cents(issue.expectedCents), actualCents: cents(issue.actualCents), createdAt: issue.createdAt,
        })),
      },
      incidents: [
        ...paymentIncidents.map((item) => ({ id: item.id, kind: item.kind, status: item.status, productionBlocking: item.productionBlocking, createdAt: item.createdAt, provider: item.intent.provider, referenceId: item.intent.id, amountCents: item.intent.amountCents, source: "payment" })),
        ...compensationIncidents.map((item) => ({ id: item.id, kind: item.kind, status: item.status, productionBlocking: item.productionBlocking, createdAt: item.createdAt, provider: item.compensation.provider, referenceId: item.compensation.id, amountCents: item.compensation.requestedAmountCents, source: "refund" })),
      ].sort((left, right) => right.createdAt.getTime() - left.createdAt.getTime()).slice(0, 25),
    }, { headers: noStore });
  } catch (error) {
    return failure(error);
  }
}

type ReceiptRow = {
  id: string; sale_id: number; sale_number: string; customer: string; cash_register: string;
  branch_name: string; type: string; method: string; status: string; amount_cents: number;
  provider: string; transaction_id: string | null; end_to_end_id: string | null; nsu: string | null;
  authorization_code: string | null; card_brand: string | null; card_last_four: string | null;
  installments: number; created_at: Date; refunds: bigint; reconciliation_issues: bigint;
  connector_id: string | null; connector_status: string | null; connector_health: boolean | null;
  connector_checked_at: Date | null;
};

async function transactionRows(db: Db, branchId: number, from: Date, query: ReturnType<typeof parsePaymentCenterQuery>, limit: number, offset: number) {
  const rows = await db.$queryRaw<ReceiptRow[]>(Prisma.sql`
    WITH receipts AS (
      SELECT p."id", s."id" AS sale_id, s."sale_number", s."customer", s."cash_register",
        COALESCE(b."name", 'Filial') AS branch_name, p."type", p."method", p."status", p."amount_cents",
        COALESCE(p."provider", 'local') AS provider, p."transaction_id", p."end_to_end_id", p."nsu",
        p."authorization_code", p."card_brand", p."card_last_four", p."installments", p."created_at",
        (SELECT COUNT(*) FROM "pos_sale_payments" refund WHERE refund."original_payment_id" = p."id")::bigint AS refunds,
        (SELECT COUNT(*) FROM "pos_reconciliation_issues" issue WHERE issue."erp_payment_id" = p."id")::bigint AS reconciliation_issues,
        connector."id" AS connector_id, connector."status" AS connector_status,
        connector."last_health_ok" AS connector_health, connector."last_checked_at" AS connector_checked_at
      FROM "pos_sale_payments" p
      JOIN "sales" s ON s."id" = p."sale_id"
      LEFT JOIN "branches" b ON b."id" = s."branch_id"
      LEFT JOIN "pos_connectors" connector ON connector."id" = p."connector_id"
      WHERE s."branch_id" = ${branchId} AND p."created_at" >= ${from}
      UNION ALL
      SELECT 'legacy:' || s."id"::text, s."id", s."sale_number", s."customer", s."cash_register",
        COALESCE(b."name", 'Filial'), 'payment',
        CASE
          WHEN lower(s."payment_method") LIKE '%pix%' THEN 'pix'
          WHEN lower(s."payment_method") LIKE '%crédit%' OR lower(s."payment_method") = 'credit' THEN 'credit'
          WHEN lower(s."payment_method") LIKE '%débit%' OR lower(s."payment_method") = 'debit' THEN 'debit'
          WHEN lower(s."payment_method") LIKE '%dinheiro%' OR lower(s."payment_method") = 'cash' THEN 'cash'
          WHEN lower(s."payment_method") LIKE '%transfer%' THEN 'bank_transfer'
          ELSE lower(replace(s."payment_method", ' ', '_'))
        END,
        'captured', s."total_cents", 'local', NULL::text, NULL::text, NULL::text,
        NULL::text, NULL::text, NULL::text, 1, s."created_at", 0::bigint, 0::bigint,
        NULL::text, NULL::text, NULL::boolean, NULL::timestamp
      FROM "sales" s
      LEFT JOIN "branches" b ON b."id" = s."branch_id"
      WHERE s."branch_id" = ${branchId} AND s."created_at" >= ${from} AND s."status" = 'completed'
        AND NOT EXISTS (SELECT 1 FROM "pos_sale_payments" payment WHERE payment."sale_id" = s."id")
    )
    SELECT * FROM receipts
    WHERE (${query.status} = '' OR status = ${query.status})
      AND (${query.method} = '' OR method = ${query.method})
      AND (${query.provider} = '' OR provider = ${query.provider})
      AND (${query.search} = '' OR concat_ws(' ', id, sale_number, customer, transaction_id, end_to_end_id, nsu, authorization_code, card_last_four) ILIKE ${`%${query.search}%`})
    ORDER BY created_at DESC, id DESC LIMIT ${limit} OFFSET ${offset}
  `);
  return rows.map((row) => ({
    id: row.id, saleId: row.sale_id, type: row.type, method: row.method, status: row.status,
    amountCents: row.amount_cents, provider: row.provider, transactionId: row.transaction_id,
    endToEndId: row.end_to_end_id, nsu: row.nsu, authorizationCode: row.authorization_code,
    cardBrand: row.card_brand, cardLastFour: row.card_last_four, installments: row.installments,
    createdAt: row.created_at,
    sale: { id: row.sale_id, saleNumber: row.sale_number, customer: row.customer, cashRegister: row.cash_register, branch: { name: row.branch_name } },
    connector: row.connector_id ? { id: row.connector_id, status: row.connector_status || "unknown", lastHealthOk: row.connector_health, lastCheckedAt: row.connector_checked_at, settings: null } : null,
    _count: { refunds: Number(row.refunds), reconciliationIssues: Number(row.reconciliation_issues) },
  }));
}

async function transactionCount(db: Db, branchId: number, from: Date, query: ReturnType<typeof parsePaymentCenterQuery>) {
  const [row] = await db.$queryRaw<Array<{ count: bigint }>>(Prisma.sql`
    WITH receipts AS (
      SELECT p."id", s."sale_number", s."customer", p."method", p."status", COALESCE(p."provider", 'local') AS provider,
        p."transaction_id", p."end_to_end_id", p."nsu", p."authorization_code", p."card_last_four"
      FROM "pos_sale_payments" p JOIN "sales" s ON s."id" = p."sale_id"
      WHERE s."branch_id" = ${branchId} AND p."created_at" >= ${from}
      UNION ALL
      SELECT 'legacy:' || s."id"::text, s."sale_number", s."customer",
        CASE WHEN lower(s."payment_method") LIKE '%pix%' THEN 'pix' WHEN lower(s."payment_method") LIKE '%crédit%' OR lower(s."payment_method") = 'credit' THEN 'credit' WHEN lower(s."payment_method") LIKE '%débit%' OR lower(s."payment_method") = 'debit' THEN 'debit' WHEN lower(s."payment_method") LIKE '%dinheiro%' OR lower(s."payment_method") = 'cash' THEN 'cash' WHEN lower(s."payment_method") LIKE '%transfer%' THEN 'bank_transfer' ELSE lower(replace(s."payment_method", ' ', '_')) END,
        'captured', 'local', NULL::text, NULL::text, NULL::text, NULL::text, NULL::text
      FROM "sales" s WHERE s."branch_id" = ${branchId} AND s."created_at" >= ${from} AND s."status" = 'completed'
        AND NOT EXISTS (SELECT 1 FROM "pos_sale_payments" payment WHERE payment."sale_id" = s."id")
    )
    SELECT COUNT(*)::bigint AS count FROM receipts
    WHERE (${query.status} = '' OR status = ${query.status})
      AND (${query.method} = '' OR method = ${query.method})
      AND (${query.provider} = '' OR provider = ${query.provider})
      AND (${query.search} = '' OR concat_ws(' ', id, sale_number, customer, transaction_id, end_to_end_id, nsu, authorization_code, card_last_four) ILIKE ${`%${query.search}%`})
  `);
  return Number(row?.count || 0);
}

async function selectedBranch(db: Db, userId: string) {
  const profile = await db.tenantUserProfile.findUnique({ where: { userId }, select: { activeBranch: { select: { id: true, code: true, name: true, status: true } } } });
  const branch = profile?.activeBranch || await db.branch.findFirst({ where: { status: "active" }, orderBy: [{ primary: "desc" }, { id: "asc" }], select: { id: true, code: true, name: true, status: true } });
  if (!branch) throw new PaymentCenterError("Cadastre e ative uma filial antes de consultar pagamentos.", 409);
  return branch;
}

async function dailyVolume(db: Db, branchId: number, from: Date) {
  const rows = await db.$queryRaw<Array<{ day: Date; gross_cents: bigint; refund_cents: bigint; operations: bigint }>>(Prisma.sql`
    WITH daily AS (
      SELECT date_trunc('day', p."created_at")::date AS day,
        COALESCE(SUM(p."amount_cents") FILTER (WHERE p."type" = 'payment' AND p."status" IN ('captured','manual_confirmed','paid','partially_refunded','refunded')), 0)::bigint AS gross_cents,
        COALESCE(SUM(p."amount_cents") FILTER (WHERE p."type" = 'refund' AND p."status" = 'refunded'), 0)::bigint AS refund_cents,
        COUNT(*) FILTER (WHERE p."type" = 'payment' AND p."status" IN ('captured','manual_confirmed','paid','partially_refunded','refunded'))::bigint AS operations
      FROM "pos_sale_payments" p JOIN "sales" s ON s."id" = p."sale_id"
      WHERE s."branch_id" = ${branchId} AND p."created_at" >= ${from} GROUP BY 1
      UNION ALL
      SELECT date_trunc('day', s."created_at")::date, SUM(s."total_cents")::bigint, 0::bigint, COUNT(*)::bigint
      FROM "sales" s WHERE s."branch_id" = ${branchId} AND s."created_at" >= ${from} AND s."status" = 'completed'
        AND NOT EXISTS (SELECT 1 FROM "pos_sale_payments" payment WHERE payment."sale_id" = s."id") GROUP BY 1
    )
    SELECT day, SUM(gross_cents)::bigint AS gross_cents, SUM(refund_cents)::bigint AS refund_cents,
      SUM(operations)::bigint AS operations FROM daily GROUP BY day ORDER BY day
  `);
  return rows.map((row) => ({ date: row.day.toISOString().slice(0, 10), grossCents: cents(row.gross_cents), refundCents: cents(row.refund_cents), operations: Number(row.operations) }));
}

function countGroup(groups: Array<{ status: string; _count: { _all: number } }>, states: string[]) {
  return groups.filter((group) => states.includes(group.status)).reduce((sum, group) => sum + group._count._all, 0);
}

function normalizedLegacyMethod(value: string) {
  const method = value.normalize("NFKD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
  if (method.includes("pix")) return "pix";
  if (method.includes("credit")) return "credit";
  if (method.includes("debit")) return "debit";
  if (method.includes("dinheiro") || method === "cash") return "cash";
  if (method.includes("transfer")) return "bank_transfer";
  return method.replaceAll(" ", "_");
}

function mergeBreakdowns(items: Array<{ key: string; count: number; amountCents: number }>) {
  const merged = new Map<string, { key: string; count: number; amountCents: number }>();
  for (const item of items) {
    const current = merged.get(item.key) || { key: item.key, count: 0, amountCents: 0 };
    current.count += item.count;
    current.amountCents += item.amountCents;
    merged.set(item.key, current);
  }
  return [...merged.values()].sort((left, right) => right.amountCents - left.amountCents);
}

function cents(value: bigint | number | null | undefined) {
  if (value == null) return 0;
  const result = Number(value);
  return Number.isSafeInteger(result) ? result : 0;
}

class PaymentCenterError extends Error {
  constructor(message: string, readonly status: number) { super(message); }
}

function failure(error: unknown) {
  if (error instanceof PaymentCenterError) return Response.json({ error: error.message }, { status: error.status, headers: noStore });
  if (error instanceof LicenseDeniedError) return Response.json({ error: error.message }, { status: error.status, headers: noStore });
  if (error instanceof AuthError) return authErrorResponse(error);
  console.error("Payment center failed", { error: error instanceof Error ? error.name : typeof error });
  return Response.json({ error: "Não foi possível carregar a central de pagamentos." }, { status: 500, headers: noStore });
}
