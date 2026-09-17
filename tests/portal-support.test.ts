import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { build } from "esbuild";
import test from "node:test";
import { supportCommandId, supportDetailPayload, supportListPayload, supportMessageId, supportReplyInput, supportTicketInput, supportToken, SupportDataError } from "../lib/billing/support-data";

const ticket = { token: "ticket-a", numero_ticket: "SUP-123", titulo: "Ajuda com integração", descricao: "Descrição pública", status: "aberto", categoria: "integracao", prioridade: "alta", sla_horas: 24, sla_excedido: false, created_at: "2026-09-01T10:00:00Z", updated_at: "2026-09-08T10:00:00Z" };
const detail = { ticket: { ...ticket, secret: "private-ticket-secret", internal_notes: "private-note" }, messages: [
  { id: 10, autor_tipo: "cliente", autor_nome: "Cliente", mensagem: "Mensagem pública", created_at: ticket.created_at, anexos: [{ id: 5, nome_original: "evidencia.txt", mime_type: "text/plain", tamanho: 8, storage_path: "/private/storage" }] },
  { id: 11, autor_tipo: "atendente", autor_nome: "Equipe", mensagem: "Resposta pública", created_at: ticket.updated_at, anexos: [] },
  { id: 12, autor_tipo: "atendente", mensagem: "private-internal-message", is_internal: true, anexos: [{ id: 6, nome_original: "private.txt" }] },
  { id: 13, autor_tipo: "unknown-service", mensagem: "private-unknown-author", anexos: [] },
] };

test("suporte projeta apenas campos públicos do envelope real, mensagens e anexos locais", () => {
  const projected = supportDetailPayload(detail, ticket.token);
  assert.equal(projected.number, "SUP-123"); assert.equal(projected.slaHours, 24); assert.equal(projected.slaExceeded, false);
  assert.deepEqual(projected.messages.map(message => message.id), ["10", "11"]);
  assert.equal(projected.messages[0].attachments[0].downloadUrl, "/api/portal/billing/files?type=anexo&token=5&ticketToken=ticket-a");
  assert.doesNotMatch(JSON.stringify(projected), /private-|storage_path|internal_notes/);
  assert.throws(() => supportDetailPayload(detail, "ticket-another-tenant"), SupportDataError);
  for (const messages of [undefined, null, {}]) assert.throws(() => supportDetailPayload({ ticket, messages }, ticket.token), SupportDataError);
  assert.deepEqual(supportDetailPayload({ ticket, messages: [] }, ticket.token).messages, []);
  for (const flag of [{ private: true }, { publico: false }, { visibility: "internal" }, { tipo: "nota_interna" }, { customer_visible: "FALSE" }, { visivel_cliente: "Não" }, { is_internal: " SIM " }]) {
    assert.equal(supportDetailPayload({ ticket, messages: [{ ...detail.messages[0], ...flag }] }, ticket.token).messages.length, 0);
  }
});

test("coleção real tickets é reconhecida, paginação incompleta não vira total inventado", () => {
  assert.deepEqual(supportListPayload({ tickets: [ticket] }).partial, false);
  const partial = supportListPayload({ items: [ticket], pagination: { total: 12, has_more: true } });
  assert.equal(partial.partial, true); assert.equal(partial.totalKnown, 12); assert.equal(partial.tickets.length, 1);
  assert.throws(() => supportListPayload({ error: "offline" }), SupportDataError);
  assert.throws(() => supportListPayload({ tickets: [{ titulo: "Sem token público" }] }), SupportDataError);
});

test("entrada suporte recusa coerção, traversal, IDs fracionários e comandos ausentes", () => {
  for (const token of ["..", "../other", "ticket/a", "ticket\\a", ["ticket-a"], ""]) assert.throws(() => supportToken(token));
  for (const id of [0, -1, 1.5, "1e2", "01", "9007199254740992", [1]]) assert.throws(() => supportMessageId(id));
  assert.equal(supportMessageId(10), "10");
  for (const id of [undefined, "short", ["c".repeat(20)]]) assert.throws(() => supportCommandId(id));
  for (const message of [["Mensagem"], "", "x".repeat(10_001), "nul\u0000char"]) assert.throws(() => supportReplyInput(message));
  assert.throws(() => supportTicketInput({ titulo: "Título", descricao: "Descrição completa", categoria: ["duvida"] }));
  assert.throws(() => supportTicketInput({ titulo: "Título", descricao: "Descrição completa", prioridade: "urgent" }));
  assert.equal(supportTicketInput({ titulo: " Título ", descricao: "Descrição completa" }).categoria, "duvida");
});

test("rotas de suporte e anexos validam autoridade e escopo antes de chamadas ao Billing", async t => {
  const mocks: Record<string, string> = {
    "test:support-state": `export const state = {}; export function reset(){Object.assign(state,{user:{id:"user-a",memberships:[{organizationId:"org-a",status:"active",organization:{slug:"tenant-a"}}]},permissions:["billing.read","billing.write"],list:{tickets:[]},listGate:null,detail:null,calls:[],uploads:[],binaries:[],remoteError:null,audits:[]});} reset();`,
    "@/lib/auth": `import {state} from "test:support-state"; import {privateJson,HttpSecurityError,httpSecurityErrorResponse} from "@/lib/http-security";
      export class AuthError extends Error {constructor(status){super("Acesso negado");this.status=status;}}
      export const currentUser=async()=>state.user; export const currentMembership=async user=>user.memberships.find(member=>member.status==="active")||null;
      export const authErrorResponse=error=>error instanceof HttpSecurityError?httpSecurityErrorResponse(error):privateJson({error:error instanceof AuthError?"Acesso negado":"Erro interno"},{status:error instanceof AuthError?error.status:500});`,
    "@/lib/erp/permissions": `import {state} from "test:support-state";import {AuthError} from "@/lib/auth";export const matches=(permissions,requested)=>permissions.includes("*")||permissions.includes(requested)||(requested.endsWith(".read")&&permissions.includes(requested.replace(".read",".write")));export const assertTenantPermission=async(id,permission)=>{if(!matches(state.permissions,permission))throw new AuthError(403);return{permissions:state.permissions}};`,
    "@/db/control": `import {state} from "test:support-state";export const controlDb={
      billingAccount:{findUnique:async()=>({externalId:"tenant-a"}),upsert:async()=>({externalId:"tenant-a",organizationId:"org-a"})},
      apiRateLimit:{findUnique:async()=>null,upsert:async()=>({}),update:async()=>({})},$executeRaw:async()=>0,
      $transaction:async fn=>fn(controlDb),auditLog:{create:async({data})=>{state.audits.push(data);return data;}}
    };`,
    "@/db/tenant": `export const tenantDb=async()=>{throw new Error("Tenant mutation outside test scope")};`,
    "@/lib/billing/client": `import {state} from "test:support-state";export class BillingError extends Error{constructor(message,status,requestId,retryAfter){super(message);this.status=status;this.requestId=requestId;this.retryAfter=retryAfter;}}
      const read=(method,args,value)=>{state.calls.push({method,args});if(state.remoteError)throw new BillingError("private-provider-secret",state.remoteError,"unsafe request id secret",60);return value;};
      export const billingClient={tickets:async(...args)=>{const value=read("tickets",args,state.list);if(state.listGate)await state.listGate;return value;},ticket:async(...args)=>read("ticket",args,state.detail),createTicket:async(...args)=>read("createTicket",args,{token:"ticket-created",secret:"private-secret"}),replyTicket:async(...args)=>read("replyTicket",args,{message_id:25,storage_path:"private-path"})};`,
    "@/lib/billing/binary": `import {state} from "test:support-state";import {BillingError} from "@/lib/billing/client";
      export const billingMultipart=async(path,form,key)=>{state.uploads.push({path,key,messageId:form.get("mensagem_id"),file:form.get("file")});if(state.remoteError)throw new BillingError("private-antivirus-error",state.remoteError);return{secret:"private-storage-secret",path:"private-path"}};
      export const billingBinary=async(path)=>{state.binaries.push(path);return new Response("evidence",{headers:{"content-type":"text/plain","content-disposition":"inline"}})};`,
  };
  const bundled = await build({ stdin: { contents: 'export * as support from "./app/api/portal/support/route";export * as files from "./app/api/portal/billing/files/route";export * as legacy from "./app/api/portal/billing/route";export * as service from "./lib/billing/support-service";export {state,reset} from "test:support-state";', resolveDir: process.cwd(), loader: "ts" }, bundle: true, write: false, platform: "node", format: "cjs", packages: "external", plugins: [{ name: "mock-support-transport", setup(plugin) {
    plugin.onResolve({ filter: /.*/ }, args => {
      const path = args.path === "./client" && args.importer.endsWith("/lib/billing/support-service.ts") ? "@/lib/billing/client" : args.path;
      return path in mocks ? { path, namespace: "fixture" } : undefined;
    });
    plugin.onLoad({ filter: /.*/, namespace: "fixture" }, args => ({ contents: mocks[args.path], loader: "js", resolveDir: process.cwd() }));
  } }] });
  const routeModule = { exports: {} };
  new Function("require", "module", "exports", bundled.outputFiles[0].text)(createRequire(import.meta.url), routeModule, routeModule.exports);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { support, files, legacy, service, state, reset } = routeModule.exports as Record<string, any>;
  const origin = "https://portal.example.test", commandId = "command-1234567890abcdef";
  const context = { externalId: "tenant-a", organizationId: "org-a", userId: "user-a", canWrite: true };
  const initialize = () => { reset(); service.invalidateSupportList(context); state.list = { tickets: [ticket] }; state.detail = structuredClone(detail); };
  const get = (query: string, organizationId = "org-a") => new Request(`${origin}/api/portal/support?${query}`, { headers: { "x-organization-id": organizationId } });
  const post = (body: unknown, organizationId = "org-a") => new Request(`${origin}/api/portal/support`, { method: "POST", headers: { origin, "content-type": "application/json", "x-organization-id": organizationId }, body: JSON.stringify(body) });
  const upload = (messageId = "10", values: { name?: string; content?: string; type?: string; command?: string; organization?: string; token?: string } = {}) => {
    const form = new FormData(); form.set("file", new File([values.content ?? "evidence"], values.name ?? "evidence.txt", { type: values.type ?? "text/plain" })); form.set("ticketToken", values.token ?? ticket.token); form.set("messageId", messageId); if (values.command !== "") form.set("commandId", values.command ?? commandId);
    return new Request(`${origin}/api/portal/billing/files`, { method: "POST", headers: { origin, "x-organization-id": values.organization ?? "org-a" }, body: form });
  };
  const reply = { action: "ticket_reply", commandId, token: ticket.token, message: "Resposta pública de teste" };

  await t.test("sem sessão/permissão e aba de outra empresa não leem nem escrevem", async () => {
    initialize(); state.user = null; assert.equal((await support.GET(get(""))).status, 401); assert.equal(state.calls.length, 0);
    initialize(); state.permissions = []; assert.equal((await support.GET(get(""))).status, 403); assert.equal(state.calls.length, 0);
    initialize(); assert.equal((await support.GET(get("", "org-b"))).status, 409); assert.equal((await support.POST(post(reply, "org-b"))).status, 409); assert.equal((await files.POST(upload("10", { organization: "org-b" }))).status, 409); assert.equal(state.calls.length, 0); assert.equal(state.uploads.length, 0);
  });
  await t.test("leitor consulta DTO privado mas não cria, responde ou anexa", async () => {
    initialize(); state.permissions = ["billing.read"];
    const response = await support.GET(get("resource=detail&token=ticket-a")); assert.equal(response.status, 200); assert.match(response.headers.get("cache-control"), /private, no-store/);
    const body = await response.json(); assert.equal(body.capabilities.canWrite, false); assert.equal(body.capabilities.canReply, false); assert.equal(body.capabilities.canAttach, false); assert.doesNotMatch(JSON.stringify(body), /private-/);
    assert.equal((await support.POST(post(reply))).status, 403); assert.equal((await files.POST(upload())).status, 403); assert.equal(state.uploads.length, 0);
  });
  await t.test("busca, ordenação e paginação são determinísticas sem recontar página como total", async () => {
    initialize(); state.list = { tickets: Array.from({ length: 25 }, (_, index) => ({ ...ticket, token: `ticket-${String(index).padStart(2, "0")}`, numero_ticket: `SUP-${index}`, titulo: index % 2 ? "Financeiro" : "Integração", prioridade: index === 0 ? "urgente" : "alta" })) };
    let body = await (await support.GET(get("page=2&pageSize=10"))).json(); assert.equal(body.tickets.length, 10); assert.equal(body.pagination.total, 25); assert.equal(body.summary.loaded, 25); assert.equal(body.pagination.pages, 3);
    body = await (await support.GET(get("search=SUP-0&sort=priority"))).json(); assert.equal(body.tickets.length, 1); assert.equal(body.tickets[0].number, "SUP-0");
    state.list.pagination = { total: 100, has_more: true }; service.invalidateSupportList(context); body = await (await support.GET(get(""))).json(); assert.equal(body.pagination.partial, true); assert.equal(body.summary.totalKnown, 100); assert.ok(body.warning);
    assert.equal((await support.GET(get("page=0"))).status, 400); assert.equal((await support.GET(get("sort=sql"))).status, 400); assert.equal((await support.GET(get("refresh=true"))).status, 400);
  });
  await t.test("detalhe de outro chamado é recusado antes da resposta ou upload", async () => {
    initialize(); state.detail.ticket.token = "other-tenant-ticket";
    assert.equal((await support.GET(get("resource=detail&token=ticket-a"))).status, 502);
    assert.equal((await support.POST(post(reply))).status, 502); assert.equal((await files.POST(upload())).status, 502); assert.equal(state.uploads.length, 0); assert.equal(state.calls.filter((call: { method: string }) => call.method === "replyTicket").length, 0);
  });
  await t.test("chamado encerrado e estado desconhecido não aceitam novas ações", async () => {
    for (const status of ["fechado", "encerrado", "unknown-status"]) {
      initialize(); state.detail.ticket.status = status;
      const response = await support.POST(post(reply)); assert.equal(response.status, 409); assert.equal((await response.json()).outcome, "unknown"); assert.equal((await files.POST(upload())).status, 409); assert.equal(state.uploads.length, 0);
    }
  });
  await t.test("resposta usa token escopado, conteúdo validado e mesma chave em retentativas", async () => {
    initialize();
    for (let attempt = 0; attempt < 2; attempt++) {
      const response = await support.POST(post(reply)); assert.equal(response.status, 200); assert.deepEqual((await response.json()).result, { ticketToken: "ticket-a", messageId: "25" });
    }
    const calls = state.calls.filter((call: { method: string }) => call.method === "replyTicket"); assert.equal(calls.length, 2); assert.deepEqual(calls[0].args, ["tenant-a", "ticket-a", { mensagem: reply.message }, commandId]); assert.deepEqual(calls[1].args, calls[0].args);
    const response = await support.POST(post({ action: "ticket_create", commandId, payload: { titulo: "Ajuda teste", descricao: "Descrição de teste completa", categoria: "duvida", prioridade: "media" } })); assert.equal(response.status, 200); assert.doesNotMatch(await response.text(), /private-/);
  });
  await t.test("origem, comando, campo e tipo inválidos não chegam ao fornecedor", async () => {
    initialize();
    assert.equal((await support.POST(new Request(`${origin}/api/portal/support`, { method: "POST", headers: { origin: "https://external.invalid", "content-type": "application/json" }, body: JSON.stringify(reply) }))).status, 403);
    for (const change of [{ commandId: "short" }, { token: ".." }, { message: ["Resposta"] }, { action: "ticket_close" }]) assert.equal((await support.POST(post({ ...reply, ...change }))).status, 400);
    assert.equal((await files.POST(upload("10", { command: "" }))).status, 400); assert.equal((await files.POST(upload("1.5"))).status, 400); assert.equal(state.uploads.length, 0); assert.equal(state.calls.length, 0);
  });
  await t.test("anexo exige mensagem pública do cliente do chamado escolhido", async () => {
    for (const messageId of ["11", "12", "999"]) { initialize(); assert.equal((await files.POST(upload(messageId))).status, messageId === "11" ? 403 : 409); assert.equal(state.uploads.length, 0); }
    initialize();
    for (let attempt = 0; attempt < 2; attempt++) { const response = await files.POST(upload()); assert.equal(response.status, 200); assert.deepEqual(await response.json(), { ok: true }); }
    assert.equal(state.uploads[0].messageId, "10"); assert.equal(state.uploads[0].path, "/clientes/tenant-a/tickets/ticket-a/anexos"); assert.equal(state.uploads[0].key, state.uploads[1].key);
    await files.POST(upload("10", { command: "command-different-123456789" })); assert.notEqual(state.uploads[2].key, state.uploads[0].key);
    const longName = "a".repeat(205) + ".pdf";
    assert.equal((await files.POST(upload("10", { name: longName, type: "application/pdf", content: "%PDF-test", command: "command-long-name-123456789" }))).status, 200);
    assert.ok(state.uploads[3].file.name.length <= 200); assert.ok(state.uploads[3].file.name.endsWith(".pdf"));
  });
  await t.test("anexo valida extensão, MIME, assinatura, UTF-8 e limite local", async () => {
    initialize();
    for (const values of [{ name: "evidence.pdf", type: "text/plain" }, { name: "evidence.png", type: "image/png", content: "invalid" }, { name: "evidence.txt", content: "binary\u0000data" }]) assert.equal((await files.POST(upload("10", values))).status, 415);
    assert.equal((await files.POST(upload("10", { content: "" }))).status, 413);
    assert.equal((await files.POST(upload("10", { content: "x".repeat(5 * 1024 * 1024 + 1) }))).status, 413);
    assert.equal(state.uploads.length, 0); assert.equal(state.calls.length, 0);
  });
  await t.test("download não expõe anexo interno e força arquivo privado com nome validado", async () => {
    initialize();
    const download = (id: string) => new Request(`${origin}/api/portal/billing/files?type=anexo&token=${id}&ticketToken=ticket-a`);
    assert.equal((await files.GET(download("6"))).status, 404); assert.equal((await files.GET(download("999"))).status, 404); assert.equal(state.binaries.length, 0);
    const response = await files.GET(download("5")); assert.equal(response.status, 200); assert.match(response.headers.get("content-disposition"), /^attachment;/); assert.match(response.headers.get("cache-control"), /private, no-store/); assert.equal(response.headers.get("x-content-type-options"), "nosniff"); assert.equal(state.binaries[0], "/clientes/tenant-a/tickets/ticket-a/anexos?anexo_id=5");
  });
  await t.test("erro remoto preserva retry-after mas não texto sensível do fornecedor", async () => {
    initialize(); state.remoteError = 429;
    const response = await support.GET(get("")); assert.equal(response.status, 429); assert.equal(response.headers.get("retry-after"), "60"); const body = await response.json(); assert.equal(body.retryable, true); assert.doesNotMatch(JSON.stringify(body), /private-|unsafe request/);
  });
  await t.test("rotas antigas de ticket usam os mesmos filtros e proteção de resposta", async () => {
    initialize(); const response = await legacy.GET(new Request(`${origin}/api/portal/billing?resource=ticket&token=ticket-a`)); assert.equal(response.status, 200); const body = await response.json(); assert.equal(body.token, "ticket-a"); assert.equal(body.messages.length, 2); assert.doesNotMatch(JSON.stringify(body), /private-/);
    state.detail.ticket.status = "fechado"; assert.equal((await legacy.POST(post(reply))).status, 409); assert.equal(state.calls.filter((call: { method: string }) => call.method === "replyTicket").length, 0);
  });
  await t.test("cache curto compartilha leitura e resposta antiga não ressuscita após mutação", async () => {
    initialize();
    let release!: () => void;
    state.listGate = new Promise<void>(resolve => { release = resolve; });
    const previous = service.readSupportList(context, new URLSearchParams());
    const shared = service.readSupportList(context, new URLSearchParams("refresh=1"));
    assert.equal(state.calls.filter((call: { method: string }) => call.method === "tickets").length, 1);
    service.invalidateSupportList(context);
    state.listGate = null; state.list = { tickets: [{ ...ticket, token: "ticket-new" }] };
    assert.equal((await service.readSupportList(context, new URLSearchParams())).tickets[0].token, "ticket-new");
    release(); await Promise.all([previous, shared]);
    assert.equal((await service.readSupportList(context, new URLSearchParams())).tickets[0].token, "ticket-new");
    assert.equal(state.calls.filter((call: { method: string }) => call.method === "tickets").length, 2);
    state.permissions = [];
    assert.equal((await support.GET(get(""))).status, 403);
    assert.equal(state.calls.filter((call: { method: string }) => call.method === "tickets").length, 2);
    state.permissions = ["billing.read", "billing.write"];
    await support.POST(post(reply));
    state.list = { tickets: [{ ...ticket, token: "ticket-after-reply" }] };
    assert.equal((await service.readSupportList(context, new URLSearchParams())).tickets[0].token, "ticket-after-reply");
    state.list = { tickets: [{ ...ticket, token: "ticket-manual-refresh" }] };
    assert.equal((await service.readSupportList(context, new URLSearchParams())).tickets[0].token, "ticket-after-reply");
    assert.equal((await service.readSupportList(context, new URLSearchParams("refresh=1"))).tickets[0].token, "ticket-manual-refresh");
  });
});
