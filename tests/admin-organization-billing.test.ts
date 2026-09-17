import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";
import { build } from "esbuild";
import { organizationInvoices, organizationPayment } from "../lib/admin-organization-billing";

test("projeção financeira preserva valores desconhecidos e exclui dados internos", () => {
  assert.equal(organizationPayment({ subscription: { forma_pagamento_preferida: "boleto" } }).paymentMethod, "boleto");
  assert.equal(organizationPayment({ assinatura: { forma_pagamento_preferida: "pix", forma_pagamento: "cartao" } }).paymentMethod, "pix");
  assert.deepEqual(organizationInvoices({ items: [{ id: 1, numero: "001", valor_total: "0", status: "paga", metadata: { secret: "private" } }] }), [{ id: "1", description: "001", amount: 0, dueAt: null, paidAt: null, status: "paga" }]);
  for (const value of [null, undefined, true, "", " ", "invalid"]) assert.equal(organizationInvoices([{ id: 1, amount: value }])[0].amount, null);
  assert.throws(() => organizationInvoices({ error: "offline" }));
  assert.throws(() => organizationInvoices([{}]));
  assert.deepEqual(organizationPayment({ subscription: { status: "active", forma_pagamento: "pix", secret: "private" }, payment_methods: { pix: true, boleto: true, cartao: false }, license: { secret: "private" } }), { paymentMethod: "pix", subscriptionStatus: "active", availableMethods: ["pix", "boleto"] });
});

test("financeiro individual autoriza e resolve vínculo no servidor, preservando falhas parciais", async () => {
  const mocks: Record<string, string> = {
    "test:state": "export const state={role:'user',exists:true,linked:true,failInvoices:false,calls:[],lookups:[]};",
    "@/lib/auth": `import {state} from 'test:state';export async function requireUser(role){if(state.role!==role)throw new Error('denied');return{id:'admin'};}export function authErrorResponse(){return Response.json({error:'negado'},{status:403});}`,
    "@/lib/http-security": `export {privateJson} from './lib/http-security';export async function enforceControlRateLimit(){}`,
    "@/db/control": `import {state} from 'test:state';export const controlDb={organization:{findUnique:async args=>{state.lookups.push(args);return state.exists?{id:args.where.id,billingAccount:state.linked?{externalId:'external-a'}:null}:null;}}};`,
    "@/lib/billing/client": `import {state} from 'test:state';export const billingClient={portal:async id=>{state.calls.push(['portal',id]);return{subscription:{status:'active',forma_pagamento:'pix'},payment_methods:{pix:true},secret:'private'};},invoices:async id=>{state.calls.push(['invoices',id]);if(state.failInvoices)throw new Error('private remote details');return{items:[{id:'invoice-a',valor_total:50,status:'pendente',secret:'private'}]};}};`,
  };
  const bundle = await build({
    stdin: { contents: 'export {GET} from "./app/api/admin/organizations/[id]/billing/route";export {state} from "test:state";', resolveDir: process.cwd(), loader: "ts" },
    bundle: true, write: false, platform: "node", format: "cjs", packages: "external",
    plugins: [{ name: "organization-billing", setup(plugin) {
      plugin.onResolve({ filter: /.*/ }, args => args.path in mocks ? { path: args.path, namespace: "fixture" } : undefined);
      plugin.onLoad({ filter: /.*/, namespace: "fixture" }, args => ({ contents: mocks[args.path], loader: "js", resolveDir: process.cwd() }));
    } }],
  });
  const routeModule = { exports: {} };
  new Function("require", "module", "exports", bundle.outputFiles[0].text)(createRequire(import.meta.url), routeModule, routeModule.exports);
  const { GET, state } = routeModule.exports as { GET: (request: Request, context: { params: Promise<{ id: string }> }) => Promise<Response>; state: { role: string; exists: boolean; linked: boolean; failInvoices: boolean; calls: string[][]; lookups: Array<{ where: { id: string }; select: unknown }> } };
  const request = new Request("https://app.example.test/api/admin/organizations/org-a/billing?externalId=other");
  const context = { params: Promise.resolve({ id: "org-a" }) };
  assert.equal((await GET(request, context)).status, 403);
  assert.equal(state.lookups.length, 0); assert.equal(state.calls.length, 0);
  state.role = "superadmin"; state.exists = false;
  assert.equal((await GET(request, context)).status, 404);
  state.exists = true; state.linked = false;
  assert.deepEqual(await (await GET(request, context)).json(), { linked: false });
  assert.equal(state.calls.length, 0);
  state.linked = true;
  const response = await GET(request, context);
  assert.match(response.headers.get("cache-control") || "", /private, no-store/);
  const result = await response.json();
  assert.equal(result.invoices[0].amount, 50);
  assert.equal(result.payment.paymentMethod, "pix");
  assert.ok(!JSON.stringify(result).includes("private"));
  assert.deepEqual(state.calls, [["portal", "external-a"], ["invoices", "external-a"]]);
  assert.ok(state.lookups.every(query => query.where.id === "org-a"));
  assert.deepEqual(state.lookups[0].select, { id: true, billingAccount: { select: { externalId: true } } });
  state.failInvoices = true;
  const partial = await (await GET(request, context)).json();
  assert.equal(partial.invoices, null);
  assert.equal(partial.payment.paymentMethod, "pix");
  assert.equal(partial.errors.invoices, "Não foi possível consultar as faturas externas.");
  assert.ok(!JSON.stringify(partial).includes("private"));
});
