import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const root = fileURLToPath(new URL("..", import.meta.url));
const source = (path: string) => readFileSync(join(root, path), "utf8");

test("fechamento legado é somente leitura e não contorna o domínio PDV", () => {
  const route = source("app/api/erp/cash-close/route.ts");
  const client = source("app/erp/erp-client.tsx");
  const cashCloseCenter = source("components/erp/cash-close-control-center.tsx");
  const post = route.slice(route.indexOf("export async function POST"));

  assert.match(post, /assertSameOrigin\(request\)/);
  assert.match(post, /assertPosMutationRequest\(request\)/);
  assert.match(
    post,
    /assertTenantPermission\(organization\.id, "cash-close\.write"\)/,
  );
  assert.match(post, /assertTenantWriteAccess\(organization\.id\)/);
  assert.match(post, /status: 410/);
  assert.match(post, /mutações do fechamento legado foram desativadas/);
  assert.doesNotMatch(post, /cashRegisterSession\.(?:create|update)/);
  assert.doesNotMatch(post, /cashRegisterEvent\.create/);
  assert.doesNotMatch(post, /request\.json\(/);
  assert.doesNotMatch(route, /calculatedExpected/);
  assert.doesNotMatch(client, /function CashModal/);
  assert.doesNotMatch(client, /setModal\(\{ mode: "open"/);
  assert.match(client, /if \(page === "cash-close"\) return <CashCloseControlCenter \/>/);
  assert.match(cashCloseCenter, /href="\/erp\/pdv"/);
  assert.match(cashCloseCenter, /Oculto até o fechamento/);
});
