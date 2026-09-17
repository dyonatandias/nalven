import assert from "node:assert/strict";
import test from "node:test";
import {
  assertPosLotMovement,
  assertPosLotStatusTransition,
  normalizePosTrackingIdentity,
  planPosTrackedReturn,
  PosInventoryTrackingError,
  quantityToMicros,
  selectPosFefo,
} from "../lib/erp/pos-inventory-tracking";

const scope = { warehouseId: 1, productId: 10, variationId: null, businessDate: "2026-08-28" } as const;

test("FEFO usa validade mais próxima, recebimento e deixa saldo sem validade por último", () => {
  const result = selectPosFefo({ ...scope, quantity: 2.5, candidates: [
    lot("NO-DATE", 5, null, "2026-01-01T00:00:00Z"),
    lot("LATE", 2, "2026-12-31", "2026-01-01T00:00:00Z"),
    lot("EARLY-B", 1, "2026-08-28", "2026-02-01T00:00:00Z"),
    lot("EARLY-A", 1, "2026-08-28", "2026-01-01T00:00:00Z"),
    lot("EXPIRED", 9, "2026-08-27", "2025-01-01T00:00:00Z"),
  ] });
  assert.deepEqual(result.allocations.map((item) => [item.lotId, item.quantity]), [["EARLY-A", 1], ["EARLY-B", 1], ["LATE", 0.5]]);
});

test("lote solicitado é normalizado e falha fechado quando indisponível", () => {
  const result = selectPosFefo({ ...scope, quantity: 1, requestedLotCode: " lote 42 ", candidates: [
    { ...lot("A", 3, "2027-01-01", "2026-01-01T00:00:00Z"), lotCode: "Lote 42", normalizedLotCode: "LOTE42" },
    lot("B", 3, "2026-09-01", "2026-01-01T00:00:00Z"),
  ] });
  assert.equal(result.allocations[0].lotId, "A");
  assert.throws(() => selectPosFefo({ ...scope, quantity: 1, requestedLotCode: "bloqueado", candidates: [{ ...lot("X", 2, null, "2026-01-01"), status: "quarantine" }] }), /indisponível/);
});

test("série identifica uma unidade e impede quantidade fracionária ou duplicidade", () => {
  const serial = (id: string, value: string) => ({ ...lot(id, 1, null, "2026-01-01"), lotCode: null, normalizedLotCode: null, serialNumber: value, normalizedSerialNumber: normalizePosTrackingIdentity(value) });
  const result = selectPosFefo({ ...scope, quantity: 1, requestedSerialNumber: " sn-2 ", candidates: [serial("S1", "SN-1"), serial("S2", "SN-2")] });
  assert.equal(result.allocations[0].lotId, "S2");
  assert.equal(result.serialized, true);
  assert.throws(() => selectPosFefo({ ...scope, quantity: 0.5, candidates: [serial("S1", "SN-1")] }), /inteira/);
  assert.throws(() => selectPosFefo({ ...scope, quantity: 1, candidates: [serial("S1", "SN-1"), serial("S2", "sn-1")] }), /duplicada/);
});

test("GS1 pode vincular lote e série na mesma identidade", () => {
  const candidate = { ...lot("SERIAL-LOT", 1, "2027-01-01", "2026-01-01"), lotCode: "LOTE-9", normalizedLotCode: "LOTE-9", serialNumber: "SERIE-1", normalizedSerialNumber: "SERIE-1" };
  const result = selectPosFefo({ ...scope, quantity: 1, requestedLotCode: "lote-9", requestedSerialNumber: "serie-1", candidates: [candidate] });
  assert.equal(result.allocations[0].lotId, "SERIAL-LOT");
  assert.throws(() => selectPosFefo({ ...scope, quantity: 1, requestedLotCode: "outro-lote", requestedSerialNumber: "serie-1", candidates: [candidate] }), /Lote\/série solicitado indisponível/);
});

test("reserva, quarentena, validade e escopo nunca entram no saldo vendável", () => {
  const reserved = { ...lot("RESERVED", 2, null, "2026-01-01"), reservedMicros: BigInt(2_000_000) };
  assert.throws(() => selectPosFefo({ ...scope, quantity: 1, candidates: [reserved, { ...lot("QUARANTINE", 2, null, "2026-01-01"), status: "quarantine" }] }), /insuficiente/);
  assert.throws(() => selectPosFefo({ ...scope, quantity: 1, candidates: [{ ...lot("OTHER", 2, null, "2026-01-01"), warehouseId: 2 }] }), /outro depósito/);
});

test("quantidade usa milionésimos sem arredondamento silencioso", () => {
  assert.equal(quantityToMicros(0.000001), BigInt(1));
  assert.equal(quantityToMicros(12.345678), BigInt(12_345_678));
  assert.throws(() => quantityToMicros(0.0000001), /seis casas/);
  assert.throws(() => quantityToMicros(Number.NaN), PosInventoryTrackingError);
});

test("devolução respeita alocação original e força quarentena para lote vencido", () => {
  const result = planPosTrackedReturn({ quantity: 1.5, businessDate: "2026-08-28", disposition: "restock", originalAllocations: [
    { lotId: "EXPIRED", soldMicros: BigInt(1_000_000), returnedMicros: BigInt(0), expiresOn: "2026-08-27", lotStatus: "available" },
    { lotId: "SAFE", soldMicros: BigInt(2_000_000), returnedMicros: BigInt(500_000), expiresOn: "2027-01-01", lotStatus: "available" },
  ] });
  assert.deepEqual(result.map((item) => [item.lotId, item.quantity, item.disposition]), [["EXPIRED", 1, "quarantine"], ["SAFE", 0.5, "restock"]]);
  assert.throws(() => planPosTrackedReturn({ quantity: 4, businessDate: "2026-08-28", disposition: "restock", originalAllocations: [{ lotId: "A", soldMicros: BigInt(1_000_000), returnedMicros: BigInt(0), lotStatus: "available" }] }), /supera/);
});

test("devolução reativa identidade esgotada ainda válida", () => {
  const result = planPosTrackedReturn({ quantity: 1, businessDate: "2026-08-28", disposition: "restock", originalAllocations: [
    { lotId: "SOLD-OUT", soldMicros: BigInt(1_000_000), returnedMicros: BigInt(0), expiresOn: "2027-01-01", lotStatus: "depleted" },
  ] });
  assert.equal(result[0].disposition, "restock");
});

test("ledger valida sinal, equação e limites", () => {
  assert.equal(assertPosLotMovement("receipt", BigInt(1_000_000), BigInt(500_000)), BigInt(1_500_000));
  assert.equal(assertPosLotMovement("sale", BigInt(1_000_000), BigInt(-250_000)), BigInt(750_000));
  assert.throws(() => assertPosLotMovement("sale", BigInt(1_000_000), BigInt(1)), /Sinal/);
  assert.throws(() => assertPosLotMovement("sale", BigInt(1), BigInt(-2)), /fora do limite/);
  assert.throws(() => assertPosLotMovement("status_change", BigInt(1), BigInt(1)), /Sinal/);
});

test("máquina de estados não reabilita lote vencido silenciosamente", () => {
  assert.equal(assertPosLotStatusTransition("available", "quarantine"), "quarantine");
  assert.equal(assertPosLotStatusTransition("depleted", "available"), "available");
  assert.throws(() => assertPosLotStatusTransition("expired", "available"), /Transição/);
  assert.throws(() => assertPosLotStatusTransition("mystery", "mystery"), /Estado/);
});

test("normalização é unicode-aware, estável e rejeita identidade vazia", () => {
  assert.equal(normalizePosTrackingIdentity("  sn １２３-á  "), "SN123-Á");
  assert.throws(() => normalizePosTrackingIdentity("   "), /inválid/);
});

function lot(id: string, quantity: number, expiresOn: string | null, receivedAt: string) {
  return {
    id,
    warehouseId: scope.warehouseId,
    productId: scope.productId,
    variationId: scope.variationId,
    lotCode: id,
    normalizedLotCode: id,
    serialNumber: null,
    normalizedSerialNumber: null,
    expiresOn,
    receivedAt,
    status: "available",
    quantityMicros: BigInt(Math.round(quantity * 1_000_000)),
    reservedMicros: BigInt(0),
  };
}
