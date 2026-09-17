/** Read-only Billing contract probe. Run privately with the existing application
 * EnvironmentFile. Output contains schema, counts and controlled enum/flag values
 * only; never credentials, identifiers, names, addresses, URLs or message text.
 */
import { controlDb } from "../db/control";
import { BillingClient, BillingError } from "../lib/billing/client";

type Shape = string | { type: "object"; fields: Record<string, Shape> } | { type: "array"; count: number; item: Shape } | { type: "union"; alternatives: Shape[] };
const enumFields = new Set(["status", "prioridade", "categoria", "autor_tipo", "author_type", "tipo_autor", "visibility", "visibilidade"]);
const flagFields = new Set(["interna", "interno", "internal", "is_internal", "publico", "public", "is_public", "customer_visible", "visivel_cliente", "privada", "private"]);
const record = (value: unknown): Record<string, unknown> => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
const fieldName = (value: string) => /^[a-zA-Z_][a-zA-Z0-9_]{0,47}$/.test(value) && !/^[a-f0-9]{20,}$/i.test(value) ? value : "[dynamic-key]";

function combine(shapes: Shape[]): Shape {
  const distinct = [...new Map(shapes.map(shape => [JSON.stringify(shape), shape])).values()];
  if (!distinct.length) return "unknown";
  if (distinct.length === 1) return distinct[0];
  if (distinct.every(shape => typeof shape !== "string" && shape.type === "object")) {
    const fields: Record<string, Shape[]> = {};
    for (const shape of distinct) {
      if (typeof shape === "string" || shape.type !== "object") continue;
      for (const [key, value] of Object.entries(shape.fields)) (fields[key] ||= []).push(value);
    }
    return { type: "object", fields: Object.fromEntries(Object.entries(fields).map(([key, values]) => [key, combine(values)])) };
  }
  return { type: "union", alternatives: distinct };
}

function shape(value: unknown, depth = 0): Shape {
  if (value === null) return "null";
  if (depth >= 7) return Array.isArray(value) ? "array" : typeof value;
  if (Array.isArray(value)) return { type: "array", count: value.length, item: combine(value.slice(0, 5).map(item => shape(item, depth + 1))) };
  if (typeof value === "object") return { type: "object", fields: Object.fromEntries(Object.entries(record(value)).slice(0, 80).map(([key, item]) => [fieldName(key), shape(item, depth + 1)])) };
  return typeof value;
}

function controlledValues(value: unknown, path = "", depth = 0, result: Record<string, Array<string | number | boolean>> = {}) {
  if (depth >= 7) return result;
  if (Array.isArray(value)) { for (const item of value.slice(0, 5)) controlledValues(item, `${path}[]`, depth + 1, result); return result; }
  for (const [key, item] of Object.entries(record(value)).slice(0, 80)) {
    const current = path ? `${path}.${fieldName(key)}` : fieldName(key);
    const isEnum = enumFields.has(key) && typeof item === "string" && /^[a-z_][a-z0-9_-]{0,31}$/i.test(item);
    const isFlag = flagFields.has(key) && (typeof item === "boolean" || item === 0 || item === 1 || item === "0" || item === "1");
    if (isEnum || isFlag) result[current] = [...new Set([...(result[current] || []), item as string | number | boolean])];
    if (item && typeof item === "object") controlledValues(item, current, depth + 1, result);
  }
  return result;
}

function collection(value: unknown): unknown[] {
  if (Array.isArray(value)) return value;
  const source = record(value);
  for (const key of ["items", "tickets", "chamados", "data", "support"]) if (Array.isArray(source[key])) return source[key] as unknown[];
  return [];
}

function report(label: string, value: unknown) {
  console.log(JSON.stringify({ label, schema: shape(value), enumAndFlagValues: controlledValues(value) }));
}

try {
  const account = await controlDb.billingAccount.findFirst({
    where: { organization: { database: { configKey: "demo" } } },
    select: { externalId: true },
  });
  if (!account) throw new Error("ProbeAccountUnavailable");
  const client = new BillingClient();
  const list = await client.tickets(account.externalId);
  report("ticket-list", list);
  const rows = collection(list);
  const tokens = rows.flatMap(row => {
    const token = record(row).token;
    return typeof token === "string" && /^[A-Za-z0-9_-]{1,200}$/.test(token) ? [token] : [];
  });
  const selected = [...new Set(tokens)].slice(0, 3);
  console.log(JSON.stringify({ label: "sample-counts", listed: rows.length, selectedDetails: selected.length }));
  for (const [index, token] of selected.entries()) report(`ticket-detail-${index + 1}`, await client.ticket(account.externalId, token));
} catch (error) {
  console.error(JSON.stringify({ label: "probe-failure", kind: error instanceof BillingError ? "BillingError" : "ProbeError", status: error instanceof BillingError ? error.status : null }));
  process.exitCode = 1;
} finally {
  await controlDb.$disconnect();
}
