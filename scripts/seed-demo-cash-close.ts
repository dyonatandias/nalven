import { PrismaPg } from "@prisma/adapter-pg";
import { Prisma, PrismaClient } from "../generated/tenant/client";

if (process.env.NALVEN_ALLOW_DEMO_CASH_CLOSE_SEED !== "1")
  throw new Error("Defina NALVEN_ALLOW_DEMO_CASH_CLOSE_SEED=1 para confirmar o seed demonstrativo de fechamento.");
const connectionString = process.env.TENANT_DATABASE_URL;
if (!connectionString) throw new Error("TENANT_DATABASE_URL não foi definida.");
const db = new PrismaClient({ adapter: new PrismaPg({ connectionString }) });
const now = new Date();
const actor = "Seed demonstrativo NALVEN";

async function main() {
  const [identity] = await db.$queryRaw<Array<{ database: string; role: string }>>(Prisma.sql`SELECT current_database() AS database, current_user AS role`);
  if (!identity || identity.database !== "nalven_t_demo" || identity.role !== "nalven_t_demo_runtime")
    throw new Error("O seed de fechamento só pode executar em nalven_t_demo com a credencial runtime.");

  const branch = await db.branch.findFirst({ where: { status: "active" }, orderBy: [{ primary: "desc" }, { id: "asc" }], include: { warehouses: { orderBy: [{ primary: "desc" }, { id: "asc" }], take: 1 } } });
  if (!branch) throw new Error("O seed exige uma filial ativa.");
  const profile = await db.tenantUserProfile.findFirst({ where: { status: "active" }, orderBy: { id: "asc" } });
  const warehouseId = branch.defaultWarehouseId || branch.warehouses[0]?.id || null;
  const registerDefinitions = [
    { code: "PRINCIPAL", name: "Caixa principal" },
    { code: "EXPRESSO-DEMO", name: "Caixa expresso" },
    { code: "BALCAO-DEMO", name: "Caixa balcão" },
  ];
  const registers = [];
  for (const definition of registerDefinitions) registers.push(await db.posRegister.upsert({
    where: { branchId_code: { branchId: branch.id, code: definition.code } },
    update: { name: definition.name, warehouseId, status: "active", settings: { requireOpenShift: true, blindClose: true } },
    create: { ...definition, branchId: branch.id, warehouseId, status: "active", settings: { requireOpenShift: true, blindClose: true } },
  }));

  const operatorNames = [profile?.displayName || "Marina Oliveira", "Carlos Mendes", "Ana Souza", "Rafael Lima"];
  let createdSessions = 0;
  let createdSales = 0;
  let divergentSessions = 0;
  for (let index = 0; index < 36; index += 1) {
    const register = registers[index % registers.length];
    const daysAgo = 35 - index;
    const businessDate = day(daysAgo);
    const stamp = businessDate.toISOString().slice(0, 10).replaceAll("-", "");
    const number = `DEMO-CX-${stamp}-${String((index % registers.length) + 1).padStart(2, "0")}`;
    const openingCents = 20_000 + (index % 3) * 5_000;
    const salesCents = 68_000 + (index * 37_900) % 265_000;
    const suppliesCents = index % 5 === 0 ? 10_000 + (index % 2) * 5_000 : 0;
    const withdrawalsCents = index % 3 === 0 ? 15_000 + (index % 4) * 5_000 : 0;
    const cashSalesCents = Math.round(salesCents * (0.18 + (index % 4) * 0.02));
    const pixCents = Math.round(salesCents * 0.34);
    const creditCents = Math.round(salesCents * 0.31);
    const debitCents = salesCents - cashSalesCents - pixCents - creditCents;
    const cashExpectedCents = openingCents + cashSalesCents + suppliesCents - withdrawalsCents;
    const scenario = divergence(index);
    const differences = { cash: scenario.cash, pix: scenario.pix, credit: scenario.credit, debit: scenario.debit };
    const totalDifferenceCents = Object.values(differences).reduce((sum, value) => sum + value, 0);
    const absoluteDifferenceCents = Object.values(differences).reduce((sum, value) => sum + Math.abs(value), 0);
    if (absoluteDifferenceCents > 0) divergentSessions += 1;
    const openedAt = atHour(businessDate, 8 + index % 3, 5 + index % 4 * 7);
    const closedAt = new Date(openedAt.valueOf() + (6 * 60 + 40 + index % 110) * 60_000);
    const operatorName = operatorNames[index % operatorNames.length];
    let approvalId: string | null = null;
    if (absoluteDifferenceCents > 0) {
      approvalId = `demo-close-approval-${stamp}-${index % registers.length}`;
      if (!await db.posApproval.findUnique({ where: { id: approvalId } })) await db.posApproval.create({ data: {
        id: approvalId, branchId: branch.id, action: "session.close.divergence", entityType: "cash_register_session",
        entityId: number, status: "consumed", requesterId: `demo-operator-${index % operatorNames.length}`,
        requesterName: operatorName, approverId: "demo-supervisor", approverName: "Supervisão demonstrativa",
        reason: scenario.label, context: { demo: true, totalDifferenceCents, absoluteDifferenceCents },
        correlationId: `demo-close-${stamp}-${index % registers.length}`, idempotencyKey: `demo-close-${stamp}-${index % registers.length}`,
        decisionReason: "Cenário demonstrativo revisado pela supervisão.", expiresAt: new Date(closedAt.valueOf() + 30 * 60_000),
        decidedAt: closedAt, consumedAt: closedAt, consumedBy: actor, consumptionRef: number,
      } });
    }
    let session = await db.cashRegisterSession.findUnique({ where: { number } });
    if (!session) {
      session = await db.cashRegisterSession.create({ data: {
        number, registerName: register.name, registerId: register.id, operatorProfileId: index % operatorNames.length === 0 ? profile?.id : null,
        status: "closed", openingAmount: openingCents / 100, openingAmountCents: openingCents,
        expectedAmount: cashExpectedCents / 100, expectedAmountCents: cashExpectedCents,
        closingAmount: (cashExpectedCents + differences.cash) / 100, closingAmountCents: cashExpectedCents + differences.cash,
        difference: differences.cash / 100, differenceCents: totalDifferenceCents, absoluteDifferenceCents,
        openedBy: operatorName, openedByUserId: index % operatorNames.length === 0 ? profile?.userId : null,
        closedBy: operatorName, openedAt, closedAt, businessDate, version: 2,
        openingNotes: "Contagem inicial conferida no início do expediente demonstrativo.",
        closeNotes: absoluteDifferenceCents ? scenario.label : "Contagem conferida sem divergência.", closeApprovalId: approvalId,
      } });
      createdSessions += 1;
    }
    const counts = [
      { method: "cash", provider: "", expectedCents: cashExpectedCents, declaredCents: cashExpectedCents + differences.cash, differenceCents: differences.cash },
      { method: "pix", provider: "pix_demo", expectedCents: pixCents, declaredCents: pixCents + differences.pix, differenceCents: differences.pix },
      { method: "credit", provider: "adquirente_demo", expectedCents: creditCents, declaredCents: creditCents + differences.credit, differenceCents: differences.credit },
      { method: "debit", provider: "adquirente_demo", expectedCents: debitCents, declaredCents: debitCents + differences.debit, differenceCents: differences.debit },
    ];
    for (const count of counts) await db.posSessionPaymentCount.upsert({
      where: { sessionId_method_provider: { sessionId: session.id, method: count.method, provider: count.provider } },
      update: {}, create: { sessionId: session.id, ...count, countedAt: closedAt, details: { demo: true } },
    });
    for (const event of [
      ...(suppliesCents ? [{ type: "supply", amountCents: suppliesCents, description: "Reforço de troco autorizado", reasonCode: "change_fund" }] : []),
      ...(withdrawalsCents ? [{ type: "withdrawal", amountCents: withdrawalsCents, description: "Sangria preventiva para cofre", reasonCode: "cash_limit" }] : []),
    ]) {
      const idempotencyKey = `demo-event-${session.id}-${event.type}`;
      await db.cashRegisterEvent.upsert({ where: { idempotencyKey }, update: {}, create: {
        sessionId: session.id, type: event.type, amount: event.amountCents / 100, amountCents: event.amountCents,
        description: event.description, actor: operatorName, approvedBy: "Supervisão demonstrativa", reasonCode: event.reasonCode,
        correlationId: `demo-event-${session.id}`, idempotencyKey, requestHash: "d".repeat(64), createdAt: new Date(openedAt.valueOf() + 3 * 60 * 60_000),
      } });
    }
    const split = splitCents(salesCents, 3 + index % 3);
    for (const [saleIndex, totalCents] of split.entries()) {
      const sourceId = `${number}-${saleIndex + 1}`;
      if (await db.sale.findUnique({ where: { sourceType_sourceId: { sourceType: "demo_cash_close", sourceId } } })) continue;
      await db.sale.create({ data: {
        saleNumber: `VEN-${stamp}-${String(index + 1).padStart(2, "0")}${saleIndex + 1}`,
        customer: saleIndex % 2 ? "Consumidor final" : "Cliente demonstrativo", seller: operatorName,
        cashRegister: register.name, paymentMethod: ["cash", "pix", "credit", "debit"][saleIndex % 4],
        total: totalCents / 100, totalCents, subtotalCents: totalCents, discountCents: 0, surchargeCents: 0, changeCents: 0,
        branchId: branch.id, warehouseId, sessionId: session.id, operatorProfileId: index % operatorNames.length === 0 ? profile?.id : null,
        status: "completed", sourceType: "demo_cash_close", sourceId, fulfillmentMode: "on_site",
        notes: "Venda sintética exclusiva do ambiente demonstrativo.", createdAt: new Date(openedAt.valueOf() + (saleIndex + 1) * 70 * 60_000),
      } });
      createdSales += 1;
    }
  }
  const counts = await Promise.all([
    db.cashRegisterSession.count({ where: { number: { startsWith: "DEMO-CX-" } } }),
    db.sale.count({ where: { sourceType: "demo_cash_close" } }),
    db.posSessionPaymentCount.count({ where: { session: { number: { startsWith: "DEMO-CX-" } } } }),
    db.cashRegisterEvent.count({ where: { idempotencyKey: { startsWith: "demo-event-" } } }),
  ]);
  console.log(JSON.stringify({ createdSessions, createdSales, divergentSessions, sessions: counts[0], sales: counts[1], paymentCounts: counts[2], events: counts[3] }));
}

function day(daysAgo: number) { return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - daysAgo)); }
function atHour(value: Date, hour: number, minute: number) { const result = new Date(value); result.setUTCHours(hour, minute, 0, 0); return result; }
function splitCents(total: number, count: number) { const base = Math.floor(total / count); const remainder = total - base * count; return Array.from({ length: count }, (_, index) => base + (index < remainder ? 1 : 0)); }
function divergence(index: number) {
  if (index % 11 === 5) return { cash: 500, pix: -500, credit: 0, debit: 0, label: "Diferenças opostas identificadas por meio; saldo líquido zero não elimina a revisão." };
  if (index % 9 === 3) return { cash: -850, pix: 0, credit: 0, debit: 0, label: "Falta de numerário registrada e aprovada para análise demonstrativa." };
  if (index % 8 === 6) return { cash: 0, pix: 0, credit: 125, debit: 0, label: "Pequena diferença de cartão registrada na conferência demonstrativa." };
  if (index % 13 === 9) return { cash: 1_200, pix: 0, credit: 0, debit: -300, label: "Sobra de caixa e ajuste de débito revisados pela supervisão." };
  return { cash: 0, pix: 0, credit: 0, debit: 0, label: "Contagem exata." };
}

main().finally(() => db.$disconnect());
