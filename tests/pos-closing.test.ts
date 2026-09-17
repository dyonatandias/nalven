import assert from "node:assert/strict";
import test from "node:test";
import { evaluatePosClosingPolicy } from "../lib/erp/pos-closing";

test("fechamento exato não exige justificativa nem aprovação", () => {
  assert.deepEqual(evaluatePosClosingPolicy({ differencesCents: [0, 0], toleranceCents: 0, notes: null, approvalId: null }), {
    totalDifferenceCents: 0,
    absoluteDifferenceCents: 0,
    approvalRequired: false,
  });
});

test("divergência dentro da tolerância exige justificativa mas não aprovação", () => {
  assert.deepEqual(evaluatePosClosingPolicy({ differencesCents: [-25], toleranceCents: 25, notes: "Moeda faltante", approvalId: null }), {
    totalDifferenceCents: -25,
    absoluteDifferenceCents: 25,
    approvalRequired: false,
  });
});

test("diferenças compensadas não burlam o limiar de aprovação", () => {
  assert.deepEqual(evaluatePosClosingPolicy({ differencesCents: [-100, 100], toleranceCents: 100, notes: "Troca entre formas", approvalId: "approval-1" }), {
    totalDifferenceCents: 0,
    absoluteDifferenceCents: 200,
    approvalRequired: true,
  });
});

test("divergência sem justificativa ou aprovação falha fechada", () => {
  assert.throws(() => evaluatePosClosingPolicy({ differencesCents: [1], toleranceCents: 100, notes: "curta", approvalId: null }), /Justifique/);
  assert.throws(() => evaluatePosClosingPolicy({ differencesCents: [101], toleranceCents: 100, notes: "Diferença apurada", approvalId: null }), /aprovação independente/);
});

test("tolerância e totais inválidos são rejeitados", () => {
  assert.throws(() => evaluatePosClosingPolicy({ differencesCents: [0], toleranceCents: -1, notes: null, approvalId: null }), /configurada incorretamente/);
  assert.throws(() => evaluatePosClosingPolicy({ differencesCents: [0.5], toleranceCents: 0, notes: null, approvalId: null }), /inválidas/);
});
