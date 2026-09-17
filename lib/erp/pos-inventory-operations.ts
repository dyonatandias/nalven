import { Prisma } from "@/generated/tenant/client";
import {
  normalizePosTrackingIdentity,
  planPosTrackedReturn,
  POS_QUANTITY_SCALE,
  quantityToMicros,
  selectPosFefo,
  type PosFefoAllocation,
  type PosTrackedStockCandidate,
} from "@/lib/erp/pos-inventory-tracking";

export class PosInventoryOperationError extends Error {}

export type PosInventoryDisposition = "restock" | "quarantine" | "discard";

export type PosScanTrackingRequest = {
  lotCode: string | null;
  serialNumber: string | null;
  quantity: number;
};

export type PosTrackedMutationResult = {
  tracked: boolean;
  variationId: number | null;
  restockedQuantity: number;
  aggregateQuantityDelta: number;
  effectiveDisposition: PosInventoryDisposition | "mixed" | null;
  allocations: Array<PosFefoAllocation & { disposition?: PosInventoryDisposition }>;
};

/**
 * Converts the bounded scan snapshot carried by the sale line into explicit
 * identity requests. New clients send `tracking[]`; the top-level GS1 fields
 * remain supported so held carts and older clients fail safely.
 */
export function parsePosScanTrackingRequests(scanData: unknown, lineQuantity: number): PosScanTrackingRequest[] {
  quantityToMicros(lineQuantity);
  if (scanData == null) return [];
  if (!isObject(scanData)) throw new PosInventoryOperationError("Dados de rastreamento da leitura inválidos.");
  const entries = Array.isArray(scanData.tracking) ? scanData.tracking : null;
  if (entries && entries.length > 200) throw new PosInventoryOperationError("A linha excede o limite de leituras rastreadas.");
  const source = entries ?? (hasIdentity(scanData) ? [{ lot: scanData.lot, serial: scanData.serial, quantity: lineQuantity }] : []);
  let totalMicros = BigInt(0);
  const parsed = source.map((entry) => {
    if (!isObject(entry)) throw new PosInventoryOperationError("Leitura rastreada inválida.");
    const lotCode = optionalIdentity(entry.lot ?? entry.lotCode, "Lote");
    const serialNumber = optionalIdentity(entry.serial ?? entry.serialNumber, "Série");
    if (!lotCode && !serialNumber) throw new PosInventoryOperationError("Leitura rastreada sem lote ou série.");
    const rawQuantity = entry.quantity == null ? (serialNumber ? 1 : lineQuantity) : Number(entry.quantity);
    const quantityMicros = quantityToMicros(rawQuantity);
    if (serialNumber && quantityMicros !== POS_QUANTITY_SCALE) {
      throw new PosInventoryOperationError("A leitura de uma série identifica exatamente uma unidade.");
    }
    totalMicros += quantityMicros;
    return { lotCode, serialNumber, quantity: rawQuantity };
  });
  if (totalMicros > quantityToMicros(lineQuantity)) throw new PosInventoryOperationError("As leituras de lote/série superam a quantidade da linha.");
  return parsed;
}

export function posBusinessDate(timeZone: string, now = new Date()) {
  let formatter: Intl.DateTimeFormat;
  try {
    formatter = new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" });
  } catch {
    throw new PosInventoryOperationError("Fuso horário operacional inválido.");
  }
  const parts = Object.fromEntries(formatter.formatToParts(now).map((part) => [part.type, part.value]));
  return `${parts.year}-${parts.month}-${parts.day}`;
}

export async function allocatePosTrackedSaleItem(
  tx: Prisma.TransactionClient,
  input: {
    warehouseId: number;
    productId: number;
    variationId: number | null;
    saleItemId: number;
    quantity: number;
    scanData?: unknown;
    businessDate: string;
    idempotencyKey: string;
    actor: string;
    referenceId: string;
  },
): Promise<PosTrackedMutationResult> {
  const lots = await lockTrackedLots(tx, input.warehouseId, input.productId, input.variationId);
  const requests = parsePosScanTrackingRequests(input.scanData, input.quantity);
  if (!lots.length) {
    if (requests.length) throw new PosInventoryOperationError("O lote/série lido não está cadastrado neste depósito para o produto selecionado.");
    return emptyResult();
  }
  const serializedScope = lots.some((lot) => Boolean(lot.normalizedSerialNumber));
  if (serializedScope) {
    if (!requests.length || requests.some((request) => !request.serialNumber)) {
      throw new PosInventoryOperationError("Leia o número de série exato de cada unidade antes de concluir a venda.");
    }
    const requestedMicros = requests.reduce((total, request) => total + quantityToMicros(request.quantity), BigInt(0));
    if (requestedMicros !== quantityToMicros(input.quantity)) {
      throw new PosInventoryOperationError("Leia o número de série exato de cada unidade antes de concluir a venda.");
    }
    const normalizedSerials = new Set<string>();
    for (const request of requests) {
      const normalizedSerial = normalizePosTrackingIdentity(request.serialNumber!, "Série");
      if (normalizedSerials.has(normalizedSerial)) {
        throw new PosInventoryOperationError("Cada número de série deve ser lido uma única vez.");
      }
      normalizedSerials.add(normalizedSerial);
    }
  }
  let remainingMicros = quantityToMicros(input.quantity);
  const candidates = lots.map(toCandidate);
  const allocatedByLot = new Map<string, PosFefoAllocation>();

  for (const request of requests) {
    const planned = selectPosFefo({
      warehouseId: input.warehouseId,
      productId: input.productId,
      variationId: input.variationId,
      quantity: request.quantity,
      businessDate: input.businessDate,
      requestedLotCode: request.lotCode,
      requestedSerialNumber: request.serialNumber,
      candidates,
    });
    mergeAllocations(allocatedByLot, planned.allocations);
    consumeCandidates(candidates, planned.allocations);
    remainingMicros -= planned.requestedMicros;
  }
  if (remainingMicros > BigInt(0)) {
    const planned = selectPosFefo({
      warehouseId: input.warehouseId,
      productId: input.productId,
      variationId: input.variationId,
      quantity: microsToQuantity(remainingMicros),
      businessDate: input.businessDate,
      candidates,
    });
    mergeAllocations(allocatedByLot, planned.allocations);
  }

  const allocations = [...allocatedByLot.values()];
  const lotById = new Map(lots.map((lot) => [lot.id, lot]));
  for (const allocation of allocations) {
    const lot = lotById.get(allocation.lotId)!;
    const before = lot.quantityMicros;
    const after = before - allocation.quantityMicros;
    const changed = await tx.posInventoryLot.updateMany({
      where: { id: lot.id, status: "available", quantityMicros: before, reservedMicros: lot.reservedMicros },
      data: { quantityMicros: after, ...(after === BigInt(0) ? { status: "depleted" } : {}) },
    });
    if (changed.count !== 1) throw new PosInventoryOperationError("O lote/série mudou durante a venda. Releia o item e tente novamente.");
    await tx.posInventoryLotMovement.create({ data: {
      lotId: lot.id,
      saleItemId: input.saleItemId,
      type: "sale",
      quantityMicros: -allocation.quantityMicros,
      balanceBeforeMicros: before,
      balanceAfterMicros: after,
      referenceType: "sale",
      referenceId: input.referenceId,
      idempotencyKey: `${input.idempotencyKey}:tracked-sale:${input.saleItemId}:${lot.id}`,
      actor: input.actor,
      metadata: trackingMetadata(lot, "sale"),
    } });
  }
  return { tracked: true, variationId: input.variationId, restockedQuantity: 0, aggregateQuantityDelta: 0, effectiveDisposition: null, allocations };
}

export async function restorePosTrackedSaleItem(
  tx: Prisma.TransactionClient,
  input: {
    saleItemId: number;
    trackedProductId?: number;
    trackedVariationId?: number | null;
    returnItemId?: number | null;
    quantity: number;
    disposition: PosInventoryDisposition;
    businessDate: string;
    idempotencyKey: string;
    actor: string;
    referenceType: "sale_cancel" | "pos_return";
    referenceId: string;
  },
): Promise<PosTrackedMutationResult> {
  if ((input.trackedProductId == null) !== (input.trackedVariationId === undefined)) throw new PosInventoryOperationError("Escopo rastreado incompleto.");
  const lotScope = input.trackedProductId == null ? {} : { lot: { productId: input.trackedProductId, variationId: input.trackedVariationId ?? null } };
  const original = await tx.posInventoryLotMovement.findMany({
    where: { saleItemId: input.saleItemId, type: "sale", ...lotScope },
    orderBy: [{ occurredAt: "asc" }, { id: "asc" }],
  });
  if (!original.length) return emptyResult();
  const lotIds = [...new Set(original.map((movement) => movement.lotId))].sort();
  await lockLotsById(tx, lotIds);
  const [lots, priorReturns] = await Promise.all([
    tx.posInventoryLot.findMany({ where: { id: { in: lotIds } } }),
    tx.posInventoryLotMovement.findMany({
      where: {
        type: "return",
        ...lotScope,
        OR: [
          { returnItem: { saleItemId: input.saleItemId } },
          { saleItemId: input.saleItemId, referenceType: "sale_cancel" },
        ],
      },
      select: { lotId: true, quantityMicros: true },
    }),
  ]);
  if (lots.length !== lotIds.length) throw new PosInventoryOperationError("Uma identidade rastreada da venda não existe mais.");
  const returnedByLot = sumByLot(priorReturns);
  const lotById = new Map(lots.map((lot) => [lot.id, lot]));
  const trackedVariationIds = new Set(lots.map((lot) => lot.variationId));
  if (trackedVariationIds.size !== 1) throw new PosInventoryOperationError("A venda rastreada mistura escopos de variação incompatíveis.");
  const soldByLot = new Map<string, bigint>();
  for (const movement of original) soldByLot.set(movement.lotId, (soldByLot.get(movement.lotId) ?? BigInt(0)) + -movement.quantityMicros);
  const planned = planPosTrackedReturn({
    quantity: input.quantity,
    businessDate: input.businessDate,
    disposition: input.disposition,
    originalAllocations: [...soldByLot.entries()].map(([lotId, soldMicros]) => {
      const lot = lotById.get(lotId)!;
      return { lotId, soldMicros, returnedMicros: returnedByLot.get(lotId) ?? BigInt(0), expiresOn: lot.expiresOn, lotStatus: lot.status };
    }),
  });
  const dispositions = new Set<PosInventoryDisposition>();
  let restockedMicros = BigInt(0);
  let aggregateDeltaMicros = BigInt(0);
  const allocations: Array<PosFefoAllocation & { disposition: PosInventoryDisposition }> = [];
  for (let index = 0; index < planned.length; index += 1) {
    const allocation = planned[index];
    const lot = lotById.get(allocation.lotId)!;
    const before = lot.quantityMicros;
    const returnedAfter = before + allocation.quantityMicros;
    const scopeKey = input.trackedProductId == null ? "line" : `${input.trackedProductId}:${input.trackedVariationId ?? 0}`;
    const baseKey = `${input.idempotencyKey}:tracked-${input.referenceType}:${input.saleItemId}:${scopeKey}:${lot.id}:${index}`;
    await tx.posInventoryLotMovement.create({ data: {
      lotId: lot.id,
      ...(input.returnItemId ? { returnItemId: input.returnItemId } : { saleItemId: input.saleItemId }),
      type: "return",
      quantityMicros: allocation.quantityMicros,
      balanceBeforeMicros: before,
      balanceAfterMicros: returnedAfter,
      referenceType: input.referenceType,
      referenceId: input.referenceId,
      idempotencyKey: `${baseKey}:return`,
      actor: input.actor,
      metadata: { ...trackingMetadata(lot, input.referenceType), disposition: allocation.disposition },
    } });
    if (allocation.disposition === "discard") {
      await tx.posInventoryLotMovement.create({ data: {
        lotId: lot.id,
        ...(input.returnItemId ? { returnItemId: input.returnItemId } : { saleItemId: input.saleItemId }),
        type: "discard",
        quantityMicros: -allocation.quantityMicros,
        balanceBeforeMicros: returnedAfter,
        balanceAfterMicros: before,
        referenceType: input.referenceType,
        referenceId: input.referenceId,
        idempotencyKey: `${baseKey}:discard`,
        actor: input.actor,
        metadata: trackingMetadata(lot, "discard"),
      } });
    } else if (allocation.disposition === "quarantine" && !lot.normalizedSerialNumber) {
      // A batch may contain units that were never sold, and future returns may
      // have a different disposition. Always split the returned portion into a
      // non-sellable bucket while the original identity stays untouched.
      await tx.posInventoryLotMovement.create({ data: {
        lotId: lot.id,
        ...(input.returnItemId ? { returnItemId: input.returnItemId } : { saleItemId: input.saleItemId }),
        type: "transfer_out",
        quantityMicros: -allocation.quantityMicros,
        balanceBeforeMicros: returnedAfter,
        balanceAfterMicros: before,
        referenceType: input.referenceType,
        referenceId: input.referenceId,
        idempotencyKey: `${baseKey}:quarantine-out`,
        actor: input.actor,
        metadata: trackingMetadata(lot, "quarantine_split"),
      } });
      const quarantine = await quarantineBucket(tx, lot);
      const quarantineBefore = quarantine.quantityMicros;
      const quarantineAfter = quarantineBefore + allocation.quantityMicros;
      const bucketChanged = await tx.posInventoryLot.updateMany({
        where: { id: quarantine.id, status: "quarantine", bucketKey: "quarantine", quantityMicros: quarantineBefore, reservedMicros: quarantine.reservedMicros },
        data: { quantityMicros: quarantineAfter },
      });
      if (bucketChanged.count !== 1) throw new PosInventoryOperationError("O bucket de quarentena mudou durante o pós-venda. Atualize e tente novamente.");
      await tx.posInventoryLotMovement.create({ data: {
        lotId: quarantine.id,
        ...(input.returnItemId ? { returnItemId: input.returnItemId } : { saleItemId: input.saleItemId }),
        type: "transfer_in",
        quantityMicros: allocation.quantityMicros,
        balanceBeforeMicros: quarantineBefore,
        balanceAfterMicros: quarantineAfter,
        referenceType: input.referenceType,
        referenceId: input.referenceId,
        idempotencyKey: `${baseKey}:quarantine-in`,
        actor: input.actor,
        metadata: trackingMetadata(lot, "quarantine_split"),
      } });
      quarantine.quantityMicros = quarantineAfter;
    } else {
      const targetStatus = allocation.disposition === "restock" ? "available" : "quarantine";
      const changed = await tx.posInventoryLot.updateMany({
        where: { id: lot.id, quantityMicros: before, reservedMicros: lot.reservedMicros, status: lot.status },
        data: { quantityMicros: returnedAfter, status: targetStatus },
      });
      if (changed.count !== 1) throw new PosInventoryOperationError("O lote/série mudou durante o pós-venda. Atualize e tente novamente.");
      lot.quantityMicros = returnedAfter;
      lot.status = targetStatus;
    }
    dispositions.add(allocation.disposition);
    if (allocation.disposition === "restock") {
      restockedMicros += allocation.quantityMicros;
      aggregateDeltaMicros += allocation.quantityMicros;
    }
    allocations.push({
      lotId: lot.id,
      quantityMicros: allocation.quantityMicros,
      quantity: allocation.quantity,
      lotCode: lot.lotCode,
      serialNumber: lot.serialNumber,
      expiresOn: lot.expiresOn?.toISOString().slice(0, 10) ?? null,
      disposition: allocation.disposition,
    });
  }
  return {
    tracked: true,
    variationId: [...trackedVariationIds][0],
    restockedQuantity: microsToQuantity(restockedMicros),
    aggregateQuantityDelta: microsToQuantity(aggregateDeltaMicros),
    effectiveDisposition: dispositions.size === 1 ? [...dispositions][0] : "mixed",
    allocations,
  };
}

async function lockTrackedLots(tx: Prisma.TransactionClient, warehouseId: number, productId: number, variationId: number | null) {
  const locked = await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`
    SELECT "id" FROM "pos_inventory_lots"
    WHERE "warehouse_id" = ${warehouseId}
      AND "product_id" = ${productId}
      AND "variation_id" IS NOT DISTINCT FROM ${variationId}
    ORDER BY "id" FOR UPDATE
  `);
  if (!locked.length) return [];
  return tx.posInventoryLot.findMany({ where: { id: { in: locked.map((row) => row.id) } }, orderBy: { id: "asc" } });
}

async function lockLotsById(tx: Prisma.TransactionClient, lotIds: string[]) {
  if (!lotIds.length) return;
  await tx.$queryRaw(Prisma.sql`SELECT "id" FROM "pos_inventory_lots" WHERE "id" IN (${Prisma.join(lotIds)}) ORDER BY "id" FOR UPDATE`);
}

async function quarantineBucket(tx: Prisma.TransactionClient, lot: Awaited<ReturnType<typeof lockTrackedLots>>[number]) {
  if (!lot.normalizedLotCode || lot.normalizedSerialNumber) throw new PosInventoryOperationError("Somente lotes não serializados podem ser segregados em bucket de quarentena.");
  const locked = await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`
    SELECT "id" FROM "pos_inventory_lots"
    WHERE "warehouse_id" = ${lot.warehouseId}
      AND "product_id" = ${lot.productId}
      AND "variation_id" IS NOT DISTINCT FROM ${lot.variationId}
      AND "normalized_lot_code" = ${lot.normalizedLotCode}
      AND "bucket_key" = 'quarantine'
    FOR UPDATE
  `);
  if (locked[0]) return tx.posInventoryLot.findUniqueOrThrow({ where: { id: locked[0].id } });
  return tx.posInventoryLot.create({ data: {
    warehouseId: lot.warehouseId,
    productId: lot.productId,
    variationId: lot.variationId,
    lotCode: lot.lotCode,
    normalizedLotCode: lot.normalizedLotCode,
    manufacturedOn: lot.manufacturedOn,
    expiresOn: lot.expiresOn,
    receivedAt: lot.receivedAt,
    bucketKey: "quarantine",
    status: "quarantine",
    quantityMicros: BigInt(0),
    reservedMicros: BigInt(0),
    metadata: { sourceLotId: lot.id, disposition: "quarantine" },
  } });
}

function toCandidate(lot: Awaited<ReturnType<typeof lockTrackedLots>>[number]): PosTrackedStockCandidate {
  return {
    id: lot.id,
    warehouseId: lot.warehouseId,
    productId: lot.productId,
    variationId: lot.variationId,
    lotCode: lot.lotCode,
    normalizedLotCode: lot.normalizedLotCode,
    serialNumber: lot.serialNumber,
    normalizedSerialNumber: lot.normalizedSerialNumber,
    expiresOn: lot.expiresOn,
    receivedAt: lot.receivedAt,
    status: lot.status,
    quantityMicros: lot.quantityMicros,
    reservedMicros: lot.reservedMicros,
  };
}

function mergeAllocations(target: Map<string, PosFefoAllocation>, source: PosFefoAllocation[]) {
  for (const allocation of source) {
    const current = target.get(allocation.lotId);
    const quantityMicros = (current?.quantityMicros ?? BigInt(0)) + allocation.quantityMicros;
    target.set(allocation.lotId, { ...allocation, quantityMicros, quantity: microsToQuantity(quantityMicros) });
  }
}

function consumeCandidates(candidates: PosTrackedStockCandidate[], allocations: PosFefoAllocation[]) {
  const allocated = new Map(allocations.map((allocation) => [allocation.lotId, allocation.quantityMicros]));
  for (const candidate of candidates) candidate.quantityMicros = BigInt(candidate.quantityMicros) - (allocated.get(candidate.id) ?? BigInt(0));
}

function sumByLot(rows: Array<{ lotId: string; quantityMicros: bigint }>) {
  const result = new Map<string, bigint>();
  for (const row of rows) result.set(row.lotId, (result.get(row.lotId) ?? BigInt(0)) + row.quantityMicros);
  return result;
}

function trackingMetadata(lot: { lotCode: string | null; serialNumber: string | null; expiresOn: Date | null }, operation: string): Prisma.InputJsonObject {
  return { operation, lotCode: lot.lotCode, serialNumber: lot.serialNumber, expiresOn: lot.expiresOn?.toISOString().slice(0, 10) ?? null };
}

function emptyResult(): PosTrackedMutationResult {
  return { tracked: false, variationId: null, restockedQuantity: 0, aggregateQuantityDelta: 0, effectiveDisposition: null, allocations: [] };
}

function hasIdentity(value: Record<string, unknown>) {
  return value.lot != null && String(value.lot).trim() !== "" || value.serial != null && String(value.serial).trim() !== "";
}

function optionalIdentity(value: unknown, label: string) {
  if (value == null || String(value).trim() === "") return null;
  const text = String(value).trim();
  normalizePosTrackingIdentity(text, label);
  return text;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function microsToQuantity(value: bigint) {
  return Number(value) / Number(POS_QUANTITY_SCALE);
}
