/** Public, read-only license DTOs. Never include keys, prefixes or provider records. */
export type LicenseStatus = "active" | "expired" | "suspended" | "cancelled" | "pending" | "inactive" | "unknown";
export type LicenseDate = { kind: "date" | "not_defined" | "unknown"; value: string | null };
export type LicenseLimit = { kind: "finite" | "no_quota" | "unknown"; value: number | null };
export type LicenseResource = { code: string; name: string; enabled: boolean | null; availability: "enabled" | "disabled" | "unknown"; limit: LicenseLimit; origin: string | null };
export type LicenseMetric = { code: string; name: string; limit: LicenseLimit; unit: string | null };
export type PortalLicense = {
  status: LicenseStatus; statusCode: string | null; valid: boolean | null;
  validFrom: LicenseDate; validUntil: LicenseDate; graceUntil?: LicenseDate; maxInstallations: LicenseLimit;
  plan: { code: string | null; name: string | null };
  resources: LicenseResource[]; limits: LicenseMetric[]; resourcesKnown: boolean; limitsKnown: boolean;
};
export type PortalLicenseData = {
  license: PortalLicense;
  applicationPlan: { id: string; name: string; expectedRemoteCode: string | null; modules: { id: string; name: string; enabled: boolean }[] };
  comparison: { plan: "match" | "different" | "unknown" };
  source: { name: "billing_headless"; checkedAt: string; cached: boolean };
  warnings: string[];
  capabilities: { canRefresh: true; canExportDiagnostic: true; canRotate: false };
  generatedAt: string;
};
export class PortalLicenseDataError extends Error {}
type RecordData = Record<string, unknown>;
const own = (value: RecordData, key: string) => Object.prototype.hasOwnProperty.call(value, key);
const statuses: Record<string, LicenseStatus> = { active: "active", ativo: "active", ativa: "active", valid: "active", expired: "expired", expirada: "expired", expirado: "expired", vencida: "expired", suspended: "suspended", suspensa: "suspended", suspenso: "suspended", bloqueada: "suspended", cancelled: "cancelled", canceled: "cancelled", cancelada: "cancelled", cancelado: "cancelled", revoked: "cancelled", revogada: "cancelled", pending: "pending", pendente: "pending", aguardando_ativacao: "pending", inactive: "inactive", inativo: "inactive", inativa: "inactive", invalid: "inactive" };

export function portalLicensePayload(value: unknown): { license: PortalLicense; warnings: string[] } {
  const root = record(value);
  const license = own(root, "licenca") ? record(root.licenca) : own(root, "license") ? record(root.license) : root;
  if (!["status", "valida", "valida_de", "valida_ate", "recursos", "limites", "plano", "plano_codigo", "max_instalacoes"].some(key => own(license, key) || own(root, key))) throw new PortalLicenseDataError("License fields missing");
  const pick = (key: string) => own(root, key) ? root[key] : license[key];
  const warnings: string[] = [];
  const resourcesValue = pick("recursos"), limitsValue = pick("limites");
  const resourcesKnown = resourcesValue !== undefined, limitsKnown = limitsValue !== undefined;
  const limits = collection(limitsValue).map(item => ({ code: requiredCode(item.codigo), name: publicText(item.nome, 180) || requiredCode(item.codigo), limit: licenseLimit(item.valor, false), unit: publicText(item.sufixo, 40) }));
  unique(limits);
  const resources = collection(resourcesValue).map(item => {
    const code = requiredCode(item.codigo), enabled = typeof item.habilitado === "boolean" ? item.habilitado : null;
    // Explicit per-resource overrides outrank the base quota, even zero/null.
    const limit = own(item, "limite") ? licenseLimit(item.limite) : limits.find(metric => metric.code === code)?.limit || licenseLimit(undefined);
    const availability: LicenseResource["availability"] = enabled === false || (limit.kind === "finite" && limit.value === 0) ? "disabled" : enabled === true && limit.kind !== "unknown" ? "enabled" : "unknown";
    return { code, name: publicText(item.nome, 180) || code, enabled, availability, limit, origin: safeCode(item.origem) };
  });
  unique(resources);
  const planValue = pick("plano"), plan = planValue === undefined || planValue === null ? {} : record(planValue);
  const rawStatus = safeCode(pick("status")), statusCode = rawStatus && own(statuses, rawStatus) ? rawStatus : null;
  const valid = typeof pick("valida") === "boolean" ? pick("valida") as boolean : null;
  // A boolean validity never manufactures an active lifecycle status.
  const status = statusCode ? statuses[statusCode] : "unknown";
  const validFrom = licenseDate(pick("valida_de")), validUntil = licenseDate(pick("valida_ate"));
  if (status === "unknown") warnings.push("O serviço não informou um estado de licença reconhecido.");
  if (validUntil.kind !== "date") warnings.push("A validade final não foi confirmada; ausência de data não significa licença sem expiração.");
  if (!resourcesKnown) warnings.push("O serviço não informou a relação de recursos.");
  if (!limitsKnown) warnings.push("O serviço não informou a relação de cotas adicionais.");
  if (resources.some(item => item.availability === "unknown") || limits.some(item => item.limit.kind === "unknown")) warnings.push("Há habilitações ou limites não confirmados; valores ausentes não são considerados ilimitados.");
  if (valid === false && status === "active") warnings.push("O estado cadastral está ativo, mas o serviço informou validação negativa. Esta consulta não libera operações.");
  return { license: { status, statusCode, valid, validFrom, validUntil, ...(pick("grace_ate") !== undefined ? { graceUntil: licenseDate(pick("grace_ate")) } : {}), maxInstallations: licenseLimit(pick("max_instalacoes"), false), plan: { code: safeCode(plan.codigo) || safeCode(pick("plano_codigo")), name: publicText(plan.nome, 180) || publicText(pick("plano_nome"), 180) }, resources, limits, resourcesKnown, limitsKnown }, warnings };
}

export function licenseLimit(value: unknown, nullMeansNoQuota = true): LicenseLimit {
  if (value === null && nullMeansNoQuota) return { kind: "no_quota", value: null };
  if (typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= Number.MAX_SAFE_INTEGER) return { kind: "finite", value };
  return { kind: "unknown", value: null };
}

export function licenseDate(value: unknown): LicenseDate {
  if (value === null) return { kind: "not_defined", value: null };
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})?)?$/.test(value)) return { kind: "unknown", value: null };
  const dateOnly = value.slice(0, 10), parsedDate = new Date(`${dateOnly}T00:00:00Z`);
  if (!Number.isFinite(parsedDate.getTime()) || parsedDate.toISOString().slice(0, 10) !== dateOnly) return { kind: "unknown", value: null };
  if (value.length > 10 && (Number(value.slice(11, 13)) > 23 || Number(value.slice(14, 16)) > 59 || Number(value.slice(17, 19)) > 59)) return { kind: "unknown", value: null };
  // Keep date-only values and naive provider dates without inventing a timezone.
  if (value.length > 10 && !Number.isFinite(Date.parse(value))) return { kind: "unknown", value: null };
  return { kind: "date", value };
}

/** Export deliberately excludes organization/installation IDs, names and credentials. */
export function portalLicenseDiagnostic(data: PortalLicenseData) {
  return {
    version: 1, generatedAt: data.generatedAt, source: { name: data.source.name, checkedAt: data.source.checkedAt },
    license: { status: data.license.status, valid: data.license.valid, validFrom: { kind: data.license.validFrom.kind, value: data.license.validFrom.value }, validUntil: { kind: data.license.validUntil.kind, value: data.license.validUntil.value }, ...(data.license.graceUntil ? { graceUntil: { kind: data.license.graceUntil.kind, value: data.license.graceUntil.value } } : {}), maxInstallations: { kind: data.license.maxInstallations.kind, value: data.license.maxInstallations.value }, planCode: data.license.plan.code, resources: data.license.resources.map(item => ({ code: item.code, enabled: item.enabled, availability: item.availability, limit: { kind: item.limit.kind, value: item.limit.value } })), limits: data.license.limits.map(item => ({ code: item.code, limit: { kind: item.limit.kind, value: item.limit.value } })) },
    applicationPlan: { id: data.applicationPlan.id, expectedRemoteCode: data.applicationPlan.expectedRemoteCode, modules: data.applicationPlan.modules.map(item => ({ id: item.id, enabled: item.enabled })) },
    comparison: { plan: data.comparison.plan },
  };
}

function record(value: unknown): RecordData { if (!value || typeof value !== "object" || Array.isArray(value)) throw new PortalLicenseDataError("Invalid license object"); return value as RecordData; }
function collection(value: unknown): RecordData[] { if (value === undefined) return []; if (!Array.isArray(value) || value.length > 2000) throw new PortalLicenseDataError("Invalid license collection"); return value.map(record); }
function publicText(value: unknown, max: number) { if (typeof value !== "string" || /[\u0000-\u001f\u007f]/.test(value)) return null; const text = value.trim(); return text && text.length <= max ? text : null; }
function safeCode(value: unknown) { return typeof value === "string" && /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,119}$/.test(value) ? value.toLowerCase() : null; }
function requiredCode(value: unknown) { const code = safeCode(value); if (!code) throw new PortalLicenseDataError("Invalid resource code"); return code; }
function unique(values: { code: string }[]) { if (new Set(values.map(value => value.code)).size !== values.length) throw new PortalLicenseDataError("Duplicate resource code"); }
