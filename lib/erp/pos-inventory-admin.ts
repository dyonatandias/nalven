import { createHash } from "node:crypto";
import { Prisma } from "@/generated/tenant/client";
import { applyPosCommonStockChange, PosCommonStockError } from "@/lib/erp/pos-common-stock";
import { assertPosLotMovement, normalizePosTrackingIdentity, POS_QUANTITY_SCALE, PosInventoryTrackingError, quantityToMicros } from "@/lib/erp/pos-inventory-tracking";

export const POS_INVENTORY_ADMIN_ACTIONS = ["inventory.receive", "inventory.quarantine", "inventory.release", "inventory.discard"] as const;
export type PosInventoryAdminAction = typeof POS_INVENTORY_ADMIN_ACTIONS[number];

type Common = { action: PosInventoryAdminAction; idempotencyKey: string; branchId: number };
export type PosInventoryAdminInput =
  | Common & { action: "inventory.receive"; warehouseId: number; productId: number; variationId: number | null; lotCode: string | null; serialNumber: string | null; manufacturedOn: string | null; expiresOn: string | null; quantity: number; note: string | null }
  | Common & { action: "inventory.quarantine"; lotId: string; quantity: number; reason: string }
  | Common & { action: "inventory.release"; lotId: string; quantity: number; reason: string }
  | Common & { action: "inventory.discard"; lotId: string; quantity: number; reason: string };

export class PosInventoryAdminError extends Error {
  constructor(message: string, public readonly status = 422) {
    super(message);
    this.name = "PosInventoryAdminError";
  }
}

export function parsePosInventoryAdminInput(body: Record<string, unknown>): PosInventoryAdminInput {
  const action = choice(body.action, POS_INVENTORY_ADMIN_ACTIONS, "Ação");
  const idempotencyKey = key(body.idempotencyKey), branchId = id(body.branchId, "Filial");
  if (action === "inventory.receive") {
    onlyKeys(body, ["action", "idempotencyKey", "branchId", "warehouseId", "productId", "variationId", "lotCode", "serialNumber", "manufacturedOn", "expiresOn", "quantity", "note"]);
    const lotCode = optionalIdentity(body.lotCode, 160, "Lote"), serialNumber = optionalIdentity(body.serialNumber, 200, "Série");
    if (!lotCode && !serialNumber) throw new PosInventoryAdminError("Informe lote, série ou ambos.");
    const manufacturedOn = optionalDate(body.manufacturedOn, "Fabricação"), expiresOn = optionalDate(body.expiresOn, "Validade");
    if (manufacturedOn && expiresOn && manufacturedOn > expiresOn) throw new PosInventoryAdminError("A fabricação não pode ser posterior à validade.");
    const quantity = trackedQuantity(body.quantity);
    if (serialNumber && quantityToMicros(quantity) !== POS_QUANTITY_SCALE) throw new PosInventoryAdminError("Uma série representa exatamente uma unidade.");
    return {
      action, idempotencyKey, branchId, warehouseId: id(body.warehouseId, "Depósito"), productId: id(body.productId, "Produto"),
      variationId: nullableId(body.variationId, "Variação"), lotCode, serialNumber, manufacturedOn, expiresOn,
      quantity, note: optionalText(body.note, 300),
    };
  }
  onlyKeys(body, ["action", "idempotencyKey", "branchId", "lotId", "quantity", "reason"]);
  return { action, idempotencyKey, branchId, lotId: text(body.lotId, "Lote/série", 1, 160), quantity: trackedQuantity(body.quantity), reason: text(body.reason, "Motivo", 4, 300) };
}

export function hashPosInventoryAdminInput(input: PosInventoryAdminInput) {
  const payload = { ...input } as Record<string, unknown>;
  delete payload.idempotencyKey;
  return createHash("sha256").update(canonicalJson(payload)).digest("hex");
}

export async function applyPosInventoryAdminMutation(
  tx: Prisma.TransactionClient,
  input: PosInventoryAdminInput,
  context: { actor: string; businessDate: string },
) {
  if (input.action === "inventory.receive") return receive(tx, input, context);
  const lot = await lockedLot(tx, input.lotId);
  if (lot.metadata && typeof lot.metadata === "object" && !Array.isArray(lot.metadata)
      && typeof lot.metadata.productionReportId === "string") {
    const report = await tx.productionReport.findUnique({ where: { id: lot.metadata.productionReportId } });
    if (report?.status === "quarantine") {
      throw new PosInventoryAdminError("Este lote aguarda inspeção de produção. Registre a decisão de qualidade na ordem antes de movimentá-lo.", 409);
    }
  }
  const scope = await activeInventoryScope(tx, input.branchId, lot.warehouseId, lot.productId, lot.variationId);
  if (input.action === "inventory.quarantine") return quarantine(tx, input, lot, scope, context);
  if (input.action === "inventory.release") return release(tx, input, lot, scope, context);
  return discard(tx, input, lot, scope, context);
}

async function receive(tx: Prisma.TransactionClient, input: Extract<PosInventoryAdminInput, { action: "inventory.receive" }>, context: { actor: string; businessDate: string }) {
  const scope = await activeInventoryScope(tx, input.branchId, input.warehouseId, input.productId, input.variationId);
  if (input.manufacturedOn && input.manufacturedOn > context.businessDate) throw new PosInventoryAdminError("A fabricação não pode estar no futuro.");
  if (input.expiresOn && input.expiresOn < context.businessDate) throw new PosInventoryAdminError("Não é permitido receber lote/série já vencido.");
  if (input.serialNumber && quantityToMicros(input.quantity) !== POS_QUANTITY_SCALE) throw new PosInventoryAdminError("Uma série representa exatamente uma unidade.");
  const normalizedLotCode = input.lotCode ? normalizedIdentity(input.lotCode, "Lote", 160) : null;
  const normalizedSerialNumber = input.serialNumber ? normalizedIdentity(input.serialNumber, "Série", 200) : null;
  const siblings = await lockIdentity(tx, { warehouseId: input.warehouseId, productId: input.productId, variationId: scope.variationId, normalizedLotCode, normalizedSerialNumber });
  if (normalizedSerialNumber && siblings.length) throw new PosInventoryAdminError("Esta série já foi cadastrada e não pode ser reutilizada.", 409);
  let lot = normalizedSerialNumber ? null : siblings.find(item => item.bucketKey === "sellable" && item.normalizedSerialNumber == null) || null;
  let beforeData: Record<string, unknown> | null = null;
  if (lot) {
    if (!datesEqual(lot.manufacturedOn, input.manufacturedOn) || !datesEqual(lot.expiresOn, input.expiresOn)) throw new PosInventoryAdminError("O lote já existe com fabricação ou validade diferente; o histórico não pode ser editado.", 409);
    if (!new Set(["available", "depleted"]).has(lot.status)) throw new PosInventoryAdminError("O lote existente não está apto a novo recebimento.", 409);
    beforeData = lotSnapshot(lot);
  } else {
    lot = await tx.posInventoryLot.create({ data: {
      warehouseId: input.warehouseId, productId: input.productId, variationId: scope.variationId,
      lotCode: input.lotCode, normalizedLotCode, serialNumber: input.serialNumber, normalizedSerialNumber,
      manufacturedOn: input.manufacturedOn ? new Date(`${input.manufacturedOn}T00:00:00.000Z`) : null,
      expiresOn: input.expiresOn ? new Date(`${input.expiresOn}T00:00:00.000Z`) : null,
      bucketKey: "sellable", status: "available", quantityMicros: BigInt(0), reservedMicros: BigInt(0),
      metadata: input.note ? { receiptNote: input.note } : undefined,
    } });
  }
  const delta = quantityToMicros(input.quantity), before = lot.quantityMicros, after = assertPosLotMovement("receipt", before, delta);
  const changed = await tx.posInventoryLot.updateMany({ where: { id: lot.id, quantityMicros: before, reservedMicros: lot.reservedMicros, status: lot.status, bucketKey: "sellable" }, data: { quantityMicros: after, status: "available" } });
  if (changed.count !== 1) throw changedError();
  await trackedMovement(tx, lot.id, "receipt", delta, before, after, input.idempotencyKey, context.actor, input.note);
  await aggregateMovement(tx, scope, input.quantity, "receipt", input.idempotencyKey, context.actor);
  const saved = await tx.posInventoryLot.findUniqueOrThrow({ where: { id: lot.id }, include: lotInclude });
  return mutationResult(saved, beforeData ? 200 : 201, beforeData, { receivedQuantity: input.quantity });
}

async function quarantine(
  tx: Prisma.TransactionClient,
  input: Extract<PosInventoryAdminInput, { action: "inventory.quarantine" }>,
  lot: LockedLot,
  scope: InventoryScope,
  context: { actor: string; businessDate: string },
) {
  if (lot.bucketKey !== "sellable" || lot.status !== "available") throw new PosInventoryAdminError("Somente saldo vendável e disponível pode ser enviado à quarentena.", 409);
  const quantityMicros = quantityToMicros(input.quantity);
  assertAvailable(lot, quantityMicros);
  const beforeData = lotSnapshot(lot);
  if (lot.normalizedSerialNumber) {
    if (quantityMicros !== POS_QUANTITY_SCALE || lot.quantityMicros !== POS_QUANTITY_SCALE) throw new PosInventoryAdminError("A quarentena de uma série deve mover sua única unidade.");
    const changed = await tx.posInventoryLot.updateMany({ where: lotCas(lot), data: { bucketKey: "quarantine", status: "quarantine" } });
    if (changed.count !== 1) throw changedError();
    await trackedMovement(tx, lot.id, "status_change", BigInt(0), lot.quantityMicros, lot.quantityMicros, input.idempotencyKey, context.actor, input.reason);
  } else {
    const after = lot.quantityMicros - quantityMicros;
    const changed = await tx.posInventoryLot.updateMany({ where: lotCas(lot), data: { quantityMicros: after, ...(after === BigInt(0) ? { status: "depleted" } : {}) } });
    if (changed.count !== 1) throw changedError();
    await trackedMovement(tx, lot.id, "transfer_out", -quantityMicros, lot.quantityMicros, after, `${input.idempotencyKey}:out`, context.actor, input.reason);
    const bucket = await getOrCreateBucket(tx, lot, "quarantine");
    const bucketBefore = bucket.quantityMicros, bucketAfter = assertPosLotMovement("transfer_in", bucketBefore, quantityMicros);
    const bucketChanged = await tx.posInventoryLot.updateMany({ where: lotCas(bucket), data: { quantityMicros: bucketAfter } });
    if (bucketChanged.count !== 1) throw changedError();
    await trackedMovement(tx, bucket.id, "transfer_in", quantityMicros, bucketBefore, bucketAfter, `${input.idempotencyKey}:in`, context.actor, input.reason);
  }
  await aggregateMovement(tx, scope, -input.quantity, "quarantine", input.idempotencyKey, context.actor);
  const saved = await tx.posInventoryLot.findUniqueOrThrow({ where: { id: lot.id }, include: lotInclude });
  return mutationResult(saved, 200, beforeData, { quarantinedQuantity: input.quantity });
}

async function release(
  tx: Prisma.TransactionClient,
  input: Extract<PosInventoryAdminInput, { action: "inventory.release" }>,
  lot: LockedLot,
  scope: InventoryScope,
  context: { actor: string; businessDate: string },
) {
  if (lot.bucketKey !== "quarantine" || lot.status !== "quarantine") throw new PosInventoryAdminError("Somente bucket de quarentena pode ser liberado.", 409);
  const expiry = dateValue(lot.expiresOn);
  if (expiry && expiry < context.businessDate) throw new PosInventoryAdminError("Lote/série vencido não pode ser liberado.", 409);
  const quantityMicros = quantityToMicros(input.quantity);
  assertAvailable(lot, quantityMicros);
  const beforeData = lotSnapshot(lot);
  if (lot.normalizedSerialNumber) {
    if (quantityMicros !== POS_QUANTITY_SCALE || lot.quantityMicros !== POS_QUANTITY_SCALE) throw new PosInventoryAdminError("A liberação de uma série deve mover sua única unidade.");
    const changed = await tx.posInventoryLot.updateMany({ where: lotCas(lot), data: { bucketKey: "sellable", status: "available" } });
    if (changed.count !== 1) throw changedError();
    await trackedMovement(tx, lot.id, "status_change", BigInt(0), lot.quantityMicros, lot.quantityMicros, input.idempotencyKey, context.actor, input.reason);
  } else {
    const after = lot.quantityMicros - quantityMicros;
    const changed = await tx.posInventoryLot.updateMany({ where: lotCas(lot), data: { quantityMicros: after } });
    if (changed.count !== 1) throw changedError();
    await trackedMovement(tx, lot.id, "transfer_out", -quantityMicros, lot.quantityMicros, after, `${input.idempotencyKey}:out`, context.actor, input.reason);
    const sellable = await getOrCreateBucket(tx, lot, "sellable");
    if (!new Set(["available", "depleted"]).has(sellable.status)) throw new PosInventoryAdminError("O bucket vendável correspondente não pode ser reativado.", 409);
    const sellableBefore = sellable.quantityMicros, sellableAfter = assertPosLotMovement("transfer_in", sellableBefore, quantityMicros);
    const sellableChanged = await tx.posInventoryLot.updateMany({ where: lotCas(sellable), data: { quantityMicros: sellableAfter, status: "available" } });
    if (sellableChanged.count !== 1) throw changedError();
    await trackedMovement(tx, sellable.id, "transfer_in", quantityMicros, sellableBefore, sellableAfter, `${input.idempotencyKey}:in`, context.actor, input.reason);
  }
  await aggregateMovement(tx, scope, input.quantity, "release", input.idempotencyKey, context.actor);
  const saved = await tx.posInventoryLot.findUniqueOrThrow({ where: { id: lot.id }, include: lotInclude });
  return mutationResult(saved, 200, beforeData, { releasedQuantity: input.quantity });
}

async function discard(
  tx: Prisma.TransactionClient,
  input: Extract<PosInventoryAdminInput, { action: "inventory.discard" }>,
  lot: LockedLot,
  scope: InventoryScope,
  context: { actor: string; businessDate: string },
) {
  if (!new Set(["available", "quarantine", "blocked", "expired"]).has(lot.status)) throw new PosInventoryAdminError("Este lote/série não possui saldo descartável.", 409);
  const quantityMicros = quantityToMicros(input.quantity);
  assertAvailable(lot, quantityMicros);
  const beforeData = lotSnapshot(lot), after = assertPosLotMovement("discard", lot.quantityMicros, -quantityMicros);
  const changed = await tx.posInventoryLot.updateMany({ where: lotCas(lot), data: { quantityMicros: after, ...(lot.bucketKey === "sellable" && after === BigInt(0) ? { status: "depleted" } : {}) } });
  if (changed.count !== 1) throw changedError();
  await trackedMovement(tx, lot.id, "discard", -quantityMicros, lot.quantityMicros, after, input.idempotencyKey, context.actor, input.reason);
  if (lot.bucketKey === "sellable") await aggregateMovement(tx, scope, -input.quantity, "discard", input.idempotencyKey, context.actor);
  const saved = await tx.posInventoryLot.findUniqueOrThrow({ where: { id: lot.id }, include: lotInclude });
  return mutationResult(saved, 200, beforeData, { discardedQuantity: input.quantity });
}

const lotInclude = {
  warehouse: { select: { id: true, code: true, name: true, branchId: true } },
  product: { select: { id: true, sku: true, name: true } },
  variation: { select: { id: true, sku: true, attributes: true } },
  _count: { select: { movements: true } },
} satisfies Prisma.PosInventoryLotInclude;

type LockedLot = Prisma.PosInventoryLotGetPayload<Record<string, never>>;
type InventoryScope = Awaited<ReturnType<typeof activeInventoryScope>>;

async function activeInventoryScope(tx: Prisma.TransactionClient, branchId: number, warehouseId: number, productId: number, variationId: number | null) {
  const [branch, warehouse, product] = await Promise.all([
    tx.branch.findFirst({ where: { id: branchId, status: "active" }, select: { id: true, timezone: true } }),
    tx.warehouse.findFirst({ where: { id: warehouseId, branchId, active: true }, select: { id: true, branchId: true } }),
    tx.product.findFirst({
      where: { id: productId, active: true, branchConfigurations: { some: { branchId, active: true } } },
      select: { id: true, name: true, type: true, manageStock: true, stock: true, variations: { where: { enabled: true }, select: { id: true, productId: true, manageStock: true, stock: true } } },
    }),
  ]);
  if (!branch) throw new PosInventoryAdminError("Filial ativa não encontrada.", 404);
  if (!warehouse) throw new PosInventoryAdminError("Depósito ativo da filial não encontrado.", 404);
  if (!product) throw new PosInventoryAdminError("Produto ativo e vinculado à filial não encontrado.", 404);
  if (product.type === "service") throw new PosInventoryAdminError("Serviço não pode possuir lote ou série.");
  const variation = variationId == null ? null : product.variations.find(item => item.id === variationId) || null;
  if (variationId != null && !variation) throw new PosInventoryAdminError("Variação ativa e compatível não encontrada.", 404);
  if (variation && variation.manageStock !== "true") throw new PosInventoryAdminError("Esta variação não possui controle de estoque próprio; cadastre o lote no produto pai.");
  if (!variation && !product.manageStock) throw new PosInventoryAdminError("O produto não possui controle de estoque.");
  return { branch, warehouse, product, variation, variationId: variation?.id ?? null };
}

async function lockedLot(tx: Prisma.TransactionClient, lotId: string) {
  const found = await tx.posInventoryLot.findUnique({ where: { id: lotId } });
  if (!found) throw new PosInventoryAdminError("Lote/série não encontrado.", 404);
  await lockIdentity(tx, found);
  return tx.posInventoryLot.findUniqueOrThrow({ where: { id: lotId } });
}

async function lockIdentity(tx: Prisma.TransactionClient, value: { warehouseId: number; productId: number; variationId: number | null; normalizedLotCode: string | null; normalizedSerialNumber: string | null }) {
  if (value.normalizedSerialNumber) {
    const ids = await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`SELECT "id" FROM "pos_inventory_lots" WHERE "normalized_serial_number" = ${value.normalizedSerialNumber} ORDER BY "id" FOR UPDATE`);
    return ids.length ? tx.posInventoryLot.findMany({ where: { id: { in: ids.map(item => item.id) } }, orderBy: { id: "asc" } }) : [];
  }
  if (!value.normalizedLotCode) return [];
  const ids = await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`
    SELECT "id" FROM "pos_inventory_lots"
    WHERE "warehouse_id" = ${value.warehouseId} AND "product_id" = ${value.productId}
      AND "variation_id" IS NOT DISTINCT FROM ${value.variationId}
      AND "normalized_lot_code" = ${value.normalizedLotCode}
    ORDER BY "id" FOR UPDATE
  `);
  return ids.length ? tx.posInventoryLot.findMany({ where: { id: { in: ids.map(item => item.id) } }, orderBy: { id: "asc" } }) : [];
}

async function getOrCreateBucket(tx: Prisma.TransactionClient, source: LockedLot, bucketKey: "sellable" | "quarantine") {
  if (!source.normalizedLotCode || source.normalizedSerialNumber) throw new PosInventoryAdminError("Somente lote batch pode ser dividido entre buckets.");
  const existing = await tx.posInventoryLot.findFirst({ where: {
    warehouseId: source.warehouseId, productId: source.productId, variationId: source.variationId,
    normalizedLotCode: source.normalizedLotCode, normalizedSerialNumber: null, bucketKey,
  } });
  if (existing) {
    if (!datesEqual(existing.manufacturedOn, dateValue(source.manufacturedOn)) || !datesEqual(existing.expiresOn, dateValue(source.expiresOn))) throw new PosInventoryAdminError("Buckets do mesmo lote possuem datas incompatíveis.", 409);
    return existing;
  }
  return tx.posInventoryLot.create({ data: {
    warehouseId: source.warehouseId, productId: source.productId, variationId: source.variationId,
    lotCode: source.lotCode, normalizedLotCode: source.normalizedLotCode,
    manufacturedOn: source.manufacturedOn, expiresOn: source.expiresOn, receivedAt: source.receivedAt,
    bucketKey, status: bucketKey === "quarantine" ? "quarantine" : "available",
    quantityMicros: BigInt(0), reservedMicros: BigInt(0), metadata: { sourceLotId: source.id, bucket: bucketKey },
  } });
}

async function aggregateMovement(tx: Prisma.TransactionClient, scope: InventoryScope, delta: number, type: string, referenceId: string, actor: string) {
  let balance = await tx.warehouseBalance.findUnique({ where: { warehouseId_productId: { warehouseId: scope.warehouse.id, productId: scope.product.id } } });
  let variationBalance = scope.variation ? await tx.warehouseVariationBalance.findUnique({ where: { warehouseId_variationId: { warehouseId: scope.warehouse.id, variationId: scope.variation.id } } }) : null;
  if (!balance || scope.variation && !variationBalance) {
    await tx.$queryRaw(Prisma.sql`SELECT "id" FROM "warehouses" WHERE "id" = ${scope.warehouse.id} FOR UPDATE`);
    balance = await tx.warehouseBalance.findUnique({ where: { warehouseId_productId: { warehouseId: scope.warehouse.id, productId: scope.product.id } } });
    if (!balance) balance = await tx.warehouseBalance.create({ data: { warehouseId: scope.warehouse.id, productId: scope.product.id, quantity: 0, reservedQuantity: 0 } });
    if (scope.variation) {
      variationBalance = await tx.warehouseVariationBalance.findUnique({ where: { warehouseId_variationId: { warehouseId: scope.warehouse.id, variationId: scope.variation.id } } });
      if (!variationBalance) variationBalance = await tx.warehouseVariationBalance.create({ data: { warehouseId: scope.warehouse.id, productId: scope.product.id, variationId: scope.variation.id, quantity: 0, reservedQuantity: 0 } });
    }
  }
  try {
    await applyPosCommonStockChange(tx, {
      warehouseId: scope.warehouse.id,
      product: scope.product,
      variation: scope.variation,
      delta,
      allowNegative: false,
      movementType: delta >= 0 ? "entry" : "exit",
      ledgerType: type,
      referenceType: "pos_inventory_admin",
      referenceId,
      actor,
      note: `PDV rastreado: ${type} · ${referenceId}`,
    });
  } catch (error) {
    if (error instanceof PosCommonStockError) throw new PosInventoryAdminError(error.message, error.status);
    throw error;
  }
}

async function trackedMovement(tx: Prisma.TransactionClient, lotId: string, type: string, delta: bigint, before: bigint, after: bigint, idempotencyKey: string, actor: string, reason: string | null) {
  assertPosLotMovement(type, before, delta);
  await tx.posInventoryLotMovement.create({ data: {
    lotId, type, quantityMicros: delta, balanceBeforeMicros: before, balanceAfterMicros: after,
    referenceType: "pos_inventory_admin", referenceId: idempotencyKey, idempotencyKey: `inventory-admin:${idempotencyKey}`,
    actor, metadata: reason ? { reason } : undefined,
  } });
}

function mutationResult(value: Prisma.PosInventoryLotGetPayload<{ include: typeof lotInclude }>, status: number, beforeData: Record<string, unknown> | null, detail: Record<string, unknown>) {
  return { entityType: "pos_inventory_lot", entityId: value.id, status, beforeData: beforeData || undefined, body: { lot: posInventoryLotDto(value), ...detail } };
}

export function posInventoryLotDto(value: Prisma.PosInventoryLotGetPayload<{ include: typeof lotInclude }>) {
  return {
    id: value.id, warehouseId: value.warehouseId, productId: value.productId, variationId: value.variationId,
    lotCode: value.lotCode, serialNumber: value.serialNumber, manufacturedOn: dateValue(value.manufacturedOn), expiresOn: dateValue(value.expiresOn),
    bucketKey: value.bucketKey, status: value.status, quantityMicros: value.quantityMicros.toString(), reservedMicros: value.reservedMicros.toString(),
    quantity: microsToQuantity(value.quantityMicros), reservedQuantity: microsToQuantity(value.reservedMicros), receivedAt: value.receivedAt,
    warehouse: value.warehouse, product: value.product, variation: value.variation, movementCount: value._count.movements,
  };
}

function lotCas(lot: LockedLot) { return { id: lot.id, quantityMicros: lot.quantityMicros, reservedMicros: lot.reservedMicros, status: lot.status, bucketKey: lot.bucketKey }; }
function lotSnapshot(lot: LockedLot) { return { id: lot.id, bucketKey: lot.bucketKey, status: lot.status, quantityMicros: lot.quantityMicros.toString(), reservedMicros: lot.reservedMicros.toString() }; }
function assertAvailable(lot: LockedLot, quantityMicros: bigint) { if (quantityMicros > lot.quantityMicros - lot.reservedMicros) throw new PosInventoryAdminError("Quantidade superior ao saldo disponível não reservado.", 409); }
function changedError() { return new PosInventoryAdminError("O saldo rastreado mudou durante a operação. Atualize e tente novamente.", 409); }
function datesEqual(value: Date | null, expected: string | null) { return dateValue(value) === expected; }
function dateValue(value: Date | null) { return value?.toISOString().slice(0, 10) ?? null; }
function normalizedIdentity(value: string, label: string, maximum: number) { const normalized = normalizePosTrackingIdentity(value, label); if (normalized.length > maximum) throw new PosInventoryAdminError(`${label} normalizado excede o limite.`); return normalized; }
function microsToQuantity(value: bigint) { return Number(value) / Number(POS_QUANTITY_SCALE); }
function trackedQuantity(value: unknown) { if (typeof value !== "number") throw new PosInventoryAdminError("Quantidade inválida."); const result = value; try { quantityToMicros(result); } catch (error) { if (error instanceof PosInventoryTrackingError) throw new PosInventoryAdminError(error.message); throw error; } return result; }
function optionalIdentity(value: unknown, maximum: number, label: string) { const result = optionalText(value, maximum); if (!result) return null; normalizedIdentity(result, label, maximum); return result; }
function optionalDate(value: unknown, label: string) { if (value == null || value === "") return null; if (typeof value !== "string") throw new PosInventoryAdminError(`${label} inválida.`); const result = value; if (!/^\d{4}-\d{2}-\d{2}$/.test(result) || new Date(`${result}T00:00:00.000Z`).toISOString().slice(0, 10) !== result) throw new PosInventoryAdminError(`${label} inválida.`); return result; }
function optionalText(value: unknown, maximum: number) { if (value == null || value === "") return null; return text(value, "Texto", 1, maximum); }
function key(value: unknown) { if (typeof value !== "string") throw new PosInventoryAdminError("Chave de idempotência inválida."); const result = value.trim(); if (result.length < 16 || result.length > 160 || !/^[A-Za-z0-9._:-]+$/.test(result)) throw new PosInventoryAdminError("Chave de idempotência inválida."); return result; }
function id(value: unknown, label: string) { if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) throw new PosInventoryAdminError(`${label} inválido.`); return value; }
function nullableId(value: unknown, label: string) { return value == null || value === "" ? null : id(value, label); }
function text(value: unknown, label: string, minimum: number, maximum: number) { if (typeof value !== "string") throw new PosInventoryAdminError(`${label} inválido.`); const result = value.trim(); if (result.length < minimum || result.length > maximum) throw new PosInventoryAdminError(`${label} inválido.`); return result; }
function choice<const T extends readonly string[]>(value: unknown, choices: T, label: string): T[number] { if (typeof value !== "string" || !choices.includes(value)) throw new PosInventoryAdminError(`${label} inválida.`); return value as T[number]; }
function onlyKeys(body: Record<string, unknown>, allowed: string[]) { const extra = Object.keys(body).find(field => !allowed.includes(field)); if (extra) throw new PosInventoryAdminError(`Campo não permitido: ${extra}.`); }
function canonicalJson(value: unknown): string { if (value === null || typeof value !== "object") return JSON.stringify(value); if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`; const record = value as Record<string, unknown>; return `{${Object.keys(record).sort().map(field => `${JSON.stringify(field)}:${canonicalJson(record[field])}`).join(",")}}`; }
