import assert from "node:assert/strict";
import test from "node:test";
import { PosAgentError } from "../lib/erp/pos-agent-auth";
import {
  PosAdapterRegistry,
  PosConnectorError,
  createDeviceCommand,
  verifyDeviceAck,
  type PosFiscalSaleSnapshot,
  type PosPaymentIntentInput,
} from "../lib/erp/pos-connectors";
import {
  DeterministicDeviceAgentSimulator,
  DeterministicFiscalSimulator,
  DeterministicPaymentSimulator,
  DeterministicPrintClaimSimulator,
  POS_LOCAL_CONFORMANCE_CAPABILITIES,
} from "../lib/erp/pos-conformance-simulators";

const TERMINAL_ID = "cmconformanceterminal000001";
const DEVICE_ID = "cmconformancedevice0000001";
const SIGNING_KEY = { keyId: "conformance-key-v1", secret: "local-conformance-secret-with-more-than-thirty-two-bytes" };

test("PSP simulado cobre sucesso, recusa, processamento e resultado desconhecido", async () => {
  const clock = fixedClock();
  const keys = { success: "psp-success-0001", decline: "psp-decline-0001", processing: "psp-processing-0001", unknown: "psp-unknown-0001" };
  const adapter = new DeterministicPaymentSimulator({ clock: clock.now, createScenarios: { [keys.decline]: "decline", [keys.processing]: "processing", [keys.unknown]: "unknown" } });
  const registry = new PosAdapterRegistry().registerPayment(adapter);
  assert.equal((await registry.createPaymentIntent(adapter.provider, intent(keys.success, "pix"))).state, "captured");
  const declined = await registry.createPaymentIntent(adapter.provider, intent(keys.decline, "credit"));
  assert.equal(declined.state, "declined");
  assert.equal(declined.failureCode, "simulated_decline");
  assert.equal((await registry.createPaymentIntent(adapter.provider, intent(keys.processing, "credit"))).state, "processing");
  assert.equal((await registry.createPaymentIntent(adapter.provider, intent(keys.unknown, "credit"))).state, "unknown");
  assert.equal(adapter.effects.create, 4);
});

test("retry PSP é idempotente e colisão de chave falha fechada", async () => {
  const adapter = new DeterministicPaymentSimulator();
  const registry = new PosAdapterRegistry().registerPayment(adapter);
  const input = intent("psp-idempotent-0001", "credit");
  const first = await registry.createPaymentIntent(adapter.provider, input);
  const replay = await registry.createPaymentIntent(adapter.provider, { ...input, expiresAt: new Date(input.expiresAt) });
  assert.deepEqual(replay, first);
  assert.equal(adapter.effects.create, 1);
  await assert.rejects(
    registry.createPaymentIntent(adapter.provider, { ...input, amountCents: input.amountCents + 1 }),
    (error: unknown) => error instanceof PosConnectorError && error.code === "adapter_failure" && error.outcomeUnknown,
  );
  assert.equal(adapter.effects.create, 1, "colisão idempotente não pode reaplicar o efeito");
});

test("timeout após captura preserva outcome desconhecido e exige consulta", async () => {
  const key = "psp-timeout-captured-0001";
  const adapter = new DeterministicPaymentSimulator({ createScenarios: { [key]: "timeout_after_capture" } });
  const registry = new PosAdapterRegistry().registerPayment(adapter);
  await assert.rejects(registry.createPaymentIntent(adapter.provider, intent(key, "pix"), { timeoutMs: 10 }), (error: unknown) => error instanceof PosConnectorError && error.code === "timeout" && error.outcomeUnknown);
  const reconciled = await registry.paymentStatus(adapter.provider, adapter.referenceFor(key));
  assert.equal(reconciled.state, "captured");
  assert.equal(adapter.effects.create, 1);
});

test("callback PSP duplicado é no-op e callback fora de ordem é recusado", async () => {
  const clock = fixedClock();
  const key = "psp-callback-0001";
  const adapter = new DeterministicPaymentSimulator({ clock: clock.now, createScenarios: { [key]: "processing" } });
  const registry = new PosAdapterRegistry().registerPayment(adapter);
  const created = await registry.createPaymentIntent(adapter.provider, intent(key, "credit"));
  const callback = { eventId: "callback-event-0001", reference: created.reference, state: "captured" as const, occurredAt: clock.now() };
  assert.deepEqual(adapter.acceptCallback(callback), { accepted: true, duplicate: false, state: "captured" });
  assert.deepEqual(adapter.acceptCallback(callback), { accepted: false, duplicate: true, state: "captured" });
  assert.equal(adapter.effects.callback, 1);
  assert.throws(() => adapter.acceptCallback({ ...callback, eventId: "callback-event-0002", state: "authorized" }), /Transição inválida/);
  assert.throws(() => adapter.acceptCallback({ ...callback, state: "declined" }), /outro conteúdo/);
});

test("cancelamento e refunds parcial/total mantêm idempotência e saldo", async () => {
  const processingKey = "psp-cancel-source-0001", capturedKey = "psp-refund-source-0001";
  const adapter = new DeterministicPaymentSimulator({ createScenarios: { [processingKey]: "processing" } });
  const registry = new PosAdapterRegistry().registerPayment(adapter);
  const processing = await registry.createPaymentIntent(adapter.provider, intent(processingKey, "credit"));
  const cancelled = await registry.cancelPayment(adapter.provider, processing.reference, "psp-cancel-operation-0001");
  assert.equal(cancelled.state, "cancelled");
  assert.deepEqual(await registry.cancelPayment(adapter.provider, processing.reference, "psp-cancel-operation-0001"), cancelled);
  assert.equal(adapter.effects.cancel, 1);

  const captured = await registry.createPaymentIntent(adapter.provider, intent(capturedKey, "credit"));
  const partialRefund = await registry.refundPayment(adapter.provider, captured.reference, 500, "psp-refund-partial-0001");
  assert.equal(partialRefund.state, "partially_refunded");
  assert.deepEqual(await registry.refundPayment(adapter.provider, captured.reference, 500, "psp-refund-partial-0001"), partialRefund);
  assert.equal((await registry.refundPayment(adapter.provider, captured.reference, 1_000, "psp-refund-total-0001")).state, "refunded");
  assert.equal(adapter.effects.refund, 2);
  await assert.rejects(
    registry.refundPayment(adapter.provider, captured.reference, 1, "psp-refund-overflow-0001"),
    (error: unknown) => error instanceof PosConnectorError && error.code === "adapter_failure" && error.outcomeUnknown,
  );
  assert.equal(adapter.effects.refund, 2, "estorno inválido não pode alterar saldo ou efeitos");
});

test("fiscal simulado cobre autorização, consulta, artefatos, cancelamento e retry", async () => {
  const adapter = new DeterministicFiscalSimulator();
  const registry = new PosAdapterRegistry().registerFiscal(adapter);
  const snapshot = fiscalSnapshot();
  const issued = await registry.issueFiscal(adapter.provider, snapshot, "profile-conformance-v1", "fiscal-authorize-0001");
  assert.equal(issued.state, "authorized");
  assert.deepEqual(await registry.issueFiscal(adapter.provider, snapshot, "profile-conformance-v1", "fiscal-authorize-0001"), issued);
  assert.equal(adapter.effects.issue, 1);
  assert.equal((await registry.fiscalStatus(adapter.provider, issued.reference)).state, "authorized");
  assert.match((await registry.renderFiscalDanfe(adapter.provider, issued.reference)).artifactId, /^danfe-/);
  assert.match((await registry.downloadFiscalXml(adapter.provider, issued.reference)).artifactId, /^xml-/);
  const cancelled = await registry.cancelFiscal(adapter.provider, issued.reference, "Cancelamento local de conformidade", "fiscal-cancel-0001");
  assert.equal(cancelled.state, "cancelled");
  assert.deepEqual(await registry.cancelFiscal(adapter.provider, issued.reference, "Cancelamento local de conformidade", "fiscal-cancel-0001"), cancelled);
  assert.equal(adapter.effects.cancel, 1);
  await assert.rejects(
    registry.issueFiscal(adapter.provider, snapshot, "profile-conformance-v2", "fiscal-authorize-0001"),
    (error: unknown) => error instanceof PosConnectorError && error.code === "adapter_failure" && error.outcomeUnknown,
  );
  assert.equal(adapter.effects.issue, 1, "colisão fiscal não pode emitir novamente");
});

test("fiscal simulado cobre rejeição, processamento, unknown e contingência", async () => {
  const keys = { reject: "fiscal-reject-0001", processing: "fiscal-processing-0001", unknown: "fiscal-unknown-0001" };
  const adapter = new DeterministicFiscalSimulator({ issueScenarios: { [keys.reject]: "reject", [keys.processing]: "processing", [keys.unknown]: "unknown" } });
  const registry = new PosAdapterRegistry().registerFiscal(adapter), snapshot = fiscalSnapshot();
  const rejected = await registry.issueFiscal(adapter.provider, snapshot, "profile-v1", keys.reject);
  assert.equal(rejected.state, "rejected");
  assert.equal(rejected.rejectionCode, "SIM001");
  assert.equal((await registry.issueFiscal(adapter.provider, snapshot, "profile-v1", keys.processing)).state, "processing");
  assert.equal((await registry.issueFiscal(adapter.provider, snapshot, "profile-v1", keys.unknown)).state, "unknown");
  const contingency = await registry.fiscalContingency(adapter.provider, snapshot, "profile-v1", "Indisponibilidade simulada local", "fiscal-contingency-0001");
  assert.equal(contingency.state, "contingency");
  assert.ok(contingency.xmlArtifactId);
});

test("timeout fiscal após autorização é reconciliado por query", async () => {
  const key = "fiscal-timeout-authorized-0001";
  const adapter = new DeterministicFiscalSimulator({ issueScenarios: { [key]: "timeout_after_authorize" } });
  const registry = new PosAdapterRegistry().registerFiscal(adapter);
  await assert.rejects(registry.issueFiscal(adapter.provider, fiscalSnapshot(), "profile-v1", key, { timeoutMs: 10 }), (error: unknown) => error instanceof PosConnectorError && error.code === "timeout" && error.outcomeUnknown);
  assert.equal((await registry.fiscalStatus(adapter.provider, adapter.referenceFor(key))).state, "authorized");
});

test("agente determinístico valida assinatura, tamper, replay e dispositivo offline", () => {
  const clock = fixedClock();
  const identifiers = { commandId: "11111111-1111-4111-8111-111111111111", nonce: "22222222-2222-4222-8222-222222222222" };
  const command = createDeviceCommand({ terminalId: TERMINAL_ID, deviceId: DEVICE_ID, sequence: 1, type: "print.receipt", payload: { jobId: "job-conformance-1" } }, SIGNING_KEY, 30, clock.now(), identifiers);
  const repeated = createDeviceCommand({ terminalId: TERMINAL_ID, deviceId: DEVICE_ID, sequence: 1, type: "print.receipt", payload: { jobId: "job-conformance-1" } }, SIGNING_KEY, 30, clock.now(), identifiers);
  assert.deepEqual(repeated, command, "o vetor assinado deve ser reproduzível byte a byte");
  const agent = new DeterministicDeviceAgentSimulator({ terminalId: TERMINAL_ID, signingKey: SIGNING_KEY, clock: clock.now, devices: { [DEVICE_ID]: "online" } });
  const ack = agent.execute(command);
  assert.equal(ack.state, "completed");
  assert.equal(verifyDeviceAck(ack, command, SIGNING_KEY, { now: clock.now() }), ack);
  const repeatedAck = new DeterministicDeviceAgentSimulator({ terminalId: TERMINAL_ID, signingKey: SIGNING_KEY, clock: clock.now, devices: { [DEVICE_ID]: "online" } }).execute(command);
  assert.deepEqual(repeatedAck, ack, "o ACK assinado deve ser reproduzível byte a byte");
  assert.throws(() => agent.execute(command), /já processada|Nonce/);
  assert.throws(() => createDeviceCommand({ terminalId: TERMINAL_ID, deviceId: DEVICE_ID, sequence: 2, type: "print.receipt", payload: {} }, SIGNING_KEY, 30, clock.now(), { ...identifiers, commandId: "não-é-uuid" }), /inválido/);

  const freshAgent = new DeterministicDeviceAgentSimulator({ terminalId: TERMINAL_ID, signingKey: SIGNING_KEY, clock: clock.now, devices: { [DEVICE_ID]: "online" } });
  assert.throws(() => freshAgent.execute({ ...command, payload: { jobId: "tampered" } }), /integridade|assinatura/i);
  freshAgent.setDeviceStatus(DEVICE_ID, "offline");
  const offlineCommand = createDeviceCommand({ terminalId: TERMINAL_ID, deviceId: DEVICE_ID, sequence: 2, type: "print.receipt", payload: { jobId: "job-conformance-2" } }, SIGNING_KEY, 30, clock.now(), { commandId: "33333333-3333-4333-8333-333333333333", nonce: "44444444-4444-4444-8444-444444444444" });
  const offlineAck = freshAgent.execute(offlineCommand);
  assert.equal(offlineAck.state, "failed");
  assert.equal(offlineAck.errorCode, "device_offline");
  assert.throws(() => verifyDeviceAck({ ...offlineAck, errorMessage: "alterado" }, offlineCommand, SIGNING_KEY, { now: clock.now() }), /integridade|assinatura/i);
});

test("claim/lease/ACK de impressão é idempotente e rejeita replay alterado", () => {
  const clock = fixedClock();
  const simulator = new DeterministicPrintClaimSimulator(clock.now);
  simulator.enqueue(TERMINAL_ID, "job-conformance-print-1");
  const first = simulator.pull(TERMINAL_ID, 1)[0];
  assert.ok(first.claimId);
  assert.deepEqual(simulator.pull(TERMINAL_ID, 1), [], "lease vigente não pode ser reclamado");
  clock.advance(121_000);
  const reclaimed = simulator.pull(TERMINAL_ID, 1)[0];
  assert.notEqual(reclaimed.claimId, first.claimId);
  const failed = { terminalId: TERMINAL_ID, jobId: reclaimed.id, claimId: reclaimed.claimId, state: "failed" as const, error: "Dispositivo offline" };
  assert.deepEqual(simulator.acknowledge(failed), { id: reclaimed.id, status: "queued", replayed: false });
  assert.deepEqual(simulator.acknowledge(failed), { id: reclaimed.id, status: "queued", replayed: true });
  assert.throws(() => simulator.acknowledge({ ...failed, error: "conteúdo alterado" }), (error: unknown) => error instanceof PosAgentError && error.status === 409);
  const finalClaim = simulator.pull(TERMINAL_ID, 1)[0];
  const printed = { terminalId: TERMINAL_ID, jobId: finalClaim.id, claimId: finalClaim.claimId, state: "printed" as const, error: null };
  assert.equal(simulator.acknowledge(printed).status, "printed");
  assert.equal(simulator.job(finalClaim.id).status, "printed");
  simulator.setTerminalOffline(TERMINAL_ID);
  assert.throws(() => simulator.pull(TERMINAL_ID), /offline/);
});

test("relatório de capabilities nunca declara homologação nem inclui material PCI", () => {
  assert.equal(POS_LOCAL_CONFORMANCE_CAPABILITIES.homologated, false);
  assert.equal(POS_LOCAL_CONFORMANCE_CAPABILITIES.certificationStatus, "NOT_CERTIFIED");
  assert.equal(POS_LOCAL_CONFORMANCE_CAPABILITIES.externalHomologationStatus, "NOT_PERFORMED");
  const serialized = JSON.stringify(POS_LOCAL_CONFORMANCE_CAPABILITIES);
  assert.doesNotMatch(serialized, /\b(?:4[0-9]{12,18}|5[0-9]{12,18})\b/);
  assert.doesNotMatch(serialized, /credential=|bearer\s|secret=/i);
  assert.match(serialized, /real_hardware/);
});

function intent(idempotencyKey: string, method: "pix" | "credit" = "pix"): PosPaymentIntentInput {
  return { idempotencyKey, saleId: 101, branchId: 7, registerId: 3, terminalId: TERMINAL_ID, amountCents: 1_500, currency: "BRL", method, installments: method === "credit" ? 2 : 1, expiresAt: new Date(Date.now() + 60_000) };
}

function fiscalSnapshot(): PosFiscalSaleSnapshot {
  return {
    saleId: 101, saleNumber: "SALE-CONFORMANCE-101", branchId: 7, currency: "BRL", totalCents: 1_500, issuedAt: new Date(), customerTaxId: null,
    items: [{ sequence: 1, productId: 501, description: "ITEM DE CONFORMIDADE", unit: "UN", quantity: 1, unitPriceCents: 1_500, discountCents: 0, surchargeCents: 0, totalCents: 1_500, fiscal: { cfop: "5102", ncm: "00000000" } }],
    payments: [{ method: "pix", amountCents: 1_500 }],
  };
}

function fixedClock() {
  let value = new Date("2026-08-29T00:00:00.000Z");
  return { now: () => new Date(value), advance: (milliseconds: number) => { value = new Date(value.valueOf() + milliseconds); } };
}
