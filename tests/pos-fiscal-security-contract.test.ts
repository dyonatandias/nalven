import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const projectRoot = fileURLToPath(new URL("..", import.meta.url));

function source(path: string) {
  return readFileSync(join(projectRoot, path), "utf8");
}

test("retorno e cancelamento fiscal não podem ser atestados por ação humana", () => {
  const route = source("app/api/erp/fiscal/route.ts");
  const client = source("app/erp/erp-client.tsx");
  const trustedSourceGuard = route.indexOf(
    'if (body.action === "response" || body.action === "cancel")',
  );

  assert.ok(
    trustedSourceGuard >= 0,
    "a API deve falhar fechada para ações legadas",
  );
  assert.ok(
    trustedSourceGuard <
      route.indexOf('if (body.action === "document.create")'),
    "o bloqueio deve ocorrer antes das mutações de documento",
  );
  assert.match(route, /status: 409/);
  assert.match(route, /conector fiscal autenticado e homologado/);
  assert.doesNotMatch(route, /status = choice\(body\.status, \["authorized"/);
  assert.doesNotMatch(route, /action: "fiscal_document\.cancelled"/);
  assert.doesNotMatch(client, /Registrar retorno do autorizador/);
  assert.doesNotMatch(client, /name="accessKey"/);
  assert.doesNotMatch(client, /name="protocol"/);
  assert.doesNotMatch(client, /onClick=\{\(\) => setModal\(\{ mode: "cancel"/);
  assert.match(client, /Aguardando conector fiscal homologado/);
});

test("mutação fiscal valida origem, Fetch Metadata, JSON, tamanho, licença e taxa", () => {
  const route = source("app/api/erp/fiscal/route.ts");
  assert.match(route, /assertSameOrigin\(request\)/);
  assert.match(route, /assertPosMutationRequest\(request\)/);
  assert.match(
    route,
    /assertTenantPermission\(organization\.id, "fiscal\.write"\)/,
  );
  assert.match(route, /assertTenantWriteAccess\(organization\.id\)/);
  assert.match(route, /readPosJson\(request, 1_600_000\)/);
  assert.match(
    route,
    /enforcePosRateLimit\(db, access\.user\.id, "fiscal\.mutation"\)/,
  );
  assert.match(route, /canIssueFiscal: true/);
  assert.match(route, /assertFiscalBranchAccess\(/);
  assert.match(route, /source\.branchId !== branchId/);
  assert.match(route, /cache-control/);
});
