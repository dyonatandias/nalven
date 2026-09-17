import { CategoryInputError } from "@/lib/erp/category-input";

const QUERY_VALUES = {
  status: ["active", "inactive"],
  type: ["product", "service", "both"],
  visibility: ["visible", "catalog", "hidden"],
  attention: ["empty", "seo", "mapping", "attributes", "low_stock"],
  sort: ["structure", "name", "products", "revenue", "health", "recent"],
  format: ["", "csv"],
} as const;

export type CategoryMetrics = {
  products: number;
  activeProducts: number;
  revenue90d: number;
  units90d: number;
  stockValue: number;
  potentialRevenue: number;
  lowStock: number;
  outOfStock: number;
  marginPercent: number;
};

export function parseCategoryQuery(params: URLSearchParams) {
  const search = limited(params.get("search"), 100);
  const status = selected(params.get("status"), QUERY_VALUES.status, "status");
  const type = selected(params.get("type"), QUERY_VALUES.type, "aplicação");
  const visibility = selected(params.get("visibility"), QUERY_VALUES.visibility, "visibilidade");
  const attention = selected(params.get("attention"), QUERY_VALUES.attention, "atenção");
  const sort = selected(params.get("sort") || "structure", QUERY_VALUES.sort, "ordenação") || "structure";
  const format = selected(params.get("format"), QUERY_VALUES.format, "formato");
  const parent = params.get("parent");
  if (parent && parent !== "root" && (!/^\d+$/.test(parent) || Number(parent) < 1)) throw new CategoryInputError("Filtro de hierarquia inválido.");
  return { search, status, type, visibility, attention, sort, format, parent: parent || "", page: number(params.get("page"), 1, 1, 100_000), limit: number(params.get("limit"), 25, 10, 100) };
}

export function categoryHealth(category: { active: boolean; description: string | null; seoTitle: string | null; seoDescription: string | null; seoNoindex: boolean; visibility: string; type: string; attributeCount: number; mappingCount: number; requireMappings?: boolean; metrics: Pick<CategoryMetrics, "products" | "lowStock" | "outOfStock"> }) {
  const issues: string[] = [];
  let score = 100;
  if (!category.description) { score -= 14; issues.push("Sem descrição"); }
  if (!category.seoTitle && !category.seoNoindex && category.visibility !== "hidden") { score -= 12; issues.push("Título SEO ausente"); }
  if (!category.seoDescription && !category.seoNoindex && category.visibility !== "hidden") { score -= 10; issues.push("Descrição SEO ausente"); }
  if ((category.type === "product" || category.type === "both") && !category.attributeCount) { score -= 9; issues.push("Sem atributos orientadores"); }
  if ((category.type === "product" || category.type === "both") && category.requireMappings !== false && !category.mappingCount) { score -= 8; issues.push("Sem mapeamento de canal"); }
  if (!category.metrics.products) { score -= 18; issues.push("Sem itens vinculados"); }
  if (category.metrics.outOfStock) { score -= Math.min(12, category.metrics.outOfStock * 2); issues.push(`${category.metrics.outOfStock} item(ns) esgotado(s)`); }
  else if (category.metrics.lowStock) { score -= Math.min(8, category.metrics.lowStock); issues.push(`${category.metrics.lowStock} item(ns) em estoque baixo`); }
  if (!category.active) score = Math.min(score, 72);
  const normalized = Math.max(0, Math.round(score));
  return { score: normalized, label: normalized >= 85 ? "healthy" : normalized >= 65 ? "attention" : "critical", issues };
}

export function categoryTree<T extends { id: number; name: string; parentId: number | null; menuOrder: number }>(items: T[]) {
  const byParent = new Map<number | null, T[]>();
  const byId = new Map(items.map((item) => [item.id, item]));
  for (const item of items) {
    const key = item.parentId && byId.has(item.parentId) ? item.parentId : null;
    const siblings = byParent.get(key) || [];
    siblings.push(item);
    byParent.set(key, siblings);
  }
  for (const siblings of byParent.values()) siblings.sort((left, right) => left.menuOrder - right.menuOrder || left.name.localeCompare(right.name, "pt-BR"));
  const rows: Array<T & { depth: number; path: string }> = [];
  const visit = (parentId: number | null, depth: number, prefix: string, ancestors: Set<number>) => {
    for (const item of byParent.get(parentId) || []) {
      if (ancestors.has(item.id)) continue;
      const path = prefix ? `${prefix} / ${item.name}` : item.name;
      rows.push({ ...item, depth, path });
      visit(item.id, depth + 1, path, new Set([...ancestors, item.id]));
    }
  };
  visit(null, 0, "", new Set());
  return rows;
}

export function categoryCsv(items: Array<{ name: string; code: string | null; slug: string; path: string; type: string; active: boolean; visibility: string; menuOrder: number; health: { score: number }; metrics: CategoryMetrics; parent?: { name: string } | null }>) {
  const header = ["Categoria", "Código", "Slug", "Caminho", "Superior", "Aplicação", "Status", "Visibilidade", "Ordem", "Saúde", "Itens", "Receita 90d", "Unidades 90d", "Valor em estoque", "Estoque baixo", "Esgotados", "Margem %"];
  const rows = items.map((item) => [item.name, item.code || "", item.slug, item.path, item.parent?.name || "Raiz", item.type, item.active ? "Ativa" : "Inativa", item.visibility, item.menuOrder, item.health.score, item.metrics.products, item.metrics.revenue90d.toFixed(2), item.metrics.units90d.toFixed(2), item.metrics.stockValue.toFixed(2), item.metrics.lowStock, item.metrics.outOfStock, item.metrics.marginPercent.toFixed(2)]);
  return `\uFEFF${[header, ...rows].map((row) => row.map(csvCell).join(";")).join("\r\n")}`;
}

function csvCell(value: unknown) {
  let cell = String(value ?? "");
  if (/^[=+\-@]/.test(cell)) cell = `'${cell}`;
  return `"${cell.replaceAll('"', '""')}"`;
}

function limited(value: string | null, max: number) {
  const result = (value || "").trim();
  if (result.length > max) throw new CategoryInputError("Busca muito extensa.");
  return result;
}

function selected<T extends string>(value: string | null, choices: readonly T[], label: string): T | "" {
  if (!value) return "";
  if (!choices.includes(value as T)) throw new CategoryInputError(`Filtro de ${label} inválido.`);
  return value as T;
}

function number(value: string | null, fallback: number, min: number, max: number) {
  if (!value) return fallback;
  const result = Number(value);
  if (!Number.isInteger(result) || result < min || result > max) throw new CategoryInputError("Paginação inválida.");
  return result;
}
