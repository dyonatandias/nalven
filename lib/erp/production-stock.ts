import { randomUUID } from "node:crypto";
import { Prisma } from "@/generated/tenant/client";
import { applyPosCommonStockChange } from "./pos-common-stock";
import { posBusinessDate } from "./pos-inventory-operations";
import {
  normalizePosTrackingIdentity,
  selectPosFefo,
} from "./pos-inventory-tracking";
import { ProductionInputError } from "./production-input";
import {
  asQuantity,
  cents,
  dateOnly,
  materialCost,
  MICRO,
  safeJson,
  weightedAverageCost,
  ZERO,
  type ProductionSnapshot,
} from "./production-domain";

type Tx = Prisma.TransactionClient;
export type MaterialDemand = {
  productId: number;
  variationId: number | null;
  requiredMicros: bigint;
};
export type OrderStockContext = {
  id: number;
  warehouseId: number;
  number: string;
};
const remaining = (row: {
  quantityMicros: bigint;
  consumedMicros: bigint;
  releasedMicros: bigint;
}) => row.quantityMicros - row.consumedMicros - row.releasedMicros;

export async function lockProductionStock(
  tx: Tx,
  warehouseId: number,
  productIds: number[],
) {
  const ids = [...new Set(productIds)].sort((a, b) => a - b);
  if (!ids.length)
    throw new ProductionInputError("A produção não possui materiais.");
  await tx.$queryRaw(
    Prisma.sql`SELECT id FROM products WHERE id IN (${Prisma.join(ids)}) ORDER BY id FOR UPDATE`,
  );
  await tx.$queryRaw(
    Prisma.sql`SELECT id FROM warehouse_balances WHERE warehouse_id = ${warehouseId} AND product_id IN (${Prisma.join(ids)}) ORDER BY product_id FOR UPDATE`,
  );
  await tx.$queryRaw(
    Prisma.sql`SELECT id FROM warehouse_variation_balances WHERE warehouse_id = ${warehouseId} AND product_id IN (${Prisma.join(ids)}) ORDER BY product_id,variation_id FOR UPDATE`,
  );
  await tx.$queryRaw(
    Prisma.sql`SELECT id FROM pos_inventory_lots WHERE warehouse_id = ${warehouseId} AND product_id IN (${Prisma.join(ids)}) ORDER BY product_id,id FOR UPDATE`,
  );
}

export async function productionScope(
  tx: Tx,
  warehouseId: number,
  productId: number,
  variationId: number | null,
) {
  const warehouse = await tx.warehouse.findFirst({
    where: { id: warehouseId, active: true },
    include: { branch: true },
  });
  const product = await tx.product.findFirst({
    where: { id: productId, active: true },
    include: { variations: { where: { enabled: true } } },
  });
  if (!warehouse || (warehouse.branch && warehouse.branch.status !== "active"))
    throw new ProductionInputError("Depósito ou filial inativos.");
  if (!product || product.type === "service" || !product.manageStock)
    throw new ProductionInputError(
      "Produto precisa estar ativo e controlar estoque.",
    );
  const variation =
    variationId === null
      ? null
      : (product.variations.find((item) => item.id === variationId) ?? null);
  if (variationId !== null && (!variation || variation.manageStock !== "true"))
    throw new ProductionInputError(
      "Selecione uma variação ativa com estoque próprio.",
    );
  if (variationId === null && product.catalogType === "variable")
    throw new ProductionInputError(`Selecione a variação de ${product.name}.`);
  const businessDate = posBusinessDate(
    warehouse.branch?.timezone || "America/Sao_Paulo",
  );
  return { warehouse, product, variation, businessDate };
}

async function adjustReservation(
  tx: Tx,
  warehouseId: number,
  productId: number,
  variationId: number | null,
  deltaMicros: bigint,
) {
  if (deltaMicros === ZERO) return;
  const delta = asQuantity(deltaMicros);
  const parent = await tx.warehouseBalance.findUnique({
    where: { warehouseId_productId: { warehouseId, productId } },
  });
  if (
    !parent ||
    parent.reservedQuantity + delta < -0.0000001 ||
    parent.reservedQuantity + delta > parent.quantity + 0.0000001
  )
    throw new ProductionInputError(
      "Saldo disponível insuficiente ou reserva divergente.",
    );
  const changed = await tx.warehouseBalance.updateMany({
    where: {
      id: parent.id,
      quantity: parent.quantity,
      reservedQuantity: parent.reservedQuantity,
    },
    data: { reservedQuantity: Math.max(0, parent.reservedQuantity + delta) },
  });
  if (changed.count !== 1)
    throw new ProductionInputError(
      "Saldo alterado simultaneamente. Atualize a produção.",
    );
  if (variationId !== null) {
    const variation = await tx.warehouseVariationBalance.findUnique({
      where: { warehouseId_variationId: { warehouseId, variationId } },
    });
    if (
      !variation ||
      variation.productId !== productId ||
      variation.reservedQuantity + delta < -0.0000001 ||
      variation.reservedQuantity + delta > variation.quantity + 0.0000001
    )
      throw new ProductionInputError(
        "Saldo da variação insuficiente ou divergente.",
      );
    const result = await tx.warehouseVariationBalance.updateMany({
      where: {
        id: variation.id,
        quantity: variation.quantity,
        reservedQuantity: variation.reservedQuantity,
      },
      data: {
        reservedQuantity: Math.max(0, variation.reservedQuantity + delta),
      },
    });
    if (result.count !== 1)
      throw new ProductionInputError(
        "Reserva da variação alterada simultaneamente.",
      );
  }
}

/** Call under the order lock and sorted product/stock locks, inside the command transaction. */
export async function reserveProductionMaterials(
  tx: Tx,
  order: OrderStockContext,
  demands: MaterialDemand[],
  actor: string,
) {
  const reservations = await tx.productionMaterialReservation.findMany({
    where: { orderId: order.id },
  });
  for (const demand of [...demands].sort(
    (a, b) =>
      a.productId - b.productId || (a.variationId ?? 0) - (b.variationId ?? 0),
  )) {
    const scope = await productionScope(
      tx,
      order.warehouseId,
      demand.productId,
      demand.variationId,
    );
    const existing = reservations.filter(
      (row) =>
        row.productId === demand.productId &&
        row.variationId === demand.variationId &&
        remaining(row) > ZERO,
    );
    for (const reservation of existing) {
      if (!reservation.lotId) continue;
      const lot = await tx.posInventoryLot.findUniqueOrThrow({
        where: { id: reservation.lotId },
      });
      if (
        lot.status !== "available" ||
        lot.bucketKey !== "sellable" ||
        (lot.expiresOn &&
          lot.expiresOn.toISOString().slice(0, 10) < scope.businessDate)
      )
        throw new ProductionInputError(
          `A reserva de ${scope.product.name} contém lote vencido ou bloqueado. Libere a reserva e faça nova separação.`,
        );
    }
    const missing =
      demand.requiredMicros -
      existing.reduce((sum, row) => sum + remaining(row), ZERO);
    if (missing <= ZERO) continue;
    const lots = await tx.posInventoryLot.findMany({
      where: {
        warehouseId: order.warehouseId,
        productId: demand.productId,
        variationId: demand.variationId,
        bucketKey: "sellable",
      },
      orderBy: { id: "asc" },
      take: 10001,
    });
    if (lots.length > 10000)
      throw new ProductionInputError(
        "O estoque rastreado excede o limite de seleção por material.",
      );
    const hasOtherTracked =
      lots.length > 0 ||
      (await tx.posInventoryLot.count({
        where: { productId: demand.productId, variationId: demand.variationId },
      })) > 0;
    if (
      !lots.length &&
      (hasOtherTracked ||
        scope.product.expiryDate ||
        scope.product.expiry?.trim())
    )
      throw new ProductionInputError(
        `Cadastre o lote disponível de ${scope.product.name} neste depósito.`,
      );
    const allocations = lots.length
      ? selectPosFefo({
          warehouseId: order.warehouseId,
          productId: demand.productId,
          variationId: demand.variationId,
          quantity: asQuantity(missing),
          businessDate: scope.businessDate,
          candidates: lots,
        }).allocations.map((item) => ({
          lotId: item.lotId,
          quantityMicros: item.quantityMicros,
        }))
      : [{ lotId: null, quantityMicros: missing }];
    await adjustReservation(
      tx,
      order.warehouseId,
      demand.productId,
      demand.variationId,
      missing,
    );
    for (const allocation of allocations) {
      if (allocation.lotId) {
        const lot = lots.find((item) => item.id === allocation.lotId)!;
        const changed = await tx.posInventoryLot.updateMany({
          where: {
            id: lot.id,
            quantityMicros: lot.quantityMicros,
            reservedMicros: lot.reservedMicros,
            status: "available",
          },
          data: { reservedMicros: { increment: allocation.quantityMicros } },
        });
        if (changed.count !== 1)
          throw new ProductionInputError("Lote alterado durante a reserva.");
        await lotMovement(
          tx,
          lot.id,
          "status_change",
          ZERO,
          lot.quantityMicros,
          `reserve:${randomUUID()}`,
          order.id,
          actor,
          { reservedDeltaMicros: allocation.quantityMicros.toString() },
        );
      }
      await tx.productionMaterialReservation.create({
        data: {
          orderId: order.id,
          productId: demand.productId,
          variationId: demand.variationId,
          ...allocation,
        },
      });
    }
  }
}

export async function releaseProductionMaterials(
  tx: Tx,
  order: OrderStockContext,
  actor: string,
) {
  const rows = await tx.productionMaterialReservation.findMany({
    where: { orderId: order.id },
    orderBy: [{ productId: "asc" }, { id: "asc" }],
  });
  for (const row of rows) {
    const amount = remaining(row);
    if (amount <= ZERO) continue;
    await adjustReservation(
      tx,
      order.warehouseId,
      row.productId,
      row.variationId,
      -amount,
    );
    if (row.lotId) {
      const lot = await tx.posInventoryLot.findUniqueOrThrow({
        where: { id: row.lotId },
      });
      if (lot.reservedMicros < amount)
        throw new ProductionInputError("Reserva do lote divergente.");
      await tx.posInventoryLot.update({
        where: { id: lot.id },
        data: { reservedMicros: { decrement: amount } },
      });
      await lotMovement(
        tx,
        lot.id,
        "status_change",
        ZERO,
        lot.quantityMicros,
        `release:${row.id}`,
        order.id,
        actor,
        { reservedDeltaMicros: (-amount).toString() },
      );
    }
    await tx.productionMaterialReservation.update({
      where: { id: row.id },
      data: { releasedMicros: { increment: amount } },
    });
  }
}

export async function consumeProductionMaterials(
  tx: Tx,
  order: OrderStockContext,
  demands: MaterialDemand[],
  reportId: string,
  actor: string,
) {
  await reserveProductionMaterials(tx, order, demands, actor);
  let total = 0;
  const lines: Array<{
    reservationId: string;
    quantityMicros: bigint;
    unitCostCents: number;
    totalCostCents: number;
  }> = [];
  for (const demand of demands) {
    const scope = await productionScope(
      tx,
      order.warehouseId,
      demand.productId,
      demand.variationId,
    );
    let needed = demand.requiredMicros;
    const reservations = await tx.productionMaterialReservation.findMany({
      where: {
        orderId: order.id,
        productId: demand.productId,
        variationId: demand.variationId,
      },
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    });
    for (const row of reservations) {
      if (needed === ZERO) break;
      const available = remaining(row),
        amount = available < needed ? available : needed;
      if (amount <= ZERO) continue;
      await adjustReservation(
        tx,
        order.warehouseId,
        demand.productId,
        demand.variationId,
        -amount,
      );
      if (row.lotId) {
        const lot = await tx.posInventoryLot.findUniqueOrThrow({
          where: { id: row.lotId },
        });
        if (
          lot.status !== "available" ||
          lot.bucketKey !== "sellable" ||
          lot.quantityMicros < amount ||
          lot.reservedMicros < amount ||
          (lot.expiresOn &&
            lot.expiresOn.toISOString().slice(0, 10) < scope.businessDate)
        )
          throw new ProductionInputError(
            "O lote reservado não pode ser consumido.",
          );
        await tx.posInventoryLot.update({
          where: { id: lot.id },
          data: {
            quantityMicros: { decrement: amount },
            reservedMicros: { decrement: amount },
            ...(lot.quantityMicros === amount ? { status: "depleted" } : {}),
          },
        });
        await lotMovement(
          tx,
          lot.id,
          "adjustment",
          -amount,
          lot.quantityMicros,
          `consume:${reportId}:${row.id}`,
          order.id,
          actor,
          { reportId, reservationId: row.id },
        );
      }
      await applyPosCommonStockChange(tx, {
        warehouseId: order.warehouseId,
        product: scope.product,
        variation: scope.variation,
        delta: -asQuantity(amount),
        allowNegative: false,
        movementType: "exit",
        ledgerType: "production_consume",
        referenceType: "production_report",
        referenceId: reportId,
        actor,
        note: `Consumo real ${order.number}`,
      });
      await tx.productionMaterialReservation.update({
        where: { id: row.id },
        data: { consumedMicros: { increment: amount } },
      });
      const unitCostCents = cents(Math.round(scope.product.cost * 100)),
        totalCostCents = materialCost(amount, unitCostCents);
      lines.push({
        reservationId: row.id,
        quantityMicros: amount,
        unitCostCents,
        totalCostCents,
      });
      total += totalCostCents;
      needed -= amount;
    }
    if (needed !== ZERO)
      throw new ProductionInputError(
        "Reserva insuficiente para o consumo informado.",
      );
  }
  return { materialCostCents: cents(total), lines };
}

export type OutputIdentity = {
  lotCode: string;
  serialNumbers: string[];
  manufacturedOn: string;
  expiresOn: string | null;
  lotIds: string[];
};
export async function quarantineProductionOutput(
  tx: Tx,
  order: OrderStockContext,
  snapshot: ProductionSnapshot,
  reportId: string,
  producedMicros: bigint,
  raw: Record<string, unknown>,
  actor: string,
): Promise<OutputIdentity> {
  const scope = await productionScope(
    tx,
    order.warehouseId,
    snapshot.outputProductId,
    snapshot.outputVariationId,
  );
  const lotCode = String(
    raw.lotCode || `${order.number}-${reportId.slice(0, 8)}`,
  ).trim();
  const normalizedLotCode = normalizePosTrackingIdentity(lotCode, "Lote");
  if (normalizedLotCode.length > 160)
    throw new ProductionInputError("Lote muito longo.");
  const manufacturedOn = dateOnly(raw.manufacturedOn || scope.businessDate)!;
  const expiresOn = dateOnly(raw.expiresOn, true);
  if (
    manufacturedOn > scope.businessDate ||
    (expiresOn &&
      (expiresOn < manufacturedOn || expiresOn < scope.businessDate))
  )
    throw new ProductionInputError(
      "Datas de fabricação e validade incoerentes.",
    );
  if ((scope.product.expiry?.trim() || scope.product.expiryDate) && !expiresOn)
    throw new ProductionInputError("Informe a validade do produto acabado.");
  const serialNumbers = Array.isArray(raw.serialNumbers)
    ? raw.serialNumbers.map((value) => String(value).trim())
    : String(raw.serialNumbers || "")
        .split(/[\n,]/)
        .map((value) => value.trim())
        .filter(Boolean);
  if (serialNumbers.length > 1000)
    throw new ProductionInputError("Máximo de 1000 séries por apontamento.");
  const normalizedSerials = serialNumbers.map((serial) =>
    normalizePosTrackingIdentity(serial, "Série"),
  );
  if (
    new Set(normalizedSerials).size !== normalizedSerials.length ||
    (serialNumbers.length &&
      BigInt(serialNumbers.length) * MICRO !== producedMicros)
  )
    throw new ProductionInputError(
      "Informe uma série única por unidade produzida.",
    );
  const serialScope = await tx.posInventoryLot.count({
    where: {
      productId: snapshot.outputProductId,
      variationId: snapshot.outputVariationId,
      normalizedSerialNumber: { not: null },
    },
  });
  if (serialScope && producedMicros > ZERO && !serialNumbers.length)
    throw new ProductionInputError("Este produto exige uma série por unidade.");
  const result: OutputIdentity = {
    lotCode,
    serialNumbers,
    manufacturedOn,
    expiresOn,
    lotIds: [],
  };
  if (producedMicros === ZERO) return result;
  await preserveUntrackedStock(tx, { warehouseId: order.warehouseId, productId: snapshot.outputProductId, variationId: snapshot.outputVariationId, referenceType: "production_order", referenceId: String(order.id) }, actor);
  // A lot code identifies one report; multiple partial reports may not merge quarantine and release evidence.
  const duplicateLot = await tx.posInventoryLot.count({
    where: {
      warehouseId: order.warehouseId,
      productId: snapshot.outputProductId,
      variationId: snapshot.outputVariationId,
      normalizedLotCode,
    },
  });
  if (duplicateLot)
    throw new ProductionInputError(
      "Use um lote de saída exclusivo para este apontamento.",
    );
  if (
    normalizedSerials.length &&
    (await tx.posInventoryLot.count({
      where: {
        productId: snapshot.outputProductId,
        normalizedSerialNumber: { in: normalizedSerials },
      },
    }))
  )
    throw new ProductionInputError("Uma das séries já está cadastrada.");
  for (const [index, serial] of (serialNumbers.length
    ? serialNumbers
    : [null]
  ).entries()) {
    const amount = serial ? MICRO : producedMicros;
    const lot = await tx.posInventoryLot.create({
      data: {
        warehouseId: order.warehouseId,
        productId: snapshot.outputProductId,
        variationId: snapshot.outputVariationId,
        lotCode,
        normalizedLotCode,
        serialNumber: serial,
        normalizedSerialNumber: serial ? normalizedSerials[index] : null,
        manufacturedOn: new Date(`${manufacturedOn}T00:00:00Z`),
        expiresOn: expiresOn ? new Date(`${expiresOn}T00:00:00Z`) : null,
        bucketKey: "quarantine",
        status: "quarantine",
        quantityMicros: amount,
        metadata: { productionReportId: reportId, productionOrderId: order.id },
      },
    });
    result.lotIds.push(lot.id);
    await lotMovement(
      tx,
      lot.id,
      "receipt",
      amount,
      ZERO,
      `output:${reportId}:${index}`,
      order.id,
      actor,
      { reportId, disposition: "quarantine" },
    );
  }
  return result;
}

export async function preserveUntrackedStock(
  tx: Tx,
  identity: { warehouseId: number; productId: number; variationId: number | null; referenceType: string; referenceId: string },
  actor: string,
) {
  const { productId, variationId, warehouseId } = identity;
  const balance = variationId
    ? await tx.warehouseVariationBalance.findUnique({
        where: {
          warehouseId_variationId: {
            warehouseId,
            variationId,
          },
        },
      })
    : await tx.warehouseBalance.findUnique({
        where: {
          warehouseId_productId: { warehouseId, productId },
        },
      });
  if (!balance || balance.quantity <= 0) return;
  const lots = await tx.posInventoryLot.findMany({
    where: {
      warehouseId,
      productId,
      variationId,
      bucketKey: "sellable",
    },
  });
  const tracked = lots.reduce((sum, lot) => sum + lot.quantityMicros, ZERO);
  const missing = BigInt(Math.round(balance.quantity * 1e6)) - tracked;
  if (missing <= ZERO) return;
  const product = await tx.product.findUniqueOrThrow({
    where: { id: productId },
  });
  if (
    product.expiry ||
    product.expiryDate ||
    lots.some((lot) => lot.normalizedSerialNumber)
  )
    throw new ProductionInputError(
      "Identifique o saldo anterior por lote, série e validade antes de registrar novas unidades deste produto.",
    );
  const priorReservations = await tx.productionMaterialReservation.findMany({
    where: {
      productId,
      variationId,
      lotId: null,
      order: { warehouseId },
    },
  });
  const reservedMicros = priorReservations.reduce(
    (sum, row) => sum + remaining(row),
    ZERO,
  );
  if (reservedMicros > missing)
    throw new ProductionInputError(
      "As reservas do saldo anterior estão divergentes.",
    );
  const lotCode = `SALDO-ANTERIOR-${randomUUID().slice(0, 12).toUpperCase()}`;
  const lot = await tx.posInventoryLot.create({
    data: {
      warehouseId,
      productId,
      variationId,
      lotCode,
      normalizedLotCode: lotCode,
      quantityMicros: missing,
      reservedMicros,
      metadata: {
        origin: "opening_untracked_balance",
        referenceType: identity.referenceType,
        referenceId: identity.referenceId,
      },
    },
  });
  for (const row of priorReservations)
    if (remaining(row) > ZERO)
      await tx.productionMaterialReservation.update({
        where: { id: row.id },
        data: { lotId: lot.id },
      });
  await tx.posInventoryLotMovement.create({ data: {
    lotId: lot.id, type: "receipt", quantityMicros: missing,
    balanceBeforeMicros: ZERO, balanceAfterMicros: missing,
    idempotencyKey: `opening:${lot.id}`, referenceType: identity.referenceType,
    referenceId: identity.referenceId, actor,
    metadata: { origin: "opening_untracked_balance", aggregateDelta: 0, explanation: "Identificação do saldo anterior; não representa nova entrada física." },
  } });
}

export async function decideProductionOutput(
  tx: Tx,
  order: OrderStockContext,
  snapshot: ProductionSnapshot,
  report: {
    id: string;
    outputIdentity: Prisma.JsonValue;
    producedMicros: bigint;
  },
  approved: boolean,
  totalCostCents: number,
  actor: string,
) {
  const identity = report.outputIdentity as unknown as OutputIdentity;
  const scope = await productionScope(
    tx,
    order.warehouseId,
    snapshot.outputProductId,
    snapshot.outputVariationId,
  );
  if (approved && identity.expiresOn && identity.expiresOn < scope.businessDate)
    throw new ProductionInputError("Produto vencido não pode ser aprovado.");
  let sum = ZERO;
  for (const lotId of identity.lotIds) {
    const lot = await tx.posInventoryLot.findUniqueOrThrow({
      where: { id: lotId },
    });
    if (
      lot.status !== "quarantine" ||
      lot.bucketKey !== "quarantine" ||
      lot.reservedMicros !== ZERO ||
      lot.productId !== snapshot.outputProductId ||
      lot.warehouseId !== order.warehouseId
    )
      throw new ProductionInputError(
        "O lote de saída foi alterado fora da inspeção de produção.",
      );
    sum += lot.quantityMicros;
    await tx.posInventoryLot.update({
      where: { id: lot.id },
      data: approved
        ? { status: "available", bucketKey: "sellable" }
        : { quantityMicros: ZERO, status: "depleted" },
    });
    await lotMovement(
      tx,
      lot.id,
      approved ? "status_change" : "discard",
      approved ? ZERO : -lot.quantityMicros,
      lot.quantityMicros,
      `quality:${report.id}:${lot.id}`,
      order.id,
      actor,
      { reportId: report.id, decision: approved ? "approved" : "rejected" },
    );
  }
  if (sum !== report.producedMicros)
    throw new ProductionInputError(
      "Saldo em quarentena diverge do apontamento.",
    );
  if (!approved || sum === ZERO) return;
  await tx.warehouseBalance.upsert({
    where: {
      warehouseId_productId: {
        warehouseId: order.warehouseId,
        productId: snapshot.outputProductId,
      },
    },
    create: {
      warehouseId: order.warehouseId,
      productId: snapshot.outputProductId,
    },
    update: {},
  });
  if (scope.variation)
    await tx.warehouseVariationBalance.upsert({
      where: {
        warehouseId_variationId: {
          warehouseId: order.warehouseId,
          variationId: scope.variation.id,
        },
      },
      create: {
        warehouseId: order.warehouseId,
        productId: snapshot.outputProductId,
        variationId: scope.variation.id,
      },
      update: {},
    });
  const cost = weightedAverageCost(
    scope.product.stock,
    scope.product.cost,
    sum,
    totalCostCents,
  );
  await applyPosCommonStockChange(tx, {
    warehouseId: order.warehouseId,
    product: scope.product,
    variation: scope.variation,
    delta: asQuantity(sum),
    allowNegative: false,
    movementType: "entry",
    ledgerType: "production_output",
    referenceType: "production_report",
    referenceId: report.id,
    actor,
    note: `Liberação de qualidade ${order.number}`,
  });
  await tx.product.update({
    where: { id: snapshot.outputProductId },
    data: { cost },
  });
}

async function lotMovement(
  tx: Tx,
  lotId: string,
  type: string,
  delta: bigint,
  before: bigint,
  key: string,
  orderId: number,
  actor: string,
  metadata: Record<string, unknown>,
) {
  await tx.posInventoryLotMovement.create({
    data: {
      lotId,
      type,
      quantityMicros: delta,
      balanceBeforeMicros: before,
      balanceAfterMicros: before + delta,
      referenceType: "production_order",
      referenceId: String(orderId),
      idempotencyKey: key,
      actor,
      metadata: safeJson(metadata),
    },
  });
}

export async function transferProductionMaterial(
  tx: Tx,
  order: OrderStockContext,
  demand: MaterialDemand,
  fromWarehouseId: number,
  actor: string,
) {
  if (fromWarehouseId === order.warehouseId)
    throw new ProductionInputError("Selecione outro depósito como origem.");
  for (const warehouseId of [fromWarehouseId, order.warehouseId].sort(
    (a, b) => a - b,
  ))
    await lockProductionStock(tx, warehouseId, [demand.productId]);
  const source = await productionScope(
    tx,
    fromWarehouseId,
    demand.productId,
    demand.variationId,
  );
  await productionScope(
    tx,
    order.warehouseId,
    demand.productId,
    demand.variationId,
  );
  const amount = asQuantity(demand.requiredMicros);
  const lots = await tx.posInventoryLot.findMany({
    where: {
      warehouseId: fromWarehouseId,
      productId: demand.productId,
      variationId: demand.variationId,
      bucketKey: "sellable",
    },
    take: 10001,
  });
  const allocations = lots.length
    ? selectPosFefo({
        warehouseId: fromWarehouseId,
        productId: demand.productId,
        variationId: demand.variationId,
        quantity: amount,
        businessDate: source.businessDate,
        candidates: lots,
      }).allocations
    : [];
  if (
    !lots.length &&
    (source.product.expiry ||
      source.product.expiryDate ||
      (await tx.posInventoryLot.count({
        where: { productId: demand.productId, variationId: demand.variationId },
      })))
  )
    throw new ProductionInputError(
      "Cadastre o lote na origem antes da transferência.",
    );
  const transfer = await tx.stockTransfer.create({
    data: {
      number: `TR-OP-${randomUUID().slice(0, 12).toUpperCase()}`,
      fromWarehouseId,
      toWarehouseId: order.warehouseId,
      transferredBy: actor,
      notes: `Abastecimento ${order.number}${demand.variationId ? ` · variação ${demand.variationId}` : ""}`,
      items: { create: { productId: demand.productId, quantity: amount } },
    },
  });
  for (const allocation of allocations) {
    const lot = lots.find((row) => row.id === allocation.lotId)!;
    const after = lot.quantityMicros - allocation.quantityMicros;
    if (lot.normalizedSerialNumber) {
      // Serialized inventory uses one identity across warehouses; keep the same row and its history.
      if (
        lot.quantityMicros !== MICRO ||
        allocation.quantityMicros !== MICRO ||
        lot.reservedMicros !== ZERO
      )
        throw new ProductionInputError(
          "A série está reservada ou possui saldo inválido.",
        );
      await tx.posInventoryLot.update({
        where: { id: lot.id },
        data: { warehouseId: order.warehouseId },
      });
      await lotMovement(
        tx,
        lot.id,
        "status_change",
        ZERO,
        lot.quantityMicros,
        `transfer:${transfer.id}:${lot.id}`,
        order.id,
        actor,
        {
          transferId: transfer.id,
          fromWarehouseId,
          toWarehouseId: order.warehouseId,
        },
      );
    } else {
      await tx.posInventoryLot.update({
        where: { id: lot.id },
        data: {
          quantityMicros: after,
          ...(after === ZERO ? { status: "depleted" } : {}),
        },
      });
      await lotMovement(
        tx,
        lot.id,
        "transfer_out",
        -allocation.quantityMicros,
        lot.quantityMicros,
        `transfer-out:${transfer.id}:${lot.id}`,
        order.id,
        actor,
        { transferId: transfer.id },
      );
      const existing = await tx.posInventoryLot.findFirst({
        where: {
          warehouseId: order.warehouseId,
          productId: demand.productId,
          variationId: demand.variationId,
          normalizedLotCode: lot.normalizedLotCode,
          normalizedSerialNumber: null,
          bucketKey: "sellable",
        },
      });
      if (
        existing &&
        (!["available", "depleted"].includes(existing.status) ||
          existing.expiresOn?.getTime() !== lot.expiresOn?.getTime() ||
          existing.manufacturedOn?.getTime() !== lot.manufacturedOn?.getTime())
      )
        throw new ProductionInputError(
          "O lote de destino possui validade ou condição divergente.",
        );
      const target = existing
        ? await tx.posInventoryLot.update({
            where: { id: existing.id },
            data: {
              quantityMicros: { increment: allocation.quantityMicros },
              status: "available",
            },
          })
        : await tx.posInventoryLot.create({
            data: {
              warehouseId: order.warehouseId,
              productId: demand.productId,
              variationId: demand.variationId,
              lotCode: lot.lotCode,
              normalizedLotCode: lot.normalizedLotCode,
              manufacturedOn: lot.manufacturedOn,
              expiresOn: lot.expiresOn,
              quantityMicros: allocation.quantityMicros,
            },
          });
      await lotMovement(
        tx,
        target.id,
        "transfer_in",
        allocation.quantityMicros,
        existing?.quantityMicros ?? ZERO,
        `transfer-in:${transfer.id}:${lot.id}`,
        order.id,
        actor,
        { transferId: transfer.id, sourceLotId: lot.id },
      );
    }
  }
  await tx.warehouseBalance.upsert({
    where: {
      warehouseId_productId: {
        warehouseId: order.warehouseId,
        productId: demand.productId,
      },
    },
    create: { warehouseId: order.warehouseId, productId: demand.productId },
    update: {},
  });
  if (demand.variationId)
    await tx.warehouseVariationBalance.upsert({
      where: {
        warehouseId_variationId: {
          warehouseId: order.warehouseId,
          variationId: demand.variationId,
        },
      },
      create: {
        warehouseId: order.warehouseId,
        productId: demand.productId,
        variationId: demand.variationId,
      },
      update: {},
    });
  for (const [warehouseId, delta] of [
    [fromWarehouseId, -amount],
    [order.warehouseId, amount],
  ])
    await applyPosCommonStockChange(tx, {
      warehouseId,
      product: source.product,
      variation: source.variation,
      delta,
      allowNegative: false,
      movementType: delta > 0 ? "entry" : "exit",
      ledgerType: delta > 0 ? "transfer_in" : "transfer_out",
      referenceType: "stock_transfer",
      referenceId: String(transfer.id),
      actor,
      note: `Abastecimento ${order.number}`,
    });
  return transfer;
}
