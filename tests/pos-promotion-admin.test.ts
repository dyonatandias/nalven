import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import {
  couponCodeMetadata,
  hashPosPromotionAdminInput,
  parsePosPromotionAdminInput,
  PosPromotionAdminError,
} from "../lib/erp/pos-promotion-admin";

const basePromotion = {
  action: "promotion.create",
  idempotencyKey: key("create"),
  branchId: 2,
  name: " Oferta de verão ",
  description: null,
  priority: 10,
  status: "active",
  startsAt: "2026-08-28T10:00:00-03:00",
  endsAt: "2026-09-30T23:59:59-03:00",
  usageLimit: 100,
  perCustomerLimit: 2,
  conditions: { productIds: [3, 1, 3], minimumQuantity: 2, couponRequired: true },
  effect: { type: "percentage", percentageBasisPoints: 1500, maximumDiscountCents: 2500 },
} as const;
const projectRoot = fileURLToPath(new URL("..", import.meta.url));

test("cadastro normaliza somente regras suportadas pelo motor", () => {
  const input = parsePosPromotionAdminInput(basePromotion);
  assert.equal(input.action, "promotion.create");
  if (input.action !== "promotion.create") return;
  assert.equal(input.name, "Oferta de verão");
  assert.deepEqual(input.conditions.productIds, [1, 3]);
  assert.deepEqual(input.effect, { type: "percentage", percentageBasisPoints: 1500, maximumDiscountCents: 2500 });
  assert.equal(input.startsAt.toISOString(), "2026-08-28T13:00:00.000Z");
});

test("rejeita mass assignment, datas ambíguas e regras desconhecidas", () => {
  assert.throws(() => parsePosPromotionAdminInput({ ...basePromotion, createdAt: "2020-01-01" }), /Campo não permitido/);
  assert.throws(() => parsePosPromotionAdminInput({ ...basePromotion, startsAt: "2026-08-28T10:00:00" }), /fuso horário/);
  assert.throws(() => parsePosPromotionAdminInput({ ...basePromotion, conditions: { customerTier: "gold" } }), /campos desconhecidos/);
  assert.throws(() => parsePosPromotionAdminInput({ ...basePromotion, effect: { type: "percentage", percentageBasisPoints: 10001 } }), /100%/);
  assert.throws(() => parsePosPromotionAdminInput({ ...basePromotion, endsAt: basePromotion.startsAt }), /posterior/);
});

test("PATCH exige alteração e limites permanecem inteiros em faixa PostgreSQL", () => {
  assert.throws(() => parsePosPromotionAdminInput({ action: "promotion.update", idempotencyKey: key("empty"), promotionId: "promo_1" }), /ao menos um campo/);
  assert.throws(() => parsePosPromotionAdminInput({ action: "coupon.update", idempotencyKey: key("empty-coupon"), couponId: "coupon_1" }), /ao menos um campo/);
  assert.throws(() => parsePosPromotionAdminInput({ action: "coupon.update", idempotencyKey: key("float"), couponId: "coupon_1", usageLimit: 1.5 }), PosPromotionAdminError);
  assert.deepEqual(parsePosPromotionAdminInput({ action: "coupon.update", idempotencyKey: key("clear"), couponId: "coupon_1", usageLimit: null, expiresAt: null }), {
    action: "coupon.update", idempotencyKey: key("clear"), couponId: "coupon_1", usageLimit: null, expiresAt: null,
  });
});

test("código de cupom é normalizado, mas o hash idempotente nunca depende do texto aberto serializado", () => {
  const first = parsePosPromotionAdminInput({ action: "coupon.create", idempotencyKey: key("coupon-a"), promotionId: "promo_1", code: " verão-2026 ", status: "active", usageLimit: 5, expiresAt: null });
  const second = parsePosPromotionAdminInput({ action: "coupon.create", idempotencyKey: key("coupon-b"), promotionId: "promo_1", code: "VERÃO-2026", status: "active", usageLimit: 5, expiresAt: null });
  assert.equal(hashPosPromotionAdminInput(first), hashPosPromotionAdminInput(second));
  assert.match(hashPosPromotionAdminInput(first), /^[0-9a-f]{64}$/);
  assert.deepEqual(couponCodeMetadata(" verão-2026 "), {
    codeHash: "sha256:e11810553b8d5e02627e1ab52bd18725cdcd16136f491ad1485a1574b96d11f4",
    codeLastFour: "2026",
  });
});

test("código e ids têm limites estritos", () => {
  assert.throws(() => parsePosPromotionAdminInput({ action: "coupon.rotate", idempotencyKey: key("short-code"), couponId: "coupon_1", code: "abc" }), /Cupom inválido/);
  assert.throws(() => parsePosPromotionAdminInput({ action: "coupon.rotate", idempotencyKey: key("spaces"), couponId: "coupon_1", code: "CODE WITH SPACE" }), /Cupom inválido/);
  assert.throws(() => parsePosPromotionAdminInput({ action: "promotion.deactivate", idempotencyKey: "short", promotionId: "promo_1" }), /idempotência/);
});

test("migration amplia o CHECK administrativo sem remover ações existentes", () => {
  const migration = readFileSync(join(projectRoot, "prisma/tenant/migrations/20260828140000_pos_promotion_admin_actions/migration.sql"), "utf8");
  for (const action of [
    "register.create", "terminal.pairing.issue",
    "promotion.create", "promotion.update", "promotion.deactivate",
    "coupon.create", "coupon.update", "coupon.rotate", "coupon.deactivate",
  ]) assert.match(migration, new RegExp(`'${action.replace(".", "\\.")}'`));
  assert.match(migration, /DROP CONSTRAINT "pos_admin_mutations_action_check"/);
  assert.match(migration, /ADD CONSTRAINT "pos_admin_mutations_action_check" CHECK/);
});

function key(suffix: string) { return `pos-promotion-admin:${suffix}:00000000`; }
