import assert from "node:assert/strict";
import test from "node:test";
import {
  buildPosPromotionRule,
  evaluatePosPromotions,
  hashPosCouponCode,
  normalizePosCouponCode,
  PosPromotionDomainError,
  type PosCouponSnapshot,
  type PosPromotionRecord,
} from "../lib/erp/pos-promotions";

const NOW = new Date("2026-08-28T12:00:00.000Z");

function record(overrides: Partial<PosPromotionRecord> = {}): PosPromotionRecord {
  return {
    id: "promo-base",
    name: "Promoção base",
    priority: 0,
    status: "active",
    stackMode: "exclusive",
    branchId: null,
    conditions: {},
    effects: { type: "percentage", percentageBasisPoints: 1_000 },
    startsAt: new Date("2026-08-01T00:00:00.000Z"),
    endsAt: new Date("2026-09-01T00:00:00.000Z"),
    usageLimit: null,
    perCustomerLimit: null,
    ...overrides,
  };
}

const cart = [
  { lineId: "line-1", productId: 1, categoryId: 10, quantity: 1, subtotalCents: 1_001 },
  { lineId: "line-2", productId: 2, categoryId: 20, quantity: 2, subtotalCents: 2_002 },
] as const;

function evaluate(promotions: PosPromotionRecord[], overrides: Partial<Parameters<typeof evaluatePosPromotions>[0]> = {}) {
  return evaluatePosPromotions({
    now: NOW,
    branchId: 1,
    customerId: null,
    lines: cart,
    promotions: promotions.map(buildPosPromotionRule),
    ...overrides,
  });
}

test("considera início inclusivo, término exclusivo e filial exata", () => {
  const startsNow = record({ id: "starts-now", startsAt: NOW });
  assert.equal(evaluate([startsNow]).award?.promotionId, "starts-now");

  const endsNow = record({ id: "ends-now", endsAt: NOW });
  const result = evaluate([endsNow], { branchId: 9 });
  assert.equal(result.award, null);
  assert.deepEqual(result.evaluations[0].rejectionReasons, ["expired"]);

  const wrongBranch = record({ id: "wrong-branch", branchId: 2 });
  assert.deepEqual(evaluate([wrongBranch]).evaluations[0].rejectionReasons, ["branch_mismatch"]);
  const future = record({ id: "future", startsAt: new Date("2026-08-28T12:00:00.001Z"), endsAt: null });
  assert.deepEqual(evaluate([future]).evaluations[0].rejectionReasons, ["not_started"]);
});

test("filtra produto e categoria cumulativamente e soma apenas a quantidade elegível", () => {
  const promotion = record({
    conditions: { productIds: [1, 2], categoryIds: [10], minimumQuantity: 1 },
    effects: { type: "fixed", discountCents: 500 },
  });
  const result = evaluate([promotion]);
  assert.equal(result.award?.eligibleSubtotalCents, 1_001);
  assert.equal(result.award?.discountCents, 500);
  assert.deepEqual(result.award?.allocations, [{ lineId: "line-1", discountCents: 500 }]);

  const insufficient = record({ id: "minimum", conditions: { productIds: [1], minimumQuantity: 1.000001 } });
  assert.deepEqual(evaluate([insufficient]).evaluations[0].rejectionReasons, ["minimum_quantity_not_met"]);

  const linkedCategory = evaluate([record({ id: "linked", conditions: { categoryIds: [99] } })], {
    lines: [{ lineId: "linked", productId: 8, categoryId: 10, categoryIds: [10, 99], quantity: 1, subtotalCents: 100 }],
  });
  assert.equal(linkedCategory.award?.promotionId, "linked");
});

test("normaliza e deriva hash de cupom sem preservar texto aberto", () => {
  assert.equal(normalizePosCouponCode("  verão-2026  "), "VERÃO-2026");
  const first = hashPosCouponCode(" cupom_1234 ");
  assert.equal(first, hashPosCouponCode("CUPOM_1234"));
  assert.match(first, /^sha256:[a-f0-9]{64}$/);
  assert.equal(first.includes("CUPOM"), false);
  assert.throws(() => hashPosCouponCode("a b"), /Cupom inválido/);
  assert.throws(() => hashPosCouponCode("abc"), /Cupom inválido/);
});

test("quantidade fracionária usa escala decimal determinística", () => {
  const promotion = record({ conditions: { minimumQuantity: 0.3 } });
  const result = evaluate([promotion], {
    lines: [
      { lineId: "a", productId: 1, categoryId: null, quantity: 0.1, subtotalCents: 100 },
      { lineId: "b", productId: 2, categoryId: null, quantity: 0.2, subtotalCents: 200 },
    ],
  });
  assert.equal(result.evaluations[0].eligibleQuantity, 0.3);
  assert.equal(result.award?.discountCents, 30);
});

test("percentual usa pontos-base, arredonda para baixo e respeita teto", () => {
  const promotion = record({
    effects: { type: "percentage", percentageBasisPoints: 3_333, maximumDiscountCents: 333 },
  });
  const result = evaluate([promotion], {
    lines: [{ lineId: "only", productId: 1, categoryId: null, quantity: 1, subtotalCents: 1_001 }],
  });
  assert.equal(result.award?.discountCents, 333);

  const subCent = record({ id: "sub-cent", effects: { type: "percentage", percentageBasisPoints: 1 } });
  const noDiscount = evaluate([subCent], {
    lines: [{ lineId: "one-cent", productId: 1, categoryId: null, quantity: 1, subtotalCents: 1 }],
  });
  assert.equal(noDiscount.award, null);
  assert.deepEqual(noDiscount.evaluations[0].rejectionReasons, ["no_discount"]);

  const zeroValueLine = evaluate([record({ id: "zero-line", conditions: { productIds: [1] } })], {
    lines: [
      { lineId: "free", productId: 1, categoryId: null, quantity: 1, subtotalCents: 0 },
      { lineId: "paid", productId: 2, categoryId: null, quantity: 1, subtotalCents: 100 },
    ],
  });
  assert.equal(zeroValueLine.award, null);
  assert.deepEqual(zeroValueLine.evaluations[0].rejectionReasons, ["no_discount"]);
});

test("desconto fixo nunca supera o subtotal elegível", () => {
  const promotion = record({ effects: { type: "fixed", discountCents: 10_000 } });
  const result = evaluate([promotion]);
  assert.equal(result.award?.discountCents, 3_003);
  assert.equal(result.award?.allocations.reduce((sum, item) => sum + item.discountCents, 0), 3_003);
});

test("rateio pelo maior resto é exato e desempata por lineId", () => {
  const promotion = record({ effects: { type: "fixed", discountCents: 1 } });
  const result = evaluate([promotion], {
    lines: [
      { lineId: "b", productId: 1, categoryId: null, quantity: 1, subtotalCents: 1 },
      { lineId: "a", productId: 2, categoryId: null, quantity: 1, subtotalCents: 1 },
      { lineId: "c", productId: 3, categoryId: null, quantity: 1, subtotalCents: 1 },
    ],
  });
  assert.deepEqual(result.award?.allocations, [
    { lineId: "b", discountCents: 0 },
    { lineId: "a", discountCents: 1 },
    { lineId: "c", discountCents: 0 },
  ]);
});

test("limites globais e por cliente falham fechados sem snapshot", () => {
  const promotion = record({ usageLimit: 10, perCustomerLimit: 2 });
  const anonymous = evaluate([promotion]);
  assert.deepEqual(anonymous.evaluations[0].rejectionReasons, ["usage_snapshot_missing", "customer_required"]);

  const missingCustomerCount = evaluate([promotion], {
    customerId: 7,
    usageByPromotionId: { "promo-base": { totalUsed: 1 } },
  });
  assert.deepEqual(missingCustomerCount.evaluations[0].rejectionReasons, ["customer_usage_missing"]);

  const exhausted = evaluate([promotion], {
    customerId: 7,
    usageByPromotionId: { "promo-base": { totalUsed: 10, customerUsed: 2 } },
  });
  assert.deepEqual(exhausted.evaluations[0].rejectionReasons, ["usage_limit_reached", "customer_limit_reached"]);

  const available = evaluate([promotion], {
    customerId: 7,
    usageByPromotionId: { "promo-base": { totalUsed: 9, customerUsed: 1 } },
  });
  assert.equal(available.award?.promotionId, "promo-base");

  const prototypeId = record({ id: "toString", usageLimit: 1, perCustomerLimit: null });
  assert.deepEqual(evaluate([prototypeId], { usageByPromotionId: {} }).evaluations[0].rejectionReasons, ["usage_snapshot_missing"]);
});

test("reservas T2 live somam aos usos global, customer e cupom sem alterar used_count", () => {
  const promotion = record({ usageLimit: 10, perCustomerLimit: 3, conditions: { couponRequired: true } });
  const coupon: PosCouponSnapshot = {
    id: "coupon-live", promotionId: promotion.id, status: "active", usageLimit: 4,
    usedCount: 2, liveReserved: 2, expiresAt: null,
  };
  const result = evaluate([promotion], {
    customerId: 7,
    usageByPromotionId: { "promo-base": { totalUsed: 8, totalReserved: 2, customerUsed: 1, customerReserved: 2 } },
    coupon,
  });
  assert.equal(result.award, null);
  assert.deepEqual(result.evaluations[0].rejectionReasons, ["usage_limit_reached", "customer_limit_reached", "coupon_limit_reached"]);
  assert.equal(coupon.usedCount, 2);
});

test("cupom deve pertencer à promoção e estar ativo, vigente e disponível", () => {
  const promotion = record({ conditions: { couponRequired: true } });
  assert.deepEqual(evaluate([promotion]).evaluations[0].rejectionReasons, ["coupon_required"]);

  const coupon = (overrides: Partial<PosCouponSnapshot> = {}): PosCouponSnapshot => ({
    id: "coupon-1",
    promotionId: "promo-base",
    status: "active",
    usageLimit: 2,
    usedCount: 1,
    expiresAt: new Date("2026-08-29T00:00:00.000Z"),
    ...overrides,
  });
  assert.equal(evaluate([promotion], { coupon: coupon() }).award?.couponId, "coupon-1");
  assert.deepEqual(evaluate([promotion], { coupon: coupon({ promotionId: "other" }) }).evaluations[0].rejectionReasons, ["coupon_mismatch"]);
  assert.deepEqual(evaluate([promotion], { coupon: coupon({ status: "disabled" }) }).evaluations[0].rejectionReasons, ["coupon_inactive"]);
  assert.deepEqual(evaluate([promotion], { coupon: coupon({ expiresAt: NOW }) }).evaluations[0].rejectionReasons, ["coupon_expired"]);
  assert.deepEqual(evaluate([promotion], { coupon: coupon({ usedCount: 2 }) }).evaluations[0].rejectionReasons, ["coupon_limit_reached"]);
  assert.deepEqual(evaluate([promotion], { coupon: coupon({ liveReserved: 1 }) }).evaluations[0].rejectionReasons, ["coupon_limit_reached"]);
});

test("escolhe maior desconto, depois prioridade e por fim menor id", () => {
  const low = record({ id: "low", priority: 99, effects: { type: "fixed", discountCents: 99 } });
  const tieLowPriority = record({ id: "a-low-priority", priority: 1, effects: { type: "fixed", discountCents: 100 } });
  const tieIdB = record({ id: "b-high", priority: 2, effects: { type: "fixed", discountCents: 100 } });
  const tieIdA = record({ id: "a-high", priority: 2, effects: { type: "fixed", discountCents: 100 } });
  const result = evaluate([low, tieLowPriority, tieIdB, tieIdA]);
  assert.equal(result.award?.promotionId, "a-high");
  assert.deepEqual(result.evaluations.map((item) => item.promotionId), ["low", "a-low-priority", "b-high", "a-high"]);
});

test("rejeita configurações ambíguas, dinheiro inválido e estouros", () => {
  assert.throws(() => buildPosPromotionRule(record({ conditions: { minimum_quantity: 2 } })), /campos desconhecidos/);
  assert.throws(() => buildPosPromotionRule(record({ effects: { type: "percentage", percentageBasisPoints: 10_001 } })), /100%/);
  assert.throws(() => buildPosPromotionRule(record({ stackMode: "stackable" })), /Somente promoções exclusivas/);
  assert.throws(() => buildPosPromotionRule(record({ endsAt: new Date("2026-08-01T00:00:00.000Z") })), /posterior ao início/);
  assert.throws(() => evaluate([record()], {
    lines: [{ lineId: "invalid", productId: 1, categoryId: null, quantity: 1, subtotalCents: 1.5 }],
  }), PosPromotionDomainError);
  assert.throws(() => evaluate([record()], {
    lines: [
      { lineId: "a", productId: 1, categoryId: null, quantity: 1, subtotalCents: 2_147_483_647 },
      { lineId: "b", productId: 2, categoryId: null, quantity: 1, subtotalCents: 1 },
    ],
  }), /excede o limite/);
  const integerLimit = evaluate([
    record({ id: "integer-limit", effects: { type: "percentage", percentageBasisPoints: 10_000 } }),
  ], {
    lines: [{ lineId: "max", productId: 1, categoryId: null, quantity: 1, subtotalCents: 2_147_483_647 }],
  });
  assert.equal(integerLimit.award?.discountCents, 2_147_483_647);
  assert.throws(() => evaluate([record()], {
    lines: [
      { lineId: "same", productId: 1, categoryId: null, quantity: 1, subtotalCents: 100 },
      { lineId: "same", productId: 2, categoryId: null, quantity: 1, subtotalCents: 100 },
    ],
  }), /Item duplicado/);
  assert.throws(() => evaluate([record()], {
    lines: [{ lineId: "tiny", productId: 1, categoryId: null, quantity: 0.0000000001, subtotalCents: 1 }],
  }), /Quantidade do item/);
});
