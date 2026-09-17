export class AccountsControlError extends Error {
  constructor(message: string, readonly status = 400) { super(message); }
}

export const ACCOUNT_TYPES = ["bank", "cash", "wallet", "investment"] as const;
export const ACCOUNT_PAGE_SIZES = [25, 50, 100] as const;

export function parseAccountsQuery(params: URLSearchParams, now = new Date()) {
  const today = utcDay(now);
  const first = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), 1));
  const from = dateValue(params.get("from"), first, "Data inicial inválida.");
  const toDay = dateValue(params.get("to"), today, "Data final inválida.");
  if (from > toDay) throw new AccountsControlError("A data inicial não pode ser posterior à data final.");
  if ((toDay.valueOf() - from.valueOf()) / 86_400_000 > 731) throw new AccountsControlError("Consulte no máximo 732 dias por vez.");
  const type = String(params.get("type") || "");
  if (type && !ACCOUNT_TYPES.includes(type as (typeof ACCOUNT_TYPES)[number])) throw new AccountsControlError("Tipo de conta inválido.");
  const status = String(params.get("status") || "active");
  if (!["active", "inactive", "all"].includes(status)) throw new AccountsControlError("Situação inválida.");
  const format = String(params.get("format") || "json");
  if (!["json", "csv"].includes(format)) throw new AccountsControlError("Formato inválido.");
  const pageSize = integer(params.get("pageSize"), 50, 1, 100, "Quantidade por página inválida.");
  if (!ACCOUNT_PAGE_SIZES.includes(pageSize as (typeof ACCOUNT_PAGE_SIZES)[number])) throw new AccountsControlError("Use 25, 50 ou 100 lançamentos por página.");
  const search = String(params.get("search") || "").trim();
  if (search.length > 100) throw new AccountsControlError("A busca deve ter no máximo 100 caracteres.");
  return { search, type, status, accountId: optionalId(params.get("accountId"), "Conta inválida."), from,
    to: new Date(toDay.valueOf() + 86_400_000 - 1), page: integer(params.get("page"), 1, 1, 100_000, "Página inválida."),
    pageSize, format: format as "json" | "csv" };
}

export function accountInput(value: unknown, editing = false) {
  const input = object(value);
  return {
    code: accountCode(input.code), name: requiredText(input.name, "Nome", 2, 100),
    type: select(input.type, ACCOUNT_TYPES, "Tipo de conta inválido."), currency: "BRL",
    branchId: optionalId(input.branchId, "Filial inválida."), description: optionalText(input.description, 500),
    institutionName: optionalText(input.institutionName, 100), bankCode: optionalPattern(input.bankCode, /^\d{3,8}$/, "Código bancário inválido."),
    agency: optionalPattern(input.agency, /^[0-9A-Za-z.-]{1,20}$/, "Agência inválida."),
    accountNumberLast4: optionalPattern(input.accountNumberLast4, /^[0-9A-Za-z]{2,8}$/, "Identificador final da conta inválido."),
    color: color(input.color), creditLimitCents: moneyCents(input.creditLimit || 0, true),
    ...(!editing ? { openingBalanceCents: moneyCents(input.openingBalance || 0, true, true) } : {}),
  };
}

export function manualEntryInput(value: unknown) {
  const input = object(value);
  return { accountId: requiredId(input.accountId, "Conta inválida."), type: select(input.type, ["credit", "debit"] as const, "Tipo de lançamento inválido."),
    amountCents: moneyCents(input.amount), description: requiredText(input.description, "Descrição", 3, 180),
    reference: optionalText(input.reference, 100), occurredAt: dateValue(input.occurredAt ? String(input.occurredAt) : null, utcDay(new Date()), "Data do lançamento inválida."),
    requestId: requestId(input.requestId) };
}

export function transferInput(value: unknown) {
  const input = object(value);
  const fromAccountId = requiredId(input.fromAccountId, "Conta de origem inválida.");
  const toAccountId = requiredId(input.toAccountId, "Conta de destino inválida.");
  if (fromAccountId === toAccountId) throw new AccountsControlError("Selecione contas diferentes.");
  return { fromAccountId, toAccountId, amountCents: moneyCents(input.amount), description: optionalText(input.description, 300),
    occurredAt: dateValue(input.occurredAt ? String(input.occurredAt) : null, utcDay(new Date()), "Data da transferência inválida."), requestId: requestId(input.requestId) };
}

export function reversalInput(value: unknown) {
  const input = object(value);
  return { id: requiredId(input.id, "Lançamento inválido."), reason: requiredText(input.reason, "Motivo", 8, 500), requestId: requestId(input.requestId) };
}

export function transferReversalInput(value: unknown) {
  const input = object(value);
  return { id: requiredId(input.id, "Transferência inválida."), reason: requiredText(input.reason, "Motivo", 8, 500), requestId: requestId(input.requestId) };
}

export function accountStateInput(value: unknown) {
  const input = object(value);
  return { id: requiredId(input.id, "Conta inválida."), reason: requiredText(input.reason, "Motivo", 8, 500) };
}

export type AccountSummaryRow = { id: number; type: string; active: boolean; currentBalanceCents: number; creditLimitCents: number; ledgerBalanceCents: number; pendingReconciliation: number };
export function accountsSummary(accounts: AccountSummaryRow[], entries: Array<{ type: string; amountCents: number }>) {
  const active = accounts.filter((account) => account.active);
  return {
    balanceCents: active.reduce((sum, item) => sum + item.currentBalanceCents, 0),
    availableCents: active.reduce((sum, item) => sum + item.currentBalanceCents + item.creditLimitCents, 0),
    cashCents: active.filter((item) => item.type === "cash").reduce((sum, item) => sum + item.currentBalanceCents, 0),
    bankCents: active.filter((item) => item.type === "bank").reduce((sum, item) => sum + item.currentBalanceCents, 0),
    active: active.length, inactive: accounts.length - active.length,
    inflowCents: entries.filter((entry) => entry.type === "credit").reduce((sum, entry) => sum + entry.amountCents, 0),
    outflowCents: entries.filter((entry) => entry.type === "debit").reduce((sum, entry) => sum + entry.amountCents, 0),
    pendingReconciliation: accounts.reduce((sum, item) => sum + item.pendingReconciliation, 0),
    drifted: accounts.filter((item) => item.currentBalanceCents !== item.ledgerBalanceCents).length,
  };
}

export function accountTrend(entries: Array<{ occurredAt: Date; type: string; amountCents: number }>) {
  const days = new Map<string, { date: string; inflowCents: number; outflowCents: number; netCents: number; count: number }>();
  for (const entry of entries) {
    const key = entry.occurredAt.toISOString().slice(0, 10);
    const item = days.get(key) || { date: key, inflowCents: 0, outflowCents: 0, netCents: 0, count: 0 };
    if (entry.type === "credit") item.inflowCents += entry.amountCents; else item.outflowCents += entry.amountCents;
    item.netCents = item.inflowCents - item.outflowCents; item.count += 1; days.set(key, item);
  }
  return [...days.values()].sort((left, right) => left.date.localeCompare(right.date));
}

export function accountsCsv(entries: Array<{ occurredAt: Date; accountCode: string; accountName: string; type: string; description: string; reference: string | null; sourceType: string; amountCents: number; balanceAfterCents: number; createdBy: string }>) {
  const header = ["Data", "Código", "Conta", "Movimento", "Descrição", "Referência", "Origem", "Valor", "Saldo após", "Responsável"];
  const rows = entries.map((entry) => [entry.occurredAt.toISOString().slice(0, 10), entry.accountCode, entry.accountName,
    entry.type === "credit" ? "Entrada" : "Saída", entry.description, entry.reference || "", entry.sourceType,
    decimal(entry.amountCents), decimal(entry.balanceAfterCents), entry.createdBy]);
  return `\uFEFF${[header, ...rows].map((row) => row.map(csv).join(";")).join("\r\n")}`;
}

export function centsToAmount(cents: number) { return cents / 100; }
function decimal(cents: number) { return (cents / 100).toFixed(2).replace(".", ","); }
function csv(value: string) { const safe = /^[=+\-@\t\r]/.test(value) ? `'${value}` : value; return `"${safe.replaceAll('"', '""')}"`; }
function object(value: unknown) { if (!value || typeof value !== "object" || Array.isArray(value)) throw new AccountsControlError("Dados da operação inválidos."); return value as Record<string, unknown>; }
function requiredText(value: unknown, label: string, min: number, max: number) { const result = String(value || "").trim(); if (result.length < min || result.length > max) throw new AccountsControlError(`${label} inválido.`); return result; }
function optionalText(value: unknown, max: number) { const result = String(value || "").trim(); if (result.length > max) throw new AccountsControlError("Texto excede o limite permitido."); return result || null; }
function requiredId(value: unknown, message: string) { const result = Number(value); if (!Number.isInteger(result) || result <= 0) throw new AccountsControlError(message); return result; }
function optionalId(value: unknown, message: string) { return value === null || value === undefined || value === "" ? null : requiredId(value, message); }
function select<T extends readonly string[]>(value: unknown, values: T, message: string) { const result = String(value); if (!values.includes(result)) throw new AccountsControlError(message); return result as T[number]; }
function requestId(value: unknown) { const result = String(value || ""); if (!/^[A-Za-z0-9:_-]{8,120}$/.test(result)) throw new AccountsControlError("Identificador da operação inválido."); return result; }
function accountCode(value: unknown) { const result = String(value || "").trim().toUpperCase().replace(/\s+/g, "-"); if (!/^[A-Z0-9][A-Z0-9._-]{1,29}$/.test(result)) throw new AccountsControlError("Código deve possuir de 2 a 30 letras, números, pontos, traços ou sublinhados."); return result; }
function optionalPattern(value: unknown, pattern: RegExp, message: string) { const result = String(value || "").trim(); if (result && !pattern.test(result)) throw new AccountsControlError(message); return result || null; }
function color(value: unknown) { const result = String(value || "#168151"); if (!/^#[0-9A-Fa-f]{6}$/.test(result)) throw new AccountsControlError("Cor inválida."); return result.toUpperCase(); }
function moneyCents(value: unknown, allowZero = false, allowNegative = false) { const source = String(value ?? "").trim().replace(",", "."); if (!/^-?\d{1,10}(?:\.\d{1,2})?$/.test(source)) throw new AccountsControlError("Valor monetário inválido."); const result = Math.round(Number(source) * 100); if (!Number.isSafeInteger(result) || Math.abs(result) > 2_000_000_000 || (!allowNegative && result < (allowZero ? 0 : 1)) || (allowNegative && !allowZero && result === 0)) throw new AccountsControlError("Valor monetário inválido."); return result; }
function dateValue(value: string | null, fallback: Date, message: string) { if (!value) return fallback; if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new AccountsControlError(message); const result = new Date(`${value}T00:00:00.000Z`); if (Number.isNaN(result.valueOf()) || result.toISOString().slice(0, 10) !== value) throw new AccountsControlError(message); return result; }
function integer(value: string | null, fallback: number, min: number, max: number, message: string) { if (!value) return fallback; const result = Number(value); if (!Number.isInteger(result) || result < min || result > max) throw new AccountsControlError(message); return result; }
function utcDay(value: Date) { return new Date(Date.UTC(value.getUTCFullYear(), value.getUTCMonth(), value.getUTCDate())); }
