import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";
import { build } from "esbuild";

test("autorizador real aplica política do plano antes do proprietário e do perfil", async () => {
  const mocks: Record<string, string> = {
    "test:state": `export const state={modules:['@policy:v1','products.read'],role:'owner',status:'active',permission:['*'],tenantReads:0};`,
    "@/lib/auth": `import {state} from 'test:state';export class AuthError extends Error{constructor(status){super('negado');this.status=status;}}export async function currentUser(){return{id:'user-a',memberships:[{organizationId:'org-a',role:state.role,status:state.status,organization:{modules:state.modules}}]};}`,
    "@/db/tenant": `import {state} from 'test:state';export async function tenantDb(){state.tenantReads++;return{tenantRole:{findFirst:async()=>({permissions:state.permission})},tenantUserProfile:{findUnique:async()=>({id:1,status:'active',accessExpiresAt:null})}};}`,
  };
  const bundle = await build({ stdin: { contents: 'export {assertTenantPermission} from "./lib/erp/permissions";export {state} from "test:state";', resolveDir: process.cwd(), loader: "ts" }, bundle: true, write: false, platform: "node", format: "cjs", packages: "external", plugins: [{ name: "strict-plan-fixture", setup(plugin) {
    plugin.onResolve({ filter: /.*/ }, args => args.path in mocks ? { path: args.path, namespace: "fixture" } : undefined);
    plugin.onLoad({ filter: /.*/, namespace: "fixture" }, args => ({ contents: mocks[args.path], loader: "js", resolveDir: process.cwd() }));
  } }] });
  const routeModule = { exports: {} };
  new Function("require", "module", "exports", bundle.outputFiles[0].text)(createRequire(import.meta.url), routeModule, routeModule.exports);
  const { assertTenantPermission: authorize, state } = routeModule.exports as { assertTenantPermission: (id: string, permission: string) => Promise<unknown>; state: { modules: string[]; role: string; status: string; permission: string[]; tenantReads: number } };
  await authorize("org-a", "products.read");
  await assert.rejects(authorize("org-a", "products.write"), { status: 403 });
  await assert.rejects(authorize("org-a", "finance.read"), { status: 403 });
  await assert.rejects(authorize("other", "products.read"), { status: 403 });
  assert.equal(state.tenantReads, 0);
  state.role = "member";
  await assert.rejects(authorize("org-a", "products.write"), { status: 403 });
  assert.equal(state.tenantReads, 0);
  await authorize("org-a", "products.read");
  state.permission = [];
  await assert.rejects(authorize("org-a", "products.read"), { status: 403 });
  state.modules = ["@policy:v1", "menu:products"];
  state.permission = ["*"];
  await assert.rejects(authorize("org-a", "products.read"), { status: 403 });
  state.modules = ["@policy:v1", "products.read", "products.write"];
  await authorize("org-a", "products.write");
  state.status = "disabled";
  await assert.rejects(authorize("org-a", "products.read"), { status: 403 });
});
