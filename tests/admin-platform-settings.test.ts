import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";
import { build } from "esbuild";

test("configuração valida senha, planos e versões preservando campos internos", async () => {
  const mocks: Record<string, string> = {
    "test:state": `export const state={role:'user',writes:[],audit:[]};`,
    "@/lib/auth": `import {state} from 'test:state';export async function requireUser(role){if(role!==state.role)throw Object.assign(new Error('negado'),{status:403});return{id:'admin',passwordHash:'fixture'};}export function authErrorResponse(error){return Response.json({error:error.message},{status:error.status||500});}`,
    "@/lib/password": `export async function verifyPassword(value){return value==='fixture-confirmation';}`,
    "@/lib/http-security": `export {HttpSecurityError,readJsonObject,privateJson} from './lib/http-security';export async function enforceControlRateLimit(){}`,
    "@/db/control": `import {state} from 'test:state';export const controlDb={systemSetting:{findMany:async()=>[{key:'saas',updatedAt:new Date('2026-09-09T00:00:00Z'),value:{tenantIsolation:'database-per-tenant'}},{key:'signup',updatedAt:new Date('2026-09-09T00:00:00Z'),value:{internalMarker:'preserve'}}],upsert:async args=>state.writes.push(args)},auditLog:{create:async args=>state.audit.push(args)},$executeRaw:async()=>0,$transaction:async callback=>callback(controlDb)};`,
  };
  const bundle = await build({ stdin: { contents: 'export {POST} from "./app/api/admin/platform-settings/route";export {state} from "test:state";', resolveDir: process.cwd(), loader: "ts" }, bundle: true, write: false, platform: "node", format: "cjs", packages: "external", plugins: [{ name: "platform-fixture", setup(plugin) {
    plugin.onResolve({ filter: /.*/ }, args => args.path in mocks ? { path: args.path, namespace: "fixture" } : undefined);
    plugin.onLoad({ filter: /.*/, namespace: "fixture" }, args => ({ contents: mocks[args.path], loader: "js", resolveDir: process.cwd() }));
  } }] });
  const routeModule = { exports: {} };
  new Function("require", "module", "exports", bundle.outputFiles[0].text)(createRequire(import.meta.url), routeModule, routeModule.exports);
  const { POST, state } = routeModule.exports as { POST: (request: Request) => Promise<Response>; state: { role: string; writes: { update: { value: Record<string, unknown> } }[]; audit: unknown[] } };
  const body = { name: "Nalven", domain: "example.test", trialDays: 14, dueDay: 10, paymentMethods: ["pix"], versions: { saas: "2026-09-09T00:00:00.000Z", signup: "2026-09-09T00:00:00.000Z" }, currentPassword: "fixture-confirmation" };
  const request = (value: unknown, origin = "https://admin.example.test") => new Request("https://admin.example.test/api/admin/platform-settings", { method: "POST", headers: { origin, "content-type": "application/json" }, body: JSON.stringify(value) });
  assert.equal((await POST(request(body))).status, 403); state.role = "superadmin";
  assert.equal((await POST(request(body, "https://outside.invalid"))).status, 403);
  assert.equal((await POST(request({ ...body, currentPassword: "wrong" }))).status, 403);
  for (const patch of [{ domain: "https://example.test" }, { trialDays: 91 }, { dueDay: 29 }, { paymentMethods: [] }]) assert.equal((await POST(request({ ...body, ...patch }))).status, 400);
  assert.equal((await POST(request({ ...body, versions: { saas: null, signup: null } }))).status, 409);
  assert.equal(state.writes.length, 0);
  assert.equal((await POST(request(body))).status, 200);
  assert.equal(state.writes[0].update.value.tenantIsolation, "database-per-tenant");
  assert.equal(state.writes[1].update.value.internalMarker, "preserve");
  assert.equal(state.audit.length, 1);
  assert.equal(JSON.stringify(state.audit).includes(body.currentPassword), false);
});
