import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";
import { build } from "esbuild";
import { hashPassword } from "../lib/password";

test("administradores: isolamento, reautenticação, concorrência e revogação", async () => {
  const mocks: Record<string, string> = {
    "test:state": `export const state={role:'user',hash:'',actorStatus:'active',targetRole:'superadmin',targetId:'other',existingEmail:false,queries:[],writes:[],audit:[],revoked:[],locks:[]};`,
    "@/lib/auth": `import {state} from 'test:state';export async function requireUser(role){if(role!==state.role)throw Object.assign(new Error('negado'),{status:403});return{id:'admin',passwordHash:state.hash};}export function authErrorResponse(error){return Response.json({error:error.message},{status:error.status||500});}`,
    "@/lib/http-security": `export {HttpSecurityError,readJsonObject,privateJson} from './lib/http-security';export async function enforceControlRateLimit(){}`,
    "@/db/control": `import {state} from 'test:state';export const controlDb={
      user:{findMany:async args=>{state.queries.push(args);return[];},count:async()=>0,
        findUnique:async args=>args.select.passwordHash?{role:'superadmin',status:state.actorStatus,passwordHash:state.hash}:args.where.email?(state.existingEmail?{id:'customer'}:null):{id:state.targetId,role:state.targetRole,status:'active',updatedAt:new Date('2026-09-08T12:00:00Z')},
        create:async args=>{state.writes.push(args);return{id:'created'};},update:async args=>{state.writes.push(args);return args.data;}},
      session:{deleteMany:async args=>{state.revoked.push(args);return{count:1};}},auditLog:{create:async args=>state.audit.push(args)},
      $executeRaw:async (strings,...values)=>{state.locks.push([strings.join('?'),...values]);return 0;},
      $transaction:async callback=>Array.isArray(callback)?Promise.all(callback):callback(controlDb)
    };`,
  };
  const bundle = await build({
    stdin: { contents: 'export {GET,POST} from "./app/api/admin/users/route";export {state} from "test:state";', resolveDir: process.cwd(), loader: "ts" },
    bundle: true, write: false, platform: "node", format: "cjs", packages: "external",
    plugins: [{ name: "users-dependencies", setup(plugin) {
      plugin.onResolve({ filter: /.*/ }, args => args.path in mocks ? { path: args.path, namespace: "fixture" } : undefined);
      plugin.onLoad({ filter: /.*/, namespace: "fixture" }, args => ({ contents: mocks[args.path], loader: "js", resolveDir: process.cwd() }));
    } }],
  });
  const routeModule = { exports: {} };
  new Function("require", "module", "exports", bundle.outputFiles[0].text)(createRequire(import.meta.url), routeModule, routeModule.exports);
  const { GET, POST, state } = routeModule.exports as {
    GET: (request: Request) => Promise<Response>; POST: (request: Request) => Promise<Response>;
    state: { role: string; hash: string; actorStatus: string; targetRole: string; targetId: string; existingEmail: boolean; queries: { where: { role: string }; select: Record<string, boolean>; skip: number }[]; writes: { data: Record<string, string> }[]; audit: unknown[]; revoked: unknown[]; locks: unknown[] };
  };
  const secret = "FixtureAdmin123!";
  state.hash = await hashPassword(secret);
  const request = (body: unknown, origin = "https://admin.example.test") => new Request("https://admin.example.test/api/admin/users", { method: "POST", headers: { origin, "content-type": "application/json" }, body: JSON.stringify(body) });
  const update = { action: "update", id: "other", name: "Administrador", status: "disabled", updatedAt: "2026-09-08T12:00:00.000Z", currentPassword: secret };
  assert.equal((await GET(new Request("https://admin.example.test/api/admin/users"))).status, 403);
  assert.equal((await POST(request(update))).status, 403);
  assert.equal(state.queries.length, 0);
  state.role = "superadmin";
  const listing = await GET(new Request("https://admin.example.test/api/admin/users?page=999999"));
  assert.equal(listing.status, 200);
  assert.match(listing.headers.get("cache-control") || "", /private, no-store/);
  assert.equal(state.queries[0].where.role, "superadmin");
  assert.equal(state.queries[0].skip, 499950);
  assert.equal(state.queries[0].select.passwordHash, undefined);
  assert.equal(state.queries[0].select.memberships, undefined);
  assert.equal((await POST(request(update, "https://external.invalid"))).status, 403);
  assert.equal((await POST(request({ ...update, currentPassword: "wrong" }))).status, 403);
  assert.equal((await POST(request({ ...update, organizationId: "org" }))).status, 400);
  state.targetRole = "user";
  assert.equal((await POST(request(update))).status, 404);
  state.targetRole = "superadmin";
  assert.equal((await POST(request({ ...update, updatedAt: "stale" }))).status, 409);
  state.targetId = "admin";
  assert.equal((await POST(request({ ...update, id: "admin" }))).status, 400);
  state.targetId = "other";
  state.actorStatus = "disabled";
  assert.equal((await POST(request(update))).status, 403);
  state.actorStatus = "active";
  state.existingEmail = true;
  const create = { action: "create", name: "Novo", email: "customer@example.test", password: "NewFixture123!", currentPassword: secret };
  assert.equal((await POST(request(create))).status, 409);
  assert.equal(state.writes.length, 0);
  assert.equal(state.revoked.length, 0);
  assert.equal((await POST(request(update))).status, 200);
  assert.equal(state.writes.length, 1);
  assert.equal(state.revoked.length, 1);
  assert.equal(state.audit.length, 1);
  assert.match(JSON.stringify(state.locks), /password-reset:other/);
  assert.equal((await POST(request({ action: "revoke_sessions", id: "other", currentPassword: secret }))).status, 200);
  assert.equal(state.revoked.length, 2);
  state.existingEmail = false;
  assert.equal((await POST(request(create))).status, 200);
  assert.equal(state.writes[1].data.role, "superadmin");
  assert.match(state.writes[1].data.passwordHash, /^scrypt:/);
  assert.equal(JSON.stringify(state.audit).includes(secret), false);
  assert.equal(JSON.stringify(state.audit).includes(create.password), false);
});
