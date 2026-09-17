import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const root = fileURLToPath(new URL("..", import.meta.url));
const workspace = readFileSync(join(root, "app/erp/erp-client.tsx"), "utf8");
const route = readFileSync(join(root, "app/api/erp/route.ts"), "utf8");
const styles = readFileSync(join(root, "app/erp/enhancements.css"), "utf8");

test("workspace de estoque oferece operação guiada e trilha pesquisável", () => {
  for (const evidence of [
    "stock-summary",
    "stock-balance-preview",
    "Histórico de movimentações",
    "Exportar CSV",
    "historyPeriod",
    "stock-history-pagination",
    "Registro auditável",
    "/erp/movimentacoes-estoque?produto=",
  ]) assert.match(workspace, new RegExp(evidence.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.match(workspace, /canManageStock[^\n]+false/);
  assert.match(workspace, /maxLength=\{500\}/);
});

test("endpoint rejeita movimentações malformadas antes de alterar saldo", () => {
  const guard = route.indexOf('if (body.type !== "entry" && body.type !== "exit")');
  const mutation = route.indexOf("tx.warehouseBalance.updateMany", guard);
  assert.ok(guard >= 0, "validação explícita do tipo ausente");
  assert.ok(mutation > guard, "a validação deve anteceder a primeira mutação de saldo");
  assert.match(route, /Number\.isFinite\(quantity\)/);
  assert.match(route, /note\.length > 500/);
  assert.match(route, /!product\.active \|\| !product\.manageStock/);
});

test("layout possui adaptações para desktop, tablet e celular estreito", () => {
  for (const breakpoint of ["1180px", "980px", "700px", "440px"]) assert.match(styles, new RegExp(`max-width:${breakpoint}`));
  assert.match(styles, /\.stock-main-grid\{display:grid/);
  assert.match(styles, /\.stock-type-picker\{[^}]*grid-template-columns:1fr 1fr/);
  assert.match(styles, /\.stock-summary\{display:grid/);
});
