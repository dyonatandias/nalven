export const AUDIT_SEVERITIES = ["info", "warning", "critical"] as const;
export const AUDIT_CATEGORIES = ["commercial", "supply", "finance", "fiscal", "identity", "privacy", "integration", "governance"] as const;
export const AUDIT_SOURCES = ["erp", "pos", "fiscal", "integration", "system"] as const;
export const INVESTIGATION_STATUSES = ["open", "in_review", "resolved", "dismissed"] as const;
export const INVESTIGATION_SEVERITIES = ["low", "medium", "high", "critical"] as const;

export type AuditQuery = ReturnType<typeof parseAuditQuery>;
export type AuditExportRow = {
  id: string;
  createdAt: Date | string;
  actor: { name: string; email: string };
  action: string;
  entityType: string;
  entityId: string | null;
  correlationId: string | null;
  severity: string;
  category: string;
  source: string;
  fingerprint: string | null;
  changedFields: string[];
};

export class AuditInputError extends Error {}

export function parseAuditQuery(params: URLSearchParams) {
  const page = integer(params.get("page"), 1, 1, 200);
  const limit = integer(params.get("limit"), 50, 20, 100);
  const from = optionalDate(params.get("from"), "Data inicial inválida.");
  const toSource = optionalDate(params.get("to"), "Data final inválida.");
  const to = toSource && /^\d{4}-\d{2}-\d{2}$/.test(params.get("to") || "")
    ? new Date(toSource.valueOf() + 86_400_000 - 1)
    : toSource;
  if (from && to && from > to) throw new AuditInputError("A data inicial deve ser anterior à data final.");
  return {
    page,
    limit,
    search: text(params.get("search"), 120),
    actorId: text(params.get("actorId"), 160),
    action: text(params.get("action"), 160),
    entityType: text(params.get("entityType"), 120),
    correlationId: text(params.get("correlationId"), 180),
    severity: choice(params.get("severity"), AUDIT_SEVERITIES),
    category: choice(params.get("category"), AUDIT_CATEGORIES),
    source: choice(params.get("source"), AUDIT_SOURCES),
    onlyChanges: params.get("onlyChanges") === "true",
    from,
    to,
    sort: params.get("sort") === "oldest" ? "oldest" as const : "newest" as const,
    format: params.get("format") === "csv" ? "csv" as const : params.get("format") === "jsonl" ? "jsonl" as const : "json" as const,
  };
}

export function auditFilterSnapshot(value: unknown) {
  const input = record(value, "Filtros inválidos.");
  const params = new URLSearchParams();
  for (const key of ["search", "actorId", "action", "entityType", "correlationId", "severity", "category", "source", "from", "to", "sort"])
    if (input[key] != null && String(input[key]).trim()) params.set(key, String(input[key]));
  if (input.onlyChanges === true) params.set("onlyChanges", "true");
  const parsed = parseAuditQuery(params);
  return {
    search: parsed.search, actorId: parsed.actorId, action: parsed.action,
    entityType: parsed.entityType, correlationId: parsed.correlationId,
    severity: parsed.severity, category: parsed.category, source: parsed.source,
    onlyChanges: parsed.onlyChanges,
    from: parsed.from?.toISOString().slice(0, 10) || "",
    to: parsed.to?.toISOString().slice(0, 10) || "",
    sort: parsed.sort,
  };
}

export function investigationCreateInput(value: unknown) {
  const input = record(value, "Investigação inválida.");
  return {
    title: required(input.title, 4, 140, "Informe um título entre 4 e 140 caracteres."),
    summary: optional(input.summary, 2000),
    severity: requiredChoice(input.severity || "medium", INVESTIGATION_SEVERITIES, "Criticidade inválida."),
    assigneeId: optional(input.assigneeId, 160),
    dueAt: optionalDate(input.dueAt, "Prazo inválido."),
    eventKeys: eventKeys(input.eventKeys, true),
  };
}

export function investigationStatusInput(value: unknown) {
  const input = record(value, "Investigação inválida.");
  const status = requiredChoice(input.status, INVESTIGATION_STATUSES, "Estado da investigação inválido.");
  const resolution = optional(input.resolution, 4000);
  if (["resolved", "dismissed"].includes(status) && (!resolution || resolution.length < 5)) throw new AuditInputError("Registre a conclusão com ao menos 5 caracteres.");
  return {
    id: identifier(input.investigationId, "Investigação inválida."),
    expectedVersion: integer(input.expectedVersion, 0, 1, 2_147_483_647),
    status,
    severity: input.severity == null ? null : requiredChoice(input.severity, INVESTIGATION_SEVERITIES, "Criticidade inválida."),
    assigneeId: input.assigneeId === null || input.assigneeId === "" ? null : optional(input.assigneeId, 160),
    resolution,
  };
}

export function investigationNoteInput(value: unknown) {
  const input = record(value, "Anotação inválida.");
  return { id: identifier(input.investigationId, "Investigação inválida."), body: required(input.body, 2, 4000, "A anotação deve ter entre 2 e 4.000 caracteres.") };
}

export function investigationLinkInput(value: unknown) {
  const input = record(value, "Vínculo inválido.");
  return { id: identifier(input.investigationId, "Investigação inválida."), eventKeys: eventKeys(input.eventKeys, false) };
}

export function savedViewInput(value: unknown) {
  const input = record(value, "Visão inválida.");
  return {
    id: input.viewId == null ? null : integer(input.viewId, 0, 1, 2_147_483_647),
    name: required(input.name, 2, 80, "Informe um nome entre 2 e 80 caracteres."),
    description: optional(input.description, 300),
    visibility: input.visibility === "shared" ? "shared" as const : "private" as const,
    filters: auditFilterSnapshot(input.filters || {}),
  };
}

export function eventKeys(value: unknown, allowEmpty: boolean) {
  if (!Array.isArray(value) || (!allowEmpty && value.length === 0) || value.length > 100) throw new AuditInputError("Selecione entre 1 e 100 eventos.");
  const keys = [...new Set(value.map((item) => String(item)))];
  if (keys.some((item) => !/^(erp|integration):[A-Za-z0-9_-]+$/.test(item))) throw new AuditInputError("Um dos eventos selecionados é inválido.");
  return keys;
}

export function eventKey(value: unknown) {
  const key = String(value || "");
  if (!/^(erp|integration):[A-Za-z0-9_-]+$/.test(key)) throw new AuditInputError("Evento inválido.");
  const separator = key.indexOf(":");
  return { key, source: key.slice(0, separator) as "erp" | "integration", id: key.slice(separator + 1) };
}

export function redactAuditPayload(value: unknown, key = "", depth = 0): unknown {
  if (value == null || typeof value === "boolean" || typeof value === "number") return value;
  if (/pass(word)?|secret|token|private.?key|credential|certificate|authorization|cookie|pin|cvv/i.test(key)) return "[conteúdo protegido]";
  if (typeof value === "string") {
    if (/email/i.test(key)) return maskEmail(value);
    if (/document|cpf|cnpj|tax.?id/i.test(key)) return maskDocument(value);
    if (/phone|telefone|celular/i.test(key)) return maskPhone(value);
    return value.length > 500 ? `${value.slice(0, 497)}…` : value;
  }
  if (depth >= 6) return "[estrutura resumida]";
  if (Array.isArray(value)) return value.slice(0, 30).map((item) => redactAuditPayload(item, key, depth + 1));
  if (typeof value === "object") return Object.fromEntries(Object.entries(value as Record<string, unknown>).slice(0, 80).map(([childKey, child]) => [childKey, redactAuditPayload(child, childKey, depth + 1)]));
  return String(value);
}

export function auditChanges(beforeData: unknown, afterData: unknown) {
  const before = plainObject(beforeData), after = plainObject(afterData), keys = [...new Set([...Object.keys(before), ...Object.keys(after)])].sort();
  return keys.filter((key) => stable(before[key]) !== stable(after[key])).slice(0, 100).map((key) => ({ key, before: redactAuditPayload(before[key], key), after: redactAuditPayload(after[key], key) }));
}

export function auditCsv(items: AuditExportRow[]) {
  const rows = [
    ["Data e hora", "Ator", "E-mail", "Criticidade", "Categoria", "Origem", "Ação", "Entidade", "Registro", "Correlação", "Campos alterados", "Fingerprint"],
    ...items.map((item) => [String(item.createdAt), item.actor.name, item.actor.email, item.severity, item.category, item.source, item.action, item.entityType, item.entityId || "", item.correlationId || "", item.changedFields.join(", "), item.fingerprint || ""]),
  ];
  return `\uFEFF${rows.map((row) => row.map(csvCell).join(";")).join("\r\n")}`;
}

export function auditJsonl(items: AuditExportRow[]) {
  return items.map((item) => JSON.stringify({ ...item, actor: { name: item.actor.name, email: maskEmail(item.actor.email) } })).join("\n");
}

function csvCell(value: unknown) {
  let source = String(value ?? "");
  if (/^[=+\-@]/.test(source)) source = `'${source}`;
  return `"${source.replaceAll('"', '""')}"`;
}
function maskEmail(value: string) { const [name, domain] = value.split("@"); return domain ? `${name.slice(0, 2)}***@${domain}` : value; }
function maskDocument(value: string) { const digits = value.replace(/\D/g, ""); return digits.length > 4 ? `${"*".repeat(Math.min(8, digits.length - 4))}${digits.slice(-4)}` : "****"; }
function maskPhone(value: string) { const digits = value.replace(/\D/g, ""); return digits.length > 4 ? `(**) *****-${digits.slice(-4)}` : "****"; }
function plainObject(value: unknown) { return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {}; }
function stable(value: unknown): string { if (value === null) return "null"; if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`; if (value && typeof value === "object") return `{${Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => `${JSON.stringify(key)}:${stable(item)}`).join(",")}}`; try { return JSON.stringify(value) ?? String(value); } catch { return String(value); } }
function record(value: unknown, message: string) { if (!value || typeof value !== "object" || Array.isArray(value)) throw new AuditInputError(message); return value as Record<string, unknown>; }
function text(value: unknown, maximum: number) { const result = String(value || "").trim(); if (result.length > maximum) throw new AuditInputError("Um dos filtros excede o tamanho permitido."); return result; }
function optional(value: unknown, maximum: number) { const result = text(value, maximum); return result || null; }
function required(value: unknown, minimum: number, maximum: number, message: string) { const result = text(value, maximum); if (result.length < minimum) throw new AuditInputError(message); return result; }
function identifier(value: unknown, message: string) { const result = String(value || ""); if (!/^[A-Za-z0-9_-]{8,160}$/.test(result)) throw new AuditInputError(message); return result; }
function choice<T extends string>(value: unknown, values: readonly T[]) { const result = String(value || "") as T; return values.includes(result) ? result : "" as T | ""; }
function requiredChoice<T extends string>(value: unknown, values: readonly T[], message: string) { const result = choice(value, values); if (!result) throw new AuditInputError(message); return result; }
function integer(value: unknown, fallback: number, minimum: number, maximum: number) { const parsed = Number(value); if (value == null || value === "") return fallback; if (!Number.isInteger(parsed) || parsed < minimum || parsed > maximum) throw new AuditInputError("Número inválido."); return parsed; }
function optionalDate(value: unknown, message: string) { const source = String(value || "").trim(); if (!source) return null; const date = new Date(source); if (Number.isNaN(date.valueOf())) throw new AuditInputError(message); return date; }
