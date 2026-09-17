/** Private GET-only license contract probe. Never invoke tenantLicense, sync,
 * activation, validation, rotation or usage reporting: those can change state.
 * Only schemas, controlled enums/flags and aggregate counts leave this process.
 */
import { controlDb } from "../db/control";
import { BillingClient, BillingError, billingSettings } from "../lib/billing/client";
import { decryptSecret } from "../lib/secrets";
import { safeRequest } from "../lib/integrations/security";

type Shape = string | { type: "object"; fields: Record<string, Shape> } | { type: "array"; count: number; item: Shape } | { type: "union"; alternatives: Shape[] };
const record = (value: unknown): Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
const fieldName = (value: string) => /^[a-zA-Z_][a-zA-Z0-9_]{0,47}$/.test(value) && !/^[a-f0-9]{20,}$/i.test(value) ? value : "[dynamic-key]";
const sensitiveMap = /^(metadata|metadados|config|configuration|settings|extra|extras|attributes)$/i;
const enums: Record<string, Set<string>> = {
  status: new Set(["ativa", "ativo", "active", "inativa", "inativo", "inactive", "trial", "trialing", "suspensa", "suspenso", "suspended", "cancelada", "cancelado", "cancelled", "canceled", "expirada", "expirado", "expired", "bloqueada", "bloqueado", "blocked", "pendente", "pending", "valid", "invalid", "carencia", "grace"]),
  ambiente: new Set(["local", "sandbox", "homologacao", "producao"]),
  origem: new Set(["plano", "licenca", "modulo", "adicional", "override", "plan", "license"]),
  tipo: new Set(["habilitacao", "cota", "quota", "feature", "numero", "booleano"]),
  periodicidade: new Set(["instantaneo", "mensal", "diario", "anual", "configuracao"]),
};
const flags = new Set(["success", "valida", "habilitado", "ativo", "ativa", "bloqueado", "bloqueada", "suspenso", "suspensa", "ilimitado", "permite_ilimitado"]);
const bounds = new Set(["limite", "valor", "limite_valor", "max_instalacoes"]);
const dateFields = new Set(["valida_de", "valida_ate", "expira_em", "servidor_em", "created_at", "updated_at", "activated_at", "expires_at", "valid_from", "valid_until"]);

function combine(shapes: Shape[]): Shape {
  const unique = [...new Map(shapes.map(value => [JSON.stringify(value), value])).values()];
  if (!unique.length) return "unknown";
  if (unique.length === 1) return unique[0];
  if (unique.every(value => typeof value !== "string" && value.type === "object")) {
    const fields: Record<string, Shape[]> = {};
    for (const value of unique) {
      if (typeof value === "string" || value.type !== "object") continue;
      for (const [key, shape] of Object.entries(value.fields)) (fields[key] ||= []).push(shape);
    }
    return { type: "object", fields: Object.fromEntries(Object.entries(fields).map(([key, values]) => [key, combine(values)])) };
  }
  return { type: "union", alternatives: unique };
}

function shape(value: unknown, depth = 0): Shape {
  if (value === null) return "null";
  if (depth >= 7) return Array.isArray(value) ? "array" : typeof value;
  if (Array.isArray(value)) return { type: "array", count: value.length, item: combine(value.slice(0, 5).map(item => shape(item, depth + 1))) };
  if (typeof value === "object") return { type: "object", fields: Object.fromEntries(Object.entries(record(value)).slice(0, 80).map(([key, item]) => [fieldName(key), sensitiveMap.test(key) ? "redacted-map" : shape(item, depth + 1)])) };
  return typeof value;
}

function observations(value: unknown, path = "", depth = 0, result: Record<string, Record<string, number>> = {}) {
  if (depth >= 7) return result;
  if (Array.isArray(value)) { for (const item of value.slice(0, 5000)) observations(item, `${path}[]`, depth + 1, result); return result; }
  for (const [key, item] of Object.entries(record(value)).slice(0, 80)) {
    const current = path ? `${path}.${fieldName(key)}` : fieldName(key);
    let category: string | undefined;
    if (enums[key]) category = typeof item === "string" && enums[key].has(item) ? item : item === null ? "null" : "unknown-enum";
    if (flags.has(key)) category = typeof item === "boolean" ? String(item) : item === null ? "null" : `non-boolean-${typeof item}`;
    if (bounds.has(key)) category = item === null ? "null" : typeof item !== "number" ? `non-number-${typeof item}` : !Number.isFinite(item) ? "non-finite" : item === 0 ? "zero" : item === -1 ? "minus-one" : item < 0 ? "negative-other" : "positive";
    if (dateFields.has(key)) category = item === null ? "null" : typeof item !== "string" ? `non-string-${typeof item}` : /^\d{4}-\d{2}-\d{2}$/.test(item) ? "date-only" : /^\d{4}-\d{2}-\d{2}[T ][\d:.]+(?:Z|[+-]\d{2}:?\d{2})$/.test(item) ? "timestamp-with-zone" : /^\d{4}-\d{2}-\d{2}[T ][\d:.]+$/.test(item) ? "timestamp-without-zone" : "unrecognized-date";
    if (category) { result[current] ||= {}; result[current][category] = (result[current][category] || 0) + 1; }
    if (item && typeof item === "object" && !sensitiveMap.test(key)) observations(item, current, depth + 1, result);
  }
  return result;
}

function report(label: string, value: unknown) {
  console.log(JSON.stringify({ label, schema: shape(value), observations: observations(value) }));
}

try {
  const account = await controlDb.billingAccount.findFirst({
    where: { organization: { database: { configKey: "demo" } } },
    select: { externalId: true, licenseSecret: true, entitlementCache: true },
  });
  if (!account) throw new Error("ProbeAccountUnavailable");
  report("local-entitlement-cache", account.entitlementCache);
  console.log(JSON.stringify({ label: "local-configuration", licenseConfigured: Boolean(account.licenseSecret) }));
  try { report("headless-license", await new BillingClient().license(account.externalId)); }
  catch (error) { console.log(JSON.stringify({ label: "headless-license-unavailable", status: error instanceof BillingError ? error.status : null })); process.exitCode = 1; }
  if (account.licenseSecret) {
    const settings = await billingSettings();
    const response = await safeRequest(`${settings.baseUrl.replace(/\/$/, "")}/licencas/entitlements?${new URLSearchParams({ produto_codigo: settings.productCode, instalacao_id: account.externalId })}`, {
      method: "GET", headers: { Authorization: `License ${decryptSecret(account.licenseSecret)}`, Accept: "application/json" }, timeoutMs: settings.licenseTimeoutMs,
    });
    console.log(JSON.stringify({ label: "runtime-entitlements-http", status: response.status }));
    if (response.status >= 200 && response.status < 300) report("runtime-entitlements", JSON.parse(response.body));
    else process.exitCode = 1;
  }
} catch (error) {
  console.error(JSON.stringify({ label: "probe-failure", kind: error instanceof BillingError ? "BillingError" : "ProbeError", status: error instanceof BillingError ? error.status : null }));
  process.exitCode = 1;
} finally {
  await controlDb.$disconnect();
}
