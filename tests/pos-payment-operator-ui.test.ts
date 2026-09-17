import assert from "node:assert/strict";
import test from "node:test";
import {
  isPdvPaymentIntentCaptured,
  isPdvPaymentIntentLocked,
  posPaymentIntentContextSignature,
  type PdvOperatorPaymentIntent,
} from "../components/erp/pdv-payment-intent-control";

const context = {
  sessionId: 7,
  registerId: 3,
  operatorProfileId: 9,
  saleDraftId: "sale-draft-0000001",
  paymentPlanId: "payment-plan-0000001",
  paymentIndex: 1,
  amountCents: 12_345,
  method: "credit",
  installments: 3,
  connectorId: "connector-1",
  terminalId: "terminal-1",
};
const signature = posPaymentIntentContextSignature(context);
const intent: PdvOperatorPaymentIntent = {
  id: "intent-1",
  status: "captured",
  version: 4,
  branchId: 2,
  registerId: 3,
  sessionId: 7,
  operatorProfileId: 9,
  terminalId: "terminal-1",
  connectorId: "connector-1",
  saleDraftId: "sale-draft-0000001",
  paymentPlanId: "payment-plan-0000001",
  paymentIndex: 1,
  amountCents: 12_345,
  currency: "BRL",
  method: "credit",
  installments: 3,
  provider: "payment_gateway",
  providerReference: "provider-reference",
  failureCode: null,
  failureMessage: null,
  unknownSince: null,
  nextReconcileAt: null,
  expiresAt: new Date(Date.now() + 60_000).toISOString(),
  consumedAt: null,
  contextSignature: signature,
  artifacts: [],
};

test("captura só vale para o contexto exato da divisão", () => {
  assert.equal(isPdvPaymentIntentCaptured(intent, signature), true);
  assert.equal(
    isPdvPaymentIntentCaptured(
      intent,
      posPaymentIntentContextSignature({ ...context, amountCents: 12_346 }),
    ),
    false,
  );
  assert.equal(
    isPdvPaymentIntentCaptured({ ...intent, status: "authorized" }, signature),
    false,
  );
  assert.equal(
    isPdvPaymentIntentCaptured(
      { ...intent, consumedAt: new Date().toISOString() },
      signature,
    ),
    false,
  );
});

test("estado incerto mantém os controles contextuais bloqueados", () => {
  for (const status of [
    "created",
    "processing",
    "authorized",
    "captured",
    "unknown",
    "manual_review",
  ])
    assert.equal(isPdvPaymentIntentLocked({ ...intent, status }), true, status);
  for (const status of ["cancelled", "declined"])
    assert.equal(
      isPdvPaymentIntentLocked({ ...intent, status }),
      false,
      status,
    );
  assert.equal(isPdvPaymentIntentLocked(null), false);
});

test("assinatura inclui plano, caixa, operador, índice, parcelas, conector e terminal", () => {
  const parsed = JSON.parse(signature) as Record<string, unknown>;
  assert.deepEqual(parsed, context);
  for (const change of [
    { paymentIndex: 2 },
    { installments: 4 },
    { connectorId: "connector-2" },
    { terminalId: "" },
    { saleDraftId: "sale-draft-0000002" },
    { paymentPlanId: "payment-plan-0000002" },
  ])
    assert.notEqual(
      posPaymentIntentContextSignature({ ...context, ...change }),
      signature,
    );
});
