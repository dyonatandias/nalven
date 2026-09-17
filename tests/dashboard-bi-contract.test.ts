import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const root = fileURLToPath(new URL("..", import.meta.url));
const read = (path: string) => readFileSync(join(root, path), "utf8");
const route = read("app/api/erp/dashboard/route.ts");
const workspace = read("components/erp/business-intelligence-dashboard.tsx");
const styles = read("components/erp/business-intelligence-dashboard.module.css");
const legacyRoute = read("app/api/erp/route.ts");

test("dashboard usa métricas canônicas, líquidas e isoladas por filial", () => {
  for (const evidence of [
    'reportContext("dashboard.read")',
    "salesPeriod(params, timezone)",
    "pdvNetSalesSource(row)",
    'sourceType: "sales_order"',
    "linkedIds.has(String(row.id))",
    "refundedTotal",
    "compareMetric",
    "branchConfigurations[0]?.costOverride",
    "warehouse: { branchId }",
  ]) assert.match(route, new RegExp(evidence.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.match(route, /previousStart/);
  assert.match(route, /current\.summary\.revenue - currentCogs/);
  assert.match(route, /available = round\(physical - reserved\)/);
});

test("interface entrega filtros, comparação, análises e saída acionável", () => {
  for (const evidence of [
    "Comparar período anterior",
    "Exportar resumo",
    "Leitura automática",
    "Evolução diária",
    "Receita por dia da semana",
    "Quem impulsiona o resultado",
    "Canais e pagamentos",
    "Cobertura e reposição",
    "Pipeline de pedidos",
    "Critérios e governança dos indicadores",
  ]) assert.match(workspace, new RegExp(evidence, "i"));
  assert.match(workspace, /period === "custom"/);
  assert.match(workspace, /buildInsights\(data\)/);
  assert.match(workspace, /\/erp\/movimentacoes-estoque\?produto=/);
});

test("dashboard legado deixa de carregar históricos brutos e o layout cobre quatro faixas", () => {
  assert.match(legacyRoute, /const needsProducts = \["products", "stock", "pdv"\]/);
  assert.match(legacyRoute, /const needsMovements = scope === "stock"/);
  assert.match(legacyRoute, /const needsSales = false/);
  for (const breakpoint of ["1180px", "900px", "650px", "420px"]) assert.match(styles, new RegExp(`max-width:${breakpoint}`));
  assert.match(styles, /\.kpis\{display:grid/);
  assert.match(styles, /\.analyticsGrid\{display:grid/);
  assert.match(styles, /\.detailGrid\{display:grid/);
});
