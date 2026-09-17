import { AuthError } from "@/lib/auth";
import { ReportInputError, csvFile } from "@/lib/erp/report-domain";
import { aggregateSales, compareMetric, PAID_ORDER_STATUSES, pdvNetSalesSource, salesPeriod, type SalesSource } from "@/lib/erp/report-sales";
import { csvResponse, guardReportExport, privateJson, reportContext, reportFailure } from "@/lib/erp/report-server";

async function sources(db: Awaited<ReturnType<typeof reportContext>>["db"], branchId: number, start: Date, end: Date) {
  const [pdv, orders] = await Promise.all([
    db.sale.findMany({ where: { branchId, createdAt: { gte: start, lt: end } }, select: { id: true, status: true, totalCents: true, createdAt: true, items: { select: { productId: true, productName: true, quantity: true, returnedQuantity: true, totalCents: true, returnedCents: true } } } }),
    db.salesOrder.findMany({ where: { branchId, deletedAt: null, status: { in: [...PAID_ORDER_STATUSES] }, placedAt: { gte: start, lt: end } }, select: { id: true, total: true, refundedTotal: true, placedAt: true, items: { select: { productId: true, nameSnapshot: true, quantity: true, refundedQuantity: true, total: true } } } }),
  ]);
  const linkedOrderIds = orders.length ? new Set((await db.sale.findMany({ where: { sourceType: "sales_order", sourceId: { in: orders.map((order) => String(order.id)) } }, select: { sourceId: true } })).map((sale) => sale.sourceId)) : new Set<string | null>();
  return [
    ...pdv.map(pdvNetSalesSource).filter((sale): sale is SalesSource => Boolean(sale)),
    ...orders.filter((order) => !linkedOrderIds.has(String(order.id))).map((order): SalesSource => {
      const netTotal = Math.max(0, order.total - order.refundedTotal);
      const grossItems = order.items.reduce((sum, item) => sum + item.total, 0);
      return { id: `order:${order.id}`, date: order.placedAt, total: netTotal, items: order.items.map((item) => { const quantity = Math.max(0, item.quantity - item.refundedQuantity); return { productId: item.productId, name: item.nameSnapshot, quantity, revenue: grossItems > 0 ? item.total / grossItems * netTotal : 0 }; }).filter((item) => item.quantity > 0) };
    }).filter((order) => order.total > 0),
  ];
}

export async function GET(request: Request) {
  try {
    const { organization, access, db, branchId, timezone } = await reportContext("reports.read");
    const params = new URL(request.url).searchParams;
    const interval = salesPeriod(params, timezone);
    const exportMode = params.get("export");
    if (exportMode && !["summary", "top"].includes(exportMode)) throw new ReportInputError("Modo de exportação inválido.");
    if (exportMode) await guardReportExport(db, `${organization.id}:${access.user.id}:sales`);
    const [currentSources, previousSources, productTotal, customerTotal] = await Promise.all([
      sources(db, branchId, interval.start, interval.end),
      sources(db, branchId, interval.previousStart, interval.previousEnd),
      db.product.count({ where: { active: true, branchConfigurations: { some: { branchId, active: true } } } }),
      db.customer.count({ where: { status: "active" } }),
    ]);
    const current = aggregateSales(currentSources, interval.dateMin, interval.dateMax, timezone);
    const previous = aggregateSales(previousSources, interval.previousMin, interval.previousMax, timezone);
    const comparison = {
      revenue: compareMetric(current.summary.revenue, previous.summary.revenue),
      orders: compareMetric(current.summary.orders, previous.summary.orders),
      average_ticket: compareMetric(current.summary.average_ticket, previous.summary.average_ticket),
      items: compareMetric(current.summary.items, previous.summary.items),
    };
    if (exportMode === "summary") return csvResponse(csvFile(
      ["Data inicial", "Data final", "Faturamento líquido", "Pedidos", "Ticket médio", "Itens vendidos", "Variação faturamento (%)", "Reembolsos"],
      [[interval.dateMin, interval.dateMax, current.summary.revenue.toFixed(2), current.summary.orders, current.summary.average_ticket.toFixed(2), current.summary.items, comparison.revenue ?? "", "Subtraídos do faturamento"]],
    ), "relatorio-vendas-resumo.csv");
    if (exportMode === "top") return csvResponse(csvFile(
      ["Posição", "Produto", "Quantidade vendida", "Receita líquida"],
      current.top_sellers.map((item, index) => [index + 1, item.product, item.quantity, item.revenue.toFixed(2)]),
    ), "relatorio-vendas-produtos.csv");
    return privateJson({
      period: { date_min: interval.dateMin, date_max: interval.dateMax, days: interval.days, timezone, paid_statuses: [...PAID_ORDER_STATUSES], refund_treatment: "Faturamento líquido: cancelamentos e devoluções confirmadas são subtraídos; operações financeiras pendentes não são reconhecidas." },
      summary: current.summary, previous: previous.summary, comparison,
      top_sellers: current.top_sellers.slice(0, 20), timeline: current.timeline,
      totals: { orders: current.summary.orders, products: productTotal, customers: customerTotal },
    });
  } catch (error) {
    if (error instanceof AuthError) return Response.json({ error: "Acesso negado." }, { status: error.status });
    return reportFailure(error);
  }
}
