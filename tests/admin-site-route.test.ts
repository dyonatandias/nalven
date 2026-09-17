import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";
import { build } from "esbuild";

test("site exige autoridade, formato e versão antes de salvar e auditar", async () => {
  const mocks: Record<string, string> = {
    "test:state": `export const state={role:'user',count:1,writes:[],audit:[]};`,
    "@/lib/auth": `import {state} from 'test:state';export async function requireUser(role){if(role!==state.role)throw Object.assign(new Error('negado'),{status:403});return{id:'admin'};}export function authErrorResponse(error){return Response.json({error:error.message},{status:error.status||500});}`,
    "@/lib/http-security": `export {HttpSecurityError,readJsonObject,privateJson} from './lib/http-security';export async function enforceControlRateLimit(){}`,
    "@/db/control": `import {state} from 'test:state';export const controlDb={siteContent:{findUnique:async()=>({key:'features.items',type:'json'}),updateMany:async args=>{state.writes.push(args);return{count:state.count};}},auditLog:{create:async args=>state.audit.push(args)},$transaction:async callback=>callback(controlDb)};`,
  };
  const bundle = await build({
    stdin: { contents: 'export {POST} from "./app/api/admin/site/route";export {state} from "test:state";', resolveDir: process.cwd(), loader: "ts" },
    bundle: true, write: false, platform: "node", format: "cjs", packages: "external",
    plugins: [{ name: "site-dependencies", setup(plugin) {
      plugin.onResolve({ filter: /.*/ }, args => args.path in mocks ? { path: args.path, namespace: "fixture" } : undefined);
      plugin.onLoad({ filter: /.*/, namespace: "fixture" }, args => ({ contents: mocks[args.path], loader: "js", resolveDir: process.cwd() }));
    } }],
  });
  const routeModule = { exports: {} };
  new Function("require", "module", "exports", bundle.outputFiles[0].text)(createRequire(import.meta.url), routeModule, routeModule.exports);
  const { POST, state } = routeModule.exports as { POST: (request: Request) => Promise<Response>; state: { role: string; count: number; writes: { where: { updatedAt: Date; key: string; type: string } }[]; audit: unknown[] } };
  const body = { key: "features.items", public: true, updatedAt: "2026-09-09T00:00:00.000Z", value: [{ title: "Vendas", description: "Texto" }] };
  const request = (value: unknown, origin = "https://admin.example.test") => new Request("https://admin.example.test/api/admin/site", { method: "POST", headers: { origin, "content-type": "application/json" }, body: JSON.stringify(value) });
  assert.equal((await POST(request(body))).status, 403);
  state.role = "superadmin";
  assert.equal((await POST(request(body, "https://outside.invalid"))).status, 403);
  assert.equal((await POST(request({ ...body, value: "invalid" }))).status, 400);
  assert.equal((await POST(request({ ...body, updatedAt: "invalid" }))).status, 400);
  assert.equal(state.writes.length, 0);
  state.count = 0;
  assert.equal((await POST(request(body))).status, 409);
  assert.equal(state.audit.length, 0);
  state.count = 1;
  const saved = await POST(request(body));
  assert.equal(saved.status, 200);
  assert.match(saved.headers.get("cache-control") || "", /private, no-store/);
  assert.equal(state.writes[1].where.updatedAt.toISOString(), body.updatedAt);
  assert.equal(state.writes[1].where.type, "json");
  assert.equal(state.audit.length, 1);
});
