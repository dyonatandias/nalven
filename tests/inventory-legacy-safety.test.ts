import assert from "node:assert/strict";
import test from "node:test";
import { legacyInventorySafetyReasons, type LegacyInventorySafetyProduct } from "../lib/erp/inventory-legacy-safety";

const simple: LegacyInventorySafetyProduct = {
  id: 1,
  name: "Produto simples",
  sku: "SIMPLE-1",
  type: "product",
  catalogType: "simple",
  expiry: null,
  expiryDate: null,
  variationCount: 0,
  variationBalanceCount: 0,
  trackedLotCount: 0,
  hasReservedBalance: false,
  hasActiveReservation: false,
};

test("contenção permite somente SKU simples sem dimensões nem reservas", () => {
  assert.deepEqual(legacyInventorySafetyReasons(simple), []);
});

test("contenção bloqueia toda dimensão que o inventário legado não representa", () => {
  const scenarios: Array<[Partial<LegacyInventorySafetyProduct>, RegExp]> = [
    [{ type: "service" }, /tipo de item/],
    [{ catalogType: "variable" }, /catálogo não simples/],
    [{ variationCount: 1 }, /variações/],
    [{ variationBalanceCount: 1 }, /saldos por variação/],
    [{ trackedLotCount: 1 }, /lote, série, validade ou bucket/],
    [{ expiry: "2027-01-01" }, /validade cadastrada/],
    [{ expiryDate: new Date("2027-01-01T00:00:00.000Z") }, /validade cadastrada/],
    [{ hasReservedBalance: true }, /saldo reservado/],
    [{ hasActiveReservation: true }, /reserva de pedido ativa/],
  ];
  for (const [change, expected] of scenarios) {
    assert.match(legacyInventorySafetyReasons({ ...simple, ...change }).join("; "), expected);
  }
});

test("contenção relata simultaneamente inconsistências sobrepostas", () => {
  const reasons = legacyInventorySafetyReasons({
    ...simple,
    catalogType: "variable",
    variationCount: 2,
    trackedLotCount: 3,
    hasReservedBalance: true,
  });
  assert.deepEqual(reasons, ["catálogo não simples", "variações", "lote, série, validade ou bucket rastreado", "saldo reservado"]);
});
