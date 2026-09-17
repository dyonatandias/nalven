import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  allowedFiscalOperation,
  fiscalDocumentCsv,
  FiscalControlInputError,
  operationDueAt,
  parseFiscalQuery,
} from "../lib/erp/fiscal-control";

const route = readFileSync("app/api/erp/fiscal/route.ts", "utf8");
const workspace = readFileSync("components/erp/fiscal-center.tsx", "utf8");
const css = readFileSync("components/erp/fiscal-center.module.css", "utf8");
const client = readFileSync("app/erp/erp-client.tsx", "utf8");
const schema = readFileSync("prisma/tenant/schema.prisma", "utf8");
const hardening = readFileSync("prisma/tenant/migrations/20260902050000_fiscal_center_hardening/migration.sql", "utf8");
const operationsMigration = readFileSync("prisma/tenant/migrations/20260903050000_fiscal_operations_control_center/migration.sql", "utf8");
const seed = readFileSync("scripts/seed-demo-fiscal-center.ts", "utf8");

test("central fiscal consolida domínios, fila, BI operacional e filtros avançados", () => {
  assert.match(client, /<FiscalCenter\s*\/>/);
  for (const contract of ["Visão geral", "Fila operacional", "Emissões", "PDV fiscal", "DF-e recebidos", "Certificados A1", "role=\"search\"", "aria-live=\"polite\"", "Taxa de autorização", "Exportar CSV", "Inutilizar faixa"])
    assert.match(workspace, new RegExp(contract));
  assert.match(route, /posFiscalDocument\.findMany/);
  assert.match(route, /inboundFiscalDocument\.findMany/);
  assert.match(route, /fiscalOperation\.findMany/);
  assert.match(route, /fiscalTrend/);
  assert.match(route, /authorizationRate/);
  assert.match(route, /format === "csv"/);
  assert.match(css, /@media \(max-width: 520px\)/);
  assert.match(css, /prefers-reduced-motion/);
  assert.doesNotMatch(css, /font-size:\s*[789]px/);
});

test("consulta valida filtros, datas e paginação", () => {
  const query = parseFiscalQuery(new URLSearchParams("status=authorized&type=nfe&environment=production&branchId=2&from=2026-08-01&to=2026-08-31&page=3&limit=24"));
  assert.equal(query.status, "authorized");
  assert.equal(query.type, "nfe");
  assert.equal(query.environment, "production");
  assert.equal(query.branchId, 2);
  assert.equal(query.page, 3);
  assert.equal(query.limit, 24);
  assert.equal(query.from?.toISOString(), "2026-08-01T00:00:00.000Z");
  assert.equal(query.toExclusive?.toISOString(), "2026-09-01T00:00:00.000Z");
  assert.throws(() => parseFiscalQuery(new URLSearchParams("from=2026-09-10&to=2026-09-01")), FiscalControlInputError);
  assert.throws(() => parseFiscalQuery(new URLSearchParams("status=forged")), FiscalControlInputError);
  assert.throws(() => parseFiscalQuery(new URLSearchParams("limit=500")), FiscalControlInputError);
});

test("matriz de operações impede transições fiscais incoerentes", () => {
  assert.equal(allowedFiscalOperation("retry", { status: "rejected", type: "nfe" }), true);
  assert.equal(allowedFiscalOperation("retry", { status: "authorized", type: "nfe" }), false);
  assert.equal(allowedFiscalOperation("contingency", { status: "processing", type: "nfce" }), true);
  assert.equal(allowedFiscalOperation("cancellation", { status: "authorized", type: "nfse" }), true);
  assert.equal(allowedFiscalOperation("correction", { status: "authorized", type: "nfe" }), true);
  assert.equal(allowedFiscalOperation("correction", { status: "authorized", type: "nfce" }), false);
  assert.equal(allowedFiscalOperation("invalidation", null), true);
  assert.equal(allowedFiscalOperation("issuance", { status: "draft", type: "nfe" }), false);
  const now = new Date("2026-09-03T12:00:00.000Z");
  assert.equal(operationDueAt("status_query", now).toISOString(), "2026-09-03T12:10:00.000Z");
  assert.equal(operationDueAt("correction", now).toISOString(), "2026-09-03T13:00:00.000Z");
});

test("exportação fiscal neutraliza fórmulas e preserva valores exatos", () => {
  const csv = fiscalDocumentCsv([{
    branch: { code: "M01", name: "Matriz" }, type: "nfe", series: 1, number: 90,
    status: "authorized", environment: "production", recipient: "=HYPERLINK(\"x\")",
    amountCents: 12345, accessKey: "1".repeat(44), protocol: "P90", rejectionCode: null,
    rejectionMessage: null, issuedAt: new Date("2026-09-03T10:00:00.000Z"), cancelledAt: null,
    createdAt: new Date("2026-09-03T09:59:00.000Z"),
  }]);
  assert.match(csv, /123\.45/);
  assert.match(csv, /'=HYPERLINK/);
  assert.match(csv, /P90/);
});

test("API preserva segredos, escopo, concorrência e retornos externos", () => {
  assert.doesNotMatch(route, /encryptedContent:\s*true|encryptedPassword:\s*true|saleSnapshot:\s*true|snapshotHash:\s*true/);
  assert.match(route, /fiscalCertificate\.findMany\([\s\S]*select:/);
  assert.match(route, /connectors: connectors\.map/);
  assert.doesNotMatch(route, /connectors, cursors, operations/);
  assert.match(route, /assertFiscalBranchAccess/);
  assert.match(route, /TransactionIsolationLevel\.Serializable/);
  assert.match(route, /branch_settings[^`]+FOR UPDATE/);
  assert.match(route, /sales_orders[^`]+FOR UPDATE/);
  assert.match(route, /fiscal_operations[^`]+FOR UPDATE/);
  assert.match(route, /operation\.resolve/);
  assert.match(route, /conector fiscal autenticado e homologado/);
  assert.match(route, /private, no-store/);
  assert.match(route, /Não foi possível concluir a operação fiscal/);
  assert.doesNotMatch(route, /error instanceof Error \? error\.message : "Erro fiscal/);
});

test("persistência fiscal garante centavos, unicidade aberta e eventos imutáveis", () => {
  assert.match(schema, /model FiscalOperation/);
  assert.match(schema, /amountCents\s+Int/);
  assert.match(schema, /operations\s+FiscalOperation\[\]/);
  assert.match(hardening, /one_active_per_branch/);
  assert.match(hardening, /fiscal_events_append_only/);
  assert.match(operationsMigration, /fiscal_documents_sync_amount/);
  assert.match(operationsMigration, /fiscal_operations_one_open_per_document_type_idx/);
  assert.match(operationsMigration, /fiscal_operations_resolution_check/);
  assert.match(operationsMigration, /CHECK \("amount_cents" >= 0\)/);
});

test("seed demo cobre volume, exceções, SLA, correção, cancelamento e inutilização", () => {
  assert.match(seed, /central-fiscal-demo-v2/);
  assert.match(seed, /scenarioStatuses/);
  assert.match(seed, /correction/);
  assert.match(seed, /cancellation/);
  assert.match(seed, /invalidation/);
  assert.match(seed, /demo-fiscal-simulator/);
  assert.match(seed, /nalven_t_demo_runtime/);
  assert.match(seed, /NALVEN_ALLOW_DEMO_FISCAL_SEED/);
});
