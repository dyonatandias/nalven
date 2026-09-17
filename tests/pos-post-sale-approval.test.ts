import assert from "node:assert/strict";
import test from "node:test";
import { PosDomainError } from "../lib/erp/pos-domain";
import {
  assertPosPostSaleApprovalContext,
  assertPosPostSaleApprovalReplay,
  buildPosCancelApprovalContext,
  buildPosReturnApprovalContext,
  normalizePosPostSaleApprovalIntent,
  type PosPostSaleApprovalSale,
  type PosReturnApprovalIntent,
} from "../lib/erp/pos-post-sale-approval";

function sale(): PosPostSaleApprovalSale {
  return {
    id: 42,
    branchId: 7,
    warehouseId: 3,
    sessionId: 9,
    customerId: 11,
    saleNumber: "PDV-42",
    status: "completed",
    totalCents: 12_000,
    changeCents: 0,
    items: [
      { id: 102, productId: 2, productName: "Produto B", variationId: null, quantity: 2, returnedQuantity: 0, unitPriceCents: 2_000, totalCents: 4_000, returnedCents: 0, kitComponents: [{ id: "component-1", bomId: "bom-1", bomVersion: 1, productId: 9, variationId: null, componentScopeKey: "9:0", unitQuantityMicros: BigInt(1_000_000), quantityMicros: BigInt(2_000_000), returnedMicros: BigInt(0) }] },
      { id: 101, productId: 1, productName: "Produto A", variationId: 8, quantity: 4, returnedQuantity: 1, unitPriceCents: 2_000, totalCents: 8_000, returnedCents: 2_000 },
    ],
    payments: [
      { id: "pay-cash", method: "cash", status: "captured", amountCents: 7_000, provider: "cash", metadata: {}, refunds: [] },
      { id: "pay-credit", method: "store_credit", status: "captured", amountCents: 5_000, provider: "pos_value", metadata: { valueAccountId: "account_1234", valueAmountUnits: 5000 }, refunds: [] },
    ],
  };
}

function returnIntent(overrides: Partial<PosReturnApprovalIntent> = {}): PosReturnApprovalIntent {
  return {
    sessionId: 15,
    items: [
      { saleItemId: 101, quantityMicros: 1_000_000, disposition: "restock" },
      { saleItemId: 102, quantityMicros: 2_000_000, disposition: "quarantine" },
    ],
    reasonCode: "customer_return",
    description: "Cliente devolveu os itens sem uso.",
    exchangeRequested: false,
    ...overrides,
  };
}

test("cancelamento vincula venda, saldos, destinos e valor integral em hash canônico", () => {
  const first = buildPosCancelApprovalContext({ sale: sale(), branchId: 7, processingSessionId: 9, registerId: 4, reason: "Erro operacional confirmado." });
  const reordered = sale();
  reordered.items.reverse();
  const second = buildPosCancelApprovalContext({ sale: reordered, branchId: 7, processingSessionId: 9, registerId: 4, reason: "Erro operacional confirmado." });
  assert.deepEqual(first, second);
  assert.equal(first.operation.refundTotalCents, 12_000);
  assert.equal(first.sale.payments[1].valueAccountId, "account_1234");
  assert.match(first.contentHash, /^[a-f0-9]{64}$/);
  assert.doesNotThrow(() => assertPosPostSaleApprovalContext(first, second));
});

test("cancelamento falha fechado quando o estado financeiro muda depois da aprovação", () => {
  const stored = buildPosCancelApprovalContext({ sale: sale(), branchId: 7, processingSessionId: 9, registerId: 4, reason: "Erro operacional confirmado." });
  const changed = sale();
  changed.payments[0].status = "partially_refunded";
  changed.payments[0].refunds.push({ id: "refund-1", status: "refunded", amountCents: 100 });
  assert.throws(
    () => buildPosCancelApprovalContext({ sale: changed, branchId: 7, processingSessionId: 9, registerId: 4, reason: "Erro operacional confirmado." }),
    /já possui estorno/,
  );
  const reasonChanged = buildPosCancelApprovalContext({ sale: sale(), branchId: 7, processingSessionId: 9, registerId: 4, reason: "Outro motivo material." });
  assert.throws(() => assertPosPostSaleApprovalContext(stored, reasonChanged), /conteúdo financeiro atual/);
  const componentChanged = sale();
  componentChanged.items[0].kitComponents![0].returnedMicros = BigInt(1_000_000);
  const componentExpected = buildPosCancelApprovalContext({ sale: componentChanged, branchId: 7, processingSessionId: 9, registerId: 4, reason: "Erro operacional confirmado." });
  assert.throws(() => assertPosPostSaleApprovalContext(stored, componentExpected), /conteúdo financeiro atual/);
});

test("devolução vincula quantidades, destinos, motivo, troca, saldos e alocações", () => {
  const stored = buildPosReturnApprovalContext({ sale: sale(), branchId: 7, processingSessionId: 15, registerId: 4, intent: returnIntent() });
  assert.equal(stored.action, "return.create");
  if (stored.action !== "return.create") return;
  assert.equal(stored.operation.refundTotalCents, 6_000);
  assert.deepEqual(stored.operation.allocations.map(({ paymentId, amountCents }) => ({ paymentId, amountCents })), [{ paymentId: "pay-cash", amountCents: 6_000 }]);
  for (const intent of [
    returnIntent({ items: [{ saleItemId: 101, quantityMicros: 1_000_000, disposition: "discard" }] }),
    returnIntent({ reasonCode: "defective" }),
    returnIntent({ description: "Produto defeituoso confirmado pelo cliente." }),
    returnIntent({ exchangeRequested: true }),
  ]) {
    const changed = buildPosReturnApprovalContext({ sale: sale(), branchId: 7, processingSessionId: 15, registerId: 4, intent });
    assert.throws(() => assertPosPostSaleApprovalContext(stored, changed), /conteúdo financeiro atual/);
  }
});

test("devolução aprovada não sobrevive a saldo de item ou pagamento adulterado", () => {
  const stored = buildPosReturnApprovalContext({ sale: sale(), branchId: 7, processingSessionId: 15, registerId: 4, intent: returnIntent() });
  const itemChanged = sale();
  itemChanged.items[0].returnedQuantity = 1;
  itemChanged.items[0].returnedCents = 2_000;
  assert.throws(
    () => buildPosReturnApprovalContext({ sale: itemChanged, branchId: 7, processingSessionId: 15, registerId: 4, intent: returnIntent() }),
    /Quantidade de devolução superior/,
  );
  const paymentChanged = sale();
  paymentChanged.payments[0].refunds.push({ id: "refund-concurrent", status: "pending", amountCents: 2_000 });
  const expected = buildPosReturnApprovalContext({ sale: paymentChanged, branchId: 7, processingSessionId: 15, registerId: 4, intent: returnIntent() });
  assert.throws(() => assertPosPostSaleApprovalContext(stored, expected), /conteúdo financeiro atual/);
});

test("replay aceita somente a mesma intenção e snapshot íntegro", () => {
  const intent = returnIntent();
  const stored = buildPosReturnApprovalContext({ sale: sale(), branchId: 7, processingSessionId: 15, registerId: 4, intent });
  assert.doesNotThrow(() => assertPosPostSaleApprovalReplay("return.create", intent, stored));
  assert.throws(() => assertPosPostSaleApprovalReplay("return.create", returnIntent({ exchangeRequested: true }), stored), /outro pedido/);
  const corrupted = { ...stored, contentHash: "0".repeat(64) };
  assert.throws(() => assertPosPostSaleApprovalReplay("return.create", intent, corrupted), /corrompido/);
});

test("pedido rejeita totais fornecidos pelo cliente e normaliza itens em ordem estável", () => {
  assert.throws(() => normalizePosPostSaleApprovalIntent("sale.cancel", { sessionId: 9, totalCents: 1 }, "42", "Erro operacional confirmado."), PosDomainError);
  const description = "Cliente devolveu os itens sem uso.";
  const intent = normalizePosPostSaleApprovalIntent("return.create", {
    sessionId: 15,
    items: [
      { saleItemId: 102, quantity: 2, disposition: "quarantine" },
      { saleItemId: 101, quantity: 1, disposition: "restock" },
    ],
    reasonCode: "customer_return",
    description,
    exchangeRequested: false,
  }, "42", description) as PosReturnApprovalIntent;
  assert.deepEqual(intent.items.map((item) => item.saleItemId), [101, 102]);
  assert.throws(() => normalizePosPostSaleApprovalIntent("return.create", {
    sessionId: 15,
    items: [{ saleItemId: 101, quantity: 1, disposition: "restock", refundCents: 1 }],
    reasonCode: "customer_return",
    description,
    exchangeRequested: false,
  }, "42", description), /somente os campos/);
});
