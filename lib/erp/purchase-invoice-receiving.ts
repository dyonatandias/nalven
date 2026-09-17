import { Prisma } from "@/generated/tenant/client";
import { tenantDb } from "@/db";
import { NfeInputError } from "@/lib/erp/nfe-input";
import { assertFiscalEntryAllowed } from "@/lib/erp/fiscal-import-policy";

type TenantDb = Awaited<ReturnType<typeof tenantDb>>;

export async function receivePurchaseInvoiceRecord(db: TenantDb, id: number, input: { warehouseId: number; dueAt: Date }, user: { id: string; name: string }, correlationId: string) {
  return db.$transaction(async (tx) => {
    await tx.$queryRaw(Prisma.sql`SELECT "id" FROM "purchase_invoices" WHERE "id" = ${id} FOR UPDATE`);
    const invoice = await tx.purchaseInvoice.findUnique({ where: { id }, select: {
      id: true, number: true, series: true, status: true, branchId: true, supplierId: true,
      supplierDocument: true, supplierName: true, total: true,
      items: { select: { id: true, productId: true, quantity: true, unitCost: true, supplierCode: true } },
    } });
    if (!invoice) throw new NfeInputError("NF-e não encontrada.");
    const fiscalDocument = await tx.inboundFiscalDocument.findUnique({ where: { purchaseInvoiceId: invoice.id } });
    if (fiscalDocument) { try { assertFiscalEntryAllowed(fiscalDocument); } catch (error) { throw new NfeInputError((error as Error).message); } }
    if (invoice.status === "received") throw new NfeInputError("Esta NF-e já foi recebida.");
    if (invoice.status !== "matched" || invoice.items.some((item) => !item.productId)) throw new NfeInputError("Confira e vincule todos os itens antes de receber.");
    const warehouse = await tx.warehouse.findFirst({ where: { id: input.warehouseId, active: true }, select: { id: true, branchId: true } });
    if (!warehouse) throw new NfeInputError("Depósito ativo não encontrado.");
    if (invoice.branchId && warehouse.branchId && invoice.branchId !== warehouse.branchId) throw new NfeInputError("O depósito selecionado pertence a outra filial.");
    if (await tx.financialTitle.findUnique({ where: { sourceType_sourceId: { sourceType: "purchase_invoice", sourceId: String(id) } }, select: { id: true } })) throw new NfeInputError("Esta NF-e já possui um título financeiro.");

    const aggregates = new Map<number, { quantity: number; costTotal: number }>();
    for (const item of invoice.items) {
      if (!item.productId) throw new NfeInputError("Todos os itens precisam estar vinculados.");
      const aggregate = aggregates.get(item.productId) || { quantity: 0, costTotal: 0 };
      aggregate.quantity += item.quantity; aggregate.costTotal += item.quantity * item.unitCost; aggregates.set(item.productId, aggregate);
    }
    const productIds = [...aggregates.keys()].sort((left, right) => left - right);
    await tx.$queryRaw(Prisma.sql`SELECT "id" FROM "products" WHERE "id" IN (${Prisma.join(productIds)}) ORDER BY "id" FOR UPDATE`);
    const products = await tx.product.findMany({ where: { id: { in: productIds }, active: true, type: "product" }, select: { id: true, stock: true, cost: true } });
    if (products.length !== productIds.length) throw new NfeInputError("Um produto vinculado foi desativado.");
    for (const productId of productIds) await tx.warehouseBalance.upsert({ where: { warehouseId_productId: { warehouseId: input.warehouseId, productId } }, update: {}, create: { warehouseId: input.warehouseId, productId, quantity: 0 } });
    await tx.$queryRaw(Prisma.sql`SELECT "id" FROM "warehouse_balances" WHERE "warehouse_id" = ${input.warehouseId} AND "product_id" IN (${Prisma.join(productIds)}) ORDER BY "product_id" FOR UPDATE`);
    const balances = await tx.warehouseBalance.findMany({ where: { warehouseId: input.warehouseId, productId: { in: productIds } }, select: { id: true, productId: true, quantity: true } });
    const productById = new Map(products.map((product) => [product.id, product])), balanceByProduct = new Map(balances.map((balance) => [balance.productId, balance]));
    for (const [productId, aggregate] of aggregates) {
      const product = productById.get(productId), balance = balanceByProduct.get(productId);
      if (!product || !balance) throw new NfeInputError("Não foi possível preparar o saldo do produto.");
      const stockBasis = Math.max(0, product.stock), stockAfter = product.stock + aggregate.quantity;
      const weightedCost = round4((stockBasis * product.cost + aggregate.costTotal) / (stockBasis + aggregate.quantity));
      await tx.product.update({ where: { id: productId }, data: { stock: { increment: aggregate.quantity }, cost: weightedCost, supplier: invoice.supplierName, lastPurchaseAt: new Date() } });
      await tx.warehouseBalance.update({ where: { id: balance.id }, data: { quantity: { increment: aggregate.quantity } } });
      await tx.stockMovement.create({ data: { productId, warehouseId: input.warehouseId, type: "entry", quantity: aggregate.quantity, previousStock: product.stock, currentStock: stockAfter, note: `NF-e ${invoice.number}/${invoice.series}`, userName: user.name } });
      await tx.warehouseLedgerEntry.create({ data: { warehouseId: input.warehouseId, productId, type: "purchase_invoice", quantity: aggregate.quantity, balanceBefore: balance.quantity, balanceAfter: balance.quantity + aggregate.quantity, referenceType: "purchase_invoice", referenceId: String(invoice.id), actor: user.name } });
    }
    const supplier = await tx.supplier.upsert({ where: { document: invoice.supplierDocument }, update: { name: invoice.supplierName, status: "active" }, create: { name: invoice.supplierName, tradeName: invoice.supplierName, document: invoice.supplierDocument, status: "active" }, select: { id: true } });
    for (const item of invoice.items) if (item.productId) await tx.supplierProduct.upsert({ where: { supplierId_productId: { supplierId: supplier.id, productId: item.productId } }, update: { supplierCode: item.supplierCode, lastCost: item.unitCost }, create: { supplierId: supplier.id, productId: item.productId, supplierCode: item.supplierCode, lastCost: item.unitCost } });
    await tx.financialTitle.create({ data: { type: "payable", description: `NF-e ${invoice.number} · ${invoice.supplierName}`, supplierId: supplier.id, documentNumber: `${invoice.number}/${invoice.series}`, sourceType: "purchase_invoice", sourceId: String(invoice.id), amount: invoice.total, dueAt: input.dueAt } });
    const receivedAt = new Date();
    await tx.purchaseInvoice.update({ where: { id: invoice.id }, data: { status: "received", supplierId: supplier.id, warehouseId: input.warehouseId, receivedAt, dueAt: input.dueAt } });
    const inbound = await tx.inboundFiscalDocument.findUnique({ where: { purchaseInvoiceId: invoice.id } });
    if (inbound) {
      await tx.inboundFiscalDocument.update({ where: { id: inbound.id }, data: { status: "received", reviewedBy: user.name, reviewedAt: receivedAt } });
      await tx.inboundFiscalDocumentEvent.create({ data: { documentId: inbound.id, type: "dfe.document.received", actorId: user.id, correlationId, metadata: { purchaseInvoiceId: invoice.id, warehouseId: input.warehouseId, automatic: user.id === "system:dfe-sync" } } });
    }
    await tx.tenantAuditEvent.create({ data: { actorId: user.id, action: "purchase_invoice.received", entityType: "purchase_invoice", entityId: String(invoice.id), correlationId, beforeData: { status: invoice.status }, afterData: { status: "received", warehouseId: input.warehouseId, total: invoice.total, itemCount: invoice.items.length, productCount: aggregates.size, dueAt: input.dueAt.toISOString().slice(0, 10), automatic: user.id === "system:dfe-sync" } } });
    return { id: invoice.id, receivedAt };
  }, { isolationLevel: "Serializable", maxWait: 5_000, timeout: 30_000 });
}

export async function autoReceiveEligibility(db: TenantDb, invoiceId: number, warehouseId: number) {
  const invoice = await db.purchaseInvoice.findUnique({ where: { id: invoiceId }, select: {
    status: true, branchId: true, supplier: { select: { status: true, homologationStatus: true } },
    items: { select: { productId: true, matchConfidence: true, product: { select: { active: true, onboardingStatus: true } } } },
  } });
  const warehouse = await db.warehouse.findFirst({ where: { id: warehouseId, active: true }, select: { branchId: true } });
  if (!invoice || !warehouse || invoice.status !== "matched") return { eligible: false, reason: "Entrada ou depósito indisponível" };
  if (invoice.branchId && warehouse.branchId && invoice.branchId !== warehouse.branchId) return { eligible: false, reason: "Depósito de outra filial" };
  if (invoice.supplier?.status !== "active" || invoice.supplier.homologationStatus !== "approved") return { eligible: false, reason: "Fornecedor aguarda revisão e homologação" };
  const fiscalDocument = await db.inboundFiscalDocument.findUnique({ where: { purchaseInvoiceId: invoiceId } });
  if (fiscalDocument) { try { assertFiscalEntryAllowed(fiscalDocument); } catch { return { eligible: false, reason: "Documento fiscal não permite recebimento" }; } }
  if (invoice.items.some((item) => !item.productId || !item.product?.active || item.product.onboardingStatus !== "complete" || (item.matchConfidence || 0) < 95)) return { eligible: false, reason: "Produto novo, incompleto ou vínculo abaixo de 95%" };
  return { eligible: true, reason: "Todos os critérios automáticos foram comprovados" };
}

function round4(value: number) { return Math.round(value * 10_000) / 10_000; }
