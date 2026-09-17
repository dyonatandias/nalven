import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";
import { build } from "esbuild";

test("API de planos valida autoridade, exclusividade, limite público e edição concorrente", async () => {
  const mocks: Record<string, string> = {
    "test:state": `export const state={role:'user',existing:null,publicCount:3,otherAssignments:0,ownerExists:true,writes:[],audit:[]};`,
    "@/lib/auth": `import {state} from 'test:state';export async function requireUser(role){if(role!==state.role)throw Object.assign(new Error('negado'),{status:403});return{id:'admin'};}export function authErrorResponse(error){return Response.json({error:error.message},{status:error.status||500});}`,
    "@/lib/http-security": `export {HttpSecurityError,readJsonObject,privateJson} from './lib/http-security';export async function enforceControlRateLimit(){}`,
    "@/db/control": `import {state} from 'test:state'; export const controlDb={
      plan:{findUnique:async()=>state.existing,count:async()=>state.publicCount,upsert:async args=>{state.writes.push(args);return args.create;}},
      organization:{findUnique:async()=>state.ownerExists?{id:'org-a'}:null,count:async()=>state.otherAssignments,updateMany:async args=>{state.writes.push(args);return{count:1};}},
      auditLog:{create:async args=>state.audit.push(args)},$executeRaw:async()=>0,
      $transaction:async callback=>{const writes=[...state.writes],audit=[...state.audit];try{return await callback(controlDb);}catch(error){state.writes=writes;state.audit=audit;throw error;}}
    };`,
  };
  const bundle = await build({
    stdin: { contents: 'export {POST} from "./app/api/admin/plans/route";export {state} from "test:state";', resolveDir: process.cwd(), loader: "ts" },
    bundle: true, write: false, platform: "node", format: "cjs", packages: "external",
    plugins: [{ name: "plan-dependencies", setup(plugin) {
      plugin.onResolve({ filter: /.*/ }, args => args.path in mocks ? { path: args.path, namespace: "fixture" } : undefined);
      plugin.onLoad({ filter: /.*/, namespace: "fixture" }, args => ({ contents: mocks[args.path], loader: "js", resolveDir: process.cwd() }));
    } }],
  });
  const routeModule = { exports: {} };
  new Function("require", "module", "exports", bundle.outputFiles[0].text)(createRequire(import.meta.url), routeModule, routeModule.exports);
  const { POST, state } = routeModule.exports as { POST: (request: Request) => Promise<Response>; state: { role: string; existing: null | { id: string; updatedAt: Date; visibility: string }; publicCount: number; otherAssignments: number; ownerExists: boolean; writes: unknown[]; audit: unknown[] } };
  const body = { id: "exclusive-a", name: "Exclusivo", monthlyPrice: 100, annualPrice: 1000, seats: 5, active: true, visibility: "private", ownerOrganizationId: "org-a", modules: ["@policy:v1", "products.read", "menu:products"] };
  const request = (value: unknown, origin = "https://admin.example.test") => new Request("https://admin.example.test/api/admin/plans", { method: "POST", headers: { origin, "content-type": "application/json" }, body: JSON.stringify(value) });
  assert.equal((await POST(request(body))).status, 403);
  assert.equal(state.writes.length, 0);
  state.role = "superadmin";
  assert.equal((await POST(request(body, "https://external.invalid"))).status, 403);
  assert.equal((await POST(request({ ...body, visibility: "public" }))).status, 400);
  assert.equal(state.writes.length, 0);
  state.ownerExists = false;
  assert.equal((await POST(request(body))).status, 404);
  state.ownerExists = true;
  state.otherAssignments = 1;
  assert.equal((await POST(request(body))).status, 409);
  state.otherAssignments = 0;
  state.existing = { id: body.id, visibility: "private", updatedAt: new Date("2026-09-08T12:00:00Z") };
  assert.equal((await POST(request(body))).status, 409);
  assert.equal(state.writes.length, 0);
  const response = await POST(request({ ...body, updatedAt: state.existing.updatedAt.toISOString() }));
  assert.equal(response.status, 200);
  assert.match(response.headers.get("cache-control") || "", /private, no-store/);
  assert.equal(state.writes.length, 2);
  assert.equal(state.audit.length, 1);
});
