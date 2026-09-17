export const BRANCH_STATUSES = ["planned", "active", "inactive"] as const;
export const BRANCH_TYPES = ["headquarters", "branch"] as const;
export const BRANCH_SORTS = ["name", "readiness", "recent", "stock", "team"] as const;
export class BranchControlError extends Error {}

export type BusinessHour = { day: number; enabled: boolean; opensAt: string; closesAt: string };
export type ReadinessCheck = { key: string; label: string; complete: boolean; weight: number; critical: boolean; guidance: string };

export const DEFAULT_BUSINESS_HOURS: BusinessHour[] = [
  { day: 0, enabled: false, opensAt: "08:00", closesAt: "18:00" },
  { day: 1, enabled: true, opensAt: "08:00", closesAt: "18:00" },
  { day: 2, enabled: true, opensAt: "08:00", closesAt: "18:00" },
  { day: 3, enabled: true, opensAt: "08:00", closesAt: "18:00" },
  { day: 4, enabled: true, opensAt: "08:00", closesAt: "18:00" },
  { day: 5, enabled: true, opensAt: "08:00", closesAt: "18:00" },
  { day: 6, enabled: false, opensAt: "08:00", closesAt: "12:00" },
];

export type BranchReadinessSource = {
  legalName?: string | null;
  document?: string | null;
  activityCode?: string | null;
  stateRegistration?: string | null;
  stateRegistrationExempt?: boolean;
  zip?: string | null;
  street?: string | null;
  number?: string | null;
  city?: string | null;
  state?: string | null;
  email?: string | null;
  phone?: string | null;
  managerName?: string | null;
  managerEmail?: string | null;
  managerPhone?: string | null;
  defaultWarehouseId?: number | null;
  warehouseCount: number;
  userCount: number;
  productCount: number;
  validCertificateCount: number;
  settings?: {
    fiscalEnvironment?: string | null;
    fiscalEnabled?: boolean;
    salesEnabled?: boolean;
    purchasesEnabled?: boolean;
    stockEnabled?: boolean;
    servicesEnabled?: boolean;
    businessHours?: unknown;
  } | null;
};

export function branchReadiness(source: BranchReadinessSource) {
  const capabilities = source.settings && [source.settings.salesEnabled, source.settings.purchasesEnabled, source.settings.stockEnabled, source.settings.fiscalEnabled, source.settings.servicesEnabled].some(Boolean);
  const fiscalReady = !source.settings?.fiscalEnabled || source.settings.fiscalEnvironment !== "production" || source.validCertificateCount > 0;
  const schedule = normalizeBusinessHours(source.settings?.businessHours);
  const checks: ReadinessCheck[] = [
    check("legal", "Identidade legal", Boolean(source.legalName && source.document?.length === 14), 15, true, "Complete razão social e CNPJ."),
    check("tax", "Cadastro tributário", Boolean(source.activityCode && (source.stateRegistrationExempt || source.stateRegistration)), 10, false, "Informe CNAE e inscrição estadual ou marque isenção."),
    check("address", "Endereço completo", Boolean(source.zip?.length === 8 && source.street && source.number && source.city && source.state?.length === 2), 15, true, "Complete CEP, logradouro, número, cidade e UF."),
    check("contact", "Contato e responsável", Boolean((source.email || source.phone) && source.managerName && (source.managerEmail || source.managerPhone)), 10, false, "Informe contato da unidade e responsável local."),
    check("warehouse", "Estrutura de estoque", Boolean(source.warehouseCount > 0 && source.defaultWarehouseId), 15, Boolean(source.settings?.stockEnabled ?? true), "Vincule ao menos um depósito e defina o padrão."),
    check("users", "Equipe autorizada", source.userCount > 0, 10, true, "Autorize ao menos uma pessoa na unidade."),
    check("catalog", "Catálogo operacional", source.productCount > 0, 10, Boolean(source.settings?.salesEnabled || source.settings?.purchasesEnabled || source.settings?.servicesEnabled), "Libere produtos ou serviços no catálogo local."),
    check("fiscal", "Emissão fiscal", fiscalReady, 10, false, "Produção fiscal exige certificado A1 ativo e válido."),
    check("operation", "Operação e horários", Boolean(capabilities && schedule.some((item) => item.enabled)), 5, true, "Ative uma capacidade e ao menos um dia de operação."),
  ];
  const score = checks.reduce((total, item) => total + (item.complete ? item.weight : 0), 0);
  const issues = checks.filter((item) => !item.complete);
  const hasCriticalIssue = issues.some((item) => item.critical);
  return { score, status: hasCriticalIssue ? "critical" : score >= 90 ? "ready" : "attention", checks, issues, canActivate: !hasCriticalIssue };
}

export function normalizeBusinessHours(value: unknown): BusinessHour[] {
  if (!Array.isArray(value)) return DEFAULT_BUSINESS_HOURS.map((item) => ({ ...item }));
  const byDay = new Map<number, BusinessHour>();
  for (const entry of value) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
    const item = entry as Record<string, unknown>, day = Number(item.day);
    if (!Number.isInteger(day) || day < 0 || day > 6 || byDay.has(day)) continue;
    const opensAt = validClock(item.opensAt) ? String(item.opensAt) : "08:00", closesAt = validClock(item.closesAt) ? String(item.closesAt) : "18:00", enabled = item.enabled === true;
    byDay.set(day, { day, enabled, opensAt, closesAt });
  }
  return DEFAULT_BUSINESS_HOURS.map((fallback) => byDay.get(fallback.day) || { ...fallback });
}

export function validateBusinessHours(value: unknown) {
  if (!Array.isArray(value) || value.length !== 7) throw new BranchControlError("Informe os horários dos sete dias da semana.");
  const normalized = normalizeBusinessHours(value);
  if (new Set(value.map((item) => item && typeof item === "object" && !Array.isArray(item) ? Number((item as Record<string, unknown>).day) : -1)).size !== 7) throw new BranchControlError("Há dias ausentes ou duplicados nos horários.");
  for (const item of normalized) if (item.enabled && item.opensAt >= item.closesAt) throw new BranchControlError("O horário de fechamento deve ser posterior à abertura.");
  return normalized;
}

export function parseBranchQuery(parameters: URLSearchParams) {
  const page = integer(parameters.get("page"), 1, 10_000, 1), limit = integer(parameters.get("limit"), 1, 100, 24);
  const status = member(parameters.get("status"), BRANCH_STATUSES), type = member(parameters.get("type"), BRANCH_TYPES), sort = member(parameters.get("sort"), BRANCH_SORTS) || "name";
  const readiness = member(parameters.get("readiness"), ["ready", "attention", "critical"] as const), state = String(parameters.get("state") || "").trim().toUpperCase(), search = String(parameters.get("search") || "").trim().slice(0, 120), format = parameters.get("format") === "csv" ? "csv" : "json";
  if (state && !/^[A-Z]{2}$/.test(state)) throw new BranchControlError("UF inválida.");
  return { page, limit, status, type, sort, readiness, state, search, format };
}

export function branchCsv(items: Array<{ code: string; name: string; legalName: string; document: string; type: string; status: string; city?: string | null; state?: string | null; readiness: { score: number }; metrics: { warehouseCount: number; userCount: number; productCount: number; availableStock: number; financialAccountCount: number } }>) {
  const rows = [["Código", "Unidade", "Razão social", "CNPJ", "Tipo", "Situação", "Cidade", "UF", "Prontidão", "Depósitos", "Usuários", "Catálogo", "Saldo disponível", "Contas financeiras"]];
  for (const item of items) rows.push([item.code, item.name, item.legalName, item.document, item.type, item.status, item.city || "", item.state || "", String(item.readiness.score), String(item.metrics.warehouseCount), String(item.metrics.userCount), String(item.metrics.productCount), String(item.metrics.availableStock), String(item.metrics.financialAccountCount)]);
  return `\uFEFF${rows.map((row) => row.map(csvCell).join(";")).join("\r\n")}`;
}

function check(key: string, label: string, complete: boolean, weight: number, critical: boolean, guidance: string): ReadinessCheck { return { key, label, complete, weight, critical, guidance }; }
function validClock(value: unknown) { return typeof value === "string" && /^(?:[01]\d|2[0-3]):[0-5]\d$/.test(value); }
function integer(value: string | null, min: number, max: number, fallback: number) { const parsed = Number(value || fallback); if (!Number.isInteger(parsed) || parsed < min || parsed > max) throw new BranchControlError("Paginação inválida."); return parsed; }
function member<T extends string>(value: string | null, allowed: readonly T[]) { if (!value) return "" as const; if (!allowed.includes(value as T)) throw new BranchControlError("Filtro inválido."); return value as T; }
function csvCell(value: string) { return `"${value.replaceAll('"', '""')}"`; }
