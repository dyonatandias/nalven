import { ReportInputError, round } from "@/lib/erp/report-domain";

export const PAID_ORDER_STATUSES = ["processing", "preparing", "shipped", "out-delivery", "delivered", "completed", "refunded"] as const;

export function addCalendarDays(date: string, days: number) {
  const [year, month, day] = date.split("-").map(Number);
  return new Date(Date.UTC(year, month - 1, day + days)).toISOString().slice(0, 10);
}

export function dateInTimezone(value: Date, timezone: string) {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(value);
  const part = (type: string) => parts.find((item) => item.type === type)?.value || "";
  return `${part("year")}-${part("month")}-${part("day")}`;
}

export function zonedMidnight(date: string, timezone: string) {
  const [year, month, day] = date.split("-").map(Number);
  if (!year || !month || !day) throw new ReportInputError("Data inválida.");
  const desired = Date.UTC(year, month - 1, day);
  let guess = desired;
  for (let index = 0; index < 3; index += 1) {
    const parts = new Intl.DateTimeFormat("en-US", { timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23" }).formatToParts(new Date(guess));
    const part = (type: string) => Number(parts.find((item) => item.type === type)?.value || 0);
    const represented = Date.UTC(part("year"), part("month") - 1, part("day"), part("hour"), part("minute"), part("second"));
    guess += desired - represented;
  }
  return new Date(guess);
}

export function salesPeriod(params: URLSearchParams, timezone: string, now = new Date()) {
  const requestedPeriod = params.get("period") || "30d";
  const days = requestedPeriod === "7d" ? 7 : requestedPeriod === "90d" ? 90 : 30;
  const today = dateInTimezone(now, timezone);
  const dateMin = params.get("date_min") || addCalendarDays(today, -(days - 1));
  const dateMax = params.get("date_max") || today;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dateMin) || !/^\d{4}-\d{2}-\d{2}$/.test(dateMax) || dateMin > dateMax) throw new ReportInputError("Intervalo de datas inválido.");
  const start = zonedMidnight(dateMin, timezone), end = zonedMidnight(addCalendarDays(dateMax, 1), timezone);
  const calendarDays = Math.round((Date.parse(`${dateMax}T00:00:00Z`) - Date.parse(`${dateMin}T00:00:00Z`)) / 86_400_000) + 1;
  if (calendarDays > 366) throw new ReportInputError("O intervalo máximo é de 366 dias.");
  const previousMax = addCalendarDays(dateMin, -1), previousMin = addCalendarDays(previousMax, -(calendarDays - 1));
  return { dateMin, dateMax, start, end, days: calendarDays, previousMin, previousMax, previousStart: zonedMidnight(previousMin, timezone), previousEnd: start };
}

export type SalesSource = {
  id: string;
  date: Date;
  total: number;
  items: Array<{ productId: number | null; name: string; quantity: number; revenue: number }>;
};

export type PdvSalesReportRow = {
  id: number;
  createdAt: Date;
  status: string;
  totalCents: number;
  items: Array<{
    productId: number;
    productName: string;
    quantity: number;
    returnedQuantity: number;
    totalCents: number;
    returnedCents: number;
  }>;
};

/**
 * Projects only financially concluded POS sales into the net-sales report.
 * Cancelled, fully refunded and unresolved-return sales are intentionally not
 * counted as orders, revenue or sold units. Partial returns use the immutable
 * item snapshots and their confirmed returned amounts.
 */
export function pdvNetSalesSource(sale: PdvSalesReportRow): SalesSource | null {
  if (!['completed', 'partially_returned'].includes(sale.status)) return null;
  const items = sale.items.map((item) => ({
    productId: item.productId,
    name: item.productName,
    quantity: round(Math.max(0, item.quantity - item.returnedQuantity)),
    revenue: Math.max(0, item.totalCents - item.returnedCents) / 100,
  })).filter((item) => item.quantity > 0 || item.revenue > 0);
  const confirmedReturnedCents = sale.items.reduce((sum, item) => sum + Math.max(0, item.returnedCents), 0);
  const netCents = Math.max(0, sale.totalCents - confirmedReturnedCents);
  if (netCents === 0) return null;
  return { id: `pdv:${sale.id}`, date: sale.createdAt, total: netCents / 100, items };
}

export function aggregateSales(sources: SalesSource[], dateMin: string, dateMax: string, timezone: string) {
  const revenue = round(sources.reduce((sum, sale) => sum + sale.total, 0));
  const items = round(sources.reduce((sum, sale) => sum + sale.items.reduce((quantity, item) => quantity + item.quantity, 0), 0));
  const ranking = new Map<string, { product_id: number | null; product: string; quantity: number; revenue: number }>();
  for (const sale of sources) for (const item of sale.items) {
    const key = item.productId ? `id:${item.productId}` : `name:${item.name}`;
    const row = ranking.get(key) || { product_id: item.productId, product: item.name, quantity: 0, revenue: 0 };
    row.quantity += item.quantity;
    row.revenue += item.revenue;
    ranking.set(key, row);
  }
  const days: Array<{ date: string; revenue: number; orders: number; items: number }> = [];
  for (let date = dateMin; date <= dateMax; date = addCalendarDays(date, 1)) days.push({ date, revenue: 0, orders: 0, items: 0 });
  const byDate = new Map(days.map((item) => [item.date, item]));
  for (const sale of sources) {
    const row = byDate.get(dateInTimezone(sale.date, timezone));
    if (!row) continue;
    row.revenue += sale.total;
    row.orders += 1;
    row.items += sale.items.reduce((sum, item) => sum + item.quantity, 0);
  }
  return {
    summary: { revenue, orders: sources.length, average_ticket: sources.length ? round(revenue / sources.length) : 0, items },
    top_sellers: [...ranking.values()].map((item) => ({ ...item, quantity: round(item.quantity), revenue: round(item.revenue) })).sort((a, b) => b.quantity - a.quantity || b.revenue - a.revenue || a.product.localeCompare(b.product, "pt-BR")),
    timeline: days.map((item) => ({ ...item, revenue: round(item.revenue), items: round(item.items) })),
  };
}

export function compareMetric(current: number, previous: number) {
  if (previous === 0) return current === 0 ? 0 : null;
  return round(((current - previous) / previous) * 100);
}
