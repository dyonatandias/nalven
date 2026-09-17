import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";
import { build } from "esbuild";

test("consulta fiscal autoriza antes de resolver o tenant e limita a projeção", async () => {
  const mocks: Record<string, string> = {
    "test:state": `export const state={role:'user',exists:true,resolved:[],queries:[]};`,
    "@/lib/auth": `import {state} from 'test:state';export async function requireUser(role){if(role!==state.role)throw Object.assign(new Error('negado'),{status:403});return{id:'admin'};}export function authErrorResponse(error){return Response.json({error:error.message},{status:error.status||500});}`,
    "@/db/control": `import {state} from 'test:state';export const controlDb={organization:{findUnique:async args=>state.exists?{id:args.where.id}:null}};`,
    "@/db/tenant": `import {state} from 'test:state';export async function tenantDb(id){state.resolved.push(id);return{branch:{findMany:async args=>{state.queries.push(args);return[];},count:async()=>0},$transaction:async queries=>Promise.all(queries)};}`,
  };
  const bundle = await build({
    stdin: { contents: 'export {GET} from "./app/api/admin/organizations/[id]/fiscal/route";export {state} from "test:state";', resolveDir: process.cwd(), loader: "ts" },
    bundle: true, write: false, platform: "node", format: "cjs", packages: "external",
    plugins: [{ name: "fiscal-dependencies", setup(plugin) {
      plugin.onResolve({ filter: /.*/ }, args => args.path in mocks ? { path: args.path, namespace: "fixture" } : undefined);
      plugin.onLoad({ filter: /.*/, namespace: "fixture" }, args => ({ contents: mocks[args.path], loader: "js", resolveDir: process.cwd() }));
    } }],
  });
  const routeModule = { exports: {} };
  new Function("require", "module", "exports", bundle.outputFiles[0].text)(createRequire(import.meta.url), routeModule, routeModule.exports);
  const { GET, state } = routeModule.exports as { GET: (request: Request, context: { params: Promise<{ id: string }> }) => Promise<Response>; state: { role: string; exists: boolean; resolved: string[]; queries: { select: Record<string, boolean>; take: number; skip: number }[] } };
  const context = { params: Promise.resolve({ id: "org-a" }) };
  const request = new Request("https://admin.example.test/api/admin/organizations/org-a/fiscal?page=999999");
  assert.equal((await GET(request, context)).status, 403);
  assert.deepEqual(state.resolved, []);
  state.role = "superadmin"; state.exists = false;
  assert.equal((await GET(request, context)).status, 404);
  assert.deepEqual(state.resolved, []);
  state.exists = true;
  const response = await GET(request, context);
  assert.equal(response.status, 200);
  assert.match(response.headers.get("cache-control") || "", /private, no-store/);
  assert.deepEqual(state.resolved, ["org-a"]);
  assert.equal(state.queries[0].take, 25);
  assert.equal(state.queries[0].skip, 249975);
  assert.equal(state.queries[0].select.document, true);
  assert.equal(state.queries[0].select.settings, undefined);
  assert.equal(state.queries[0].select.notes, undefined);
});
