import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";
import { build } from "esbuild";

test("cadastro de organização exige superadmin, versão e escopo de campos", async () => {
  const mocks: Record<string, string> = {
    "test:state": `export const state={role:'user',count:1,writes:[],audit:[]};`,
    "@/lib/auth": `import {state} from 'test:state';export async function requireUser(role){if(role!==state.role)throw Object.assign(new Error('negado'),{status:403});return{id:'admin'};}export function authErrorResponse(error){return Response.json({error:error.message},{status:error.status||500});}`,
    "@/lib/http-security": `export {HttpSecurityError,readJsonObject,privateJson} from './lib/http-security';export async function enforceControlRateLimit(){}`,
    "@/db/control": `import {state} from 'test:state';export const controlDb={organization:{updateMany:async args=>{state.writes.push(args);return{count:state.count};},findUniqueOrThrow:async()=>({updatedAt:new Date('2026-09-09T01:00:00Z')})},auditLog:{create:async args=>state.audit.push(args)},$transaction:async callback=>callback(controlDb)};`,
  };
  const bundle = await build({
    stdin: { contents: 'export {PATCH} from "./app/api/admin/organizations/[id]/route";export {state} from "test:state";', resolveDir: process.cwd(), loader: "ts" },
    bundle: true, write: false, platform: "node", format: "cjs", packages: "external",
    plugins: [{ name: "organization-dependencies", setup(plugin) {
      plugin.onResolve({ filter: /.*/ }, args => args.path in mocks ? { path: args.path, namespace: "fixture" } : undefined);
      plugin.onLoad({ filter: /.*/, namespace: "fixture" }, args => ({ contents: mocks[args.path], loader: "js", resolveDir: process.cwd() }));
    } }],
  });
  const routeModule = { exports: {} };
  new Function("require", "module", "exports", bundle.outputFiles[0].text)(createRequire(import.meta.url), routeModule, routeModule.exports);
  const { PATCH, state } = routeModule.exports as { PATCH: (request: Request, context: { params: Promise<{ id: string }> }) => Promise<Response>; state: { role: string; count: number; writes: { where: { id: string; updatedAt: Date }; data: Record<string, string> }[]; audit: { data: { entityType: string; entityId: string } }[] } };
  const body = { name: " Cliente A ", ownerName: "Responsável", email: "CONTACT@example.test", updatedAt: "2026-09-09T00:00:00.000Z" };
  const context = { params: Promise.resolve({ id: "org-a" }) };
  const request = (value: unknown, origin = "https://admin.example.test") => new Request("https://admin.example.test/api/admin/organizations/org-a", { method: "PATCH", headers: { origin, "content-type": "application/json" }, body: JSON.stringify(value) });
  assert.equal((await PATCH(request(body), context)).status, 403);
  state.role = "superadmin";
  assert.equal((await PATCH(request(body, "https://outside.invalid"), context)).status, 403);
  for (const field of ["status", "planId", "document", "modules", "organizationId"]) assert.equal((await PATCH(request({ ...body, [field]: "injected" }), context)).status, 400);
  assert.equal((await PATCH(request({ ...body, email: "invalid" }), context)).status, 400);
  assert.equal((await PATCH(request({ ...body, updatedAt: "invalid" }), context)).status, 400);
  assert.equal(state.writes.length, 0);
  state.count = 0;
  assert.equal((await PATCH(request(body), context)).status, 409);
  assert.equal(state.audit.length, 0);
  state.count = 1;
  const saved = await PATCH(request(body), context);
  assert.equal(saved.status, 200);
  assert.match(saved.headers.get("cache-control") || "", /private, no-store/);
  assert.equal(state.writes[1].where.id, "org-a");
  assert.equal(state.writes[1].where.updatedAt.toISOString(), body.updatedAt);
  assert.deepEqual(state.writes[1].data, { name: "Cliente A", ownerName: "Responsável", email: "contact@example.test" });
  assert.equal(state.audit[0].data.entityType, "organization");
  assert.equal(state.audit[0].data.entityId, "org-a");
});
