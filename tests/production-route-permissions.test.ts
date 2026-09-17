import assert from "node:assert/strict";
import test from "node:test";
import { createRequire } from "node:module";
import { build } from "esbuild";

// Exercise the real HTTP handlers and permission evaluator. Only session/storage,
// license transport and business writers are substituted; this is not login E2E.
test("rotas de produção respeitam sessão, vínculo, perfil, escopos extras e licença antes de executar", async t => {
  const mocks: Record<string, string> = {
    "test:state": `export const state = { user: null, permissions: [], profile: null, writes: 0, reads: 0, licensed: true, tenantIds: [] };`,
    "@/lib/auth": `import { state } from "test:state";
      export class AuthError extends Error { constructor(status) { super("Acesso negado"); this.status = status; } }
      export const currentUser = async () => state.user;
      export const authErrorResponse = error => Response.json({error:error.message},{status:error.status,headers:{"cache-control":"private, no-store"}});`,
    "@/db": `import { state } from "test:state"; import { AuthError } from "@/lib/auth";
      export const currentOrganization = async () => { if (!state.user) throw new AuthError(401); return {id:"tenant-a"}; };
      export const tenantDb = async id => { state.tenantIds.push(id); return {
        tenantRole: { findFirst: async () => ({permissions:state.permissions}) },
        tenantUserProfile: { findUnique: async () => state.profile }
      }; };`,
    "@/db/tenant": `export { tenantDb } from "@/db";`,
    "@/lib/billing/license": `export class LicenseDeniedError extends Error { status = 403; }`,
    "@/lib/tenant-access": `import {state} from "test:state"; import {LicenseDeniedError} from "@/lib/billing/license";
      export const assertTenantWriteAccess = async () => { if (!state.licensed) throw new LicenseDeniedError("Licença bloqueada"); };`,
    "@/lib/erp/production-service": `import {state} from "test:state"; export const executeProductionCommand = async () => { state.writes++; return {ok:true}; };`,
    "@/lib/erp/production-query": `import {state} from "test:state"; export const productionRead = async () => { state.reads++; return {items:[]}; };`,
    "@/lib/erp/pos-common-stock": `export class PosCommonStockError extends Error {}`,
    "@/lib/erp/pos-inventory-tracking": `export class PosInventoryTrackingError extends Error {}`,
  };
  const bundled = await build({
    stdin: { contents: 'export { GET, POST } from "./app/api/erp/production/operations/route"; export {state} from "test:state";', resolveDir: process.cwd(), loader: "ts" },
    bundle: true, write: false, platform: "node", format: "cjs", packages: "external",
    plugins: [{ name: "isolated-route-dependencies", setup(plugin) {
      plugin.onResolve({ filter: /.*/ }, args => args.path in mocks ? { path: args.path, namespace: "fixture" } : undefined);
      plugin.onLoad({ filter: /.*/, namespace: "fixture" }, args => ({ contents: mocks[args.path], loader: "js" }));
    } }],
  });
  type State = { user: { id: string; name: string; memberships: { organizationId: string; status: string; role: string; organization: { modules: string[] } }[] } | null; permissions: string[]; profile: { status: string; accessExpiresAt?: Date } | null; writes: number; reads: number; licensed: boolean; tenantIds: string[] };
  const routeModule = { exports: {} };
  new Function("require", "module", "exports", bundled.outputFiles[0].text)(createRequire(import.meta.url), routeModule, routeModule.exports);
  const { GET, POST, state } = routeModule.exports as { GET: (r: Request) => Promise<Response>; POST: (r: Request) => Promise<Response>; state: State };
  function reset() {
    Object.assign(state, { user: { id: "operator", name: "Operador", memberships: [{ organizationId: "tenant-a", status: "active", role: "operator", organization: { modules: ["*"] } }] }, permissions: ["production.write"], profile: { status: "active" }, writes: 0, reads: 0, licensed: true, tenantIds: [] });
  }
  const request = (action = "order.create", origin = "http://localhost") => new Request("http://localhost/api/erp/production/operations", { method: "POST", headers: { origin, "content-type": "application/json" }, body: JSON.stringify({ action }) });
  async function denied(expected = 403, action = "order.create", origin?: string) {
    const response = await POST(request(action, origin)); assert.equal(response.status,expected); assert.equal(state.writes,0); assert.match(response.headers.get("cache-control") || "", /no-store/);
  }
  await t.test("sem sessão não lê nem escreve", async () => { reset(); state.user = null; assert.equal((await GET(new Request("http://localhost/api/erp/production"))).status,401); await denied(401); assert.equal(state.reads,0); });
  await t.test("vínculo de outra empresa e vínculo inativo são recusados", async () => { reset(); state.user!.memberships[0].organizationId = "tenant-b"; await denied(); reset(); state.user!.memberships[0].status = "inactive"; await denied(); });
  await t.test("leitor consulta mas não altera ordens", async () => { reset(); state.permissions = ["production.read"]; assert.equal((await GET(new Request("http://localhost/api/erp/production"))).status,200); assert.equal(state.reads,1); await denied(); });
  await t.test("perfil suspenso ou vencido não escreve", async () => { reset(); state.profile = { status: "suspended" }; await denied(); reset(); state.profile = { status: "active", accessExpiresAt: new Date("2000-01-01") }; await denied(); });
  await t.test("compra exige produção e compras; transferência exige inventário", async () => { reset(); await denied(403,"mrp.purchase"); await denied(403,"mrp.transfer"); state.permissions.push("purchases.write"); assert.equal((await POST(request("mrp.purchase"))).status,200); state.permissions.push("inventory.write"); assert.equal((await POST(request("mrp.transfer"))).status,200); assert.equal(state.writes,2); assert.ok(state.tenantIds.every(id => id === "tenant-a")); });
  await t.test("licença bloqueia inclusive proprietário", async () => { reset(); state.user!.memberships[0].role = "owner"; state.licensed = false; await denied(); });
  await t.test("plano explícito bloqueia leitura e escrita mesmo com proprietário", async () => { reset(); state.user!.memberships[0].role = "owner"; state.user!.memberships[0].organization.modules = ["@policy:v1", "menu:production"]; assert.equal((await GET(new Request("http://localhost/api/erp/production"))).status,403); await denied(); assert.equal(state.reads,0); });
  await t.test("plano de consulta permite GET mas não comandos", async () => { reset(); state.user!.memberships[0].role = "owner"; state.user!.memberships[0].organization.modules = ["@policy:v1", "production.read"]; assert.equal((await GET(new Request("http://localhost/api/erp/production"))).status,200); await denied(); });
  await t.test("operação composta também exige recurso adicional no plano", async () => { reset(); state.user!.memberships[0].role = "owner"; state.user!.memberships[0].organization.modules = ["@policy:v1", "production.read", "production.write"]; await denied(403,"mrp.purchase"); state.user!.memberships[0].organization.modules.push("purchases.read", "purchases.write"); assert.equal((await POST(request("mrp.purchase"))).status,200); });
  await t.test("origem externa é recusada antes do comando", async () => { reset(); await denied(403,"order.create","https://external.invalid"); });
  await t.test("permissão completa executa e não permite cache público", async () => { reset(); const response = await POST(request()); assert.equal(response.status,200); assert.equal(state.writes,1); assert.equal(response.headers.get("cache-control"),"private, no-store"); });
});
