import assert from "node:assert/strict";
import test from "node:test";
import { canAssignPlan, publicPlanWhere } from "../lib/admin-plan-policy";
import { changePlanGrant, setPlanResourceMode } from "../lib/admin-plan-builder";
import { planAllows, planMenuAllows, restrictedFeature, STRICT_PLAN_POLICY } from "../lib/erp/plan-features";

test("ações em lote respeitam o filtro e preservam dependências de consulta", () => {
  const initial = [STRICT_PLAN_POLICY, "finance.read", "finance.write"];
  const full = setPlanResourceMode(initial, ["products"], "write");
  assert.ok(full.includes("products.read") && full.includes("products.write") && full.includes("menu:products"));
  assert.ok(full.includes("finance.write"));
  const read = setPlanResourceMode(full, ["products"], "read");
  assert.ok(!read.includes("products.write") && read.includes("menu:products"));
  assert.deepEqual(new Set(setPlanResourceMode(read, ["products"], "none")), new Set(initial));
  assert.deepEqual(new Set(changePlanGrant(full, "products", "products.read", false)), new Set(initial));
});

test("apenas planos ativos com código do Billing são atribuíveis", () => {
  assert.equal(canAssignPlan({ active: true, code: "essencial" }), true);
  assert.equal(canAssignPlan({ active: false, code: "essencial" }), false);
  assert.equal(canAssignPlan({ active: true, code: null }), false);
  assert.equal(canAssignPlan(null), false);
  assert.deepEqual(publicPlanWhere, { active: true, code: { not: null } });
});

test("política explícita controla recursos, ações e menus separadamente", () => {
  const modules = [STRICT_PLAN_POLICY, "products.read", "menu:products"];
  assert.equal(planAllows(modules, "products"), true);
  assert.equal(planMenuAllows(modules, "products"), true);
  assert.equal(restrictedFeature(modules, "products.read"), false);
  assert.equal(restrictedFeature(modules, "products.write"), true);
  assert.equal(restrictedFeature(modules, "finance.read"), true);
  assert.equal(planMenuAllows([STRICT_PLAN_POLICY, "products.read"], "products"), false);
  assert.equal(restrictedFeature([STRICT_PLAN_POLICY, "*"], "finance.write"), true);
});
