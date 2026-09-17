import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { allowedBudgetTransition, categoryKey, goalAchieved, goalProgress, parsePlanningQuery,
  planningCsv, planningSummary, suggestedDreGroup, type PlanningMonth } from "../lib/erp/planning-control";

test("planning query validates dimensions and defaults", () => {
  assert.deepEqual(parsePlanningQuery(new URLSearchParams(), new Date("2026-09-03T00:00:00Z")),
    { year: 2026, scenario: "base", basis: "accrual", branchId: null, costCenterId: null, budgetId: null, format: "json" });
  assert.throws(() => parsePlanningQuery(new URLSearchParams("year=2019")), /Ano inválido/);
  assert.throws(() => parsePlanningQuery(new URLSearchParams("basis=magic")), /Regime inválido/);
});

test("classification normalizes accents and suggests conservative DRE groups", () => {
  assert.equal(categoryKey("  Tarifas Bancárias  "), "tarifas_bancarias");
  assert.equal(suggestedDreGroup("IRPJ e CSLL", "payable"), "income_tax");
  assert.equal(suggestedDreGroup("Compra de mercadorias", "payable"), "excluded");
  assert.equal(suggestedDreGroup("Serviços", "receivable"), "revenue");
});

test("goals honor increase and decrease directions", () => {
  assert.equal(goalProgress({ baseline: 10, current: 15, target: 20, direction: "increase" }), 50);
  assert.equal(goalProgress({ baseline: 30, current: 20, target: 10, direction: "decrease" }), 50);
  assert.equal(goalAchieved({ current: 9, target: 10, direction: "decrease" }), true);
  assert.equal(goalAchieved({ current: 19, target: 20, direction: "increase" }), false);
});

test("budget workflow prevents editing active plans", () => {
  assert.equal(allowedBudgetTransition("draft", "approved"), true);
  assert.equal(allowedBudgetTransition("approved", "active"), true);
  assert.equal(allowedBudgetTransition("active", "draft"), false);
  assert.equal(allowedBudgetTransition("archived", "draft"), true);
});

test("planning summary reconciles DRE, budget, variance and forecast", () => {
  const blank = (month: number): PlanningMonth => ({ month, revenueCents: 0, deductionsCents: 0, cogsCents: 0,
    operatingExpenseCents: 0, financialResultCents: 0, incomeTaxCents: 0, resultCents: 0,
    budgetRevenueCents: 0, budgetCogsCents: 0, budgetExpenseCents: 0, budgetResultCents: 0 });
  const months = Array.from({ length: 12 }, (_, index) => blank(index + 1));
  months[0] = { ...months[0], revenueCents: 100_000, deductionsCents: 10_000, cogsCents: 20_000,
    operatingExpenseCents: 30_000, resultCents: 40_000, budgetRevenueCents: 90_000,
    budgetCogsCents: 20_000, budgetExpenseCents: 25_000, budgetResultCents: 45_000 };
  const summary = planningSummary(months, 2026, new Date("2026-01-20T00:00:00Z"));
  assert.equal(summary.grossProfitCents, 70_000); assert.equal(summary.grossMargin, 70);
  assert.equal(summary.varianceCents, -5_000); assert.equal(summary.forecast.resultCents, 480_000);
  assert.match(planningCsv(months, 2026), /2026;1;1000,00/);
});

test("planning control center keeps security, lifecycle and responsive contracts", () => {
  const api = readFileSync("app/api/erp/planning/route.ts", "utf8"), ui = readFileSync("components/erp/planning-control-center.tsx", "utf8"),
    css = readFileSync("components/erp/planning-control-center.module.css", "utf8"), migration = readFileSync("prisma/tenant/migrations/20260903033000_planning_control_center/migration.sql", "utf8");
  assert.match(api, /assertSameOrigin\(request\)/); assert.match(api, /assertTenantWriteAccess/); assert.match(api, /readPosJson/);
  assert.match(api, /isolationLevel: "Serializable"/); assert.match(api, /console\.error\("Planning control center failed"/);
  assert.match(ui, /role="tablist"/); assert.match(ui, /Exportar CSV/); assert.match(ui, /Atualizar progresso/);
  assert.match(css, /@media\(max-width:680px\)/); assert.match(css, /@media\(pointer:coarse\)/);
  assert.match(migration, /business_goal_updates/); assert.match(migration, /dre_category_rules/); assert.match(migration, /CHECK \("month" BETWEEN 1 AND 12\)/);
  const salesDimensionMigration = readFileSync("prisma/tenant/migrations/20260903040000_sale_planning_dimension/migration.sql", "utf8");
  assert.match(salesDimensionMigration, /sales_cost_center_id_fkey/); assert.match(api, /costCenterId: query.costCenterId/);
});
