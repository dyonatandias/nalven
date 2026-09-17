export const DRE_GROUPS = [
  "revenue",
  "deductions",
  "cogs",
  "operating_expense",
  "financial_result",
  "income_tax",
  "excluded",
] as const;

export type DreGroup = (typeof DRE_GROUPS)[number];
export type PlanningBasis = "accrual" | "cash";
export type PlanningScenario = "base" | "optimistic" | "conservative";

export class PlanningControlError extends Error {
  constructor(message: string, readonly status = 400) {
    super(message);
  }
}

export function parsePlanningQuery(parameters: URLSearchParams, now = new Date()) {
  const year = numeric(parameters.get("year") || now.getUTCFullYear(), 2020, 2100, "Ano");
  const scenario = option(parameters.get("scenario") || "base", ["base", "optimistic", "conservative"] as const, "Cenário");
  const basis = option(parameters.get("basis") || "accrual", ["accrual", "cash"] as const, "Regime");
  return {
    year,
    scenario,
    basis,
    branchId: optionalId(parameters.get("branchId")),
    costCenterId: optionalId(parameters.get("costCenterId")),
    budgetId: optionalId(parameters.get("budgetId")),
    format: parameters.get("format") === "csv" ? "csv" as const : "json" as const,
  };
}

export function categoryKey(value: string | null | undefined) {
  return String(value || "Sem categoria")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .trim()
    .toLocaleLowerCase("pt-BR")
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_|_$/g, "") || "sem_categoria";
}

export function suggestedDreGroup(category: string | null | undefined, type: string): DreGroup {
  const key = categoryKey(category);
  if (type === "receivable") return "revenue";
  if (/(cancel|transfer|adiantamento|imobilizado|estoque|fornecedor|componente|mercadoria)/.test(key)) return "excluded";
  if (/(cmv|custo_direto|materia_prima|producao)/.test(key)) return "cogs";
  if (/(imposto_de_renda|contribuicao_social|irpj|csll)/.test(key)) return "income_tax";
  if (/(imposto|tribut|icms|iss|pis|cofins|das)/.test(key)) return "deductions";
  if (/(tarifa|juros|finance|bancari|antecipacao|iof)/.test(key)) return "financial_result";
  return "operating_expense";
}

export function goalProgress(goal: { baseline: number; current: number; target: number; direction: string }) {
  const span = goal.direction === "decrease" ? goal.baseline - goal.target : goal.target - goal.baseline;
  if (span <= 0) return 0;
  const advance = goal.direction === "decrease" ? goal.baseline - goal.current : goal.current - goal.baseline;
  return Math.max(0, Math.min(100, round((advance / span) * 100, 1)));
}

export function goalAchieved(goal: { current: number; target: number; direction: string }) {
  return goal.direction === "decrease" ? goal.current <= goal.target : goal.current >= goal.target;
}

export function allowedBudgetTransition(current: string, target: string) {
  return ({
    draft: ["approved", "archived"],
    approved: ["draft", "active", "archived"],
    active: ["archived"],
    archived: ["draft"],
  } as Record<string, string[]>)[current]?.includes(target) || false;
}

export type PlanningMonth = {
  month: number;
  revenueCents: number;
  deductionsCents: number;
  cogsCents: number;
  operatingExpenseCents: number;
  financialResultCents: number;
  incomeTaxCents: number;
  resultCents: number;
  budgetRevenueCents: number;
  budgetCogsCents: number;
  budgetExpenseCents: number;
  budgetResultCents: number;
};

export function planningSummary(months: PlanningMonth[], year: number, now = new Date()) {
  const elapsedMonths = year < now.getUTCFullYear() ? 12 : year > now.getUTCFullYear() ? 0 : now.getUTCMonth() + 1;
  const sum = (key: keyof PlanningMonth) => months.reduce((total, month) => total + Number(month[key]), 0);
  const realized = {
    revenueCents: sum("revenueCents"), deductionsCents: sum("deductionsCents"), cogsCents: sum("cogsCents"),
    operatingExpenseCents: sum("operatingExpenseCents"), financialResultCents: sum("financialResultCents"),
    incomeTaxCents: sum("incomeTaxCents"), resultCents: sum("resultCents"),
  };
  const budget = { revenueCents: sum("budgetRevenueCents"), cogsCents: sum("budgetCogsCents"),
    expenseCents: sum("budgetExpenseCents"), resultCents: sum("budgetResultCents") };
  const annualization = elapsedMonths > 0 && elapsedMonths < 12 ? 12 / elapsedMonths : elapsedMonths === 0 ? 0 : 1;
  const grossProfit = realized.revenueCents - realized.deductionsCents - realized.cogsCents;
  return {
    ...realized,
    grossProfitCents: grossProfit,
    grossMargin: realized.revenueCents ? round(grossProfit / realized.revenueCents * 100, 1) : 0,
    operatingMargin: realized.revenueCents ? round(realized.resultCents / realized.revenueCents * 100, 1) : 0,
    budget,
    varianceCents: realized.resultCents - budget.resultCents,
    attainment: budget.revenueCents ? round(realized.revenueCents / budget.revenueCents * 100, 1) : 0,
    forecast: {
      revenueCents: Math.round(realized.revenueCents * annualization),
      resultCents: Math.round(realized.resultCents * annualization),
    },
    elapsedMonths,
  };
}

export function planningCsv(months: PlanningMonth[], year: number) {
  const heading = ["ano", "mes", "receita_realizada", "deducoes", "cmv", "despesas_operacionais", "resultado_financeiro", "tributos_resultado", "resultado", "receita_orcada", "cmv_orcado", "despesas_orcadas", "resultado_orcado", "desvio"];
  const rows = months.map((month) => [year, month.month, amount(month.revenueCents), amount(month.deductionsCents), amount(month.cogsCents),
    amount(month.operatingExpenseCents), amount(month.financialResultCents), amount(month.incomeTaxCents), amount(month.resultCents),
    amount(month.budgetRevenueCents), amount(month.budgetCogsCents), amount(month.budgetExpenseCents), amount(month.budgetResultCents),
    amount(month.resultCents - month.budgetResultCents)]);
  return [heading, ...rows].map((row) => row.map(csvCell).join(";")).join("\n");
}

function numeric(value: unknown, min: number, max: number, label: string) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) throw new PlanningControlError(`${label} inválido.`);
  return parsed;
}
function optionalId(value: string | null) { return value ? numeric(value, 1, Number.MAX_SAFE_INTEGER, "Filtro") : null; }
function option<const T extends readonly string[]>(value: string, allowed: T, label: string): T[number] {
  if (!allowed.includes(value)) throw new PlanningControlError(`${label} inválido.`);
  return value as T[number];
}
function amount(cents: number) { return (cents / 100).toFixed(2).replace(".", ","); }
function csvCell(value: unknown) { const text = String(value); return /[;"\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text; }
function round(value: number, digits = 2) { const factor = 10 ** digits; return Math.round(value * factor) / factor; }
