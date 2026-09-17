export type FinanceProjectionTitle = {
  type: string;
  status: string;
  amount: number;
  paidAmount: number;
  dueAt: Date;
};

export function remainingAmount(title: Pick<FinanceProjectionTitle, "amount" | "paidAmount">) {
  return round(Math.max(0, title.amount - title.paidAmount));
}

export function effectiveStatus(title: FinanceProjectionTitle, today: Date) {
  if (["paid", "cancelled"].includes(title.status)) return title.status;
  return title.dueAt < today ? "overdue" : title.status;
}

export function financeSummary(titles: FinanceProjectionTitle[], accountBalance: number, todayValue = new Date()) {
  const today = utcDay(todayValue);
  const tomorrow = addDays(today, 1);
  const inSevenDays = addDays(today, 8);
  const active = titles.filter((title) => title.status !== "cancelled");
  const outstanding = active.filter((title) => title.status !== "paid");
  const sum = (items: FinanceProjectionTitle[]) => round(items.reduce((total, title) => total + remainingAmount(title), 0));
  const receivable = outstanding.filter((title) => title.type === "receivable");
  const payable = outstanding.filter((title) => title.type === "payable");
  const overdue = outstanding.filter((title) => title.dueAt < today);
  const dueToday = outstanding.filter((title) => title.dueAt >= today && title.dueAt < tomorrow);
  const dueNext7 = outstanding.filter((title) => title.dueAt >= today && title.dueAt < inSevenDays);
  const maturedReceivables = active.filter((title) => title.type === "receivable" && title.dueAt < tomorrow);
  const maturedPrincipal = maturedReceivables.reduce((total, title) => total + title.amount, 0);
  const maturedPaid = maturedReceivables.reduce((total, title) => total + Math.min(title.amount, title.paidAmount), 0);
  return {
    receivable: sum(receivable), payable: sum(payable), netOpen: round(sum(receivable) - sum(payable)),
    accountBalance: round(accountBalance), overdue: sum(overdue),
    overdueReceivable: sum(overdue.filter((title) => title.type === "receivable")),
    overduePayable: sum(overdue.filter((title) => title.type === "payable")), overdueCount: overdue.length,
    dueToday: sum(dueToday), dueTodayCount: dueToday.length,
    next7Inflow: sum(dueNext7.filter((title) => title.type === "receivable")),
    next7Outflow: sum(dueNext7.filter((title) => title.type === "payable")),
    collectionRate: maturedPrincipal ? round((maturedPaid / maturedPrincipal) * 100) : 100,
    settled: round(active.reduce((total, title) => total + title.paidAmount, 0)),
  };
}

export function agingBuckets(titles: FinanceProjectionTitle[], todayValue = new Date()) {
  const today = utcDay(todayValue);
  const buckets = [
    { key: "current", label: "A vencer", min: -Infinity, max: -1 },
    { key: "1_7", label: "1–7 dias", min: 1, max: 7 },
    { key: "8_30", label: "8–30 dias", min: 8, max: 30 },
    { key: "31_60", label: "31–60 dias", min: 31, max: 60 },
    { key: "61_90", label: "61–90 dias", min: 61, max: 90 },
    { key: "over_90", label: "+90 dias", min: 91, max: Infinity },
  ];
  const open = titles.filter((title) => !["paid", "cancelled"].includes(title.status));
  return buckets.map((bucket) => {
    const selected = open.filter((title) => {
      const days = Math.floor((today.valueOf() - utcDay(title.dueAt).valueOf()) / 86_400_000);
      return days >= bucket.min && days <= bucket.max;
    });
    return { ...bucket,
      receivable: round(selected.filter((title) => title.type === "receivable").reduce((sum, title) => sum + remainingAmount(title), 0)),
      payable: round(selected.filter((title) => title.type === "payable").reduce((sum, title) => sum + remainingAmount(title), 0)), count: selected.length };
  });
}

export function cashForecast(titles: FinanceProjectionTitle[], accountBalance: number, todayValue = new Date(), weeks = 8) {
  const today = utcDay(todayValue);
  let running = accountBalance;
  return Array.from({ length: weeks }, (_, index) => {
    const start = addDays(today, index * 7);
    const end = addDays(start, 7);
    const selected = titles.filter((title) => !["paid", "cancelled"].includes(title.status) && title.dueAt >= start && title.dueAt < end);
    const inflow = round(selected.filter((title) => title.type === "receivable").reduce((sum, title) => sum + remainingAmount(title), 0));
    const outflow = round(selected.filter((title) => title.type === "payable").reduce((sum, title) => sum + remainingAmount(title), 0));
    running = round(running + inflow - outflow);
    return { start: start.toISOString(), end: addDays(end, -1).toISOString(), inflow, outflow, net: round(inflow - outflow), balance: running };
  });
}

export function settlementCashAmount(type: string, amount: number, interest: number, fee: number) {
  return round(type === "receivable" ? amount + interest - fee : amount + interest + fee);
}

function utcDay(value: Date) { return new Date(Date.UTC(value.getUTCFullYear(), value.getUTCMonth(), value.getUTCDate())); }
function addDays(value: Date, count: number) { const copy = new Date(value); copy.setUTCDate(copy.getUTCDate() + count); return copy; }
function round(value: number) { return Math.round(value * 100) / 100; }
