import assert from "node:assert/strict";
import test from "node:test";
import { deriveRbacModules, BILLING_MODULE_CODES } from "../lib/billing/module-map";
import { planAllows, planMenuAllows, STRICT_PLAN_POLICY } from "../lib/erp/plan-features";

test("plano sem módulos ainda libera os recursos sempre disponíveis", () => {
  const modules = deriveRbacModules([]);
  assert.ok(modules.includes(STRICT_PLAN_POLICY));
  assert.equal(planAllows(modules, "settings"), true);
  assert.equal(planAllows(modules, "billing"), true);
  assert.equal(planAllows(modules, "products"), false);
});

test("módulo contratado libera consulta e alteração do recurso e o menu", () => {
  const modules = deriveRbacModules(["catalogo_estoque"]);
  assert.equal(planAllows(modules, "products"), true);
  assert.equal(planMenuAllows(modules, "products"), true);
  assert.equal(modules.includes("products.write"), true);
  assert.equal(planAllows(modules, "finance"), false);
});

test("códigos de módulo desconhecidos são ignorados sem lançar erro", () => {
  assert.deepEqual(deriveRbacModules(["nao-existe"]), deriveRbacModules([]));
  assert.deepEqual(deriveRbacModules("não é um array"), deriveRbacModules([]));
});

test("plano omnichannel acumula todos os módulos canônicos sem duplicar concessões", () => {
  const modules = deriveRbacModules([...BILLING_MODULE_CODES]);
  assert.equal(new Set(modules).size, modules.length);
  assert.equal(planAllows(modules, "marketplaces"), true);
  assert.equal(planAllows(modules, "reports"), true);
});
