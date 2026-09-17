import assert from "node:assert/strict";
import test from "node:test";
import { planPosPromotionReversal, posPromotionReversalReason, PosPromotionRedemptionError } from "../lib/erp/pos-promotion-redemptions";

test("planeja somente resgates ativos e agrega cupons deterministicamente", () => {
  const plan = planPosPromotionReversal([
    { id: BigInt(3), couponId: "coupon-b", reversedAt: null },
    { id: BigInt(1), couponId: "coupon-a", reversedAt: null },
    { id: BigInt(2), couponId: "coupon-a", reversedAt: null },
    { id: BigInt(4), couponId: "coupon-c", reversedAt: new Date("2026-08-28T12:00:00Z") },
  ]);
  assert.deepEqual(plan.redemptionIds, [BigInt(1), BigInt(2), BigInt(3)]);
  assert.deepEqual(plan.couponDecrements, [{ couponId: "coupon-a", count: 2 }, { couponId: "coupon-b", count: 1 }]);
});

test("replay de reversão já concluída produz plano vazio", () => {
  assert.deepEqual(planPosPromotionReversal([{ id: BigInt(1), couponId: "coupon-a", reversedAt: new Date() }]), { redemptionIds: [], couponDecrements: [] });
});

test("rejeita ids duplicados, datas inválidas e cupom malformado", () => {
  assert.throws(() => planPosPromotionReversal([{ id: BigInt(1), couponId: null, reversedAt: null }, { id: BigInt(1), couponId: null, reversedAt: null }]), /duplicado/);
  assert.throws(() => planPosPromotionReversal([{ id: BigInt(0), couponId: null, reversedAt: null }]), PosPromotionRedemptionError);
  assert.throws(() => planPosPromotionReversal([{ id: BigInt(1), couponId: "", reversedAt: null }]), PosPromotionRedemptionError);
  assert.throws(() => planPosPromotionReversal([{ id: BigInt(1), couponId: null, reversedAt: new Date("invalid") }]), PosPromotionRedemptionError);
});

test("motivo vincula o gatilho, normaliza espaços e limita conteúdo", () => {
  assert.equal(posPromotionReversalReason("sale_cancel", "  erro   operacional  "), "sale_cancel:erro operacional");
  assert.equal(posPromotionReversalReason("full_return", "customer_return"), "full_return:customer_return");
  assert.throws(() => posPromotionReversalReason("sale_cancel", "x".repeat(501)), PosPromotionRedemptionError);
});
