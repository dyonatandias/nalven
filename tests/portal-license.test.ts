import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";
import { build } from "esbuild";
import { licenseDate, licenseLimit, portalLicenseDiagnostic, portalLicensePayload, PortalLicenseDataError, type PortalLicenseData } from "../lib/billing/portal-license-data";

const observed = { license: { id: "private-id", chave_prefix: "private-prefix", chave: "private-key", metadata: { secret: "private-metadata" }, status: "ativa", valida_de: "2026-08-25T12:00:00-03:00", valida_ate: null, grace_ate: null, max_instalacoes: 3, plano_codigo: "profissional", plano_nome: "Profissional", recursos: [
  { codigo: "nalven_catalogo", nome: "Catálogo", habilitado: true, limite: null, origem: "plano", private_notes: "private-note" },
  { codigo: "nalven_usuarios_nomeados", nome: "Usuários", habilitado: true, limite: 5, origem: "plano" },
  { codigo: "nalven_estoque", nome: "Estoque", habilitado: true, limite: 0, origem: "plano" },
  { codigo: "nalven_marketplaces", nome: "Marketplaces", habilitado: false, limite: 1, origem: "plano" },
] } };

test("licença headless real é projetada sem segredo e sem fabricar validação runtime", () => {
  const { license } = portalLicensePayload(observed);
  assert.equal(license.status, "active"); assert.equal(license.valid, null); assert.equal(license.plan.code, "profissional");
  assert.deepEqual(license.validUntil, { kind: "not_defined", value: null });
  assert.equal(license.validFrom.value, "2026-08-25T12:00:00-03:00");
  assert.deepEqual(license.resources.map(item => item.availability), ["enabled", "enabled", "disabled", "disabled"]);
  assert.equal(license.resources[2].limit.value, 0); assert.equal(license.resources[0].limit.kind, "no_quota");
  assert.equal(license.resourcesKnown, true); assert.equal(license.limitsKnown, false);
  assert.doesNotMatch(JSON.stringify(license), /private-|chave|grace_ate|metadata/);
  assert.deepEqual(license.graceUntil, { kind: "not_defined", value: null });
});

test("habilitações, números e estados não usam coerção nem sentinela negativa", () => {
  for (const value of [undefined, "0", "5", false, true, -1, Infinity, NaN, {}, [], Number.MAX_SAFE_INTEGER + 1]) assert.equal(licenseLimit(value).kind, "unknown");
  assert.deepEqual(licenseLimit(0), { kind: "finite", value: 0 }); assert.deepEqual(licenseLimit(0.5), { kind: "finite", value: 0.5 });
  const { license } = portalLicensePayload({ status: "future_status", valida: "true", recursos: [{ codigo: "flag", habilitado: "false", limite: null }, { codigo: "missing", habilitado: true }, { codigo: "disabled", habilitado: false }] });
  assert.equal(license.status, "unknown"); assert.equal(license.statusCode, null); assert.equal(license.valid, null);
  assert.deepEqual(license.resources.map(item => item.availability), ["unknown", "unknown", "disabled"]);
  assert.equal(portalLicensePayload({ valida: true }).license.status, "unknown");
  assert.equal(portalLicensePayload({ status: "constructor" }).license.status, "unknown");
  assert.equal(portalLicensePayload({ status: "suspensa", valida: false }).license.valid, false);
  assert.equal(portalLicensePayload({ status: "expirada" }).license.status, "expired");
});

test("limite individual explícito tem precedência; null de métrica não vira capacidade infinita", () => {
  const { license } = portalLicensePayload({ status: "ativa", recursos: [{ codigo: "zero", habilitado: true, limite: 0 }, { codigo: "no_quota", habilitado: true, limite: null }, { codigo: "fallback", habilitado: true }, { codigo: "malformed", habilitado: true, limite: "10" }], limites: [{ codigo: "zero", valor: 10 }, { codigo: "no_quota", valor: 20 }, { codigo: "fallback", valor: 3 }, { codigo: "malformed", valor: 10 }, { codigo: "null_metric", valor: null }] });
  assert.deepEqual(license.resources.map(item => item.limit.value), [0, null, 3, null]);
  assert.deepEqual(license.resources.map(item => item.limit.kind), ["finite", "no_quota", "finite", "unknown"]);
  assert.equal(license.limits.at(-1)?.limit.kind, "unknown");
});

test("datas ausentes e inválidas nunca significam sem expiração", () => {
  for (const value of [undefined, "", false, 0, "2026-02-30", "2026-09-08T24:00:00Z", "2026-09-08T10:61:00Z", "yesterday", "2026-9-8", "2026-09-08<script>"]) assert.equal(licenseDate(value).kind, "unknown");
  assert.equal(licenseDate(null).kind, "not_defined");
  for (const value of ["2026-09-08", "2026-09-08 10:30:00", "2026-09-08T10:30:00Z", "2026-09-08T10:30:00.000-03:00"]) assert.deepEqual(licenseDate(value), { kind: "date", value });
});

test("envelopes/coleções malformados ou códigos duplicados falham em vez de mostrar vazio", () => {
  for (const value of [null, [], "valid", {}, { error: "private-error" }, { license: null }, { license: [] }, { status: "ativa", recursos: null }, { status: "ativa", recursos: {} }, { status: "ativa", recursos: [null] }, { status: "ativa", recursos: [{ codigo: "a" }, { codigo: "a" }] }, { status: "ativa", recursos: [{ codigo: "../secret" }] }, { status: "ativa", limites: new Array(2001).fill({ codigo: "quota" }) }]) assert.throws(() => portalLicensePayload(value), PortalLicenseDataError);
  assert.equal(portalLicensePayload({ status: "ativa", recursos: [] }).license.resourcesKnown, true);
  assert.equal(portalLicensePayload({ status: "ativa" }).license.resourcesKnown, false);
});

test("rota independente consulta só licença e revalida sessão, perfil e plano fora do cache", async t => {
  const mocks: Record<string, string> = {
    "test:license-state": `export const state = {}; let sequence=0; export function reset(){sequence++;Object.assign(state,{user:{id:"user-a",memberships:[{organizationId:"org-"+sequence,status:"active",organization:{slug:"tenant-"+sequence}}]},permissions:["billing.read"],profileActive:true,externalId:"external-"+sequence,remote:null,gate:null,calls:[],permissionChecks:[],orgReads:0,configReads:0,dbReads:[],rateStatus:null,error:null,organization:{modules:["products"],plan:{id:"growth",name:"Plano local"}},setting:{value:{billingPlanCodes:{growth:"profissional"}}}});} reset();`,
    "@/lib/auth": `import {state} from "test:license-state";import {privateJson,HttpSecurityError,httpSecurityErrorResponse} from "@/lib/http-security";export class AuthError extends Error {constructor(status){super("Acesso negado");this.status=status;}};export const currentUser=async()=>state.user;export const currentMembership=async user=>user.memberships.find(member=>member.status==="active")||null;export const authErrorResponse=error=>error instanceof HttpSecurityError?httpSecurityErrorResponse(error):privateJson({error:"Erro de acesso"},{status:error instanceof AuthError?error.status:500});`,
    "@/lib/erp/permissions": `import {state} from "test:license-state";import {AuthError} from "@/lib/auth";export async function assertTenantPermission(id,permission){state.permissionChecks.push([id,permission]);if(!state.profileActive||!state.permissions.includes(permission))throw new AuthError(403);return{permissions:state.permissions};}`,
    "@/db/control": `import {state} from "test:license-state";import {HttpSecurityError} from "@/lib/http-security";export const controlDb={billingAccount:{findUnique:async args=>{state.dbReads.push(args);return state.externalId===null?null:{externalId:state.externalId};}},organization:{findUniqueOrThrow:async()=>{state.orgReads++;return structuredClone(state.organization);}},systemSetting:{findUnique:async()=>{state.configReads++;return structuredClone(state.setting);}},apiRateLimit:{findUnique:async()=>null,upsert:async()=>({}),update:async()=>({})},$executeRaw:async()=>{if(state.rateStatus)throw new HttpSecurityError("Muitas consultas",state.rateStatus);return 0;},$transaction:async fn=>fn(controlDb)};`,
    "@/lib/billing/client": `import {state} from "test:license-state";export class BillingError extends Error{constructor(message,status,requestId,retryAfter){super(message);this.status=status;this.requestId=requestId;this.retryAfter=retryAfter;}}export const billingClient={license:async id=>{state.calls.push(id);const response=structuredClone(state.remote);if(state.gate)await state.gate;if(state.error)throw new BillingError("private-provider-message",state.error,"private unsafe request id",60);return response;}};`,
    "@/lib/billing/license": `throw new Error("Runtime license code must not be imported");`,
  };
  const bundled = await build({ stdin: { contents: 'export * as route from "./app/api/portal/license/route";export {state,reset} from "test:license-state";', resolveDir: process.cwd(), loader: "ts" }, bundle: true, write: false, platform: "node", format: "cjs", packages: "external", plugins: [{ name: "mock-license", setup(plugin) {
    plugin.onResolve({ filter: /.*/ }, args => { const path = args.path === "./client" && args.importer.endsWith("/lib/billing/portal-license-service.ts") ? "@/lib/billing/client" : args.path; return path in mocks ? { path, namespace: "fixture" } : undefined; });
    plugin.onLoad({ filter: /.*/, namespace: "fixture" }, args => ({ contents: mocks[args.path], loader: "js", resolveDir: process.cwd() }));
  } }] });
  const routeModule = { exports: {} }; new Function("require", "module", "exports", bundled.outputFiles[0].text)(createRequire(import.meta.url), routeModule, routeModule.exports);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { route, state, reset } = routeModule.exports as Record<string, any>;
  const initialize = () => { reset(); state.remote = structuredClone(observed); };
  const request = (query = "", organizationId = state.user?.memberships[0]?.organizationId || "absent") => new Request(`https://example.test/api/portal/license?${query}`, { headers: { "x-organization-id": organizationId } });

  await t.test("sessão, membership, permissão, perfil e aba de outra empresa falham antes do provedor", async () => {
    initialize(); state.user = null; assert.equal((await route.GET(request())).status, 401); assert.equal(state.calls.length, 0);
    initialize(); state.user.memberships = []; assert.equal((await route.GET(request())).status, 403); assert.equal(state.calls.length, 0);
    initialize(); state.permissions = []; assert.equal((await route.GET(request())).status, 403); assert.equal(state.calls.length, 0);
    initialize(); state.profileActive = false; assert.equal((await route.GET(request())).status, 403); assert.equal(state.calls.length, 0);
    initialize(); assert.equal((await route.GET(request("", "other-tenant"))).status, 409); assert.equal(state.calls.length, 0);
  });
  await t.test("projeção privada e plano real independem de finanças; não há handler de mutação", async () => {
    initialize(); const response = await route.GET(request()); assert.equal(response.status, 200); assert.match(response.headers.get("cache-control"), /private, no-store/);
    const data: PortalLicenseData = await response.json(); assert.equal(data.comparison.plan, "match"); assert.equal(data.source.cached, false); assert.equal(data.capabilities.canRotate, false); assert.equal(route.POST, undefined);
    assert.equal(data.applicationPlan.modules.find(item => item.id === "products")?.enabled, true); assert.equal(data.applicationPlan.modules.find(item => item.id === "marketplaces")?.enabled, false);
    assert.deepEqual(state.calls, [state.externalId]); assert.deepEqual(state.dbReads[0].select, { externalId: true }); assert.doesNotMatch(JSON.stringify(data), /private-/);
    Object.assign(data.license.resources[0].limit, { secret: "private-extra-secret" }); Object.assign(data.license.validFrom, { secret: "private-extra-secret" });
    const diagnostic = portalLicenseDiagnostic(data); assert.doesNotMatch(JSON.stringify(diagnostic), /private-|Plano local|Catálogo|external-|org-|user-a|"nome":/);
  });
  await t.test("cache curto é por empresa e permissões/plano/mapeamento são revistos em cada request", async () => {
    initialize(); const first = await (await route.GET(request())).json();
    state.organization.modules = ["marketplaces"]; state.setting.value.billingPlanCodes.growth = "omnichannel";
    const data = await (await route.GET(request())).json(); assert.equal(data.source.cached, true); assert.equal(data.source.checkedAt, first.source.checkedAt); assert.equal(data.comparison.plan, "different"); assert.equal(data.applicationPlan.modules.find((item: { id: string }) => item.id === "products").enabled, false); assert.equal(state.calls.length, 1); assert.equal(state.orgReads, 2); assert.equal(state.configReads, 2);
    state.permissions = []; assert.equal((await route.GET(request())).status, 403); assert.equal(state.calls.length, 1);
    state.permissions = ["billing.read"]; state.profileActive = false; assert.equal((await route.GET(request())).status, 403); assert.equal(state.calls.length, 1);
    state.profileActive = true; state.user.memberships[0].organizationId += "-second"; await route.GET(request()); assert.equal(state.calls.length, 2);
  });
  await t.test("atualização explícita ignora dados preenchidos e compartilha leitura pendente", async () => {
    initialize(); let release!: () => void; state.gate = new Promise<void>(resolve => { release = resolve; });
    const first = route.GET(request()); await new Promise(resolve => setImmediate(resolve)); const second = route.GET(request("refresh=1")); await new Promise(resolve => setImmediate(resolve)); assert.equal(state.calls.length, 1); release(); await Promise.all([first, second]); state.gate = null;
    state.remote.license.status = "suspensa"; let data = await (await route.GET(request())).json(); assert.equal(data.license.status, "active"); assert.equal(state.calls.length, 1);
    data = await (await route.GET(request("refresh=1"))).json(); assert.equal(data.license.status, "suspended"); assert.equal(data.source.cached, false); assert.equal(state.calls.length, 2);
  });
  await t.test("expiração e troca do vínculo externo não reutilizam licença de outro contexto", async () => {
    initialize(); const clock = Date.now; let now = clock(); Date.now = () => now;
    try { await route.GET(request()); now += 15_001; await route.GET(request()); assert.equal(state.calls.length, 2); state.externalId += "-changed"; await route.GET(request()); assert.equal(state.calls.length, 3); }
    finally { Date.now = clock; }
  });
  await t.test("erros não vazam fornecedor e refresh falho não ressuscita cache ativo", async () => {
    initialize(); await route.GET(request()); state.error = 404;
    const response = await route.GET(request("refresh=1")); assert.equal(response.status, 404); assert.doesNotMatch(await response.text(), /private-/);
    assert.equal((await route.GET(request())).status, 404); assert.equal(state.calls.length, 3);
    state.error = 429; const throttled = await route.GET(request()); assert.equal(throttled.status, 429); assert.equal(throttled.headers.get("retry-after"), "60"); assert.equal((await throttled.json()).retryable, true);
    state.error = 401; assert.equal((await route.GET(request())).status, 502);
    state.error = null; state.remote = { error: "private-error" }; assert.equal((await route.GET(request())).status, 502);
    state.remote = structuredClone(observed); assert.equal((await route.GET(request())).status, 200);
  });
  await t.test("refresh inválido/rate limit não chama provedor; desconhecido não vira correspondência", async () => {
    initialize(); for (const query of ["refresh=true", "refresh=2", "refresh=1&refresh=0"]) assert.equal((await route.GET(request(query))).status, 400); assert.equal(state.calls.length, 0);
    state.rateStatus = 429; assert.equal((await route.GET(request())).status, 429); assert.equal(state.calls.length, 0); state.rateStatus = null;
    state.setting = null; state.externalId = null; const data = await (await route.GET(request())).json(); assert.equal(data.comparison.plan, "unknown"); assert.equal(data.applicationPlan.expectedRemoteCode, null); assert.deepEqual(state.calls, [state.user.memberships[0].organizationId]);
  });
});
