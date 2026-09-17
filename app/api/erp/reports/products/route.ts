import type { Prisma } from "@/generated/tenant/client";
import { AuthError } from "@/lib/auth";
import { REPORT_EXPORT_LIMIT, ReportInputError, csvFile, parsePage } from "@/lib/erp/report-domain";
import { csvResponse, guardReportExport, privateJson, reportContext, reportFailure } from "@/lib/erp/report-server";

const SORT_FIELDS = { name: "name", price: "price", stock: "stock", sku: "sku" } as const;

export async function GET(request: Request) {
  try {
    const { organization, access, db, branchId } = await reportContext("reports.read");
    const params = new URL(request.url).searchParams;
    const { page, perPage } = parsePage(params, 50);
    const search = String(params.get("search") || "").trim().slice(0, 120);
    const categoryId = params.get("category") ? Number(params.get("category")) : null;
    if (categoryId !== null && (!Number.isInteger(categoryId) || categoryId < 1)) throw new ReportInputError("Categoria inválida.");
    const stockStatus = params.get("stock_status") || "";
    if (stockStatus && !["instock", "outofstock", "onbackorder"].includes(stockStatus)) throw new ReportInputError("Status de estoque inválido.");
    const amount = (key: string) => { const raw = params.get(key); if (!raw) return null; const value = Number(raw); if (!Number.isFinite(value) || value < 0) throw new ReportInputError(`${key} inválido.`); return value; };
    const minPrice = amount("min_price"), maxPrice = amount("max_price");
    if (minPrice !== null && maxPrice !== null && minPrice > maxPrice) throw new ReportInputError("O preço mínimo não pode superar o máximo.");
    const sort = params.get("order_by") || "name";
    const orderBy = sort in SORT_FIELDS ? SORT_FIELDS[sort as keyof typeof SORT_FIELDS] : "name";
    const order = params.get("order")?.toUpperCase() === "DESC" ? "desc" : "asc";
    const exportMode = params.get("export");
    if (exportMode && !["page", "all"].includes(exportMode)) throw new ReportInputError("Modo de exportação inválido.");
    if (exportMode === "all") await guardReportExport(db, `${organization.id}:${access.user.id}:products`);
    const and: Prisma.ProductWhereInput[] = [];
    if (categoryId) and.push({ OR: [{ categoryId }, { categoryLinks: { some: { categoryId } } }] });
    if (search) and.push({ OR: [{ name: { contains: search, mode: "insensitive" } }, { sku: { contains: search, mode: "insensitive" } }, { gtin: { contains: search } }] });
    if (minPrice !== null || maxPrice !== null) {
      const range = { ...(minPrice !== null ? { gte: minPrice } : {}), ...(maxPrice !== null ? { lte: maxPrice } : {}) };
      and.push({ OR: [
        { branchConfigurations: { some: { branchId, active: true, priceOverride: { not: null, ...range } } } },
        { branchConfigurations: { some: { branchId, active: true, priceOverride: null } }, price: range },
      ] });
    }
    const where: Prisma.ProductWhereInput = {
      active: true,
      status: "publish",
      branchConfigurations: { some: { branchId, active: true } },
      ...(stockStatus ? { stockStatus } : {}),
      ...(and.length ? { AND: and } : {}),
    };
    const total = await db.product.count({ where });
    if (exportMode === "all" && total > REPORT_EXPORT_LIMIT) throw new ReportInputError(`A exportação possui ${total} linhas. Reduza os filtros para no máximo ${REPORT_EXPORT_LIMIT}.`, 413);
    const take = exportMode === "all" ? total : perPage;
    const skip = exportMode === "all" ? 0 : (page - 1) * perPage;
    const [products, categories] = await Promise.all([
      db.product.findMany({ where, select: { id: true, name: true, sku: true, price: true, stockStatus: true, manageStock: true, stock: true, weight: true, weightUnit: true, length: true, width: true, height: true, dimensionUnit: true, categoryRecord: { select: { id: true, name: true } }, categoryLinks: { select: { category: { select: { id: true, name: true } } }, orderBy: { categoryId: "asc" } }, branchConfigurations: { where: { branchId }, select: { priceOverride: true }, take: 1 }, warehouseBalances: { where: { warehouse: { branchId } }, select: { quantity: true, reservedQuantity: true } } }, orderBy: { [orderBy]: order }, skip, take }),
      db.category.findMany({ where: { active: true }, select: { id: true, name: true }, orderBy: { name: "asc" } }),
    ]);
    const items = products.map((product) => {
      const categories = product.categoryLinks.map((item) => item.category);
      if (!categories.length && product.categoryRecord) categories.push(product.categoryRecord);
      const stock = product.warehouseBalances.reduce((sum, item) => sum + item.quantity - item.reservedQuantity, 0);
      return { id: product.id, name: product.name, sku: product.sku, categories, price: product.branchConfigurations[0]?.priceOverride ?? product.price, stock_status: product.stockStatus, manage_stock: product.manageStock, stock_quantity: product.manageStock ? stock : null, weight: product.weight, weight_unit: product.weightUnit, dimensions: product.length !== null || product.width !== null || product.height !== null ? { length: product.length, width: product.width, height: product.height, unit: product.dimensionUnit } : null };
    });
    if (exportMode) return csvResponse(csvFile(
      ["Produto", "SKU", "Categorias", "Preço", "Status de estoque", "Controla estoque", "Quantidade em estoque", "Peso", "Unidade do peso", "Comprimento", "Largura", "Altura", "Unidade das dimensões"],
      items.map((item) => [item.name, item.sku, item.categories.map((category) => category.name).join(", "), Number(item.price).toFixed(2), item.stock_status, item.manage_stock ? "Sim" : "Nao", item.stock_quantity ?? "", item.weight ?? "", item.weight_unit, item.dimensions?.length ?? "", item.dimensions?.width ?? "", item.dimensions?.height ?? "", item.dimensions?.unit ?? ""]),
    ), "relatorio-produtos.csv");
    return privateJson({ items, categories, total, page, per_page: perPage, pages: Math.max(1, Math.ceil(total / perPage)) });
  } catch (error) {
    if (error instanceof AuthError) return Response.json({ error: "Acesso negado." }, { status: error.status });
    return reportFailure(error);
  }
}
