import assert from "node:assert/strict";
import test from "node:test";
import { planPosDraftRecovery, planPosDraftRecoveryWithManualReferences } from "../lib/erp/pos-draft-recovery";

const draft = (id: string) => ({ id, revision: 2, status: "draft" });
const intent = (id: string, saleDraftId: string, status = "processing", paymentIndex = 0) => ({ id, saleDraftId, status, paymentIndex, consumedAt: null });

test("refresh restaura somente o draft exato e preserva a ordem dos intents", () => {
  const result = planPosDraftRecovery([draft("draft-refresh")], [
    intent("intent-2", "draft-refresh", "captured", 1),
    intent("intent-1", "draft-refresh", "captured", 0),
  ]);
  assert.deepEqual(result, { mode: "restore", draftId: "draft-refresh", issues: [], paymentIntentIds: ["intent-1", "intent-2"] });
});

test("draft divergente bloqueia sem adotar intent por valor ou horário", () => {
  const result = planPosDraftRecovery([draft("draft-a")], [intent("intent-b", "draft-b")]);
  assert.equal(result.mode, "blocked");
  assert.deepEqual(result.issues, [{ code: "orphan_intent", draftId: "draft-b", intentId: "intent-b" }]);
});

test("intent captured órfão bloqueia checkout e não inventa carrinho", () => {
  const result = planPosDraftRecovery([], [intent("captured-orphan", "missing", "captured")]);
  assert.equal(result.mode, "blocked");
  assert.deepEqual(result.issues, [{ code: "captured_orphan", draftId: "missing", intentId: "captured-orphan" }]);
});

test("intent parcialmente estornado continua ocupando o slot e bloqueia recobrança", () => {
  const result = planPosDraftRecovery([], [intent("partial-orphan", "missing", "partially_refunded")]);
  assert.equal(result.mode, "blocked");
  assert.deepEqual(result.issues, [{ code: "captured_orphan", draftId: "missing", intentId: "partial-orphan" }]);
});

test("intent unknown órfão exige reconciliação", () => {
  const result = planPosDraftRecovery([], [intent("unknown-orphan", "missing", "unknown")]);
  assert.equal(result.mode, "blocked");
  assert.deepEqual(result.issues, [{ code: "unknown_orphan", draftId: "missing", intentId: "unknown-orphan" }]);
});

test("índice eletrônico com lacuna não fabrica pagamento local ausente", () => {
  const result = planPosDraftRecovery([draft("split")], [intent("electronic", "split", "captured", 1)]);
  assert.equal(result.mode, "blocked");
  assert.deepEqual(result.issues, [{ code: "payment_index_gap", draftId: "split" }]);
});

test("refresh restaura referência manual aprovada exata sem fabricar a prova", () => {
  const result = planPosDraftRecoveryWithManualReferences([draft("manual-refresh")], [], [{ id: "manual-1", saleDraftId: "manual-refresh", paymentIndex: 0, status: "pending", approvalStatus: "approved", approvalExpiresAt: "2026-08-29T12:10:00.000Z", consumedSalePaymentId: null }], new Date("2026-08-29T12:00:00.000Z"));
  assert.deepEqual(result, { mode: "restore", draftId: "manual-refresh", issues: [], paymentIntentIds: [], manualReferenceIds: ["manual-1"] });
});

test("referência rejeitada ou aprovada expirada bloqueia até resolução explícita", () => {
  const rejected = planPosDraftRecoveryWithManualReferences([draft("manual-rejected")], [], [{ id: "manual-r", saleDraftId: "manual-rejected", paymentIndex: 0, status: "pending", approvalStatus: "rejected", approvalExpiresAt: "2026-08-29T12:10:00.000Z", consumedSalePaymentId: null }], new Date("2026-08-29T12:00:00.000Z"));
  assert.equal(rejected.mode, "blocked");
  assert.match(JSON.stringify(rejected), /manual_reference_rejected/);
  const expired = planPosDraftRecoveryWithManualReferences([draft("manual-expired")], [], [{ id: "manual-e", saleDraftId: "manual-expired", paymentIndex: 0, status: "pending", approvalStatus: "approved", approvalExpiresAt: "2026-08-29T11:59:00.000Z", consumedSalePaymentId: null }], new Date("2026-08-29T12:00:00.000Z"));
  assert.equal(expired.mode, "blocked");
  assert.match(JSON.stringify(expired), /manual_reference_approved_expired/);
});

test("intent e referência manual podem preencher slots distintos, mas nunca duplicar o mesmo", () => {
  const manual = { id: "manual-slot", saleDraftId: "split-manual", paymentIndex: 0, status: "pending", approvalStatus: "approved", approvalExpiresAt: "2026-08-29T12:10:00.000Z", consumedSalePaymentId: null };
  const restored = planPosDraftRecoveryWithManualReferences([draft("split-manual")], [intent("intent-slot", "split-manual", "captured", 1)], [manual], new Date("2026-08-29T12:00:00.000Z"));
  assert.equal(restored.mode, "restore");
  const duplicate = planPosDraftRecoveryWithManualReferences([draft("split-manual")], [intent("intent-slot", "split-manual", "captured", 0)], [manual], new Date("2026-08-29T12:00:00.000Z"));
  assert.equal(duplicate.mode, "blocked");
  assert.match(JSON.stringify(duplicate), /duplicate_payment_index/);
});
