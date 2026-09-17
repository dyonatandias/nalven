import assert from "node:assert/strict";
import test from "node:test";
import { assertPosCashCustodyTransition, PosCashCustodyError } from "../lib/erp/pos-cash-custody";
import { assertPosCashLedgerDirection, hashPosCashLedgerRequest, planPosCashLedgerAppend, PosCashLedgerError } from "../lib/erp/pos-cash-ledger";

const at = (minutes: number) => new Date(Date.UTC(2026, 7, 29, 12, minutes));

test("ledger encadeia sequência e saldos e suporta abertura zero explícita", () => {
  assert.deepEqual(planPosCashLedgerAppend(null, 0, at(0), true), {
    sequence: 1, amountCents: 0, deltaCents: 0, balanceBeforeCents: 0, balanceAfterCents: 0, occurredAt: at(0),
  });
  assert.deepEqual(planPosCashLedgerAppend({ sequence: 1, balanceAfterCents: 0, occurredAt: at(0) }, 2_000, at(1)), {
    sequence: 2, amountCents: 2_000, deltaCents: 2_000, balanceBeforeCents: 0, balanceAfterCents: 2_000, occurredAt: at(1),
  });
  assert.throws(() => planPosCashLedgerAppend({ sequence: 2, balanceAfterCents: 100, occurredAt: at(2) }, -101, at(3)), PosCashLedgerError);
  assert.throws(() => planPosCashLedgerAppend({ sequence: 2, balanceAfterCents: 100, occurredAt: at(2) }, 1, at(1)), PosCashLedgerError);
});

test("direção monetária é fechada por tipo", () => {
  for (const [type, delta] of [["opening", 0], ["opening", 100], ["sale", 100], ["supply", 100], ["return", -100], ["withdrawal", -100], ["custody_seal", -100], ["adjustment", -100]] as const) assert.doesNotThrow(() => assertPosCashLedgerDirection(type, delta));
  for (const [type, delta] of [["opening", -1], ["sale", -1], ["supply", -1], ["return", 1], ["withdrawal", 1], ["custody_seal", 1], ["adjustment", 0]] as const) assert.throws(() => assertPosCashLedgerDirection(type, delta), PosCashLedgerError);
});

test("hash canônico estabiliza idempotência sem depender da ordem das chaves", () => {
  assert.equal(hashPosCashLedgerRequest({ b: 2, a: { d: 4, c: 3 } }), hashPosCashLedgerRequest({ a: { c: 3, d: 4 }, b: 2 }));
  assert.notEqual(hashPosCashLedgerRequest({ amountCents: 100 }), hashPosCashLedgerRequest({ amountCents: 101 }));
});

test("custódia exige selagem, entrega e aceite por destinatário diferente", () => {
  const sealed = assertPosCashCustodyTransition(null, { eventType: "sealed", actorProfileId: 10, expectedAmountCents: 500, occurredAt: at(0) });
  assert.deepEqual({ sequence: sealed.sequence, fromState: sealed.fromState, toState: sealed.toState }, { sequence: 1, fromState: null, toState: "sealed" });
  const delivered = assertPosCashCustodyTransition({ sequence: 1, eventType: "sealed", toState: "sealed", actorProfileId: 10, counterpartyProfileId: null, incidentId: null, occurredAt: at(0) }, { eventType: "delivered", actorProfileId: 10, counterpartyProfileId: 20, expectedAmountCents: 500, occurredAt: at(1) });
  assert.equal(delivered.toState, "delivered");
  const lastDelivery = { sequence: 2, eventType: "delivered", toState: "delivered", actorProfileId: 10, counterpartyProfileId: 20, incidentId: null, occurredAt: at(1) };
  assert.throws(() => assertPosCashCustodyTransition(lastDelivery, { eventType: "accepted", actorProfileId: 10, observedAmountCents: 500, expectedAmountCents: 500, occurredAt: at(2) }), PosCashCustodyError);
  assert.throws(() => assertPosCashCustodyTransition(lastDelivery, { eventType: "accepted", actorProfileId: 20, observedAmountCents: 499, expectedAmountCents: 500, occurredAt: at(2) }), PosCashCustodyError);
  assert.equal(assertPosCashCustodyTransition(lastDelivery, { eventType: "accepted", actorProfileId: 20, observedAmountCents: 500, expectedAmountCents: 500, occurredAt: at(2) }).toState, "accepted");
});

test("divergência só é resolvida por terceiro sobre o mesmo incidente", () => {
  const delivery = { sequence: 2, eventType: "delivered", toState: "delivered", actorProfileId: 10, counterpartyProfileId: 20, incidentId: null, occurredAt: at(1) };
  assert.equal(assertPosCashCustodyTransition(delivery, { eventType: "divergence_reported", actorProfileId: 20, observedAmountCents: 450, expectedAmountCents: 500, incidentId: "incident-1", occurredAt: at(2) }).toState, "disputed");
  const disputed = { sequence: 3, eventType: "divergence_reported", toState: "disputed", actorProfileId: 20, counterpartyProfileId: null, incidentId: "incident-1", occurredAt: at(2) };
  assert.throws(() => assertPosCashCustodyTransition(disputed, { eventType: "divergence_resolved", actorProfileId: 20, observedAmountCents: 450, expectedAmountCents: 500, incidentId: "incident-1", occurredAt: at(3) }), PosCashCustodyError);
  assert.throws(() => assertPosCashCustodyTransition(disputed, { eventType: "divergence_resolved", actorProfileId: 30, observedAmountCents: 450, expectedAmountCents: 500, incidentId: "incident-2", occurredAt: at(3) }), PosCashCustodyError);
  assert.equal(assertPosCashCustodyTransition(disputed, { eventType: "divergence_resolved", actorProfileId: 30, observedAmountCents: 450, expectedAmountCents: 500, incidentId: "incident-1", occurredAt: at(3) }).toState, "accepted");
});
