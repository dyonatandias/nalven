import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import test from "node:test";
import { build } from "esbuild";
import { customerIdentityError } from "../lib/billing/customer-identity";
import { validBillingHeadlessUrl } from "../lib/billing/endpoint-policy";
import type { CustomerInput } from "../lib/billing/types";

const organization = { id: "org-internal", document: "11222333000181", email: "owner@example.invalid" };
const payload = { external_id: organization.id, documento: organization.document, responsavel: { email: organization.email }, tenant: { nome: "Loja" } } as CustomerInput;
test("identidade exige ID interno, documento válido e e-mail consistente", () => {
  assert.equal(customerIdentityError(payload, organization), null);
  assert.equal(customerIdentityError({ ...payload, tenant: { ...payload.tenant, nome: "Outro nome" } }, organization), null);
  for (const value of ["", "nome-da-loja", "outro-id"]) assert.ok(customerIdentityError({ ...payload, external_id: value }, organization));
  for (const documento of ["", "62119226", "11111111111", "52998224725"]) assert.ok(customerIdentityError({ ...payload, documento }, organization));
  assert.ok(customerIdentityError({ ...payload, responsavel: { ...payload.responsavel, email: "other@example.invalid" } }, organization));
  assert.ok(customerIdentityError(payload, organization, "legacy-slug"));
});
test("destino rejeita API legada e cadastro não deriva identidade do slug", () => {
  assert.ok(validBillingHeadlessUrl("https://billing.example.test/api/v1/saas"));
  for (const path of ["/api/external/cliente", "/headless", "/api/v1/saas?redirect=/api/external", "/api/v1/saas/../external"]) assert.equal(validBillingHeadlessUrl(`https://billing.example.test${path}`), false);
  const signup = readFileSync("app/api/auth/signup/route.ts", "utf8");
  assert.match(signup, /external_id:organization.id/);
  assert.match(signup, /externalId:organization.id/);
  for (const file of ["lib/billing/sync.ts", "lib/billing/support-service.ts", "lib/billing/portal-license-service.ts", "app/api/portal/billing/route.ts"]) assert.doesNotMatch(readFileSync(file, "utf8"), /externalId:[^\n]*organization\.slug|externalId:org\.slug/);
});
test("409 é terminal mesmo com Retry-After; sem reconciliação ou rotação de licença", async () => {
  const mocks: Record<string, string> = {
    "fixture:state": `export const state={job:null,calls:[],lookupStatus:404,createStatus:409,externalId:'org-internal'};`,
    "./client": `import{state}from'fixture:state';export class BillingError extends Error{constructor(message,status,requestId,retryAfter){super(message);Object.assign(this,{status,requestId,retryAfter});}}export const billingClient={customer:async()=>{state.calls.push('GET');throw new BillingError('lookup',state.lookupStatus,undefined,30);},createCustomer:async()=>{state.calls.push('POST');throw new BillingError('upstream',state.createStatus,undefined,30);},rotateLicense:async()=>{state.calls.push('ROTATE');}};`,
    "@/lib/secrets": `export function encryptSecret(){throw new Error('must not rotate');}`,
    "@/db/control": `import{state}from'fixture:state';export const controlDb={organization:{findUnique:async()=>(${JSON.stringify(organization)})},billingAccount:{findUnique:async()=>({externalId:state.externalId}),updateMany:async()=>({count:1})},billingProvisionJob:{updateMany:async args=>{if(!['pending','retry'].includes(state.job.status))return{count:0};state.job.status='processing';state.job.attempts++;return{count:1};},findUniqueOrThrow:async()=>state.job,findFirst:async()=>state.job,update:async args=>{Object.assign(state.job,args.data);return state.job;}}};`,
  };
  const bundle = await build({stdin:{contents:'export {processBillingJob,retryBillingProvision} from "./lib/billing/provision";export {state} from "fixture:state";',resolveDir:process.cwd(),loader:"ts"},bundle:true,write:false,platform:"node",format:"cjs",packages:"external",plugins:[{name:"provision-fixture",setup(plugin){plugin.onResolve({filter:/.*/},args=>args.path in mocks?{path:args.path,namespace:"fixture"}:undefined);plugin.onLoad({filter:/.*/,namespace:"fixture"},args=>({contents:mocks[args.path],loader:"js",resolveDir:process.cwd()}));}}]});
  const mod = { exports: {} };
  new Function("require","module","exports",bundle.outputFiles[0].text)(createRequire(import.meta.url),mod,mod.exports);
  const {processBillingJob,retryBillingProvision,state} = mod.exports as {processBillingJob:(id:string)=>Promise<{status:string}>;retryBillingProvision:(id:string)=>Promise<unknown>;state:{job:Record<string,unknown>;calls:string[];lookupStatus:number;createStatus:number;externalId:string}};
  const reset = () => {state.job={id:"job",organizationId:organization.id,payload,status:"pending",attempts:0};state.calls=[];state.lookupStatus=404;state.createStatus=409;state.externalId=organization.id;};
  reset();
  assert.equal((await processBillingJob("job")).status,"failed");
  assert.deepEqual(state.calls,["GET","POST"]);
  assert.equal(state.job.errorCode,"HTTP_409");
  assert.match(String(state.job.lastError),/Não haverá nova tentativa automática/);
  await assert.rejects(retryBillingProvision(organization.id),/vinculação pelo painel/);
  assert.equal((await processBillingJob("job")).status,"skipped");
  reset();state.lookupStatus=409;
  assert.equal((await processBillingJob("job")).status,"failed");
  assert.deepEqual(state.calls,["GET"]);
  reset();state.job.errorCode="HTTP_409";state.job.status="retry";
  assert.equal((await processBillingJob("job")).status,"failed");
  assert.deepEqual(state.calls,[]);
  reset();state.externalId="legacy";
  assert.equal((await processBillingJob("job")).status,"failed");
  assert.deepEqual(state.calls,[]);
  reset();state.createStatus=503;
  assert.equal((await processBillingJob("job")).status,"retry");
});
