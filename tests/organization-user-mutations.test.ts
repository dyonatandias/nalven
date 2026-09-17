import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";
import { build } from "esbuild";

test("mutações de vínculos aguardam o tenant, revertem falhas e protegem proprietário", async () => {
  const mocks: Record<string, string> = {
    "test:state": `export const state={failTenant:false,events:[],persisted:{member:{id:'member-a',userId:'user-a',organizationId:'org-a',role:'stock',status:'active',user:{name:'Pessoa',email:'person@example.invalid'}},sessions:2,audit:[]},tenant:{status:'active',audit:[]}};`,
    "@/lib/auth": `export class AuthError extends Error{};export function authErrorResponse(){return Response.json({error:'negado'},{status:403});}`,
    "@/lib/erp/permissions": `export const PERMISSION_RESOURCES=[];export function matches(){return true;}`,
    "@/db": `import{state}from'test:state';let queue=Promise.resolve();
      const control={
        $executeRaw:async()=>state.events.push('catalog.lock'),$queryRaw:async()=>state.events.push('membership.lock'),
        membership:{findFirst:async({where})=>{state.events.push('member.read');const m=state.persisted.member;return where.id===m.id&&where.organizationId===m.organizationId?structuredClone(m):null;},findMany:async({where})=>{const m=state.persisted.member;return where.organizationId===m.organizationId&&where.id.in.includes(m.id)?[structuredClone(m)]:[];},update:async({data})=>Object.assign(state.persisted.member,data),updateMany:async({data})=>{Object.assign(state.persisted.member,data);return{count:1};}},
        session:{deleteMany:async()=>{const count=state.persisted.sessions;state.persisted.sessions=0;return{count};}},
        auditLog:{create:async({data})=>state.persisted.audit.push(data)}
      };
      const tenant={
        tenantRole:{findFirst:async({where})=>({id:1,key:where.key,active:true})},branch:{count:async()=>0},
        tenantUserProfile:{findUnique:async()=>({jobTitle:null,department:null,phone:null,accessExpiresAt:null,branchAccesses:[]}),upsert:async({update})=>{state.tenant.status=update.status;return{id:1};},updateMany:async({data})=>{state.tenant.status=data.status;return{count:1};}},
        tenantAuditEvent:{create:async({data})=>{if(state.failTenant){state.failTenant=false;throw new Error('private tenant failure');}state.tenant.audit.push(data);}},
        $transaction:async callback=>{const saved=structuredClone(state.tenant);state.events.push('tenant.begin');try{const value=await callback(tenant);state.events.push('tenant.commit');return value;}catch(error){state.tenant=saved;throw error;}}
      };
      export async function tenantDb(){return tenant;}
      export const controlDb={$transaction:async callback=>{let release;const waiting=queue;queue=new Promise(resolve=>release=resolve);await waiting;const saved=structuredClone(state.persisted);state.events.push('control.begin');try{const value=await callback(control);state.events.push('control.commit');return value;}catch(error){state.persisted=saved;state.events.push('control.rollback');throw error;}finally{release();}}};`,
  };
  const bundle = await build({
    stdin: { contents: 'export {postOrganizationUsers} from "./lib/erp/user-access-handlers";export {state} from "test:state";', resolveDir: process.cwd(), loader: "ts" },
    bundle: true, write: false, platform: "node", format: "cjs", packages: "external",
    plugins: [{ name: "user-mutation-dependencies", setup(plugin) {
      plugin.onResolve({ filter: /.*/ }, args => args.path in mocks ? { path: args.path, namespace: "fixture" } : undefined);
      plugin.onLoad({ filter: /.*/, namespace: "fixture" }, args => ({ contents: mocks[args.path], loader: "js", resolveDir: process.cwd() }));
    } }],
  });
  const routeModule = { exports: {} };
  new Function("require", "module", "exports", bundle.outputFiles[0].text)(createRequire(import.meta.url), routeModule, routeModule.exports);
  type Scope = { organization: { id: string }; access: { user: { id: string }; permissions: string[] } };
  const { postOrganizationUsers: POST, state } = routeModule.exports as { postOrganizationUsers: (request: Request, resolve: () => Promise<Scope>) => Promise<Response>; state: { failTenant: boolean; events: string[]; persisted: { member: { role: string; status: string }; sessions: number; audit: unknown[] }; tenant: { status: string; audit: unknown[] } } };
  const scope = async () => ({ organization: { id: "org-a" }, access: { user: { id: "admin-a" }, permissions: ["*"] } });
  const send = (body: Record<string, unknown>) => POST(new Request("https://app.example.test/api/admin/organizations/org-a/users", { method: "POST", headers: { origin: "https://app.example.test", host: "app.example.test", "content-type": "application/json" }, body: JSON.stringify(body) }), scope);
  const individual = { action: "member.update", membershipId: "member-a", roleKey: "stock", status: "disabled" };
  const bulk = { action: "member.bulk_update", membershipIds: ["member-a"], status: "disabled" };
  for (const status of [undefined, null, "invalid", ["active"]]) {
    const saved = structuredClone(state.persisted);
    assert.equal((await send({ ...individual, status })).status, 400);
    assert.deepEqual(state.persisted, saved);
    assert.deepEqual(state.events, []);
  }
  for (const body of [individual, bulk]) {
    const saved = structuredClone(state.persisted), tenant = structuredClone(state.tenant);
    state.failTenant = true;
    const failed = await send(body);
    assert.equal(failed.status, 500); assert.ok(!(await failed.text()).includes("private"));
    assert.deepEqual(state.persisted, saved); assert.deepEqual(state.tenant, tenant);
  }
  state.events = []; state.failTenant = true;
  const responses = await Promise.all([send(individual), send({ ...individual, roleKey: "auditor", status: "active" })]);
  assert.deepEqual(responses.map(response => response.status), [500, 200]);
  assert.equal(state.persisted.member.role, "auditor"); assert.equal(state.persisted.member.status, "active");
  assert.equal(state.persisted.sessions, 2);
  assert.ok(state.events.indexOf("catalog.lock") < state.events.indexOf("member.read"));
  assert.ok(state.events.indexOf("membership.lock") < state.events.indexOf("member.read"));
  assert.ok(state.events.lastIndexOf("tenant.commit") < state.events.lastIndexOf("control.commit"));
  assert.equal((await send(bulk)).status, 200);
  assert.equal(state.persisted.sessions, 0); assert.equal(state.tenant.status, "disabled");
  state.persisted.member.role = "owner";
  for (const body of [individual, bulk]) assert.equal((await send(body)).status, 400);
  assert.equal(state.persisted.member.role, "owner");
});
