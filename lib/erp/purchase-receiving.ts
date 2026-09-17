import { randomUUID } from "node:crypto";
import { Prisma, type PrismaClient } from "@/generated/tenant/client";
import { PurchaseInputError, receiptInput } from "./purchase-input";
import { applyPosCommonStockChange, stockMode } from "./pos-common-stock";
import { normalizePosTrackingIdentity } from "./pos-inventory-tracking";
import { posBusinessDate } from "./pos-inventory-operations";
import { lockProductionStock, preserveUntrackedStock } from "./production-stock";
import { cents, dateOnly, materialCost, object, quantity, requestHash, safeJson, uuid, weightedAverageCost, ZERO } from "./production-domain";

export const purchaseOrderDetailInclude = {
  supplier: { select: { id: true, name: true, tradeName: true } },
  items: { include: { product: { select: { id: true, name: true, sku: true, unit: true } }, variation: { select: { id: true, sku: true, attributes: true } } }, orderBy: { id: "asc" as const } },
  receipts: { select: { id: true, number: true, receivedAt: true, warehouseId: true }, orderBy: { receivedAt: "desc" as const } },
} satisfies Prisma.PurchaseOrderInclude;

/** A receipt, its dimensioned stock movements and payable commit with the replay key. */
export async function receivePurchaseOrder(db: PrismaClient, orderId: number, raw: Record<string, unknown>, actor: { id: string; name: string }, defaultWarehouseId: number | null) {
  const key = uuid(raw.idempotencyKey), input = receiptInput(raw);
  const hash = requestHash({ ...raw, orderId, actorId: actor.id });
  const run = () => db.$transaction(async tx => {
    await tx.$queryRaw`SELECT 1 AS locked FROM pg_advisory_xact_lock(hashtextextended(${`purchase-receipt:${key}`},0))`;
    const prior = await tx.goodsReceipt.findUnique({ where: { idempotencyKey: key } });
    if (prior) {
      if (prior.requestHash !== hash || prior.purchaseOrderId !== orderId) throw new PurchaseInputError("Esta chave de recebimento já foi usada com outro conteúdo ou usuário.");
      return { receipt: prior, order: await tx.purchaseOrder.findUniqueOrThrow({ where: { id: orderId }, include: purchaseOrderDetailInclude }), correlationId: key };
    }
    await tx.$queryRaw`SELECT id FROM purchase_orders WHERE id=${orderId} FOR UPDATE`;
    const order = await tx.purchaseOrder.findUniqueOrThrow({ where: { id: orderId }, include: { supplier: true, items: true } });
    if (!["ordered", "partially_received"].includes(order.status)) throw new PurchaseInputError("O pedido precisa estar enviado e pendente de recebimento.");
    const origins = await tx.productionProcurement.findMany({ where: { purchaseOrderId: orderId }, include: { order: { select: { warehouseId: true } } } });
    const destinations = [...new Set(origins.map(row => row.order.warehouseId))];
    if (destinations.length > 1) throw new PurchaseInputError("Esta compra possui necessidades de depósitos diferentes; separe os pedidos antes de receber.");
    const requestedWarehouse = raw.warehouseId == null || raw.warehouseId === "" ? null : Number(raw.warehouseId);
    if (requestedWarehouse !== null && (!Number.isSafeInteger(requestedWarehouse) || requestedWarehouse <= 0)) throw new PurchaseInputError("Depósito inválido.");
    if (destinations.length && requestedWarehouse !== null && requestedWarehouse !== destinations[0]) throw new PurchaseInputError("Receba no depósito vinculado à ordem de produção.");
    const warehouseId = destinations[0] ?? requestedWarehouse ?? defaultWarehouseId;
    if (!warehouseId) throw new PurchaseInputError("Selecione um depósito ativo para receber a compra.");
    const warehouse = await tx.warehouse.findFirst({ where: { id: warehouseId, active: true }, include: { branch: true } });
    if (!warehouse || (warehouse.branch && warehouse.branch.status !== "active")) throw new PurchaseInputError("Depósito ou filial inativos.");
    const indexed = new Map(order.items.map(item => [item.id, item]));
    for (const row of input.items) {
      const item = indexed.get(row.itemId);
      if (!item || quantity(row.quantity) > quantity(item.quantity) - quantity(item.receivedQuantity, true)) throw new PurchaseInputError("Item inválido ou quantidade acima do saldo pendente do pedido.");
    }
    await lockProductionStock(tx, warehouseId, input.items.map(row => indexed.get(row.itemId)!.productId));
    const receipt = await tx.goodsReceipt.create({ data: { number: `REC-${randomUUID().slice(0,12).toUpperCase()}`, purchaseOrderId: orderId, warehouseId, receivedBy: actor.name, notes: input.notes, idempotencyKey: key, requestHash: hash } });
    const rawRows = (raw.items as unknown[]).map(object);
    for (const row of [...input.items].sort((a,b) => indexed.get(a.itemId)!.productId - indexed.get(b.itemId)!.productId)) {
      const item = indexed.get(row.itemId)!;
      const product = await tx.product.findUniqueOrThrow({ where: { id: item.productId }, include: { variations: true } });
      const variation = item.variationId === null ? null : product.variations.find(variant => variant.id === item.variationId && variant.enabled) ?? null;
      if (!product.active || (item.variationId !== null && !variation)) throw new PurchaseInputError("Produto ou variação inativos.");
      if (product.catalogType === "variable" && !variation) throw new PurchaseInputError("O pedido precisa identificar a variação antes do recebimento.");
      const tracking = stockMode(product.type, product.manageStock, variation?.manageStock) === "none" ? [] : await receiveStock(tx, { warehouseId, product, variation, quantity: row.quantity, receiptId: receipt.id, receiptNumber: receipt.number, itemId: item.id, key, actor: actor.name, businessDate: posBusinessDate(warehouse.branch?.timezone || "America/Sao_Paulo"), raw: rawRows.find(rawRow => Number(rawRow.itemId) === item.id)! });
      const changed = await tx.purchaseOrderItem.updateMany({ where: { id: item.id, receivedQuantity: item.receivedQuantity }, data: { receivedQuantity: { increment: row.quantity } } });
      if (changed.count !== 1) throw new PurchaseInputError("O saldo do pedido mudou. Atualize antes de continuar.");
      await tx.goodsReceiptItem.create({ data: { goodsReceiptId: receipt.id, purchaseOrderItemId: item.id, productId: item.productId, variationId: item.variationId, quantity: row.quantity, unitCost: item.unitCost, tracking: safeJson(tracking) } });
      const cost = product.stock > 0 ? weightedAverageCost(product.stock, product.cost, quantity(row.quantity), materialCost(quantity(row.quantity), cents(Math.round(item.unitCost * 100)))) : item.unitCost;
      await tx.product.update({ where: { id: product.id }, data: { cost } });
      await tx.supplierProduct.upsert({ where: { supplierId_productId: { supplierId: order.supplierId, productId: item.productId } }, update: { lastCost: item.unitCost }, create: { supplierId: order.supplierId, productId: item.productId, lastCost: item.unitCost } });
    }
    const pending = order.items.some(item => quantity(item.quantity) - quantity(item.receivedQuantity, true) - quantity(input.items.find(row => row.itemId === item.id)?.quantity || 0, true) > ZERO);
    const status = pending ? "partially_received" : "received";
    await tx.purchaseOrder.update({ where: { id: orderId }, data: { status, ...(status === "received" ? { completedAt: new Date() } : {}) } });
    await tx.financialTitle.upsert({ where: { sourceType_sourceId: { sourceType: "purchase_order", sourceId: String(orderId) } }, update: { amount: order.total, dueAt: order.dueAt || new Date(), supplierId: order.supplierId }, create: { type: "payable", description: `Pedido ${order.number} · ${order.supplier.tradeName || order.supplier.name}`, supplierId: order.supplierId, sourceType: "purchase_order", sourceId: String(orderId), amount: order.total, dueAt: order.dueAt || new Date() } });
    await tx.tenantAuditEvent.create({ data: { actorId: actor.id, action: "purchase_order.received", entityType: "purchase_order", entityId: String(orderId), correlationId: key, beforeData: { status: order.status }, afterData: { status, receiptId: receipt.id, warehouseId, items: input.items } } });
    return { receipt, order: await tx.purchaseOrder.findUniqueOrThrow({ where: { id: orderId }, include: purchaseOrderDetailInclude }), correlationId: key };
  }, { isolationLevel: "Serializable", timeout: 30000 });
  for (let attempt=0;;attempt++) { try { return await run(); } catch(error) { if (!(error instanceof Prisma.PrismaClientKnownRequestError) || error.code !== "P2034" || attempt >= 3) throw error; await new Promise(resolve => setTimeout(resolve, 30 * 2 ** attempt)); } }
}

async function receiveStock(tx: Prisma.TransactionClient, input: {
  warehouseId: number; product: { id: number; name: string; type: string; manageStock: boolean; expiry: string | null; expiryDate: Date | null };
  variation: { id: number; manageStock: string } | null; quantity: number; receiptId: number; receiptNumber: string; itemId: number; key: string; actor: string; businessDate: string; raw: Record<string, unknown>;
}) {
  const { warehouseId, product, variation, raw } = input, variationId = variation?.id ?? null;
  if (variation && variation.manageStock !== "true") throw new PurchaseInputError("A variação precisa controlar seu próprio estoque.");
  const serials = (Array.isArray(raw.serialNumbers) ? raw.serialNumbers : String(raw.serialNumbers || "").split(/[\n,]/)).map(value => String(value).trim()).filter(Boolean);
  if (serials.length > 1000 || (serials.length && serials.length !== input.quantity)) throw new PurchaseInputError("Informe uma série por unidade recebida, até 1000 séries por item.");
  const normalizedSerials = serials.map(serial => normalizePosTrackingIdentity(serial,"Série"));
  if (new Set(normalizedSerials).size !== serials.length) throw new PurchaseInputError("Série repetida no recebimento.");
  const serialRequired = await tx.posInventoryLot.count({ where: { productId: product.id, variationId, normalizedSerialNumber: { not: null } } });
  if (serialRequired && !serials.length) throw new PurchaseInputError("Este produto exige uma série por unidade recebida.");
  const lotCode = String(raw.lotCode || `${input.receiptNumber}-${input.itemId}`).trim(), normalizedLotCode = normalizePosTrackingIdentity(lotCode,"Lote");
  const manufacturedOn = dateOnly(raw.manufacturedOn,true), expiresOn = dateOnly(raw.expiresOn,true);
  if ((manufacturedOn && manufacturedOn > input.businessDate) || (expiresOn && (expiresOn < input.businessDate || (manufacturedOn && expiresOn < manufacturedOn)))) throw new PurchaseInputError("Fabricação ou validade inválidas para o recebimento.");
  if ((product.expiry || product.expiryDate) && !expiresOn) throw new PurchaseInputError("Informe a validade exigida pelo produto.");
  await tx.warehouseBalance.upsert({ where: { warehouseId_productId: { warehouseId, productId: product.id } }, update: {}, create: { warehouseId, productId: product.id, quantity: 0 } });
  if (variation) await tx.warehouseVariationBalance.upsert({ where: { warehouseId_variationId: { warehouseId, variationId: variation.id } }, update: {}, create: { warehouseId, productId: product.id, variationId: variation.id, quantity: 0 } });
  await preserveUntrackedStock(tx, { warehouseId, productId: product.id, variationId, referenceType: "goods_receipt", referenceId: String(input.receiptId) }, input.actor);
  const tracking: { lotId: string; lotCode: string; serialNumber: string | null; quantity: number; expiresOn: string | null }[] = [];
  for (const [index,serialNumber] of (serials.length ? serials : [null]).entries()) {
    const normalizedSerialNumber = serialNumber ? normalizedSerials[index] : null;
    if (normalizedSerialNumber && await tx.posInventoryLot.count({ where: { productId: product.id, normalizedSerialNumber } })) throw new PurchaseInputError("Uma das séries recebidas já está cadastrada.");
    const existing = normalizedSerialNumber ? null : await tx.posInventoryLot.findFirst({ where: { warehouseId, productId: product.id, variationId, normalizedLotCode, normalizedSerialNumber: null, bucketKey: "sellable" } });
    if (existing && (!["available","depleted"].includes(existing.status) || existing.expiresOn?.toISOString().slice(0,10) !== (expiresOn || undefined) || existing.manufacturedOn?.toISOString().slice(0,10) !== (manufacturedOn || undefined) || (existing.metadata && typeof existing.metadata === "object" && !Array.isArray(existing.metadata) && existing.metadata.productionReportId))) throw new PurchaseInputError("O lote existente possui origem, condição ou datas incompatíveis. Use um lote próprio do recebimento.");
    const amount = serialNumber ? 1 : input.quantity, micros = quantity(amount), before = existing?.quantityMicros ?? ZERO;
    const lot = existing ? await tx.posInventoryLot.update({ where: { id: existing.id }, data: { quantityMicros: { increment: micros }, status: "available" } }) : await tx.posInventoryLot.create({ data: { warehouseId, productId: product.id, variationId, lotCode, normalizedLotCode, serialNumber, normalizedSerialNumber, manufacturedOn: manufacturedOn ? new Date(`${manufacturedOn}T00:00:00Z`) : null, expiresOn: expiresOn ? new Date(`${expiresOn}T00:00:00Z`) : null, quantityMicros: micros, metadata: { goodsReceiptId: input.receiptId } } });
    await tx.posInventoryLotMovement.create({ data: { lotId: lot.id, type: "receipt", quantityMicros: micros, balanceBeforeMicros: before, balanceAfterMicros: before + micros, referenceType: "goods_receipt", referenceId: String(input.receiptId), idempotencyKey: `${input.key}:${input.itemId}:${index}`, actor: input.actor, metadata: { purchaseOrderItemId: input.itemId } } });
    tracking.push({ lotId: lot.id, lotCode, serialNumber, quantity: amount, expiresOn });
  }
  await applyPosCommonStockChange(tx, { warehouseId, product, variation, delta: input.quantity, allowNegative: false, movementType: "entry", ledgerType: "purchase_receipt", referenceType: "goods_receipt", referenceId: String(input.receiptId), actor: input.actor, note: `Recebimento ${input.receiptNumber}` });
  return tracking;
}
