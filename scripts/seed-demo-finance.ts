import { PrismaPg } from "@prisma/adapter-pg";
import { Prisma, PrismaClient } from "../generated/tenant/client";
import { createHash } from "node:crypto";

if (process.env.NALVEN_ALLOW_DEMO_FINANCE_SEED !== "1")
  throw new Error("Defina NALVEN_ALLOW_DEMO_FINANCE_SEED=1 para confirmar o seed financeiro demonstrativo.");
const connectionString = process.env.TENANT_DATABASE_URL;
if (!connectionString) throw new Error("TENANT_DATABASE_URL não foi definida.");
const db = new PrismaClient({ adapter: new PrismaPg({ connectionString }) });
const actor = "Seed financeiro NALVEN";
const now = new Date();
const day = (offset: number) => new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + offset));

async function ensureAccountEntry(definition: { accountId: number; type: "credit" | "debit"; amount: number; description: string;
  reference: string; sourceType: string; sourceId: string; occurredAt: Date }) {
  await db.$transaction(async (tx) => {
    await tx.$queryRaw(Prisma.sql`SELECT "id" FROM "financial_accounts" WHERE "id"=${definition.accountId} FOR UPDATE`);
    const existing = await tx.accountEntry.findUnique({ where: { sourceType_sourceId_accountId: {
      sourceType: definition.sourceType, sourceId: definition.sourceId, accountId: definition.accountId } }, select: { id: true } });
    if (existing) return;
    const account = await tx.financialAccount.findUniqueOrThrow({ where: { id: definition.accountId }, select: { currentBalanceCents: true } });
    const amountCents = Math.round(definition.amount * 100);
    const delta = definition.type === "credit" ? amountCents : -amountCents;
    await tx.accountEntry.create({ data: { ...definition, amount: definition.amount, amountCents,
      balanceAfterCents: account.currentBalanceCents + delta, createdBy: actor } });
    await tx.financialAccount.update({ where: { id: definition.accountId }, data: {
      currentBalance: { increment: delta / 100 }, currentBalanceCents: { increment: delta }, version: { increment: 1 } } });
  }, { isolationLevel: "Serializable" });
}

async function main() {
  const [identity] = await db.$queryRaw<Array<{ database: string; role: string }>>(Prisma.sql`SELECT current_database() AS database, current_user AS role`);
  if (!identity || identity.database !== "nalven_t_demo" || identity.role !== "nalven_t_demo_runtime")
    throw new Error("O seed financeiro só pode executar em nalven_t_demo com a credencial runtime.");

  const [branch, customers, suppliers] = await Promise.all([
    db.branch.findFirst({ where: { status: "active" }, orderBy: [{ primary: "desc" }, { id: "asc" }] }),
    db.customer.findMany({ where: { status: "active" }, orderBy: { id: "asc" }, take: 8 }),
    db.supplier.findMany({ where: { status: "active" }, orderBy: { id: "asc" }, take: 8 }),
  ]);
  if (!branch || customers.length < 2 || suppliers.length < 2)
    throw new Error("O seed exige uma filial, dois clientes e dois fornecedores ativos.");

  const accounts = [];
  for (const definition of [
    { code: "BANCO-NALVEN", name: "Banco NALVEN · Conta movimento", type: "bank", openingBalance: 86_450.3, creditLimit: 25_000,
      institutionName: "Banco NALVEN", bankCode: "077", agency: "0001", accountNumberLast4: "8421", color: "#168151", description: "Conta operacional para recebimentos, pagamentos e conciliação diária." },
    { code: "CAIXA-MATRIZ", name: "Caixa da matriz", type: "cash", openingBalance: 4_280.75, creditLimit: 0,
      institutionName: null, bankCode: null, agency: null, accountNumberLast4: null, color: "#D79424", description: "Numerário da tesouraria e pequenos desembolsos da matriz." },
    { code: "WALLET-MARKET", name: "Carteira digital · Marketplaces", type: "wallet", openingBalance: 18_930.4, creditLimit: 3_000,
      institutionName: "Hub de marketplaces", bankCode: null, agency: null, accountNumberLast4: "7788", color: "#347EAC", description: "Recebíveis de canais digitais aguardando repasse." },
    { code: "INV-RESERVA", name: "Reserva de liquidez", type: "investment", openingBalance: 120_000, creditLimit: 0,
      institutionName: "Corretora NALVEN", bankCode: null, agency: "INV-01", accountNumberLast4: "4026", color: "#6B5FA7", description: "Aplicação de curto prazo para reserva operacional." },
    { code: "BANCO-FOLHA", name: "Conta exclusiva · Folha", type: "bank", openingBalance: 32_750, creditLimit: 8_000,
      institutionName: "Banco Cooperativo", bankCode: "756", agency: "3189", accountNumberLast4: "2104", color: "#B65A4C", description: "Conta segregada para salários, benefícios e encargos." },
  ] as const) {
    const existing = await db.financialAccount.findUnique({ where: { code: definition.code } }) ||
      await db.financialAccount.findFirst({ where: { name: definition.name } });
    const openingBalanceCents = Math.round(definition.openingBalance * 100);
    const creditLimitCents = Math.round(definition.creditLimit * 100);
    const data = { ...definition, branchId: branch.id, openingBalanceCents, creditLimitCents, active: true };
    accounts.push(existing
      ? await db.financialAccount.update({ where: { id: existing.id }, data })
      : await db.financialAccount.create({ data: { ...data, currentBalance: definition.openingBalance,
        currentBalanceCents: openingBalanceCents } }));
  }
  const centers = [];
  for (const definition of [
    { code: "ADM-DEMO", name: "Administrativo" },
    { code: "COM-DEMO", name: "Comercial e marketing" },
    { code: "LOG-DEMO", name: "Operações e logística" },
    { code: "TEC-DEMO", name: "Tecnologia e serviços" },
  ]) centers.push(await db.costCenter.upsert({ where: { code: definition.code }, update: { name: definition.name, active: true }, create: definition }));

  const definitions = [
    ["receivable", "Mensalidade de suporte empresarial", 4890, -96, "paid", "Serviços", 0, "normal"],
    ["receivable", "Projeto de implantação ERP", 12800, -62, "paid", "Serviços", 1, "high"],
    ["payable", "Frete consolidado regional", 3650, -48, "paid", "Logística", 2, "normal"],
    ["payable", "Licenças de infraestrutura", 2890, -33, "paid", "Assinaturas", 3, "normal"],
    ["receivable", "Fatura comercial em cobrança", 7420, -27, "partial", "Vendas", 0, "urgent"],
    ["payable", "Serviço de armazenagem", 5180, -18, "open", "Logística", 2, "urgent"],
    ["receivable", "Parcela de contrato anual", 6350, -12, "open", "Serviços", 3, "urgent"],
    ["payable", "Agência de performance", 4260, -8, "partial", "Marketing", 1, "high"],
    ["receivable", "Venda corporativa · pedido 1842", 9340, -4, "open", "Vendas", 1, "high"],
    ["payable", "Guia tributária estadual", 6725, 0, "open", "Impostos", 0, "urgent"],
    ["receivable", "Recebimento via marketplace", 3840, 1, "open", "Vendas", 1, "normal"],
    ["payable", "Fornecedor de embalagens", 2980, 2, "open", "Fornecedores", 2, "normal"],
    ["receivable", "Contrato de manutenção · 1/4", 5250, 4, "open", "Serviços", 3, "normal"],
    ["payable", "Folha complementar", 8840, 5, "open", "Folha", 0, "high"],
    ["receivable", "Projeto de integração fiscal", 11750, 7, "open", "Serviços", 3, "high"],
    ["payable", "Compra de componentes", 14300, 9, "open", "Fornecedores", 2, "normal"],
    ["receivable", "Contrato de manutenção · 2/4", 5250, 34, "open", "Serviços", 3, "normal"],
    ["payable", "Aluguel do centro de distribuição", 9800, 35, "open", "Infraestrutura", 2, "normal"],
    ["receivable", "Contrato de manutenção · 3/4", 5250, 64, "open", "Serviços", 3, "normal"],
    ["payable", "Renovação anual de seguros", 6340, 70, "open", "Administrativo", 0, "low"],
    ["receivable", "Negociação cancelada", 2190, 18, "cancelled", "Vendas", 1, "low"],
    ["payable", "Pedido de mídia cancelado", 1750, 22, "cancelled", "Marketing", 1, "low"],
  ] as const;

  for (const [index, definition] of definitions.entries()) {
    const [type, description, amount, dueOffset, status, category, centerIndex, priority] = definition;
    const paidAmount = status === "paid" ? amount : status === "partial" ? Math.round(amount * .4 * 100) / 100 : 0;
    const sourceId = `FIN-DEMO-${String(index + 1).padStart(3, "0")}`;
    const isReceivable = type === "receivable";
    const title = await db.financialTitle.upsert({
      where: { sourceType_sourceId: { sourceType: "demo_finance", sourceId } },
      update: { description, amount, paidAmount, dueAt: day(dueOffset), status, category, priority, branchId: branch.id, accountId: accounts[index % accounts.length].id, costCenterId: centers[centerIndex].id },
      create: {
        type, description, amount, paidAmount, dueAt: day(dueOffset), issueAt: day(dueOffset - 20), competenceAt: day(dueOffset - 30), status,
        category, priority, branchId: branch.id, accountId: accounts[index % accounts.length].id, costCenterId: centers[centerIndex].id,
        customerId: isReceivable ? customers[index % customers.length].id : null, supplierId: isReceivable ? null : suppliers[index % suppliers.length].id,
        documentNumber: `DOC-${String(2026000 + index + 1)}`, paymentMethod: index % 3 === 0 ? "boleto" : index % 3 === 1 ? "pix" : "bank_transfer",
        recurrenceKey: index >= 12 && index <= 18 ? "CONTRATO-DEMO-2026" : null, installmentNumber: index >= 12 && index <= 18 ? Math.floor((index - 12) / 2) + 1 : null, installmentCount: index >= 12 && index <= 18 ? 4 : null,
        notes: status === "partial" ? "Baixa parcial demonstrativa; saldo restante requer acompanhamento." : "Cenário financeiro demonstrativo para análise da carteira.", sourceType: "demo_finance", sourceId,
      },
    });
    if (paidAmount > 0 && !await db.financialSettlement.findFirst({ where: { titleId: title.id, notes: `seed:${sourceId}` } }))
      await db.financialSettlement.create({ data: { titleId: title.id, accountId: accounts[index % accounts.length].id, amount: paidAmount, interest: index === 4 ? 32.5 : 0, fee: isReceivable && index % 2 ? 4.9 : 0, discount: 0, method: index % 2 ? "pix" : "bank_transfer", status: "posted", occurredAt: day(Math.min(dueOffset, -1)), settledBy: actor, notes: `seed:${sourceId}` } });
  }

  const treasuryEntries = [
    [0, "credit", 18_420.5, -29, "Recebimentos PIX do lote comercial", "PIX-LOTE-0901"],
    [0, "debit", 12_780.2, -26, "Pagamento consolidado a fornecedores", "PAG-FORN-0826"],
    [1, "credit", 2_600, -24, "Reforço de numerário para operação", "SUPRIMENTO-024"],
    [1, "debit", 845.7, -22, "Despesas operacionais de pequeno valor", "CAIXA-022"],
    [2, "credit", 9_870.35, -19, "Repasse do marketplace principal", "REPASSE-MKT-019"],
    [2, "debit", 1_245.6, -17, "Tarifas e ajustes dos canais digitais", "TARIFA-MKT-017"],
    [3, "credit", 8_000, -15, "Aplicação programada da sobra de caixa", "APL-015"],
    [4, "debit", 14_950.8, -13, "Folha e benefícios da primeira quinzena", "FOLHA-013"],
    [0, "credit", 23_610.9, -11, "Liquidação de boletos da carteira B2B", "BOL-B2B-011"],
    [0, "debit", 6_725, -9, "Recolhimento de guia tributária", "GUIA-009"],
    [1, "credit", 1_500, -8, "Venda presencial recebida em espécie", "VENDA-CX-008"],
    [1, "debit", 420.3, -7, "Fundo fixo para equipe externa", "FUNDO-007"],
    [2, "credit", 6_435.45, -6, "Recebíveis liberados do canal direto", "REPASSE-DIR-006"],
    [4, "credit", 18_000, -5, "Aporte para cobertura da folha mensal", "APORTE-FOLHA-005"],
    [3, "debit", 5_000, -4, "Resgate parcial para capital de giro", "RESGATE-004"],
    [0, "debit", 3_980.75, -3, "Fretes e armazenagem consolidados", "LOG-003"],
    [0, "credit", 7_420, -2, "Recebimento parcial de fatura comercial", "FAT-002"],
    [2, "debit", 980.4, -1, "Chargebacks e taxas de antecipação", "AJUSTE-MKT-001"],
    [1, "credit", 890, 0, "Abertura reforçada do caixa da matriz", "ABERTURA-HOJE"],
    [0, "debit", 2_890, 0, "Renovação de infraestrutura mensal", "INFRA-HOJE"],
  ] as const;
  for (const [index, [accountIndex, type, amount, offset, description, reference]] of treasuryEntries.entries())
    await ensureAccountEntry({ accountId: accounts[accountIndex].id, type, amount, description, reference,
      sourceType: "demo_treasury", sourceId: `TREASURY-DEMO-${String(index + 1).padStart(3, "0")}`, occurredAt: day(offset) });

  const transferDefinitions = [
    { key: "DEMO-TRANSFER-001", from: 0, to: 1, amount: 3_000, offset: -10, description: "Suprimento semanal do caixa físico", reversed: false },
    { key: "DEMO-TRANSFER-002", from: 0, to: 4, amount: 10_000, offset: -5, description: "Provisionamento complementar da folha", reversed: false },
    { key: "DEMO-TRANSFER-003", from: 2, to: 0, amount: 4_500, offset: -2, description: "Centralização de recebíveis digitais", reversed: false },
    { key: "DEMO-TRANSFER-004", from: 3, to: 0, amount: 7_500, offset: -1, description: "Resgate duplicado identificado pela tesouraria", reversed: true },
  ] as const;
  for (const definition of transferDefinitions) {
    let transfer = await db.accountTransfer.findUnique({ where: { idempotencyKey: definition.key } });
    if (!transfer) transfer = await db.accountTransfer.create({ data: { fromAccountId: accounts[definition.from].id,
      toAccountId: accounts[definition.to].id, amount: definition.amount, amountCents: Math.round(definition.amount * 100),
      description: definition.description, idempotencyKey: definition.key, transferredBy: actor, createdAt: day(definition.offset) } });
    await ensureAccountEntry({ accountId: transfer.fromAccountId, type: "debit", amount: definition.amount,
      description: `Transferência para ${accounts[definition.to].name}`, reference: definition.description,
      sourceType: "transfer", sourceId: `${transfer.id}:out`, occurredAt: day(definition.offset) });
    await ensureAccountEntry({ accountId: transfer.toAccountId, type: "credit", amount: definition.amount,
      description: `Transferência de ${accounts[definition.from].name}`, reference: definition.description,
      sourceType: "transfer", sourceId: `${transfer.id}:in`, occurredAt: day(definition.offset) });
    if (definition.reversed) {
      const reason = "Transferência simulada em duplicidade; estorno demonstrativo.";
      await ensureAccountEntry({ accountId: transfer.toAccountId, type: "debit", amount: definition.amount,
        description: `Estorno de transferência para ${accounts[definition.from].name}`, reference: reason,
        sourceType: "transfer_reversal", sourceId: `${transfer.id}:reversal:out`, occurredAt: day(0) });
      await ensureAccountEntry({ accountId: transfer.fromAccountId, type: "credit", amount: definition.amount,
        description: `Estorno de transferência de ${accounts[definition.to].name}`, reference: reason,
        sourceType: "transfer_reversal", sourceId: `${transfer.id}:reversal:in`, occurredAt: day(0) });
      if (transfer.status !== "reversed") transfer = await db.accountTransfer.update({ where: { id: transfer.id }, data: {
        status: "reversed", reversalIdempotencyKey: `${definition.key}-REV`, reversedAt: day(0), reversedBy: actor, reversalReason: reason } });
    }
  }

  const statementDefinitions = [
    { key: "DEMO-EXTRATO-CONTA-MOVIMENTO-01", account: 0, fileName: "extrato-banco-nalven-setembro.csv", rows: [
      ["DEMO-BANK-001", -12, "Crédito contrato anual DOC-2026007", 6350, "TED", "DOC-2026007", "pending", null],
      ["DEMO-BANK-002", 0, "Pagamento guia estadual DOC-2026010", -6725, "PAGAMENTO", "DOC-2026010", "pending", null],
      ["DEMO-BANK-003", -1, "Repasse marketplace DOC-2026011", 3840, "PIX", "DOC-2026011", "pending", null],
      ["DEMO-BANK-004", 0, "Fornecedor de embalagens DOC-2026012", -2980, "PIX", "DOC-2026012", "pending", null],
      ["DEMO-BANK-005", -6, "Venda balcão consolidada", 2190, "PIX", "LOTE-2190", "reconciled", "Vendas"],
      ["DEMO-BANK-006", -5, "Tarifa de emissão já contabilizada", -45, "TARIFA", "TAR-045", "ignored", null],
    ] },
    { key: "DEMO-EXTRATO-CONTA-FOLHA-01", account: 4, fileName: "conta-folha-movimentos.ofx", rows: [
      ["DEMO-BANK-007", 0, "Folha complementar DOC-2026014", -8840, "PAGAMENTO", "DOC-2026014", "pending", null],
      ["DEMO-BANK-008", -17, "Serviço de armazenagem DOC-2026006", -5180, "TED", "DOC-2026006", "pending", null],
      ["DEMO-BANK-009", 0, "Projeto integração fiscal DOC-2026015", 11750, "TED", "DOC-2026015", "pending", null],
      ["DEMO-BANK-010", -8, "Adiantamento salarial eventual", -1800, "PIX", "FOLHA-EVT", "reconciled", "Folha"],
      ["DEMO-BANK-011", -4, "Crédito de validação bancária", 100, "CRÉDITO", "TESTE-100", "ignored", null],
      ["DEMO-BANK-012", -8, "Agência performance DOC-2026008", -2556, "PIX", "DOC-2026008", "pending", null],
    ] },
    { key: "DEMO-EXTRATO-CONTA-MOVIMENTO-02", account: 0, fileName: "extrato-banco-nalven-complementar.csv", rows: [
      ["DEMO-BANK-013", -4, "Venda corporativa pedido 1842 DOC-2026009", 9340, "BOLETO", "DOC-2026009", "pending", null],
      ["DEMO-BANK-014", 0, "Contrato manutenção parcela DOC-2026013", 5250, "PIX", "DOC-2026013", "pending", null],
      ["DEMO-BANK-015", 0, "Compra componentes DOC-2026016", -14300, "TED", "DOC-2026016", "pending", null],
      ["DEMO-BANK-016", -3, "Pacote mensal de tarifas", -890, "TARIFA", "TAR-PACOTE", "reconciled", "Tarifas bancárias"],
      ["DEMO-BANK-017", -2, "Receita de treinamento avulso", 1250, "PIX", "TREINAMENTO", "reconciled", "Serviços"],
      ["DEMO-BANK-018", -1, "Débito temporário de homologação", -0.01, "DÉBITO", "HOMOLOG-001", "ignored", null],
      ["DEMO-BANK-019", 0, "Renovação de seguros DOC-2026020", -6340, "DÉBITO", "DOC-2026020", "pending", null],
    ] },
  ] as const;
  for (const definition of statementDefinitions) {
    const account = accounts[definition.account];
    const totalCreditCents = definition.rows.reduce((sum, row) => sum + Math.max(Math.round(Number(row[3]) * 100), 0), 0);
    const totalDebitCents = definition.rows.reduce((sum, row) => sum + Math.max(-Math.round(Number(row[3]) * 100), 0), 0);
    const digest = createHash("sha256").update(definition.key).digest("hex");
    let statementImport = await db.bankStatementImport.findUnique({ where: { digest } });
    if (!statementImport) statementImport = await db.bankStatementImport.create({ data: { accountId: account.id,
      fileName: definition.fileName, format: definition.fileName.endsWith(".ofx") ? "ofx" : "csv", fileSize: 2_048 + definition.rows.length * 137,
      digest, rowCount: definition.rows.length, importedRowCount: definition.rows.length, duplicateRowCount: 0,
      totalCreditCents, totalDebitCents, periodStart: day(Math.min(...definition.rows.map((row) => Number(row[1])))),
      periodEnd: day(Math.max(...definition.rows.map((row) => Number(row[1])))), status: "completed", importedBy: actor,
      correlationId: `DEMO-IMPORT-${digest.slice(0, 16)}` } });
    for (const row of definition.rows) {
      const [externalId, offset, description, amount, bankReference, documentNumber, status, category] = row;
      let transaction = await db.bankTransaction.findUnique({ where: { accountId_externalId: { accountId: account.id, externalId } } });
      if (!transaction) transaction = await db.bankTransaction.create({ data: { importId: statementImport.id, accountId: account.id,
        externalId, occurredAt: day(offset), description, amount, amountCents: Math.round(amount * 100), bankReference,
        documentNumber, status, category, resolutionType: status === "reconciled" ? "manual" : status === "ignored" ? "ignored" : null,
        resolutionReason: status === "reconciled" ? "Movimento demonstrativo classificado após conferência do extrato." :
          status === "ignored" ? "Movimento demonstrativo sem efeito financeiro, mantido para auditoria." : null,
        reconciliationSequence: status === "reconciled" ? 1 : 0, reconciledBy: status === "pending" ? null : actor,
        reconciledAt: status === "pending" ? null : day(offset), correlationId: `DEMO-RECON-${externalId}` } });
      if (transaction.status === "reconciled") await ensureAccountEntry({ accountId: account.id,
        type: transaction.amountCents > 0 ? "credit" : "debit", amount: Math.abs(transaction.amountCents) / 100,
        description: transaction.description, reference: transaction.externalId, sourceType: "bank_transaction",
        sourceId: `${transaction.id}:${transaction.reconciliationSequence}`, occurredAt: transaction.occurredAt });
    }
  }

  const counts = await Promise.all([
    db.financialTitle.count({ where: { sourceType: "demo_finance" } }),
    db.financialSettlement.count({ where: { title: { sourceType: "demo_finance" } } }),
    db.financialAccount.count({ where: { active: true } }),
    db.costCenter.count({ where: { active: true } }),
    db.accountEntry.count({ where: { sourceType: { in: ["demo_treasury", "transfer", "transfer_reversal"] }, createdBy: actor } }),
    db.accountTransfer.count({ where: { transferredBy: actor } }),
    db.bankStatementImport.count({ where: { importedBy: actor } }),
    db.bankTransaction.count({ where: { statementImport: { importedBy: actor } } }),
  ]);
  console.log(JSON.stringify({ titles: counts[0], settlements: counts[1], accounts: counts[2], costCenters: counts[3],
    accountEntries: counts[4], transfers: counts[5], statementImports: counts[6], bankTransactions: counts[7] }));
}

main().finally(() => db.$disconnect());
