import assert from "node:assert/strict";
import test from "node:test";
import { canAssignPlan, publicPlanWhere } from "../lib/admin-plan-policy";
import { parsePlanInput } from "../lib/admin-plan-input";
import { editablePlanModules } from "../lib/admin-plan-catalog";
import { PLAN_RESOURCES } from "../lib/admin-plan-catalog";
import { changePlanGrant, PLAN_GROUPS, planGrantSummary, searchText, setPlanResourceMode } from "../lib/admin-plan-builder";
import { planAllows, planMenuAllows, restrictedFeature, STRICT_PLAN_POLICY } from "../lib/erp/plan-features";

test("construtor agrupa todo o catálogo exatamente uma vez", () => {
  const resources = PLAN_GROUPS.flatMap(group => [...group.resources]);
  assert.deepEqual([...resources].sort(), PLAN_RESOURCES.map(([key]) => key).sort());
  assert.equal(new Set(resources).size, resources.length);
  assert.equal(searchText("  Integrações  "), "integracoes");
});
test("ações em lote respeitam o filtro e preservam dependências de consulta", () => {
  const initial = [STRICT_PLAN_POLICY, "finance.read", "finance.write"];
  const full = setPlanResourceMode(initial, ["products"], "write");
  assert.ok(full.includes("products.read") && full.includes("products.write") && full.includes("menu:products"));
  assert.ok(full.includes("finance.write"));
  const read = setPlanResourceMode(full, ["products"], "read");
  assert.ok(!read.includes("products.write") && read.includes("menu:products"));
  assert.deepEqual(new Set(setPlanResourceMode(read, ["products"], "none")), new Set(initial));
  assert.deepEqual(new Set(changePlanGrant(full, "products", "products.read", false)), new Set(initial));
  assert.equal(planGrantSummary(full).read, 2);
  assert.deepEqual(planGrantSummary(full).menus.map(([key]) => key), ["products"]);
});

test("planos privados são exclusivos e nunca contratáveis no cadastro público", () => {
  const plan = { active: true, visibility: "private", ownerOrganizationId: "org-a" };
  assert.equal(canAssignPlan(plan), false);
  assert.equal(canAssignPlan(plan, "org-b"), false);
  assert.equal(canAssignPlan(plan, "org-a"), true);
  assert.equal(canAssignPlan({ ...plan, active: false }, "org-a"), false);
  assert.equal(canAssignPlan({ active: true, visibility: "public", ownerOrganizationId: null }), true);
  assert.equal(canAssignPlan({ active: true, visibility: "unknown", ownerOrganizationId: null }), false);
  assert.deepEqual(publicPlanWhere, { active: true, visibility: "public", ownerOrganizationId: null });
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

test("formulário exige consulta antes de ações e recusa recursos desconhecidos", () => {
  const valid = { id: "custom-a", name: "Plano A", monthlyPrice: 10, annualPrice: 100, seats: 5, active: true, visibility: "private", ownerOrganizationId: "org-a", modules: [STRICT_PLAN_POLICY, "products.read", "products.write"] };
  assert.equal(parsePlanInput(valid).ownerOrganizationId, "org-a");
  assert.throws(() => parsePlanInput({ ...valid, ownerOrganizationId: "" }));
  assert.throws(() => parsePlanInput({ ...valid, modules: [STRICT_PLAN_POLICY, "products.write"] }));
  assert.throws(() => parsePlanInput({ ...valid, modules: [STRICT_PLAN_POLICY, "unknown.read"] }));
  assert.throws(() => parsePlanInput({ ...valid, modules: ["*"] }));
  assert.throws(() => parsePlanInput({ ...valid, seats: -1 }));
  assert.equal(parsePlanInput({ ...valid, visibility: "public" }).ownerOrganizationId, null);
});

test("edição migra acesso legado efetivo sem retirar permissões silenciosamente", () => {
  const modules = editablePlanModules(["products"]);
  assert.equal(modules.includes("finance.read"), true);
  assert.equal(modules.includes("marketplaces.read"), false);
  assert.equal(modules.includes(STRICT_PLAN_POLICY), true);
});

test("preços e capacidade recusam conversões implícitas e respeitam limites", () => {
  const valid = { id: "public-a", name: "Plano A", monthlyPrice: 10, annualPrice: 100, seats: 5, active: true, visibility: "public", modules: [STRICT_PLAN_POLICY] };
  for (const field of ["monthlyPrice", "annualPrice", "seats"]) {
    for (const value of [undefined, null, true, false, "", "1", [], [1], {}, NaN, Infinity, -Infinity, -1]) {
      assert.throws(() => parsePlanInput({ ...valid, [field]: value }), `${field}: ${String(value)}`);
    }
  }
  for (const field of ["monthlyPrice", "annualPrice"]) {
    assert.equal(parsePlanInput({ ...valid, [field]: 0 })[field as "monthlyPrice" | "annualPrice"], 0);
    assert.doesNotThrow(() => parsePlanInput({ ...valid, [field]: 1_000_000 }));
    assert.throws(() => parsePlanInput({ ...valid, [field]: 1_000_001 }));
  }
  for (const seats of [0, 1.5, 100_001]) assert.throws(() => parsePlanInput({ ...valid, seats }));
  for (const seats of [1, 100_000]) assert.doesNotThrow(() => parsePlanInput({ ...valid, seats }));
});
