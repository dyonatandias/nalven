import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";
import { build } from "esbuild";

test("atribuição valida cliente, versão e confirmação sem alterar cobrança", async () => {
  const mocks: Record<string, string> = {
    "test:state": `export const state={role:'user',owner:'other',count:1,writes:[],audit:[],locks:0};`,
    "@/lib/auth": `import {state} from 'test:state';export async function requireUser(role){if(role!==state.role)throw Object.assign(new Error('negado'),{status:403});return{id:'admin'};}export function authErrorResponse(error){return Response.json({error:error.message},{status:error.status||500});}`,
    "@/lib/http-security": `export {HttpSecurityError,readJsonObject,privateJson} from './lib/http-security';export async function enforceControlRateLimit(){}`,
    "@/db/control": `import {state} from 'test:state';export const controlDb={plan:{findUnique:async()=>({id:'exclusive',active:true,visibility:'private',ownerOrganizationId:state.owner,modules:['@policy:v1','products.read']})},organization:{findUnique:async()=>({planId:'old'}),updateMany:async args=>{state.writes.push(args);return{count:state.count};}},auditLog:{create:async args=>state.audit.push(args)},$executeRaw:async()=>state.locks++,$transaction:async callback=>callback(controlDb)};`,
  };
  const bundle = await build({
    stdin: { contents: 'export {POST} from "./app/api/admin/organizations/[id]/plan/route";export {state} from "test:state";', resolveDir: process.cwd(), loader: "ts" },
    bundle: true, write: false, platform: "node", format: "cjs", packages: "external",
    plugins: [{ name: "assignment-dependencies", setup(plugin) {
      plugin.onResolve({ filter: /.*/ }, args => args.path in mocks ? { path: args.path, namespace: "fixture" } : undefined);
      plugin.onLoad({ filter: /.*/, namespace: "fixture" }, args => ({ contents: mocks[args.path], loader: "js", resolveDir: process.cwd() }));
    } }],
  });
  const routeModule = { exports: {} };
  new Function("require", "module", "exports", bundle.outputFiles[0].text)(createRequire(import.meta.url), routeModule, routeModule.exports);
  const { POST, state } = routeModule.exports as { POST: (request: Request, context: { params: Promise<{ id: string }> }) => Promise<Response>; state: { role: string; owner: string; count: number; locks: number; writes: { where: { id: string; updatedAt: Date }; data: Record<string, unknown> }[]; audit: { data: { entityId: string; metadata: { previousPlanId: string; externalBillingChanged: boolean } } }[] } };
  const body = { planId: "exclusive", updatedAt: "2026-09-09T00:00:00.000Z", confirm: true };
  const context = { params: Promise.resolve({ id: "org-a" }) };
  const request = (value: unknown, origin = "https://admin.example.test") => new Request("https://admin.example.test/api/admin/organizations/org-a/plan", { method: "POST", headers: { origin, "content-type": "application/json" }, body: JSON.stringify(value) });
  assert.equal((await POST(request(body), context)).status, 403);
  state.role = "superadmin";
  assert.equal((await POST(request(body, "https://outside.invalid"), context)).status, 403);
  assert.equal((await POST(request({ ...body, confirm: false }), context)).status, 400);
  assert.equal((await POST(request({ ...body, status: "active" }), context)).status, 400);
  assert.equal((await POST(request(body), context)).status, 409);
  assert.equal(state.writes.length, 0);
  state.owner = "org-a"; state.count = 0;
  assert.equal((await POST(request(body), context)).status, 409);
  assert.equal(state.audit.length, 0);
  state.count = 1;
  assert.equal((await POST(request(body), context)).status, 200);
  assert.deepEqual(state.writes[1].data, { planId: "exclusive", modules: ["@policy:v1", "products.read"] });
  assert.equal(state.writes[1].where.id, "org-a");
  assert.equal(state.writes[1].where.updatedAt.toISOString(), body.updatedAt);
  assert.equal(state.audit[0].data.entityId, "org-a");
  assert.equal(state.audit[0].data.metadata.previousPlanId, "old");
  assert.equal(state.audit[0].data.metadata.externalBillingChanged, false);
  assert.equal(state.locks, 3);
});
