import { addCalendarDays } from "./report-sales";

export const REPORT_DEFINITIONS = [
  {
    key: "margins",
    name: "Margens e precificação",
    description:
      "Custos, margem real, saúde e preço recomendado por produto e categoria.",
    href: "/erp/relatorios/margens",
    area: "Rentabilidade",
    accent: "green",
    exportModes: ["page", "all"],
  },
  {
    key: "sales",
    name: "Vendas e desempenho",
    description:
      "Receita líquida, pedidos, ticket médio, evolução e produtos líderes.",
    href: "/erp/relatorios/vendas",
    area: "Comercial",
    accent: "blue",
    exportModes: ["summary", "top"],
  },
  {
    key: "products",
    name: "Catálogo e estoque",
    description:
      "Produtos, preços, categorias, disponibilidade, peso e dimensões.",
    href: "/erp/relatorios/produtos",
    area: "Operações",
    accent: "amber",
    exportModes: ["page", "all"],
  },
  {
    key: "fiscal",
    name: "Prontidão fiscal",
    description:
      "Completude de NCM, CEST, origem e GTIN, com correção operacional em lote.",
    href: "/erp/relatorios/fiscal",
    area: "Conformidade",
    accent: "purple",
    exportModes: ["page", "all"],
  },
] as const;

export type ReportKey = (typeof REPORT_DEFINITIONS)[number]["key"];
export type ReportFrequency = "daily" | "weekly" | "monthly";

const FILTERS: Record<ReportKey, Set<string>> = {
  margins: new Set(["category_id", "health", "order_by", "order", "view"]),
  sales: new Set(["period", "date_min", "date_max"]),
  products: new Set([
    "search",
    "category",
    "stock_status",
    "min_price",
    "max_price",
    "order_by",
    "order",
  ]),
  fiscal: new Set(["search", "missing_field", "incomplete"]),
};

export class ReportWorkspaceInputError extends Error {
  constructor(
    message: string,
    public status = 400,
  ) {
    super(message);
  }
}

export function parseReportKey(value: unknown): ReportKey {
  const key = String(value || "");
  if (!REPORT_DEFINITIONS.some((item) => item.key === key))
    throw new ReportWorkspaceInputError("Relatório inválido.");
  return key as ReportKey;
}

export function reportName(key: ReportKey) {
  return REPORT_DEFINITIONS.find((item) => item.key === key)?.name || key;
}

export function normalizeReportFilters(key: ReportKey, value: unknown) {
  if (value === null || value === undefined) return {};
  if (typeof value !== "object" || Array.isArray(value))
    throw new ReportWorkspaceInputError("Filtros inválidos.");
  const result: Record<string, string> = {};
  for (const [name, raw] of Object.entries(value)) {
    if (
      !FILTERS[key].has(name) ||
      raw === null ||
      raw === undefined ||
      raw === ""
    )
      continue;
    if (
      typeof raw !== "string" &&
      typeof raw !== "number" &&
      typeof raw !== "boolean"
    )
      throw new ReportWorkspaceInputError("Valor de filtro inválido.");
    const normalized = String(raw).trim();
    if (normalized.length > 160)
      throw new ReportWorkspaceInputError(
        "Um filtro excede o tamanho permitido.",
      );
    result[name] = normalized;
  }
  return result;
}

export function savedViewInput(value: Record<string, unknown>) {
  const name = String(value.name || "").trim();
  if (name.length < 3 || name.length > 100)
    throw new ReportWorkspaceInputError(
      "O nome deve ter entre 3 e 100 caracteres.",
    );
  const description = String(value.description || "").trim();
  if (description.length > 300)
    throw new ReportWorkspaceInputError(
      "A descrição deve ter até 300 caracteres.",
    );
  const reportKey = parseReportKey(value.reportKey);
  const visibility = value.visibility === "team" ? "team" : "private";
  return {
    name,
    description: description || null,
    reportKey,
    visibility,
    filters: normalizeReportFilters(reportKey, value.filters),
  };
}

export function scheduleInput(
  value: Record<string, unknown>,
  fallbackTimezone: string,
  now = new Date(),
) {
  const name = String(value.name || "").trim();
  if (name.length < 3 || name.length > 100)
    throw new ReportWorkspaceInputError(
      "O nome da rotina deve ter entre 3 e 100 caracteres.",
    );
  const reportKey = parseReportKey(value.reportKey);
  const frequency = String(value.frequency || "") as ReportFrequency;
  if (!["daily", "weekly", "monthly"].includes(frequency))
    throw new ReportWorkspaceInputError("Frequência inválida.");
  const time = String(value.time || "");
  if (!/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(time))
    throw new ReportWorkspaceInputError("Horário inválido.");
  const timezone = validTimezone(String(value.timezone || fallbackTimezone))
    ? String(value.timezone || fallbackTimezone)
    : fallbackTimezone;
  const weekday =
    frequency === "weekly"
      ? integerInRange(value.weekday, 0, 6, "Dia da semana inválido.")
      : null;
  const dayOfMonth =
    frequency === "monthly"
      ? integerInRange(value.dayOfMonth, 1, 28, "Dia do mês inválido.")
      : null;
  return {
    name,
    reportKey,
    filters: normalizeReportFilters(reportKey, value.filters),
    format: "csv",
    frequency,
    weekday,
    dayOfMonth,
    time,
    timezone,
    nextRunAt: nextScheduleRun(
      { frequency, weekday, dayOfMonth, time, timezone },
      now,
    ),
  };
}

export function nextScheduleRun(
  schedule: {
    frequency: ReportFrequency;
    weekday: number | null;
    dayOfMonth: number | null;
    time: string;
    timezone: string;
  },
  now = new Date(),
) {
  const localToday = localDate(now, schedule.timezone);
  for (let offset = 0; offset <= 370; offset += 1) {
    const candidateDate = addCalendarDays(localToday, offset);
    const calendar = new Date(`${candidateDate}T12:00:00Z`);
    const eligible =
      schedule.frequency === "daily" ||
      (schedule.frequency === "weekly" &&
        calendar.getUTCDay() === schedule.weekday) ||
      (schedule.frequency === "monthly" &&
        calendar.getUTCDate() === schedule.dayOfMonth);
    if (!eligible) continue;
    const candidate = zonedDateTime(
      candidateDate,
      schedule.time,
      schedule.timezone,
    );
    if (candidate > now) return candidate;
  }
  throw new ReportWorkspaceInputError(
    "Não foi possível calcular a próxima execução.",
  );
}

export function reportHref(key: ReportKey, filters: unknown) {
  const definition = REPORT_DEFINITIONS.find((item) => item.key === key)!;
  const query = new URLSearchParams(
    normalizeReportFilters(key, filters),
  ).toString();
  return `${definition.href}${query ? `?${query}` : ""}`;
}

function integerInRange(
  value: unknown,
  minimum: number,
  maximum: number,
  message: string,
) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < minimum || parsed > maximum)
    throw new ReportWorkspaceInputError(message);
  return parsed;
}

function validTimezone(value: string) {
  try {
    new Intl.DateTimeFormat("pt-BR", { timeZone: value }).format();
    return true;
  } catch {
    return false;
  }
}

function localDate(value: Date, timezone: string) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(value);
  const pick = (type: string) =>
    parts.find((item) => item.type === type)?.value || "";
  return `${pick("year")}-${pick("month")}-${pick("day")}`;
}

function zonedDateTime(date: string, time: string, timezone: string) {
  const [year, month, day] = date.split("-").map(Number),
    [hour, minute] = time.split(":").map(Number);
  const desired = Date.UTC(year, month - 1, day, hour, minute, 0);
  let timestamp = desired;
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  });
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const parts = Object.fromEntries(
      formatter
        .formatToParts(new Date(timestamp))
        .map((item) => [item.type, item.value]),
    );
    const observed = Date.UTC(
      Number(parts.year),
      Number(parts.month) - 1,
      Number(parts.day),
      Number(parts.hour),
      Number(parts.minute),
      Number(parts.second),
    );
    timestamp += desired - observed;
  }
  return new Date(timestamp);
}
