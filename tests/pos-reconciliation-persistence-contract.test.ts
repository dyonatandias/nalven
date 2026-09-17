import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const schema = read("prisma/tenant/schema.prisma");
const migration = read("prisma/tenant/migrations/20260829170000_pos_reconciliation_persistence/migration.sql");
const persistence = read("lib/erp/pos-reconciliation-persistence.ts");
const layout = read("lib/erp/pos-reconciliation-layout.ts");
const input = read("lib/erp/pos-reconciliation-admin.ts");
const route = read("app/api/erp/pdv/reconciliation/route.ts");
const job = read("app/api/internal/pdv/reconciliation/process/route.ts");
const jobHttp = read("lib/erp/pos-reconciliation-http.ts");
const ui = read("components/erp/pdv-reconciliation-admin.tsx");
const dialog = read("components/erp/pdv-admin-dialog.tsx");

test("schema persiste layout, lote, linhas, runs e issues com idempotência provider/digest", () => {
  for (const model of ["PosReconciliationLayout", "PosReconciliationBatch", "PosReconciliationLine", "PosReconciliationRun", "PosReconciliationIssue"]) assert.match(schema, new RegExp(`model ${model} \\{`));
  assert.match(schema, /@@unique\(\[provider, digest\]\)/);
  assert.match(schema, /requestKey\s+String\s+@unique/);
  assert.match(schema, /operationKey\s+String\s+@unique/);
  assert.match(schema, /layoutSnapshot\s+Json/);
  assert.match(schema, /referenceHash\s+String/);
  assert.doesNotMatch(schema, /model PosReconciliation(?:Batch|Run|Issue)[\s\S]{0,1200}(?:cardNumber|customerDocument|rawFile|fileName)/);
});

test("migration aplica checks e torna evidência normalizada imutável", () => {
  assert.match(migration, /UNIQUE \("provider", "digest"\)/);
  assert.match(migration, /row_count" BETWEEN 1 AND 10000/);
  assert.match(migration, /reference_hash" ~ '\^\[0-9a-f\]\{64\}\$'/);
  for (const table of ["pos_reconciliation_lines", "pos_reconciliation_runs", "pos_reconciliation_issues"]) assert.match(migration, new RegExp(`${table}_immutable`));
  assert.match(migration, /BEFORE UPDATE OR DELETE/);
  assert.match(migration, /pos_reconciliation_batch_guard/);
  assert.match(migration, /NEW\."digest" <> OLD\."digest"/);
});

test("processamento usa SERIALIZABLE, lock, versão esperada, CAS e retry P2034", () => {
  assert.match(persistence, /isolationLevel: "Serializable"/);
  assert.match(persistence, /FOR UPDATE/);
  assert.match(persistence, /batch\.version !== input\.expectedVersion/);
  assert.match(persistence, /updateMany\(\{ where: \{ id: batch\.id, version: batch\.version \}/);
  assert.match(persistence, /updated\.count !== 1/);
  assert.match(persistence, /serializationRetries: 3/);
  assert.match(persistence, /P2034/);
  assert.match(persistence, /operationKey/);
  assert.match(persistence, /posReconciliationRun\.findUnique/);
});

test("linhas/resultados/issues e auditoria não propagam referências brutas aos DTOs", () => {
  assert.match(persistence, /posReconciliationLine\.createMany/);
  assert.match(persistence, /posReconciliationRun\.create/);
  assert.match(persistence, /posReconciliationIssue\.createMany/);
  assert.match(persistence, /pos\.reconciliation\.batch\.imported/);
  assert.match(persistence, /pos\.reconciliation\.batch\.processed/);
  assert.match(persistence, /posReconciliationReferenceHash/);
  const batchDto = persistence.slice(persistence.indexOf("export function batchDto"), persistence.indexOf("function runDto"));
  assert.doesNotMatch(batchDto, /transactionId|settlementId|importedBy|requestKey|requestHash/);
  assert.match(batchDto, /digestPrefix/);
  assert.doesNotMatch(ui, /batch\.(?:transactionId|settlementId|referenceHash|cardLastFour|authorizationCode)/);
  assert.doesNotMatch(ui, /dangerouslySetInnerHTML/);
});

test("parser limita bytes/linhas, normaliza UTF-8 e export usa proteção de CSV injection", () => {
  assert.match(layout, /maximumBytes: 768 \* 1024/);
  assert.match(layout, /maximumRows: 10_000/);
  assert.match(layout, /TextDecoder\("utf-8", \{ fatal: true \}\)/);
  assert.match(route, /csvFile\(/);
  assert.match(input, /Buffer\.byteLength\(body\.csv, "utf8"\)/);
  assert.match(route, /readPosJson\(request, 1_048_576\)/);
});

test("API administrativa exige same-origin, RBAC owner/admin, licença, rate limit e no-store", () => {
  assert.match(route, /assertSameOrigin\(request\)/);
  assert.match(route, /assertPosMutationRequest\(request\)/);
  assert.match(route, /reconciliation\.read/);
  assert.match(route, /reconciliation\.write/);
  assert.match(route, /\["owner", "admin"\]/);
  assert.match(route, /assertTenantWriteAccess/);
  assert.match(route, /enforcePosRateLimit/);
  assert.match(route, /no-store, max-age=0/);
  assert.match(route, /allowed = new Set\(\["branchId", "limit", "format"\]\)/);
  assert.match(route, /limit < 1 \|\| limit > 50/);
});

test("job interno autentica antes do body, pagina tenants ativos e limita trabalho", () => {
  const auth = job.indexOf("assertPosReconciliationJobAuthorization(request)"), body = job.indexOf("readPosJson(request");
  assert.ok(auth >= 0 && body > auth);
  assert.match(jobHttp, /timingSafeEqual/);
  assert.match(jobHttp, /\{32,512\}/);
  assert.match(jobHttp, /maximumOrganizationLimit: 100/);
  assert.match(jobHttp, /maximumBatchLimit: 50/);
  assert.match(job, /status: \{ in: \["active", "trial"\] \}/);
  assert.match(job, /database: \{ status: "active" \}/);
  assert.match(job, /afterOrganizationId/);
  assert.match(job, /reconciliation\.process/);
  assert.match(job, /no-store, max-age=0/);
  assert.doesNotMatch(job, /assertTenantWriteAccess/);
});

test("UI é isolada, usa no-store, limite local, idempotência e integração mínima no diálogo", () => {
  assert.match(ui, /cache: "no-store"/);
  assert.match(ui, /crypto\.randomUUID\(\)/);
  assert.match(ui, /file\.size > 768 \* 1024/);
  assert.match(ui, /expectedVersion: batch\.version/);
  assert.match(ui, /format=csv/);
  assert.match(dialog, /import \{ PdvReconciliationAdmin \}/);
  assert.match(dialog, /<PdvReconciliationAdmin branchId=\{data\.branch\.id\} \/>/);
});

function read(path: string) { return readFileSync(new URL(`../${path}`, import.meta.url), "utf8"); }
