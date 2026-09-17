import assert from "node:assert/strict";
import test from "node:test";
import { posValueAccrualClawbackUnits, posValueRefundUnits, posValueUnitsForPayment } from "../lib/erp/pos-value-sale";

test("valor monetário usa centavos exatos", () => {
  assert.equal(posValueUnitsForPayment({ kind: "gift_card", unit: "cents", program: null }, 1599), 1599);
  assert.throws(() => posValueUnitsForPayment({ kind: "store_credit", unit: "cents", program: null }, 1599, 1500), /corresponder/);
});

test("pontos exigem conversão exata e inteira do programa", () => {
  const account = { kind: "loyalty_points", unit: "points", program: { id: "program_1", redeemCentsPerUnit: 5 } };
  assert.equal(posValueUnitsForPayment(account, 500, 100), 100);
  assert.throws(() => posValueUnitsForPayment(account, 499, 100), /exatamente/);
  assert.throws(() => posValueUnitsForPayment(account, 500), /exatamente/);
});

test("conversões inválidas falham fechadas", () => {
  assert.throws(() => posValueUnitsForPayment({ kind: "cashback", unit: "points", program: null }, 100, 100), /sem conversão/);
  assert.throws(() => posValueUnitsForPayment({ kind: "gift_card", unit: "cents", program: null }, 0), /inválido/);
});

test("estorno proporcional só aceita unidades inteiras e nunca arredonda saldo", () => {
  assert.equal(posValueRefundUnits(100, 500, 250), 50);
  assert.equal(posValueRefundUnits(100, 500, 500), 100);
  assert.throws(() => posValueRefundUnits(3, 100, 50), /unidades inteiras/);
  assert.throws(() => posValueRefundUnits(100, 500, 501), /inválidas/);
});

test("recompensa é retirada pelo acumulado devolvido e fecha exatamente no retorno integral", () => {
  assert.equal(posValueAccrualClawbackUnits(10, 999, 499), 4);
  assert.equal(posValueAccrualClawbackUnits(10, 999, 500, 4), 1);
  assert.equal(posValueAccrualClawbackUnits(10, 999, 999, 5), 5);
  assert.throws(() => posValueAccrualClawbackUnits(10, 999, 1_000), /inválido/);
});
