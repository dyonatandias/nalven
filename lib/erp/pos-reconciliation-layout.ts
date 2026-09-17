import { createHash } from "node:crypto";
import { PosDomainError } from "@/lib/erp/pos-domain";
import type { PosSettlementEntry, PosSettlementKind } from "@/lib/erp/pos-reconciliation";

export const POS_RECONCILIATION_IMPORT_LIMITS = Object.freeze({
  maximumBytes: 768 * 1024,
  maximumRows: 10_000,
  maximumErpTransactions: 20_000,
});

export const POS_RECONCILIATION_FIELDS = [
  "settlementId",
  "transactionId",
  "kind",
  "grossCents",
  "feeCents",
  "netCents",
  "occurredAt",
  "settledAt",
] as const;

export type PosReconciliationField = typeof POS_RECONCILIATION_FIELDS[number];

export type PosReconciliationLayoutConfig = {
  provider: string;
  delimiter: "," | ";" | "\t";
  amountMode: "integer_cents" | "decimal";
  decimalSeparator: "." | ",";
  dateMode: "iso8601" | "epoch_millis";
  columns: Readonly<Record<PosReconciliationField, string>>;
  kindMapping: Readonly<Record<PosSettlementKind, readonly string[]>>;
};

export type ParsedPosReconciliationFile = {
  digest: string;
  entries: readonly PosSettlementEntry[];
  periodStart: Date;
  periodEnd: Date;
};

export function normalizePosReconciliationLayout(value: PosReconciliationLayoutConfig): PosReconciliationLayoutConfig {
  const provider = normalizeProvider(value.provider);
  if (![",", ";", "\t"].includes(value.delimiter)) throw new PosDomainError("Delimitador do layout de conciliação inválido.");
  if (!(["integer_cents", "decimal"] as string[]).includes(value.amountMode)) throw new PosDomainError("Formato monetário do layout de conciliação inválido.");
  if (![".", ","].includes(value.decimalSeparator)) throw new PosDomainError("Separador decimal do layout de conciliação inválido.");
  if (!(["iso8601", "epoch_millis"] as string[]).includes(value.dateMode)) throw new PosDomainError("Formato de data do layout de conciliação inválido.");
  if (!value.columns || typeof value.columns !== "object" || Array.isArray(value.columns)) throw new PosDomainError("Mapeamento de colunas do layout inválido.");
  const columns = Object.fromEntries(POS_RECONCILIATION_FIELDS.map(field => [field, headerName(value.columns[field], field)])) as Record<PosReconciliationField, string>;
  if (new Set(Object.values(columns).map(item => item.toLowerCase())).size !== POS_RECONCILIATION_FIELDS.length) throw new PosDomainError("As colunas do layout de conciliação devem ser distintas.");
  if (!value.kindMapping || typeof value.kindMapping !== "object" || Array.isArray(value.kindMapping)) throw new PosDomainError("Mapeamento de tipos do layout inválido.");
  const kindMapping = {
    payment: kindAliases(value.kindMapping.payment, "pagamento"),
    refund: kindAliases(value.kindMapping.refund, "estorno"),
    chargeback: kindAliases(value.kindMapping.chargeback, "chargeback"),
  };
  const aliases = Object.values(kindMapping).flat();
  if (new Set(aliases).size !== aliases.length) throw new PosDomainError("Os valores de tipo do layout de conciliação devem ser distintos.");
  return Object.freeze({ provider, delimiter: value.delimiter, amountMode: value.amountMode, decimalSeparator: value.decimalSeparator, dateMode: value.dateMode, columns: Object.freeze(columns), kindMapping: Object.freeze(kindMapping) });
}

export function parseConfiguredPosSettlementCsv(source: string | Uint8Array, layoutInput: PosReconciliationLayoutConfig, now = new Date()): ParsedPosReconciliationFile {
  const layout = normalizePosReconciliationLayout(layoutInput);
  const bytes = typeof source === "string" ? new TextEncoder().encode(source) : source;
  if (!(bytes instanceof Uint8Array) || !bytes.length || bytes.byteLength > POS_RECONCILIATION_IMPORT_LIMITS.maximumBytes) throw new PosDomainError("Arquivo de conciliação vazio ou acima de 768 KiB.");
  const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes).replace(/^\uFEFF/, "");
  if (/\u0000/.test(text)) throw new PosDomainError("Arquivo de conciliação contém bytes inválidos.");
  const rows = parseCsv(text, layout.delimiter);
  if (rows.length < 2) throw new PosDomainError("Arquivo de conciliação não possui lançamentos.");
  if (rows.length - 1 > POS_RECONCILIATION_IMPORT_LIMITS.maximumRows) throw new PosDomainError("Arquivo de conciliação excede 10.000 lançamentos.");
  const headers = rows[0].map(item => item.trim().toLowerCase());
  if (new Set(headers).size !== headers.length) throw new PosDomainError("Cabeçalho do arquivo de conciliação contém colunas repetidas.");
  const indexes = Object.fromEntries(POS_RECONCILIATION_FIELDS.map(field => {
    const index = headers.indexOf(layout.columns[field].toLowerCase());
    if (index < 0) throw new PosDomainError(`Coluna ${layout.columns[field]} não encontrada no arquivo de conciliação.`);
    return [field, index];
  })) as Record<PosReconciliationField, number>;
  const entries = rows.slice(1).map((row, index) => settlementEntry(row, index + 2, indexes, layout, now));
  const periodStart = new Date(Math.min(...entries.map(entry => entry.occurredAt.valueOf())));
  const periodEnd = new Date(Math.max(...entries.map(entry => entry.occurredAt.valueOf())));
  return Object.freeze({
    digest: createHash("sha256").update(bytes).digest("hex"),
    entries: Object.freeze(entries),
    periodStart,
    periodEnd,
  });
}

export function posReconciliationReferenceHash(provider: string, transactionId: string) {
  return createHash("sha256").update(`${normalizeProvider(provider)}\u0000${boundedReference(transactionId, "Transação")}`, "utf8").digest("hex");
}

function settlementEntry(row: string[], line: number, indexes: Record<PosReconciliationField, number>, layout: PosReconciliationLayoutConfig, now: Date): PosSettlementEntry {
  const field = (name: PosReconciliationField) => row[indexes[name]] ?? "";
  const kindValue = field("kind").trim().toLowerCase();
  const kind = (Object.entries(layout.kindMapping) as Array<[PosSettlementKind, readonly string[]]>).find(([, aliases]) => aliases.includes(kindValue))?.[0];
  if (!kind) throw new PosDomainError(`Tipo inválido na linha ${line}.`);
  const entry = {
    provider: layout.provider,
    settlementId: boundedReference(field("settlementId"), `Liquidação da linha ${line}`),
    transactionId: boundedReference(field("transactionId"), `Transação da linha ${line}`),
    kind,
    grossCents: money(field("grossCents"), layout, false, `Bruto da linha ${line}`),
    feeCents: money(field("feeCents"), layout, true, `Taxa da linha ${line}`),
    netCents: signedMoney(field("netCents"), layout, `Líquido da linha ${line}`),
    occurredAt: instant(field("occurredAt"), layout.dateMode, `Ocorrência da linha ${line}`, now),
    settledAt: instant(field("settledAt"), layout.dateMode, `Liquidação da linha ${line}`, now),
  } satisfies PosSettlementEntry;
  const expectedNet = kind === "payment" ? entry.grossCents - entry.feeCents : -(entry.grossCents + entry.feeCents);
  if (entry.netCents !== expectedNet) throw new PosDomainError(`Equação bruto/taxa/líquido inválida para a linha ${line}.`);
  if (entry.settledAt < entry.occurredAt) throw new PosDomainError(`Liquidação anterior à ocorrência na linha ${line}.`);
  return Object.freeze(entry);
}

function parseCsv(source: string, delimiter: string) {
  const rows: string[][] = [];
  let row: string[] = [], field = "", quoted = false, quoteClosed = false;
  for (let index = 0; index < source.length; index += 1) {
    const character = source[index];
    if (quoted) {
      if (character === '"' && source[index + 1] === '"') { field += '"'; index += 1; }
      else if (character === '"') { quoted = false; quoteClosed = true; }
      else field += character;
    } else if (character === '"') {
      if (field.length || quoteClosed) throw new PosDomainError("Aspas inválidas no arquivo de conciliação.");
      quoted = true;
    } else if (character === delimiter) { row.push(field); field = ""; quoteClosed = false; }
    else if (character === "\n") { row.push(field.replace(/\r$/, "")); rows.push(row); row = []; field = ""; quoteClosed = false; }
    else {
      if (quoteClosed && character !== "\r") throw new PosDomainError("Conteúdo após aspas fechadas no arquivo de conciliação.");
      field += character;
    }
  }
  if (quoted) throw new PosDomainError("Campo CSV não terminado no arquivo de conciliação.");
  if (field.length || row.length) { row.push(field.replace(/\r$/, "")); rows.push(row); }
  return rows.filter((candidate, index) => !(index === rows.length - 1 && candidate.length === 1 && candidate[0] === ""));
}

function money(value: string, layout: PosReconciliationLayoutConfig, allowZero: boolean, label: string) {
  const cents = parseMoney(value, layout, false, label);
  if (cents < 0 || !allowZero && cents === 0) throw new PosDomainError(`${label} inválido.`);
  return cents;
}

function signedMoney(value: string, layout: PosReconciliationLayoutConfig, label: string) {
  return parseMoney(value, layout, true, label);
}

function parseMoney(value: string, layout: PosReconciliationLayoutConfig, signed: boolean, label: string) {
  const normalized = value.trim();
  if (layout.amountMode === "integer_cents") {
    const pattern = signed ? /^-?\d{1,16}$/ : /^\d{1,16}$/;
    if (!pattern.test(normalized)) throw new PosDomainError(`${label} inválido.`);
    const result = Number(normalized);
    if (!Number.isSafeInteger(result) || Math.abs(result) > 9_000_000_000_000_000) throw new PosDomainError(`${label} inválido.`);
    return result;
  }
  const separator = layout.decimalSeparator === "." ? "\\." : ",";
  const pattern = new RegExp(`^${signed ? "-?" : ""}\\d{1,13}(?:${separator}\\d{1,2})?$`);
  if (!pattern.test(normalized)) throw new PosDomainError(`${label} inválido.`);
  const [whole, fraction = ""] = normalized.replace(layout.decimalSeparator, ".").split(".");
  const negative = whole.startsWith("-");
  const absoluteWhole = BigInt(negative ? whole.slice(1) : whole);
  const cents = absoluteWhole * BigInt(100) + BigInt(fraction.padEnd(2, "0"));
  const signedCents = negative ? -cents : cents;
  const result = Number(signedCents);
  if (!Number.isSafeInteger(result) || Math.abs(result) > 9_000_000_000_000_000) throw new PosDomainError(`${label} inválido.`);
  return result;
}

function instant(value: string, mode: PosReconciliationLayoutConfig["dateMode"], label: string, now: Date) {
  const normalized = value.trim();
  let parsed: Date;
  if (mode === "epoch_millis") {
    if (!/^\d{13}$/.test(normalized)) throw new PosDomainError(`${label} inválida.`);
    parsed = new Date(Number(normalized));
  } else {
    if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(normalized)) throw new PosDomainError(`${label} inválida.`);
    parsed = new Date(normalized);
  }
  if (!Number.isFinite(parsed.valueOf()) || parsed.valueOf() > now.valueOf() + 5 * 60_000) throw new PosDomainError(`${label} inválida.`);
  return parsed;
}

function normalizeProvider(value: unknown) {
  const normalized = String(value ?? "").trim().toLowerCase();
  if (normalized.length < 2 || normalized.length > 80 || !/^[a-z0-9][a-z0-9._-]+$/.test(normalized)) throw new PosDomainError("Identificador do provedor inválido.");
  return normalized;
}

function boundedReference(value: unknown, label: string) {
  if (typeof value !== "string") throw new PosDomainError(`${label} inválida.`);
  const normalized = value.trim();
  if (!normalized || normalized.length > 160 || /[\u0000-\u001f\u007f]/.test(normalized)) throw new PosDomainError(`${label} inválida.`);
  return normalized;
}

function headerName(value: unknown, field: string) {
  if (typeof value !== "string") throw new PosDomainError(`Coluna ${field} inválida.`);
  const normalized = value.trim();
  if (!normalized || normalized.length > 80 || /[\u0000-\u001f\u007f]/.test(normalized)) throw new PosDomainError(`Coluna ${field} inválida.`);
  return normalized;
}

function kindAliases(value: unknown, label: string) {
  if (!Array.isArray(value) || value.length < 1 || value.length > 10) throw new PosDomainError(`Mapeamento de ${label} inválido.`);
  const aliases = value.map(item => {
    if (typeof item !== "string") throw new PosDomainError(`Mapeamento de ${label} inválido.`);
    const normalized = item.trim().toLowerCase();
    if (!normalized || normalized.length > 40 || /[\u0000-\u001f\u007f]/.test(normalized)) throw new PosDomainError(`Mapeamento de ${label} inválido.`);
    return normalized;
  });
  if (new Set(aliases).size !== aliases.length) throw new PosDomainError(`Mapeamento de ${label} contém valores repetidos.`);
  return Object.freeze(aliases);
}
