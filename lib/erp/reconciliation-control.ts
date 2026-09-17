import { createHash } from "node:crypto";

export class ReconciliationControlError extends Error {
  constructor(message: string, readonly status = 400) { super(message); }
}

export const RECONCILIATION_PAGE_SIZES = [25, 50, 100] as const;
export const RECONCILIATION_CATEGORIES = ["Vendas", "Serviços", "Fornecedores", "Impostos", "Folha", "Logística", "Tarifas bancárias", "Transferências", "Investimentos", "Outros"] as const;

export function parseReconciliationQuery(params: URLSearchParams, now = new Date()) {
  const today = utcDay(now);
  const initial = new Date(today.valueOf() - 44 * 86_400_000);
  const from = dateValue(params.get("from"), initial, "Data inicial inválida.");
  const toDay = dateValue(params.get("to"), today, "Data final inválida.");
  if (from > toDay) throw new ReconciliationControlError("A data inicial não pode ser posterior à data final.");
  if ((toDay.valueOf() - from.valueOf()) / 86_400_000 > 731) throw new ReconciliationControlError("Consulte no máximo 732 dias por vez.");
  const status = String(params.get("status") || "pending");
  if (!new Set(["pending", "reconciled", "ignored", "all"]).has(status)) throw new ReconciliationControlError("Situação inválida.");
  const direction = String(params.get("direction") || "all");
  if (!new Set(["credit", "debit", "all"]).has(direction)) throw new ReconciliationControlError("Direção inválida.");
  const format = String(params.get("format") || "json");
  if (!new Set(["json", "csv"]).has(format)) throw new ReconciliationControlError("Formato inválido.");
  const pageSize = boundedInteger(params.get("pageSize"), 50, 1, 100, "Quantidade por página inválida.");
  if (!RECONCILIATION_PAGE_SIZES.includes(pageSize as (typeof RECONCILIATION_PAGE_SIZES)[number]))
    throw new ReconciliationControlError("Use 25, 50 ou 100 movimentos por página.");
  const search = String(params.get("search") || "").trim();
  if (search.length > 100) throw new ReconciliationControlError("A busca deve ter no máximo 100 caracteres.");
  return { search, status, direction, accountId: optionalId(params.get("accountId"), "Conta inválida."), from,
    to: new Date(toDay.valueOf() + 86_400_000 - 1), page: boundedInteger(params.get("page"), 1, 1, 100_000, "Página inválida."),
    pageSize, format: format as "json" | "csv" };
}

export type ParsedStatementRow = { externalId: string; occurredAt: Date; description: string; amountCents: number;
  bankReference: string | null; documentNumber: string | null };
export type ParsedStatement = { format: "csv" | "ofx"; fileSize: number; rowCount: number; internalDuplicates: number;
  rows: ParsedStatementRow[]; periodStart: Date; periodEnd: Date; totalCreditCents: number; totalDebitCents: number };

export function parseStatementDocument(content: unknown, fileName: unknown): ParsedStatement {
  const source = String(content || "").replace(/^\uFEFF/, "");
  const name = requiredText(fileName, "Arquivo", 1, 180);
  const fileSize = new TextEncoder().encode(source).byteLength;
  if (fileSize < 5 || fileSize > 2_000_000) throw new ReconciliationControlError("O arquivo deve possuir entre 5 bytes e 2 MB.");
  const format = /\.ofx$/i.test(name) || /<(?:OFX|STMTTRN)>/i.test(source) ? "ofx" : "csv";
  const rawRows = format === "ofx" ? parseOfx(source) : parseCsv(source);
  if (!rawRows.length || rawRows.length > 5_000) throw new ReconciliationControlError("O extrato deve possuir de 1 a 5.000 movimentos.");
  const seen = new Map<string, string>();
  const rows: ParsedStatementRow[] = [];
  let internalDuplicates = 0;
  for (const row of rawRows) {
    const fingerprint = rowFingerprint(row);
    const prior = seen.get(row.externalId);
    if (prior) {
      if (prior !== fingerprint) throw new ReconciliationControlError(`O identificador ${row.externalId} aparece com dados diferentes no arquivo.`);
      internalDuplicates += 1; continue;
    }
    seen.set(row.externalId, fingerprint); rows.push(row);
  }
  if (!rows.length) throw new ReconciliationControlError("O arquivo contém somente movimentos duplicados.");
  const timestamps = rows.map((row) => row.occurredAt.valueOf());
  const totalCreditCents = rows.reduce((sum, row) => sum + Math.max(row.amountCents, 0), 0);
  const totalDebitCents = rows.reduce((sum, row) => sum + Math.max(-row.amountCents, 0), 0);
  if (totalCreditCents > 2_000_000_000 || totalDebitCents > 2_000_000_000)
    throw new ReconciliationControlError("O total de entradas ou saídas do arquivo excede o limite monetário suportado.");
  return { format, fileSize, rowCount: rawRows.length, internalDuplicates, rows,
    periodStart: new Date(Math.min(...timestamps)), periodEnd: new Date(Math.max(...timestamps)),
    totalCreditCents, totalDebitCents };
}

export function reconciliationInput(value: unknown) {
  const input = object(value);
  const transactionId = requiredId(input.transactionId, "Movimento inválido.");
  const requestId = idempotencyKey(input.requestId);
  const reason = requiredText(input.reason, "Justificativa", 8, 500);
  const category = optionalText(input.category, 80);
  const rawAllocations = Array.isArray(input.allocations) ? input.allocations : input.titleId ? [{ titleId: input.titleId, amount: input.amount }] : [];
  if (rawAllocations.length > 10) throw new ReconciliationControlError("Use no máximo 10 títulos em uma conciliação.");
  const allocations = rawAllocations.map((value) => { const item = object(value); return {
    titleId: requiredId(item.titleId, "Título inválido."), amountCents: item.amount === undefined || item.amount === null || item.amount === "" ? null : moneyCents(item.amount),
  }; });
  if (new Set(allocations.map((item) => item.titleId)).size !== allocations.length)
    throw new ReconciliationControlError("Um título não pode aparecer duas vezes na mesma conciliação.");
  if (!allocations.length && (!category || !RECONCILIATION_CATEGORIES.includes(category as (typeof RECONCILIATION_CATEGORIES)[number])))
    throw new ReconciliationControlError("Selecione uma categoria para a conciliação sem título.");
  return { transactionId, requestId, reason, category, allocations };
}

export function resolutionInput(value: unknown, label: string) {
  const input = object(value);
  return { transactionId: requiredId(input.transactionId, "Movimento inválido."), requestId: idempotencyKey(input.requestId),
    reason: requiredText(input.reason, label, 8, 500) };
}

export function autoReconciliationInput(value: unknown) {
  const input = object(value);
  return { accountId: optionalId(input.accountId, "Conta inválida."), requestId: idempotencyKey(input.requestId),
    limit: boundedInteger(input.limit === undefined ? null : String(input.limit), 25, 1, 50, "Limite de automação inválido.") };
}

export type MatchTransaction = { amountCents: number; occurredAt: Date; description: string; documentNumber?: string | null };
export type MatchTitle = { id: number; type: string; status: string; amount: number; paidAmount: number; dueAt: Date; description: string;
  documentNumber: string | null; customer: { name: string; tradeName: string | null } | null; supplier: { name: string; tradeName: string | null } | null };

export function titleSuggestions(transaction: MatchTransaction, titles: MatchTitle[]) {
  const requiredType = transaction.amountCents > 0 ? "receivable" : "payable";
  const target = Math.abs(transaction.amountCents);
  const transactionTokens = tokens(`${transaction.description} ${transaction.documentNumber || ""}`);
  const matches = titles.flatMap((title) => {
    if (title.type !== requiredType) return [];
    const remainingCents = Math.round((title.amount - title.paidAmount) * 100);
    if (remainingCents < target) return [];
    const reasons: string[] = [];
    let score = 0;
    const exact = remainingCents === target;
    if (exact) { score += 58; reasons.push("valor exato"); } else { score += 24; reasons.push("saldo comporta o movimento"); }
    const days = Math.abs(Math.round((title.dueAt.valueOf() - transaction.occurredAt.valueOf()) / 86_400_000));
    if (days <= 2) { score += 22; reasons.push("data até 2 dias"); }
    else if (days <= 7) { score += 14; reasons.push("data até 7 dias"); }
    else if (days <= 30) { score += 6; reasons.push("data até 30 dias"); }
    const party = title.customer?.tradeName || title.customer?.name || title.supplier?.tradeName || title.supplier?.name || "";
    const titleTokens = tokens(`${title.description} ${title.documentNumber || ""} ${party}`);
    const shared = [...transactionTokens].filter((token) => titleTokens.has(token)).length;
    if (shared) { score += Math.min(15, shared * 5); reasons.push(`${shared} termo(s) em comum`); }
    const normalizedDocument = normalize(title.documentNumber || "");
    if (normalizedDocument.length >= 4 && normalize(transaction.description).includes(normalizedDocument)) {
      score += 15; reasons.push("documento identificado");
    }
    return [{ title, remainingCents, confidence: Math.min(99, score), exact, days, reasons, party }];
  }).sort((left, right) => right.confidence - left.confidence || left.days - right.days || left.title.dueAt.valueOf() - right.title.dueAt.valueOf());
  return matches.slice(0, 5).map((match, index) => ({ ...match,
    recommended: index === 0 && match.exact && match.confidence >= 80 &&
      (matches.length === 1 || match.confidence - (matches[1]?.confidence || 0) >= 10) }));
}

export function reconciliationSummary(transactions: Array<{ status: string; amountCents: number }>, automatable: number) {
  const pending = transactions.filter((item) => item.status === "pending");
  const reconciled = transactions.filter((item) => item.status === "reconciled");
  const ignored = transactions.filter((item) => item.status === "ignored");
  const total = transactions.length;
  return { pending: pending.length, pendingCents: pending.reduce((sum, item) => sum + Math.abs(item.amountCents), 0),
    pendingCreditsCents: pending.reduce((sum, item) => sum + Math.max(item.amountCents, 0), 0),
    pendingDebitsCents: pending.reduce((sum, item) => sum + Math.max(-item.amountCents, 0), 0),
    reconciled: reconciled.length, reconciledCents: reconciled.reduce((sum, item) => sum + Math.abs(item.amountCents), 0),
    ignored: ignored.length, automation: automatable, rate: total ? Math.round(reconciled.length / total * 10_000) / 100 : 0,
    creditsCents: transactions.reduce((sum, item) => sum + Math.max(item.amountCents, 0), 0),
    debitsCents: transactions.reduce((sum, item) => sum + Math.max(-item.amountCents, 0), 0) };
}

export function reconciliationTrend(transactions: Array<{ occurredAt: Date; status: string; amountCents: number }>) {
  const values = new Map<string, { date: string; creditsCents: number; debitsCents: number; pending: number; reconciled: number; ignored: number }>();
  for (const transaction of transactions) {
    const key = transaction.occurredAt.toISOString().slice(0, 10);
    const item = values.get(key) || { date: key, creditsCents: 0, debitsCents: 0, pending: 0, reconciled: 0, ignored: 0 };
    if (transaction.amountCents > 0) item.creditsCents += transaction.amountCents; else item.debitsCents += -transaction.amountCents;
    if (transaction.status === "pending") item.pending += 1;
    else if (transaction.status === "reconciled") item.reconciled += 1; else item.ignored += 1;
    values.set(key, item);
  }
  return [...values.values()].sort((left, right) => left.date.localeCompare(right.date));
}

export function reconciliationCsv(transactions: Array<{ occurredAt: Date; accountCode: string; accountName: string; description: string;
  externalId: string; documentNumber: string | null; amountCents: number; status: string; resolutionType: string | null;
  category: string | null; matchedDocuments: string; reconciledBy: string | null; reconciledAt: Date | null }>) {
  const header = ["Data", "Código da conta", "Conta", "Descrição", "ID externo", "Documento", "Valor", "Situação", "Resolução", "Categoria", "Títulos", "Responsável", "Resolvido em"];
  const rows = transactions.map((item) => [item.occurredAt.toISOString().slice(0, 10), item.accountCode, item.accountName, item.description,
    item.externalId, item.documentNumber || "", decimal(item.amountCents), statusLabel(item.status), item.resolutionType || "", item.category || "",
    item.matchedDocuments, item.reconciledBy || "", item.reconciledAt?.toISOString() || ""]);
  return `\uFEFF${[header, ...rows].map((row) => row.map(csvCell).join(";")).join("\r\n")}`;
}

export function operationHash(action: string, transactionId: number, payload: object) {
  return createHash("sha256").update(JSON.stringify({ action, transactionId, ...canonical(payload) })).digest("hex");
}

export function centsAmount(cents: number) { return cents / 100; }

function parseCsv(source: string): ParsedStatementRow[] {
  const firstLine = source.split(/\r?\n/, 1)[0] || "";
  const delimiter = delimiterCount(firstLine, ";") >= delimiterCount(firstLine, ",") ? ";" : ",";
  const table = csvTable(source, delimiter);
  if (table.length < 2 || table.length > 5_001) throw new ReconciliationControlError("O CSV deve conter cabeçalho e até 5.000 movimentos.");
  const headers = table[0].map(headerKey);
  const positions = { date: headerPosition(headers, ["date", "data", "dtposted"]), description: headerPosition(headers, ["description", "descricao", "historico", "memo"]),
    amount: headerPosition(headers, ["amount", "valor", "trnamt"]), externalId: headerPosition(headers, ["externalid", "idexterno", "fitid", "id"], false),
    reference: headerPosition(headers, ["bankreference", "referencia", "refnum", "tipo"], false), document: headerPosition(headers, ["documentnumber", "documento", "checknum", "numero"], false) };
  const occurrences = new Map<string, number>();
  return table.slice(1).filter((row) => row.some((value) => value.trim())).map((row, index) => {
    if (row.length > 30) throw new ReconciliationControlError(`Linha ${index + 2} possui colunas demais.`);
    const occurredAt = statementDate(row[positions.date], index + 2);
    const description = requiredText(row[positions.description], `Descrição da linha ${index + 2}`, 2, 300);
    const amountCents = statementMoney(row[positions.amount], index + 2);
    const bankReference = positions.reference < 0 ? null : optionalText(row[positions.reference], 120);
    const documentNumber = positions.document < 0 ? null : optionalText(row[positions.document], 120);
    const sourceId = positions.externalId < 0 ? "" : String(row[positions.externalId] || "").trim();
    const base = `${occurredAt.toISOString().slice(0, 10)}|${amountCents}|${normalize(description)}|${documentNumber || ""}`;
    const occurrence = (occurrences.get(base) || 0) + 1; occurrences.set(base, occurrence);
    const externalId = sourceId || `AUTO-${createHash("sha256").update(`${base}|${occurrence}`).digest("hex").slice(0, 32)}`;
    if (!/^[\p{L}\p{N}._:/-]{1,120}$/u.test(externalId)) throw new ReconciliationControlError(`Identificador externo inválido na linha ${index + 2}.`);
    return { externalId, occurredAt, description, amountCents, bankReference, documentNumber };
  });
}

function parseOfx(source: string): ParsedStatementRow[] {
  const blocks = source.match(/<STMTTRN>[\s\S]*?(?=<STMTTRN>|<\/BANKTRANLIST>|<\/STMTTRN>|$)/gi) || [];
  if (!blocks.length || blocks.length > 5_000) throw new ReconciliationControlError("O OFX deve conter de 1 a 5.000 movimentos STMTTRN.");
  const occurrences = new Map<string, number>();
  return blocks.map((block, index) => {
    const line = index + 1;
    const occurredAt = statementDate(ofxTag(block, "DTPOSTED").slice(0, 8), line, true);
    const amountCents = statementMoney(ofxTag(block, "TRNAMT"), line);
    const description = requiredText(decodeEntities(ofxTag(block, "MEMO") || ofxTag(block, "NAME") || ofxTag(block, "TRNTYPE")), `Descrição OFX ${line}`, 2, 300);
    const bankReference = optionalText(decodeEntities(ofxTag(block, "TRNTYPE") || ofxTag(block, "REFNUM")), 120);
    const documentNumber = optionalText(decodeEntities(ofxTag(block, "CHECKNUM") || ofxTag(block, "REFNUM")), 120);
    const fitId = decodeEntities(ofxTag(block, "FITID")).trim();
    const base = `${occurredAt.toISOString().slice(0, 10)}|${amountCents}|${normalize(description)}|${documentNumber || ""}`;
    const occurrence = (occurrences.get(base) || 0) + 1; occurrences.set(base, occurrence);
    const externalId = fitId || `OFX-${createHash("sha256").update(`${base}|${occurrence}`).digest("hex").slice(0, 32)}`;
    if (!/^[\p{L}\p{N}._:/-]{1,120}$/u.test(externalId)) throw new ReconciliationControlError(`FITID inválido no movimento OFX ${line}.`);
    return { externalId, occurredAt, description, amountCents, bankReference, documentNumber };
  });
}

function csvTable(source: string, delimiter: string) {
  const rows: string[][] = []; let row: string[] = []; let field = ""; let quoted = false;
  for (let index = 0; index < source.length; index += 1) {
    const character = source[index];
    if (quoted) {
      if (character === '"' && source[index + 1] === '"') { field += '"'; index += 1; }
      else if (character === '"') quoted = false; else field += character;
    } else if (character === '"' && !field) quoted = true;
    else if (character === delimiter) { row.push(field); field = ""; }
    else if (character === "\n" || character === "\r") {
      if (character === "\r" && source[index + 1] === "\n") index += 1;
      row.push(field); if (row.some((item) => item.trim())) rows.push(row); row = []; field = "";
    } else field += character;
  }
  if (quoted) throw new ReconciliationControlError("CSV possui aspas sem fechamento.");
  row.push(field); if (row.some((item) => item.trim())) rows.push(row);
  return rows;
}

function statementDate(value: string, line: number, compact = false) {
  const source = String(value || "").trim();
  let iso = source;
  if (compact && /^\d{8}$/.test(source)) iso = `${source.slice(0, 4)}-${source.slice(4, 6)}-${source.slice(6, 8)}`;
  else if (/^\d{2}\/\d{2}\/\d{4}$/.test(source)) iso = `${source.slice(6)}-${source.slice(3, 5)}-${source.slice(0, 2)}`;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(iso)) throw new ReconciliationControlError(`Data inválida na linha ${line}.`);
  const result = new Date(`${iso}T00:00:00.000Z`);
  if (Number.isNaN(result.valueOf()) || result.toISOString().slice(0, 10) !== iso) throw new ReconciliationControlError(`Data inválida na linha ${line}.`);
  return result;
}

function statementMoney(value: string, line: number) {
  let source = String(value || "").trim().replace(/\s|R\$/gi, "");
  const negative = source.startsWith("-") || /^\(.*\)$/.test(source);
  source = source.replace(/[()\-+]/g, "");
  const comma = source.lastIndexOf(","), dot = source.lastIndexOf(".");
  if (comma >= 0 && dot >= 0) source = comma > dot ? source.replaceAll(".", "").replace(",", ".") : source.replaceAll(",", "");
  else if (comma >= 0) source = source.replaceAll(".", "").replace(",", ".");
  else if ((source.match(/\./g) || []).length > 1 || (/\.\d{3}$/.test(source) && !/\.\d{1,2}$/.test(source))) source = source.replaceAll(".", "");
  if (!/^\d{1,10}(?:\.\d{1,2})?$/.test(source)) throw new ReconciliationControlError(`Valor inválido na linha ${line}.`);
  const cents = Math.round(Number(source) * 100) * (negative ? -1 : 1);
  if (!Number.isSafeInteger(cents) || cents === 0 || Math.abs(cents) > 2_000_000_000) throw new ReconciliationControlError(`Valor inválido na linha ${line}.`);
  return cents;
}

function delimiterCount(value: string, delimiter: string) { let count = 0; let quoted = false; for (let index = 0; index < value.length; index += 1) { if (value[index] === '"') quoted = !quoted; else if (!quoted && value[index] === delimiter) count += 1; } return count; }
function headerKey(value: string) { return normalize(value).replace(/[^a-z0-9]/g, ""); }
function headerPosition(headers: string[], aliases: string[], required = true) { const result = headers.findIndex((header) => aliases.includes(header)); if (required && result < 0) throw new ReconciliationControlError(`Cabeçalho obrigatório ausente: ${aliases[0]}.`); return result; }
function ofxTag(block: string, tag: string) { return block.match(new RegExp(`<${tag}>([^<\\r\\n]+)`, "i"))?.[1]?.trim() || ""; }
function decodeEntities(value: string) { return value.replace(/&amp;/gi, "&").replace(/&lt;/gi, "<").replace(/&gt;/gi, ">").replace(/&quot;/gi, '"').replace(/&#39;/gi, "'"); }
function rowFingerprint(row: ParsedStatementRow) { return `${row.occurredAt.toISOString()}|${row.amountCents}|${row.description}|${row.bankReference || ""}|${row.documentNumber || ""}`; }
function tokens(value: string) { return new Set(normalize(value).split(/[^a-z0-9]+/).filter((item) => item.length >= 3 && !new Set(["para", "com", "por", "pagamento", "recebimento", "transferencia"]).has(item))); }
function normalize(value: string) { return value.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase(); }
function statusLabel(value: string) { return ({ pending: "Pendente", reconciled: "Conciliado", ignored: "Ignorado" } as Record<string, string>)[value] || value; }
function decimal(cents: number) { const prefix = cents < 0 ? "-" : ""; return `${prefix}${(Math.abs(cents) / 100).toFixed(2).replace(".", ",")}`; }
function csvCell(value: string) { const formula = /^[=+@\t\r]/.test(value) || (/^-/.test(value) && !/^-\d+(?:,\d{2})?$/.test(value)); const safe = formula ? `'${value}` : value; return `"${safe.replaceAll('"', '""')}"`; }
function canonical(value: object): object { return Object.fromEntries(Object.entries(value).sort(([left], [right]) => left.localeCompare(right)).map(([key, child]) => [key, Array.isArray(child) ? child.map((item) => typeof item === "object" && item ? canonical(item) : item) : typeof child === "object" && child ? canonical(child as object) : child])); }
function object(value: unknown) { if (!value || typeof value !== "object" || Array.isArray(value)) throw new ReconciliationControlError("Dados da operação inválidos."); return value as Record<string, unknown>; }
function requiredText(value: unknown, label: string, min: number, max: number) { const result = String(value || "").trim(); if (result.length < min || result.length > max) throw new ReconciliationControlError(`${label} inválido.`); return result; }
function optionalText(value: unknown, max: number) { const result = String(value || "").trim(); if (result.length > max) throw new ReconciliationControlError("Texto excede o limite permitido."); return result || null; }
function requiredId(value: unknown, message: string) { const result = Number(value); if (!Number.isInteger(result) || result <= 0) throw new ReconciliationControlError(message); return result; }
function optionalId(value: unknown, message: string) { return value === null || value === undefined || value === "" ? null : requiredId(value, message); }
function idempotencyKey(value: unknown) { const result = String(value || ""); if (!/^[A-Za-z0-9:_-]{8,120}$/.test(result)) throw new ReconciliationControlError("Identificador da operação inválido."); return result; }
function moneyCents(value: unknown) { let source = String(value ?? "").trim().replace(/\s|R\$/gi, ""); const comma = source.lastIndexOf(","), dot = source.lastIndexOf("."); if (comma >= 0 && dot >= 0) source = comma > dot ? source.replaceAll(".", "").replace(",", ".") : source.replaceAll(",", ""); else if (comma >= 0) source = source.replace(",", "."); if (!/^\d{1,10}(?:\.\d{1,2})?$/.test(source)) throw new ReconciliationControlError("Valor da alocação inválido."); const cents = Math.round(Number(source) * 100); if (!Number.isSafeInteger(cents) || cents < 1 || cents > 2_000_000_000) throw new ReconciliationControlError("Valor da alocação inválido."); return cents; }
function dateValue(value: string | null, fallback: Date, message: string) { if (!value) return fallback; if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new ReconciliationControlError(message); const result = new Date(`${value}T00:00:00.000Z`); if (Number.isNaN(result.valueOf()) || result.toISOString().slice(0, 10) !== value) throw new ReconciliationControlError(message); return result; }
function boundedInteger(value: string | null, fallback: number, min: number, max: number, message: string) { if (!value) return fallback; const result = Number(value); if (!Number.isInteger(result) || result < min || result > max) throw new ReconciliationControlError(message); return result; }
function utcDay(value: Date) { return new Date(Date.UTC(value.getUTCFullYear(), value.getUTCMonth(), value.getUTCDate())); }
