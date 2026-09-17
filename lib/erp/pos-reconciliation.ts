import { createHash } from "node:crypto";
import { PosDomainError } from "@/lib/erp/pos-domain";

export type PosSettlementKind = "payment" | "refund" | "chargeback";

export type PosSettlementEntry = {
  provider: string;
  settlementId: string;
  transactionId: string;
  kind: PosSettlementKind;
  grossCents: number;
  feeCents: number;
  netCents: number;
  occurredAt: Date;
  settledAt: Date;
};

export type PosReconciliationTransaction = {
  provider: string;
  transactionId: string;
  kind: "payment" | "refund";
  amountCents: number;
  status: string;
};

export type PosReconciliationIssue = {
  code: "duplicate_settlement" | "duplicate_transaction" | "missing_provider_entry" | "unexpected_provider_entry" | "kind_mismatch" | "amount_mismatch" | "non_final_erp_state";
  provider: string;
  transactionId: string;
  detail: string;
};

const SETTLEMENT_HEADER = ["provider", "settlement_id", "transaction_id", "kind", "gross_cents", "fee_cents", "net_cents", "occurred_at", "settled_at"] as const;
const MAX_FILE_BYTES = 5 * 1024 * 1024;
const MAX_ROWS = 50_000;
const FINAL_ERP_STATES = new Set(["captured", "paid", "partially_refunded", "refunded"]);

export function parsePosSettlementCsv(source: string | Uint8Array, now = new Date()) {
  const bytes = typeof source === "string" ? new TextEncoder().encode(source) : source;
  if (!(bytes instanceof Uint8Array) || !bytes.length || bytes.byteLength > MAX_FILE_BYTES) throw new PosDomainError("Arquivo de liquidação vazio ou acima de 5 MiB.");
  const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes).replace(/^\uFEFF/, "");
  if (/\u0000/.test(text)) throw new PosDomainError("Arquivo de liquidação contém bytes inválidos.");
  const rows = parseCsv(text);
  if (rows.length < 2) throw new PosDomainError("Arquivo de liquidação não possui lançamentos.");
  if (rows.length - 1 > MAX_ROWS) throw new PosDomainError("Arquivo de liquidação excede 50.000 lançamentos.");
  if (rows[0].length !== SETTLEMENT_HEADER.length || rows[0].some((value, index) => value.trim().toLowerCase() !== SETTLEMENT_HEADER[index])) throw new PosDomainError("Cabeçalho canônico de liquidação inválido.");
  const entries = rows.slice(1).map((row, index) => settlementEntry(row, index + 2, now));
  return Object.freeze({ digest: createHash("sha256").update(bytes).digest("hex"), entries: Object.freeze(entries) });
}

export function reconcilePosSettlements(erpTransactions: ReadonlyArray<PosReconciliationTransaction>, providerEntries: ReadonlyArray<PosSettlementEntry>) {
  if (!Array.isArray(erpTransactions) || !Array.isArray(providerEntries)) throw new PosDomainError("Entradas de conciliação inválidas.");
  const issues: PosReconciliationIssue[] = [];
  const erpByKey = new Map<string, PosReconciliationTransaction>();
  const providerByKey = new Map<string, PosSettlementEntry>();

  for (const transaction of erpTransactions) {
    validateErpTransaction(transaction);
    const key = transactionKey(transaction.provider, transaction.transactionId);
    if (erpByKey.has(key)) issues.push(issue("duplicate_transaction", transaction, "Transação repetida no recorte do ERP."));
    else erpByKey.set(key, transaction);
  }
  const settlementKeys = new Set<string>();
  for (const entry of providerEntries) {
    validateSettlementEntry(entry);
    const settlementKey = `${providerKey(entry.provider)}:${entry.settlementId}`;
    if (settlementKeys.has(settlementKey)) issues.push(issue("duplicate_settlement", entry, "Lançamento repetido no arquivo do provedor."));
    settlementKeys.add(settlementKey);
    const key = transactionKey(entry.provider, entry.transactionId);
    if (providerByKey.has(key)) issues.push(issue("duplicate_transaction", entry, "Referência de transação repetida no arquivo do provedor."));
    else providerByKey.set(key, entry);
  }

  let matched = 0;
  for (const [key, transaction] of erpByKey) {
    const entry = providerByKey.get(key);
    if (!entry) {
      issues.push(issue("missing_provider_entry", transaction, "Transação final do ERP ausente no arquivo do provedor."));
      continue;
    }
    providerByKey.delete(key);
    matched += 1;
    if (!FINAL_ERP_STATES.has(transaction.status)) issues.push(issue("non_final_erp_state", transaction, `Estado ${transaction.status} não é final para liquidação.`));
    if (entry.kind === "chargeback" || entry.kind !== transaction.kind) issues.push(issue("kind_mismatch", transaction, `ERP=${transaction.kind}; provedor=${entry.kind}.`));
    if (entry.grossCents !== transaction.amountCents) issues.push(issue("amount_mismatch", transaction, `ERP=${transaction.amountCents}; provedor=${entry.grossCents}.`));
  }
  for (const entry of providerByKey.values()) issues.push(issue("unexpected_provider_entry", entry, `Lançamento ${entry.kind} não possui referência no recorte do ERP.`));

  const totals = providerEntries.reduce((sum, entry) => ({
    grossCents: safeCentTotal(sum.grossCents, entry.kind === "payment" ? entry.grossCents : -entry.grossCents),
    feeCents: safeCentTotal(sum.feeCents, entry.feeCents),
    netCents: safeCentTotal(sum.netCents, entry.netCents),
  }), { grossCents: 0, feeCents: 0, netCents: 0 });
  return Object.freeze({ matched, issueCount: issues.length, productionBlocking: issues.length > 0, totals: Object.freeze(totals), issues: Object.freeze(issues) });
}

function settlementEntry(row: string[], line: number, now: Date): PosSettlementEntry {
  if (row.length !== SETTLEMENT_HEADER.length) throw new PosDomainError(`Linha ${line} da liquidação possui número de colunas inválido.`);
  const kind = row[3].trim().toLowerCase();
  if (!(["payment", "refund", "chargeback"] as string[]).includes(kind)) throw new PosDomainError(`Tipo inválido na linha ${line}.`);
  const entry = {
    provider: bounded(row[0], `Provedor da linha ${line}`, 2, 80).toLowerCase(),
    settlementId: bounded(row[1], `Liquidação da linha ${line}`, 1, 160),
    transactionId: bounded(row[2], `Transação da linha ${line}`, 1, 160),
    kind: kind as PosSettlementKind,
    grossCents: integer(row[4], `Bruto da linha ${line}`, false),
    feeCents: integer(row[5], `Taxa da linha ${line}`, true),
    netCents: signedInteger(row[6], `Líquido da linha ${line}`),
    occurredAt: instant(row[7], `Ocorrência da linha ${line}`, now),
    settledAt: instant(row[8], `Liquidação da linha ${line}`, now),
  };
  validateSettlementEntry(entry);
  return Object.freeze(entry);
}

function validateSettlementEntry(entry: PosSettlementEntry) {
  providerKey(entry.provider);
  bounded(entry.settlementId, "Identificador da liquidação", 1, 160);
  bounded(entry.transactionId, "Identificador da transação", 1, 160);
  if (!["payment", "refund", "chargeback"].includes(entry.kind)) throw new PosDomainError("Tipo do lançamento de liquidação inválido.");
  positiveCents(entry.grossCents, "Valor bruto da liquidação");
  nonNegativeCents(entry.feeCents, "Taxa da liquidação");
  if (!Number.isSafeInteger(entry.netCents) || Math.abs(entry.netCents) > 9_000_000_000_000_000) throw new PosDomainError("Valor líquido da liquidação inválido.");
  if (!(entry.occurredAt instanceof Date) || !Number.isFinite(entry.occurredAt.valueOf()) || !(entry.settledAt instanceof Date) || !Number.isFinite(entry.settledAt.valueOf())) throw new PosDomainError("Datas da liquidação inválidas.");
  const expectedNet = entry.kind === "payment" ? entry.grossCents - entry.feeCents : -(entry.grossCents + entry.feeCents);
  if (entry.netCents !== expectedNet) throw new PosDomainError(`Equação bruto/taxa/líquido inválida para a transação ${entry.transactionId}.`);
  if (entry.settledAt.valueOf() < entry.occurredAt.valueOf()) throw new PosDomainError(`Liquidação anterior à ocorrência para a transação ${entry.transactionId}.`);
}

function validateErpTransaction(value: PosReconciliationTransaction) {
  providerKey(value.provider);
  bounded(value.transactionId, "Transação do ERP", 1, 160);
  if (!["payment", "refund"].includes(value.kind)) throw new PosDomainError("Tipo de transação do ERP inválido.");
  if (!Number.isSafeInteger(value.amountCents) || value.amountCents <= 0 || value.amountCents > 9_000_000_000_000_000) throw new PosDomainError("Valor da transação do ERP inválido.");
  bounded(value.status, "Estado da transação do ERP", 1, 60);
}

function parseCsv(source: string) {
  const rows: string[][] = [];
  let row: string[] = [], field = "", quoted = false, quoteClosed = false;
  for (let index = 0; index < source.length; index += 1) {
    const character = source[index];
    if (quoted) {
      if (character === '"' && source[index + 1] === '"') { field += '"'; index += 1; }
      else if (character === '"') { quoted = false; quoteClosed = true; }
      else field += character;
    } else if (character === '"') {
      if (field.length || quoteClosed) throw new PosDomainError("Aspas inválidas no arquivo de liquidação.");
      quoted = true;
    } else if (character === ",") { row.push(field); field = ""; quoteClosed = false; }
    else if (character === "\n") { row.push(field.replace(/\r$/, "")); rows.push(row); row = []; field = ""; quoteClosed = false; }
    else {
      if (quoteClosed && character !== "\r") throw new PosDomainError("Conteúdo após aspas fechadas no arquivo de liquidação.");
      field += character;
    }
  }
  if (quoted) throw new PosDomainError("Campo CSV não terminado no arquivo de liquidação.");
  if (field.length || row.length) { row.push(field.replace(/\r$/, "")); rows.push(row); }
  return rows.filter((candidate, index) => !(index === rows.length - 1 && candidate.length === 1 && candidate[0] === ""));
}

function issue(code: PosReconciliationIssue["code"], value: { provider: string; transactionId: string }, detail: string): PosReconciliationIssue {
  return { code, provider: providerKey(value.provider), transactionId: bounded(value.transactionId, "Referência de conciliação", 1, 160), detail };
}

function transactionKey(provider: string, transactionId: string) {
  return `${providerKey(provider)}:${bounded(transactionId, "Referência de conciliação", 1, 160)}`;
}

function providerKey(value: string) {
  const normalized = bounded(value, "Provedor", 2, 80).toLowerCase();
  if (!/^[a-z0-9][a-z0-9._-]+$/.test(normalized)) throw new PosDomainError("Identificador do provedor inválido.");
  return normalized;
}

function bounded(value: unknown, label: string, minimum: number, maximum: number) {
  if (typeof value !== "string") throw new PosDomainError(`${label} inválido.`);
  const normalized = value.trim();
  if (normalized.length < minimum || normalized.length > maximum || /[\u0000-\u001f\u007f]/.test(normalized)) throw new PosDomainError(`${label} inválido.`);
  return normalized;
}

function integer(value: string, label: string, allowZero: boolean) {
  if (!/^\d{1,16}$/.test(value.trim())) throw new PosDomainError(`${label} inválido.`);
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed > 9_000_000_000_000_000 || !allowZero && parsed === 0) throw new PosDomainError(`${label} inválido.`);
  return parsed;
}

function signedInteger(value: string, label: string) {
  if (!/^-?\d{1,16}$/.test(value.trim())) throw new PosDomainError(`${label} inválido.`);
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || Math.abs(parsed) > 9_000_000_000_000_000) throw new PosDomainError(`${label} inválido.`);
  return parsed;
}

function positiveCents(value: number, label: string) {
  if (!Number.isSafeInteger(value) || value <= 0 || value > 9_000_000_000_000_000) throw new PosDomainError(`${label} inválido.`);
}

function nonNegativeCents(value: number, label: string) {
  if (!Number.isSafeInteger(value) || value < 0 || value > 9_000_000_000_000_000) throw new PosDomainError(`${label} inválido.`);
}

function safeCentTotal(current: number, increment: number) {
  const total = current + increment;
  if (!Number.isSafeInteger(total)) throw new PosDomainError("Totais do arquivo de liquidação excedem o limite inteiro seguro.");
  return total;
}

function instant(value: string, label: string, now: Date) {
  const parsed = new Date(value.trim());
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(value.trim()) || !Number.isFinite(parsed.valueOf()) || parsed.valueOf() > now.valueOf() + 5 * 60_000) throw new PosDomainError(`${label} inválido.`);
  return parsed;
}
