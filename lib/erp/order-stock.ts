import type { Prisma } from "@/generated/tenant/client";
import { SalesOrderInputError } from "@/lib/erp/sales-order-input";

export type WorkflowOrder = {
  id: number;
  branchId: number;
  number: string;
  status: string;
  customerId: number | null;
  customerName: string;
  salesperson: string | null;
  paymentMethod: string | null;
  firstDueDate: Date | null;
  total: number;
  expectedAt: Date | null;
  items: Array<{
    id: number;
    productId: number;
    variationId?: number | null;
    quantity: number;
    unitPrice: number;
    total: number;
    product: { name: string; type: string };
  }>;
};

export async function reserveOrderStock(
  tx: Prisma.TransactionClient,
  order: WorkflowOrder,
  allowNegativeStock: boolean,
) {
  if (
    await tx.stockReservation.count({
      where: { salesOrderId: order.id, status: "active" },
    })
  )
    return;
  const branch = await tx.branch.findUnique({
    where: { id: order.branchId },
    include: {
      settings: true,
      defaultWarehouse: true,
      productConfigurations: {
        where: { productId: { in: order.items.map((item) => item.productId) } },
      },
    },
  });
  if (!branch?.defaultWarehouse?.active)
    throw new SalesOrderInputError(
      "A filial do pedido não possui depósito padrão ativo.",
    );
  const allowCross = Boolean(branch.settings?.allowCrossBranchFulfillment);
  const warehouseWhere = {
    active: true,
    branchId: allowCross ? { not: null } : order.branchId,
  };
  const [balances, variationBalances] = await Promise.all([
    tx.warehouseBalance.findMany({
      where: {
        productId: { in: order.items.map((item) => item.productId) },
        warehouse: warehouseWhere,
      },
      include: {
        warehouse: { select: { id: true, name: true, branchId: true } },
      },
    }),
    tx.warehouseVariationBalance.findMany({
      where: {
        variationId: {
          in: order.items.flatMap((item) =>
            item.variationId ? [item.variationId] : [],
          ),
        },
        warehouse: warehouseWhere,
      },
      include: {
        warehouse: { select: { id: true, name: true, branchId: true } },
      },
    }),
  ]);
  const configByProduct = new Map(
    branch.productConfigurations.map((item) => [item.productId, item]),
  );
  for (const item of order.items) {
    if (item.product.type === "service") continue;
    let remaining = item.quantity;
    const preferred = configByProduct.get(item.productId)?.preferredWarehouseId;
    const candidates = (
      item.variationId
        ? variationBalances.filter(
            (balance) => balance.variationId === item.variationId,
          )
        : balances.filter((balance) => balance.productId === item.productId)
    ).sort((a, b) => {
      const preferredRank =
        Number(b.warehouseId === preferred) -
        Number(a.warehouseId === preferred);
      if (preferredRank) return preferredRank;
      if (branch.settings?.stockAllocationStrategy === "highest_stock")
        return (
          b.quantity - b.reservedQuantity - (a.quantity - a.reservedQuantity)
        );
      const localRank =
        Number(b.warehouse.branchId === order.branchId) -
        Number(a.warehouse.branchId === order.branchId);
      return (
        localRank ||
        b.quantity - b.reservedQuantity - (a.quantity - a.reservedQuantity)
      );
    });
    for (const balance of candidates) {
      const quantity = Math.min(
        remaining,
        Math.max(0, balance.quantity - balance.reservedQuantity),
      );
      if (quantity <= 0) continue;
      await createReservation(tx, order, item, balance.warehouseId, quantity);
      balance.reservedQuantity += quantity;
      remaining = Math.round((remaining - quantity) * 1000) / 1000;
      if (remaining <= 0) break;
    }
    if (remaining > 0 && allowNegativeStock) {
      await tx.warehouseBalance.upsert({
        where: {
          warehouseId_productId: {
            warehouseId: branch.defaultWarehouse.id,
            productId: item.productId,
          },
        },
        update: {},
        create: {
          warehouseId: branch.defaultWarehouse.id,
          productId: item.productId,
        },
      });
      if (item.variationId)
        await tx.warehouseVariationBalance.upsert({
          where: {
            warehouseId_variationId: {
              warehouseId: branch.defaultWarehouse.id,
              variationId: item.variationId,
            },
          },
          update: {},
          create: {
            warehouseId: branch.defaultWarehouse.id,
            productId: item.productId,
            variationId: item.variationId,
          },
        });
      await createReservation(
        tx,
        order,
        item,
        branch.defaultWarehouse.id,
        remaining,
      );
      remaining = 0;
    }
    if (remaining > 0)
      throw new SalesOrderInputError(
        `Saldo disponível insuficiente para ${item.product.name}. Necessário: ${item.quantity}; faltante: ${remaining}.`,
      );
  }
}

async function createReservation(
  tx: Prisma.TransactionClient,
  order: WorkflowOrder,
  item: WorkflowOrder["items"][number],
  warehouseId: number,
  quantity: number,
) {
  await tx.stockReservation.upsert({
    where: { orderItemId_warehouseId: { orderItemId: item.id, warehouseId } },
    update: {
      quantity: { increment: quantity },
      variationId: item.variationId || null,
    },
    create: {
      salesOrderId: order.id,
      orderItemId: item.id,
      branchId: order.branchId,
      warehouseId,
      productId: item.productId,
      variationId: item.variationId || null,
      quantity,
    },
  });
  await tx.warehouseBalance.upsert({
    where: {
      warehouseId_productId: { warehouseId, productId: item.productId },
    },
    update: { reservedQuantity: { increment: quantity } },
    create: {
      warehouseId,
      productId: item.productId,
      quantity: 0,
      reservedQuantity: quantity,
    },
  });
  if (item.variationId)
    await tx.warehouseVariationBalance.update({
      where: {
        warehouseId_variationId: { warehouseId, variationId: item.variationId },
      },
      data: { reservedQuantity: { increment: quantity } },
    });
}
