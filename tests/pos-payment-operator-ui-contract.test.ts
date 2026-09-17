import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const root = fileURLToPath(new URL("..", import.meta.url));
const read = (path: string) => readFileSync(join(root, path), "utf8");
const control = read("components/erp/pdv-payment-intent-control.tsx");
const workspace = read("components/erp/pdv-workspace.tsx");
const route = read("app/api/erp/pdv/payment-intents/route.ts");

test("operador cria, consulta e solicita retry sem receber ou fabricar captura", () => {
  for (const evidence of ['action: "intent.create"', 'action: "intent.retry"', "/api/erp/pdv/payment-intents?intentId=", "setInterval", "paymentPlanId", "paymentIndex", "provider-agnostic"]) assert.match(control, new RegExp(evidence.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.match(control, /action: "intent\.create",\s*sessionId: props\.sessionId,\s*paymentPlanId: props\.paymentPlanId,\s*paymentIndex: props\.paymentIndex,\s*idempotencyKey:/);
  assert.match(control, /intent\.status === "captured"/);
  assert.match(control, /Resultado desconhecido/);
  assert.match(control, /Não repita a cobrança fora do fluxo/);
  assert.doesNotMatch(control, /fetch\([^\n]*(?:cielo|stone|rede|pagseguro|mercadopago|stripe)/i);
  assert.doesNotMatch(control, /status:\s*["']captured["']/);
});

test("cancelamento local é CAS, idempotente e restrito ao pré-dispatch", () => {
  for (const evidence of ['body.action === "intent.cancel"', "assertSameOrigin(request)", "assertPosMutationRequest(request)", 'assertTenantPermission(organization.id, "pdv.write")', "assertTenantWriteAccess", "lockPosPaymentIntentCanonical", 'intent.status !== "created"', "attempt.dispatchCount > 0", 'status: "cancelled"', "version: { increment: 1 }", "evidenceHash: requestHash", 'isolationLevel: "Serializable"', "pos.payment.intent.cancelled_before_dispatch"]) assert.match(route, new RegExp(evidence.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.match(route, /providerReference: null, providerOccurredAt: null/);
  assert.match(route, /operator_cancelled_before_dispatch/);
  assert.doesNotMatch(route, /psp\.cancel|connector\.cancel/i);
});

test("checkout ativa plano e envia somente prova/execução, com manual fechado até 320000", () => {
  assert.match(workspace, /payment\.method === "cash"/);
  assert.match(workspace, /payment\.method === "store_credit"/);
  assert.match(workspace, /Ativar divisões autoritativas/);
  assert.match(workspace, /paymentPlanId: currentPaymentPlan!\.id/);
  assert.match(workspace, /Referência manual · disponível na wave 320000/);
  assert.match(workspace, /isPdvPaymentIntentCaptured/);
  assert.match(workspace, /paymentIntentId: payment\.electronicIntent\?\.id/);
  assert.match(workspace, /manualReferenceId: payment\.manualReference\?\.id/);
  assert.match(workspace, /paymentPlanConfigurationLocked/);
});
