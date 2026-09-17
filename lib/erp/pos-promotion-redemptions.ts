export class PosPromotionRedemptionError extends Error {}

export type ReversiblePosPromotionRedemption = {
  id: bigint;
  couponId: string | null;
  reversedAt: Date | null;
};

export type PosPromotionReversalPlan = {
  redemptionIds: bigint[];
  couponDecrements: ReadonlyArray<{ couponId: string; count: number }>;
};

/** Builds an immutable, deterministic plan and excludes historical reversals. */
export function planPosPromotionReversal(rows: readonly ReversiblePosPromotionRedemption[]): PosPromotionReversalPlan {
  if (!Array.isArray(rows) || rows.length > 10_000) throw new PosPromotionRedemptionError("Quantidade de resgates inválida para reversão.");
  const ids = new Set<string>(), active: ReversiblePosPromotionRedemption[] = [];
  for (const row of rows) {
    if (typeof row.id !== "bigint" || row.id <= BigInt(0)) throw new PosPromotionRedemptionError("Identificador de resgate inválido.");
    const id = row.id.toString();
    if (ids.has(id)) throw new PosPromotionRedemptionError(`Resgate duplicado na reversão: ${id}.`);
    ids.add(id);
    if (row.couponId != null && (typeof row.couponId !== "string" || !row.couponId.trim() || row.couponId.length > 100)) throw new PosPromotionRedemptionError("Cupom do resgate inválido.");
    if (row.reversedAt != null && (!(row.reversedAt instanceof Date) || !Number.isFinite(row.reversedAt.getTime()))) throw new PosPromotionRedemptionError("Data de reversão inválida.");
    if (row.reversedAt == null) active.push(row);
  }
  active.sort((left, right) => left.id < right.id ? -1 : left.id > right.id ? 1 : 0);
  const couponCounts = new Map<string, number>();
  for (const row of active) if (row.couponId) couponCounts.set(row.couponId, (couponCounts.get(row.couponId) ?? 0) + 1);
  return {
    redemptionIds: active.map((row) => row.id),
    couponDecrements: [...couponCounts].sort(([left], [right]) => left.localeCompare(right)).map(([couponId, count]) => ({ couponId, count })),
  };
}

export function posPromotionReversalReason(trigger: "sale_cancel" | "full_return", detail: unknown) {
  if (typeof detail !== "string") throw new PosPromotionRedemptionError("Motivo da reversão promocional inválido.");
  const normalized = detail.trim().replace(/\s+/g, " ");
  if (!normalized || normalized.length > 500) throw new PosPromotionRedemptionError("Motivo da reversão promocional inválido.");
  return `${trigger}:${normalized}`;
}
