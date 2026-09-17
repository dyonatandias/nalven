import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const workspace = readFileSync("components/erp/pdv-workspace.tsx", "utf8");
const pdvRoute = readFileSync("app/api/erp/pdv/route.ts", "utf8");
const paymentRoute = readFileSync("app/api/erp/pdv/payment-intents/route.ts", "utf8");
const recoveryHelper = readFileSync("lib/erp/pos-draft-recovery.ts", "utf8");

test("workspace recupera do servidor sem persistir PII, segredos ou prova no browser", () => {
  assert.match(workspace, /payment-intents\?recovery=1&sessionId=/);
  assert.match(workspace, /cart\.draft\.save/);
  assert.match(workspace, /recoveryCheckoutBlocked/);
  assert.match(workspace, /Cancelar somente pré-dispatch/);
  assert.doesNotMatch(workspace, /(?:localStorage|sessionStorage)\.(?:setItem|getItem)\(/);
  const start = workspace.indexOf('action: "cart.draft.save"');
  const saveBody = workspace.slice(start, workspace.indexOf("}).then(async response", start));
  for (const forbidden of ["giftPin", "giftQrToken", "couponQrToken", "manualReference", "electronicIntent", "providerReference", "approvalId"]) assert.doesNotMatch(saveBody, new RegExp(forbidden));
});

test("servidor vincula por ID exato, bloqueia divergência e não captura nem estorna", () => {
  for (const evidence of ['status: "draft"', "saleDraftId: idempotencyKey", "assertRecoveryDraftMatchesCommit", "POS_DRAFT_RECOVERY_INTENT_STATES", "consumedAt: null", "checkout foi bloqueado para reconciliação"]) assert.ok(pdvRoute.includes(evidence), `faltou ${evidence}`);
  assert.match(paymentRoute, /planPosDraftRecoveryWithManualReferences/);
  assert.match(paymentRoute, /operatorProfileId: context\.actorProfileId/);
  assert.match(paymentRoute, /registerId: session\.registerId/);
  assert.match(paymentRoute, /posManualPaymentReference\.findMany/);
  assert.match(paymentRoute, /referenceLastFour/);
  assert.match(recoveryHelper, /manualReferenceIds/);
  assert.match(workspace, /manualReferences/);
  assert.match(workspace, /paymentFromRecoveredManualReference/);
  assert.match(workspace, /recovered \|\| payment\.manualReference\.signature/);
  assert.match(workspace, /Revogar rejeição com auditoria/);
  assert.doesNotMatch(paymentRoute, /reference: reference\.reference/);
  assert.doesNotMatch(paymentRoute, /(?:capture|refund)PosPayment/i);
});
