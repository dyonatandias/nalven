import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";
import { build } from "esbuild";

test("configuração e cofre financeiro fazem rollback conjunto e exigem reautenticação", async () => {
  const mocks: Record<string, string> = {
    "test:state": `export const state={role:'superadmin',fail:'',stored:{settings:'old',vault:'old',jobs:'blocked',audit:[]},transactions:0};`,
    "@/lib/auth": `import{state}from'test:state';export class AuthError extends Error{constructor(status){super('negado');this.status=status;}}export async function requireUser(role){if(state.role!==role)throw new AuthError(403);return{id:'admin',passwordHash:'hash'};}export function authErrorResponse(error){return Response.json({error:'operação recusada'},{status:error.status||500});}`,
    "@/lib/http-security": `export {privateJson,readJsonObject} from './lib/http-security';export async function enforceControlRateLimit(){}`,
    "@/lib/password": `export async function verifyPassword(value){return value==='correct';}`,
    "@/lib/secrets": `import{state}from'test:state';export function encryptSecret(){if(state.fail==='encryption')throw new Error('encryption unavailable');return'ciphertext-only';}export function decryptSecret(){}`,
    "@/lib/billing/client": `export class BillingError extends Error{};export const billingClient={};export async function billingSettings(){return{baseUrl:'https://billing.example.test/api',headlessBaseUrl:'https://billing.example.test/api/v1/saas',publicAppUrl:'https://app.example.test',productCode:'nalven',appVersion:'0.9.0',licenseTimeoutMs:5000,licenseCacheSeconds:300};}`,
    "@/lib/integrations/security": `export async function validatePublicHttpsUrl(){}`,
    "@/lib/billing/sync": `export function billingAccountFor(){}export function reconcileBilling(){}export function syncBillingOrganization(){}`,
    "@/lib/billing/provision": `export function processBillingJob(){}export function retryBillingProvision(){}export async function unblockBillingJobs(tx){return tx.billingProvisionJob.updateMany();}`,
    "@/lib/billing/catalog-sync": `import{state}from'test:state';export async function syncPlanCatalog(){state.catalogSyncCalls=(state.catalogSyncCalls||0)+1;return{synced:['essencial'],skipped:[],deactivated:[]};}`,
    "@/db/control": `import{state}from'test:state';const tx={
      $executeRaw:async()=>0,
      systemSetting:{upsert:async args=>{state.stored.settings=args.update.value;}},
      vaultSecret:{upsert:async args=>{if(state.fail==='vault')throw new Error('vault failed');state.stored.vault=args.update;}},
      billingProvisionJob:{updateMany:async()=>{if(state.fail==='jobs')throw new Error('jobs failed');state.stored.jobs='pending';}},
      auditLog:{create:async args=>{if(state.fail==='audit')throw new Error('audit failed');state.stored.audit.push(args.data);}}
    };export const controlDb={auditLog:tx.auditLog,$transaction:async callback=>{state.transactions++;const before=structuredClone(state.stored);try{return await callback(tx);}catch(error){state.stored=before;throw error;}}};`,
  };
  const bundle = await build({
    stdin: { contents: 'export {POST} from "./app/api/admin/billing/route";export {state} from "test:state";', resolveDir: process.cwd(), loader: "ts" },
    bundle: true, write: false, platform: "node", format: "cjs", packages: "external",
    plugins: [{ name: "billing-write", setup(plugin) {
      plugin.onResolve({ filter: /.*/ }, args => args.path in mocks ? { path: args.path, namespace: "fixture" } : undefined);
      plugin.onLoad({ filter: /.*/, namespace: "fixture" }, args => ({ contents: mocks[args.path], loader: "js", resolveDir: process.cwd() }));
    } }],
  });
  const routeModule = { exports: {} };
  new Function("require", "module", "exports", bundle.outputFiles[0].text)(createRequire(import.meta.url), routeModule, routeModule.exports);
  const { POST, state } = routeModule.exports as { POST: (request: Request) => Promise<Response>; state: { role: string; fail: string; transactions: number; catalogSyncCalls?: number; stored: { settings: unknown; vault: unknown; jobs: string; audit: unknown[] } } };
  const send = (body: Record<string, unknown>) => POST(new Request("https://app.example.test/api/admin/billing", { method: "POST", headers: { origin: "https://app.example.test", host: "app.example.test", "content-type": "application/json" }, body: JSON.stringify(body) }));
  const apiKey = "skp_nalven_synthetic_test_key";
  const body = { action: "configuration.save", apiKey, currentPassword: "correct", appVersion: "1.0.0" };
  const before = structuredClone(state.stored);
  assert.equal((await send({ action: "configuration.save", baseUrl: "https://changed.example.test" })).status, 403);
  assert.equal((await send({ ...body, apiKey: "invalid" })).status, 400);
  assert.equal(state.transactions, 0);
  assert.equal((await send({ ...body, headlessBaseUrl: "https://billing.example.test/api/external/cliente" })).status, 400);
  assert.equal(state.transactions, 0);
  for (const fail of ["encryption", "vault", "jobs", "audit"]) {
    state.fail = fail;
    assert.equal((await send(body)).status, 500);
    assert.deepEqual(state.stored, before, `rollback after ${fail}`);
  }
  state.fail = "";
  const success = await send(body);
  assert.equal(success.status, 200);
  assert.match(success.headers.get("cache-control") || "", /private, no-store/);
  assert.ok(!(await success.text()).includes(apiKey));
  assert.equal(state.stored.jobs, "pending");
  assert.equal(state.stored.audit.length, 1);
  assert.ok(!JSON.stringify(state.stored).includes(apiKey));
  const saved = structuredClone(state.stored);
  state.fail = "audit";
  assert.equal((await send({ action: "webhook.import", currentPassword: "correct", webhookSecret: "synthetic-webhook-secret-for-test-only-123" })).status, 500);
  assert.deepEqual(state.stored, saved, "webhook credential rolls back when audit fails");
  state.fail = ""; state.role = "user";
  assert.equal((await send(body)).status, 403);
  assert.deepEqual(state.stored, saved);

  state.role = "superadmin";
  const auditBefore = state.stored.audit.length;
  const syncResponse = await send({ action: "catalog_sync" });
  assert.equal(syncResponse.status, 200);
  assert.equal(state.catalogSyncCalls, 1);
  assert.equal(state.stored.audit.length, auditBefore + 1);
});
