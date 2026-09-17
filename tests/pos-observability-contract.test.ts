import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const root = fileURLToPath(new URL("..", import.meta.url));
const route = readFileSync(join(root, "app/api/erp/pdv/observability/route.ts"), "utf8");
const domain = readFileSync(join(root, "lib/erp/pos-observability.ts"), "utf8");
const panel = readFileSync(join(root, "components/erp/pdv-observability-admin.tsx"), "utf8");
const dialog = readFileSync(join(root, "components/erp/pdv-admin-dialog.tsx"), "utf8");

test("observabilidade exige pdv.read, papel privilegiado e filial ativa do tenant", () => {
  assert.match(route, /assertTenantPermission\(organization\.id, "pdv\.read"\)/);
  assert.match(route, /\["owner", "admin"\]\.includes\(actor\.membership\.role\)/);
  assert.match(route, /tenantDb\(organization\.id\)/);
  assert.match(route, /where:\s*\{\s*id:\s*branchId,\s*status:\s*"active"\s*\}/);
  assert.doesNotMatch(route, /tenantId|tenant_id/);
});

test("resposta e erros de observabilidade nunca podem ser armazenados em cache", () => {
  assert.match(route, /"cache-control":\s*"no-store, max-age=0"/);
  assert.match(route, /Response\.json\([\s\S]*?headers:\s*noStoreHeaders/);
  assert.match(route, /PosObservabilityError[\s\S]*?headers:\s*noStoreHeaders/);
  assert.match(route, /AuthError[\s\S]*?status:\s*error\.status,\s*headers:\s*noStoreHeaders/);
  assert.match(panel, /fetch\(`\/api\/erp\/pdv\/observability\?\$\{parameters\}`,\s*\{\s*cache:\s*"no-store"\s*\}\)/);
});

test("query possui allowlist e limites finitos", () => {
  assert.match(domain, /new Set\(\["branchId", "windowHours", "limit"\]\)/);
  assert.match(domain, /maximumWindowHours:\s*720/);
  assert.match(domain, /maximumDetailLimit:\s*50/);
  assert.match(domain, /diagnosticScanLimit:\s*500/);
  assert.match(domain, /parameters\.getAll\(key\)\.length !== 1/);
  assert.match(route, /take:\s*limit/g);
  assert.match(route, /take:\s*scanLimit \+ 1/g);
});

test("DTO operacional omite PII, credenciais, hashes, payloads e erros abertos", () => {
  for (const forbidden of ["codeHash", "tokenHash", "credentialRef", "certificateFingerprint", "cardLastFour", "authorizationCode", "transactionId", "endToEndId", "lastError", "requestHash", "payload", "openedBy", "closedBy", "displayName", "email", "document"]) {
    assert.doesNotMatch(route, new RegExp(`\\b${forbidden}\\b`), `campo sensível no DTO: ${forbidden}`);
  }
  assert.doesNotMatch(route, /select:\s*\{[^}]*\b(?:response|conflict):\s*true/);
  assert.match(route, /operatorProfileId:\s*true/);
  assert.match(route, /resource:\s*\{\s*type:/);
  assert.match(route, /payments:\s*payments\.filter[\s\S]*?type:\s*item\.type,\s*method:\s*item\.method,\s*status:\s*item\.status,\s*count:/);
});

test("painel isolado preserva inventário e promoções no diálogo administrativo", () => {
  assert.match(dialog, /import \{ PdvInventoryAdmin \}/);
  assert.match(dialog, /import \{ PdvPromotionsAdmin \}/);
  assert.match(dialog, /import \{ PdvObservabilityAdmin \}/);
  assert.match(dialog, /<PdvObservabilityAdmin branchId=\{data\.branch\.id\} \/>[\s\S]*?<PdvInventoryAdmin branchId=\{data\.branch\.id\} onChanged=\{onChanged\} \/>[\s\S]*?<PdvPromotionsAdmin/);
  assert.doesNotMatch(panel, /dangerouslySetInnerHTML/);
});
