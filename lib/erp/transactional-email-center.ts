const PERIODS = new Set([7, 30, 90]);
const DELIVERY_STATUSES = new Set([
  "pending",
  "processing",
  "sent",
  "failed",
  "dead",
]);

export type TransactionalEmailQuery = {
  days: 7 | 30 | 90;
  status: string;
  category: string;
  eventKey: string;
  search: string;
  page: number;
  limit: number;
  csv: boolean;
};

export function parseTransactionalEmailQuery(
  searchParams: URLSearchParams,
): TransactionalEmailQuery {
  const requestedDays = Number(searchParams.get("days") || 30);
  return {
    days: (PERIODS.has(requestedDays) ? requestedDays : 30) as 7 | 30 | 90,
    status: enumValue(searchParams.get("status"), DELIVERY_STATUSES),
    category: text(searchParams.get("category"), 100),
    eventKey: text(searchParams.get("eventKey"), 120),
    search: text(searchParams.get("search"), 120),
    page: integer(searchParams.get("page"), 1, 1, 400),
    limit: integer(searchParams.get("limit"), 25, 10, 100),
    csv: searchParams.get("format") === "csv",
  };
}

export const EMAIL_STATUS_META: Record<
  string,
  { label: string; tone: "neutral" | "info" | "success" | "warning" | "danger" }
> = {
  pending: { label: "Aguardando", tone: "warning" },
  processing: { label: "Processando", tone: "info" },
  sent: { label: "Aceito pelo SMTP", tone: "success" },
  failed: { label: "Nova tentativa", tone: "warning" },
  dead: { label: "Intervenção necessária", tone: "danger" },
};

export function publicDeliveryError(value: string | null | undefined) {
  if (!value) return null;
  const normalized = value.toLowerCase();
  if (normalized.includes("opt-out"))
    return "Envio bloqueado pela preferência do destinatário.";
  if (normalized.includes("conta smtp") || normalized.includes("smtp não configurado"))
    return "Nenhuma conta SMTP ativa está disponível.";
  if (normalized.includes("evento inexistente") || normalized.includes("desativado"))
    return "O evento foi removido ou está desativado.";
  if (normalized.includes("variáveis protegidas"))
    return "Os dados protegidos do evento não puderam ser lidos.";
  if (normalized.includes("destinatário") && normalized.includes("inválido"))
    return "O endereço protegido do destinatário é inválido.";
  if (normalized.includes("credenciais inválidas") || normalized.includes("auth"))
    return "O SMTP recusou as credenciais configuradas.";
  if (normalized.includes("limite") || normalized.includes("429"))
    return "O provedor limitou temporariamente os envios.";
  return "O transporte SMTP não concluiu a entrega. Consulte a saúde da conta.";
}

export function isPermanentDeliveryError(value: string | null | undefined) {
  const normalized = (value || "").toLowerCase();
  return [
    "opt-out",
    "evento inexistente",
    "evento desativado",
    "variáveis protegidas inválidas",
    "destinatário protegido inválido",
  ].some((part) => normalized.includes(part));
}

export type TemplateIssue = {
  level: "error" | "warning";
  code: string;
  message: string;
};

export function analyzeTransactionalTemplate(input: {
  subject: string;
  htmlBody: string;
  textBody: string;
  allowedVariables: string[];
}) {
  const issues: TemplateIssue[] = [];
  if (!input.subject.trim())
    issues.push({ level: "error", code: "subject.required", message: "Informe o assunto." });
  if (/[\r\n]/.test(input.subject))
    issues.push({
      level: "error",
      code: "subject.control",
      message: "O assunto não pode conter quebras de linha.",
    });
  if (input.subject.length > 240)
    issues.push({ level: "error", code: "subject.length", message: "O assunto excede 240 caracteres." });
  if (!input.htmlBody.trim())
    issues.push({ level: "error", code: "html.required", message: "Informe a versão HTML." });
  if (!input.textBody.trim())
    issues.push({ level: "error", code: "text.required", message: "Informe a versão em texto simples." });
  if (input.htmlBody.length > 200_000)
    issues.push({ level: "error", code: "html.length", message: "O HTML excede 200 mil caracteres." });
  if (input.textBody.length > 100_000)
    issues.push({ level: "error", code: "text.length", message: "O texto excede 100 mil caracteres." });
  if (
    /<\s*(script|iframe|object|embed|form|base|meta|link|svg)\b|\son[a-z]+\s*=|javascript\s*:|data\s*:\s*text\/html|expression\s*\(/i.test(
      input.htmlBody,
    )
  )
    issues.push({
      level: "error",
      code: "html.executable",
      message: "O HTML contém elemento, atributo ou protocolo executável não permitido.",
    });
  const allowed = new Set(input.allowedVariables);
  for (const variable of templateVariables(
    `${input.subject}\n${input.htmlBody}\n${input.textBody}`,
  ))
    if (!allowed.has(variable))
      issues.push({
        level: "error",
        code: `variable.unknown.${variable}`,
        message: `A variável {{${variable}}} não pertence a este evento.`,
      });
  if (!input.htmlBody.toLowerCase().includes("{{action.url}}"))
    issues.push({
      level: "warning",
      code: "action.missing",
      message: "A versão HTML não possui o link de ação do evento.",
    });
  if (!/<a\b[^>]*href\s*=\s*["']{{\s*action\.url\s*}}["']/i.test(input.htmlBody))
    issues.push({
      level: "warning",
      code: "action.not_link",
      message: "Transforme {{action.url}} em um link clicável na versão HTML.",
    });
  if (!input.textBody.includes("{{action.url}}"))
    issues.push({
      level: "warning",
      code: "text.action.missing",
      message: "A versão em texto simples não possui o link de ação.",
    });
  return uniqueIssues(issues);
}

export function templateVariables(value: string) {
  return [
    ...new Set(
      [...value.matchAll(/{{\s*([a-z][a-z0-9_.-]{0,79})\s*}}/gi)].map(
        (match) => match[1],
      ),
    ),
  ].sort();
}

export function renderTransactionalTemplate(
  template: string,
  variables: Record<string, string | number | boolean | null>,
  html = false,
) {
  return template.replace(
    /{{\s*([a-z0-9_.-]+)\s*}}/gi,
    (_match, key: string) => {
      const value = String(variables[key] ?? "");
      return html ? escapeHtml(value) : value;
    },
  );
}

export type DeliveryCsvRow = {
  eventId: string;
  eventKey: string;
  recipientMasked: string;
  status: string;
  attempts: number;
  version: number | null;
  createdAt: Date | string;
  sentAt: Date | string | null;
  error: string | null;
};

export function transactionalDeliveryCsv(rows: DeliveryCsvRow[]) {
  const header = [
    "ID do evento",
    "Evento",
    "Destinatário",
    "Status",
    "Tentativas",
    "Versão",
    "Criado em",
    "Aceito pelo SMTP em",
    "Diagnóstico",
  ];
  return [
    header,
    ...rows.map((row) => [
      row.eventId,
      row.eventKey,
      row.recipientMasked,
      EMAIL_STATUS_META[row.status]?.label || row.status,
      row.attempts,
      row.version ?? "",
      iso(row.createdAt),
      row.sentAt ? iso(row.sentAt) : "",
      row.error || "",
    ]),
  ]
    .map((row) => row.map(csvCell).join(","))
    .join("\r\n");
}

function text(value: string | null, max: number) {
  return (value || "").trim().slice(0, max);
}
function enumValue(value: string | null, allowed: Set<string>) {
  return value && allowed.has(value) ? value : "";
}
function integer(
  value: string | null,
  fallback: number,
  minimum: number,
  maximum: number,
) {
  const parsed = Number(value);
  return Number.isInteger(parsed)
    ? Math.min(Math.max(parsed, minimum), maximum)
    : fallback;
}
function uniqueIssues(issues: TemplateIssue[]) {
  return [...new Map(issues.map((issue) => [issue.code, issue])).values()];
}
function escapeHtml(value: string) {
  return value.replace(
    /[&<>"']/g,
    (character) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        character
      ]!,
  );
}
function iso(value: Date | string) {
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? "" : date.toISOString();
}
function csvCell(value: unknown) {
  let textValue = String(value ?? "");
  if (/^[=+\-@\t\r]/.test(textValue)) textValue = `'${textValue}`;
  return `"${textValue.replaceAll('"', '""')}"`;
}
