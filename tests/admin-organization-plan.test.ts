import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";
import { build } from "esbuild";

test("atribuição confirma o plano no Billing antes de gravar localmente", async () => {
  const mocks: Record<string, string> = {
    "test:state": `export const state={role:'user',plan:{id:'profissional',code:'profissional',active:true,modules:['@policy:v1','products.read']},before:{planId:'old',updatedAt:new Date('2026-09-09T00:00:00.000Z')},account:{externalId:'org-a',paymentMethod:'pix',modules:[]},count:1,writes:[],audit:[],subscriptionCalls:[],subscriptionError:null};`,
    "@/lib/auth": `import {state} from 'test:state';export async function requireUser(role){if(role!==state.role)throw Object.assign(new Error('negado'),{status:403});return{id:'admin'};}export function authErrorResponse(error){return Response.json({error:error.message},{status:error.status||500});}`,
    "@/lib/http-security": `export {HttpSecurityError,readJsonObject,privateJson} from './lib/http-security';export async function enforceControlRateLimit(){}`,
    "@/lib/billing/client": `import {state} from 'test:state';export class BillingError extends Error{constructor(message,status,requestId){super(message);this.status=status;this.requestId=requestId;}}export const billingClient={updateSubscription:async(externalId,input,commandId)=>{state.subscriptionCalls.push({externalId,input,commandId});if(state.subscriptionError)throw state.subscriptionError;return{};}};`,
    "@/db/control": `import {state} from 'test:state';
const tx={
  organization:{updateMany:async args=>{state.writes.push({kind:'organization',...args});return{count:state.count};}},
  billingAccount:{update:async args=>{state.writes.push({kind:'billingAccount',...args});}},
  auditLog:{create:async args=>state.audit.push(args)}
};
export const controlDb={
  plan:{findUnique:async()=>state.plan},
  organization:{findUnique:async()=>state.before},
  billingAccount:{findUnique:async()=>state.account},
  $transaction:async callback=>callback(tx)
};`,
  };
  const bundle = await build({
    stdin: { contents: 'export {POST} from "./app/api/admin/organizations/[id]/plan/route";export {state} from "test:state";export {BillingError} from "@/lib/billing/client";', resolveDir: process.cwd(), loader: "ts" },
    bundle: true, write: false, platform: "node", format: "cjs", packages: "external",
    plugins: [{ name: "assignment-dependencies", setup(plugin) {
      plugin.onResolve({ filter: /.*/ }, args => args.path in mocks ? { path: args.path, namespace: "fixture" } : undefined);
      plugin.onLoad({ filter: /.*/, namespace: "fixture" }, args => ({ contents: mocks[args.path], loader: "js", resolveDir: process.cwd() }));
    } }],
  });
  const routeModule = { exports: {} };
  new Function("require", "module", "exports", bundle.outputFiles[0].text)(createRequire(import.meta.url), routeModule, routeModule.exports);
  const { POST, state } = routeModule.exports as {
    POST: (request: Request, context: { params: Promise<{ id: string }> }) => Promise<Response>;
    state: {
      role: string; plan: { id: string; code: string | null; active: boolean; modules: string[] } | null;
      before: { planId: string; updatedAt: Date } | null; account: { externalId: string; paymentMethod: string; modules: unknown[] } | null;
      count: number; writes: Record<string, unknown>[]; audit: { data: { entityId: string; metadata: { previousPlanId: string; externalBillingChanged: boolean } } }[];
      subscriptionCalls: { externalId: string; input: Record<string, unknown> }[]; subscriptionError: unknown;
    };
  };
  const body = { planId: "profissional", updatedAt: "2026-09-09T00:00:00.000Z", confirm: true };
  const context = { params: Promise.resolve({ id: "org-a" }) };
  const request = (value: unknown, origin = "https://admin.example.test") => new Request("https://admin.example.test/api/admin/organizations/org-a/plan", { method: "POST", headers: { origin, "content-type": "application/json" }, body: JSON.stringify(value) });

  assert.equal((await POST(request(body), context)).status, 403);
  state.role = "superadmin";
  assert.equal((await POST(request(body, "https://outside.invalid"), context)).status, 403);
  assert.equal((await POST(request({ ...body, confirm: false }), context)).status, 400);
  assert.equal((await POST(request({ ...body, status: "active" }), context)).status, 400);

  // Plan without a Billing code (legacy/unreconciled) is never assignable.
  state.plan = { id: "management", code: null, active: true, modules: [] };
  assert.equal((await POST(request(body), context)).status, 409);
  state.plan = { id: "profissional", code: "profissional", active: true, modules: ["@policy:v1", "products.read"] };

  state.before = null;
  assert.equal((await POST(request(body), context)).status, 404);
  state.before = { planId: "old", updatedAt: new Date("2026-09-01T00:00:00.000Z") };
  assert.equal((await POST(request(body), context)).status, 409);
  state.before = { planId: "old", updatedAt: new Date("2026-09-09T00:00:00.000Z") };

  state.account = null;
  assert.equal((await POST(request(body), context)).status, 409);
  assert.equal(state.subscriptionCalls.length, 0);
  state.account = { externalId: "org-a", paymentMethod: "pix", modules: [] };

  // Billing rejects the plan (404/409) — nothing is written locally.
  const { BillingError } = routeModule.exports as unknown as { BillingError: new (message: string, status: number) => Error };
  state.subscriptionError = new BillingError("Plano não encontrado para este produto", 404);
  assert.equal((await POST(request(body), context)).status, 404);
  assert.equal(state.writes.length, 0);
  state.subscriptionError = null;

  assert.equal((await POST(request(body), context)).status, 200);
  assert.equal(state.subscriptionCalls.length, 2);
  assert.equal(state.subscriptionCalls[1].externalId, "org-a");
  assert.equal(state.subscriptionCalls[1].input.plano_codigo, "profissional");
  assert.deepEqual(state.writes[0], { kind: "organization", where: { id: "org-a", updatedAt: state.before.updatedAt }, data: { planId: "profissional", modules: ["@policy:v1", "products.read"] } });
  assert.equal(state.writes[1].kind, "billingAccount");
  assert.equal(state.audit[0].data.entityId, "org-a");
  assert.equal(state.audit[0].data.metadata.previousPlanId, "old");
  assert.equal(state.audit[0].data.metadata.externalBillingChanged, true);
});
