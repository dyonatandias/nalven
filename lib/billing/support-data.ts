/** Public support DTOs. Never spread a provider record into a browser response. */
export const SUPPORT_CATEGORIES = ["pagamento", "tecnico", "funcionalidade", "integracao", "duvida", "reclamacao", "sugestao", "outro"] as const;
export const SUPPORT_PRIORITIES = ["baixa", "media", "alta", "urgente"] as const;
export type SupportAuthorType = "client" | "support" | "system";
export type SupportAttachment = { id: string; name: string; mimeType: string | null; size: number | null; downloadUrl: string };
export type SupportMessage = { id: string | null; authorName: string; authorType: SupportAuthorType; body: string; createdAt: string | null; attachments: SupportAttachment[] };
export type SupportTicketSummary = { token: string; title: string; status: string; category: string; priority: string; createdAt: string | null; updatedAt: string | null; number?: string | null; slaHours?: number | null; slaExceeded?: boolean | null };
export type SupportTicket = SupportTicketSummary & { description: string; messages: SupportMessage[] };
export type SupportListData = {
  tickets: SupportTicketSummary[];
  pagination: { page: number; pageSize: number; total: number; pages: number; hasMore: boolean; partial: boolean };
  summary: { loaded: number; totalKnown: number | null; byStatus: Record<string, number> };
  facets: { statuses: string[]; categories: string[]; priorities: string[] };
  capabilities: { canWrite: boolean };
  warning: string | null;
  generatedAt: string;
};
export type SupportDetailData = { ticket: SupportTicket; capabilities: { canWrite: boolean; canReply: boolean; canAttach: boolean }; generatedAt: string };
export type SupportCommandResult = { ticketToken: string | null; messageId: string | null };
export class SupportInputError extends Error {}
export class SupportDataError extends Error {}
export class SupportStateChangedError extends Error {}

export function supportObject(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

export function supportToken(value: unknown) {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]{1,200}$/.test(value)) throw new SupportInputError("Identificador do chamado inválido.");
  return value;
}

export function supportMessageId(value: unknown) {
  const id = typeof value === "number" && Number.isSafeInteger(value) ? String(value) : value;
  if (typeof id !== "string" || !/^[1-9]\d{0,15}$/.test(id) || !Number.isSafeInteger(Number(id))) throw new SupportInputError("Identificador da mensagem ou anexo inválido.");
  return id;
}

export function supportCommandId(value: unknown) {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]{16,120}$/.test(value)) throw new SupportInputError("Identificador da operação inválido. Atualize a página e tente novamente.");
  return value;
}

export function supportTicketInput(value: unknown) {
  const input = supportObject(value);
  const category = input.categoria ?? "duvida", priority = input.prioridade ?? "media";
  if (!SUPPORT_CATEGORIES.includes(category as typeof SUPPORT_CATEGORIES[number])) throw new SupportInputError("Categoria inválida.");
  if (!SUPPORT_PRIORITIES.includes(priority as typeof SUPPORT_PRIORITIES[number])) throw new SupportInputError("Prioridade inválida.");
  return { titulo: inputText(input.titulo, 5, 255, "O assunto deve ter entre 5 e 255 caracteres."), descricao: inputText(input.descricao, 10, 10_000, "A descrição deve ter entre 10 e 10.000 caracteres."), categoria: category as string, prioridade: priority as string };
}

export function supportReplyInput(value: unknown) {
  return inputText(value, 1, 10_000, "A resposta deve ter entre 1 e 10.000 caracteres.");
}

export function ticketAcceptsReply(status: string) {
  return ["aberto", "em_andamento", "aguardando_cliente", "aguardando_resposta", "open", "pending", "in_progress"].includes(status);
}

export function supportListPayload(value: unknown) {
  const envelope = supportObject(value);
  const rows = Array.isArray(value) ? value : firstArray(envelope, ["tickets", "chamados", "items", "data"]);
  if (!rows || rows.length > 5000) throw new SupportDataError("Formato da lista de chamados indisponível.");
  const tickets = rows.map(ticketSummary);
  const pagination = supportObject(envelope.pagination ?? envelope.paginacao ?? envelope.meta);
  const declaredTotal = positiveCount(envelope.total ?? pagination.total);
  const partial = envelope.has_more === true || pagination.has_more === true || Boolean(envelope.next_cursor ?? pagination.next_cursor) || (declaredTotal !== null && declaredTotal > tickets.length);
  return { tickets, partial, totalKnown: partial ? declaredTotal : tickets.length };
}

export function supportDetailPayload(value: unknown, requestedToken: string): SupportTicket {
  const envelope = supportObject(value), nested = supportObject(envelope.ticket ?? envelope.chamado);
  const row = Object.keys(nested).length ? nested : envelope;
  const summary = ticketSummary(row);
  if (summary.token !== requestedToken) throw new SupportDataError("O provedor retornou um chamado diferente do solicitado.");
  const rows = firstArray(envelope, ["messages", "mensagens"]) ?? firstArray(row, ["messages", "mensagens"]);
  if (!rows) throw new SupportDataError("O provedor não informou um histórico de mensagens válido.");
  if (rows.length > 5000) throw new SupportDataError("O histórico do chamado excede o limite seguro de leitura.");
  return { ...summary, description: publicText(row.descricao ?? row.description, 10_000), messages: rows.map(message => publicMessage(message, summary.token)).filter((message): message is SupportMessage => message !== null) };
}

export function supportCommandPayload(value: unknown): SupportCommandResult {
  const envelope = supportObject(value), ticket = supportObject(envelope.ticket ?? envelope.chamado), message = supportObject(envelope.message ?? envelope.mensagem);
  const token = ticket.token ?? envelope.token ?? envelope.ticket_token;
  return { ticketToken: safeToken(token), messageId: safeId(message.id ?? envelope.mensagem_id ?? envelope.message_id) };
}

function ticketSummary(value: unknown): SupportTicketSummary {
  const row = supportObject(value), token = safeToken(row.token ?? row.ticket_token);
  if (!token) throw new SupportDataError("O provedor não informou o identificador público do chamado.");
  return { token, title: publicText(row.titulo ?? row.assunto ?? row.title, 255) || "Chamado", status: publicCode(row.status), category: publicCode(row.categoria ?? row.category), priority: publicCode(row.prioridade ?? row.priority), createdAt: timestamp(row.created_at ?? row.createdAt), updatedAt: timestamp(row.updated_at ?? row.updatedAt), number: publicText(row.numero_ticket, 100) || null, slaHours: typeof row.sla_horas === "number" && Number.isFinite(row.sla_horas) && row.sla_horas >= 0 ? row.sla_horas : null, slaExceeded: typeof row.sla_excedido === "boolean" ? row.sla_excedido : null };
}

function publicMessage(value: unknown, ticketToken: string): SupportMessage | null {
  const row = supportObject(value);
  if (internal(row)) return null;
  const kind = publicCode(row.autor_tipo ?? row.author_type ?? row.authorType);
  const authorType = ["cliente", "client", "customer"].includes(kind) ? "client" : ["atendente", "suporte", "support", "staff", "admin", "administrador"].includes(kind) ? "support" : ["sistema", "system"].includes(kind) ? "system" : null;
  // Unknown authors/types are not enough evidence that a message is public.
  if (!authorType) return null;
  const id = safeId(row.id ?? row.mensagem_id);
  const body = publicText(row.mensagem ?? row.conteudo ?? row.body ?? row.message, 10_000);
  const attachments = (firstArray(row, ["anexos", "attachments"]) ?? []).slice(0, 50).map(value => publicAttachment(value, ticketToken)).filter((file): file is SupportAttachment => file !== null);
  return { id, authorName: publicText(row.autor_nome ?? row.author_name, 160) || (authorType === "client" ? "Cliente" : authorType === "system" ? "Sistema" : "Atendimento"), authorType, body, createdAt: timestamp(row.created_at ?? row.createdAt), attachments };
}

function publicAttachment(value: unknown, token: string): SupportAttachment | null {
  const row = supportObject(value), id = safeId(row.id ?? row.anexo_id);
  if (!id || internal(row)) return null;
  return { id, name: publicText(row.nome_original ?? row.nome ?? row.filename ?? row.name, 200) || "Anexo", mimeType: publicText(row.mime_type ?? row.mimeType ?? row.content_type, 100) || null, size: positiveCount(row.tamanho ?? row.size ?? row.size_bytes), downloadUrl: `/api/portal/billing/files?type=anexo&token=${encodeURIComponent(id)}&ticketToken=${encodeURIComponent(token)}` };
}

function internal(row: Record<string, unknown>) {
  const normalized = (value: string) => value.trim().normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
  const flag = (value: unknown) => value === true || value === 1 || (typeof value === "string" && ["true", "1", "sim", "yes"].includes(normalized(value)));
  const hidden = (value: unknown) => value === false || value === 0 || (typeof value === "string" && ["false", "0", "nao", "no"].includes(normalized(value)));
  if (["interno", "interna", "internal", "is_internal", "isInternal", "private", "privado", "privada", "is_private"].some(key => flag(row[key]))) return true;
  if (["public", "publico", "publica", "is_public", "visible_to_customer", "customer_visible", "visivel_cliente"].some(key => hidden(row[key]))) return true;
  return [row.visibility, row.visibilidade, row.tipo, row.type].some(value => typeof value === "string" && /^(internal|private|interno|interna|privado|privada|nota_interna|internal_note|staff_note)$/.test(normalized(value)));
}

function firstArray(row: Record<string, unknown>, keys: string[]) {
  for (const key of keys) if (Array.isArray(row[key])) return row[key] as unknown[];
  return null;
}
function inputText(value: unknown, min: number, max: number, message: string) {
  if (typeof value !== "string") throw new SupportInputError(message);
  const text = value.trim();
  if (text.length < min || text.length > max || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(text)) throw new SupportInputError(message);
  return text;
}
function publicText(value: unknown, max: number) { return typeof value === "string" ? value.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "").slice(0, max) : ""; }
function publicCode(value: unknown) { return typeof value === "string" && /^[A-Za-z0-9_-]{1,60}$/.test(value) ? value.toLowerCase() : "unknown"; }
function safeToken(value: unknown) { try { return supportToken(value); } catch { return null; } }
function safeId(value: unknown) { try { return supportMessageId(value); } catch { return null; } }
function positiveCount(value: unknown) { const number = typeof value === "number" ? value : typeof value === "string" && /^\d+$/.test(value) ? Number(value) : NaN; return Number.isSafeInteger(number) && number >= 0 ? number : null; }
function timestamp(value: unknown) { return typeof value === "string" && value.length <= 100 && Number.isFinite(Date.parse(value)) ? value : null; }
