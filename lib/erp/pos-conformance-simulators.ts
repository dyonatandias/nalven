import { createHash } from "node:crypto";
import { PosAgentError } from "@/lib/erp/pos-agent-auth";
import {
  advanceFiscalState,
  advancePaymentState,
  canonicalPosJson,
  createDeviceAck,
  fiscalSnapshotDigest,
  verifyDeviceAck,
  verifyDeviceCommand,
  type PosDeviceAck,
  type PosDeviceCommand,
  type PosFiscalAdapter,
  type PosFiscalResult,
  type PosFiscalSaleSnapshot,
  type PosFiscalState,
  type PosPaymentAdapter,
  type PosPaymentIntentInput,
  type PosPaymentMethod,
  type PosPaymentState,
  type PosPaymentTransaction,
  type PosSigningKey,
} from "@/lib/erp/pos-connectors";
import { PosDomainError } from "@/lib/erp/pos-domain";
import { hashPosPrintAck, replayPosPrintAck, type PosPrintAckInput, type PosPrintAckRecord } from "@/lib/erp/pos-print-ack";

export type SimulatorClock = () => Date;
export type PaymentCreateScenario = "success" | "decline" | "processing" | "unknown" | "timeout_after_capture";
export type FiscalIssueScenario = "authorize" | "reject" | "processing" | "unknown" | "timeout_after_authorize";

const DEFAULT_SIMULATOR_INSTANT = "2026-08-29T00:00:00.000Z";

type IdempotencyRecord = { operation: string; fingerprint: string; result: unknown };
type PaymentRecord = { reference: string; method: PosPaymentMethod; amountCents: number; state: PosPaymentState; refundedCents: number; occurredAt: Date };
type FiscalRecord = { reference: string; snapshotDigest: string; state: PosFiscalState; occurredAt: Date };

export const POS_LOCAL_CONFORMANCE_CAPABILITIES = Object.freeze({
  designation: "local-software-conformance-only",
  homologated: false,
  certificationStatus: "NOT_CERTIFIED",
  externalHomologationStatus: "NOT_PERFORMED",
  payment: ["success", "decline", "processing", "unknown", "timeout_after_capture", "status", "cancel", "partial_refund", "full_refund", "retry", "idempotency_collision", "duplicate_callback", "out_of_order_callback"],
  fiscal: ["authorize", "reject", "processing", "unknown", "timeout_after_authorize", "query", "cancel", "contingency", "danfe_artifact", "xml_artifact", "retry", "idempotency_collision"],
  agent: ["signed_command", "signed_ack", "tamper_rejection", "command_replay_rejection", "device_offline", "print_claim", "claim_lease", "ack_retry", "ack_tamper_rejection"],
  prohibited: ["credentials", "PAN", "CVV", "PIN", "track_data", "provider_network", "SEFAZ_network", "real_hardware"],
  gaps: [
    "PSP/eventos/credenciais reais não são exercitados; HMAC e persistência transacional são validados em suítes separadas",
    "XML, certificado, schema oficial, transmissão SEFAZ e regras por UF não são simulados",
    "binário do agente, drivers ESC/POS/TEF, USB/serial/rede e firmware não são exercitados",
    "sucesso local não substitui homologação, laboratório físico, conciliação ou piloto",
  ],
});

export class DeterministicPaymentSimulator implements PosPaymentAdapter {
  readonly provider = "local-psp-simulator";
  readonly methods = ["pix", "credit", "debit", "voucher"] as const;
  readonly effects = { create: 0, cancel: 0, refund: 0, callback: 0 };
  readonly #clock: SimulatorClock;
  readonly #createScenarios: Readonly<Record<string, PaymentCreateScenario>>;
  readonly #idempotency = new Map<string, IdempotencyRecord>();
  readonly #payments = new Map<string, PaymentRecord>();
  readonly #callbacks = new Map<string, { fingerprint: string; state: PosPaymentState }>();

  constructor(options: { clock?: SimulatorClock; createScenarios?: Readonly<Record<string, PaymentCreateScenario>> } = {}) {
    this.#clock = options.clock ?? defaultSimulatorClock;
    this.#createScenarios = Object.freeze({ ...(options.createScenarios || {}) });
  }

  referenceFor(idempotencyKey: string) {
    return `pay-${digest(idempotencyKey).slice(0, 24)}`;
  }

  async createIntent(input: Readonly<PosPaymentIntentInput>): Promise<PosPaymentTransaction> {
    const fingerprint = canonicalPosJson({ ...input, expiresAt: input.expiresAt });
    const scenario = this.#createScenarios[input.idempotencyKey] || "success";
    const transaction = this.#once(input.idempotencyKey, "payment.create", fingerprint, () => {
      this.effects.create += 1;
      const reference = this.referenceFor(input.idempotencyKey);
      const state: PosPaymentState = scenario === "decline" ? "declined" : scenario === "processing" ? "processing" : scenario === "unknown" ? "unknown" : "captured";
      const record: PaymentRecord = { reference, method: input.method, amountCents: input.amountCents, state, refundedCents: 0, occurredAt: this.#now() };
      this.#payments.set(reference, record);
      return paymentTransaction(this.provider, record);
    });
    if (scenario === "timeout_after_capture") return never();
    return clonePayment(transaction);
  }

  async status(reference: string) {
    return paymentTransaction(this.provider, this.#payment(reference));
  }

  async cancel(reference: string, idempotencyKey: string) {
    const fingerprint = canonicalPosJson({ reference });
    return clonePayment(this.#once(idempotencyKey, "payment.cancel", fingerprint, () => {
      const record = this.#payment(reference);
      advancePaymentState(record.state, "cancelled");
      record.state = "cancelled";
      record.occurredAt = this.#now();
      this.effects.cancel += 1;
      return paymentTransaction(this.provider, record);
    }));
  }

  async refund(reference: string, amountCents: number, idempotencyKey: string) {
    const fingerprint = canonicalPosJson({ reference, amountCents });
    return clonePayment(this.#once(idempotencyKey, "payment.refund", fingerprint, () => {
      const record = this.#payment(reference);
      if (!Number.isSafeInteger(amountCents) || amountCents <= 0 || record.refundedCents + amountCents > record.amountCents) throw new PosDomainError("Estorno simulado excede o saldo capturado.");
      const next = record.refundedCents + amountCents === record.amountCents ? "refunded" : "partially_refunded";
      advancePaymentState(record.state, next);
      record.refundedCents += amountCents;
      record.state = next;
      record.occurredAt = this.#now();
      this.effects.refund += 1;
      return paymentTransaction(this.provider, { ...record, amountCents });
    }));
  }

  acceptCallback(input: { eventId: string; reference: string; state: "authorized" | "captured" | "declined" | "unknown" | "manual_review"; occurredAt: Date }) {
    const fingerprint = canonicalPosJson(input);
    const existing = this.#callbacks.get(input.eventId);
    if (existing) {
      if (existing.fingerprint !== fingerprint) throw new PosDomainError("Callback simulado reutilizou o ID com outro conteúdo.");
      return { accepted: false as const, duplicate: true as const, state: existing.state };
    }
    const record = this.#payment(input.reference);
    advancePaymentState(record.state, input.state);
    record.state = input.state;
    record.occurredAt = new Date(input.occurredAt);
    this.#callbacks.set(input.eventId, { fingerprint, state: record.state });
    this.effects.callback += 1;
    return { accepted: true as const, duplicate: false as const, state: record.state };
  }

  #payment(reference: string) {
    const record = this.#payments.get(reference);
    if (!record) throw new PosDomainError("Pagamento simulado não encontrado.");
    return record;
  }

  #once<T>(key: string, operation: string, fingerprint: string, apply: () => T): T {
    const existing = this.#idempotency.get(key);
    if (existing) {
      if (existing.operation !== operation || existing.fingerprint !== fingerprint) throw new PosDomainError("Chave idempotente simulada reutilizada com outro contexto.");
      return existing.result as T;
    }
    const result = apply();
    this.#idempotency.set(key, { operation, fingerprint, result });
    return result;
  }

  #now() {
    const value = this.#clock();
    if (!(value instanceof Date) || Number.isNaN(value.valueOf())) throw new PosDomainError("Relógio do simulador PSP inválido.");
    return new Date(value);
  }
}

export class DeterministicFiscalSimulator implements PosFiscalAdapter {
  readonly provider = "local-fiscal-simulator";
  readonly effects = { issue: 0, cancel: 0, contingency: 0 };
  readonly #clock: SimulatorClock;
  readonly #issueScenarios: Readonly<Record<string, FiscalIssueScenario>>;
  readonly #idempotency = new Map<string, IdempotencyRecord>();
  readonly #documents = new Map<string, FiscalRecord>();

  constructor(options: { clock?: SimulatorClock; issueScenarios?: Readonly<Record<string, FiscalIssueScenario>> } = {}) {
    this.#clock = options.clock ?? defaultSimulatorClock;
    this.#issueScenarios = Object.freeze({ ...(options.issueScenarios || {}) });
  }

  referenceFor(idempotencyKey: string) {
    return `fiscal-${digest(idempotencyKey).slice(0, 24)}`;
  }

  async validateSale() {
    return undefined;
  }

  async issue(snapshot: Readonly<PosFiscalSaleSnapshot>, profileVersion: string, idempotencyKey: string): Promise<PosFiscalResult> {
    const snapshotDigest = fiscalSnapshotDigest(snapshot as PosFiscalSaleSnapshot);
    const scenario = this.#issueScenarios[idempotencyKey] || "authorize";
    const result = this.#once(idempotencyKey, "fiscal.issue", canonicalPosJson({ snapshotDigest, profileVersion }), () => {
      this.effects.issue += 1;
      const state: PosFiscalState = scenario === "reject" ? "rejected" : scenario === "processing" ? "processing" : scenario === "unknown" ? "unknown" : "authorized";
      const record: FiscalRecord = { reference: this.referenceFor(idempotencyKey), snapshotDigest, state, occurredAt: this.#now() };
      this.#documents.set(record.reference, record);
      return fiscalResult(this.provider, record);
    });
    if (scenario === "timeout_after_authorize") return never();
    return cloneFiscal(result);
  }

  async status(reference: string) {
    return fiscalResult(this.provider, this.#document(reference));
  }

  async cancel(reference: string, reason: string, idempotencyKey: string) {
    return cloneFiscal(this.#once(idempotencyKey, "fiscal.cancel", canonicalPosJson({ reference, reason }), () => {
      const record = this.#document(reference);
      advanceFiscalState(record.state, "cancelled");
      record.state = "cancelled";
      record.occurredAt = this.#now();
      this.effects.cancel += 1;
      return fiscalResult(this.provider, record);
    }));
  }

  async contingency(snapshot: Readonly<PosFiscalSaleSnapshot>, profileVersion: string, reason: string, idempotencyKey: string) {
    const snapshotDigest = fiscalSnapshotDigest(snapshot as PosFiscalSaleSnapshot);
    return cloneFiscal(this.#once(idempotencyKey, "fiscal.contingency", canonicalPosJson({ snapshotDigest, profileVersion, reason }), () => {
      const record: FiscalRecord = { reference: this.referenceFor(idempotencyKey), snapshotDigest, state: "contingency", occurredAt: this.#now() };
      this.#documents.set(record.reference, record);
      this.effects.contingency += 1;
      return fiscalResult(this.provider, record);
    }));
  }

  async renderDanfe(reference: string) {
    this.#document(reference);
    return { artifactId: `danfe-${digest(reference).slice(0, 24)}` };
  }

  async downloadXml(reference: string) {
    this.#document(reference);
    return { artifactId: `xml-${digest(reference).slice(0, 24)}` };
  }

  #document(reference: string) {
    const record = this.#documents.get(reference);
    if (!record) throw new PosDomainError("Documento fiscal simulado não encontrado.");
    return record;
  }

  #once<T>(key: string, operation: string, fingerprint: string, apply: () => T): T {
    const existing = this.#idempotency.get(key);
    if (existing) {
      if (existing.operation !== operation || existing.fingerprint !== fingerprint) throw new PosDomainError("Chave idempotente fiscal simulada reutilizada com outro contexto.");
      return existing.result as T;
    }
    const result = apply();
    this.#idempotency.set(key, { operation, fingerprint, result });
    return result;
  }

  #now() {
    const value = this.#clock();
    if (!(value instanceof Date) || Number.isNaN(value.valueOf())) throw new PosDomainError("Relógio do simulador fiscal inválido.");
    return new Date(value);
  }
}

export class DeterministicDeviceAgentSimulator {
  readonly #terminalId: string;
  readonly #signingKey: PosSigningKey;
  readonly #clock: SimulatorClock;
  readonly #deviceStatus = new Map<string, "online" | "offline" | "error">();
  readonly #seenCommandNonces = new Set<string>();
  readonly #seenAckNonces = new Set<string>();
  #lastSequence = 0;
  #ackCounter = 0;

  constructor(input: { terminalId: string; signingKey: PosSigningKey; clock?: SimulatorClock; devices: Readonly<Record<string, "online" | "offline" | "error">> }) {
    this.#terminalId = input.terminalId;
    this.#signingKey = input.signingKey;
    this.#clock = input.clock ?? defaultSimulatorClock;
    for (const [id, status] of Object.entries(input.devices)) this.#deviceStatus.set(id, status);
  }

  execute(command: PosDeviceCommand): PosDeviceAck {
    const now = this.#now();
    verifyDeviceCommand(command, this.#signingKey, { now, lastSequence: this.#lastSequence, seenNonces: this.#seenCommandNonces });
    if (command.terminalId !== this.#terminalId) throw new PosDomainError("Comando pertence a outro terminal simulado.");
    const status = this.#deviceStatus.get(command.deviceId);
    if (!status) throw new PosDomainError("Dispositivo simulado não encontrado.");
    this.#lastSequence = command.sequence;
    this.#seenCommandNonces.add(command.nonce);
    const seed = `${command.digest}:${++this.#ackCounter}`;
    const input = status === "online" ? { state: "completed" as const } : { state: "failed" as const, errorCode: status === "offline" ? "device_offline" : "device_error", errorMessage: status === "offline" ? "Dispositivo indisponível no simulador local." : "Dispositivo reportou erro no simulador local." };
    const ack = createDeviceAck(command, input, this.#signingKey, now, { ackId: deterministicUuid(`${seed}:ack`), nonce: deterministicUuid(`${seed}:nonce`) });
    verifyDeviceAck(ack, command, this.#signingKey, { now, seenNonces: this.#seenAckNonces });
    this.#seenAckNonces.add(ack.nonce);
    return ack;
  }

  setDeviceStatus(deviceId: string, status: "online" | "offline" | "error") {
    if (!this.#deviceStatus.has(deviceId)) throw new PosDomainError("Dispositivo simulado não encontrado.");
    this.#deviceStatus.set(deviceId, status);
  }

  #now() {
    const value = this.#clock();
    if (!(value instanceof Date) || Number.isNaN(value.valueOf())) throw new PosDomainError("Relógio do agente simulado inválido.");
    return new Date(value);
  }
}

type SimulatedPrintJob = { id: string; terminalId: string; status: "queued" | "processing" | "printed" | "failed"; attempts: number; claimId: string | null; claimExpiresAt: Date | null; error: string | null };

export class DeterministicPrintClaimSimulator {
  readonly #clock: SimulatorClock;
  readonly #jobs = new Map<string, SimulatedPrintJob>();
  readonly #acknowledgements = new Map<string, PosPrintAckRecord>();
  readonly #offlineTerminals = new Set<string>();

  constructor(clock: SimulatorClock = defaultSimulatorClock) {
    this.#clock = clock;
  }

  enqueue(terminalId: string, jobId: string) {
    if (this.#jobs.has(jobId)) throw new PosAgentError("Job simulado duplicado.", 409);
    this.#jobs.set(jobId, { id: jobId, terminalId, status: "queued", attempts: 0, claimId: null, claimExpiresAt: null, error: null });
  }

  setTerminalOffline(terminalId: string, offline = true) {
    if (offline) this.#offlineTerminals.add(terminalId); else this.#offlineTerminals.delete(terminalId);
  }

  pull(terminalId: string, limit = 10) {
    if (this.#offlineTerminals.has(terminalId)) throw new PosAgentError("Terminal simulado offline.", 409);
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 20) throw new PosAgentError("Limite de claim simulado inválido.");
    const now = this.#now();
    for (const job of this.#jobs.values()) {
      if (job.terminalId === terminalId && job.status === "processing" && job.claimExpiresAt && job.claimExpiresAt < now && job.attempts >= 5) {
        Object.assign(job, { status: "failed", claimId: null, claimExpiresAt: null, error: "claim_attempts_exhausted" });
      }
    }
    return [...this.#jobs.values()].filter(job => job.terminalId === terminalId && job.attempts < 5 && (job.status === "queued" || job.status === "processing" && job.claimExpiresAt && job.claimExpiresAt < now)).sort((left, right) => left.id.localeCompare(right.id)).slice(0, limit).map(job => {
      job.attempts += 1;
      job.status = "processing";
      job.claimId = deterministicUuid(`${job.id}:claim:${job.attempts}`);
      job.claimExpiresAt = new Date(now.valueOf() + 2 * 60_000);
      job.error = null;
      return { id: job.id, claimId: job.claimId, attempt: job.attempts, claimExpiresAt: new Date(job.claimExpiresAt) };
    });
  }

  acknowledge(input: PosPrintAckInput) {
    const existing = this.#acknowledgements.get(input.claimId);
    if (existing) return replayPosPrintAck(existing, input);
    const job = this.#jobs.get(input.jobId);
    if (!job || job.terminalId !== input.terminalId || job.status !== "processing" || job.claimId !== input.claimId) throw new PosAgentError("ACK simulado inválido, expirado ou já processado.", 409);
    if (input.state === "failed" && !input.error) throw new PosAgentError("ACK simulado com falha exige erro.");
    if (input.state === "printed" && input.error) throw new PosAgentError("ACK simulado impresso não aceita erro.");
    job.status = input.state === "printed" ? "printed" : job.attempts >= 5 ? "failed" : "queued";
    job.error = input.state === "failed" ? input.error : null;
    job.claimId = null;
    job.claimExpiresAt = null;
    const record = { terminalId: input.terminalId, jobId: input.jobId, claimId: input.claimId, requestHash: hashPosPrintAck(input), resultStatus: job.status };
    this.#acknowledgements.set(input.claimId, record);
    return { id: job.id, status: job.status, replayed: false as const };
  }

  job(jobId: string) {
    const job = this.#jobs.get(jobId);
    if (!job) throw new PosAgentError("Job simulado não encontrado.", 404);
    return { ...job, claimExpiresAt: job.claimExpiresAt ? new Date(job.claimExpiresAt) : null };
  }

  #now() {
    const value = this.#clock();
    if (!(value instanceof Date) || Number.isNaN(value.valueOf())) throw new PosAgentError("Relógio do claim simulado inválido.");
    return new Date(value);
  }
}

function paymentTransaction(provider: string, record: PaymentRecord): PosPaymentTransaction {
  const base: PosPaymentTransaction = { provider, reference: record.reference, state: record.state, amountCents: record.amountCents, currency: "BRL", occurredAt: new Date(record.occurredAt) };
  if (["authorized", "captured"].includes(record.state)) {
    if (record.method === "pix") return { ...base, transactionId: `tx-${digest(record.reference).slice(0, 20)}`, endToEndId: `E1234567820260829${digest(record.reference).slice(0, 15).toUpperCase()}`, evidenceId: `evidence-${digest(record.reference).slice(0, 20)}` };
    return { ...base, transactionId: `tx-${digest(record.reference).slice(0, 20)}`, nsu: digest(`${record.reference}:nsu`).slice(0, 12), authorizationCode: digest(`${record.reference}:authorization`).slice(0, 12).toUpperCase(), brand: "SIMULATED", lastFour: "1111", evidenceId: `evidence-${digest(record.reference).slice(0, 20)}` };
  }
  if (record.state === "declined") return { ...base, failureCode: "simulated_decline", failureMessage: "Transação recusada pelo cenário local." };
  return base;
}

function fiscalResult(provider: string, record: FiscalRecord): PosFiscalResult {
  const base: PosFiscalResult = { provider, reference: record.reference, state: record.state, occurredAt: new Date(record.occurredAt) };
  if (record.state === "authorized") return { ...base, accessKey: nfeAccessKey(record.snapshotDigest), protocol: `protocol-${record.snapshotDigest.slice(0, 20)}`, xmlArtifactId: `xml-${record.snapshotDigest.slice(0, 24)}`, danfeArtifactId: `danfe-${record.snapshotDigest.slice(0, 24)}` };
  if (record.state === "rejected") return { ...base, rejectionCode: "SIM001", rejectionMessage: "Rejeição determinística do simulador local." };
  if (record.state === "contingency") return { ...base, xmlArtifactId: `xml-contingency-${record.snapshotDigest.slice(0, 20)}` };
  if (record.state === "cancelled") return { ...base, protocol: `cancel-${record.snapshotDigest.slice(0, 20)}` };
  return base;
}

function nfeAccessKey(seed: string) {
  const base = (`35${seed.replace(/[a-f]/g, value => String(value.charCodeAt(0) % 10))}${"0".repeat(43)}`).slice(0, 43);
  let weight = 2, sum = 0;
  for (let index = base.length - 1; index >= 0; index--) {
    sum += Number(base[index]) * weight;
    weight = weight === 9 ? 2 : weight + 1;
  }
  const remainder = sum % 11;
  return `${base}${remainder === 0 || remainder === 1 ? 0 : 11 - remainder}`;
}

function deterministicUuid(seed: string) {
  const value = digest(seed).slice(0, 32).split("");
  value[12] = "4";
  value[16] = "8";
  const hex = value.join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function clonePayment(value: PosPaymentTransaction): PosPaymentTransaction {
  return { ...value, occurredAt: new Date(value.occurredAt) };
}

function cloneFiscal(value: PosFiscalResult): PosFiscalResult {
  return { ...value, occurredAt: new Date(value.occurredAt) };
}

function digest(value: string) {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function never<T>(): Promise<T> {
  return new Promise<T>(() => undefined);
}

function defaultSimulatorClock() {
  return new Date(DEFAULT_SIMULATOR_INSTANT);
}
