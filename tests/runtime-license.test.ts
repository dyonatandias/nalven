import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import test from "node:test";
import { build } from "esbuild";

type Account = { id: string; organizationId: string; externalId: string; licenseSecret: string | null; updatedAt: Date; lastSyncedAt: Date; entitlementCache: unknown };
type Fixture = {
  accounts: Record<string, Account>;
  settings: { baseUrl: string; productCode: string; licenseCacheSeconds: unknown; licenseTimeoutMs: number };
  payload: unknown; status: number; body: string | null; gate: Promise<void> | null; transportFailure: boolean; writeFailure: boolean; casZero: boolean; decryptFailure: boolean;
  calls: Array<{ url: string; options: { method: string; headers: Record<string, string> } }>;
  writes: Array<{ where: { id: string; externalId: string; licenseSecret: string; updatedAt: Date }; data: Record<string, unknown> }>;
  syncWrites: Array<{ data: Record<string, unknown> }>;
  headless: Record<string, unknown>; forbidden: number;
};
type Subject = typeof import("../lib/billing/license") & Pick<typeof import("../lib/billing/sync"), "syncBillingOrganization"> & { state: Fixture; DbNull: object };
const resource = { codigo: "nalven_catalogo", habilitado: true, limite: null };
const valid = () => ({ success: true, valida: true, recursos: [{ ...resource }], limites: [{ codigo: "nalven_usuarios_nomeados", valor: 3 }] });

test("runtime de licença real valida autoridade, cache próprio e concorrência", async t => {
  const mocks: Record<string, string> = {
    "test:runtime-state": "export const state={};export const DbNull={fixtureDbNull:true};",
    "@/generated/control/client": 'import {DbNull} from "test:runtime-state";export const Prisma={DbNull};',
    "@/lib/secrets": 'import {state} from "test:runtime-state";export const decryptSecret=value=>{if(state.decryptFailure)throw new Error("lic_private-secret");return "lic_fixture-key";};',
    "@/lib/integrations/security": `import {state} from "test:runtime-state";export const safeRequest=async(url,options)=>{state.calls.push({url,options});const body=state.body??JSON.stringify(state.payload),status=state.status,gate=state.gate;if(gate)await gate;if(state.transportFailure)throw new Error("lic_private-secret");return{body,status,headers:{"content-type":"application/json"}};};`,
    "test:client": `import {state} from "test:runtime-state";export const billingSettings=async()=>({...state.settings});export class BillingError extends Error{constructor(message,status){super(message);this.status=status;}}
      export const billingClient={customer:async()=>({id:"customer-fixture"}),subscription:async()=>({plano_codigo:"omnichannel",forma_pagamento:"pix",modulos:[],status:"ativa"}),license:async()=>structuredClone(state.headless),portal:async()=>({public:true})};`,
    "test:provision": 'import {state} from "test:runtime-state";const forbidden=async()=>{state.forbidden++;throw new Error("Forbidden provider mutation");};export const processBillingJob=forbidden,processBillingJobs=forbidden,retryBillingProvision=forbidden;',
    "@/db/control": `import {state,DbNull} from "test:runtime-state";
      const byId=id=>Object.values(state.accounts).find(row=>row.id===id);
      export const controlDb={organization:{findUnique:async({where})=>state.accounts[where.id]?{id:where.id,slug:state.accounts[where.id].externalId}:null},billingAccount:{
        findUnique:async({where})=>{const row=where.organizationId?state.accounts[where.organizationId]:byId(where.id);return row?structuredClone(row):null;},
        upsert:async({where})=>structuredClone(state.accounts[where.organizationId]),
        updateMany:async(args)=>{state.writes.push(args);if(state.writeFailure)throw new Error("private-db-secret");const row=byId(args.where.id);if(state.casZero||!row||row.externalId!==args.where.externalId||row.licenseSecret!==args.where.licenseSecret||row.updatedAt.getTime()!==args.where.updatedAt.getTime())return{count:0};Object.assign(row,structuredClone(args.data),{entitlementCache:args.data.entitlementCache===DbNull?null:args.data.entitlementCache,updatedAt:new Date(row.updatedAt.getTime()+1)});return{count:1};},
        update:async(args)=>{state.syncWrites.push(args);const row=byId(args.where.id);Object.assign(row,structuredClone(args.data),{entitlementCache:args.data.entitlementCache===DbNull?null:args.data.entitlementCache,updatedAt:new Date(row.updatedAt.getTime()+1)});return structuredClone(row);}
      }};`,
  };
  const built = await build({ stdin: { contents: 'export * from "./lib/billing/license";export {syncBillingOrganization} from "./lib/billing/sync";export {state,DbNull} from "test:runtime-state";', resolveDir: process.cwd(), loader: "ts" }, bundle: true, write: false, platform: "node", format: "cjs", packages: "external", plugins: [{ name: "runtime-license-io", setup(plugin) {
    plugin.onResolve({ filter: /.*/ }, args => {
      const path = args.path === "./client" && /lib\/billing\/(license|sync)\.ts$/.test(args.importer) ? "test:client" : args.path === "./provision" && args.importer.endsWith("/lib/billing/sync.ts") ? "test:provision" : args.path;
      return path in mocks ? { path, namespace: "fixture" } : undefined;
    });
    plugin.onLoad({ filter: /.*/, namespace: "fixture" }, args => ({ contents: mocks[args.path], loader: "js", resolveDir: process.cwd() }));
  } }] });
  const subjectModule = { exports: {} };
  new Function("require", "module", "exports", built.outputFiles[0].text)(createRequire(import.meta.url), subjectModule, subjectModule.exports);
  const { tenantLicense, assertTenantLicensed, LicenseDeniedError, syncBillingOrganization, state, DbNull } = subjectModule.exports as Subject;
  let generation = 0;
  const account = (organizationId = "org-a"): Account => ({ id: `account-${organizationId}`, organizationId, externalId: `tenant-${organizationId}`, licenseSecret: "encrypted-fixture", updatedAt: new Date("2026-09-01T00:00:00Z"), lastSyncedAt: new Date(), entitlementCache: null });
  const reset = () => Object.assign(state, { accounts: { "org-a": account() }, settings: { baseUrl: "https://billing.invalid/api/v1/", productCode: `nalven-${generation++}`, licenseCacheSeconds: 300, licenseTimeoutMs: 5000 }, payload: valid(), status: 200, body: null, gate: null, transportFailure: false, writeFailure: false, casZero: false, decryptFailure: false, calls: [], writes: [], syncWrites: [], headless: { license: { status: "ativa", recursos: [resource] } }, forbidden: 0 });
  const cache = (checkedAt = Date.now(), payload: unknown = valid(), organizationId = "org-a") => ({ source: "nalven-runtime-v1", checkedAt, contextHash: createHash("sha256").update(JSON.stringify([organizationId, state.accounts[organizationId].externalId, state.settings.baseUrl.replace(/\/+$/, ""), state.settings.productCode, state.accounts[organizationId].licenseSecret])).digest("hex"), payload });
  const denied = (error: unknown) => { assert.ok(error instanceof LicenseDeniedError); assert.equal(error.status, 403); assert.doesNotMatch(error.message, /private-|lic_|encrypted-fixture|secret|<script>/); return true; };
  const defer = () => { let release!: () => void; const promise = new Promise<void>(resolve => { release = resolve; }); return { promise, release }; };
  const turn = () => new Promise<void>(resolve => setImmediate(resolve));

  await t.test("cache legado/headless nunca autoriza e GET cria wrapper sem renovar timestamp financeiro", async () => {
    for (const legacy of [valid(), { license: { status: "ativa", recursos: [resource] } }, [], { source: "other", payload: valid() }]) {
      reset(); state.accounts["org-a"].entitlementCache = legacy;
      assert.equal((await tenantLicense("org-a")).valida, true); assert.equal(state.calls.length, 1);
      const write = state.writes[0]; assert.equal("lastSyncedAt" in write.data, false);
      assert.equal(write.where.externalId, "tenant-org-a"); assert.equal(write.where.licenseSecret, "encrypted-fixture"); assert.ok(write.where.updatedAt instanceof Date);
      const stored = write.data.entitlementCache as ReturnType<typeof cache>;
      assert.equal(stored.source, "nalven-runtime-v1"); assert.equal(typeof stored.checkedAt, "number"); assert.match(stored.contextHash, /^[a-f0-9]{64}$/);
      assert.equal(state.calls[0].options.method, "GET"); assert.match(state.calls[0].url, /\/licencas\/entitlements\?/); assert.doesNotMatch(state.calls[0].url, /lic_fixture/);
    }
  });

  await t.test("TTL próprio ignora lastSyncedAt recente/velho; futuro e payload inválido forçam GET", async () => {
    reset(); state.accounts["org-a"].entitlementCache = cache(); state.accounts["org-a"].lastSyncedAt = new Date(0);
    assert.equal((await tenantLicense("org-a")).valida, true); assert.equal(state.calls.length, 0);
    for (const candidate of [cache(Date.now() - 301_000), cache(Date.now() + 60_000), cache(Date.now(), { success: true, valida: "true", recursos: [] }), { ...cache(), checkedAt: "today" }]) {
      reset(); state.accounts["org-a"].entitlementCache = candidate;
      await tenantLicense("org-a"); assert.equal(state.calls.length, 1);
    }
    reset(); state.accounts["org-a"].entitlementCache = cache(); await tenantLicense("org-a", { force: true }); assert.equal(state.calls.length, 1);
  });

  await t.test("TTL configurado é limitado a 30..3600 segundos e fallback300", async () => {
    for (const [configured, age, fresh] of [[0, 20_000, true], [0, 31_000, false], [99_999, 3_599_000, true], [99_999, 3_601_000, false], ["900", 301_000, false], [null, 299_000, true], [NaN, 301_000, false]] as Array<[unknown, number, boolean]>) {
      reset(); state.settings.licenseCacheSeconds = configured; state.accounts["org-a"].entitlementCache = cache(Date.now() - age);
      await tenantLicense("org-a"); assert.equal(state.calls.length, fresh ? 0 : 1);
    }
  });

  await t.test("contexto inclui organização, externalId, endpoint, produto e chave cifrada", async () => {
    for (const change of [() => { state.accounts["org-a"].externalId = "tenant-changed"; }, () => { state.accounts["org-a"].licenseSecret = "encrypted-replaced"; }, () => { state.settings.baseUrl = "https://other.invalid/api/v1"; }, () => { state.settings.productCode = "other-product"; }]) {
      reset(); state.accounts["org-a"].entitlementCache = cache(); change(); await tenantLicense("org-a"); assert.equal(state.calls.length, 1);
    }
    reset(); const original = cache(); state.accounts["org-b"] = { ...account("org-b"), externalId: state.accounts["org-a"].externalId, entitlementCache: original };
    await tenantLicense("org-b"); assert.equal(state.calls.length, 1);
    reset(); state.accounts["org-a"].entitlementCache = cache(); state.accounts["org-a"].licenseSecret = null;
    await assert.rejects(tenantLicense("org-a"), denied); assert.equal(state.calls.length, 0);
  });

  await t.test("booleans estritos e coleções/códigos duplicados ou malformados não autorizam", async () => {
    for (const payload of [null, [], { license: valid() }, { ...valid(), success: "true" }, { ...valid(), valida: "true" }, { ...valid(), valida: 1 }, { success: true, valida: true }, { ...valid(), recursos: null }, { ...valid(), recursos: [{ ...resource, habilitado: "false" }] }, { ...valid(), recursos: [{ ...resource, codigo: "../bad" }] }, { ...valid(), recursos: [resource, resource] }, { ...valid(), recursos: Array.from({ length: 5001 }, () => resource) }, { ...valid(), limites: [{ codigo: "same", valor: 1 }, { codigo: "same", valor: 2 }] }, { ...valid(), limites: {} }]) {
      reset(); state.payload = payload; await assert.rejects(tenantLicense("org-a"), denied); assert.equal(state.writes.length, 0);
    }
    reset(); state.body = "invalid-json lic_private-secret"; await assert.rejects(tenantLicense("org-a"), denied);
  });

  await t.test("cota zero e habilitação false negam recurso, null permite habilitação sem inventar ilimitado", async () => {
    reset(); assert.equal((await assertTenantLicensed("org-a", resource.codigo)).recursos[0].limite, null);
    for (const value of [{ ...resource, limite: 0 }, { ...resource, habilitado: false }]) {
      reset(); state.payload = { ...valid(), recursos: [value] }; await assert.rejects(assertTenantLicensed("org-a", resource.codigo), denied);
    }
    reset(); await assert.rejects(assertTenantLicensed("org-a", "missing_resource"), denied);
    for (const limit of [-1, -0.5, "0", true, Number.MAX_SAFE_INTEGER + 1, undefined]) {
      reset(); state.payload = { ...valid(), recursos: [{ ...resource, limite: limit }] }; await assert.rejects(tenantLicense("org-a"), denied);
      reset(); state.payload = { ...valid(), limites: [{ codigo: "quota", valor: limit }] }; await assert.rejects(tenantLicense("org-a"), denied);
    }
    reset(); state.body = '{"success":true,"valida":true,"recursos":[{"codigo":"quota","habilitado":true,"limite":1e400}]}'; await assert.rejects(tenantLicense("org-a"), denied);
    reset(); state.payload = { ...valid(), recursos: [{ ...resource, limite: 0.5 }] }; assert.equal((await tenantLicense("org-a")).recursos[0].limite, 0.5);
  });

  await t.test("códigos alfanuméricos/ponto preservam case e não ganham aliases de autorização", async () => {
    reset(); const codigo = "2.Custom-Quota_1";
    state.payload = { ...valid(), recursos: [{ ...resource, codigo }], limites: [{ codigo, valor: 2 }] };
    const license = await assertTenantLicensed("org-a", codigo);
    assert.equal(license.recursos[0].codigo, codigo); assert.equal(license.limites?.[0].codigo, codigo);
    await assert.rejects(assertTenantLicensed("org-a", codigo.toLowerCase()), denied);
  });

  await t.test("invalidade explícita é cacheada mas sempre negada sem motivo ou segredo remoto", async () => {
    reset(); state.payload = { success: true, valida: false, motivo: "lic_private-secret <script>", key: "lic_private-secret" };
    await assert.rejects(tenantLicense("org-a"), denied); assert.equal(state.writes[0].data.licenseStatus, "invalid");
    await assert.rejects(tenantLicense("org-a"), denied); assert.equal(state.calls.length, 1);
    assert.doesNotMatch(JSON.stringify(state.accounts["org-a"].entitlementCache), /private-|motivo|key/);
    reset(); state.payload = { ...valid(), motivo: "private-reason", key: "lic_private-secret", cliente: { email: "private@example.invalid" } };
    const license = await tenantLicense("org-a"); assert.doesNotMatch(JSON.stringify(license), /private-|motivo|key|cliente/);
    for (const status of [401, 403, 429, 500]) { reset(); state.status = status; state.payload = { motivo: "lic_private-secret" }; await assert.rejects(tenantLicense("org-a"), denied); assert.equal(state.writes.length, [401, 403].includes(status) ? 1 : 0); }
  });

  await t.test("rechecagem 401/403 revoga cache válido e não o reutiliza na próxima consulta", async () => {
    for (const status of [401, 403]) {
      reset(); state.accounts["org-a"].entitlementCache = cache(); state.status = status;
      await assert.rejects(tenantLicense("org-a", { force: true }), denied);
      assert.equal(state.writes[0].data.entitlementCache, DbNull); assert.equal(state.accounts["org-a"].entitlementCache, null);
      await assert.rejects(tenantLicense("org-a"), denied); assert.equal(state.calls.length, 2);
      assert.equal("lastSyncedAt" in state.writes[0].data, false);
    }
    reset(); state.accounts["org-a"].entitlementCache = cache(); state.payload = { success: true, valida: false };
    await assert.rejects(tenantLicense("org-a", { force: true }), denied);
    await assert.rejects(tenantLicense("org-a"), denied); assert.equal(state.calls.length, 1);
  });

  await t.test("negativa conhecida não reutiliza cache se a invalidação falha no banco ou CAS", async () => {
    for (const invalidity of ["http403", "valida-false"]) for (const flag of ["writeFailure", "casZero"] as const) {
      reset(); const stale = cache(Date.now() - 1000); state.accounts["org-a"].entitlementCache = stale; state.status = 403; state[flag] = true;
      if (invalidity === "valida-false") { state.status = 200; state.payload = { success: true, valida: false }; }
      await assert.rejects(tenantLicense("org-a", { force: true }), denied);
      assert.deepEqual(state.accounts["org-a"].entitlementCache, stale);
      state[flag] = false;
      if (flag === "casZero") state.accounts["org-a"].updatedAt = new Date(state.accounts["org-a"].updatedAt.getTime() + 1);
      await assert.rejects(tenantLicense("org-a"), denied); assert.equal(state.calls.length, 2);
    }
  });

  await t.test("tombstone não revoga chave/contexto novo nem cache checado depois da negativa", async () => {
    reset(); state.accounts["org-a"].entitlementCache = cache(Date.now() - 1000); state.status = 403; state.writeFailure = true;
    await assert.rejects(tenantLicense("org-a", { force: true }), denied);
    state.writeFailure = false; state.status = 200;
    const originalSecret = state.accounts["org-a"].licenseSecret;
    state.accounts["org-a"].licenseSecret = "encrypted-context-new"; state.accounts["org-a"].entitlementCache = cache(Date.now() - 1000);
    assert.equal((await tenantLicense("org-a")).valida, true); assert.equal(state.calls.length, 1);
    state.accounts["org-a"].licenseSecret = originalSecret;
    await new Promise(resolve => setTimeout(resolve, 2));
    state.accounts["org-a"].entitlementCache = cache();
    assert.equal((await tenantLicense("org-a")).valida, true); assert.equal(state.calls.length, 1);
  });

  await t.test("consultas concorrentes da mesma versão compartilham um GET e um CAS", async () => {
    reset(); const hold = defer(); state.gate = hold.promise;
    const reads = Array.from({ length: 5 }, () => tenantLicense("org-a")); await turn(); assert.equal(state.calls.length, 1);
    hold.release(); const values = await Promise.all(reads); assert.ok(values.every(value => value.valida === true)); assert.equal(state.writes.length, 1);
  });

  await t.test("troca de chave/versão durante GET separa leituras e impede autorização antiga", async () => {
    reset(); const hold = defer(); state.gate = hold.promise;
    const old = tenantLicense("org-a"); const oldDenied = assert.rejects(old, denied); await turn();
    state.accounts["org-a"].licenseSecret = "encrypted-new"; state.accounts["org-a"].updatedAt = new Date(state.accounts["org-a"].updatedAt.getTime() + 1); state.gate = null;
    assert.equal((await tenantLicense("org-a")).valida, true); hold.release(); await oldDenied;
    assert.equal(state.calls.length, 2); assert.equal(state.writes.length, 2);
    const stored = state.accounts["org-a"].entitlementCache as ReturnType<typeof cache>; assert.equal(stored.contextHash, cache().contextHash);
    reset(); const versionHold = defer(); state.gate = versionHold.promise;
    const versionOld = assert.rejects(tenantLicense("org-a"), denied); await turn();
    state.accounts["org-a"].updatedAt = new Date(state.accounts["org-a"].updatedAt.getTime() + 1); state.gate = null;
    await tenantLicense("org-a"); versionHold.release(); await versionOld; assert.equal(state.calls.length, 2);
  });

  await t.test("CAS zero ou falha de persistência/transporte nunca libera resposta remota", async () => {
    for (const flag of ["casZero", "writeFailure", "transportFailure", "decryptFailure"] as const) {
      reset(); state[flag] = true; await assert.rejects(tenantLicense("org-a"), denied); assert.equal(state.accounts["org-a"].entitlementCache, null);
      state[flag] = false; assert.equal((await tenantLicense("org-a")).valida, true);
    }
  });

  await t.test("sincronização financeira extrai license.status e invalida cache com DbNull", async () => {
    reset(); state.accounts["org-a"].entitlementCache = cache();
    await syncBillingOrganization("org-a", false);
    assert.equal(state.syncWrites[0].data.entitlementCache, DbNull); assert.equal(state.syncWrites[0].data.licenseStatus, "ativa"); assert.ok(state.syncWrites[0].data.lastSyncedAt instanceof Date);
    assert.equal(state.accounts["org-a"].entitlementCache, null); assert.equal(state.forbidden, 0); assert.equal(state.calls.length, 0);
    await tenantLicense("org-a"); assert.equal(state.calls.length, 1);
    reset(); const hold = defer(); state.gate = hold.promise; const stale = assert.rejects(tenantLicense("org-a"), denied); await turn();
    await syncBillingOrganization("org-a", false); hold.release(); await stale; assert.equal(state.accounts["org-a"].entitlementCache, null);
  });

  await t.test("limite de consultas pendentes é bounded e nenhuma rotação/ativação é disparada", async () => {
    reset(); const hold = defer(); state.gate = hold.promise;
    for (let index = 0; index < 61; index++) state.accounts[`org-${index}`] = account(`org-${index}`);
    const reads = Array.from({ length: 60 }, (_, index) => tenantLicense(`org-${index}`)); await turn();
    await assert.rejects(tenantLicense("org-60"), denied); assert.equal(state.calls.length, 60);
    hold.release(); await Promise.all(reads); assert.equal(state.forbidden, 0);
    assert.ok(state.calls.every(call => call.options.method === "GET" && call.url.includes("/licencas/entitlements?")));
  });

  await t.test("saturação de tombstones não reabre cache antigo; GET novo continua permitido", async () => {
    reset(); state.status = 403; state.writeFailure = true;
    for (let index = 0; index < 257; index++) {
      const organizationId = `blocked-${index}`;
      state.accounts[organizationId] = account(organizationId);
      state.accounts[organizationId].entitlementCache = cache(Date.now() - 1000, valid(), organizationId);
      await assert.rejects(tenantLicense(organizationId, { force: true }), denied);
    }
    const previousCalls = state.calls.length;
    await assert.rejects(tenantLicense("blocked-0"), denied); assert.equal(state.calls.length, previousCalls + 1);
    state.status = 200; state.writeFailure = false;
    assert.equal((await tenantLicense("blocked-0")).valida, true);
    await new Promise(resolve => setTimeout(resolve, 2));
    state.accounts["new-context"] = account("new-context");
    state.accounts["new-context"].entitlementCache = cache(Date.now(), valid(), "new-context");
    const beforeNewContext = state.calls.length;
    assert.equal((await tenantLicense("new-context")).valida, true); assert.equal(state.calls.length, beforeNewContext);
  });
});
