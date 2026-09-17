import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";
import { build } from "esbuild";

test("auditoria exige superadmin, limita consultas e não seleciona metadados sensíveis", async () => {
  const mocks: Record<string, string> = {
    "test:state": "export const state={role:'user',queries:[]};",
    "@/lib/auth": `import {state} from 'test:state'; export async function requireUser(role){if(state.role!==role) throw new Error('denied');return {id:'admin'};} export function authErrorResponse(){return Response.json({error:'Acesso negado'},{status:403});}`,
    "@/db/control": `import {state} from 'test:state';export const controlDb={organization:{findUnique:async args=>args.where.id==='org-a'?{id:'org-a'}:null},auditLog:{findMany:async args=>{state.queries.push(args);return [];},count:async()=>0},$transaction:async values=>Promise.all(values)};`,
  };
  const bundle = await build({
    stdin: { contents: 'export { GET } from "./app/api/admin/audit/route"; export {state} from "test:state";', resolveDir: process.cwd(), loader: "ts" },
    bundle: true, write: false, platform: "node", format: "cjs", packages: "external",
    plugins: [{ name: "audit-dependencies", setup(plugin) {
      plugin.onResolve({ filter: /.*/ }, args => args.path in mocks ? { path: args.path, namespace: "fixture" } : undefined);
      plugin.onLoad({ filter: /.*/, namespace: "fixture" }, args => ({ contents: mocks[args.path], loader: "js", resolveDir: process.cwd() }));
    } }],
  });
  const routeModule = { exports: {} };
  new Function("require", "module", "exports", bundle.outputFiles[0].text)(createRequire(import.meta.url), routeModule, routeModule.exports);
  const { GET, state } = routeModule.exports as { GET: (request: Request) => Promise<Response>; state: { role: string; queries: Array<{ take: number; skip: number; select: Record<string, unknown>; where: { entityType?: string; OR?: unknown[] } }> } };
  assert.equal((await GET(new Request("https://example.invalid/api/admin/audit"))).status, 403);
  assert.equal(state.queries.length, 0);
  state.role = "superadmin";
  const response = await GET(new Request("https://example.invalid/api/admin/audit?page=2&entityType=organization&q=Ana"));
  assert.equal(response.status, 200);
  assert.match(response.headers.get("cache-control") || "", /private, no-store/);
  assert.deepEqual(await response.json(), { logs: [], total: 0, page: 2, pageSize: 50 });
  assert.equal(state.queries[0].take, 50);
  assert.equal(state.queries[0].skip, 50);
  assert.equal(state.queries[0].where.entityType, "organization");
  assert.equal(state.queries[0].where.OR?.length, 3);
  assert.equal(state.queries[0].select.metadata, undefined);
  assert.equal(state.queries[0].select.ipAddress, undefined);
  await GET(new Request("https://example.invalid/api/admin/audit?page=-99"));
  assert.equal(state.queries[1].skip, 0);
  for (const suffix of ["organizationId=", "from=2026-02-30", "to=invalid", "from=2026-09-09&to=2026-09-01"]) {
    assert.equal((await GET(new Request(`https://example.invalid/api/admin/audit?${suffix}`))).status, 400);
  }
  assert.equal((await GET(new Request("https://example.invalid/api/admin/audit?organizationId=missing"))).status, 404);
  assert.equal(state.queries.length, 2);
  assert.equal((await GET(new Request("https://example.invalid/api/admin/audit?organizationId=org-a&q=Ana&from=2026-09-01&to=2026-09-09"))).status, 200);
  assert.deepEqual(state.queries[2].where, {
    AND: [{ OR: [{ entityType: "organization", entityId: "org-a" }, { entityType: "billing", metadata: { path: ["organizationId"], equals: "org-a" } }] }],
    createdAt: { gte: new Date("2026-09-01T00:00:00.000Z"), lt: new Date("2026-09-10T00:00:00.000Z") },
    OR: [{ action: { contains: "Ana", mode: "insensitive" } }, { entityId: { contains: "Ana", mode: "insensitive" } }, { user: { name: { contains: "Ana", mode: "insensitive" } } }],
  });
});
