import type { Prisma } from "@/generated/tenant/client";
import { InventoryInputError } from "@/lib/erp/inventory-input";

export type LegacyInventorySafetyProduct = {
  id: number;
  name: string;
  sku: string;
  type: string;
  catalogType: string;
  expiry: string | null;
  expiryDate: Date | null;
  variationCount: number;
  variationBalanceCount: number;
  trackedLotCount: number;
  hasReservedBalance: boolean;
  hasActiveReservation: boolean;
};

type LegacyInventoryOperation = "finalize_count" | "transfer" | "production_complete";
type LegacyInventorySafetyTx = Pick<Prisma.TransactionClient, "product" | "warehouseBalance" | "stockReservation">;

export function legacyInventorySafetyReasons(product: LegacyInventorySafetyProduct) {
  const reasons: string[] = [];
  if (product.type !== "product") reasons.push("tipo de item não compatível");
  if (product.catalogType !== "simple") reasons.push("catálogo não simples");
  if (product.variationCount > 0) reasons.push("variações");
  if (product.variationBalanceCount > 0) reasons.push("saldos por variação");
  if (product.trackedLotCount > 0) reasons.push("lote, série, validade ou bucket rastreado");
  if (Boolean(product.expiry?.trim()) || product.expiryDate != null) reasons.push("validade cadastrada");
  if (product.hasReservedBalance) reasons.push("saldo reservado");
  if (product.hasActiveReservation) reasons.push("reserva de pedido ativa");
  return reasons;
}

/**
 * The legacy inventory models only identify a product and a warehouse. They must
 * never mutate aggregates backed by variation, lot/serial/bucket or reservation
 * dimensions because those identities cannot be represented by the operation.
 */
export async function assertLegacySimpleInventoryOperation(
  tx: LegacyInventorySafetyTx,
  input: { operation: LegacyInventoryOperation; productIds: readonly number[]; warehouseIds: readonly number[] },
) {
  const productIds = uniquePositiveIds(input.productIds, "Produto");
  const warehouseIds = uniquePositiveIds(input.warehouseIds, "Depósito");
  const [products, reservedBalances, activeReservations] = await Promise.all([
    tx.product.findMany({
      where: { id: { in: productIds } },
      select: {
        id: true,
        name: true,
        sku: true,
        type: true,
        catalogType: true,
        expiry: true,
        expiryDate: true,
        _count: { select: { variations: true, warehouseVariationBalances: true, posInventoryLots: true } },
      },
      orderBy: { id: "asc" },
    }),
    tx.warehouseBalance.findMany({
      where: { warehouseId: { in: warehouseIds }, productId: { in: productIds }, reservedQuantity: { gt: 0 } },
      select: { productId: true },
      distinct: ["productId"],
    }),
    tx.stockReservation.findMany({
      where: { warehouseId: { in: warehouseIds }, productId: { in: productIds }, status: "active" },
      select: { productId: true },
      distinct: ["productId"],
    }),
  ]);

  if (products.length !== productIds.length) throw new InventoryInputError("A operação legada referencia um produto inexistente.");
  const reservedProductIds = new Set(reservedBalances.map((item) => item.productId));
  const activeReservationProductIds = new Set(activeReservations.map((item) => item.productId));
  for (const product of products) {
    const safetyProduct: LegacyInventorySafetyProduct = {
      id: product.id,
      name: product.name,
      sku: product.sku,
      type: product.type,
      catalogType: product.catalogType,
      expiry: product.expiry,
      expiryDate: product.expiryDate,
      variationCount: product._count.variations,
      variationBalanceCount: product._count.warehouseVariationBalances,
      trackedLotCount: product._count.posInventoryLots,
      hasReservedBalance: reservedProductIds.has(product.id),
      hasActiveReservation: activeReservationProductIds.has(product.id),
    };
    const reasons = legacyInventorySafetyReasons(safetyProduct);
    if (!reasons.length) continue;
    const operation = input.operation === "finalize_count"
      ? "finalização de contagem"
      : input.operation === "production_complete"
        ? "conclusão de produção"
        : "transferência";
    throw new InventoryInputError(`A ${operation} legada foi bloqueada para ${product.name} (${product.sku}): ${reasons.join(", ")}. Use o inventário rastreado do PDV.`);
  }
}

function uniquePositiveIds(values: readonly number[], label: string) {
  if (!values.length || values.some((value) => !Number.isSafeInteger(value) || value <= 0)) throw new InventoryInputError(`${label} inválido na contenção de inventário.`);
  return [...new Set(values)].sort((left, right) => left - right);
}
