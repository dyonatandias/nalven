import { createHash } from "node:crypto";

export class PosPromotionDomainError extends Error {}

const MAX_CENTS = 2_147_483_647;
const QUANTITY_SCALE = 1_000_000;

export type PosPromotionConditions = {
  productIds?: readonly number[];
  categoryIds?: readonly number[];
  minimumQuantity?: number;
  couponRequired?: boolean;
};

export type PosPromotionEffect =
  | { type: "percentage"; percentageBasisPoints: number; maximumDiscountCents?: number | null }
  | { type: "fixed"; discountCents: number };

export type PosPromotionRecord = {
  id: string;
  name: string;
  priority: number;
  status: string;
  stackMode: string;
  branchId: number | null;
  conditions: unknown;
  effects: unknown;
  startsAt: Date;
  endsAt: Date | null;
  usageLimit: number | null;
  perCustomerLimit: number | null;
};

export type PosPromotionRule = Omit<PosPromotionRecord, "conditions" | "effects"> & {
  conditions: PosPromotionConditions;
  effect: PosPromotionEffect;
};

export type PosPromotionCartLine = {
  lineId: string;
  productId: number;
  categoryId: number | null;
  categoryIds?: readonly number[];
  quantity: number;
  subtotalCents: number;
};

export type PosPromotionUsageSnapshot = {
  totalUsed: number;
  customerUsed?: number;
  /** Live T2 reservations are additive to redemptions and never replace used counters. */
  totalReserved?: number;
  customerReserved?: number;
};

export type PosCouponSnapshot = {
  id: string;
  promotionId: string;
  status: string;
  usageLimit: number | null;
  usedCount: number;
  /** Live T2 reservations for this coupon at the authoritative evaluation instant. */
  liveReserved?: number;
  expiresAt: Date | null;
};

export type PosPromotionRejection =
  | "inactive"
  | "not_started"
  | "expired"
  | "branch_mismatch"
  | "no_eligible_items"
  | "minimum_quantity_not_met"
  | "usage_snapshot_missing"
  | "usage_limit_reached"
  | "customer_required"
  | "customer_usage_missing"
  | "customer_limit_reached"
  | "coupon_required"
  | "coupon_mismatch"
  | "coupon_inactive"
  | "coupon_expired"
  | "coupon_limit_reached"
  | "no_discount";

export type PosPromotionAllocation = {
  lineId: string;
  discountCents: number;
};

export type PosPromotionEvaluation = {
  promotionId: string;
  couponId: string | null;
  eligible: boolean;
  rejectionReasons: readonly PosPromotionRejection[];
  eligibleQuantity: number;
  eligibleSubtotalCents: number;
  discountCents: number;
  allocations: readonly PosPromotionAllocation[];
};

export type PosPromotionAward = {
  promotionId: string;
  promotionName: string;
  couponId: string | null;
  priority: number;
  discountCents: number;
  eligibleSubtotalCents: number;
  allocations: readonly PosPromotionAllocation[];
  snapshot: {
    evaluatedAt: string;
    branchId: number;
    customerId: number | null;
    effect: PosPromotionEffect;
    conditions: PosPromotionConditions;
  };
};

export type EvaluatePosPromotionsInput = {
  now: Date;
  branchId: number;
  customerId: number | null;
  lines: readonly PosPromotionCartLine[];
  promotions: readonly PosPromotionRule[];
  usageByPromotionId?: Readonly<Record<string, PosPromotionUsageSnapshot | undefined>>;
  coupon?: PosCouponSnapshot | null;
};

/**
 * Validates the JSON-backed condition/effect fields from PosPromotion and creates
 * the typed, immutable input expected by the evaluator.
 */
export function buildPosPromotionRule(record: PosPromotionRecord): PosPromotionRule {
  const id = requiredText(record.id, "Identificador da promoção");
  const name = requiredText(record.name, "Nome da promoção");
  const priority = safeInteger(record.priority, "Prioridade", { allowNegative: true });
  const branchId = record.branchId == null ? null : positiveInteger(record.branchId, "Filial da promoção");
  const startsAt = validDate(record.startsAt, "Início da promoção");
  const endsAt = record.endsAt == null ? null : validDate(record.endsAt, "Término da promoção");
  if (endsAt && endsAt.getTime() <= startsAt.getTime()) {
    throw new PosPromotionDomainError("O término da promoção deve ser posterior ao início.");
  }
  if (record.stackMode !== "exclusive") {
    throw new PosPromotionDomainError("Somente promoções exclusivas são suportadas pelo seletor de melhor oferta.");
  }

  return {
    id,
    name,
    priority,
    status: requiredText(record.status, "Status da promoção"),
    stackMode: "exclusive",
    branchId,
    startsAt,
    endsAt,
    usageLimit: nullableNonNegativeInteger(record.usageLimit, "Limite global de uso"),
    perCustomerLimit: nullableNonNegativeInteger(record.perCustomerLimit, "Limite de uso por cliente"),
    conditions: parseConditions(record.conditions),
    effect: parseEffect(record.effects),
  };
}

export function normalizePosCouponCode(value: unknown) {
  if (typeof value !== "string") throw new PosPromotionDomainError("Cupom inválido.");
  const normalized = value.normalize("NFKC").trim().toUpperCase();
  if (normalized.length < 4 || normalized.length > 64 || !/^[\p{L}\p{N}][\p{L}\p{N}_-]+$/u.test(normalized)) throw new PosPromotionDomainError("Cupom inválido.");
  return normalized;
}

export function hashPosCouponCode(value: unknown) {
  return `sha256:${createHash("sha256").update(normalizePosCouponCode(value), "utf8").digest("hex")}`;
}

/**
 * Evaluates exclusive promotions and selects exactly one offer. Ties are broken
 * by higher priority and then by the lexicographically smaller promotion id.
 */
export function evaluatePosPromotions(input: EvaluatePosPromotionsInput) {
  const now = validDate(input.now, "Data da avaliação");
  const branchId = positiveInteger(input.branchId, "Filial da avaliação");
  const customerId = input.customerId == null ? null : positiveInteger(input.customerId, "Cliente da avaliação");
  const lines = validateLines(input.lines);
  const coupon = input.coupon == null ? null : validateCoupon(input.coupon);
  const ids = new Set<string>();

  const evaluated = input.promotions.map((promotion) => {
    const normalizedPromotion = normalizeTypedRule(promotion);
    if (ids.has(normalizedPromotion.id)) throw new PosPromotionDomainError(`Promoção duplicada na avaliação: ${normalizedPromotion.id}.`);
    ids.add(normalizedPromotion.id);
    return evaluateRule({
      promotion: normalizedPromotion,
      now,
      branchId,
      customerId,
      lines,
      usage: ownUsage(input.usageByPromotionId, normalizedPromotion.id),
      coupon,
    });
  });

  const eligible = evaluated.filter((entry) => entry.evaluation.eligible);
  eligible.sort((left, right) =>
    compareNumberDescending(left.evaluation.discountCents, right.evaluation.discountCents)
    || compareNumberDescending(left.promotion.priority, right.promotion.priority)
    || compareText(left.promotion.id, right.promotion.id));
  const winner = eligible[0];

  return {
    evaluations: evaluated.map((entry) => entry.evaluation),
    award: winner ? {
      promotionId: winner.promotion.id,
      promotionName: winner.promotion.name,
      couponId: winner.evaluation.couponId,
      priority: winner.promotion.priority,
      discountCents: winner.evaluation.discountCents,
      eligibleSubtotalCents: winner.evaluation.eligibleSubtotalCents,
      allocations: winner.evaluation.allocations,
      snapshot: {
        evaluatedAt: now.toISOString(),
        branchId,
        customerId,
        effect: winner.promotion.effect,
        conditions: winner.promotion.conditions,
      },
    } satisfies PosPromotionAward : null,
  };
}

function evaluateRule(input: {
  promotion: PosPromotionRule;
  now: Date;
  branchId: number;
  customerId: number | null;
  lines: readonly ValidatedLine[];
  usage: PosPromotionUsageSnapshot | undefined;
  coupon: PosCouponSnapshot | null;
}) {
  const { promotion, now, branchId, customerId, lines, coupon } = input;
  const reasons: PosPromotionRejection[] = [];
  if (promotion.status !== "active") reasons.push("inactive");
  if (now.getTime() < promotion.startsAt.getTime()) reasons.push("not_started");
  if (promotion.endsAt && now.getTime() >= promotion.endsAt.getTime()) reasons.push("expired");
  if (promotion.branchId != null && promotion.branchId !== branchId) reasons.push("branch_mismatch");

  const eligibleLines = lines.filter((line) => lineMatches(line, promotion.conditions));
  const eligibleQuantityMicros = eligibleLines.reduce((sum, line) => sum + line.quantityMicros, BigInt(0));
  const eligibleQuantity = Number(eligibleQuantityMicros) / QUANTITY_SCALE;
  const eligibleSubtotalCents = boundedSum(eligibleLines.map((line) => line.subtotalCents), "Subtotal elegível");
  if (!eligibleLines.length) reasons.push("no_eligible_items");
  if (promotion.conditions.minimumQuantity != null) {
    const minimum = quantityMicros(promotion.conditions.minimumQuantity, "Quantidade mínima");
    if (eligibleQuantityMicros < minimum) reasons.push("minimum_quantity_not_met");
  }

  if (promotion.usageLimit != null) {
    if (!input.usage) reasons.push("usage_snapshot_missing");
    else {
      const used = nonNegativeInteger(input.usage.totalUsed, "Uso global da promoção")
        + nonNegativeInteger(input.usage.totalReserved ?? 0, "Reserva global ativa da promoção");
      if (!Number.isSafeInteger(used)) throw new PosPromotionDomainError("Uso global da promoção excedeu o limite seguro.");
      if (used >= promotion.usageLimit) reasons.push("usage_limit_reached");
    }
  }
  if (promotion.perCustomerLimit != null) {
    if (customerId == null) reasons.push("customer_required");
    else if (!input.usage || input.usage.customerUsed == null) reasons.push("customer_usage_missing");
    else {
      const customerUsed = nonNegativeInteger(input.usage.customerUsed, "Uso da promoção pelo cliente")
        + nonNegativeInteger(input.usage.customerReserved ?? 0, "Reserva ativa da promoção pelo cliente");
      if (!Number.isSafeInteger(customerUsed)) throw new PosPromotionDomainError("Uso da promoção pelo cliente excedeu o limite seguro.");
      if (customerUsed >= promotion.perCustomerLimit) reasons.push("customer_limit_reached");
    }
  }

  let couponId: string | null = null;
  if (promotion.conditions.couponRequired) {
    if (!coupon) reasons.push("coupon_required");
    else if (coupon.promotionId !== promotion.id) reasons.push("coupon_mismatch");
    else {
      couponId = coupon.id;
      if (coupon.status !== "active") reasons.push("coupon_inactive");
      if (coupon.expiresAt && now.getTime() >= coupon.expiresAt.getTime()) reasons.push("coupon_expired");
      const couponUsed = coupon.usedCount + (coupon.liveReserved ?? 0);
      if (!Number.isSafeInteger(couponUsed)) throw new PosPromotionDomainError("Uso do cupom excedeu o limite seguro.");
      if (coupon.usageLimit != null && couponUsed >= coupon.usageLimit) reasons.push("coupon_limit_reached");
    }
  }

  const discountCents = eligibleSubtotalCents > 0 ? calculateDiscount(promotion.effect, eligibleSubtotalCents) : 0;
  if (discountCents === 0) reasons.push("no_discount");
  const eligible = reasons.length === 0;
  const allocations = eligible ? allocateDiscount(eligibleLines, discountCents, eligibleSubtotalCents) : [];
  const evaluation: PosPromotionEvaluation = {
    promotionId: promotion.id,
    couponId,
    eligible,
    rejectionReasons: reasons,
    eligibleQuantity,
    eligibleSubtotalCents,
    discountCents: eligible ? discountCents : 0,
    allocations,
  };
  return { promotion, evaluation };
}

type ValidatedLine = PosPromotionCartLine & { quantityMicros: bigint };

function validateLines(lines: readonly PosPromotionCartLine[]): readonly ValidatedLine[] {
  if (!Array.isArray(lines) || lines.length === 0) throw new PosPromotionDomainError("Informe ao menos um item para avaliar promoções.");
  if (lines.length > 10_000) throw new PosPromotionDomainError("Quantidade de itens excede o limite da avaliação.");
  const ids = new Set<string>();
  const normalized = lines.map((line) => {
    const lineId = requiredText(line.lineId, "Identificador do item");
    if (ids.has(lineId)) throw new PosPromotionDomainError(`Item duplicado na avaliação: ${lineId}.`);
    ids.add(lineId);
    return {
      lineId,
      productId: positiveInteger(line.productId, "Produto do item"),
      categoryId: line.categoryId == null ? null : positiveInteger(line.categoryId, "Categoria do item"),
      categoryIds: line.categoryIds == null ? undefined : positiveIntegerList(line.categoryIds, "Categorias do item"),
      quantity: line.quantity,
      quantityMicros: quantityMicros(line.quantity, "Quantidade do item"),
      subtotalCents: nonNegativeCents(line.subtotalCents, "Subtotal do item"),
    };
  });
  const totalQuantity = normalized.reduce((sum, line) => sum + line.quantityMicros, BigInt(0));
  if (totalQuantity > BigInt(Number.MAX_SAFE_INTEGER)) throw new PosPromotionDomainError("Quantidade total excede o limite da avaliação.");
  boundedSum(normalized.map((line) => line.subtotalCents), "Subtotal do carrinho");
  return normalized;
}

function normalizeTypedRule(rule: PosPromotionRule) {
  // Reuse the JSON boundary validator so callers cannot bypass domain invariants
  // merely by asserting a database record as PosPromotionRule.
  return buildPosPromotionRule({
    ...rule,
    conditions: rule.conditions,
    effects: rule.effect,
  });
}

function validateCoupon(coupon: PosCouponSnapshot): PosCouponSnapshot {
  return {
    id: requiredText(coupon.id, "Identificador do cupom"),
    promotionId: requiredText(coupon.promotionId, "Promoção do cupom"),
    status: requiredText(coupon.status, "Status do cupom"),
    usageLimit: nullableNonNegativeInteger(coupon.usageLimit, "Limite de uso do cupom"),
    usedCount: nonNegativeInteger(coupon.usedCount, "Uso do cupom"),
    liveReserved: nonNegativeInteger(coupon.liveReserved ?? 0, "Reserva ativa do cupom"),
    expiresAt: coupon.expiresAt == null ? null : validDate(coupon.expiresAt, "Expiração do cupom"),
  };
}

function lineMatches(line: ValidatedLine, conditions: PosPromotionConditions) {
  if (conditions.productIds && !conditions.productIds.includes(line.productId)) return false;
  const lineCategories = line.categoryIds?.length ? line.categoryIds : line.categoryId == null ? [] : [line.categoryId];
  if (conditions.categoryIds && !conditions.categoryIds.some((categoryId) => lineCategories.includes(categoryId))) return false;
  return true;
}

function calculateDiscount(effect: PosPromotionEffect, subtotalCents: number) {
  if (effect.type === "fixed") return Math.min(effect.discountCents, subtotalCents);
  const calculated = Number((BigInt(subtotalCents) * BigInt(effect.percentageBasisPoints)) / BigInt(10_000));
  const capped = effect.maximumDiscountCents == null ? calculated : Math.min(calculated, effect.maximumDiscountCents);
  return Math.min(capped, subtotalCents);
}

function allocateDiscount(lines: readonly ValidatedLine[], discountCents: number, subtotalCents: number) {
  if (discountCents <= 0) return [];
  const total = BigInt(subtotalCents);
  const discount = BigInt(discountCents);
  const shares = lines.map((line) => {
    const numerator = BigInt(line.subtotalCents) * discount;
    return { lineId: line.lineId, cents: Number(numerator / total), remainder: numerator % total };
  });
  let missing = discountCents - shares.reduce((sum, share) => sum + share.cents, 0);
  const ranked = [...shares].sort((left, right) => {
    if (left.remainder !== right.remainder) return left.remainder > right.remainder ? -1 : 1;
    return compareText(left.lineId, right.lineId);
  });
  for (let index = 0; index < missing; index += 1) ranked[index].cents += 1;
  missing = discountCents - shares.reduce((sum, share) => sum + share.cents, 0);
  if (missing !== 0) throw new PosPromotionDomainError("Não foi possível ratear o desconto exatamente.");
  const byLine = new Map(shares.map((share) => [share.lineId, share.cents]));
  return lines.map((line) => ({ lineId: line.lineId, discountCents: byLine.get(line.lineId) ?? 0 }));
}

function parseConditions(value: unknown): PosPromotionConditions {
  const source = plainObject(value, "Condições da promoção");
  exactKeys(source, ["productIds", "categoryIds", "minimumQuantity", "couponRequired"], "Condições da promoção");
  const conditions: PosPromotionConditions = {};
  if (source.productIds != null) conditions.productIds = positiveIntegerList(source.productIds, "Produtos da promoção");
  if (source.categoryIds != null) conditions.categoryIds = positiveIntegerList(source.categoryIds, "Categorias da promoção");
  if (source.minimumQuantity != null) {
    quantityMicros(source.minimumQuantity, "Quantidade mínima");
    conditions.minimumQuantity = source.minimumQuantity as number;
  }
  if (source.couponRequired != null) {
    if (typeof source.couponRequired !== "boolean") throw new PosPromotionDomainError("Exigência de cupom inválida.");
    conditions.couponRequired = source.couponRequired;
  }
  return conditions;
}

function parseEffect(value: unknown): PosPromotionEffect {
  const source = plainObject(value, "Efeito da promoção");
  if (source.type === "fixed") {
    exactKeys(source, ["type", "discountCents"], "Efeito da promoção");
    return { type: "fixed", discountCents: positiveCents(source.discountCents, "Desconto fixo") };
  }
  if (source.type === "percentage") {
    exactKeys(source, ["type", "percentageBasisPoints", "maximumDiscountCents"], "Efeito da promoção");
    const percentageBasisPoints = positiveInteger(source.percentageBasisPoints, "Percentual em pontos-base");
    if (percentageBasisPoints > 10_000) throw new PosPromotionDomainError("O desconto percentual não pode superar 100%.");
    const maximumDiscountCents = source.maximumDiscountCents == null
      ? null
      : positiveCents(source.maximumDiscountCents, "Teto do desconto percentual");
    return { type: "percentage", percentageBasisPoints, maximumDiscountCents };
  }
  throw new PosPromotionDomainError("Tipo de efeito da promoção inválido.");
}

function plainObject(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value == null || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) {
    throw new PosPromotionDomainError(`${label} inválidas.`);
  }
  return value as Record<string, unknown>;
}

function exactKeys(value: Record<string, unknown>, allowed: readonly string[], label: string) {
  const unexpected = Object.keys(value).filter((key) => !allowed.includes(key));
  if (unexpected.length) throw new PosPromotionDomainError(`${label} contêm campos desconhecidos: ${unexpected.join(", ")}.`);
}

function positiveIntegerList(value: unknown, label: string) {
  if (!Array.isArray(value) || value.length === 0 || value.length > 10_000) throw new PosPromotionDomainError(`${label} inválidos.`);
  const unique = [...new Set(value.map((item) => positiveInteger(item, label)))];
  return unique.sort((left, right) => left - right);
}

function quantityMicros(value: unknown, label: string) {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0 || value > 999_999_999) {
    throw new PosPromotionDomainError(`${label} inválida.`);
  }
  const scaled = Math.round(value * QUANTITY_SCALE);
  if (!Number.isSafeInteger(scaled) || scaled <= 0 || Math.abs(scaled / QUANTITY_SCALE - value) > 1e-9) {
    throw new PosPromotionDomainError(`${label} deve ter no máximo seis casas decimais.`);
  }
  return BigInt(scaled);
}

function boundedSum(values: readonly number[], label: string) {
  const total = values.reduce((sum, value) => sum + value, 0);
  if (!Number.isSafeInteger(total) || total > MAX_CENTS) throw new PosPromotionDomainError(`${label} excede o limite permitido.`);
  return total;
}

function positiveCents(value: unknown, label: string) {
  const amount = positiveInteger(value, label);
  if (amount > MAX_CENTS) throw new PosPromotionDomainError(`${label} excede o limite permitido.`);
  return amount;
}

function nonNegativeCents(value: unknown, label: string) {
  const amount = nonNegativeInteger(value, label);
  if (amount > MAX_CENTS) throw new PosPromotionDomainError(`${label} excede o limite permitido.`);
  return amount;
}

function ownUsage(
  snapshots: EvaluatePosPromotionsInput["usageByPromotionId"],
  promotionId: string,
) {
  return snapshots && Object.prototype.hasOwnProperty.call(snapshots, promotionId) ? snapshots[promotionId] : undefined;
}

function compareText(left: string, right: string) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function compareNumberDescending(left: number, right: number) {
  return left > right ? -1 : left < right ? 1 : 0;
}

function nullableNonNegativeInteger(value: unknown, label: string) {
  return value == null ? null : nonNegativeInteger(value, label);
}

function nonNegativeInteger(value: unknown, label: string) {
  return safeInteger(value, label, { allowNegative: false });
}

function positiveInteger(value: unknown, label: string) {
  const integer = safeInteger(value, label, { allowNegative: false });
  if (integer === 0) throw new PosPromotionDomainError(`${label} inválido.`);
  return integer;
}

function safeInteger(value: unknown, label: string, options: { allowNegative: boolean }) {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || (!options.allowNegative && value < 0)) {
    throw new PosPromotionDomainError(`${label} inválido.`);
  }
  return value;
}

function validDate(value: unknown, label: string) {
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) throw new PosPromotionDomainError(`${label} inválida.`);
  return new Date(value.getTime());
}

function requiredText(value: unknown, label: string) {
  if (typeof value !== "string" || !value.trim() || value.length > 256) throw new PosPromotionDomainError(`${label} inválido.`);
  return value.trim();
}
