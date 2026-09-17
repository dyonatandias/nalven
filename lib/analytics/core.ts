export const ANALYTICS_TIMEZONE = "America/Sao_Paulo";
export const PERIODS = ["today", "7d", "30d", "90d", "all"] as const;
export type AnalyticsPeriod = typeof PERIODS[number];

export const PAGE_TYPES = ["home", "signup", "login", "blog", "glossary", "tracking", "recovery", "page", "other"] as const;
export type PageType = typeof PAGE_TYPES[number];
export type DeviceType = "desktop" | "mobile" | "tablet";

export const FUNNEL_STEPS = [
  { key: "landing_view", label: "Visita à página inicial" },
  { key: "signup_cta", label: "Clique em começar grátis" },
  { key: "signup_started", label: "Cadastro iniciado" },
  { key: "signup_completed", label: "Conta criada" },
] as const;

const PRIVATE_PREFIXES = ["/api", "/admin", "/erp", "/portal", "/convite", "/redefinir-senha", "/avaliar"];

export function normalizePeriod(value: string | null | undefined): AnalyticsPeriod {
  const aliases: Record<string, AnalyticsPeriod> = { week: "7d", month: "30d", quarter: "90d", tudo: "all", hoje: "today" };
  const normalized = aliases[String(value || "").toLowerCase()] || value;
  return PERIODS.includes(normalized as AnalyticsPeriod) ? normalized as AnalyticsPeriod : "7d";
}

export function normalizePath(value: string) {
  let path = "/";
  try { path = new URL(value, "https://analytics.invalid").pathname; } catch { path = value.split(/[?#]/, 1)[0] || "/"; }
  path = `/${path}`.replace(/\/{2,}/g, "/").slice(0, 500);
  path = path.replace(/^(\/(?:redefinir-senha|convite|avaliar))\/[^/]+/i, "$1/:token");
  return path;
}

export function shouldTrackPath(pathValue: string) {
  const path = normalizePath(pathValue).toLowerCase();
  return !PRIVATE_PREFIXES.some((prefix) => path === prefix || path.startsWith(`${prefix}/`));
}

export function classifyPage(pathValue: string): PageType {
  const path = normalizePath(pathValue);
  if (path === "/") return "home";
  if (path === "/cadastro") return "signup";
  if (path === "/login") return "login";
  if (path === "/blog" || path.startsWith("/blog/")) return "blog";
  if (path === "/glossario" || path.startsWith("/glossario/")) return "glossary";
  if (path === "/rastrear-pedido") return "tracking";
  if (path === "/esqueci-senha" || path.startsWith("/redefinir-senha/")) return "recovery";
  return path === "/" ? "home" : "page";
}

export function normalizePageType(value: unknown): PageType {
  return PAGE_TYPES.includes(value as PageType) ? value as PageType : "other";
}

export function normalizeDevice(value: unknown): DeviceType {
  return value === "mobile" || value === "tablet" ? value : "desktop";
}

export function referrerSource(value: unknown, currentHost?: string | null) {
  if (!value || typeof value !== "string") return "direct";
  try {
    const host = new URL(value).hostname.toLowerCase().replace(/^www\./, "");
    const ownHost = String(currentHost || "").toLowerCase().split(":")[0].replace(/^www\./, "");
    return !host || host === ownHost ? "direct" : host.slice(0, 120);
  } catch { return "direct"; }
}

export function localDate(date: Date, timezone: string) {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(date);
  const part = (type: Intl.DateTimeFormatPartTypes) => parts.find((item) => item.type === type)?.value || "";
  return `${part("year")}-${part("month")}-${part("day")}`;
}

export function addDays(date: string, amount: number) {
  const value = new Date(`${date}T12:00:00.000Z`);
  value.setUTCDate(value.getUTCDate() + amount);
  return value.toISOString().slice(0, 10);
}

export function eachDate(from: string, to: string) {
  const dates: string[] = [];
  for (let date = from; date <= to; date = addDays(date, 1)) dates.push(date);
  return dates;
}

export function periodRange(periodValue: string | null | undefined, timezone: string, now = new Date()) {
  const period = normalizePeriod(periodValue);
  const today = localDate(now, timezone);
  const days = period === "today" ? 1 : period === "7d" ? 7 : period === "30d" ? 30 : period === "90d" ? 90 : null;
  const from = days ? addDays(today, -(days - 1)) : null;
  return {
    key: period,
    today,
    requestedFrom: from,
    requestedTo: today,
    previousFrom: days ? addDays(from!, -days) : null,
    previousTo: days ? addDays(from!, -1) : null,
  };
}

export function validTimezone(value: string) {
  try { new Intl.DateTimeFormat("pt-BR", { timeZone: value }).format(); return true; } catch { return false; }
}
