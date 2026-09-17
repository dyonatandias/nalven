import assert from "node:assert/strict";
import test from "node:test";
import {
  PosAdapterRegistry,
  PosConnectorError,
  advanceFiscalState,
  advancePaymentState,
  canonicalPosJson,
  createDeviceAck,
  createDeviceCommand,
  fiscalSnapshotDigest,
  validateFiscalResult,
  validateFiscalSaleSnapshot,
  validatePaymentIntent,
  validateProviderTransaction,
  verifyDeviceAck,
  verifyDeviceCommand,
  type PosDeviceCommand,
  type PosFiscalAdapter,
  type PosFiscalResult,
  type PosFiscalSaleSnapshot,
  type PosPaymentAdapter,
  type PosPaymentIntentInput,
  type PosPaymentMethod,
  type PosPaymentTransaction,
} from "../lib/erp/pos-connectors";

const TERMINAL_ID = "cmterminal000000000000001";
const DEVICE_ID = "cmdevice000000000000001";
const SIGNING_KEY = { keyId: "local-agent-key-v1", secret: "a-strong-test-secret-with-at-least-thirty-two-bytes" };

test("registry guarda capabilities imutáveis e rejeita adapters incompletos", async () => {
  const methods: PosPaymentMethod[] = ["pix"];
  const adapter = paymentAdapter({ methods });
  const registry = new PosAdapterRegistry().registerPayment(adapter);
  methods.push("debit");

  await assert.rejects(registry.createPaymentIntent("psp-demo", intent({ method: "debit" })), /não está habilitado/);
  assert.throws(() => registry.registerPayment(adapter), /duplicado/);
  assert.throws(() => new PosAdapterRegistry().registerPayment({ provider: "broken", methods: ["pix"] } as unknown as PosPaymentAdapter), /não implementa/);
  assert.throws(() => new PosAdapterRegistry().registerPayment({ ...paymentAdapter(), methods: ["pix", "invalid"] as unknown as PosPaymentMethod[] }), /método inválido/);
});

test("registry executa PSP com AbortSignal e valida provedor, método e evidência", async () => {
  let observedSignal: AbortSignal | undefined;
  let observedFrozen = false;
  const adapter = paymentAdapter({
    async createIntent(input, signal) {
      observedSignal = signal;
      observedFrozen = Object.isFrozen(input);
      return pixTransaction(input.amountCents);
    },
  });
  const result = await new PosAdapterRegistry().registerPayment(adapter).createPaymentIntent("PSP-DEMO", intent());
  assert.equal(result.state, "captured");
  assert.equal(observedSignal?.aborted, false);
  assert.equal(observedFrozen, true);

  const wrongProvider = paymentAdapter({ async createIntent(input) { return { ...pixTransaction(input.amountCents), provider: "attacker" }; } });
  await assert.rejects(new PosAdapterRegistry().registerPayment(wrongProvider).createPaymentIntent("psp-demo", intent()), /diverge do conector/);

  const wrongEvidence = paymentAdapter({ async createIntent(input) { return { ...cardTransaction(input.amountCents), endToEndId: PIX_END_TO_END }; } });
  await assert.rejects(new PosAdapterRegistry().registerPayment(wrongEvidence).createPaymentIntent("psp-demo", intent({ method: "credit" })), /evidência Pix indevida/);
});

test("timeout e cancelamento interrompem a fronteira e preservam outcome desconhecido", async () => {
  const never = paymentAdapter({ async createIntent() { return new Promise<PosPaymentTransaction>(() => undefined); } });
  await assert.rejects(
    new PosAdapterRegistry().registerPayment(never).createPaymentIntent("psp-demo", intent(), { timeoutMs: 10 }),
    (error: unknown) => error instanceof PosConnectorError && error.code === "timeout" && error.retryable && error.outcomeUnknown,
  );

  const controller = new AbortController();
  controller.abort("operator_cancelled");
  await assert.rejects(
    new PosAdapterRegistry().registerPayment(paymentAdapter()).createPaymentIntent("psp-demo", intent(), { signal: controller.signal }),
    (error: unknown) => error instanceof PosConnectorError && error.code === "aborted" && error.outcomeUnknown,
  );
});

test("falha arbitrária de adapter é normalizada sem vazar mensagem interna", async () => {
  const adapter = paymentAdapter({ async createIntent() { throw new Error("credential=top-secret-value"); } });
  await assert.rejects(
    new PosAdapterRegistry().registerPayment(adapter).createPaymentIntent("psp-demo", intent()),
    (error: unknown) => error instanceof PosConnectorError && error.code === "adapter_failure" && !error.message.includes("top-secret"),
  );
});

test("intenção eletrônica usa terminal String/cuid, BRL, centavos e parcelas válidas", () => {
  const value = intent();
  assert.equal(validatePaymentIntent(value), value);
  assert.throws(() => validatePaymentIntent({ ...value, terminalId: 4 as unknown as string }), /Terminal inválido/);
  assert.throws(() => validatePaymentIntent({ ...value, currency: "USD" as "BRL" }), /Moeda/);
  assert.throws(() => validatePaymentIntent({ ...value, installments: 2 }), /Parcelamento/);
  assert.throws(() => validatePaymentIntent({ ...value, expiresAt: new Date(Date.now() - 1) }), /expirar no futuro/);
});

test("resposta PSP rejeita estados, campos, valores, datas e evidências malformadas", () => {
  const value = cardTransaction(1_500);
  assert.equal(validateProviderTransaction(value, { provider: "psp-demo", amountCents: 1_500, method: "credit" }), value);
  assert.throws(() => validateProviderTransaction({ ...value, state: "compromised" as PosPaymentTransaction["state"] }), /Estado/);
  assert.throws(() => validateProviderTransaction({ ...value, debug: "secret" } as PosPaymentTransaction), /campo inesperado/);
  assert.throws(() => validateProviderTransaction({ ...value, failureMessage: "x".repeat(501) }), /Mensagem de falha/);
  assert.throws(() => validateProviderTransaction({ ...value, occurredAt: new Date("1999-01-01") }), /Data/);
  assert.throws(() => validateProviderTransaction({ ...value, transactionId: null, authorizationCode: null }, { method: "credit" }), /evidência obrigatória/);
  assert.throws(() => validateProviderTransaction({ ...pixTransaction(1_500), endToEndId: "not-an-e2e" }, { method: "pix" }), /Pix inválido/);
  assert.throws(() => validateProviderTransaction({ ...value, transactionId: "AUTH4111111111111111" }, { method: "credit" }), /número de cartão/);
  assert.throws(() => validateProviderTransaction({ ...value, brand: "VISA4111111111111111" }, { method: "credit" }), /número de cartão/);
  assert.throws(() => validateProviderTransaction({ ...value, evidenceId: "X4111111111111111" }, { method: "credit" }), /número de cartão/);
  assert.throws(() => validateProviderTransaction({ ...value, amountCents: 1_499 }, 1_500), /diverge/);
});

test("máquinas de estado validam os nomes antes até do no-op", () => {
  assert.equal(advancePaymentState("processing", "captured"), "captured");
  assert.throws(() => advancePaymentState("cancelled", "captured"), /Transição inválida/);
  assert.throws(() => advancePaymentState("compromised" as never, "compromised" as never), /Transição inválida/);
  assert.equal(advanceFiscalState("processing", "authorized"), "authorized");
  assert.throws(() => advanceFiscalState("cancelled", "authorized"), /Transição fiscal inválida/);
  assert.throws(() => advanceFiscalState("corrupt" as never, "corrupt" as never), /Transição fiscal inválida/);
});

test("snapshot fiscal fecha itens/pagamentos, valida CPF e retorna cópia congelada", () => {
  const input = fiscalSnapshot();
  const result = validateFiscalSaleSnapshot(input);
  assert.equal(result.totalCents, 1_500);
  assert.equal(result.issuedAt instanceof Date, true);
  assert.equal(Object.isFrozen(result), true);
  assert.equal(Object.isFrozen(result.items[0].fiscal), true);
  assert.match(fiscalSnapshotDigest(input), /^[a-f0-9]{64}$/);

  assert.throws(() => validateFiscalSaleSnapshot({ ...input, totalCents: 1_499 }), /Soma dos itens/);
  assert.throws(() => validateFiscalSaleSnapshot({ ...input, customerTaxId: "111.111.111-11" }), /CPF\/CNPJ/);
  assert.throws(() => validateFiscalSaleSnapshot({ ...input, items: [{ ...input.items[0], totalCents: 1_499 }] }), /não fecha/);
  assert.throws(() => validateFiscalSaleSnapshot({ ...input, items: [{ ...input.items[0], fiscal: { payment: { cvv: "123" } } }] }), /PCI proibido/);
});

test("registry fiscal executa snapshot congelado e valida a resposta contextual", async () => {
  let frozen = false;
  let signalSeen = false;
  const adapter = fiscalAdapter({
    async issue(snapshot, _profile, _key, signal) {
      frozen = Object.isFrozen(snapshot) && Object.isFrozen(snapshot.items[0]);
      signalSeen = signal instanceof AbortSignal;
      return authorizedFiscal();
    },
  });
  const registry = new PosAdapterRegistry().registerFiscal(adapter);
  const result = await registry.issueFiscal("SEFAZ-DEMO", fiscalSnapshot(), "profile-v1", "fiscal-key-123456");
  assert.equal(result.state, "authorized");
  assert.equal(frozen, true);
  assert.equal(signalSeen, true);
  assert.throws(() => registry.registerFiscal(adapter), /duplicado/);

  const mismatch = fiscalAdapter({ async issue() { return { ...authorizedFiscal(), provider: "other" }; } });
  await assert.rejects(new PosAdapterRegistry().registerFiscal(mismatch).issueFiscal("sefaz-demo", fiscalSnapshot(), "profile-v1", "fiscal-key-123456"), /diverge do conector/);
});

test("resposta fiscal exige estado conhecido e evidências coerentes", () => {
  assert.equal(validateFiscalResult(authorizedFiscal()).state, "authorized");
  assert.throws(() => validateFiscalResult({ ...authorizedFiscal(), state: "invalid" as PosFiscalResult["state"] }), /Estado fiscal/);
  assert.throws(() => validateFiscalResult({ ...authorizedFiscal(), accessKey: "1".repeat(44) }), /Chave de acesso/);
  assert.throws(() => validateFiscalResult({ ...authorizedFiscal(), protocol: null }), /evidência obrigatória/);
  assert.throws(() => validateFiscalResult({ provider: "sefaz-demo", reference: "nfe-ref-123", state: "rejected", occurredAt: new Date() }), /sem motivo/);
  assert.throws(() => validateFiscalResult({ ...authorizedFiscal(), rejectionCode: "999", rejectionMessage: "erro" }), /incompatível/);
});

test("comando local é assinado, usa IDs String, sequência e rejeita replay/tamper", () => {
  const now = new Date();
  const command = commandAt(now, 7);
  assert.match(command.commandId, /^[0-9a-f-]{36}$/);
  assert.match(command.digest, /^[a-f0-9]{64}$/);
  assert.match(command.signature, /^[a-f0-9]{64}$/);
  assert.equal(verifyDeviceCommand(command, SIGNING_KEY, { now, lastSequence: 6 }), command);
  assert.throws(() => verifyDeviceCommand(command, SIGNING_KEY, { now, lastSequence: 7 }), /já processada/);
  assert.throws(() => verifyDeviceCommand(command, SIGNING_KEY, { now, seenNonces: new Set([command.nonce]) }), /Nonce/);
  assert.throws(() => verifyDeviceCommand({ ...command, payload: { reason: "tampered" } }, SIGNING_KEY, { now }), /integridade|assinatura/i);
  assert.throws(() => verifyDeviceCommand(command, { ...SIGNING_KEY, secret: "different-secret-material-that-is-at-least-32-bytes" }, { now }), /assinatura/i);
  assert.throws(() => verifyDeviceCommand(command, SIGNING_KEY, { now: new Date(now.valueOf() + 31_000) }), /expirado/);
});

test("comando local aplica allowlist, bytes UTF-8 e rejeição PCI recursiva", () => {
  const base = { terminalId: TERMINAL_ID, deviceId: DEVICE_ID, sequence: 1, type: "drawer.open" as const, payload: {} };
  assert.throws(() => createDeviceCommand({ ...base, type: "shell.exec" as never }, SIGNING_KEY), /não permitido/);
  assert.throws(() => createDeviceCommand({ ...base, payload: { message: "😀".repeat(5_000) } }, SIGNING_KEY), /excede/);
  assert.throws(() => createDeviceCommand({ ...base, payload: { nested: [{ card: { number: "4242424242424242" } }] } }, SIGNING_KEY), /PCI proibido/);
  assert.throws(() => createDeviceCommand({ ...base, payload: { message: "pay 4242 4242 4242 4242" } }, SIGNING_KEY), /número de cartão/);
  assert.throws(() => createDeviceCommand({ ...base, terminalId: 1 as unknown as string }, SIGNING_KEY), /Terminal inválido/);
});

test("canonicalização é determinística e não executa getter, aceita ciclo ou tipo opaco", () => {
  assert.equal(canonicalPosJson({ z: 1, a: { y: 2, x: 3 } }), '{"a":{"x":3,"y":2},"z":1}');
  let getterCalls = 0;
  const getter = {} as Record<string, unknown>;
  Object.defineProperty(getter, "secret", { enumerable: true, get() { getterCalls += 1; return "leaked"; } });
  assert.throws(() => canonicalPosJson(getter), /Acessores/);
  assert.equal(getterCalls, 0);
  const cycle: Record<string, unknown> = {};
  cycle.self = cycle;
  assert.throws(() => canonicalPosJson(cycle), /cíclica/);
  assert.throws(() => canonicalPosJson({ amount: BigInt(1) }), /não serializável/);
  assert.throws(() => canonicalPosJson(new Map()), /não simples/);
});

test("ACK é assinado, vinculado ao comando e valida falhas/replay", () => {
  const now = new Date();
  const command = commandAt(now, 9);
  const ack = createDeviceAck(command, { state: "completed" }, SIGNING_KEY, now);
  assert.equal(verifyDeviceAck(ack, command, SIGNING_KEY, { now }), ack);
  assert.throws(() => verifyDeviceAck({ ...ack, state: "failed" }, command, SIGNING_KEY, { now }), /sem código/);
  assert.throws(() => verifyDeviceAck({ ...ack, sequence: 10 }, command, SIGNING_KEY, { now }), /não corresponde|integridade/i);
  assert.throws(() => verifyDeviceAck(ack, command, SIGNING_KEY, { now, seenNonces: new Set([ack.nonce]) }), /Nonce/);

  const failed = createDeviceAck(command, { state: "failed", errorCode: "printer_offline", errorMessage: "Impressora indisponível" }, SIGNING_KEY, now);
  assert.equal(verifyDeviceAck(failed, command, SIGNING_KEY, { now }).errorCode, "printer_offline");
  assert.throws(() => createDeviceAck(command, { state: "failed" }, SIGNING_KEY, now), /sem código/);
  assert.throws(() => createDeviceAck(command, { state: "accepted", errorCode: "unexpected", errorMessage: "erro" }, SIGNING_KEY, now), /não pode conter erro/);
});

function intent(overrides: Partial<PosPaymentIntentInput> = {}): PosPaymentIntentInput {
  return {
    idempotencyKey: "intent-key-123456", saleId: 1, branchId: 2, registerId: 3, terminalId: TERMINAL_ID,
    amountCents: 1_500, currency: "BRL", method: "pix", installments: 1, expiresAt: new Date(Date.now() + 60_000), ...overrides,
  };
}

const PIX_END_TO_END = "E1234567820260828ABCDEFGHIJKLMNO";

function pixTransaction(amountCents: number, overrides: Partial<PosPaymentTransaction> = {}): PosPaymentTransaction {
  return { provider: "psp-demo", reference: "provider-reference-123", state: "captured", amountCents, currency: "BRL", transactionId: "transaction-123", endToEndId: PIX_END_TO_END, occurredAt: new Date(), ...overrides };
}

function cardTransaction(amountCents: number, overrides: Partial<PosPaymentTransaction> = {}): PosPaymentTransaction {
  return { provider: "psp-demo", reference: "provider-reference-123", state: "captured", amountCents, currency: "BRL", transactionId: "transaction-123", nsu: "123456", authorizationCode: "AUTH123", brand: "VISA", lastFour: "4242", occurredAt: new Date(), ...overrides };
}

function paymentAdapter(overrides: Partial<PosPaymentAdapter> = {}): PosPaymentAdapter {
  return {
    provider: "psp-demo",
    methods: ["pix", "credit"],
    async createIntent(input) { return input.method === "pix" ? pixTransaction(input.amountCents) : cardTransaction(input.amountCents); },
    async status(reference) { return cardTransaction(1_500, { reference }); },
    async cancel(reference) { return cardTransaction(1_500, { reference, state: "cancelled" }); },
    async refund(reference, amountCents) { return cardTransaction(amountCents, { reference, state: "refunded" }); },
    ...overrides,
  };
}

function fiscalSnapshot(): PosFiscalSaleSnapshot {
  return {
    saleId: 1, saleNumber: "SALE-000001", branchId: 2, currency: "BRL", totalCents: 1_500,
    issuedAt: new Date(), customerTaxId: "529.982.247-25",
    items: [{ sequence: 1, productId: 10, description: "Produto fiscal", unit: "UN", quantity: 1.5, unitPriceCents: 1_000, discountCents: 100, surchargeCents: 100, totalCents: 1_500, fiscal: { cfop: "5102", ncm: "12345678" } }],
    payments: [{ method: "pix", amountCents: 1_500 }],
  };
}

function nfeAccessKey() {
  const base = `35${"1".repeat(41)}`;
  let weight = 2, sum = 0;
  for (let index = base.length - 1; index >= 0; index--) {
    sum += Number(base[index]) * weight;
    weight = weight === 9 ? 2 : weight + 1;
  }
  const remainder = sum % 11;
  return `${base}${remainder === 0 || remainder === 1 ? 0 : 11 - remainder}`;
}

function authorizedFiscal(overrides: Partial<PosFiscalResult> = {}): PosFiscalResult {
  return { provider: "sefaz-demo", reference: "nfe-ref-123", state: "authorized", accessKey: nfeAccessKey(), protocol: "protocol-123", xmlArtifactId: "xml-artifact-123", danfeArtifactId: "danfe-artifact-123", occurredAt: new Date(), ...overrides };
}

function fiscalAdapter(overrides: Partial<PosFiscalAdapter> = {}): PosFiscalAdapter {
  return {
    provider: "sefaz-demo",
    async validateSale() { return undefined; },
    async issue() { return authorizedFiscal(); },
    async status(reference) { return authorizedFiscal({ reference }); },
    async cancel(reference) { return authorizedFiscal({ reference, state: "cancelled", accessKey: null, xmlArtifactId: null, danfeArtifactId: null }); },
    async contingency() { return authorizedFiscal({ state: "contingency", accessKey: null, protocol: null, danfeArtifactId: null }); },
    async renderDanfe() { return { artifactId: "danfe-artifact-123" }; },
    async downloadXml() { return { artifactId: "xml-artifact-123" }; },
    ...overrides,
  };
}

function commandAt(now: Date, sequence: number): PosDeviceCommand {
  return createDeviceCommand({ terminalId: TERMINAL_ID, deviceId: DEVICE_ID, sequence, type: "drawer.open", payload: { reason: "cash_sale" } }, SIGNING_KEY, 30, now);
}
