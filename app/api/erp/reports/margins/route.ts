import { AuthError } from "@/lib/auth";
import {
  REPORT_EXPORT_LIMIT,
  ReportInputError,
  aggregateMarginCategories,
  calculateMarginRow,
  csvFile,
  parsePage,
  summarizeMargins,
  type MarginConfiguration,
  type MarginHealth,
} from "@/lib/erp/report-domain";
import { csvResponse, guardReportExport, privateJson, reportContext, reportFailure } from "@/lib/erp/report-server";
import { getMarginCache, setMarginCache } from "@/lib/erp/report-cache";

const ORDER_FIELDS = ["price", "total_cost", "margin", "margin_percent", "suggested_min", "name"] as const;
type OrderField = typeof ORDER_FIELDS[number];
function number(value: unknown) {
  return Number(value || 0);
}

function publicRow(row: ReturnType<typeof calculateMarginRow>) {
  return {
    id: row.id, name: row.name, sku: row.sku, price: row.price, cogs: row.cogs,
    direct_costs: row.directCosts, indirect_costs: row.indirectCosts, global_costs: row.globalCosts,
    total_cost: row.totalCost, margin: row.margin, margin_percent: row.marginPercent,
    target_margin: row.targetMargin, minimum_margin: row.minimumMargin,
    suggested_price: row.suggestedPrice, suggested_min: row.suggestedMinimum,
    suggested_difference_percent: row.suggestedDifferencePercent, health: row.health,
    margin_source: row.marginSource, categories: row.categories,
    cost_breakdown: row.costBreakdown,
  };
}

export async function GET(request: Request) {
  try {
    const { organization, access, db, branchId } = await reportContext("reports.read");
    const params = new URL(request.url).searchParams;
    const { page, perPage } = parsePage(params, 20);
    const categoryId = params.get("category_id") ? Number(params.get("category_id")) : null;
    if (categoryId !== null && (!Number.isInteger(categoryId) || categoryId < 1)) throw new ReportInputError("Categoria inválida.");
    const health = params.get("health") || "";
    if (health && !["healthy", "warning", "critical"].includes(health)) throw new ReportInputError("Filtro de saúde inválido.");
    const requestedOrder = params.get("order_by") || "margin_percent";
    const orderBy: OrderField = ORDER_FIELDS.includes(requestedOrder as OrderField) ? requestedOrder as OrderField : "margin_percent";
    const order = params.get("order")?.toUpperCase() === "ASC" ? "ASC" : "DESC";
    const exportMode = params.get("export");
    if (exportMode && !["page", "all"].includes(exportMode)) throw new ReportInputError("Modo de exportação inválido.");
    if (exportMode === "all") await guardReportExport(db, `${organization.id}:${access.user.id}:margins`);
    const cacheKey = `${organization.id}:${branchId}:${page}:${perPage}:${categoryId || ""}:${health}:${orderBy}:${order}`;
    if (!exportMode) {
      const hit = getMarginCache(cacheKey);
      if (hit) return privateJson(hit);
    }
    const productWhere = {
      active: true,
      status: "publish",
      branchConfigurations: { some: { branchId, active: true } },
      ...(categoryId ? { OR: [{ categoryId }, { categoryLinks: { some: { categoryId } } }] } : {}),
    };
    const [settings, products, globalCosts, categories] = await Promise.all([
      db.reportSettings.findUnique({ where: { id: 1 }, include: { categoryOverrides: true } }),
      db.product.findMany({
        where: productWhere,
        select: {
          id: true, name: true, sku: true, price: true, cogs: true, cost: true,
          targetMargin: true, pricingSource: true,
          branchConfigurations: { where: { branchId }, select: { priceOverride: true, costOverride: true }, take: 1 },
          categoryRecord: { select: { id: true, name: true } },
          categoryLinks: { select: { primary: true, category: { select: { id: true, name: true } } }, orderBy: [{ primary: "desc" }, { categoryId: "asc" }] },
        },
        orderBy: { id: "asc" },
      }),
      db.reportGlobalCost.findMany({ where: { reportSettingsId: 1 }, orderBy: { id: "asc" } }),
      db.category.findMany({ where: { active: true }, select: { id: true, name: true }, orderBy: { name: "asc" } }),
    ]);
    const costs = products.length ? await db.productCostItem.findMany({ where: { productId: { in: products.map((item) => item.id) } }, select: { productId: true, type: true, label: true, value: true }, orderBy: { id: "asc" } }) : [];
    const costsByProduct = new Map<number, typeof costs>();
    for (const cost of costs) costsByProduct.set(cost.productId, [...(costsByProduct.get(cost.productId) || []), cost]);
    const configuration: MarginConfiguration = {
      mode: settings?.pricingMode === "global" || settings?.pricingMode === "product" ? settings.pricingMode : "mixed",
      globalTargetMargin: number(settings?.globalTargetMargin ?? 30),
      globalMinimumMargin: number(settings?.globalMinimumMargin ?? 15),
      categoryOverrides: (settings?.categoryOverrides || []).map((item) => ({ categoryId: item.categoryId, targetMargin: number(item.targetMargin), minimumMargin: number(item.minimumMargin) })),
    };
    const globalCostRows = globalCosts.map((item) => ({ type: item.type, label: item.label, value: number(item.value) }));
    const rows = products.map((product) => {
      const linked = product.categoryLinks.map((item) => ({ ...item.category, primary: item.primary }));
      const productCategories = linked.length ? linked : product.categoryRecord ? [{ ...product.categoryRecord, primary: true }] : [];
      const branch = product.branchConfigurations[0];
      return calculateMarginRow({
        id: product.id, name: product.name, sku: product.sku,
        price: number(branch?.priceOverride ?? product.price),
        cogs: number(branch?.costOverride ?? product.cogs ?? product.cost),
        targetMargin: product.targetMargin, pricingSource: product.pricingSource,
        categories: productCategories,
        costs: (costsByProduct.get(product.id) || []).map((item) => ({ type: item.type, label: item.label, value: number(item.value) })),
      }, configuration, globalCostRows);
    });
    const summary = summarizeMargins(rows);
    const categoryBreakdown = aggregateMarginCategories(rows).map((item) => ({
      id: item.id, name: item.name, products: item.products,
      avg_margin_percent: item.avgMarginPercent, weighted_margin_percent: item.weightedMarginPercent,
      total_revenue: item.totalRevenue, total_cost: item.totalCost, total_margin: item.totalMargin,
      health_counts: item.healthCounts,
    }));
    const filtered = health ? rows.filter((item) => item.health === health as MarginHealth) : rows;
    const direction = order === "ASC" ? 1 : -1;
    filtered.sort((a, b) => {
      const fields = { price: "price", total_cost: "totalCost", margin: "margin", margin_percent: "marginPercent", suggested_min: "suggestedMinimum", name: "name" } as const;
      const left = a[fields[orderBy]], right = b[fields[orderBy]];
      const comparison = typeof left === "string" ? left.localeCompare(String(right), "pt-BR") : Number(left) - Number(right);
      return comparison * direction || a.id - b.id;
    });
    if (exportMode === "all" && filtered.length > REPORT_EXPORT_LIMIT) throw new ReportInputError(`A exportação possui ${filtered.length} linhas. Reduza os filtros para no máximo ${REPORT_EXPORT_LIMIT}.`, 413);
    const visible = exportMode === "all" ? filtered : exportMode === "page" ? filtered.slice((page - 1) * perPage, page * perPage) : filtered.slice((page - 1) * perPage, page * perPage);
    if (exportMode) return csvResponse(csvFile(
      ["Produto", "SKU", "Categorias", "Preço", "COGS", "Custos diretos", "Custos indiretos", "Custos globais", "Custo total", "Margem", "Margem (%)", "Margem mínima (%)", "Margem alvo (%)", "Preço mínimo sugerido", "Preço sugerido", "Saúde", "Origem da margem"],
      visible.map((item) => [item.name, item.sku, item.categories.map((category) => category.name).join(", "), item.price.toFixed(2), item.cogs.toFixed(2), item.directCosts.toFixed(2), item.indirectCosts.toFixed(2), item.globalCosts.toFixed(2), item.totalCost.toFixed(2), item.margin.toFixed(2), item.marginPercent, item.minimumMargin, item.targetMargin, item.suggestedMinimum.toFixed(2), item.suggestedPrice.toFixed(2), item.health, item.marginSource]),
    ), "relatorio-margens.csv");
    const value = {
      products: visible.map(publicRow),
      summary: { avg_margin_percent: summary.avgMarginPercent, weighted_margin_percent: summary.weightedMarginPercent, total_revenue: summary.totalRevenue, total_cost: summary.totalCost, total_margin: summary.totalMargin, health_counts: summary.healthCounts, products_total: summary.productsTotal },
      category_breakdown: categoryBreakdown,
      categories,
      total: filtered.length, page, per_page: perPage, pages: Math.max(1, Math.ceil(filtered.length / perPage)),
    };
    setMarginCache(cacheKey, value);
    return privateJson(value);
  } catch (error) {
    if (error instanceof AuthError) return Response.json({ error: error.message || "Acesso negado." }, { status: error.status });
    return reportFailure(error);
  }
}
