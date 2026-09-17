import assert from "node:assert/strict";
import test from "node:test";
import type { Prisma } from "../generated/tenant/client";
import { allocatePosTrackedSaleItem, parsePosScanTrackingRequests, posBusinessDate, restorePosTrackedSaleItem } from "../lib/erp/pos-inventory-operations";

test("normaliza contrato de leituras rastreadas sem aceitar quantidade excedente", () => {
  assert.deepEqual(parsePosScanTrackingRequests({ tracking: [
    { serial: " SN-1 ", quantity: 1 },
    { lot: " L-2 ", quantity: 0.5 },
  ] }, 2), [
    { serialNumber: "SN-1", lotCode: null, quantity: 1 },
    { serialNumber: null, lotCode: "L-2", quantity: 0.5 },
  ]);
  assert.throws(() => parsePosScanTrackingRequests({ tracking: [{ serial: "SN-1", quantity: 1 }, { serial: "SN-2", quantity: 1 }] }, 1), /superam/);
  assert.deepEqual(parsePosScanTrackingRequests({ tracking: [{ lot: "L", serial: "S", quantity: 1 }] }, 1), [{ lotCode: "L", serialNumber: "S", quantity: 1 }]);
});

test("mantém compatibilidade com snapshot GS1 anterior e série unitária", () => {
  assert.deepEqual(parsePosScanTrackingRequests({ lot: "LOTE-9" }, 2.5), [{ lotCode: "LOTE-9", serialNumber: null, quantity: 2.5 }]);
  assert.deepEqual(parsePosScanTrackingRequests({ serial: "SERIE-1" }, 1), [{ lotCode: null, serialNumber: "SERIE-1", quantity: 1 }]);
  assert.throws(() => parsePosScanTrackingRequests({ tracking: [{ serial: "SERIE-1", quantity: 2 }] }, 2), /exatamente uma unidade/);
  assert.throws(() => parsePosScanTrackingRequests({ serial: "SERIE-1" }, 2), /exatamente uma unidade/);
  assert.deepEqual(parsePosScanTrackingRequests({ kind: "linear" }, 4), []);
});

test("data operacional respeita o fuso da filial", () => {
  const instant = new Date("2026-08-29T01:30:00.000Z");
  assert.equal(posBusinessDate("America/Sao_Paulo", instant), "2026-08-28");
  assert.equal(posBusinessDate("UTC", instant), "2026-08-29");
  assert.throws(() => posBusinessDate("Invalid/Zone", instant), /Fuso/);
});

test("quarentena parcial separa bucket sem esconder saldo batch ainda disponível", async () => {
  const movements: Array<Record<string, unknown>> = [];
  const updates: Array<Record<string, unknown>> = [];
  let movementRead = 0;
  const lot = {
    id: "lot-sellable", warehouseId: 1, productId: 2, variationId: null, lotCode: "L-9", normalizedLotCode: "L-9",
    serialNumber: null, normalizedSerialNumber: null, manufacturedOn: null, expiresOn: new Date("2027-01-01T00:00:00Z"),
    receivedAt: new Date("2026-01-01T00:00:00Z"), bucketKey: "sellable", status: "available", quantityMicros: BigInt(3_000_000), reservedMicros: BigInt(0), metadata: null,
    createdAt: new Date(), updatedAt: new Date(),
  };
  const quarantine = { ...lot, id: "lot-quarantine", bucketKey: "quarantine", status: "quarantine", quantityMicros: BigInt(0), metadata: { sourceLotId: lot.id } };
  const tx = {
    posInventoryLotMovement: {
      findMany: async () => movementRead++ === 0 ? [{ id: BigInt(1), lotId: lot.id, saleItemId: 10, returnItemId: null, type: "sale", quantityMicros: BigInt(-2_000_000), balanceBeforeMicros: BigInt(5_000_000), balanceAfterMicros: BigInt(3_000_000), referenceType: "sale", referenceId: "20", idempotencyKey: "sale", actor: "test", metadata: null, occurredAt: new Date() }] : [],
      create: async ({ data }: { data: Record<string, unknown> }) => { movements.push(data); return data; },
    },
    posInventoryLot: {
      findMany: async () => [lot],
      findUniqueOrThrow: async () => quarantine,
      create: async () => quarantine,
      updateMany: async ({ where, data }: { where: Record<string, unknown>; data: Record<string, unknown> }) => { updates.push({ where, data }); return { count: 1 }; },
    },
    $queryRaw: async (query: { strings?: readonly string[] }) => String(query.strings || "").includes("bucket_key") ? [{ id: quarantine.id }] : [{ id: lot.id }],
  } as unknown as Prisma.TransactionClient;
  const result = await restorePosTrackedSaleItem(tx, {
    saleItemId: 10, returnItemId: 30, quantity: 1, disposition: "quarantine", businessDate: "2026-08-28",
    idempotencyKey: "return-1", actor: "Teste", referenceType: "pos_return", referenceId: "return-30",
  });
  assert.equal(result.aggregateQuantityDelta, 0);
  assert.deepEqual(movements.map((movement) => movement.type), ["return", "transfer_out", "transfer_in"]);
  assert.equal(updates.length, 1, "somente o bucket de quarentena deve mudar");
  assert.equal((updates[0].data as { quantityMicros: bigint }).quantityMicros, BigInt(1_000_000));
  assert.equal(lot.quantityMicros, BigInt(3_000_000), "saldo vendável pré-existente permanece intacto");
  assert.equal(lot.status, "available");
});

test("identidade explícita sem cadastro rastreado falha fechado", async () => {
  const tx = { $queryRaw: async () => [] } as unknown as Prisma.TransactionClient;
  await assert.rejects(allocatePosTrackedSaleItem(tx, {
    warehouseId: 1, productId: 2, variationId: null, saleItemId: 3, quantity: 1,
    scanData: { serial: "SN-NOT-REGISTERED" }, businessDate: "2026-08-28", idempotencyKey: "sale-1", actor: "Teste", referenceId: "4",
  }), /não está cadastrado/);
});

test("produto serializado exige a leitura exata e única de todas as unidades", async () => {
  const serialLots = ["SERIE-1", "SERIE-2"].map((serialNumber, index) => ({
    id: `lot-${index + 1}`, warehouseId: 1, productId: 2, variationId: null,
    lotCode: null, normalizedLotCode: null, serialNumber, normalizedSerialNumber: serialNumber,
    manufacturedOn: null, expiresOn: null, receivedAt: new Date("2026-08-29T00:00:00Z"),
    bucketKey: "sellable", status: "available", quantityMicros: BigInt(1_000_000), reservedMicros: BigInt(0),
    metadata: null, createdAt: new Date(), updatedAt: new Date(),
  }));
  const updates: unknown[] = [];
  const movements: unknown[] = [];
  const tx = {
    $queryRaw: async () => serialLots.map(({ id }) => ({ id })),
    posInventoryLot: {
      findMany: async () => serialLots,
      updateMany: async (operation: unknown) => { updates.push(operation); return { count: 1 }; },
    },
    posInventoryLotMovement: {
      create: async (operation: unknown) => { movements.push(operation); return operation; },
    },
  } as unknown as Prisma.TransactionClient;
  const base = {
    warehouseId: 1, productId: 2, variationId: null, saleItemId: 3, quantity: 2,
    businessDate: "2026-08-29", idempotencyKey: "sale-serial", actor: "Teste", referenceId: "4",
  };

  await assert.rejects(allocatePosTrackedSaleItem(tx, base), /série exato de cada unidade/);
  await assert.rejects(allocatePosTrackedSaleItem(tx, { ...base, scanData: { tracking: [{ serial: "SERIE-1" }] } }), /série exato de cada unidade/);
  await assert.rejects(allocatePosTrackedSaleItem(tx, {
    ...base,
    scanData: { tracking: [{ serial: "SERIE-1" }, { serial: " serie-1 " }] },
  }), /única vez/);
  assert.equal(updates.length, 0);
  assert.equal(movements.length, 0);
});

test("devolução anterior no lote original conta mesmo após segregação em bucket", async () => {
  let movementRead = 0;
  const lot = {
    id: "lot-origin", warehouseId: 1, productId: 2, variationId: null, lotCode: "L-10", normalizedLotCode: "L-10",
    serialNumber: null, normalizedSerialNumber: null, manufacturedOn: null, expiresOn: null, receivedAt: new Date(), bucketKey: "sellable",
    status: "available", quantityMicros: BigInt(3_000_000), reservedMicros: BigInt(0), metadata: null, createdAt: new Date(), updatedAt: new Date(),
  };
  const tx = {
    posInventoryLotMovement: {
      findMany: async () => movementRead++ === 0
        ? [{ id: BigInt(1), lotId: lot.id, saleItemId: 10, returnItemId: null, type: "sale", quantityMicros: BigInt(-2_000_000), balanceBeforeMicros: BigInt(5_000_000), balanceAfterMicros: BigInt(3_000_000), referenceType: "sale", referenceId: "20", idempotencyKey: "sale", actor: "test", metadata: null, occurredAt: new Date() }]
        : [{ lotId: lot.id, quantityMicros: BigInt(1_000_000) }],
    },
    posInventoryLot: { findMany: async () => [lot] },
    $queryRaw: async () => [{ id: lot.id }],
  } as unknown as Prisma.TransactionClient;
  await assert.rejects(restorePosTrackedSaleItem(tx, {
    saleItemId: 10, returnItemId: 31, quantity: 2, disposition: "restock", businessDate: "2026-08-28",
    idempotencyKey: "return-2", actor: "Teste", referenceType: "pos_return", referenceId: "return-31",
  }), /supera o saldo rastreado/);
});
