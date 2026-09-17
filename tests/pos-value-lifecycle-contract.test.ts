import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const root = fileURLToPath(new URL("..", import.meta.url));
const source = (path: string) => readFileSync(join(root, path), "utf8");
const lifecycle = source("lib/erp/pos-value-lifecycle.ts");
const lifecycleHttp = source("lib/erp/pos-value-lifecycle-http.ts");
const internalRoute = source("app/api/internal/pdv/value-accounts/sweep/route.ts");
const liability = source("lib/erp/pos-value-liability.ts");
const liabilityRoute = source("app/api/erp/pdv/value-accounts/liability/route.ts");
const panel = source("components/erp/pdv-value-liability-admin.tsx");
const valueAdmin = source("components/erp/pdv-value-accounts-admin.tsx");

test("sweep usa locks, serializable, retry e efeitos idempotentes no ledger", () => {
  assert.match(lifecycle, /pos_value_reservations[\s\S]*?FOR UPDATE/);
  assert.match(lifecycle, /pos_value_accounts[\s\S]*?FOR UPDATE/);
  assert.match(lifecycle, /isolationLevel: "Serializable"/);
  assert.match(lifecycle, /pg_try_advisory_xact_lock/);
  assert.match(lifecycle, /isPosValueLifecycleSerializationConflict\(error\)/);
  assert.match(lifecycle, /lifecycleOperationKey\("release", reservation\.id\)/);
  assert.match(lifecycle, /lifecycleOperationKey\("expire", account\.id\)/);
  assert.match(lifecycle, /applyPosValueMaintenanceCommand\(tx/);
  assert.match(lifecycle, /pos\.value\.reservation\.expired/);
  assert.match(lifecycle, /pos\.value\.account\.expired/);
  assert.doesNotMatch(lifecycle, /posValueLedgerEntry\.(?:update|delete)/);
});

test("job interno exige token forte, JSON limitado, pagina tenants e limita taxa persistentemente", () => {
  assert.match(lifecycleHttp, /timingSafeEqual/);
  assert.match(lifecycleHttp, /expectedValid = \/\^\[\\x21-\\x7e\]\{32,512\}\$\//);
  assert.match(lifecycleHttp, /createHash\("sha256"\)[\s\S]*?timingSafeEqual\(expected, received\)/);
  assert.match(lifecycleHttp, /new Set\(\["action", "organizationLimit", "itemLimit", "afterOrganizationId"\]\)/);
  assert.match(internalRoute, /assertPosValueLifecycleJobAuthorization\(request\)[\s\S]*?assertPosMutationRequest\(request\)/);
  assert.match(internalRoute, /readPosJson\(request, 4_096\)/);
  assert.match(internalRoute, /status: \{ in: \["active", "trial"\] \}/);
  assert.match(internalRoute, /database: \{ status: "active" \}/);
  assert.match(internalRoute, /id: \{ gt: input\.afterOrganizationId \}/);
  assert.match(internalRoute, /take: input\.organizationLimit \+ 1/);
  assert.match(internalRoute, /tenantDb\(organization\.id\)/);
  assert.match(internalRoute, /enforcePosRateLimit\(db, POS_VALUE_LIFECYCLE_ACTOR, "value\.lifecycle\.sweep"\)/);
  assert.match(internalRoute, /status: failed \? 503 : 200/);
  assert.match(internalRoute, /"cache-control": "no-store, max-age=0"/);
  assert.doesNotMatch(internalRoute, /assertTenantWriteAccess/);
});

test("relatório de passivo é tenant/filial, somente admin e agregado sem PII ou segredos", () => {
  assert.match(liabilityRoute, /assertSameOrigin\(request\)/);
  assert.match(liabilityRoute, /assertTenantPermission\(organization\.id, "pdv\.read"\)/);
  assert.match(liabilityRoute, /\["owner", "admin"\]\.includes\(actor\.membership\.role\)/);
  assert.match(liabilityRoute, /tenantDb\(organization\.id\)/);
  assert.match(liabilityRoute, /where: \{ id: branchId, status: "active" \}/);
  assert.match(liabilityRoute, /"cache-control": "no-store, max-age=0"/);
  assert.match(liability, /a\."branch_id" = \$\{branchId\}/);
  assert.match(liability, /GROUP BY a\."kind", a\."unit", a\."status", "aging_bucket"/);
  for (const forbidden of ["customerId", "customer_id", "codeHash", "code_hash", "pinHash", "pin_hash", "label", "email", "document", "requestHash", "request_hash"]) {
    assert.doesNotMatch(liability, new RegExp(`\\b${forbidden}\\b`), `relatório não pode consultar/expor ${forbidden}`);
    assert.doesNotMatch(liabilityRoute, new RegExp(`\\b${forbidden}\\b`), `rota não pode consultar/expor ${forbidden}`);
  }
});

test("painel administrativo isolado busca somente o DTO agregado sem cache", () => {
  assert.match(panel, /fetch\(`\/api\/erp\/pdv\/value-accounts\/liability\?branchId=\$\{branchId\}`,[\s\S]*?cache: "no-store"/);
  assert.match(panel, /Agregado por natureza, estado e idade, sem dados de cliente ou credenciais/);
  assert.doesNotMatch(panel, /dangerouslySetInnerHTML|localStorage|sessionStorage/);
  assert.match(valueAdmin, /import \{ PdvValueLiabilityAdmin \}/);
  assert.match(valueAdmin, /<PdvValueLiabilityAdmin branchId=\{branchId\} \/>/);
});
