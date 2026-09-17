import { Prisma, type PrismaClient } from "@/generated/tenant/client";

export const POS_VALUE_LIABILITY_AGING = Object.freeze({ recentDays: 30, mediumDays: 90, longDays: 365 });
export type PosValueAgingBucket = "age_0_30" | "age_31_90" | "age_91_365" | "age_over_365";

type LiabilityRow = {
  kind: string;
  unit: string;
  status: string;
  aging_bucket: PosValueAgingBucket;
  account_count: bigint;
  balance_units: string;
  reserved_units: string;
  face_value_cents: string;
  reserved_face_value_cents: string;
};

type DueRow = {
  kind: string;
  unit: string;
  item_count: bigint;
  amount_units: string;
  face_value_cents: string;
};

export async function posValueLiabilityReport(db: PrismaClient, branchId: number, asOf = new Date()) {
  if (!Number.isSafeInteger(branchId) || branchId <= 0) throw new Error("Filial do passivo de valores inválida.");
  const now = validDate(asOf), recent = daysBefore(now, POS_VALUE_LIABILITY_AGING.recentDays), medium = daysBefore(now, POS_VALUE_LIABILITY_AGING.mediumDays), long = daysBefore(now, POS_VALUE_LIABILITY_AGING.longDays);
  const [liability, dueReservations, dueAccounts, lastSweep] = await Promise.all([
    db.$queryRaw<LiabilityRow[]>(Prisma.sql`
      SELECT
        a."kind",
        a."unit",
        a."status",
        CASE
          WHEN a."created_at" >= ${recent} THEN 'age_0_30'
          WHEN a."created_at" >= ${medium} THEN 'age_31_90'
          WHEN a."created_at" >= ${long} THEN 'age_91_365'
          ELSE 'age_over_365'
        END AS "aging_bucket",
        COUNT(*)::BIGINT AS "account_count",
        COALESCE(SUM(a."balance_units"), 0)::TEXT AS "balance_units",
        COALESCE(SUM(a."reserved_units"), 0)::TEXT AS "reserved_units",
        COALESCE(SUM(a."balance_units"::NUMERIC * CASE WHEN a."unit" = 'cents' THEN 1 ELSE COALESCE(p."redeem_cents_per_unit", 0) END), 0)::TEXT AS "face_value_cents",
        COALESCE(SUM(a."reserved_units"::NUMERIC * CASE WHEN a."unit" = 'cents' THEN 1 ELSE COALESCE(p."redeem_cents_per_unit", 0) END), 0)::TEXT AS "reserved_face_value_cents"
      FROM "pos_value_accounts" a
      LEFT JOIN "pos_value_programs" p ON p."id" = a."program_id"
      WHERE a."branch_id" = ${branchId}
        AND (a."balance_units" > 0 OR a."reserved_units" > 0)
      GROUP BY a."kind", a."unit", a."status", "aging_bucket"
      ORDER BY a."kind", a."status", "aging_bucket"
    `),
    db.$queryRaw<DueRow[]>(Prisma.sql`
      SELECT
        a."kind",
        a."unit",
        COUNT(*)::BIGINT AS "item_count",
        COALESCE(SUM(r."amount_units"), 0)::TEXT AS "amount_units",
        COALESCE(SUM(r."amount_units"::NUMERIC * CASE WHEN a."unit" = 'cents' THEN 1 ELSE COALESCE(p."redeem_cents_per_unit", 0) END), 0)::TEXT AS "face_value_cents"
      FROM "pos_value_reservations" r
      JOIN "pos_value_accounts" a ON a."id" = r."account_id"
      LEFT JOIN "pos_value_programs" p ON p."id" = a."program_id"
      WHERE r."branch_id" = ${branchId}
        AND r."state" = 'active'
        AND (r."expires_at" <= ${now} OR (a."status" = 'active' AND a."expires_at" <= ${now}))
      GROUP BY a."kind", a."unit"
      ORDER BY a."kind", a."unit"
    `),
    db.$queryRaw<DueRow[]>(Prisma.sql`
      SELECT
        a."kind",
        a."unit",
        COUNT(*)::BIGINT AS "item_count",
        COALESCE(SUM(a."balance_units"), 0)::TEXT AS "amount_units",
        COALESCE(SUM(a."balance_units"::NUMERIC * CASE WHEN a."unit" = 'cents' THEN 1 ELSE COALESCE(p."redeem_cents_per_unit", 0) END), 0)::TEXT AS "face_value_cents"
      FROM "pos_value_accounts" a
      LEFT JOIN "pos_value_programs" p ON p."id" = a."program_id"
      WHERE a."branch_id" = ${branchId}
        AND a."status" = 'active'
        AND a."expires_at" <= ${now}
      GROUP BY a."kind", a."unit"
      ORDER BY a."kind", a."unit"
    `),
    db.tenantAuditEvent.findFirst({ where: { action: "pos.value.lifecycle.sweep" }, select: { createdAt: true, afterData: true }, orderBy: { id: "desc" } }),
  ]);

  const rows = liability.map(row => {
    const balance = integerText(row.balance_units), reserved = integerText(row.reserved_units), faceValue = integerText(row.face_value_cents), reservedFaceValue = integerText(row.reserved_face_value_cents);
    return {
      kind: row.kind,
      unit: row.unit,
      status: row.status,
      aging: row.aging_bucket,
      accountCount: safeCount(row.account_count),
      balanceUnits: balance.toString(),
      reservedUnits: reserved.toString(),
      availableUnits: (balance - reserved).toString(),
      faceValueCents: faceValue.toString(),
      reservedFaceValueCents: reservedFaceValue.toString(),
      availableFaceValueCents: (faceValue - reservedFaceValue).toString(),
    };
  });
  const totals = rows.reduce((result, row) => {
    result.accountCount += row.accountCount;
    result.faceValueCents += BigInt(row.faceValueCents);
    result.reservedFaceValueCents += BigInt(row.reservedFaceValueCents);
    if (row.unit === "points") result.points += BigInt(row.balanceUnits);
    else result.cents += BigInt(row.balanceUnits);
    return result;
  }, { accountCount: 0, points: BigInt(0), cents: BigInt(0), faceValueCents: BigInt(0), reservedFaceValueCents: BigInt(0) });

  return {
    branchId,
    asOf: now,
    agingThresholdDays: POS_VALUE_LIABILITY_AGING,
    totals: {
      accountCount: totals.accountCount,
      points: totals.points.toString(),
      cents: totals.cents.toString(),
      faceValueCents: totals.faceValueCents.toString(),
      reservedFaceValueCents: totals.reservedFaceValueCents.toString(),
      availableFaceValueCents: (totals.faceValueCents - totals.reservedFaceValueCents).toString(),
    },
    rows,
    due: {
      reservations: dueReservations.map(dueDto),
      accounts: dueAccounts.map(dueDto),
      reservationCount: dueReservations.reduce((sum, row) => sum + safeCount(row.item_count), 0),
      accountCount: dueAccounts.reduce((sum, row) => sum + safeCount(row.item_count), 0),
    },
    lastSweep: lastSweep ? { at: lastSweep.createdAt, ...sweepSummary(lastSweep.afterData) } : null,
  };
}

export function classifyPosValueAging(createdAt: Date, asOf: Date): PosValueAgingBucket {
  const created = validDate(createdAt), now = validDate(asOf);
  const ageDays = Math.max(0, Math.floor((now.valueOf() - created.valueOf()) / 86_400_000));
  if (ageDays <= POS_VALUE_LIABILITY_AGING.recentDays) return "age_0_30";
  if (ageDays <= POS_VALUE_LIABILITY_AGING.mediumDays) return "age_31_90";
  if (ageDays <= POS_VALUE_LIABILITY_AGING.longDays) return "age_91_365";
  return "age_over_365";
}

function dueDto(row: DueRow) {
  return { kind: row.kind, unit: row.unit, count: safeCount(row.item_count), amountUnits: integerText(row.amount_units).toString(), faceValueCents: integerText(row.face_value_cents).toString() };
}

function sweepSummary(value: Prisma.JsonValue | null) {
  const record = value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, Prisma.JsonValue> : {};
  return {
    releasedReservations: jsonCount(record.releasedReservations),
    expiredAccounts: jsonCount(record.expiredAccounts),
    remainingDueReservations: jsonCount(record.remainingDueReservations),
    remainingDueAccounts: jsonCount(record.remainingDueAccounts),
    hasMore: record.hasMore === true,
  };
}

function jsonCount(value: Prisma.JsonValue | undefined) {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : 0;
}

function safeCount(value: bigint) {
  if (value < BigInt(0) || value > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error("Contagem do passivo excede o limite seguro.");
  return Number(value);
}

function integerText(value: string) {
  if (typeof value !== "string" || !/^-?\d+$/.test(value)) throw new Error("Agregado do passivo possui formato inválido.");
  return BigInt(value);
}

function daysBefore(value: Date, days: number) {
  return new Date(value.valueOf() - days * 86_400_000);
}

function validDate(value: Date) {
  if (!(value instanceof Date) || Number.isNaN(value.valueOf())) throw new Error("Data do passivo de valores inválida.");
  return new Date(value);
}
