import assert from "node:assert/strict";
import test from "node:test";
import { calculatePosReturnRefundCents } from "../lib/erp/pos-returns";

test("devoluções repetidas encerram exatamente o saldo monetário da linha", () => {
  const balance = { totalQuantity: 3, returnedQuantity: 0, totalCents: 100, returnedCents: 0 };
  const refunds: number[] = [];
  for (let index = 0; index < 3; index += 1) {
    const refund = calculatePosReturnRefundCents(balance, 1);
    refunds.push(refund);
    balance.returnedQuantity += 1;
    balance.returnedCents += refund;
  }
  assert.deepEqual(refunds, [33, 33, 34]);
  assert.equal(balance.returnedCents, balance.totalCents);
});

test("devolução parcial usa valor original sem ultrapassar saldo persistido", () => {
  assert.equal(calculatePosReturnRefundCents({ totalQuantity: 10, returnedQuantity: 4, totalCents: 999, returnedCents: 400 }, 2), 200);
  assert.equal(calculatePosReturnRefundCents({ totalQuantity: 10, returnedQuantity: 6, totalCents: 999, returnedCents: 600 }, 4), 399);
  assert.equal(calculatePosReturnRefundCents({ totalQuantity: 10, returnedQuantity: 10, totalCents: 999, returnedCents: 999 }, 1), 0);
});
