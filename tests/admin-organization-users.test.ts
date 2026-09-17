import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";
import { build } from "esbuild";

test("entrada de usuários da organização exige superadmin e escopo resolvido no servidor", async () => {
  const mocks: Record<string, string> = {
    "test:state": `export const state={role:'user',exists:true,scopes:[],lookups:[],limits:0};`,
    "@/lib/auth": `import {state} from 'test:state';export async function requireUser(role){if(role!==state.role)throw Object.assign(new Error('negado'),{status:403});return{id:'admin'};}`,
    "@/lib/http-security": `export {HttpSecurityError} from './lib/http-security';import {state} from 'test:state';export async function enforceControlRateLimit(){state.limits++;}`,
    "@/db/control": `import {state} from 'test:state';export const controlDb={organization:{findUnique:async args=>{state.lookups.push(args.where.id);return state.exists?{id:args.where.id}:null;}}};`,
    "@/lib/erp/user-access-handlers": `import {state} from 'test:state';async function handle(request,resolve){try{const scope=await resolve();state.scopes.push(scope);return Response.json({ok:true});}catch(error){return Response.json({error:error.message},{status:error.status||500});}}export const getOrganizationUsers=handle,postOrganizationUsers=handle;`,
  };
  const bundle = await build({
    stdin: { contents: 'export {GET,POST} from "./app/api/admin/organizations/[id]/users/route";export {state} from "test:state";', resolveDir: process.cwd(), loader: "ts" },
    bundle: true, write: false, platform: "node", format: "cjs", packages: "external",
    plugins: [{ name: "admin-user-scope", setup(plugin) {
      plugin.onResolve({ filter: /.*/ }, args => args.path in mocks ? { path: args.path, namespace: "fixture" } : undefined);
      plugin.onLoad({ filter: /.*/, namespace: "fixture" }, args => ({ contents: mocks[args.path], loader: "js", resolveDir: process.cwd() }));
    } }],
  });
  const routeModule = { exports: {} };
  new Function("require", "module", "exports", bundle.outputFiles[0].text)(createRequire(import.meta.url), routeModule, routeModule.exports);
  type Handler = (request: Request, context: { params: Promise<{ id: string }> }) => Promise<Response>;
  const { GET, POST, state } = routeModule.exports as { GET: Handler; POST: Handler; state: { role: string; exists: boolean; scopes: unknown[]; lookups: string[]; limits: number } };
  const context = { params: Promise.resolve({ id: "org-a" }) };
  const request = new Request("https://admin.example.test/api/admin/organizations/org-a/users?organizationId=other");
  assert.equal((await GET(request, context)).status, 403);
  assert.equal((await POST(request, context)).status, 403);
  assert.deepEqual(state.lookups, []);
  state.role = "superadmin"; state.exists = false;
  assert.equal((await GET(request, context)).status, 404);
  assert.deepEqual(state.scopes, []);
  state.exists = true;
  const response = await GET(request, context);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "private, no-store");
  assert.deepEqual(state.scopes[0], { organization: { id: "org-a" }, access: { user: { id: "admin" }, permissions: ["*"] } });
  assert.equal((await POST(request, context)).status, 200);
  assert.equal(state.limits, 1);
});
