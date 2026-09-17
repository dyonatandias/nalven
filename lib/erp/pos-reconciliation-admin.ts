import { createHash } from "node:crypto";
import { normalizePosReconciliationLayout, POS_RECONCILIATION_FIELDS, type PosReconciliationField, type PosReconciliationLayoutConfig } from "@/lib/erp/pos-reconciliation-layout";

export const DEFAULT_POS_RECONCILIATION_COLUMNS: Readonly<Record<PosReconciliationField, string>> = Object.freeze({
  settlementId: "settlement_id",
  transactionId: "transaction_id",
  kind: "kind",
  grossCents: "gross_cents",
  feeCents: "fee_cents",
  netCents: "net_cents",
  occurredAt: "occurred_at",
  settledAt: "settled_at",
});

export const DEFAULT_POS_RECONCILIATION_KINDS = Object.freeze({ payment: Object.freeze(["payment"]), refund: Object.freeze(["refund"]), chargeback: Object.freeze(["chargeback"]) });

type LayoutFields = {
  name: string;
  delimiter: "," | ";" | "\t";
  amountMode: "integer_cents" | "decimal";
  decimalSeparator: "." | ",";
  dateMode: "iso8601" | "epoch_millis";
  columns: Record<PosReconciliationField, string>;
  kindMapping: Record<"payment" | "refund" | "chargeback", readonly string[]>;
  matchWindowHours: number;
};

export type PosReconciliationAdminInput =
  | ({ action: "layout.create"; branchId: number; provider: string; idempotencyKey: string } & LayoutFields)
  | ({ action: "layout.update"; layoutId: string; expectedVersion: number; idempotencyKey: string } & LayoutFields)
  | { action: "layout.deactivate"; layoutId: string; expectedVersion: number; idempotencyKey: string }
  | { action: "batch.import"; branchId: number; layoutId: string; csv: string; idempotencyKey: string }
  | { action: "batch.reprocess"; batchId: string; expectedVersion: number; idempotencyKey: string };

export class PosReconciliationAdminError extends Error {
  constructor(message: string, readonly status = 422) {
    super(message);
    this.name = "PosReconciliationAdminError";
  }
}

export function parsePosReconciliationAdminInput(body: Record<string, unknown>): PosReconciliationAdminInput {
  const action = choice(body.action, ["layout.create", "layout.update", "layout.deactivate", "batch.import", "batch.reprocess"] as const, "Ação");
  if (action === "layout.create") {
    onlyKeys(body, ["action", "branchId", "provider", "name", "delimiter", "amountMode", "decimalSeparator", "dateMode", "columns", "kindMapping", "matchWindowHours", "idempotencyKey"]);
    const provider = slug(body.provider, "Provedor"), fields = layoutFields(body, provider);
    return { action, branchId: positiveInteger(body.branchId, "Filial"), provider, ...fields, idempotencyKey: operationKey(body.idempotencyKey) };
  }
  if (action === "layout.update") {
    onlyKeys(body, ["action", "layoutId", "expectedVersion", "name", "delimiter", "amountMode", "decimalSeparator", "dateMode", "columns", "kindMapping", "matchWindowHours", "idempotencyKey"]);
    // Provider is immutable and validated again from the persisted layout in the service.
    const fields = layoutFields(body, "placeholder-provider");
    return { action, layoutId: identifier(body.layoutId, "Layout"), expectedVersion: version(body.expectedVersion), ...fields, idempotencyKey: operationKey(body.idempotencyKey) };
  }
  if (action === "layout.deactivate") {
    onlyKeys(body, ["action", "layoutId", "expectedVersion", "idempotencyKey"]);
    return { action, layoutId: identifier(body.layoutId, "Layout"), expectedVersion: version(body.expectedVersion), idempotencyKey: operationKey(body.idempotencyKey) };
  }
  if (action === "batch.import") {
    onlyKeys(body, ["action", "branchId", "layoutId", "csv", "idempotencyKey"]);
    if (typeof body.csv !== "string") throw new PosReconciliationAdminError("Arquivo CSV inválido.");
    const bytes = Buffer.byteLength(body.csv, "utf8");
    if (bytes < 1 || bytes > 768 * 1024) throw new PosReconciliationAdminError("Arquivo de conciliação vazio ou acima de 768 KiB.", 413);
    return { action, branchId: positiveInteger(body.branchId, "Filial"), layoutId: identifier(body.layoutId, "Layout"), csv: body.csv, idempotencyKey: operationKey(body.idempotencyKey) };
  }
  onlyKeys(body, ["action", "batchId", "expectedVersion", "idempotencyKey"]);
  return { action, batchId: identifier(body.batchId, "Lote"), expectedVersion: version(body.expectedVersion), idempotencyKey: operationKey(body.idempotencyKey) };
}

export function posReconciliationLayoutConfig(provider: string, value: LayoutFields): PosReconciliationLayoutConfig {
  return normalizePosReconciliationLayout({ provider, delimiter: value.delimiter, amountMode: value.amountMode, decimalSeparator: value.decimalSeparator, dateMode: value.dateMode, columns: value.columns, kindMapping: value.kindMapping });
}

export function hashPosReconciliationRequest(value: unknown) {
  return createHash("sha256").update(canonicalJson(value), "utf8").digest("hex");
}

export function reconciliationOperationKey(prefix: "import" | "reprocess" | "layout", idempotencyKey: string) {
  return `reconciliation:${prefix}:${createHash("sha256").update(operationKey(idempotencyKey), "utf8").digest("hex").slice(0, 48)}`;
}

function layoutFields(body: Record<string, unknown>, provider: string): LayoutFields {
  const columnsValue = record(body.columns, "Mapeamento de colunas"), kindValue = record(body.kindMapping, "Mapeamento de tipos");
  onlyKeys(columnsValue, [...POS_RECONCILIATION_FIELDS]);
  onlyKeys(kindValue, ["payment", "refund", "chargeback"]);
  const fields = {
    name: text(body.name, "Nome", 2, 120),
    delimiter: choice(body.delimiter, [",", ";", "\t"] as const, "Delimitador"),
    amountMode: choice(body.amountMode, ["integer_cents", "decimal"] as const, "Formato monetário"),
    decimalSeparator: choice(body.decimalSeparator, [".", ","] as const, "Separador decimal"),
    dateMode: choice(body.dateMode, ["iso8601", "epoch_millis"] as const, "Formato de data"),
    columns: Object.fromEntries(POS_RECONCILIATION_FIELDS.map(field => [field, text(columnsValue[field], `Coluna ${field}`, 1, 80)])) as Record<PosReconciliationField, string>,
    kindMapping: {
      payment: stringList(kindValue.payment, "Tipos de pagamento"),
      refund: stringList(kindValue.refund, "Tipos de estorno"),
      chargeback: stringList(kindValue.chargeback, "Tipos de chargeback"),
    },
    matchWindowHours: boundedInteger(body.matchWindowHours, 0, 168, "Janela de confronto"),
  };
  posReconciliationLayoutConfig(provider, fields);
  return fields;
}

function stringList(value: unknown, label: string) {
  if (!Array.isArray(value) || value.length < 1 || value.length > 10) throw new PosReconciliationAdminError(`${label} devem conter entre 1 e 10 valores.`);
  return value.map(item => text(item, label, 1, 40).toLowerCase());
}

function record(value: unknown, label: string) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new PosReconciliationAdminError(`${label} inválido.`);
  return value as Record<string, unknown>;
}

function onlyKeys(value: Record<string, unknown>, allowed: string[]) {
  const extra = Object.keys(value).find(key => !allowed.includes(key));
  if (extra) throw new PosReconciliationAdminError(`Campo não permitido: ${extra}.`, 400);
}

function positiveInteger(value: unknown, label: string) {
  const parsed = Number(value);
  if (typeof value !== "number" || !Number.isSafeInteger(parsed) || parsed <= 0 || parsed > 2_147_483_647) throw new PosReconciliationAdminError(`${label} inválida.`);
  return parsed;
}

function boundedInteger(value: unknown, minimum: number, maximum: number, label: string) {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < minimum || value > maximum) throw new PosReconciliationAdminError(`${label} deve estar entre ${minimum} e ${maximum}.`);
  return value;
}

function version(value: unknown) { return boundedInteger(value, 0, 2_147_483_647, "Versão esperada"); }

function identifier(value: unknown, label: string) {
  if (typeof value !== "string" || value.length < 1 || value.length > 100 || !/^[A-Za-z0-9_-]+$/.test(value)) throw new PosReconciliationAdminError(`${label} inválido.`);
  return value;
}

function operationKey(value: unknown) {
  if (typeof value !== "string" || value.length < 16 || value.length > 160 || !/^[A-Za-z0-9._:-]+$/.test(value)) throw new PosReconciliationAdminError("Chave de idempotência inválida.");
  return value;
}

function slug(value: unknown, label: string) {
  const normalized = text(value, label, 2, 80).toLowerCase();
  if (!/^[a-z0-9][a-z0-9._-]+$/.test(normalized)) throw new PosReconciliationAdminError(`${label} inválido.`);
  return normalized;
}

function text(value: unknown, label: string, minimum: number, maximum: number) {
  if (typeof value !== "string") throw new PosReconciliationAdminError(`${label} inválido.`);
  const normalized = value.trim();
  if (normalized.length < minimum || normalized.length > maximum || /[\u0000-\u001f\u007f]/.test(normalized)) throw new PosReconciliationAdminError(`${label} inválido.`);
  return normalized;
}

function choice<const T extends readonly string[]>(value: unknown, choices: T, label: string): T[number] {
  if (typeof value !== "string" || !choices.includes(value)) throw new PosReconciliationAdminError(`${label} inválida.`);
  return value as T[number];
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const recordValue = value as Record<string, unknown>;
  return `{${Object.keys(recordValue).sort().map(field => `${JSON.stringify(field)}:${canonicalJson(recordValue[field])}`).join(",")}}`;
}
