import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";
import { build } from "esbuild";

test("financeiro exige superadmin e consulta somente dados de apresentação", async () => {
  const mocks: Record<string, string> = {
    "test:state": "export const state={role:'user',queries:[]};",
    "@/lib/auth": `import {state} from 'test:state';export class AuthError extends Error{};export async function requireUser(role){if(state.role!==role)throw new AuthError();return{id:'admin'};}export function authErrorResponse(){return Response.json({error:'negado'},{status:403});}`,
    "@/db/control": `import {state} from 'test:state';const table=name=>({findMany:async args=>{state.queries.push({name,...args});return[];}});export const controlDb={billingAccount:table('accounts'),billingWebhookEvent:table('events'),billingProvisionJob:table('jobs'),billingSyncRun:{findMany:async()=>{throw new Error('Não consultar registros internos sem consumidor');}}};`,
    "@/lib/billing/client": `export class BillingError extends Error{};export const billingClient={configured:async()=>true};export async function billingSettings(){return{publicAppUrl:'https://app.example.test'};}`,
    "@/lib/vault": `export const VAULT_KEYS={billingApi:'api',billingWebhook:'webhook'};export async function vaultMetadata(){return[];}export function fingerprintSecret(){}export function generateWebhookSecret(){}export function setVaultSecret(){}`,
    "@/lib/billing/provision": "export function processBillingJob(){}export function retryBillingProvision(){}export function unblockBillingJobs(){}",
    "@/lib/billing/sync": "export function billingAccountFor(){}export function reconcileBilling(){}export function syncBillingOrganization(){}",
    "@/lib/password": "export function verifyPassword(){}",
    "@/lib/integrations/security": "export function validatePublicHttpsUrl(){}",
  };
  const bundle = await build({
    stdin: { contents: 'export {GET} from "./app/api/admin/billing/route";export {state} from "test:state";', resolveDir: process.cwd(), loader: "ts" },
    bundle: true, write: false, platform: "node", format: "cjs", packages: "external",
    plugins: [{ name: "billing-read-dependencies", setup(plugin) {
      plugin.onResolve({ filter: /.*/ }, args => args.path in mocks ? { path: args.path, namespace: "fixture" } : undefined);
      plugin.onLoad({ filter: /.*/, namespace: "fixture" }, args => ({ contents: mocks[args.path], loader: "js", resolveDir: process.cwd() }));
    } }],
  });
  const routeModule = { exports: {} };
  new Function("require", "module", "exports", bundle.outputFiles[0].text)(createRequire(import.meta.url), routeModule, routeModule.exports);
  const { GET, state } = routeModule.exports as { GET: () => Promise<Response>; state: { role: string; queries: Array<{ name: string; select: Record<string, unknown> }> } };
  assert.equal((await GET()).status, 403);
  assert.equal(state.queries.length, 0);
  state.role = "superadmin";
  const response = await GET();
  assert.equal(response.status, 200);
  assert.match(response.headers.get("cache-control") || "", /private, no-store/);
  assert.deepEqual(Object.keys(await response.json()).sort(), ["accounts", "configuration", "events", "jobs"]);
  assert.deepEqual(state.queries.map(query => query.name), ["accounts", "events", "jobs"]);
  for (const query of state.queries) {
    assert.ok(query.select);
    for (const field of ["licenseSecret", "licenseCache", "payload", "metadata", "modules"]) assert.equal(query.select[field], undefined);
  }
});
