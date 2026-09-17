export class CashCloseReportError extends Error {
  constructor(message: string, readonly status = 400) {
    super(message);
  }
}

export const CASH_CLOSE_STATUSES = ["open", "closing", "suspended", "closed", "reconciled", "reopened"] as const;
export const CASH_CLOSE_PAGE_SIZES = [10, 25, 50, 100] as const;

export type CashCloseQuery = {
  search: string;
  status: string;
  branchId: number | null;
  registerId: number | null;
  operatorProfileId: number | null;
  divergentOnly: boolean;
  from: Date;
  to: Date;
  page: number;
  pageSize: number;
  sort: "recent" | "oldest" | "difference_desc";
  format: "json" | "csv";
};

export type CashCloseReportRow = {
  id: number;
  status: string;
  businessDate: Date;
  openedAt: Date;
  closedAt: Date | null;
  registerId: number | null;
  registerName: string;
  branchId: number | null;
  branchName: string | null;
  operatorProfileId: number | null;
  operatorName: string;
  salesCents: number;
  salesCount: number;
  suppliesCents: number;
  withdrawalsCents: number;
  expectedAmountCents: number | null;
  closingAmountCents: number | null;
  differenceCents: number | null;
};

export function parseCashCloseQuery(params: URLSearchParams, now = new Date()): CashCloseQuery {
  const today = utcDay(now);
  const defaultFrom = new Date(today);
  defaultFrom.setUTCDate(defaultFrom.getUTCDate() - 29);
  const from = parseDate(params.get("from"), defaultFrom, "Data inicial inválida.");
  const to = parseDate(params.get("to"), today, "Data final inválida.");
  if (from > to) throw new CashCloseReportError("A data inicial não pode ser posterior à data final.");
  const span = Math.floor((to.valueOf() - from.valueOf()) / 86_400_000);
  if (span > 366) throw new CashCloseReportError("Consulte no máximo 367 dias por vez.");
  const status = String(params.get("status") || "").trim();
  if (status && !CASH_CLOSE_STATUSES.includes(status as (typeof CASH_CLOSE_STATUSES)[number]))
    throw new CashCloseReportError("Situação de turno inválida.");
  const sort = String(params.get("sort") || "recent");
  if (!["recent", "oldest", "difference_desc"].includes(sort))
    throw new CashCloseReportError("Ordenação inválida.");
  const format = String(params.get("format") || "json");
  if (!["json", "csv"].includes(format)) throw new CashCloseReportError("Formato de exportação inválido.");
  const pageSize = integer(params.get("pageSize"), 25, 1, 100, "Quantidade por página inválida.");
  if (!CASH_CLOSE_PAGE_SIZES.includes(pageSize as (typeof CASH_CLOSE_PAGE_SIZES)[number]))
    throw new CashCloseReportError("Use 10, 25, 50 ou 100 registros por página.");
  const search = String(params.get("search") || "").trim();
  if (search.length > 100) throw new CashCloseReportError("A busca deve ter no máximo 100 caracteres.");
  return {
    search,
    status,
    branchId: optionalId(params.get("branchId"), "Filial inválida."),
    registerId: optionalId(params.get("registerId"), "Caixa inválido."),
    operatorProfileId: optionalId(params.get("operatorProfileId"), "Operador inválido."),
    divergentOnly: params.get("divergentOnly") === "true",
    from,
    to: new Date(to.valueOf() + 86_400_000 - 1),
    page: integer(params.get("page"), 1, 1, 100_000, "Página inválida."),
    pageSize,
    sort: sort as CashCloseQuery["sort"],
    format: format as CashCloseQuery["format"],
  };
}

export function signedCashMovement(type: string, amountCents: number) {
  if (type === "withdrawal") return -Math.abs(amountCents);
  if (type === "supply") return Math.abs(amountCents);
  return amountCents;
}

export function cashCloseSummary(rows: CashCloseReportRow[], toleranceCents: number) {
  const closed = rows.filter((row) => isFinalized(row.status));
  const divergent = closed.filter((row) => Math.abs(row.differenceCents || 0) > toleranceCents);
  const exact = closed.filter((row) => (row.differenceCents || 0) === 0);
  const durations = closed.flatMap((row) => row.closedAt ? [Math.max(0, row.closedAt.valueOf() - row.openedAt.valueOf())] : []);
  return {
    open: rows.filter((row) => row.status === "open").length,
    closing: rows.filter((row) => row.status === "closing").length,
    suspended: rows.filter((row) => row.status === "suspended").length,
    closed: closed.length,
    salesCents: sum(rows, "salesCents"),
    salesCount: sum(rows, "salesCount"),
    suppliesCents: sum(rows, "suppliesCents"),
    withdrawalsCents: sum(rows, "withdrawalsCents"),
    netCashMovementCents: sum(rows, "suppliesCents") - sum(rows, "withdrawalsCents"),
    differenceCents: closed.reduce((total, row) => total + (row.differenceCents || 0), 0),
    absoluteDifferenceCents: closed.reduce((total, row) => total + Math.abs(row.differenceCents || 0), 0),
    divergent: divergent.length,
    exactRate: closed.length ? Math.round((exact.length / closed.length) * 10_000) / 100 : 100,
    averageDurationMinutes: durations.length ? Math.round(durations.reduce((total, value) => total + value, 0) / durations.length / 60_000) : 0,
  };
}

export function cashCloseTrend(rows: CashCloseReportRow[]) {
  const days = new Map<string, { date: string; salesCents: number; differenceCents: number; closed: number; divergent: number }>();
  for (const row of rows) {
    const date = row.businessDate.toISOString().slice(0, 10);
    const item = days.get(date) || { date, salesCents: 0, differenceCents: 0, closed: 0, divergent: 0 };
    item.salesCents += row.salesCents;
    if (isFinalized(row.status)) {
      item.closed += 1;
      item.differenceCents += row.differenceCents || 0;
      if ((row.differenceCents || 0) !== 0) item.divergent += 1;
    }
    days.set(date, item);
  }
  return [...days.values()].sort((a, b) => a.date.localeCompare(b.date));
}

export function cashCloseRanking(rows: CashCloseReportRow[], key: "register" | "operator") {
  const groups = new Map<string, { id: number | null; name: string; sessions: number; salesCents: number; differenceCents: number; exact: number }>();
  for (const row of rows) {
    const id = key === "register" ? row.registerId : row.operatorProfileId;
    const name = key === "register" ? row.registerName : row.operatorName;
    const groupKey = `${id ?? "legacy"}:${name}`;
    const item = groups.get(groupKey) || { id, name, sessions: 0, salesCents: 0, differenceCents: 0, exact: 0 };
    item.sessions += 1;
    item.salesCents += row.salesCents;
    if (isFinalized(row.status)) {
      item.differenceCents += Math.abs(row.differenceCents || 0);
      if ((row.differenceCents || 0) === 0) item.exact += 1;
    }
    groups.set(groupKey, item);
  }
  return [...groups.values()].sort((a, b) => b.salesCents - a.salesCents).slice(0, 12);
}

export function cashCloseCsv(rows: CashCloseReportRow[]) {
  const columns = ["Data", "Turno", "Filial", "Caixa", "Operador", "Situação", "Vendas", "Suprimentos", "Sangrias", "Esperado", "Declarado", "Diferença"];
  const lines = rows.map((row) => [
    row.businessDate.toISOString().slice(0, 10), String(row.id), row.branchName || "Sem filial", row.registerName,
    row.operatorName, row.status, cents(row.salesCents), cents(row.suppliesCents), cents(row.withdrawalsCents),
    isFinalized(row.status) ? cents(row.expectedAmountCents) : "Oculto até o fechamento",
    isFinalized(row.status) ? cents(row.closingAmountCents) : "", isFinalized(row.status) ? cents(row.differenceCents) : "",
  ]);
  return `\uFEFF${[columns, ...lines].map((line) => line.map(csvCell).join(";")).join("\r\n")}`;
}

function cents(value: number | null) { return value == null ? "" : (value / 100).toFixed(2).replace(".", ","); }
function csvCell(value: string) {
  const safe = /^[=+\-@\t\r]/.test(value) ? `'${value}` : value;
  return `"${safe.replaceAll('"', '""')}"`;
}
function sum<T extends CashCloseReportRow>(rows: T[], field: "salesCents" | "salesCount" | "suppliesCents" | "withdrawalsCents") { return rows.reduce((total, row) => total + row[field], 0); }
function isFinalized(status: string) { return status === "closed" || status === "reconciled"; }
function utcDay(value: Date) { return new Date(Date.UTC(value.getUTCFullYear(), value.getUTCMonth(), value.getUTCDate())); }
function parseDate(value: string | null, fallback: Date, message: string) {
  if (!value) return fallback;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new CashCloseReportError(message);
  const date = new Date(`${value}T00:00:00.000Z`);
  if (Number.isNaN(date.valueOf()) || date.toISOString().slice(0, 10) !== value) throw new CashCloseReportError(message);
  return date;
}
function integer(value: string | null, fallback: number, min: number, max: number, message: string) {
  if (!value) return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) throw new CashCloseReportError(message);
  return parsed;
}
function optionalId(value: string | null, message: string) { return value ? integer(value, 0, 1, Number.MAX_SAFE_INTEGER, message) : null; }
