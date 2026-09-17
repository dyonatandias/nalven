import { currentMembership, currentUser, AuthError, authErrorResponse } from "@/lib/auth";
import { controlDb } from "@/db/control";
import { assertTenantPermission, matches } from "@/lib/erp/permissions";
import { HttpSecurityError, httpSecurityErrorResponse, privateJson } from "@/lib/http-security";
import { billingClient, BillingError } from "./client";
import { SupportDataError, SupportInputError, SupportStateChangedError, supportCommandId, supportCommandPayload, supportDetailPayload, supportListPayload, supportReplyInput, supportTicketInput, supportToken, ticketAcceptsReply, type SupportDetailData, type SupportListData } from "./support-data";

export type SupportContext = { externalId: string; organizationId: string; userId: string; canWrite: boolean };
type ListPayload = ReturnType<typeof supportListPayload>;
type ListEntry = { version: number; data?: ListPayload; storedAt?: number; pending?: Promise<ListPayload> };
const listCache = new Map<string, ListEntry>();
const LIST_CACHE_TTL = 15_000;

export function invalidateSupportList(context: Pick<SupportContext, "organizationId" | "externalId">) {
  const entry = listCache.get(cacheKey(context));
  if (entry) { entry.version++; entry.data = undefined; entry.storedAt = undefined; entry.pending = undefined; }
}

async function loadSupportList(context: SupportContext, refresh = false) {
  const key = cacheKey(context);
  let entry = listCache.get(key);
  if (!entry) {
    while (listCache.size >= 60) listCache.delete(listCache.keys().next().value!);
    entry = { version: 0 }; listCache.set(key, entry);
  } else { listCache.delete(key); listCache.set(key, entry); }
  if (!refresh && entry.data && Date.now() - (entry.storedAt || 0) < LIST_CACHE_TTL) return entry.data;
  if (entry.pending) return entry.pending;
  const current = entry, version = current.version;
  const pending = billingClient.tickets(context.externalId).then(value => {
    const data = supportListPayload(value);
    // Reads begun before a write cannot resurrect the pre-write collection.
    if (listCache.get(key) === current && current.version === version) { current.data = data; current.storedAt = Date.now(); }
    return data;
  }).finally(() => { if (current.pending === pending) current.pending = undefined; });
  current.pending = pending;
  return pending;
}

function cacheKey(context: Pick<SupportContext, "organizationId" | "externalId">) { return JSON.stringify([context.organizationId, context.externalId]); }

export async function supportContext(request: Request, write = false): Promise<SupportContext> {
  const user = await currentUser();
  if (!user) throw new AuthError(401);
  const membership = await currentMembership(user);
  if (!membership) throw new AuthError(403);
  const expected = request.headers.get("x-organization-id");
  if (expected !== null && expected !== membership.organizationId) throw new HttpSecurityError("A organização ativa mudou. Atualize a página antes de continuar.", 409);
  const access = await assertTenantPermission(membership.organizationId, write ? "billing.write" : "billing.read");
  const account = await controlDb.billingAccount.findUnique({ where: { organizationId: membership.organizationId } });
  return { externalId: account?.externalId || membership.organizationId, organizationId: membership.organizationId, userId: user.id, canWrite: matches(access.permissions, "billing.write") };
}

export async function readSupportList(context: SupportContext, query: URLSearchParams): Promise<SupportListData> {
  const refresh = query.get("refresh");
  if (refresh !== null && refresh !== "0" && refresh !== "1") throw new SupportInputError("Parâmetro de atualização inválido.");
  const pageSize = integer(query.get("pageSize") ?? "20", 1, 50);
  const requestedPage = integer(query.get("page") ?? "1", 1, 100_000);
  const search = (query.get("search") || "").trim();
  if (search.length > 200) throw new SupportInputError("A busca deve ter no máximo 200 caracteres.");
  const sort = query.get("sort") || "updated_desc";
  if (!["updated_desc", "created_desc", "oldest", "priority"].includes(sort)) throw new SupportInputError("Ordenação inválida.");
  const filters = { status: query.get("status") || "", category: query.get("category") || "", priority: query.get("priority") || "" };
  if (Object.values(filters).some(value => value && !/^[a-z0-9_-]{1,60}$/.test(value))) throw new SupportInputError("Filtro inválido.");
  // Only an unfiltered collection is documented by the provider; do not invent
  // pagination cursors or claim that a partial upstream result is complete.
  const upstream = await loadSupportList(context, refresh === "1");
  const needle = search.toLocaleLowerCase("pt-BR");
  const rows = upstream.tickets.filter(ticket => (!needle || `${ticket.title} ${ticket.number || ""} ${ticket.token}`.toLocaleLowerCase("pt-BR").includes(needle)) && Object.entries(filters).every(([key, value]) => !value || ticket[key as keyof typeof filters] === value));
  const priority = { baixa: 0, media: 1, alta: 2, urgente: 3 } as Record<string, number>;
  const time = (value: string | null) => value ? Date.parse(value) || 0 : 0;
  rows.sort((left, right) => {
    const order = sort === "priority" ? (priority[right.priority] ?? -1) - (priority[left.priority] ?? -1) : sort === "oldest" ? time(left.createdAt) - time(right.createdAt) : sort === "created_desc" ? time(right.createdAt) - time(left.createdAt) : time(right.updatedAt || right.createdAt) - time(left.updatedAt || left.createdAt);
    return order || left.token.localeCompare(right.token);
  });
  const total = rows.length, pages = Math.max(1, Math.ceil(total / pageSize)), page = Math.min(requestedPage, pages);
  const byStatus = Object.fromEntries([...new Set(upstream.tickets.map(ticket => ticket.status))].map(status => [status, upstream.tickets.filter(ticket => ticket.status === status).length]));
  const facet = (key: "status" | "category" | "priority") => [...new Set(upstream.tickets.map(ticket => ticket[key]))].sort();
  return {
    tickets: rows.slice((page - 1) * pageSize, page * pageSize),
    pagination: { page, pageSize, total, pages, hasMore: page < pages, partial: upstream.partial },
    summary: { loaded: upstream.tickets.length, totalKnown: upstream.totalKnown, byStatus },
    facets: { statuses: facet("status"), categories: facet("category"), priorities: facet("priority") },
    capabilities: { canWrite: context.canWrite },
    warning: upstream.partial ? "O provedor devolveu somente parte dos chamados. Busca, filtros e contadores consideram os registros recebidos." : null,
    generatedAt: new Date().toISOString(),
  };
}

export async function readSupportDetail(context: SupportContext, tokenValue: unknown): Promise<SupportDetailData> {
  const token = supportToken(tokenValue);
  const ticket = supportDetailPayload(await billingClient.ticket(context.externalId, token), token);
  const canReply = context.canWrite && ticketAcceptsReply(ticket.status);
  return { ticket, capabilities: { canWrite: context.canWrite, canReply, canAttach: canReply && ticket.messages.some(message => message.authorType === "client" && message.id !== null) }, generatedAt: new Date().toISOString() };
}

export async function executeSupportCommand(context: SupportContext, body: Record<string, unknown>) {
  if (!context.canWrite) throw new AuthError(403);
  const commandId = supportCommandId(body.commandId);
  if (body.action === "ticket_create") {
    const input = supportTicketInput(body.payload);
    invalidateSupportList(context);
    try { return supportCommandPayload(await billingClient.createTicket(context.externalId, input, commandId)); }
    finally { invalidateSupportList(context); }
  }
  if (body.action === "ticket_reply") {
    const token = supportToken(body.token), message = supportReplyInput(body.message);
    const detail = await readSupportDetail(context, token);
    if (!detail.capabilities.canReply) throw new SupportStateChangedError("O estado do chamado mudou. Confira o histórico antes de descartar esta solicitação; um envio anterior pode já ter sido recebido.");
    invalidateSupportList(context);
    let result;
    try { result = supportCommandPayload(await billingClient.replyTicket(context.externalId, token, { mensagem: message }, commandId)); }
    finally { invalidateSupportList(context); }
    return { ...result, ticketToken: result.ticketToken || token };
  }
  throw new SupportInputError("Ação de suporte inválida.");
}

export function supportFailure(error: unknown) {
  if (error instanceof HttpSecurityError) return httpSecurityErrorResponse(error);
  if (error instanceof SupportInputError) return privateJson({ error: error.message, retryable: false }, { status: 400 });
  if (error instanceof SupportStateChangedError) return privateJson({ error: error.message, retryable: true, outcome: "unknown" }, { status: 409 });
  if (error instanceof SupportDataError) return privateJson({ error: "O serviço de suporte retornou dados que não puderam ser validados. Tente novamente mais tarde.", retryable: true }, { status: 502 });
  if (error instanceof BillingError) {
    const status = error.status;
    const message = status === 404 ? "Chamado ou arquivo não encontrado para esta organização." : status === 429 ? "Muitas solicitações ao suporte. Aguarde antes de tentar novamente." : status >= 500 ? "Serviço de suporte temporariamente indisponível. Tente confirmar a mesma operação novamente." : status === 409 ? "A operação conflita com uma solicitação anterior. Confira o chamado antes de tentar novamente." : "O serviço de suporte não aceitou a solicitação. Revise os dados e tente novamente.";
    return privateJson({ error: message, retryable: status === 429 || status >= 500, requestId: safeRequestId(error.requestId) }, { status, headers: error.retryAfter && Number.isSafeInteger(error.retryAfter) && error.retryAfter > 0 ? { "retry-after": String(Math.min(error.retryAfter, 86_400)) } : undefined });
  }
  return authErrorResponse(error);
}

function integer(value: string, min: number, max: number) { const number = Number(value); if (!/^\d+$/.test(value) || !Number.isSafeInteger(number) || number < min || number > max) throw new SupportInputError("Paginação inválida."); return number; }
function safeRequestId(value: unknown) { return typeof value === "string" && /^[A-Za-z0-9_-]{1,100}$/.test(value) ? value : undefined; }
