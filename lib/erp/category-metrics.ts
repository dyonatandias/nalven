import { Prisma } from "@/generated/tenant/client";
import { tenantDb } from "@/db";
import type { CategoryMetrics } from "@/lib/erp/category-control";

type Db = Awaited<ReturnType<typeof tenantDb>>;
type MetricRow = {
  category_id: number;
  products: bigint;
  active_products: bigint;
  revenue_90d: Prisma.Decimal;
  units_90d: Prisma.Decimal;
  stock_value: Prisma.Decimal;
  potential_revenue: Prisma.Decimal;
  low_stock: bigint;
  out_of_stock: bigint;
  margin_percent: Prisma.Decimal;
};
type CatalogTotalsRow = { linked_products: bigint; revenue_90d: Prisma.Decimal; stock_value: Prisma.Decimal };

const EMPTY: CategoryMetrics = { products: 0, activeProducts: 0, revenue90d: 0, units90d: 0, stockValue: 0, potentialRevenue: 0, lowStock: 0, outOfStock: 0, marginPercent: 0 };

export async function categoryMetricsMap(db: Db, categoryIds?: number[]) {
  if (categoryIds && !categoryIds.length) return new Map<number, CategoryMetrics>();
  const filter = categoryIds ? Prisma.sql`WHERE assignment.category_id IN (${Prisma.join(categoryIds)})` : Prisma.empty;
  const rows = await db.$queryRaw<MetricRow[]>(Prisma.sql`
    WITH assignment AS (
      SELECT category_id, id AS product_id FROM products WHERE category_id IS NOT NULL
      UNION
      SELECT category_id, product_id FROM product_category_links
    ), sales_90d AS (
      SELECT item.product_id,
             COALESCE(SUM(item.total), 0) AS revenue,
             COALESCE(SUM(item.quantity - item.returned_quantity), 0) AS units
      FROM sale_items item
      JOIN sales sale ON sale.id = item.sale_id
      WHERE sale.status = 'completed' AND sale.created_at >= CURRENT_TIMESTAMP - INTERVAL '90 days'
      GROUP BY item.product_id
    )
    SELECT assignment.category_id,
           COUNT(*) AS products,
           COUNT(*) FILTER (WHERE product.active AND product.status = 'publish') AS active_products,
           COALESCE(SUM(sale.revenue), 0) AS revenue_90d,
           COALESCE(SUM(sale.units), 0) AS units_90d,
           COALESCE(SUM(CASE WHEN product.manage_stock THEN GREATEST(product.stock, 0) * product.cost ELSE 0 END), 0) AS stock_value,
           COALESCE(SUM(CASE WHEN product.manage_stock THEN GREATEST(product.stock, 0) * product.price ELSE 0 END), 0) AS potential_revenue,
           COUNT(*) FILTER (WHERE product.manage_stock AND product.stock > 0 AND product.stock <= product.min_stock) AS low_stock,
           COUNT(*) FILTER (WHERE product.manage_stock AND product.stock <= 0) AS out_of_stock,
           COALESCE(AVG(CASE WHEN product.price > 0 THEN ((product.price - COALESCE(product.cogs_value, product.cost, 0)) / product.price) * 100 END), 0) AS margin_percent
    FROM assignment
    JOIN products product ON product.id = assignment.product_id
    LEFT JOIN sales_90d sale ON sale.product_id = product.id
    ${filter}
    GROUP BY assignment.category_id
  `);
  return new Map(rows.map((row) => [row.category_id, {
    products: Number(row.products), activeProducts: Number(row.active_products), revenue90d: Number(row.revenue_90d), units90d: Number(row.units_90d),
    stockValue: Number(row.stock_value), potentialRevenue: Number(row.potential_revenue), lowStock: Number(row.low_stock), outOfStock: Number(row.out_of_stock), marginPercent: Number(row.margin_percent),
  }]));
}

export function emptyCategoryMetrics(): CategoryMetrics {
  return { ...EMPTY };
}

export async function catalogCategoryTotals(db: Db) {
  const [row] = await db.$queryRaw<CatalogTotalsRow[]>(Prisma.sql`
    SELECT
      COUNT(*) FILTER (WHERE product.category_id IS NOT NULL OR EXISTS (SELECT 1 FROM product_category_links link WHERE link.product_id=product.id)) AS linked_products,
      COALESCE((SELECT SUM(item.total) FROM sale_items item JOIN sales sale ON sale.id=item.sale_id WHERE sale.status='completed' AND sale.created_at >= CURRENT_TIMESTAMP - INTERVAL '90 days'), 0) AS revenue_90d,
      COALESCE(SUM(CASE WHEN product.manage_stock THEN GREATEST(product.stock, 0) * product.cost ELSE 0 END), 0) AS stock_value
    FROM products product
  `);
  return { linkedProducts: Number(row?.linked_products || 0), revenue90d: Number(row?.revenue_90d || 0), stockValue: Number(row?.stock_value || 0) };
}
