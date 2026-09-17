import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../generated/tenant/client";

if (process.env.NALVEN_ALLOW_DEMO_PLANNING_SEED !== "1")
  throw new Error("Defina NALVEN_ALLOW_DEMO_PLANNING_SEED=1 para confirmar o seed demonstrativo de planejamento.");
const connectionString = process.env.TENANT_DATABASE_URL;
if (!connectionString) throw new Error("TENANT_DATABASE_URL não foi definida.");
const db = new PrismaClient({ adapter: new PrismaPg({ connectionString }) });
const actor = "Seed planejamento NALVEN";
const now = new Date(), year = now.getUTCFullYear(), currentMonth = now.getUTCMonth() + 1;
const at = (month: number, day = 10) => new Date(Date.UTC(year, month - 1, day));

async function main() {
  const [identity] = await db.$queryRaw<Array<{ database: string; role: string }>>`SELECT current_database() AS database, current_user AS role`;
  if (!identity || identity.database !== "nalven_t_demo" || identity.role !== "nalven_t_demo_runtime")
    throw new Error("O seed só pode executar em nalven_t_demo com a credencial runtime.");
  const branch = await db.branch.findFirst({ where: { status: "active" }, orderBy: [{ primary: "desc" }, { id: "asc" }] });
  if (!branch) throw new Error("O seed exige uma filial ativa.");
  const centerDefinitions = [
    { code: "ADM-DEMO", name: "Administrativo" }, { code: "COM-DEMO", name: "Comercial e marketing" },
    { code: "LOG-DEMO", name: "Operações e logística" }, { code: "TEC-DEMO", name: "Tecnologia e serviços" },
  ];
  const centers = [];
  for (const definition of centerDefinitions) centers.push(await db.costCenter.upsert({ where: { code: definition.code },
    update: { name: definition.name, active: true }, create: definition }));
  await db.sale.updateMany({ where: { costCenterId: null }, data: { costCenterId: centers[1].id } });

  await db.financialTitle.updateMany({ where: { type: "receivable", category: null }, data: { category: "Outras receitas operacionais" } });
  await db.financialTitle.updateMany({ where: { type: "payable", category: null }, data: { category: "Outras despesas operacionais" } });

  const rules = [
    ["Receita de serviços", "revenue"], ["Tributos sobre vendas", "deductions"], ["CMV e custos diretos", "cogs"],
    ["Marketing", "operating_expense"], ["Pessoal", "operating_expense"], ["Infraestrutura", "operating_expense"],
    ["Tarifas bancárias", "financial_result"], ["IRPJ e CSLL", "income_tax"], ["Compra para estoque", "excluded"],
    ["Serviços", "revenue"], ["Vendas", "revenue"], ["Outras receitas operacionais", "revenue"],
    ["Administrativo", "operating_expense"], ["Assinaturas", "operating_expense"], ["Folha", "operating_expense"],
    ["Logística", "operating_expense"], ["Impostos", "deductions"], ["Fornecedores", "excluded"],
    ["Outras despesas operacionais", "operating_expense"],
  ] as const;
  for (const [label, group] of rules) { const key = label.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase()
    .replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "");
    await db.dreCategoryRule.upsert({ where: { categoryKey: key }, update: { categoryLabel: label, dreGroup: group, active: true },
      create: { categoryKey: key, categoryLabel: label, dreGroup: group, createdBy: actor } }); }

  const baseRevenue = 82_000;
  for (let month = 1; month <= currentMonth; month += 1) {
    const growth = 1 + (month - 1) * 0.027, revenue = Math.round(baseRevenue * growth * 100) / 100;
    const entries = [
      { type: "receivable", description: `Receita recorrente e projetos · ${String(month).padStart(2, "0")}/${year}`, amount: revenue,
        category: "Receita de serviços", center: 3 },
      { type: "payable", description: `Tributos incidentes sobre faturamento · ${String(month).padStart(2, "0")}/${year}`, amount: revenue * .082,
        category: "Tributos sobre vendas", center: 0 },
      { type: "payable", description: `Equipe e encargos · ${String(month).padStart(2, "0")}/${year}`, amount: 24_500 + month * 280,
        category: "Pessoal", center: 0 },
      { type: "payable", description: `Aquisição e performance comercial · ${String(month).padStart(2, "0")}/${year}`, amount: 7_100 + month * 130,
        category: "Marketing", center: 1 },
      { type: "payable", description: `Infraestrutura operacional · ${String(month).padStart(2, "0")}/${year}`, amount: 9_400 + (month % 3) * 620,
        category: "Infraestrutura", center: 2 },
      { type: "payable", description: `Tarifas e antecipações · ${String(month).padStart(2, "0")}/${year}`, amount: 690 + month * 23,
        category: "Tarifas bancárias", center: 0 },
      { type: "payable", description: `Custo direto de entrega · ${String(month).padStart(2, "0")}/${year}`, amount: revenue * .145,
        category: "CMV e custos diretos", center: 3 },
    ];
    for (const [index, entry] of entries.entries()) {
      const sourceId = `PLANNING-${year}-${String(month).padStart(2, "0")}-${String(index + 1).padStart(2, "0")}`,
        amount = Math.round(entry.amount * 100) / 100, occurredAt = at(month, Math.min(24, 12 + index));
      const title = await db.financialTitle.upsert({ where: { sourceType_sourceId: { sourceType: "demo_planning", sourceId } },
        update: { description: entry.description, amount, paidAmount: amount, status: "paid", category: entry.category,
          branchId: branch.id, costCenterId: centers[entry.center].id, issueAt: at(month, 2), competenceAt: at(month, 1), dueAt: occurredAt, paidAt: occurredAt },
        create: { type: entry.type, description: entry.description, sourceType: "demo_planning", sourceId, amount, paidAmount: amount,
          issueAt: at(month, 2), competenceAt: at(month, 1), dueAt: occurredAt, paidAt: occurredAt, status: "paid",
          category: entry.category, priority: "normal", branchId: branch.id, costCenterId: centers[entry.center].id,
          documentNumber: `DRE-${year}-${String(month).padStart(2, "0")}-${index + 1}`, notes: "Simulação gerencial demonstrativa." } });
      if (!await db.financialSettlement.findFirst({ where: { titleId: title.id, notes: `seed-planning:${sourceId}` } }))
        await db.financialSettlement.create({ data: { titleId: title.id, amount, method: index % 2 ? "bank_transfer" : "pix",
          status: "posted", occurredAt, settledBy: actor, notes: `seed-planning:${sourceId}` } });
    }
  }

  const scenarioFactors = { base: 1, optimistic: 1.13, conservative: .89 } as const;
  for (const [scenario, factor] of Object.entries(scenarioFactors) as Array<[keyof typeof scenarioFactors, number]>) {
    const name = `Planejamento ${scenario === "base" ? "base" : scenario === "optimistic" ? "expansão" : "proteção"} ${year}`;
    let budget = await db.budget.findUnique({ where: { name_year_scenario: { name, year, scenario } } });
    if (!budget) budget = await db.budget.create({ data: { name, year, scenario, status: scenario === "base" ? "active" : scenario === "optimistic" ? "approved" : "draft",
      notes: scenario === "base" ? "Crescimento gradual, retenção de clientes e disciplina de margem." : scenario === "optimistic" ? "Aceleração comercial com expansão de capacidade a partir do segundo trimestre." : "Preservação de caixa, receita conservadora e despesas contingenciadas.",
      approvedBy: scenario === "base" ? actor : scenario === "optimistic" ? actor : null, approvedAt: scenario === "base" || scenario === "optimistic" ? now : null,
      lockedAt: scenario === "base" ? now : null, createdBy: actor } });
    if (scenario === "base") await db.budget.updateMany({ where: { id: { not: budget.id }, year, scenario, status: "active" }, data: { status: "archived", lockedAt: now } });
    const budgetCenters = await db.costCenter.findMany({ where: { active: true }, orderBy: { id: "asc" } });
    for (let month = 1; month <= 12; month += 1) for (const center of budgetCenters) {
      const isCommercial = center.id === centers[1].id, isDelivery = center.id === centers[3].id,
        revenueCents = isCommercial || isDelivery ? Math.round(baseRevenue * (1 + (month - 1) * .025) * factor * (isCommercial ? .38 : .62) * 100) : 0,
        cogsCents = isDelivery ? Math.round(revenueCents * .17) : 0,
        expenseBase = center.id === centers[0].id ? 27_500 : isCommercial ? 8_400 : center.id === centers[2].id ? 11_300 : isDelivery ? 9_200 : 0,
        expenseCents = Math.round(expenseBase * (1 + (month - 1) * .004) * (scenario === "conservative" ? .92 : scenario === "optimistic" ? 1.08 : 1) * 100);
      await db.budgetLine.upsert({ where: { budgetId_costCenterId_month: { budgetId: budget.id, costCenterId: center.id, month } },
        update: { revenueCents, cogsCents, expenseCents, revenue: revenueCents / 100, expense: expenseCents / 100 },
        create: { budgetId: budget.id, costCenterId: center.id, month, revenueCents, cogsCents, expenseCents,
          revenue: revenueCents / 100, expense: expenseCents / 100 } });
    }
  }

  const goalDefinitions = [
    { title: `Atingir receita anual de R$ 1,2 mi em ${year}`, metric: "Receita líquida", unit: "currency", direction: "increase", baseline: 820000, current: 895000, target: 1200000, owner: "Diretoria Comercial", weight: 30, status: "active" },
    { title: "Elevar margem operacional para 24%", metric: "Margem operacional", unit: "percent", direction: "increase", baseline: 17.5, current: 21.2, target: 24, owner: "Controladoria", weight: 25, status: "active" },
    { title: "Reduzir despesas administrativas para 18% da receita", metric: "Despesas / receita", unit: "percent", direction: "decrease", baseline: 23, current: 19.4, target: 18, owner: "Financeiro", weight: 20, status: "active" },
    { title: "Alcançar 95% de cobertura orçamentária", metric: "Cobertura do orçamento", unit: "percent", direction: "increase", baseline: 45, current: 100, target: 95, owner: "Controladoria", weight: 15, status: "achieved" },
    { title: "Implantar forecast semanal automatizado", metric: "Etapas implantadas", unit: "number", direction: "increase", baseline: 0, current: 3, target: 5, owner: "Dados e tecnologia", weight: 10, status: "paused" },
  ] as const;
  for (const definition of goalDefinitions) {
    let goal = await db.businessGoal.findFirst({ where: { title: definition.title } });
    const data = { ...definition, startedAt: new Date(Date.UTC(year, 0, 1)), dueAt: new Date(Date.UTC(year, 11, 31)),
      completedAt: definition.status === "achieved" ? now : null, notes: "Objetivo demonstrativo com acompanhamento executivo.", createdBy: actor };
    goal = goal ? await db.businessGoal.update({ where: { id: goal.id }, data }) : await db.businessGoal.create({ data });
    await db.businessGoalUpdate.deleteMany({ where: { goalId: goal.id, createdBy: actor } });
    const points = definition.direction === "increase"
      ? [definition.baseline, (definition.baseline + definition.current) / 2, definition.current]
      : [definition.baseline, (definition.baseline + definition.current) / 2, definition.current];
    await db.businessGoalUpdate.createMany({ data: points.map((value, index) => ({ goalId: goal!.id, value,
      note: index === 0 ? "Linha de base validada" : index === 1 ? "Revisão mensal do indicador" : "Atualização executiva mais recente",
      createdBy: actor, createdAt: new Date(Date.UTC(year, Math.max(0, currentMonth - 3 + index), 5)) })) });
  }
  console.log(JSON.stringify({ database: identity.database, year, centers: centers.length, budgets: 3,
    goals: goalDefinitions.length, realizedMonths: currentMonth, rules: rules.length }));
}

main().finally(() => db.$disconnect());
