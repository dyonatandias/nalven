export const REPORT_EXPORT_LIMIT = 10_000;
export const REPORT_PAGE_MAX = 100;

export type MarginHealth = "healthy" | "warning" | "critical";
export type MarginSource = "product" | "category" | "global";
export type PricingMode = "global" | "product" | "mixed";

export type MarginConfiguration = {
  mode: PricingMode;
  globalTargetMargin: number;
  globalMinimumMargin: number;
  categoryOverrides: Array<{ categoryId: number; targetMargin: number; minimumMargin: number }>;
};

export type MarginProductInput = {
  id: number;
  name: string;
  sku: string;
  price: number;
  cogs: number;
  targetMargin: number | null;
  pricingSource: string;
  categories: Array<{ id: number; name: string; primary?: boolean }>;
  costs: Array<{ type: string; label: string; value: number }>;
};

export type MarginRow = {
  id: number;
  name: string;
  sku: string;
  price: number;
  cogs: number;
  directCosts: number;
  indirectCosts: number;
  globalCosts: number;
  totalCost: number;
  margin: number;
  marginPercent: number;
  targetMargin: number;
  minimumMargin: number;
  suggestedPrice: number;
  suggestedMinimum: number;
  suggestedDifferencePercent: number;
  health: MarginHealth;
  marginSource: MarginSource;
  categories: Array<{ id: number; name: string }>;
  costBreakdown: Array<{ type: string; label: string; value: number }>;
};

function cents(value: number) {
  return Number.isFinite(value) ? Math.round(value * 100) : 0;
}

function money(valueInCents: number) {
  return valueInCents / 100;
}

export function round(value: number, places = 2) {
  const scale = 10 ** places;
  return Math.round((value + Number.EPSILON) * scale) / scale;
}

export function suggestedPrice(totalCost: number, marginPercent: number) {
  if (totalCost <= 0) return 0;
  if (marginPercent < 0 || marginPercent >= 100) return money(cents(totalCost));
  return money(Math.round(cents(totalCost) / (1 - marginPercent / 100)));
}

export function resolveMargin(
  product: Pick<MarginProductInput, "targetMargin" | "pricingSource" | "categories">,
  configuration: MarginConfiguration,
) {
  if (product.targetMargin !== null && product.pricingSource === "product") {
    return {
      targetMargin: product.targetMargin,
      minimumMargin: configuration.globalMinimumMargin,
      source: "product" as const,
    };
  }
  if (configuration.mode !== "global" && configuration.mode !== "product") {
    const overrides = new Map(configuration.categoryOverrides.map((item) => [item.categoryId, item]));
    const categories = [...product.categories].sort((a, b) => Number(Boolean(b.primary)) - Number(Boolean(a.primary)) || a.id - b.id);
    const override = categories.map((item) => overrides.get(item.id)).find(Boolean);
    if (override) return { targetMargin: override.targetMargin, minimumMargin: override.minimumMargin, source: "category" as const };
  }
  return {
    targetMargin: configuration.globalTargetMargin,
    minimumMargin: configuration.globalMinimumMargin,
    source: "global" as const,
  };
}

export function calculateMarginRow(
  product: MarginProductInput,
  configuration: MarginConfiguration,
  globalCostItems: Array<{ type: string; label: string; value: number }>,
): MarginRow {
  const resolved = resolveMargin(product, configuration);
  const directCents = product.costs.filter((item) => item.type === "direct").reduce((sum, item) => sum + cents(item.value), 0);
  const indirectCents = product.costs.filter((item) => item.type === "indirect").reduce((sum, item) => sum + cents(item.value), 0);
  const globalCents = globalCostItems.reduce((sum, item) => sum + cents(item.value), 0);
  const cogsCents = cents(product.cogs);
  const totalCostCents = cogsCents + directCents + indirectCents + globalCents;
  const priceCents = cents(product.price);
  const marginCents = priceCents - totalCostCents;
  const marginPercent = priceCents > 0 ? round((marginCents / priceCents) * 100) : 0;
  const health: MarginHealth = priceCents <= 0
    ? "critical"
    : marginPercent >= resolved.targetMargin
      ? "healthy"
      : marginPercent >= resolved.minimumMargin
        ? "warning"
        : "critical";
  const targetPrice = suggestedPrice(money(totalCostCents), resolved.targetMargin);
  return {
    id: product.id,
    name: product.name,
    sku: product.sku,
    price: money(priceCents),
    cogs: money(cogsCents),
    directCosts: money(directCents),
    indirectCosts: money(indirectCents),
    globalCosts: money(globalCents),
    totalCost: money(totalCostCents),
    margin: money(marginCents),
    marginPercent,
    targetMargin: resolved.targetMargin,
    minimumMargin: resolved.minimumMargin,
    suggestedPrice: targetPrice,
    suggestedMinimum: suggestedPrice(money(totalCostCents), resolved.minimumMargin),
    suggestedDifferencePercent: targetPrice > 0 ? round(((money(priceCents) - targetPrice) / targetPrice) * 100) : 0,
    health,
    marginSource: resolved.source,
    categories: product.categories.map(({ id, name }) => ({ id, name })),
    costBreakdown: [
      { type: "cogs", label: "COGS", value: money(cogsCents) },
      ...product.costs.map((item) => ({ ...item, value: money(cents(item.value)) })),
      ...globalCostItems.map((item) => ({ ...item, type: "global", value: money(cents(item.value)) })),
    ],
  };
}

export function summarizeMargins(rows: MarginRow[]) {
  const priced = rows.filter((item) => item.price > 0);
  const totalRevenueCents = rows.reduce((sum, item) => sum + cents(item.price), 0);
  const totalCostCents = rows.reduce((sum, item) => sum + cents(item.totalCost), 0);
  const totalMarginCents = rows.reduce((sum, item) => sum + cents(item.margin), 0);
  return {
    avgMarginPercent: priced.length ? round(priced.reduce((sum, item) => sum + item.marginPercent, 0) / priced.length) : 0,
    weightedMarginPercent: totalRevenueCents > 0 ? round((totalMarginCents / totalRevenueCents) * 100) : 0,
    totalRevenue: money(totalRevenueCents),
    totalCost: money(totalCostCents),
    totalMargin: money(totalMarginCents),
    healthCounts: {
      healthy: rows.filter((item) => item.health === "healthy").length,
      warning: rows.filter((item) => item.health === "warning").length,
      critical: rows.filter((item) => item.health === "critical").length,
    },
    productsTotal: rows.length,
  };
}

export function aggregateMarginCategories(rows: MarginRow[]) {
  const groups = new Map<number, { id: number; name: string; rows: MarginRow[] }>();
  for (const row of rows) {
    const categories = row.categories.length ? row.categories : [{ id: 0, name: "Sem categoria" }];
    for (const category of categories) {
      const group = groups.get(category.id) || { ...category, rows: [] };
      group.rows.push(row);
      groups.set(category.id, group);
    }
  }
  return [...groups.values()].map((group) => ({
    id: group.id,
    name: group.name,
    products: group.rows.length,
    ...summarizeMargins(group.rows),
  })).sort((a, b) => a.avgMarginPercent - b.avgMarginPercent || a.name.localeCompare(b.name, "pt-BR"));
}

export const FISCAL_FIELDS = ["ncm", "cest", "origin", "gtin"] as const;
export type FiscalField = typeof FISCAL_FIELDS[number];

export function validGtin(value: string | null | undefined) {
  const digits = String(value || "").replace(/\D/g, "");
  if (![8, 12, 13, 14].includes(digits.length)) return false;
  const body = digits.slice(0, -1);
  const sum = [...body].reverse().reduce((total, digit, index) => total + Number(digit) * (index % 2 === 0 ? 3 : 1), 0);
  return (10 - (sum % 10)) % 10 === Number(digits.at(-1));
}

export function fiscalCompleteness(
  product: { ncm?: string | null; cest?: string | null; cestNotApplicable?: boolean; origin?: string | null; gtin?: string | null },
  requiredFields: FiscalField[],
) {
  const present = {
    ncm: /^\d{8}$/.test(String(product.ncm || "").replace(/\D/g, "")),
    cest: Boolean(product.cestNotApplicable) || /^\d{7}$/.test(String(product.cest || "").replace(/\D/g, "")),
    origin: /^[0-8]$/.test(String(product.origin ?? "")),
    gtin: validGtin(product.gtin),
  };
  const missing = requiredFields.filter((field) => !present[field]);
  return { percentage: requiredFields.length ? Math.round(((requiredFields.length - missing.length) / requiredFields.length) * 100) : 100, missing, complete: missing.length === 0, validity: present };
}

export const ORIGIN_LABELS: Record<string, string> = {
  "0": "Nacional",
  "1": "Estrangeira — importação direta",
  "2": "Estrangeira — mercado interno",
  "3": "Nacional — conteúdo importado 40–70%",
  "4": "Nacional — processos produtivos básicos",
  "5": "Nacional — conteúdo importado ≤ 40%",
  "6": "Estrangeira — importação direta, sem similar",
  "7": "Estrangeira — mercado interno, sem similar",
  "8": "Nacional — conteúdo importado > 70%",
};

export function csvCell(input: unknown) {
  let value = input === null || input === undefined ? "" : String(input);
  if (/^\s*[=+@-]/.test(value)) value = `'${value}`;
  return /[,"\n\r]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}

export function csvFile(headers: string[], rows: unknown[][]) {
  return `\uFEFF${[headers, ...rows].map((row) => row.map(csvCell).join(",")).join("\r\n")}\r\n`;
}

export function parsePage(params: URLSearchParams, defaultPerPage: number) {
  const integer = (key: string, fallback: number) => {
    const raw = params.get(key);
    if (raw === null || raw === "") return fallback;
    if (!/^\d+$/.test(raw)) throw new ReportInputError(`Parâmetro ${key} inválido.`);
    return Number(raw);
  };
  const page = integer("page", 1);
  const perPage = integer("per_page", defaultPerPage);
  if (page < 1) throw new ReportInputError("Página inválida.");
  if (perPage < 1 || perPage > REPORT_PAGE_MAX) throw new ReportInputError(`per_page deve estar entre 1 e ${REPORT_PAGE_MAX}.`);
  return { page, perPage };
}

export class ReportInputError extends Error {
  constructor(message: string, public status = 400) {
    super(message);
  }
}
