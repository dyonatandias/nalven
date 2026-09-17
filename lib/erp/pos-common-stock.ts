import { Prisma } from "@/generated/tenant/client";

export type PosStockMode = "none" | "parent" | "variation";

export class PosCommonStockError extends Error {
  constructor(message: string, public readonly status = 409) {
    super(message);
    this.name = "PosCommonStockError";
  }
}

export function stockMode(productType: string, productManageStock: boolean, variationManageStock?: string | null): PosStockMode {
  if (productType === "service" || variationManageStock === "false") return "none";
  if (variationManageStock === "true") return "variation";
  return productManageStock ? "parent" : "none";
}

export function posAvailableStock(
  product: { type: string; manageStock: boolean },
  parentBalance?: { quantity: number; reservedQuantity: number } | null,
  variation?: { manageStock: string; warehouseBalances: Array<{ quantity: number; reservedQuantity: number }> } | null,
) {
  const mode = stockMode(product.type, product.manageStock, variation?.manageStock);
  if (mode === "none") return null;
  const balance = mode === "variation" ? variation?.warehouseBalances[0] : parentBalance;
  return balance ? Math.round((balance.quantity - balance.reservedQuantity) * 1000) / 1000 : 0;
}

export function planPosStockChange(input: { quantity: number; reservedQuantity: number; delta: number; allowNegative: boolean; label: string }) {
  for (const value of [input.quantity, input.reservedQuantity, input.delta]) {
    if (!Number.isFinite(value)) throw new PosCommonStockError(`Saldo inválido para ${input.label}.`);
  }
  if (input.reservedQuantity < 0) throw new PosCommonStockError(`Reserva inválida para ${input.label}.`);
  if (input.delta < 0 && !input.allowNegative && input.quantity - input.reservedQuantity + 0.000_001 < -input.delta) {
    throw new PosCommonStockError(`Estoque insuficiente para ${input.label}.`);
  }
  return { before: input.quantity, after: input.quantity + input.delta, availableBefore: input.quantity - input.reservedQuantity };
}

export type PosCommonStockInput = {
  warehouseId: number;
  product: { id: number; name: string; type: string; manageStock: boolean };
  variation: { id: number; manageStock: string } | null;
  delta: number;
  allowNegative: boolean;
  movementType: "entry" | "exit";
  ledgerType: string;
  referenceType: string;
  referenceId: string;
  actor: string;
  note: string;
};

export async function applyPosCommonStockChange(tx: Prisma.TransactionClient, input: PosCommonStockInput) {
  const mode = stockMode(input.product.type, input.product.manageStock, input.variation?.manageStock);
  if (mode === "none" || input.delta === 0) return { mode, changed: false as const, parent: null, variation: null };
  if (mode === "variation" && !input.variation) throw new PosCommonStockError(`Variação ausente para ${input.product.name}.`);

  const [parentBalance, variationBalance] = await Promise.all([
    tx.warehouseBalance.findUnique({ where: { warehouseId_productId: { warehouseId: input.warehouseId, productId: input.product.id } } }),
    mode === "variation" ? tx.warehouseVariationBalance.findUnique({ where: { warehouseId_variationId: { warehouseId: input.warehouseId, variationId: input.variation!.id } } }) : Promise.resolve(null),
  ]);
  if (!parentBalance) throw new PosCommonStockError(`Saldo de depósito não configurado para ${input.product.name}.`);
  if (mode === "variation" && (!variationBalance || variationBalance.productId !== input.product.id)) throw new PosCommonStockError(`Saldo da variação de ${input.product.name} não configurado neste depósito.`);

  const parent = planPosStockChange({ quantity: parentBalance.quantity, reservedQuantity: parentBalance.reservedQuantity, delta: input.delta, allowNegative: input.allowNegative, label: input.product.name });
  const variation = variationBalance ? planPosStockChange({ quantity: variationBalance.quantity, reservedQuantity: variationBalance.reservedQuantity, delta: input.delta, allowNegative: input.allowNegative, label: `a variação de ${input.product.name}` }) : null;

  const parentChanged = await tx.warehouseBalance.updateMany({
    where: { id: parentBalance.id, quantity: parentBalance.quantity, reservedQuantity: parentBalance.reservedQuantity },
    data: { quantity: { increment: input.delta } },
  });
  if (parentChanged.count !== 1) throw new PosCommonStockError(`O estoque de ${input.product.name} mudou durante a operação.`);
  if (variationBalance && variation) {
    const variationChanged = await tx.warehouseVariationBalance.updateMany({
      where: { id: variationBalance.id, productId: input.product.id, variationId: input.variation!.id, quantity: variationBalance.quantity, reservedQuantity: variationBalance.reservedQuantity },
      data: { quantity: { increment: input.delta } },
    });
    if (variationChanged.count !== 1) throw new PosCommonStockError(`O estoque da variação de ${input.product.name} mudou durante a operação.`);
  }

  await tx.product.update({ where: { id: input.product.id }, data: { stock: { increment: input.delta } } });
  if (variationBalance) await tx.productVariation.update({ where: { id: input.variation!.id }, data: { stock: { increment: input.delta } } });
  await tx.stockMovement.create({ data: {
    productId: input.product.id,
    warehouseId: input.warehouseId,
    variationId: variationBalance ? input.variation!.id : null,
    type: input.movementType,
    quantity: Math.abs(input.delta),
    previousStock: parent.before,
    currentStock: parent.after,
    variationPreviousStock: variation?.before ?? null,
    variationCurrentStock: variation?.after ?? null,
    note: input.note,
    userName: input.actor,
  } });
  await tx.warehouseLedgerEntry.create({ data: {
    warehouseId: input.warehouseId,
    productId: input.product.id,
    variationId: variationBalance ? input.variation!.id : null,
    type: input.ledgerType,
    quantity: input.delta,
    balanceBefore: parent.before,
    balanceAfter: parent.after,
    variationBalanceBefore: variation?.before ?? null,
    variationBalanceAfter: variation?.after ?? null,
    referenceType: input.referenceType,
    referenceId: input.referenceId,
    actor: input.actor,
  } });
  return { mode, changed: true as const, parent, variation };
}
