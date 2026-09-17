import assert from "node:assert/strict";
import test from "node:test";
import {
  assertExactPosOrderCart,
  assertExactPosOrderPricing,
  assertExactReservationQuantity,
  assertPosOrderClaimContext,
  assertPosOrderSettlement,
  evaluatePosOrderEligibility,
  hashPosOrderClaimRequest,
  posOrderClaimLease,
  PosOrderClaimError,
} from "../lib/erp/pos-order-claim";

const eligibleOrder = () => ({
  kind: "order",
  status: "approved",
  currency: "BRL",
  origin: "manual",
  salesChannel: "direct",
  deliveryType: "pickup",
  shippingPending: false,
  needsProcessing: false,
  shipments: [] as Array<{ id: number; status: string }>,
  tracking: null as { id: number; status: string | null } | null,
  shippingLabels: [] as Array<{ id: number; status: string }>,
  branchId: 7,
  deletedAt: null,
  paidAt: null,
  transactionId: null,
  freightAmount: 0,
  taxAmount: 0,
  paymentMethod: "Pix",
  paymentTerms: "à vista",
  paymentInstallments: 1,
  firstDueDate: null,
  items: [{ itemType: "line_item", quantity: 2, refundedQuantity: 0 }],
  payments: [] as Array<{
    status: string;
    paidAt: Date | null;
    transactionId: string | null;
    paymentUrl: string | null;
  }>,
});

test("elegibilidade é explícita por status, filial, pagamento e evidência financeira", () => {
  assert.deepEqual(evaluatePosOrderEligibility(eligibleOrder(), 7), {
    eligible: true,
    code: "eligible",
  });
  assert.equal(
    evaluatePosOrderEligibility({ ...eligibleOrder(), branchId: 8 }, 7).code,
    "wrong_branch",
  );
  assert.equal(
    evaluatePosOrderEligibility({ ...eligibleOrder(), status: "processing" }, 7)
      .code,
    "status",
  );
  assert.equal(
    evaluatePosOrderEligibility(
      { ...eligibleOrder(), paymentMethod: "Boleto" },
      7,
    ).code,
    "unsupported_payment_method",
  );
  assert.equal(
    evaluatePosOrderEligibility(
      { ...eligibleOrder(), paymentTerms: "Entrada + 30 dias" },
      7,
    ).code,
    "deferred_payment",
  );
  assert.equal(
    evaluatePosOrderEligibility(
      { ...eligibleOrder(), shipments: [{ id: 1, status: "picking" }] },
      7,
    ).code,
    "shipment_exists",
  );
  assert.equal(
    evaluatePosOrderEligibility(
      { ...eligibleOrder(), tracking: { id: 1, status: "registered" } },
      7,
    ).code,
    "shipping_artifact",
  );
  assert.equal(
    evaluatePosOrderEligibility(
      { ...eligibleOrder(), shippingLabels: [{ id: 1, status: "purchased" }] },
      7,
    ).code,
    "shipping_artifact",
  );
  assert.equal(
    evaluatePosOrderEligibility(
      { ...eligibleOrder(), deliveryType: "carrier" },
      7,
    ).code,
    "fulfillment_pending",
  );
  assert.equal(
    evaluatePosOrderEligibility(
      { ...eligibleOrder(), shippingPending: true },
      7,
    ).code,
    "fulfillment_pending",
  );
  assert.equal(
    evaluatePosOrderEligibility(
      { ...eligibleOrder(), needsProcessing: true },
      7,
    ).code,
    "fulfillment_pending",
  );
  assert.equal(
    evaluatePosOrderEligibility(
      {
        ...eligibleOrder(),
        origin: "marketplace",
        salesChannel: "marketplace",
      },
      7,
    ).code,
    "unsupported_channel",
  );
  assert.equal(
    evaluatePosOrderEligibility(
      {
        ...eligibleOrder(),
        payments: [
          {
            status: "captured",
            paidAt: null,
            transactionId: "e2e",
            paymentUrl: null,
          },
        ],
      },
      7,
    ).code,
    "payment_evidence",
  );
  assert.equal(
    evaluatePosOrderEligibility(
      {
        ...eligibleOrder(),
        payments: [
          {
            status: "pending",
            paidAt: null,
            transactionId: null,
            paymentUrl: null,
          },
        ],
      },
      7,
    ).code,
    "payment_evidence",
  );
  assert.equal(
    evaluatePosOrderEligibility(
      {
        ...eligibleOrder(),
        payments: [
          {
            status: "created",
            paidAt: null,
            transactionId: null,
            paymentUrl: "https://psp.invalid/pay",
          },
        ],
      },
      7,
    ).code,
    "payment_evidence",
  );
  assert.equal(
    evaluatePosOrderEligibility(
      {
        ...eligibleOrder(),
        payments: [
          {
            status: "cancelled",
            paidAt: null,
            transactionId: null,
            paymentUrl: null,
          },
        ],
      },
      7,
    ).code,
    "eligible",
  );
});

test("lease e CAS exigem o mesmo operador, turno, caixa e terminal", () => {
  const now = new Date("2026-08-29T10:00:00.000Z"),
    leaseExpiresAt = posOrderClaimLease(now);
  assert.equal(leaseExpiresAt.toISOString(), "2026-08-29T10:02:00.000Z");
  const claim = {
    state: "active",
    version: 4,
    leaseExpiresAt,
    branchId: 1,
    registerId: 2,
    sessionId: 3,
    operatorProfileId: 4,
    terminalId: "terminal-a",
  };
  const expected = {
    version: 4,
    branchId: 1,
    registerId: 2,
    sessionId: 3,
    operatorProfileId: 4,
    terminalId: "terminal-a",
    now,
  };
  assert.doesNotThrow(() => assertPosOrderClaimContext(claim, expected));
  assert.throws(
    () => assertPosOrderClaimContext(claim, { ...expected, version: 3 }),
    PosOrderClaimError,
  );
  assert.throws(
    () =>
      assertPosOrderClaimContext(claim, {
        ...expected,
        terminalId: "terminal-b",
      }),
    /outro operador/,
  );
  assert.throws(
    () =>
      assertPosOrderClaimContext(claim, { ...expected, now: leaseExpiresAt }),
    /expirou/,
  );
  assert.match(hashPosOrderClaimRequest(expected), /^[0-9a-f]{64}$/);
});

test("carrinho e preços devem reproduzir integralmente o pedido aprovado", () => {
  const items = [
    {
      id: 10,
      productId: 20,
      variationId: null,
      quantity: 2,
      listPrice: 12,
      unitPrice: 10,
      discount: 4,
      total: 20,
    },
  ];
  assert.doesNotThrow(() =>
    assertExactPosOrderCart(items, [
      { productId: 20, variationId: null, quantity: 2, discountCents: 400 },
    ]),
  );
  assert.throws(
    () =>
      assertExactPosOrderCart(items, [
        { productId: 20, variationId: null, quantity: 1, discountCents: 400 },
      ]),
    /não corresponde/,
  );
  const quote = {
    promotionId: null,
    subtotalCents: 2_000,
    manualDiscountCents: 100,
    surchargeCents: 0,
    totalCents: 1_900,
    lines: [
      {
        productId: 20,
        variationId: null,
        unitPriceCents: 1_200,
        discountCents: 400,
        totalCents: 2_000,
      },
    ],
  };
  assert.doesNotThrow(() =>
    assertExactPosOrderPricing(
      { subtotal: 20, discount: 1, total: 19, items },
      quote,
    ),
  );
  assert.throws(
    () =>
      assertExactPosOrderPricing(
        { subtotal: 20, discount: 1, total: 19, items },
        { ...quote, promotionId: "promo" },
      ),
    /promoção automática/i,
  );
  assert.throws(
    () =>
      assertExactPosOrderPricing(
        { subtotal: 20, discount: 1, total: 19, items },
        { ...quote, totalCents: 1_899 },
      ),
    /divergem/,
  );
});

test("settlement não troca meio, parcelamento nem divide pagamento aprovado", () => {
  const order = {
    paymentMethod: "Cartão de crédito",
    paymentInstallments: 3,
    total: 90,
  };
  assert.doesNotThrow(() =>
    assertPosOrderSettlement(order, [
      { method: "credit", amountCents: 9_000, installments: 3 },
    ]),
  );
  assert.throws(
    () =>
      assertPosOrderSettlement(order, [
        { method: "pix", amountCents: 9_000, installments: 1 },
      ]),
    /corresponder exatamente/,
  );
  assert.throws(
    () =>
      assertPosOrderSettlement(order, [
        { method: "credit", amountCents: 4_500, installments: 3 },
        { method: "credit", amountCents: 4_500, installments: 3 },
      ]),
    /corresponder exatamente/,
  );
  assert.throws(
    () =>
      assertPosOrderSettlement(order, [
        { method: "credit", amountCents: 9_000, installments: 2 },
      ]),
    /corresponder exatamente/,
  );
});

test("reserva parcial é rejeitada com tolerância apenas numérica", () => {
  assert.doesNotThrow(() =>
    assertExactReservationQuantity(1, 1.0000001, "Produto"),
  );
  assert.throws(
    () => assertExactReservationQuantity(2, 1, "Produto"),
    /parcial ou inconsistente/,
  );
});
