import assert from "node:assert/strict";
import test from "node:test";
import { planPosStockChange, posAvailableStock, PosCommonStockError, stockMode } from "../lib/erp/pos-common-stock";

test("catálogo ignora saldos antigos quando o controle está desativado", () => {
  const emptyBalance = { quantity: 0, reservedQuantity: 2 };
  assert.equal(posAvailableStock({ type: "service", manageStock: true }, emptyBalance), null);
  assert.equal(posAvailableStock({ type: "simple", manageStock: false }, emptyBalance), null);
  assert.equal(posAvailableStock({ type: "simple", manageStock: true }, emptyBalance), -2);
  assert.equal(posAvailableStock({ type: "simple", manageStock: true }), 0);
});

test("disponibilidade usa o controle da variação e normaliza quantidades fracionárias", () => {
  const product = { type: "simple", manageStock: true };
  const balance = { quantity: 0.3, reservedQuantity: 0.2 };
  assert.equal(posAvailableStock(product, balance), 0.1);
  assert.equal(posAvailableStock(product, balance, { manageStock: "false", warehouseBalances: [] }), null);
  assert.equal(posAvailableStock(product, balance, { manageStock: "true", warehouseBalances: [{ quantity: 8, reservedQuantity: 2 }] }), 6);
  assert.equal(posAvailableStock(product, balance, { manageStock: "true", warehouseBalances: [] }), 0);
});

test("modo de estoque distingue serviço, pai e variação", () => {
  assert.equal(stockMode("service", true, "true"), "none");
  assert.equal(stockMode("product", true, "parent"), "parent");
  assert.equal(stockMode("product", false, "true"), "variation");
  assert.equal(stockMode("product", true, "false"), "none");
});

test("plano respeita reserva e impede oversell", () => {
  assert.deepEqual(planPosStockChange({ quantity: 5, reservedQuantity: 2, delta: -3, allowNegative: false, label: "Produto" }), { before: 5, after: 2, availableBefore: 3 });
  assert.throws(() => planPosStockChange({ quantity: 5, reservedQuantity: 2, delta: -3.001, allowNegative: false, label: "Produto" }), PosCommonStockError);
  assert.deepEqual(planPosStockChange({ quantity: 1, reservedQuantity: 0, delta: -2, allowNegative: true, label: "Produto" }), { before: 1, after: -1, availableBefore: 1 });
});

test("restock é exato e números não finitos falham fechados", () => {
  assert.deepEqual(planPosStockChange({ quantity: 0.25, reservedQuantity: 0, delta: 0.75, allowNegative: false, label: "Produto" }), { before: 0.25, after: 1, availableBefore: 0.25 });
  assert.throws(() => planPosStockChange({ quantity: Number.NaN, reservedQuantity: 0, delta: 1, allowNegative: false, label: "Produto" }), /Saldo inválido/);
  assert.throws(() => planPosStockChange({ quantity: 1, reservedQuantity: -1, delta: -1, allowNegative: false, label: "Produto" }), /Reserva inválida/);
});
