import assert from "node:assert/strict";
import { createHash, createHmac } from "node:crypto";
import { createRequire } from "node:module";
import { build } from "esbuild";
import test from "node:test";

const webhookSecret = "fixture-webhook-secret-not-real";
const resources = [{ codigo: "nalven_catalogo", habilitado: true, limite: null }];
const validLicense = () => ({ success: true, valida: true, recursos: resources });

test("webhook assinado invalida autorização runtime e preserva escopo/idempotência", async t => {
  const mocks: Record<string, string> = {
    "test:webhook-state": 'export const state={};export const DbNull={fixtureDbNull:true};',
    "@/generated/control/client": 'import {DbNull} from "test:webhook-state";export const Prisma={DbNull};',
    "@/lib/vault": `import {state} from "test:webhook-state";export const VAULT_KEYS={billingWebhook:"billing_webhook"};export const getVaultSecret=async()=>state.secret;`,
    "@/lib/secrets": 'export const decryptSecret=()=>"lic_fixture_key";',
    "test:billing-client": 'export const billingSettings=async()=>({baseUrl:"https://billing.invalid/api/v1",productCode:"nalven",licenseCacheSeconds:300,licenseTimeoutMs:5000});',
    "@/lib/integrations/security": `import {state} from "test:webhook-state";export async function safeRequest(url,options){state.remoteCalls.push({url,method:options.method});if(options.method!=="GET")throw new Error("Forbidden provider mutation");const body=JSON.stringify(state.remote),gate=state.gate;if(gate)await gate;return{status:200,body,headers:{"content-type":"application/json"}};}`,
    "@/db/control": `import {state,DbNull} from "test:webhook-state";
      function apply(data){for(const[key,value]of Object.entries(data))state.account[key]=value===DbNull?null:structuredClone(value);state.account.updatedAt=new Date(state.account.updatedAt.getTime()+1);}
      export const controlDb={
        apiRateLimit:{findUnique:async()=>null,upsert:async()=>({}),update:async()=>({})},
        $executeRaw:async()=>0,
        $transaction:async fn=>{const snapshot=structuredClone({account:state.account,organization:state.organization,events:state.events});try{return await fn(controlDb);}catch(error){Object.assign(state,snapshot);throw error;}},
        billingWebhookEvent:{findFirst:async({where})=>state.events.find(event=>event.webhookId===where.OR[0].webhookId||JSON.stringify(event.payload)===JSON.stringify(where.OR[1].payload.equals))||null,create:async({data})=>{state.events.push(structuredClone(data));return data;},update:async({where,data})=>{Object.assign(state.events.find(event=>event.webhookId===where.webhookId),data);}},
        organization:{findUnique:async({where})=>state.organization?.id===where.id?structuredClone(state.organization):null,update:async({data})=>{state.orgWrites.push(data);Object.assign(state.organization,data);return state.organization;}},
        billingAccount:{findUnique:async({where})=>(where.externalId?where.externalId===state.account?.externalId:where.organizationId===state.account?.organizationId)?structuredClone(state.account):null,upsert:async args=>{state.webhookWrites.push(args);if(state.failWrite)throw new Error("Fixture persistence failure");apply(args.update);return state.account;},updateMany:async args=>{state.runtimeWrites.push(args);if(args.where.updatedAt.getTime()!==state.account.updatedAt.getTime()||args.where.externalId!==state.account.externalId||args.where.licenseSecret!==state.account.licenseSecret)return{count:0};apply(args.data);return{count:1};}}
      };`,
  };
  const bundle = await build({ stdin: { contents: 'export * as route from "./app/api/webhooks/billing/route";export {tenantLicense,LicenseDeniedError} from "./lib/billing/license";export {state,DbNull} from "test:webhook-state";', resolveDir: process.cwd(), loader: "ts" }, bundle: true, write: false, platform: "node", format: "cjs", packages: "external", plugins: [{ name: "webhook-license-mocks", setup(plugin) {
    plugin.onResolve({ filter: /.*/ }, args => { const path = args.path === "./client" && args.importer.endsWith("/lib/billing/license.ts") ? "test:billing-client" : args.path; return path in mocks ? { path, namespace: "fixture" } : undefined; });
    plugin.onLoad({ filter: /.*/, namespace: "fixture" }, args => ({ contents: mocks[args.path], loader: "js", resolveDir: process.cwd() }));
  } }] });
  const routeModule = { exports: {} }; new Function("require", "module", "exports", bundle.outputFiles[0].text)(createRequire(import.meta.url), routeModule, routeModule.exports);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { route, tenantLicense, LicenseDeniedError, state, DbNull } = routeModule.exports as Record<string, any>;
  let sequence = 0;
  const reset = () => {
    sequence++; const organizationId = `fixture-org-${sequence}`, externalId = `fixture-tenant-${sequence}`, encrypted = "fixture-encrypted";
    const cache = { source: "nalven-runtime-v1", checkedAt: Date.now(), contextHash: createHash("sha256").update(JSON.stringify([organizationId, externalId, "https://billing.invalid/api/v1", "nalven", encrypted])).digest("hex"), payload: validLicense() };
    Object.assign(state, { secret: webhookSecret, organization: { id: organizationId, slug: externalId, status: "active" }, account: { id: "fixture-account", organizationId, externalId, licenseSecret: encrypted, updatedAt: new Date("2026-09-08T00:00:00Z"), lastSyncedAt: new Date(), entitlementCache: cache }, events: [], webhookWrites: [], runtimeWrites: [], orgWrites: [], remoteCalls: [], remote: validLicense(), gate: null, failWrite: false });
  };
  const event = (name = "licenca.atualizada") => ({ event: name, instance_id: state.organization.slug, ocorrido_em: "2026-09-08T01:00:00Z", cliente_id: 1, produto_id: 1 });
  const request = (payload: unknown, options: { secret?: string; id?: string; raw?: string; type?: string } = {}) => {
    const raw = options.raw ?? JSON.stringify(payload), signature = `sha256=${createHmac("sha256", options.secret ?? webhookSecret).update(raw).digest("hex")}`;
    return new Request("https://nalven.example/api/webhooks/billing", { method: "POST", headers: { "content-type": options.type ?? "application/json", "x-billing-signature": signature, "x-webhook-id": options.id ?? "fixture-delivery-12345678", "x-real-ip": "192.0.2.10" }, body: raw });
  };

  await t.test("webhook usa identidade congelada mesmo após mudança de slug", async () => {
    reset(); const stableId = state.account.externalId; state.organization.slug = "renamed-store";
    assert.equal((await route.POST(request({ ...event(), instance_id: stableId }))).status, 200);
    assert.equal(state.webhookWrites.length, 1);
    assert.equal(state.account.externalId, stableId);
    reset(); state.account.externalId = state.organization.id;
    assert.equal((await route.POST(request({ ...event(), instance_id: state.organization.id }))).status, 200);
    assert.equal(state.webhookWrites.length, 1);
    reset();
    assert.equal((await route.POST(request({ ...event(), instance_id: state.organization.id }))).status, 200);
    assert.equal(state.webhookWrites.length, 0, "não aceitar segunda identidade para vínculo legado");
  });
  await t.test("licença/recurso atualizado limpa wrapper em transação sem alterar status ou chamar provedor", async () => {
    reset(); assert.equal((await tenantLicense(state.organization.id)).valida, true); assert.equal(state.remoteCalls.length, 0);
    const response = await route.POST(request(event())); assert.equal(response.status, 200); assert.match(response.headers.get("cache-control"), /private, no-store/);
    assert.equal(state.webhookWrites[0].update.entitlementCache, DbNull); assert.equal(state.account.entitlementCache, null); assert.equal(state.account.lastSyncedAt, null); assert.equal(state.orgWrites.length, 0); assert.equal(state.remoteCalls.length, 0); assert.ok(state.events[0].processedAt instanceof Date);
    state.remote = { success: true, valida: false }; await assert.rejects(tenantLicense(state.organization.id), LicenseDeniedError); assert.equal(state.remoteCalls.length, 1);
  });
  await t.test("GET iniciado antes do webhook não pode regravar autorização obsoleta", async () => {
    reset(); state.account.entitlementCache = null; let release!: () => void; state.gate = new Promise<void>(resolve => { release = resolve; });
    const old = assert.rejects(tenantLicense(state.organization.id), LicenseDeniedError); await new Promise(resolve => setImmediate(resolve)); assert.equal(state.remoteCalls.length, 1);
    assert.equal((await route.POST(request(event()))).status, 200); release(); await old; assert.equal(state.account.entitlementCache, null);
    state.gate = null; state.remote = { success: true, valida: false }; await assert.rejects(tenantLicense(state.organization.id), LicenseDeniedError); assert.equal(state.remoteCalls.length, 2);
  });
  await t.test("mesmo evento repetido não reinvalida uma licença recém-consultada", async () => {
    reset(); const payload = event(); await route.POST(request(payload)); await tenantLicense(state.organization.id); const cache = structuredClone(state.account.entitlementCache);
    assert.equal((await route.POST(request(payload, { id: "different-delivery-12345678" }))).status, 200);
    assert.equal(state.webhookWrites.length, 1); assert.equal(state.events.length, 1); assert.deepEqual(state.account.entitlementCache, cache);
  });
  await t.test("assinatura/tipo/corpo/segredo inválidos não alteram conta ou eventos", async () => {
    reset(); for (const [options, status] of [[{ secret: "wrong-fixture-secret" }, 401], [{ id: "short" }, 400], [{ type: "text/plain" }, 415], [{ raw: "{" }, 400], [{ raw: "x".repeat(256 * 1024 + 1) }, 413]] as const) assert.equal((await route.POST(request(event(), options))).status, status);
    state.secret = null; assert.equal((await route.POST(request(event()))).status, 503);
    assert.equal(state.webhookWrites.length, 0); assert.equal(state.events.length, 0); assert.equal(state.remoteCalls.length, 0); assert.ok(state.account.entitlementCache);
  });
  await t.test("evento de outra empresa não invalida a conta corrente", async () => {
    reset(); assert.equal((await route.POST(request({ ...event(), instance_id: "unknown-fixture-tenant" }))).status, 200);
    assert.equal(state.webhookWrites.length, 0); assert.ok(state.account.entitlementCache); assert.equal(state.orgWrites.length, 0);
  });
  await t.test("eventos financeiros mantêm mapeamento de suspensão e também removem cache", async () => {
    reset(); assert.equal((await route.POST(request(event("assinatura.suspensa")))).status, 200);
    assert.equal(state.webhookWrites[0].update.subscriptionStatus, "suspended"); assert.equal(state.organization.status, "past_due"); assert.equal(state.account.entitlementCache, null); assert.equal(state.remoteCalls.length, 0);
  });
  await t.test("falha transacional não marca evento processado e permite retentativa", async () => {
    reset(); const payload = event(); state.failWrite = true;
    const response = await route.POST(request(payload)); assert.equal(response.status, 500); assert.doesNotMatch(await response.text(), /fixture-|secret/); assert.equal(state.events.length, 0); assert.ok(state.account.entitlementCache);
    state.failWrite = false; assert.equal((await route.POST(request(payload))).status, 200); assert.equal(state.events.length, 1); assert.equal(state.account.entitlementCache, null);
  });
});
