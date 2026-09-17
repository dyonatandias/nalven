import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../generated/tenant/client";

const url = process.env.TENANT_DATABASE_URL;
if (!url) throw new Error("TENANT_DATABASE_URL não definida.");
const db = new PrismaClient({ adapter: new PrismaPg({ connectionString: url }) });

const paymentMethods = ["pix", "credit", "cash", "debit", "bank_transfer"] as const;
const expenseSamples = [
  ["Conta de energia da matriz", 486.72, "2026-09-05", "open", 0, "Distribuidora ABC"],
  ["Internet e telefonia", 219.9, "2026-09-08", "paid", 219.9, null],
  ["Material de limpeza", 174.35, "2026-09-03", "open", 0, "Comercial São Bento"],
  ["Manutenção do ar-condicionado", 680, "2026-08-29", "partial", 300, null],
  ["Aluguel do imóvel", 3250, "2026-09-10", "open", 0, null],
  ["Reposição de embalagens", 342.8, "2026-09-12", "paid", 342.8, "Auto Peças XYZ"],
  ["Serviço de contabilidade", 890, "2026-09-15", "open", 0, null],
  ["Combustível para entregas", 427.6, "2026-09-01", "paid", 427.6, null],
  ["Manutenção preventiva do computador", 310, "2026-08-27", "open", 0, null],
  ["Impressos e bobinas do caixa", 198.4, "2026-09-20", "open", 0, "Distribuidora ABC"],
] as const;

async function main() {
  const branch = await db.branch.findFirst({ where: { status: "active" }, orderBy: { primary: "desc" } });
  if (!branch) throw new Error("Filial ativa não encontrada.");
  const products = await db.product.findMany({ where: { active: true, price: { gt: 0 }, branchConfigurations: { some: { branchId: branch.id, active: true, saleEnabled: true } } }, select: { id: true, name: true, sku: true, unit: true, price: true }, orderBy: { id: "asc" }, take: 30 });
  const customers = await db.customer.findMany({ where: { status: "active" }, select: { id: true, name: true, tradeName: true }, orderBy: { id: "asc" } });
  const suppliers = await db.supplier.findMany({ where: { status: "active" }, select: { id: true, name: true, tradeName: true } });
  if (products.length < 3) throw new Error("São necessários ao menos três produtos ativos.");
  const warehouse = branch.defaultWarehouseId ? await db.warehouse.findUnique({ where: { id: branch.defaultWarehouseId } }) : await db.warehouse.findFirst({ where: { branchId: branch.id, active: true }, orderBy: { primary: "desc" } });

  let salesCreated = 0;
  for (let index = 0; index < 12; index++) {
    const sourceId = `demo-vendas-despesas-v1-${String(index + 1).padStart(2, "0")}`;
    if (await db.sale.findUnique({ where: { sourceType_sourceId: { sourceType: "demo_seed", sourceId } } })) continue;
    const lineCount = 1 + index % 3;
    const chosen = Array.from({ length: lineCount }, (_, itemIndex) => products[(index * 3 + itemIndex * 5) % products.length]);
    const lines = chosen.map((product, itemIndex) => {
      const quantity = 1 + (index + itemIndex) % 3;
      const unitPriceCents = Math.round(product.price * 100);
      const grossCents = unitPriceCents * quantity;
      const discountCents = index % 4 === 0 ? Math.round(grossCents * .05) : 0;
      return { productId: product.id, productName: product.name, skuSnapshot: product.sku, unit: product.unit, quantity, unitPrice: unitPriceCents / 100, total: (grossCents - discountCents) / 100, unitPriceCents, grossCents, discountCents, surchargeCents: 0, totalCents: grossCents - discountCents };
    });
    const subtotalCents = lines.reduce((sum, line) => sum + line.grossCents, 0);
    const discountCents = lines.reduce((sum, line) => sum + line.discountCents, 0);
    const totalCents = subtotalCents - discountCents;
    const customer = index % 4 === 0 ? null : customers[index % Math.max(customers.length, 1)] || null;
    const method = paymentMethods[index % paymentMethods.length];
    const changeCents = method === "cash" ? (1000 - totalCents % 1000) % 1000 : 0;
    const createdAt = new Date(`2026-09-01T${String(Math.min(index, 11)).padStart(2, "0")}:${String((index * 7) % 60).padStart(2, "0")}:00.000Z`);
    await db.sale.create({ data: {
      saleNumber: `VD-DEMO-${String(index + 1).padStart(4, "0")}`,
      customer: customer?.tradeName || customer?.name || "Consumidor final",
      seller: index % 3 === 0 ? "Dyonatan Dias" : index % 3 === 1 ? "Operador Caixa 01" : "Marina Souza",
      cashRegister: "Caixa principal", paymentMethod: method, total: totalCents / 100,
      branchId: branch.id, warehouseId: warehouse?.id || null, customerId: customer?.id || null,
      status: "completed", subtotalCents, discountCents, surchargeCents: 0, totalCents, changeCents,
      sourceType: "demo_seed", sourceId, idempotencyKey: `demo-seed-sale:${sourceId}`, requestHash: `demo:${sourceId}`,
      notes: index % 5 === 0 ? "Venda demonstrativa para treinamento da equipe." : null, createdAt, updatedAt: createdAt,
      items: { create: lines },
    } });
    salesCreated++;
  }

  let expensesCreated = 0;
  for (const [index, sample] of expenseSamples.entries()) {
    const [description, amount, due, status, paidAmount, supplierName] = sample;
    const sourceId = `demo-vendas-despesas-v1-${String(index + 1).padStart(2, "0")}`;
    if (await db.financialTitle.findUnique({ where: { sourceType_sourceId: { sourceType: "demo_expense", sourceId } } })) continue;
    const supplier = supplierName ? suppliers.find(item => item.tradeName === supplierName || item.name.includes(supplierName)) : null;
    const createdAt = new Date(`2026-09-01T${String(1 + index).padStart(2, "0")}:15:00.000Z`);
    const title = await db.financialTitle.create({ data: {
      type: "payable", description, supplierId: supplier?.id || null, documentNumber: `DESP-DEMO-${String(index + 1).padStart(3, "0")}`,
      sourceType: "demo_expense", sourceId, amount, paidAmount, dueAt: new Date(`${due}T12:00:00.000Z`), status,
      paidAt: status === "paid" ? createdAt : null, notes: "Lançamento demonstrativo para treinamento e validação da tela.", createdAt, updatedAt: createdAt,
    } });
    if (paidAmount > 0) await db.financialSettlement.create({ data: { titleId: title.id, amount: paidAmount, method: index % 2 ? "bank_transfer" : "pix", settledBy: "Seed demonstrativo NALVEN", settledAt: createdAt, notes: status === "partial" ? "Pagamento parcial demonstrativo." : "Pagamento demonstrativo." } });
    expensesCreated++;
  }
  const [salesTotal, expensesTotal] = await Promise.all([
    db.sale.count({ where: { sourceType: "demo_seed", sourceId: { startsWith: "demo-vendas-despesas-v1-" } } }),
    db.financialTitle.count({ where: { sourceType: "demo_expense", sourceId: { startsWith: "demo-vendas-despesas-v1-" } } }),
  ]);
  console.log(JSON.stringify({ salesCreated, expensesCreated, salesTotal, expensesTotal, branch: branch.code }));
}

main().finally(async () => db.$disconnect());
