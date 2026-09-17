import assert from "node:assert/strict";
import test from "node:test";
import {
  aggregateMarginCategories,
  calculateMarginRow,
  csvCell,
  fiscalCompleteness,
  resolveMargin,
  suggestedPrice,
  summarizeMargins,
  validGtin,
  type MarginConfiguration,
} from "../lib/erp/report-domain";
import { addCalendarDays, aggregateSales, compareMetric, pdvNetSalesSource, salesPeriod, zonedMidnight } from "../lib/erp/report-sales";

const configuration: MarginConfiguration = {
  mode: "mixed",
  globalTargetMargin: 40,
  globalMinimumMargin: 15,
  categoryOverrides: [{ categoryId: 2, targetMargin: 35, minimumMargin: 20 }],
};

test("preço sugerido inverte a fórmula da margem e protege limites", () => {
  assert.equal(suggestedPrice(60, 40), 100);
  assert.equal(suggestedPrice(60, 100), 60);
  assert.equal(suggestedPrice(60, -1), 60);
  assert.equal(suggestedPrice(0, 40), 0);
});

test("motor soma custos em centavos e calcula margem sobre o preço", () => {
  const row = calculateMarginRow({ id: 1, name: "Produto", sku: "P1", price: 100, cogs: 50, targetMargin: null, pricingSource: "auto", categories: [], costs: [{ type: "direct", label: "Embalagem", value: 4.5 }, { type: "indirect", label: "Operação", value: 2 }] }, configuration, [{ type: "indirect", label: "Global", value: 3.5 }]);
  assert.equal(row.totalCost, 60);
  assert.equal(row.margin, 40);
  assert.equal(row.marginPercent, 40);
  assert.equal(row.health, "healthy");
  assert.equal(row.suggestedPrice, 100);
});

test("preço zero nunca produz NaN e sempre é crítico", () => {
  const row = calculateMarginRow({ id: 1, name: "Sem preço", sku: "P0", price: 0, cogs: 10, targetMargin: null, pricingSource: "auto", categories: [], costs: [] }, configuration, []);
  assert.equal(row.marginPercent, 0);
  assert.equal(row.health, "critical");
  assert.equal(Number.isNaN(row.marginPercent), false);
});

test("cascata prioriza produto, categoria primária e global", () => {
  assert.deepEqual(resolveMargin({ targetMargin: 55, pricingSource: "product", categories: [{ id: 2, name: "B" }] }, configuration), { targetMargin: 55, minimumMargin: 15, source: "product" });
  assert.deepEqual(resolveMargin({ targetMargin: null, pricingSource: "auto", categories: [{ id: 9, name: "A" }, { id: 2, name: "B", primary: true }] }, configuration), { targetMargin: 35, minimumMargin: 20, source: "category" });
  assert.equal(resolveMargin({ targetMargin: null, pricingSource: "auto", categories: [] }, configuration).source, "global");
});

test("sumário usa média simples e categoria agrega o recorte inteiro", () => {
  const rows = [50, 100].map((price, index) => calculateMarginRow({ id: index + 1, name: `P${index}`, sku: String(index), price, cogs: 25, targetMargin: null, pricingSource: "auto", categories: [{ id: 1, name: "Categoria" }], costs: [] }, configuration, []));
  assert.equal(summarizeMargins(rows).avgMarginPercent, 62.5);
  assert.equal(aggregateMarginCategories(rows)[0].products, 2);
});

test("completude fiscal respeita CEST não aplicável e dígito do GTIN", () => {
  assert.equal(validGtin("7894900011517"), true);
  assert.equal(validGtin("7894900011518"), false);
  const complete = fiscalCompleteness({ ncm: "22021000", cestNotApplicable: true, origin: "0", gtin: "7894900011517" }, ["ncm", "cest", "origin", "gtin"]);
  assert.equal(complete.complete, true);
  assert.equal(complete.percentage, 100);
});

test("CSV neutraliza fórmulas antes do escape RFC 4180", () => {
  assert.equal(csvCell(" =HYPERLINK(\"x\")"), '"\' =HYPERLINK(""x"")"');
  assert.equal(csvCell("normal"), "normal");
  assert.equal(csvCell("a,b"), '"a,b"');
});

test("períodos têm exatamente N dias no fuso da loja", () => {
  const period = salesPeriod(new URLSearchParams("period=7d"), "America/Sao_Paulo", new Date("2026-08-28T15:00:00Z"));
  assert.equal(period.dateMin, "2026-08-22");
  assert.equal(period.dateMax, "2026-08-28");
  assert.equal(period.days, 7);
  assert.equal(addCalendarDays(period.dateMin, 6), period.dateMax);
  assert.equal(zonedMidnight("2026-08-28", "America/Sao_Paulo").toISOString(), "2026-08-28T03:00:00.000Z");
});

test("vendas preenchem dias sem movimento e protegem comparação sem base", () => {
  const aggregate = aggregateSales([{ id: "1", date: new Date("2026-08-28T12:00:00Z"), total: 100, items: [{ productId: 1, name: "Produto snapshot", quantity: 2, revenue: 100 }] }], "2026-08-27", "2026-08-28", "America/Sao_Paulo");
  assert.deepEqual(aggregate.timeline.map((row) => row.revenue), [0, 100]);
  assert.equal(aggregate.top_sellers[0].product, "Produto snapshot");
  assert.equal(compareMetric(100, 0), null);
  assert.equal(compareMetric(0, 0), 0);
});

test("projeção líquida do PDV exclui cancelamento/refund integral e abate devolução parcial", () => {
  const base = {
    id: 7,
    createdAt: new Date("2026-08-28T12:00:00Z"),
    totalCents: 10_000,
    items: [
      { productId: 1, productName: "A", quantity: 2, returnedQuantity: 1, totalCents: 8_000, returnedCents: 4_000 },
      { productId: 2, productName: "B", quantity: 1, returnedQuantity: 0, totalCents: 2_000, returnedCents: 0 },
    ],
  };
  assert.equal(pdvNetSalesSource({ ...base, status: "cancelled" }), null);
  assert.equal(pdvNetSalesSource({ ...base, status: "refunded" }), null);
  assert.equal(pdvNetSalesSource({ ...base, status: "return_pending" }), null);
  const partial = pdvNetSalesSource({ ...base, status: "partially_returned" });
  assert.equal(partial?.total, 60);
  assert.deepEqual(partial?.items.map(({ quantity, revenue }) => ({ quantity, revenue })), [
    { quantity: 1, revenue: 40 },
    { quantity: 1, revenue: 20 },
  ]);
});
