import { createHash, createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import { PosDomainError, assertPosStateTransition } from "@/lib/erp/pos-domain";
import { containsPosPaymentPanInIdentifier } from "@/lib/erp/pos-payment-persistence";

export type PosPaymentMethod = "pix" | "credit" | "debit" | "voucher";
export type PosPaymentState = "created" | "processing" | "authorized" | "captured" | "declined" | "unknown" | "manual_review" | "cancelled" | "partially_refunded" | "refunded";
export type PosFiscalState = "processing" | "authorized" | "rejected" | "contingency" | "cancelled" | "unknown";
export type PosDeviceCommandType = "payment.start" | "payment.cancel" | "print.receipt" | "drawer.open" | "scale.read" | "display.render";
export type PosDeviceAckState = "accepted" | "completed" | "failed";

export type PosPaymentIntentInput = {
  idempotencyKey: string;
  saleId: number;
  branchId: number;
  registerId: number;
  terminalId: string | null;
  amountCents: number;
  currency: "BRL";
  method: PosPaymentMethod;
  installments: number;
  expiresAt: Date;
};

export type PosPaymentTransaction = {
  provider: string;
  reference: string;
  state: PosPaymentState;
  amountCents: number;
  currency: "BRL";
  transactionId?: string | null;
  endToEndId?: string | null;
  nsu?: string | null;
  authorizationCode?: string | null;
  brand?: string | null;
  lastFour?: string | null;
  occurredAt: Date;
  evidenceId?: string | null;
  failureCode?: string | null;
  failureMessage?: string | null;
};

export interface PosPaymentAdapter {
  readonly provider: string;
  readonly methods: readonly PosPaymentMethod[];
  createIntent(input: Readonly<PosPaymentIntentInput>, signal: AbortSignal): Promise<PosPaymentTransaction>;
  status(reference: string, signal: AbortSignal): Promise<PosPaymentTransaction>;
  cancel(reference: string, idempotencyKey: string, signal: AbortSignal): Promise<PosPaymentTransaction>;
  refund(reference: string, amountCents: number, idempotencyKey: string, signal: AbortSignal): Promise<PosPaymentTransaction>;
}

export type PosFiscalSaleSnapshot = {
  saleId: number;
  saleNumber: string;
  branchId: number;
  currency: "BRL";
  totalCents: number;
  issuedAt: Date;
  customerTaxId: string | null;
  items: ReadonlyArray<{
    sequence: number;
    productId: number;
    description: string;
    unit: string;
    quantity: number;
    unitPriceCents: number;
    discountCents: number;
    surchargeCents: number;
    totalCents: number;
    fiscal: Readonly<Record<string, unknown>>;
  }>;
  payments: ReadonlyArray<{ method: string; amountCents: number }>;
};

export type PosFiscalResult = {
  provider: string;
  reference: string;
  state: PosFiscalState;
  accessKey?: string | null;
  protocol?: string | null;
  xmlArtifactId?: string | null;
  danfeArtifactId?: string | null;
  rejectionCode?: string | null;
  rejectionMessage?: string | null;
  occurredAt: Date;
};

export interface PosFiscalAdapter {
  readonly provider: string;
  validateSale(snapshot: Readonly<PosFiscalSaleSnapshot>, profileVersion: string, signal: AbortSignal): Promise<void>;
  issue(snapshot: Readonly<PosFiscalSaleSnapshot>, profileVersion: string, idempotencyKey: string, signal: AbortSignal): Promise<PosFiscalResult>;
  status(reference: string, signal: AbortSignal): Promise<PosFiscalResult>;
  cancel(reference: string, reason: string, idempotencyKey: string, signal: AbortSignal): Promise<PosFiscalResult>;
  contingency(snapshot: Readonly<PosFiscalSaleSnapshot>, profileVersion: string, reason: string, idempotencyKey: string, signal: AbortSignal): Promise<PosFiscalResult>;
  renderDanfe(reference: string, signal: AbortSignal): Promise<{ artifactId: string }>;
  downloadXml(reference: string, signal: AbortSignal): Promise<{ artifactId: string }>;
}

export type PosExecutionOptions = { signal?: AbortSignal; timeoutMs?: number };

export class PosConnectorError extends PosDomainError {
  readonly code: "timeout" | "aborted" | "adapter_failure";
  readonly retryable: boolean;
  readonly outcomeUnknown: boolean;

  constructor(code: PosConnectorError["code"], message: string, retryable: boolean, outcomeUnknown: boolean) {
    super(message);
    this.name = "PosConnectorError";
    this.code = code;
    this.retryable = retryable;
    this.outcomeUnknown = outcomeUnknown;
  }
}

type UnsignedDeviceCommand = {
  commandId: string;
  terminalId: string;
  deviceId: string;
  sequence: number;
  type: PosDeviceCommandType;
  payload: Readonly<Record<string, unknown>>;
  nonce: string;
  issuedAt: string;
  expiresAt: string;
  keyId: string;
};

export type PosDeviceCommand = UnsignedDeviceCommand & { digest: string; signature: string };

type UnsignedDeviceAck = {
  ackId: string;
  commandId: string;
  commandDigest: string;
  terminalId: string;
  deviceId: string;
  sequence: number;
  state: PosDeviceAckState;
  occurredAt: string;
  nonce: string;
  keyId: string;
  errorCode?: string;
  errorMessage?: string;
};

export type PosDeviceAck = UnsignedDeviceAck & { digest: string; signature: string };
export type PosSigningKey = { keyId: string; secret: string | Uint8Array };
export type PosDeviceCommandIdentifiers = { commandId: string; nonce: string };
export type PosDeviceAckIdentifiers = { ackId: string; nonce: string };

type RegisteredPayment = { adapter: PosPaymentAdapter; provider: string; methods: ReadonlySet<PosPaymentMethod> };
type RegisteredFiscal = { adapter: PosFiscalAdapter; provider: string };

const PAYMENT_METHODS = new Set<PosPaymentMethod>(["pix", "credit", "debit", "voucher"]);
const PAYMENT_STATES = new Set<PosPaymentState>(["created", "processing", "authorized", "captured", "declined", "unknown", "manual_review", "cancelled", "partially_refunded", "refunded"]);
const FISCAL_STATES = new Set<PosFiscalState>(["processing", "authorized", "rejected", "contingency", "cancelled", "unknown"]);
const DEVICE_COMMAND_TYPES = new Set<PosDeviceCommandType>(["payment.start", "payment.cancel", "print.receipt", "drawer.open", "scale.read", "display.render"]);
const ACK_STATES = new Set<PosDeviceAckState>(["accepted", "completed", "failed"]);
const MAX_COMMAND_BYTES = 16_384;
const MAX_FISCAL_BLOB_BYTES = 16_384;
const MAX_CLOCK_SKEW_MS = 5 * 60_000;

export class PosAdapterRegistry {
  readonly #payments = new Map<string, RegisteredPayment>();
  readonly #fiscal = new Map<string, RegisteredFiscal>();

  registerPayment(adapter: PosPaymentAdapter) {
    assertAdapter(adapter, "pagamento", ["createIntent", "status", "cancel", "refund"]);
    const provider = providerKey(adapter.provider);
    if (!Array.isArray(adapter.methods) || adapter.methods.length === 0) throw new PosDomainError("O adapter de pagamento deve declarar ao menos um método.");
    const methods = adapter.methods.map((method) => {
      if (!PAYMENT_METHODS.has(method)) throw new PosDomainError("O adapter de pagamento declarou método inválido.");
      return method;
    });
    if (new Set(methods).size !== methods.length) throw new PosDomainError("O adapter de pagamento possui métodos duplicados.");
    if (this.#payments.has(provider)) throw new PosDomainError(`Adapter de pagamento duplicado: ${provider}.`);
    this.#payments.set(provider, { adapter, provider, methods: new Set(methods) });
    return this;
  }

  registerFiscal(adapter: PosFiscalAdapter) {
    assertAdapter(adapter, "fiscal", ["validateSale", "issue", "status", "cancel", "contingency", "renderDanfe", "downloadXml"]);
    const provider = providerKey(adapter.provider);
    if (this.#fiscal.has(provider)) throw new PosDomainError(`Adapter fiscal duplicado: ${provider}.`);
    this.#fiscal.set(provider, { adapter, provider });
    return this;
  }

  async createPaymentIntent(provider: string, input: PosPaymentIntentInput, options?: PosExecutionOptions) {
    validatePaymentIntent(input);
    const registered = this.#payment(provider, input.method);
    const result = await executeAdapter(registered.provider, "criar intenção", true, options, (signal) => registered.adapter.createIntent(Object.freeze({ ...input, expiresAt: new Date(input.expiresAt) }), signal));
    return validateProviderTransaction(result, { provider: registered.provider, amountCents: input.amountCents, currency: input.currency, method: input.method, states: ["created", "processing", "authorized", "captured", "declined", "unknown", "manual_review"] });
  }

  async paymentStatus(provider: string, referenceValue: string, options?: PosExecutionOptions) {
    const registered = this.#payment(provider);
    const value = reference(referenceValue, "Referência do provedor");
    const result = await executeAdapter(registered.provider, "consultar pagamento", false, options, (signal) => registered.adapter.status(value, signal));
    return validateProviderTransaction(result, { provider: registered.provider, reference: value });
  }

  async cancelPayment(provider: string, referenceValue: string, idempotencyValue: string, options?: PosExecutionOptions) {
    const registered = this.#payment(provider);
    const value = reference(referenceValue, "Referência do provedor");
    const key = idempotencyKey(idempotencyValue);
    const result = await executeAdapter(registered.provider, "cancelar pagamento", true, options, (signal) => registered.adapter.cancel(value, key, signal));
    return validateProviderTransaction(result, { provider: registered.provider, reference: value, states: ["processing", "cancelled", "unknown", "manual_review"] });
  }

  async refundPayment(provider: string, referenceValue: string, amountCents: number, idempotencyValue: string, options?: PosExecutionOptions) {
    const registered = this.#payment(provider);
    const value = reference(referenceValue, "Referência do provedor");
    cents(amountCents, "Valor do estorno");
    const key = idempotencyKey(idempotencyValue);
    const result = await executeAdapter(registered.provider, "estornar pagamento", true, options, (signal) => registered.adapter.refund(value, amountCents, key, signal));
    return validateProviderTransaction(result, { provider: registered.provider, reference: value, amountCents, states: ["processing", "partially_refunded", "refunded", "unknown", "manual_review"] });
  }

  async validateFiscalSale(provider: string, snapshot: PosFiscalSaleSnapshot, profileVersion: string, options?: PosExecutionOptions) {
    const registered = this.#fiscalProvider(provider);
    const normalized = validateFiscalSaleSnapshot(snapshot);
    const profile = reference(profileVersion, "Versão do perfil fiscal", 80);
    const result = await executeAdapter(registered.provider, "validar venda fiscal", false, options, (signal) => registered.adapter.validateSale(normalized, profile, signal));
    if (result !== undefined) throw new PosDomainError("Validação fiscal retornou resposta inesperada.");
  }

  async issueFiscal(provider: string, snapshot: PosFiscalSaleSnapshot, profileVersion: string, idempotencyValue: string, options?: PosExecutionOptions) {
    const registered = this.#fiscalProvider(provider);
    const normalized = validateFiscalSaleSnapshot(snapshot);
    const profile = reference(profileVersion, "Versão do perfil fiscal", 80);
    const key = idempotencyKey(idempotencyValue);
    const result = await executeAdapter(registered.provider, "emitir documento fiscal", true, options, (signal) => registered.adapter.issue(normalized, profile, key, signal));
    return validateFiscalResult(result, { provider: registered.provider, states: ["processing", "authorized", "rejected", "contingency", "unknown"] });
  }

  async fiscalStatus(provider: string, referenceValue: string, options?: PosExecutionOptions) {
    const registered = this.#fiscalProvider(provider);
    const value = reference(referenceValue, "Referência fiscal");
    const result = await executeAdapter(registered.provider, "consultar documento fiscal", false, options, (signal) => registered.adapter.status(value, signal));
    return validateFiscalResult(result, { provider: registered.provider, reference: value });
  }

  async cancelFiscal(provider: string, referenceValue: string, reasonValue: string, idempotencyValue: string, options?: PosExecutionOptions) {
    const registered = this.#fiscalProvider(provider);
    const value = reference(referenceValue, "Referência fiscal");
    const reason = boundedText(reasonValue, "Justificativa fiscal", 15, 255);
    const key = idempotencyKey(idempotencyValue);
    const result = await executeAdapter(registered.provider, "cancelar documento fiscal", true, options, (signal) => registered.adapter.cancel(value, reason, key, signal));
    return validateFiscalResult(result, { provider: registered.provider, reference: value, states: ["processing", "cancelled", "rejected", "unknown"] });
  }

  async fiscalContingency(provider: string, snapshot: PosFiscalSaleSnapshot, profileVersion: string, reasonValue: string, idempotencyValue: string, options?: PosExecutionOptions) {
    const registered = this.#fiscalProvider(provider);
    const normalized = validateFiscalSaleSnapshot(snapshot);
    const profile = reference(profileVersion, "Versão do perfil fiscal", 80);
    const reason = boundedText(reasonValue, "Justificativa de contingência", 15, 255);
    const key = idempotencyKey(idempotencyValue);
    const result = await executeAdapter(registered.provider, "emitir em contingência", true, options, (signal) => registered.adapter.contingency(normalized, profile, reason, key, signal));
    return validateFiscalResult(result, { provider: registered.provider, states: ["processing", "contingency", "authorized", "rejected", "unknown"] });
  }

  async renderFiscalDanfe(provider: string, referenceValue: string, options?: PosExecutionOptions) {
    return this.#fiscalArtifact(provider, referenceValue, "renderizar DANFE", "renderDanfe", options);
  }

  async downloadFiscalXml(provider: string, referenceValue: string, options?: PosExecutionOptions) {
    return this.#fiscalArtifact(provider, referenceValue, "baixar XML", "downloadXml", options);
  }

  #payment(provider: string, method?: PosPaymentMethod) {
    const key = providerKey(provider);
    const registered = this.#payments.get(key);
    if (!registered || (method && !registered.methods.has(method))) throw new PosDomainError(`Conector ${provider} não está habilitado${method ? ` para ${method}` : ""}.`);
    return registered;
  }

  #fiscalProvider(provider: string) {
    const registered = this.#fiscal.get(providerKey(provider));
    if (!registered) throw new PosDomainError(`Conector fiscal ${provider} não está habilitado.`);
    return registered;
  }

  async #fiscalArtifact(provider: string, referenceValue: string, operation: string, method: "renderDanfe" | "downloadXml", options?: PosExecutionOptions) {
    const registered = this.#fiscalProvider(provider);
    const value = reference(referenceValue, "Referência fiscal");
    const result = await executeAdapter(registered.provider, operation, false, options, (signal) => registered.adapter[method](value, signal));
    assertPlainRecord(result, "Resposta de artefato fiscal");
    assertOnlyKeys(result, new Set(["artifactId"]), "Resposta de artefato fiscal");
    return { artifactId: reference(result.artifactId as string, "Artefato fiscal", 160) };
  }
}

export function validatePaymentIntent(input: PosPaymentIntentInput) {
  assertPlainRecord(input, "Intenção de pagamento");
  assertOnlyKeys(input, new Set(["idempotencyKey", "saleId", "branchId", "registerId", "terminalId", "amountCents", "currency", "method", "installments", "expiresAt"]), "Intenção de pagamento");
  idempotencyKey(input.idempotencyKey);
  positiveId(input.saleId, "Venda");
  positiveId(input.branchId, "Filial");
  positiveId(input.registerId, "Caixa");
  if (input.terminalId != null) entityId(input.terminalId, "Terminal");
  cents(input.amountCents, "Valor do pagamento");
  if (input.currency !== "BRL") throw new PosDomainError("Moeda do pagamento inválida.");
  if (!PAYMENT_METHODS.has(input.method)) throw new PosDomainError("Método eletrônico inválido.");
  if (!Number.isSafeInteger(input.installments) || input.installments < 1 || input.installments > 99) throw new PosDomainError("Número de parcelas inválido.");
  if (input.method !== "credit" && input.installments !== 1) throw new PosDomainError("Parcelamento só é permitido no crédito.");
  validFutureDate(input.expiresAt, "A intenção de pagamento deve expirar no futuro.");
  return input;
}

export function validateProviderTransaction(transaction: PosPaymentTransaction, expected: number | { provider?: string; reference?: string; amountCents?: number; currency?: "BRL"; method?: PosPaymentMethod; states?: readonly PosPaymentState[] } = {}) {
  const constraints = typeof expected === "number" ? { amountCents: expected } : expected;
  assertPlainRecord(transaction, "Resposta do provedor");
  assertOnlyKeys(transaction, new Set(["provider", "reference", "state", "amountCents", "currency", "transactionId", "endToEndId", "nsu", "authorizationCode", "brand", "lastFour", "occurredAt", "evidenceId", "failureCode", "failureMessage"]), "Resposta do provedor");
  const provider = providerKey(transaction.provider);
  const providerReference = reference(transaction.reference, "Referência do provedor");
  if (!PAYMENT_STATES.has(transaction.state)) throw new PosDomainError("Estado retornado pelo provedor é inválido.");
  if (constraints.states && !constraints.states.includes(transaction.state)) throw new PosDomainError("Estado retornado não é válido para a operação.");
  cents(transaction.amountCents, "Valor retornado pelo provedor");
  if (transaction.currency !== "BRL") throw new PosDomainError("Moeda retornada pelo provedor é inválida.");
  if (constraints.provider && provider !== providerKey(constraints.provider)) throw new PosDomainError("O provedor da resposta diverge do conector executado.");
  if (constraints.reference && providerReference !== constraints.reference) throw new PosDomainError("A referência retornada diverge da operação.");
  if (constraints.amountCents != null && transaction.amountCents !== constraints.amountCents) throw new PosDomainError("O valor confirmado pelo provedor diverge da intenção.");
  if (constraints.currency && transaction.currency !== constraints.currency) throw new PosDomainError("A moeda confirmada pelo provedor diverge da intenção.");
  validOccurredAt(transaction.occurredAt, "Data da transação do provedor inválida.");
  optionalReference(transaction.transactionId, "Transação do provedor");
  optionalReference(transaction.nsu, "NSU", 80);
  optionalReference(transaction.authorizationCode, "Código de autorização", 80);
  optionalReference(transaction.brand, "Bandeira", 40);
  optionalReference(transaction.evidenceId, "Evidência", 160);
  optionalReference(transaction.failureCode, "Código de falha", 80);
  optionalReference(transaction.failureMessage, "Mensagem de falha", 500);
  if (transaction.lastFour != null && !/^\d{4}$/.test(transaction.lastFour)) throw new PosDomainError("Final do cartão inválido.");
  if (transaction.endToEndId != null && !/^E\d{16}[A-Z0-9]{15}$/.test(transaction.endToEndId)) throw new PosDomainError("Identificador Pix inválido.");
  if (constraints.method === "pix" && transaction.lastFour != null) throw new PosDomainError("Resposta Pix contém evidência de cartão indevida.");
  if ((constraints.method === "credit" || constraints.method === "debit" || constraints.method === "voucher") && transaction.endToEndId != null) throw new PosDomainError("Resposta de cartão contém evidência Pix indevida.");
  if (["authorized", "captured"].includes(transaction.state)) {
    if (constraints.method === "pix" && !transaction.endToEndId) throw new PosDomainError("Pagamento Pix confirmado sem EndToEndId.");
    if (constraints.method && constraints.method !== "pix" && (!transaction.transactionId || !transaction.authorizationCode || !transaction.lastFour)) throw new PosDomainError("Pagamento de cartão confirmado sem evidência obrigatória.");
    if (!constraints.method && !transaction.endToEndId && (!transaction.transactionId || !transaction.authorizationCode)) throw new PosDomainError("Pagamento confirmado sem evidência obrigatória.");
  }
  if (transaction.state === "declined" && (!transaction.failureCode || !transaction.failureMessage)) throw new PosDomainError("Pagamento negado sem motivo do provedor.");
  for (const [field, value] of Object.entries({ reference: transaction.reference, transactionId: transaction.transactionId, nsu: transaction.nsu, authorizationCode: transaction.authorizationCode, brand: transaction.brand, evidenceId: transaction.evidenceId, failureCode: transaction.failureCode, failureMessage: transaction.failureMessage })) {
    if (typeof value === "string" && containsPosPaymentPanInIdentifier(value)) throw new PosDomainError(`Resposta do provedor contém número de cartão em ${field}.`);
  }
  rejectPciData(transaction, "Resposta do provedor", false);
  return transaction;
}

export function advancePaymentState(current: PosPaymentState, next: PosPaymentState) {
  return assertPosStateTransition("payment", current, next) as PosPaymentState;
}

export function validateFiscalSaleSnapshot(snapshot: PosFiscalSaleSnapshot): Readonly<PosFiscalSaleSnapshot> {
  assertPlainRecord(snapshot, "Snapshot fiscal");
  assertOnlyKeys(snapshot, new Set(["saleId", "saleNumber", "branchId", "currency", "totalCents", "issuedAt", "customerTaxId", "items", "payments"]), "Snapshot fiscal");
  positiveId(snapshot.saleId, "Venda");
  reference(snapshot.saleNumber, "Número da venda", 80);
  positiveId(snapshot.branchId, "Filial");
  if (snapshot.currency !== "BRL") throw new PosDomainError("Moeda do snapshot fiscal inválida.");
  cents(snapshot.totalCents, "Total fiscal");
  validOccurredAt(snapshot.issuedAt, "Data de emissão fiscal inválida.");
  if (snapshot.customerTaxId != null && !validBrazilianTaxId(snapshot.customerTaxId)) throw new PosDomainError("CPF/CNPJ do consumidor inválido.");
  if (!Array.isArray(snapshot.items) || snapshot.items.length < 1 || snapshot.items.length > 200) throw new PosDomainError("Quantidade de itens fiscais inválida.");
  let itemTotal = 0;
  snapshot.items.forEach((item, index) => {
    assertPlainRecord(item, `Item fiscal ${index + 1}`);
    assertOnlyKeys(item, new Set(["sequence", "productId", "description", "unit", "quantity", "unitPriceCents", "discountCents", "surchargeCents", "totalCents", "fiscal"]), `Item fiscal ${index + 1}`);
    const checked = item as PosFiscalSaleSnapshot["items"][number];
    if (checked.sequence !== index + 1) throw new PosDomainError("Sequência dos itens fiscais inválida.");
    positiveId(checked.productId, "Produto fiscal");
    boundedText(checked.description, "Descrição fiscal", 1, 120);
    if (!/^[A-Z0-9]{1,6}$/.test(checked.unit)) throw new PosDomainError("Unidade fiscal inválida.");
    if (!Number.isFinite(checked.quantity) || checked.quantity <= 0 || checked.quantity > 999_999 || Math.abs(Math.round(checked.quantity * 1_000) - checked.quantity * 1_000) > 1e-9) throw new PosDomainError("Quantidade fiscal inválida.");
    cents(checked.unitPriceCents, "Preço unitário fiscal");
    nonNegativeCents(checked.discountCents, "Desconto fiscal");
    nonNegativeCents(checked.surchargeCents, "Acréscimo fiscal");
    cents(checked.totalCents, "Total do item fiscal");
    const expected = Math.round(checked.unitPriceCents * checked.quantity) - checked.discountCents + checked.surchargeCents;
    if (expected !== checked.totalCents || expected <= 0) throw new PosDomainError("Total do item fiscal não fecha com quantidade, preço e ajustes.");
    const fiscalJson = canonicalPosJson(checked.fiscal);
    if (Buffer.byteLength(fiscalJson, "utf8") > MAX_FISCAL_BLOB_BYTES) throw new PosDomainError("Dados fiscais do item excedem o limite permitido.");
    rejectPciData(checked.fiscal, "Dados fiscais do item", false);
    itemTotal += checked.totalCents;
  });
  if (itemTotal !== snapshot.totalCents) throw new PosDomainError("Soma dos itens diverge do total fiscal.");
  if (!Array.isArray(snapshot.payments) || snapshot.payments.length < 1 || snapshot.payments.length > 50) throw new PosDomainError("Pagamentos do snapshot fiscal inválidos.");
  let paymentTotal = 0;
  snapshot.payments.forEach((payment) => {
    assertPlainRecord(payment, "Pagamento fiscal");
    assertOnlyKeys(payment, new Set(["method", "amountCents"]), "Pagamento fiscal");
    const checked = payment as PosFiscalSaleSnapshot["payments"][number];
    reference(checked.method, "Meio de pagamento fiscal", 40);
    cents(checked.amountCents, "Valor do pagamento fiscal");
    paymentTotal += checked.amountCents;
  });
  if (paymentTotal !== snapshot.totalCents) throw new PosDomainError("Soma dos pagamentos diverge do total fiscal.");
  return deepFreeze({
    ...snapshot,
    issuedAt: new Date(snapshot.issuedAt),
    items: snapshot.items.map((item) => ({ ...item, fiscal: cloneCanonical(item.fiscal) })),
    payments: snapshot.payments.map((payment) => ({ ...payment })),
  });
}

export function fiscalSnapshotDigest(snapshot: PosFiscalSaleSnapshot) {
  return sha256(canonicalPosJson(validateFiscalSaleSnapshot(snapshot)));
}

export function validateFiscalResult(result: PosFiscalResult, expected: { provider?: string; reference?: string; states?: readonly PosFiscalState[] } = {}) {
  assertPlainRecord(result, "Resposta fiscal");
  assertOnlyKeys(result, new Set(["provider", "reference", "state", "accessKey", "protocol", "xmlArtifactId", "danfeArtifactId", "rejectionCode", "rejectionMessage", "occurredAt"]), "Resposta fiscal");
  const provider = providerKey(result.provider);
  const providerReference = reference(result.reference, "Referência fiscal");
  if (!FISCAL_STATES.has(result.state)) throw new PosDomainError("Estado fiscal inválido.");
  if (expected.provider && provider !== providerKey(expected.provider)) throw new PosDomainError("O provedor fiscal da resposta diverge do conector executado.");
  if (expected.reference && providerReference !== expected.reference) throw new PosDomainError("A referência fiscal retornada diverge da operação.");
  if (expected.states && !expected.states.includes(result.state)) throw new PosDomainError("Estado fiscal não é válido para a operação.");
  validOccurredAt(result.occurredAt, "Data da resposta fiscal inválida.");
  optionalReference(result.protocol, "Protocolo fiscal", 100);
  optionalReference(result.xmlArtifactId, "Artefato XML", 160);
  optionalReference(result.danfeArtifactId, "Artefato DANFE", 160);
  optionalReference(result.rejectionCode, "Código de rejeição", 40);
  optionalReference(result.rejectionMessage, "Mensagem de rejeição", 500);
  if (result.accessKey != null && !validNfeAccessKey(result.accessKey)) throw new PosDomainError("Chave de acesso fiscal inválida.");
  if (result.state === "authorized" && (!result.accessKey || !result.protocol || !result.xmlArtifactId)) throw new PosDomainError("Autorização fiscal sem evidência obrigatória.");
  if (result.state === "rejected" && (!result.rejectionCode || !result.rejectionMessage)) throw new PosDomainError("Rejeição fiscal sem motivo.");
  if (result.state === "contingency" && !result.xmlArtifactId) throw new PosDomainError("Contingência fiscal sem artefato XML.");
  if (result.state === "cancelled" && !result.protocol) throw new PosDomainError("Cancelamento fiscal sem protocolo.");
  if (result.state !== "rejected" && (result.rejectionCode || result.rejectionMessage)) throw new PosDomainError("Resposta fiscal contém rejeição incompatível com o estado.");
  return result;
}

export function advanceFiscalState(current: PosFiscalState, next: PosFiscalState) {
  if (!FISCAL_STATES.has(current) || !FISCAL_STATES.has(next)) throw new PosDomainError(`Transição fiscal inválida de ${current} para ${next}.`);
  if (current === next) return next;
  const graph: Record<PosFiscalState, readonly PosFiscalState[]> = {
    processing: ["authorized", "rejected", "contingency", "unknown"],
    authorized: ["cancelled", "unknown"],
    rejected: ["processing", "contingency"],
    contingency: ["authorized", "rejected", "cancelled", "unknown"],
    unknown: ["processing", "authorized", "rejected", "contingency", "cancelled"],
    cancelled: [],
  };
  if (!graph[current].includes(next)) throw new PosDomainError(`Transição fiscal inválida de ${current} para ${next}.`);
  return next;
}

export function createDeviceCommand(input: Omit<UnsignedDeviceCommand, "commandId" | "nonce" | "issuedAt" | "expiresAt" | "keyId">, signingKey: PosSigningKey, ttlSeconds = 30, now = new Date(), identifiers?: PosDeviceCommandIdentifiers): PosDeviceCommand {
  assertPlainRecord(input, "Solicitação de comando local");
  assertOnlyKeys(input, new Set(["terminalId", "deviceId", "sequence", "type", "payload"]), "Solicitação de comando local");
  entityId(input.terminalId, "Terminal");
  entityId(input.deviceId, "Dispositivo");
  positiveSequence(input.sequence);
  if (!DEVICE_COMMAND_TYPES.has(input.type)) throw new PosDomainError("Tipo de comando local não permitido.");
  if (!Number.isSafeInteger(ttlSeconds) || ttlSeconds < 5 || ttlSeconds > 300) throw new PosDomainError("Expiração do comando inválida.");
  validOccurredAt(now, "Data de emissão do comando inválida.");
  validateLocalPayload(input.payload);
  const key = signingKeyMaterial(signingKey);
  if (identifiers) {
    assertPlainRecord(identifiers, "Identificadores do comando");
    assertOnlyKeys(identifiers, new Set(["commandId", "nonce"]), "Identificadores do comando");
    uuid(identifiers.commandId, "Comando");
    uuid(identifiers.nonce, "Nonce do comando");
  }
  const unsigned: UnsignedDeviceCommand = {
    commandId: identifiers?.commandId ?? randomUUID(), terminalId: input.terminalId, deviceId: input.deviceId, sequence: input.sequence,
    type: input.type, payload: cloneCanonical(input.payload) as Readonly<Record<string, unknown>>, nonce: identifiers?.nonce ?? randomUUID(),
    issuedAt: now.toISOString(), expiresAt: new Date(now.valueOf() + ttlSeconds * 1_000).toISOString(), keyId: key.keyId,
  };
  return signEnvelope(unsigned, key.secret);
}

export function verifyDeviceCommand(command: PosDeviceCommand, signingKey: PosSigningKey, options: { now?: Date; lastSequence?: number; seenNonces?: ReadonlySet<string> } = {}) {
  assertSignedCommand(command);
  entityId(command.terminalId, "Terminal");
  entityId(command.deviceId, "Dispositivo");
  positiveSequence(command.sequence);
  if (!DEVICE_COMMAND_TYPES.has(command.type)) throw new PosDomainError("Tipo de comando local não permitido.");
  validateLocalPayload(command.payload);
  const key = signingKeyMaterial(signingKey);
  verifyEnvelope(command, key);
  const issuedAt = validIsoDate(command.issuedAt, "Data de emissão do comando inválida.");
  const expiresAt = validIsoDate(command.expiresAt, "Data de expiração do comando inválida.");
  const now = options.now ?? new Date();
  if (expiresAt <= issuedAt || expiresAt - issuedAt > 300_000 || now.valueOf() < issuedAt - MAX_CLOCK_SKEW_MS || now.valueOf() > expiresAt) throw new PosDomainError("Comando local expirado ou fora da janela permitida.");
  if (options.lastSequence != null && command.sequence <= options.lastSequence) throw new PosDomainError("Sequência do comando já processada.");
  if (options.seenNonces?.has(command.nonce)) throw new PosDomainError("Nonce do comando já processado.");
  return command;
}

export function createDeviceAck(command: PosDeviceCommand, input: { state: PosDeviceAckState; errorCode?: string; errorMessage?: string }, signingKey: PosSigningKey, now = new Date(), identifiers?: PosDeviceAckIdentifiers): PosDeviceAck {
  assertSignedCommand(command);
  assertPlainRecord(input, "Solicitação de ACK");
  assertOnlyKeys(input, new Set(["state", "errorCode", "errorMessage"]), "Solicitação de ACK");
  const key = signingKeyMaterial(signingKey);
  verifyEnvelope(command, key);
  if (!ACK_STATES.has(input.state)) throw new PosDomainError("Estado do ACK inválido.");
  validOccurredAt(now, "Data do ACK inválida.");
  validateAckError(input.state, input.errorCode, input.errorMessage);
  if (identifiers) {
    assertPlainRecord(identifiers, "Identificadores do ACK");
    assertOnlyKeys(identifiers, new Set(["ackId", "nonce"]), "Identificadores do ACK");
    uuid(identifiers.ackId, "ACK");
    uuid(identifiers.nonce, "Nonce do ACK");
  }
  const unsigned: UnsignedDeviceAck = {
    ackId: identifiers?.ackId ?? randomUUID(), commandId: command.commandId, commandDigest: command.digest, terminalId: command.terminalId, deviceId: command.deviceId,
    sequence: command.sequence, state: input.state, occurredAt: now.toISOString(), nonce: identifiers?.nonce ?? randomUUID(), keyId: key.keyId,
    ...(input.errorCode ? { errorCode: reference(input.errorCode, "Código de erro do ACK", 80) } : {}),
    ...(input.errorMessage ? { errorMessage: boundedText(input.errorMessage, "Mensagem de erro do ACK", 1, 500) } : {}),
  };
  return signEnvelope(unsigned, key.secret);
}

export function verifyDeviceAck(ack: PosDeviceAck, command: PosDeviceCommand, signingKey: PosSigningKey, options: { now?: Date; maxAgeMs?: number; seenNonces?: ReadonlySet<string> } = {}) {
  assertSignedAck(ack);
  assertSignedCommand(command);
  if (!ACK_STATES.has(ack.state)) throw new PosDomainError("Estado do ACK inválido.");
  validateAckError(ack.state, ack.errorCode, ack.errorMessage);
  const key = signingKeyMaterial(signingKey);
  verifyEnvelope(command, key);
  verifyEnvelope(ack, key);
  if (ack.commandId !== command.commandId || ack.commandDigest !== command.digest || ack.terminalId !== command.terminalId || ack.deviceId !== command.deviceId || ack.sequence !== command.sequence) throw new PosDomainError("ACK não corresponde ao comando local.");
  const occurredAt = validIsoDate(ack.occurredAt, "Data do ACK inválida.");
  const now = options.now ?? new Date();
  const maxAgeMs = options.maxAgeMs ?? 300_000;
  if (!Number.isSafeInteger(maxAgeMs) || maxAgeMs < 1_000 || maxAgeMs > 86_400_000) throw new PosDomainError("Janela do ACK inválida.");
  if (occurredAt > now.valueOf() + MAX_CLOCK_SKEW_MS || occurredAt < now.valueOf() - maxAgeMs) throw new PosDomainError("ACK fora da janela permitida.");
  if (options.seenNonces?.has(ack.nonce)) throw new PosDomainError("Nonce do ACK já processado.");
  return ack;
}

export function canonicalPosJson(value: unknown): string {
  const seen = new Set<object>();
  let nodes = 0;
  const visit = (candidate: unknown, depth: number): string => {
    if (++nodes > 10_000 || depth > 32) throw new PosDomainError("Estrutura excede os limites de canonicalização.");
    if (candidate === null) return "null";
    if (typeof candidate === "string" || typeof candidate === "boolean") return JSON.stringify(candidate);
    if (typeof candidate === "number") {
      if (!Number.isFinite(candidate)) throw new PosDomainError("Número não finito não pode ser canonicalizado.");
      return JSON.stringify(Object.is(candidate, -0) ? 0 : candidate);
    }
    if (candidate instanceof Date) {
      const timestamp = Date.prototype.getTime.call(candidate);
      if (Number.isNaN(timestamp)) throw new PosDomainError("Data inválida não pode ser canonicalizada.");
      return JSON.stringify(Date.prototype.toISOString.call(candidate));
    }
    if (typeof candidate !== "object") throw new PosDomainError("Tipo não serializável na canonicalização.");
    if (seen.has(candidate)) throw new PosDomainError("Estrutura cíclica não pode ser canonicalizada.");
    const proto = Object.getPrototypeOf(candidate);
    if (!Array.isArray(candidate) && proto !== Object.prototype && proto !== null) throw new PosDomainError("Objeto não simples não pode ser canonicalizado.");
    if (Object.getOwnPropertySymbols(candidate).length) throw new PosDomainError("Chaves Symbol não podem ser canonicalizadas.");
    seen.add(candidate);
    try {
      const descriptors = Object.getOwnPropertyDescriptors(candidate);
      if (Array.isArray(candidate)) {
        const extraKeys = Object.keys(descriptors).filter((key) => key !== "length" && !/^(0|[1-9]\d*)$/.test(key));
        if (extraKeys.length) throw new PosDomainError("Array contém propriedades não serializáveis.");
        const parts: string[] = [];
        for (let index = 0; index < candidate.length; index++) {
          const descriptor = descriptors[String(index)];
          if (!descriptor || !("value" in descriptor) || descriptor.get || descriptor.set) throw new PosDomainError("Array esparso ou com acessores não pode ser canonicalizado.");
          parts.push(visit(descriptor.value, depth + 1));
        }
        return `[${parts.join(",")}]`;
      }
      const keys = Object.keys(descriptors).sort();
      const parts = keys.map((key) => {
        if (["__proto__", "prototype", "constructor"].includes(key)) throw new PosDomainError("Chave reservada não pode ser canonicalizada.");
        if (Buffer.byteLength(key, "utf8") > 256) throw new PosDomainError("Chave excede o limite de canonicalização.");
        const descriptor = descriptors[key];
        if (!("value" in descriptor) || descriptor.get || descriptor.set) throw new PosDomainError("Acessores não podem ser canonicalizados.");
        return `${JSON.stringify(key)}:${visit(descriptor.value, depth + 1)}`;
      });
      return `{${parts.join(",")}}`;
    } finally {
      seen.delete(candidate);
    }
  };
  return visit(value, 0);
}

async function executeAdapter<T>(provider: string, operation: string, outcomeUnknown: boolean, options: PosExecutionOptions | undefined, callback: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const timeoutMs = options?.timeoutMs ?? 15_000;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 10 || timeoutMs > 120_000) throw new PosDomainError("Timeout do conector inválido.");
  if (options?.signal?.aborted) throw new PosConnectorError("aborted", `Operação ${operation} cancelada.`, true, outcomeUnknown);
  const controller = new AbortController();
  const onAbort = () => controller.abort(options?.signal?.reason);
  options?.signal?.addEventListener("abort", onAbort, { once: true });
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const timedOut = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        controller.abort(new Error("timeout"));
        reject(new PosConnectorError("timeout", `Conector ${provider} excedeu o tempo de ${operation}.`, true, outcomeUnknown));
      }, timeoutMs);
    });
    const aborted = new Promise<never>((_, reject) => {
      controller.signal.addEventListener("abort", () => {
        if (options?.signal?.aborted) reject(new PosConnectorError("aborted", `Operação ${operation} cancelada.`, true, outcomeUnknown));
      }, { once: true });
    });
    return await Promise.race([Promise.resolve().then(() => callback(controller.signal)), timedOut, aborted]);
  } catch (error) {
    if (error instanceof PosConnectorError) throw error;
    throw new PosConnectorError("adapter_failure", `Conector ${provider} falhou ao ${operation}.`, true, outcomeUnknown);
  } finally {
    if (timer) clearTimeout(timer);
    options?.signal?.removeEventListener("abort", onAbort);
  }
}

function assertAdapter(adapter: unknown, kind: string, methods: readonly string[]): asserts adapter is Record<string, unknown> {
  if (adapter === null || (typeof adapter !== "object" && typeof adapter !== "function")) throw new PosDomainError(`Adapter de ${kind} inválido.`);
  const value = adapter as Record<string, unknown>;
  if (typeof value.provider !== "string") throw new PosDomainError(`Adapter de ${kind} sem provedor.`);
  for (const method of methods) if (typeof value[method] !== "function") throw new PosDomainError(`Adapter de ${kind} não implementa ${method}.`);
}

function validateLocalPayload(payload: Readonly<Record<string, unknown>>) {
  assertPlainRecord(payload, "Payload do comando");
  const encoded = canonicalPosJson(payload);
  if (Buffer.byteLength(encoded, "utf8") > MAX_COMMAND_BYTES) throw new PosDomainError("Payload do comando excede o limite permitido.");
  rejectPciData(payload, "Payload do comando", true);
}

function rejectPciData(value: unknown, label: string, scanValues: boolean) {
  const forbidden = new Set(["pan", "card", "cardnumber", "creditcardnumber", "debitcardnumber", "fullcardnumber", "cvv", "cvc", "cid", "pin", "pinblock", "encryptedpin", "track", "track1", "track2", "trackdata", "magstripe", "securitycode"]);
  const visit = (candidate: unknown) => {
    if (typeof candidate === "string" && scanValues) {
      if (/[;%][A-Z0-9 ]{0,26}\^|=\d{4,}/i.test(candidate)) throw new PosDomainError(`${label} contém dados de trilha de cartão.`);
      for (const match of candidate.match(/(?:\d[ -]?){13,19}/g) ?? []) {
        const digits = match.replace(/\D/g, "");
        if (digits.length >= 13 && digits.length <= 19 && luhn(digits)) throw new PosDomainError(`${label} contém número de cartão.`);
      }
    }
    if (candidate === null || typeof candidate !== "object") return;
    if (Array.isArray(candidate)) return candidate.forEach(visit);
    for (const [key, child] of Object.entries(candidate)) {
      if (forbidden.has(key.toLowerCase().replace(/[^a-z0-9]/g, ""))) throw new PosDomainError(`${label} contém campo PCI proibido.`);
      visit(child);
    }
  };
  visit(value);
}

function luhn(value: string) {
  let sum = 0;
  let alternate = false;
  for (let index = value.length - 1; index >= 0; index--) {
    let digit = Number(value[index]);
    if (alternate && (digit *= 2) > 9) digit -= 9;
    sum += digit;
    alternate = !alternate;
  }
  return sum % 10 === 0;
}

function signingKeyMaterial(signingKey: PosSigningKey) {
  assertPlainRecord(signingKey, "Chave de assinatura");
  assertOnlyKeys(signingKey, new Set(["keyId", "secret"]), "Chave de assinatura");
  const keyId = reference(signingKey.keyId, "Identificador da chave", 80);
  if (typeof signingKey.secret !== "string" && !(signingKey.secret instanceof Uint8Array)) throw new PosDomainError("Segredo de assinatura inválido.");
  const secret = typeof signingKey.secret === "string" ? Buffer.from(signingKey.secret, "utf8") : Buffer.from(signingKey.secret);
  if (secret.byteLength < 32 || secret.byteLength > 1_024) throw new PosDomainError("Segredo de assinatura deve ter entre 32 e 1024 bytes.");
  return { keyId, secret };
}

function signEnvelope<T extends object>(unsigned: T, secret: Uint8Array): T & { digest: string; signature: string } {
  const digest = sha256(canonicalPosJson(unsigned));
  const signature = createHmac("sha256", secret).update(`${String((unsigned as { keyId?: string }).keyId)}.${digest}`, "utf8").digest("hex");
  return deepFreeze({ ...unsigned, digest, signature });
}

function verifyEnvelope(envelope: Record<string, unknown> & { keyId: string; digest: string; signature: string }, key: { keyId: string; secret: Uint8Array }) {
  if (envelope.keyId !== key.keyId) throw new PosDomainError("Chave de assinatura não corresponde ao envelope.");
  if (!/^[a-f0-9]{64}$/.test(envelope.digest) || !/^[a-f0-9]{64}$/.test(envelope.signature)) throw new PosDomainError("Assinatura do envelope inválida.");
  const { digest, signature, ...unsigned } = envelope;
  const computedDigest = sha256(canonicalPosJson(unsigned));
  const computedSignature = createHmac("sha256", key.secret).update(`${key.keyId}.${computedDigest}`, "utf8").digest("hex");
  if (!safeHexEqual(digest, computedDigest) || !safeHexEqual(signature, computedSignature)) throw new PosDomainError("Integridade ou assinatura do envelope inválida.");
}

function assertSignedCommand(command: PosDeviceCommand): asserts command is PosDeviceCommand & Record<string, unknown> {
  assertPlainRecord(command, "Comando local");
  assertOnlyKeys(command, new Set(["commandId", "terminalId", "deviceId", "sequence", "type", "payload", "nonce", "issuedAt", "expiresAt", "keyId", "digest", "signature"]), "Comando local");
  uuid(command.commandId, "Comando");
  uuid(command.nonce, "Nonce do comando");
}

function assertSignedAck(ack: PosDeviceAck): asserts ack is PosDeviceAck & Record<string, unknown> {
  assertPlainRecord(ack, "ACK local");
  assertOnlyKeys(ack, new Set(["ackId", "commandId", "commandDigest", "terminalId", "deviceId", "sequence", "state", "occurredAt", "nonce", "keyId", "errorCode", "errorMessage", "digest", "signature"]), "ACK local");
  uuid(ack.ackId, "ACK");
  uuid(ack.commandId, "Comando do ACK");
  if (!/^[a-f0-9]{64}$/.test(ack.commandDigest)) throw new PosDomainError("Digest do comando no ACK inválido.");
  uuid(ack.nonce, "Nonce do ACK");
  entityId(ack.terminalId, "Terminal");
  entityId(ack.deviceId, "Dispositivo");
  positiveSequence(ack.sequence);
}

function validateAckError(state: PosDeviceAckState, code?: string, message?: string) {
  if (state === "failed") {
    if (!code || !message) throw new PosDomainError("ACK de falha sem código e mensagem.");
    reference(code, "Código de erro do ACK", 80);
    boundedText(message, "Mensagem de erro do ACK", 1, 500);
  } else if (code || message) throw new PosDomainError("ACK sem falha não pode conter erro.");
}

function cloneCanonical<T>(value: T): T {
  return JSON.parse(canonicalPosJson(value)) as T;
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
}

function assertPlainRecord(value: unknown, label: string): asserts value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value) || (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null)) throw new PosDomainError(`${label} deve ser um objeto simples.`);
  if (Object.getOwnPropertySymbols(value).length || Object.values(Object.getOwnPropertyDescriptors(value)).some((descriptor) => descriptor.get || descriptor.set)) throw new PosDomainError(`${label} não pode conter acessores ou chaves Symbol.`);
}

function assertOnlyKeys(value: Record<string, unknown>, allowed: ReadonlySet<string>, label: string) {
  for (const key of Object.getOwnPropertyNames(value)) if (!allowed.has(key)) throw new PosDomainError(`${label} contém campo inesperado: ${key}.`);
}

function providerKey(value: string) {
  if (typeof value !== "string") throw new PosDomainError("Identificador do provedor inválido.");
  const result = value.trim().toLowerCase();
  if (!/^[a-z0-9][a-z0-9._-]{1,79}$/.test(result)) throw new PosDomainError("Identificador do provedor inválido.");
  return result;
}

function reference(value: string, label: string, maxBytes = 160) {
  if (typeof value !== "string") throw new PosDomainError(`${label} inválida.`);
  const result = value.trim();
  if (!result || Buffer.byteLength(result, "utf8") > maxBytes || /[\u0000-\u001f]/.test(result)) throw new PosDomainError(`${label} inválida.`);
  return result;
}

function optionalReference(value: string | null | undefined, label: string, maxBytes = 160) {
  if (value != null) reference(value, label, maxBytes);
}

function boundedText(value: string, label: string, minBytes: number, maxBytes: number) {
  if (typeof value !== "string") throw new PosDomainError(`${label} inválida.`);
  const result = value.trim();
  const size = Buffer.byteLength(result, "utf8");
  if (size < minBytes || size > maxBytes || /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(result)) throw new PosDomainError(`${label} inválida.`);
  return result;
}

function idempotencyKey(value: string) {
  const result = reference(value, "Chave idempotente", 100);
  if (Buffer.byteLength(result, "utf8") < 8) throw new PosDomainError("Chave idempotente inválida.");
  return result;
}

function entityId(value: string, label: string) {
  if (typeof value !== "string") throw new PosDomainError(`${label} inválido.`);
  const result = value.trim();
  if (!/^c[a-z0-9]{8,63}$/.test(result)) throw new PosDomainError(`${label} inválido.`);
  return result;
}

function positiveId(value: number, label: string) {
  if (!Number.isSafeInteger(value) || value <= 0) throw new PosDomainError(`${label} inválido.`);
}

function positiveSequence(value: number) {
  if (!Number.isSafeInteger(value) || value <= 0) throw new PosDomainError("Sequência do comando inválida.");
}

function cents(value: number, label: string) {
  if (!Number.isSafeInteger(value) || value <= 0 || value > 2_147_483_647) throw new PosDomainError(`${label} inválido.`);
}

function nonNegativeCents(value: number, label: string) {
  if (!Number.isSafeInteger(value) || value < 0 || value > 2_147_483_647) throw new PosDomainError(`${label} inválido.`);
}

function validFutureDate(value: Date, message: string) {
  if (!(value instanceof Date)) throw new PosDomainError(message);
  const timestamp = Date.prototype.getTime.call(value);
  if (Number.isNaN(timestamp) || timestamp <= Date.now()) throw new PosDomainError(message);
}

function validOccurredAt(value: Date, message: string) {
  if (!(value instanceof Date)) throw new PosDomainError(message);
  const timestamp = Date.prototype.getTime.call(value);
  if (Number.isNaN(timestamp) || timestamp < Date.UTC(2000, 0, 1) || timestamp > Date.now() + MAX_CLOCK_SKEW_MS) throw new PosDomainError(message);
}

function validIsoDate(value: string, message: string) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)) throw new PosDomainError(message);
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp) || new Date(timestamp).toISOString() !== value) throw new PosDomainError(message);
  return timestamp;
}

function uuid(value: string, label: string) {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)) throw new PosDomainError(`${label} inválido.`);
}

function sha256(value: string) {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function safeHexEqual(left: string, right: string) {
  const leftBuffer = Buffer.from(left, "hex"), rightBuffer = Buffer.from(right, "hex");
  return leftBuffer.byteLength === rightBuffer.byteLength && timingSafeEqual(leftBuffer, rightBuffer);
}

function validBrazilianTaxId(value: string) {
  if (typeof value !== "string" || !/^[0-9./-]+$/.test(value)) return false;
  const digits = value.replace(/\D/g, "");
  if (!/^\d{11}(?:\d{3})?$/.test(digits) || /^(\d)\1+$/.test(digits)) return false;
  const check = (base: string, weights: number[]) => {
    const sum = base.split("").reduce((total, digit, index) => total + Number(digit) * weights[index], 0);
    const remainder = sum % 11;
    return remainder < 2 ? 0 : 11 - remainder;
  };
  if (digits.length === 11) return check(digits.slice(0, 9), [10, 9, 8, 7, 6, 5, 4, 3, 2]) === Number(digits[9]) && check(digits.slice(0, 10), [11, 10, 9, 8, 7, 6, 5, 4, 3, 2]) === Number(digits[10]);
  return check(digits.slice(0, 12), [5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2]) === Number(digits[12]) && check(digits.slice(0, 13), [6, 5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2]) === Number(digits[13]);
}

function validNfeAccessKey(value: string) {
  if (!/^\d{44}$/.test(value)) return false;
  const digits = value.slice(0, 43).split("").map(Number);
  let weight = 2, sum = 0;
  for (let index = digits.length - 1; index >= 0; index--) {
    sum += digits[index] * weight;
    weight = weight === 9 ? 2 : weight + 1;
  }
  const remainder = sum % 11;
  const checkDigit = remainder === 0 || remainder === 1 ? 0 : 11 - remainder;
  return checkDigit === Number(value[43]);
}
