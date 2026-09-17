import { aggregateSales, compareMetric, PAID_ORDER_STATUSES, pdvNetSalesSource, salesPeriod, type SalesSource } from "@/lib/erp/report-sales";
import { csvFile, ReportInputError, round } from "@/lib/erp/report-domain";
import { csvResponse, guardReportExport, privateJson, reportContext, reportFailure } from "@/lib/erp/report-server";

type DashboardSource = SalesSource & {
  number: string;
  customer: string;
  customerId: number | null;
  paymentMethod: string;
  channel: string;
  status: string;
};

async function loadSalesSources(
  db: Awaited<ReturnType<typeof reportContext>>["db"],
  branchId: number,
  start: Date,
  end: Date,
) {
  const [pdvRows, orderRows] = await Promise.all([
    db.sale.findMany({
      where: { branchId, createdAt: { gte: start, lt: end } },
      select: {
        id: true, saleNumber: true, customer: true, customerId: true, paymentMethod: true,
        status: true, totalCents: true, createdAt: true, sourceType: true, sourceId: true,
        items: { select: { productId: true, productName: true, quantity: true, returnedQuantity: true, totalCents: true, returnedCents: true } },
      },
    }),
    db.salesOrder.findMany({
      where: { branchId, deletedAt: null, status: { in: [...PAID_ORDER_STATUSES] }, placedAt: { gte: start, lt: end } },
      select: {
        id: true, number: true, customerName: true, customerId: true, paymentMethod: true, salesChannel: true,
        status: true, total: true, refundedTotal: true, placedAt: true,
        items: { select: { productId: true, nameSnapshot: true, quantity: true, refundedQuantity: true, total: true } },
      },
    }),
  ]);
  const linkedIds = orderRows.length ? new Set((await db.sale.findMany({
    where: { sourceType: "sales_order", sourceId: { in: orderRows.map(row => String(row.id)) } },
    select: { sourceId: true },
  })).map(row => row.sourceId)) : new Set<string | null>();
  const sources: DashboardSource[] = [];
  for (const row of pdvRows) {
    const source = pdvNetSalesSource(row);
    if (!source) continue;
    sources.push({ ...source, number: row.saleNumber, customer: row.customer, customerId: row.customerId, paymentMethod: row.paymentMethod || "Não informado", channel: row.sourceType === "sales_order" ? "Pedido convertido no PDV" : "PDV", status: row.status });
  }
  for (const row of orderRows) {
    if (linkedIds.has(String(row.id))) continue;
    const netTotal = Math.max(0, row.total - row.refundedTotal);
    if (netTotal <= 0) continue;
    const grossItems = row.items.reduce((sum, item) => sum + item.total, 0);
    sources.push({
      id: `order:${row.id}`,
      date: row.placedAt,
      total: netTotal,
      items: row.items.map(item => ({
        productId: item.productId,
        name: item.nameSnapshot,
        quantity: Math.max(0, item.quantity - item.refundedQuantity),
        revenue: grossItems > 0 ? item.total / grossItems * netTotal : 0,
      })).filter(item => item.quantity > 0),
      number: row.number,
      customer: row.customerName,
      customerId: row.customerId,
      paymentMethod: row.paymentMethod || "Não informado",
      channel: channelLabel(row.salesChannel),
      status: row.status,
    });
  }
  return sources;
}

export async function GET(request: Request) {
  try {
    const { organization, access, db, branchId, timezone } = await reportContext("dashboard.read");
    const params = new URL(request.url).searchParams;
    const interval = salesPeriod(params, timezone);
    const exportMode = params.get("export");
    if (exportMode && exportMode !== "summary") throw new ReportInputError("Modo de exportação inválido.");

    const [currentSources, previousSources, inventoryRows, branch, pipelineRows] = await Promise.all([
      loadSalesSources(db, branchId, interval.start, interval.end),
      loadSalesSources(db, branchId, interval.previousStart, interval.previousEnd),
      db.product.findMany({
        where: { active: true, type: "product", manageStock: true, branchConfigurations: { some: { branchId, active: true } } },
        select: {
          id: true, name: true, sku: true, unit: true, cost: true, minStock: true,
          branchConfigurations: { where: { branchId }, select: { costOverride: true, minStock: true }, take: 1 },
          warehouseBalances: { where: { warehouse: { branchId } }, select: { quantity: true, reservedQuantity: true } },
        },
        orderBy: { name: "asc" },
      }),
      db.branch.findUnique({ where: { id: branchId }, select: { id: true, code: true, name: true, timezone: true, defaultWarehouse: { select: { id: true, name: true } } } }),
      db.salesOrder.groupBy({ by: ["status"], where: { branchId, deletedAt: null, status: { notIn: ["completed", "delivered", "cancelled", "refunded"] } }, _count: { _all: true }, _sum: { total: true } }),
    ]);

    const productIds = [...new Set([...currentSources, ...previousSources].flatMap(source => source.items.map(item => item.productId)).filter((id): id is number => id !== null))];
    const costRows = productIds.length ? await db.product.findMany({
      where: { id: { in: productIds } },
      select: { id: true, cost: true, branchConfigurations: { where: { branchId }, select: { costOverride: true }, take: 1 } },
    }) : [];
    const costByProduct = new Map(costRows.map(product => [product.id, product.branchConfigurations[0]?.costOverride ?? product.cost]));
    const cogs = (sources: DashboardSource[]) => round(sources.reduce((total, source) => total + source.items.reduce((subtotal, item) => subtotal + item.quantity * (item.productId ? costByProduct.get(item.productId) || 0 : 0), 0), 0));

    const current = aggregateSales(currentSources, interval.dateMin, interval.dateMax, timezone);
    const previous = aggregateSales(previousSources, interval.previousMin, interval.previousMax, timezone);
    const currentCogs = cogs(currentSources);
    const previousCogs = cogs(previousSources);
    const currentProfit = round(current.summary.revenue - currentCogs);
    const previousProfit = round(previous.summary.revenue - previousCogs);
    const margin = current.summary.revenue ? round(currentProfit / current.summary.revenue * 100) : 0;
    const previousMargin = previous.summary.revenue ? round(previousProfit / previous.summary.revenue * 100) : 0;
    const customerIds = new Set(currentSources.map(source => source.customerId).filter(Boolean));

    const inventoryItems = inventoryRows.map(product => {
      const physical = round(product.warehouseBalances.reduce((sum, row) => sum + row.quantity, 0));
      const reserved = round(product.warehouseBalances.reduce((sum, row) => sum + row.reservedQuantity, 0));
      const available = round(physical - reserved);
      const cost = product.branchConfigurations[0]?.costOverride ?? product.cost;
      const minimum = product.branchConfigurations[0]?.minStock ?? product.minStock;
      return { id: product.id, name: product.name, sku: product.sku, unit: product.unit, physical, reserved, available, minimum, value: round(physical * cost), gap: round(available - minimum) };
    });
    const stockProductIds = new Set(inventoryItems.map(item => item.id));
    const soldStockUnits = round(currentSources.reduce((total, source) => total + source.items.reduce((sum, item) => sum + (item.productId && stockProductIds.has(item.productId) ? item.quantity : 0), 0), 0));
    const inventoryAvailable = round(inventoryItems.reduce((sum, item) => sum + item.available, 0));
    const dailyUnits = soldStockUnits / interval.days;
    const inventory = {
      sku_count: inventoryItems.length,
      physical_units: round(inventoryItems.reduce((sum, item) => sum + item.physical, 0)),
      available_units: inventoryAvailable,
      reserved_units: round(inventoryItems.reduce((sum, item) => sum + item.reserved, 0)),
      value: round(inventoryItems.reduce((sum, item) => sum + item.value, 0)),
      low_count: inventoryItems.filter(item => item.available <= item.minimum).length,
      out_count: inventoryItems.filter(item => item.available <= 0).length,
      coverage_days: dailyUnits > 0 ? round(Math.max(0, inventoryAvailable) / dailyUnits) : null,
      critical: inventoryItems.filter(item => item.available <= item.minimum).sort((left, right) => left.gap - right.gap || left.name.localeCompare(right.name, "pt-BR")).slice(0, 8),
    };

    const topCustomers = rankedMix(currentSources, source => source.customer || "Consumidor não identificado").slice(0, 8);
    const paymentMix = rankedMix(currentSources, source => paymentLabel(source.paymentMethod));
    const channelMix = rankedMix(currentSources, source => source.channel);
    const weekdays = weekdayMix(currentSources, timezone);
    const bestDay = [...current.timeline].sort((left, right) => right.revenue - left.revenue)[0] || null;
    const pipeline = pipelineRows.map(row => ({ status: row.status, label: statusLabel(row.status), count: row._count._all, value: round(row._sum.total || 0) })).sort((left, right) => right.value - left.value);
    const recent = [...currentSources].sort((left, right) => right.date.getTime() - left.date.getTime()).slice(0, 8).map(source => ({ id: source.id, number: source.number, customer: source.customer, channel: source.channel, payment_method: paymentLabel(source.paymentMethod), status: source.status, total: round(source.total), created_at: source.date.toISOString() }));

    const payload = {
      context: { branch: branch || { id: branchId, code: "—", name: "Filial ativa", timezone, defaultWarehouse: null }, generated_at: new Date().toISOString() },
      period: { date_min: interval.dateMin, date_max: interval.dateMax, previous_min: interval.previousMin, previous_max: interval.previousMax, days: interval.days, timezone },
      summary: {
        revenue: current.summary.revenue,
        orders: current.summary.orders,
        average_ticket: current.summary.average_ticket,
        items: current.summary.items,
        customers: customerIds.size,
        cogs: currentCogs,
        gross_profit: currentProfit,
        gross_margin: margin,
        comparison: {
          revenue: compareMetric(current.summary.revenue, previous.summary.revenue),
          orders: compareMetric(current.summary.orders, previous.summary.orders),
          average_ticket: compareMetric(current.summary.average_ticket, previous.summary.average_ticket),
          items: compareMetric(current.summary.items, previous.summary.items),
          customers: compareMetric(customerIds.size, new Set(previousSources.map(source => source.customerId).filter(Boolean)).size),
          gross_profit: compareMetric(currentProfit, previousProfit),
          gross_margin: compareMetric(margin, previousMargin),
        },
      },
      performance: {
        daily_average: round(current.summary.revenue / interval.days),
        projected_30_days: round(current.summary.revenue / interval.days * 30),
        best_day: bestDay,
        timeline: current.timeline,
        weekdays,
      },
      rankings: { products: current.top_sellers.slice(0, 10), customers: topCustomers, payments: paymentMix, channels: channelMix },
      inventory,
      pipeline,
      recent,
      criteria: { revenue: "Vendas concluídas líquidas de devoluções confirmadas; pedidos convertidos no PDV não são duplicados.", margin: "Lucro bruto estimado com o custo atual do cadastro na filial.", stock: "Saldos físicos, reservados e disponíveis de todos os depósitos da filial." },
    };

    if (exportMode === "summary") {
      await guardReportExport(db, `${organization.id}:${access.user.id}:dashboard`);
      return csvResponse(csvFile(
        ["Filial", "Data inicial", "Data final", "Receita líquida", "Pedidos", "Ticket médio", "Itens", "Clientes", "CMV estimado", "Lucro bruto", "Margem bruta (%)", "Valor em estoque", "Itens críticos"],
        [[payload.context.branch.name, interval.dateMin, interval.dateMax, current.summary.revenue.toFixed(2), current.summary.orders, current.summary.average_ticket.toFixed(2), current.summary.items, customerIds.size, currentCogs.toFixed(2), currentProfit.toFixed(2), margin.toFixed(2), inventory.value.toFixed(2), inventory.low_count]],
      ), `dashboard-bi-${interval.dateMin}-${interval.dateMax}.csv`);
    }
    return privateJson(payload);
  } catch (error) {
    return reportFailure(error);
  }
}

function rankedMix(sources: DashboardSource[], key: (source: DashboardSource) => string) {
  const rows = new Map<string, { label: string; revenue: number; orders: number }>();
  for (const source of sources) {
    const label = key(source);
    const row = rows.get(label) || { label, revenue: 0, orders: 0 };
    row.revenue += source.total;
    row.orders += 1;
    rows.set(label, row);
  }
  const total = sources.reduce((sum, source) => sum + source.total, 0);
  return [...rows.values()].map(row => ({ ...row, revenue: round(row.revenue), share: total ? round(row.revenue / total * 100) : 0 })).sort((left, right) => right.revenue - left.revenue || left.label.localeCompare(right.label, "pt-BR"));
}

function weekdayMix(sources: DashboardSource[], timezone: string) {
  const formatter = new Intl.DateTimeFormat("pt-BR", { timeZone: timezone, weekday: "short" });
  const order = ["seg.", "ter.", "qua.", "qui.", "sex.", "sáb.", "dom."];
  const rows = new Map(order.map(label => [label, { label, revenue: 0, orders: 0 }]));
  for (const source of sources) {
    const label = formatter.format(source.date).toLocaleLowerCase("pt-BR");
    const row = rows.get(label) || { label, revenue: 0, orders: 0 };
    row.revenue += source.total;
    row.orders += 1;
    rows.set(label, row);
  }
  return [...rows.values()].map(row => ({ ...row, revenue: round(row.revenue) }));
}

function paymentLabel(value: string) {
  return ({ cash: "Dinheiro", credit_card: "Cartão de crédito", debit_card: "Cartão de débito", pix: "PIX", boleto: "Boleto", store_credit: "Crédito da loja" } as Record<string, string>)[value] || value || "Não informado";
}

function channelLabel(value: string) {
  return ({ direct: "Venda direta", pdv: "PDV", ecommerce: "Loja virtual", marketplace: "Marketplace", whatsapp: "WhatsApp" } as Record<string, string>)[value] || value || "Venda direta";
}

function statusLabel(value: string) {
  return ({ draft: "Rascunho", quote: "Orçamentos", pending: "Pendentes", approved: "Aprovados", processing: "Em processamento", preparing: "Em separação", shipped: "Enviados", "out-delivery": "Em entrega", delivered: "Entregues", completed: "Concluídos", cancelled: "Cancelados", refunded: "Reembolsados" } as Record<string, string>)[value] || value;
}
