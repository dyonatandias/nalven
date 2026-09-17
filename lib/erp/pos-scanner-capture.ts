export const POS_SCANNER_PROCESSOR_REJECTION_REASONS = [
  "not_found",
  "invalid_code",
  "unsupported_format",
  "not_sellable",
  "stock_unavailable",
  "processor_error",
] as const;

export type PosScannerProcessorRejectionReason = typeof POS_SCANNER_PROCESSOR_REJECTION_REASONS[number];

export type PosScannerCaptureReasonCode =
  | "resolved"
  | "operation_active"
  | "protected_target"
  | "capture_timeout"
  | "capture_too_short"
  | "capture_too_long"
  | "invalid_key"
  | "queue_full"
  | "duplicate_terminator"
  | "duplicate_delivery"
  | PosScannerProcessorRejectionReason;

export type PosScannerCaptureResult = Readonly<{
  captureId: string;
  status: "accepted" | "rejected" | "duplicate";
  reasonCode: PosScannerCaptureReasonCode;
  atMs: number;
}>;

export type PosScannerCaptureTarget = Readonly<{
  tagName?: string | null;
  contentEditable?: boolean;
  purpose?: "scanner" | "ordinary" | "financial" | "credential";
}>;

export type PosScannerCaptureContext = Readonly<{
  operationActive: boolean;
  /**
   * True only while an adapter can positively identify every offered key as
   * scanner input (for example a focused/read-only capture surface or an
   * agent/driver session). Generic unprefixed keyboard input must use false.
   */
  wedgeSessionActive: boolean;
  target?: PosScannerCaptureTarget | null;
}>;

export type PosScannerCaptureConfiguration = Readonly<{
  prefixKeys: readonly string[];
  suffixKeys: readonly string[];
  interKeyTimeoutMs: number;
  duplicateWindowMs: number;
  minimumLength: number;
  maximumLength: number;
  queueLimit: number;
  resultLimit: number;
}>;

export const DEFAULT_POS_SCANNER_CAPTURE_CONFIGURATION: PosScannerCaptureConfiguration = Object.freeze({
  prefixKeys: Object.freeze([]),
  suffixKeys: Object.freeze(["Enter"]),
  interKeyTimeoutMs: 120,
  duplicateWindowMs: 250,
  minimumLength: 3,
  maximumLength: 512,
  queueLimit: 32,
  resultLimit: 64,
});

export type PosScannerFeedInput = Readonly<{
  key: string;
  atMs: number;
  context: PosScannerCaptureContext;
}>;

export type PosScannerFeedOutcome = Readonly<{
  disposition: "ignored" | "unidentified" | "blocked" | "prefix" | "capturing" | "queued" | "rejected" | "duplicate";
  consumed: boolean;
  /** Whether the key was positively attributed to a scanner frame. */
  sourceIdentified: boolean;
  blockReason?: "operation_active" | "protected_target";
  captureId?: string;
  immediateResults: readonly PosScannerCaptureResult[];
  queueDepth: number;
}>;

export type PosScannerOfferInput = Readonly<{
  code: string;
  atMs: number;
  context: PosScannerCaptureContext;
  captureId?: string;
  deliveryId?: string;
}>;

export type PosScannerOfferOutcome = Readonly<{
  captureId: string;
  queued: boolean;
  result: PosScannerCaptureResult | null;
  queueDepth: number;
}>;

/** Trusted processing DTO. Raw scan data is deliberately absent from public results and snapshots. */
export type PosScannerQueuedCapture = Readonly<{
  captureId: string;
  code: string;
  enqueuedAtMs: number;
}>;

export type PosScannerProcessingDecision =
  | Readonly<{ accepted: true }>
  | Readonly<{ accepted: false; reasonCode: PosScannerProcessorRejectionReason }>;

type ActiveCapture = {
  captureId: string;
  payloadKeys: string[];
  payloadLength: number;
  pendingSuffixKeys: string[];
  lastAtMs: number;
  blockedReason: "operation_active" | "protected_target" | null;
};

const PROCESSOR_REJECTION_REASONS = new Set<string>(POS_SCANNER_PROCESSOR_REJECTION_REASONS);
const PROTECTED_TAGS = new Set(["INPUT", "TEXTAREA", "SELECT"]);

export function createPosScannerCaptureConfiguration(
  overrides: Partial<PosScannerCaptureConfiguration> = {},
): PosScannerCaptureConfiguration {
  const configuration = {
    ...DEFAULT_POS_SCANNER_CAPTURE_CONFIGURATION,
    ...overrides,
    prefixKeys: [...(overrides.prefixKeys ?? DEFAULT_POS_SCANNER_CAPTURE_CONFIGURATION.prefixKeys)],
    suffixKeys: [...(overrides.suffixKeys ?? DEFAULT_POS_SCANNER_CAPTURE_CONFIGURATION.suffixKeys)],
  };
  validateKeySequence(configuration.prefixKeys, "prefixo", true, 8);
  validateKeySequence(configuration.suffixKeys, "sufixo", false, 4);
  positiveInteger(configuration.interKeyTimeoutMs, "timeout entre teclas", 10_000);
  nonNegativeInteger(configuration.duplicateWindowMs, "janela de duplicidade", 10_000);
  positiveInteger(configuration.minimumLength, "tamanho mínimo", 4_096);
  positiveInteger(configuration.maximumLength, "tamanho máximo", 4_096);
  if (configuration.minimumLength > configuration.maximumLength) throw new Error("O tamanho mínimo da leitura não pode superar o máximo.");
  positiveInteger(configuration.queueLimit, "limite da fila", 1_024);
  positiveInteger(configuration.resultLimit, "limite de resultados", 4_096);
  return Object.freeze({
    ...configuration,
    prefixKeys: Object.freeze(configuration.prefixKeys),
    suffixKeys: Object.freeze(configuration.suffixKeys),
  });
}

/**
 * Classifies active operations and editable targets as blocked. Actual wedge
 * protection additionally requires source identity; see
 * posScannerWedgeProtectionAvailable.
 */
export function posScannerWedgeBlockReason(
  context: PosScannerCaptureContext,
): "operation_active" | "protected_target" | null {
  if (context.operationActive) return "operation_active";
  const target = context.target;
  if (!target) return null;
  if (target.contentEditable) return "protected_target";
  if (target.purpose === "financial" || target.purpose === "credential") return "protected_target";
  const tagName = target.tagName?.trim().toUpperCase() || "";
  if (PROTECTED_TAGS.has(tagName) && target.purpose !== "scanner") return "protected_target";
  return null;
}

/**
 * A generic HID keyboard without a prefix is indistinguishable from human
 * typing. In that mode an adapter must provide an explicit identified session
 * or a dedicated scanner surface; otherwise it cannot promise input safety.
 */
export function posScannerWedgeProtectionAvailable(
  configuration: Pick<PosScannerCaptureConfiguration, "prefixKeys">,
  context: PosScannerCaptureContext,
) {
  return configuration.prefixKeys.length > 0 || context.wedgeSessionActive || context.target?.purpose === "scanner";
}

export function assertPosScannerWedgeProtectionAvailable(
  configuration: Pick<PosScannerCaptureConfiguration, "prefixKeys">,
  context: PosScannerCaptureContext,
) {
  if (!posScannerWedgeProtectionAvailable(configuration, context)) {
    throw new Error("HID wedge sem prefixo exige sessão identificada, campo dedicado/read-only ou agente de scanner.");
  }
}

/**
 * Browser-independent scanner state machine. Callers supply normalized keys,
 * monotonic timestamps and target metadata. No content/time heuristic dedupes
 * equal barcodes: two equal readings with distinct capture/delivery IDs remain
 * two legitimate queue entries.
 */
export class PosScannerCaptureCore {
  readonly configuration: PosScannerCaptureConfiguration;
  private readonly namespace: string;
  private readonly pending: PosScannerQueuedCapture[] = [];
  private readonly inFlight = new Set<string>();
  private readonly resultHistory: PosScannerCaptureResult[] = [];
  private readonly recentCaptureIds = new Map<string, number>();
  private readonly recentDeliveryIds = new Map<string, number>();
  private sequence = 0;
  private prefixProgress = 0;
  private prefixLastAtMs: number | null = null;
  private active: ActiveCapture | null = null;
  private discardingUntilSuffix = false;
  private discardSuffixProgress = 0;
  private discardLastAtMs: number | null = null;
  private lastTerminatorAtMs: number | null = null;
  private draining = false;

  constructor(
    configuration: PosScannerCaptureConfiguration = DEFAULT_POS_SCANNER_CAPTURE_CONFIGURATION,
    captureIdNamespace = "scanner",
  ) {
    this.configuration = createPosScannerCaptureConfiguration(configuration);
    this.namespace = identifier(captureIdNamespace, "Namespace da captura", 64);
  }

  get queueDepth() {
    return this.pending.length;
  }

  get resultCount() {
    return this.resultHistory.length;
  }

  pendingSnapshot(): readonly Readonly<{ captureId: string; enqueuedAtMs: number }>[] {
    return this.pending.map(item => Object.freeze({ captureId: item.captureId, enqueuedAtMs: item.enqueuedAtMs }));
  }

  resultsSnapshot(): readonly PosScannerCaptureResult[] {
    return [...this.resultHistory];
  }

  feed(input: PosScannerFeedInput): PosScannerFeedOutcome {
    timestamp(input.atMs);
    const immediateResults: PosScannerCaptureResult[] = [];
    const blockReason = posScannerWedgeBlockReason(input.context);

    if (this.discardingUntilSuffix) {
      if (this.discardLastAtMs != null && input.atMs - this.discardLastAtMs > this.configuration.interKeyTimeoutMs) this.resetDiscard();
      else {
        this.discardLastAtMs = input.atMs;
        this.consumeDiscardedKey(input.key);
        return this.feedOutcome("rejected", true, true, immediateResults, undefined, blockReason ?? undefined);
      }
    }

    if (this.active && input.atMs - this.active.lastAtMs > this.configuration.interKeyTimeoutMs) {
      immediateResults.push(this.rejectActive(this.active.blockedReason ?? "capture_timeout", input.atMs));
    }
    if (this.prefixProgress && this.prefixLastAtMs != null && input.atMs - this.prefixLastAtMs > this.configuration.interKeyTimeoutMs) this.resetPrefix();

    if (this.active) {
      if (blockReason) this.markActiveBlocked(blockReason);
      const activeBlockReason = this.active.blockedReason;
      const activeResult = this.consumeActiveKey(input.key, input.atMs);
      if (activeResult.result) immediateResults.push(activeResult.result);
      return this.feedOutcome(activeResult.disposition, true, true, immediateResults, activeResult.captureId, activeBlockReason ?? undefined);
    }

    const duplicate = this.repeatedStandaloneTerminator(input.key, input.atMs);
    if (duplicate) {
      immediateResults.push(duplicate);
      return this.feedOutcome("duplicate", true, true, immediateResults, duplicate.captureId, blockReason ?? undefined);
    }

    // An explicit session has already identified this key as scanner input. A
    // dedicated scanner surface may do the same when no prefix protocol is in
    // use; with a prefix, an editable hybrid/manual field remains untouched
    // until that prefix is actually recognized.
    if (input.context.wedgeSessionActive || !this.configuration.prefixKeys.length && input.context.target?.purpose === "scanner") {
      this.resetPrefix();
      this.active = this.newActive(input.atMs, blockReason);
      const activeResult = this.consumeActiveKey(input.key, input.atMs);
      if (activeResult.result) immediateResults.push(activeResult.result);
      return this.feedOutcome(activeResult.disposition, true, true, immediateResults, activeResult.captureId, blockReason ?? undefined);
    }

    // A configured prefix is the only safe way to recognize a generic HID
    // source over an arbitrary focused element. Matching prefix keys and the
    // remainder of that frame are consumed, including over protected targets.
    if (this.configuration.prefixKeys.length) {
      const prefix = this.consumePrefix(input.key, input.atMs);
      if (!prefix.complete) {
        const disposition = prefix.consumed ? "prefix" : blockReason ? "unidentified" : "ignored";
        return this.feedOutcome(disposition, prefix.consumed, prefix.consumed, immediateResults, undefined, blockReason ?? undefined);
      }
      this.active = this.newActive(input.atMs, blockReason);
      return this.feedOutcome("capturing", true, true, immediateResults, this.active.captureId, blockReason ?? undefined);
    }

    // No prefix and no explicit source identity: the key may be human input.
    // The core deliberately does not consume it or claim wedge protection.
    return this.feedOutcome("unidentified", false, false, immediateResults, undefined, blockReason ?? undefined);
  }

  offerCode(input: PosScannerOfferInput): PosScannerOfferOutcome {
    timestamp(input.atMs);
    const captureId = input.captureId ? identifier(input.captureId, "ID da captura", 160) : this.nextCaptureId();
    const blockReason = posScannerWedgeBlockReason(input.context);
    if (blockReason) return this.offerRejected(captureId, blockReason, input.atMs);

    this.pruneRecent(input.atMs);
    const deliveryId = input.deliveryId ? identifier(input.deliveryId, "ID da entrega física", 160) : null;
    if (this.isKnownCapture(captureId, input.atMs) || deliveryId && this.isRecent(this.recentDeliveryIds.get(deliveryId), input.atMs)) {
      const result = this.recordResult(captureId, "duplicate", "duplicate_delivery", input.atMs);
      return Object.freeze({ captureId, queued: false, result, queueDepth: this.queueDepth });
    }

    const code = input.code.trim();
    const length = Array.from(code).length;
    if (length < this.configuration.minimumLength) return this.offerRejected(captureId, "capture_too_short", input.atMs);
    if (length > this.configuration.maximumLength) return this.offerRejected(captureId, "capture_too_long", input.atMs);
    if (this.queueDepth >= this.configuration.queueLimit) return this.offerRejected(captureId, "queue_full", input.atMs);

    this.pending.push(Object.freeze({ captureId, code, enqueuedAtMs: input.atMs }));
    this.recentCaptureIds.set(captureId, input.atMs);
    if (deliveryId) this.recentDeliveryIds.set(deliveryId, input.atMs);
    return Object.freeze({ captureId, queued: true, result: null, queueDepth: this.queueDepth });
  }

  take(): PosScannerQueuedCapture | null {
    const item = this.pending.shift() ?? null;
    if (item) this.inFlight.add(item.captureId);
    return item;
  }

  settle(captureId: string, decision: PosScannerProcessingDecision, atMs: number): PosScannerCaptureResult {
    timestamp(atMs);
    const normalizedId = identifier(captureId, "ID da captura", 160);
    if (!this.inFlight.delete(normalizedId)) throw new Error("A captura não está em processamento.");
    if (decision.accepted) return this.recordResult(normalizedId, "accepted", "resolved", atMs);
    const reasonCode = PROCESSOR_REJECTION_REASONS.has(decision.reasonCode) ? decision.reasonCode : "processor_error";
    return this.recordResult(normalizedId, "rejected", reasonCode, atMs);
  }

  async drain(
    processor: (capture: PosScannerQueuedCapture) => Promise<PosScannerProcessingDecision>,
    settledAtMs: (capture: PosScannerQueuedCapture) => number,
  ): Promise<readonly PosScannerCaptureResult[]> {
    if (this.draining) throw new Error("A fila de scanner já está sendo processada.");
    this.draining = true;
    const completed: PosScannerCaptureResult[] = [];
    try {
      let capture = this.take();
      while (capture) {
        try {
          completed.push(this.settle(capture.captureId, await processor(capture), settledAtMs(capture)));
        } catch {
          if (this.inFlight.has(capture.captureId)) completed.push(this.settle(capture.captureId, { accepted: false, reasonCode: "processor_error" }, settledAtMs(capture)));
        }
        capture = this.take();
      }
      return completed;
    } finally {
      this.draining = false;
    }
  }

  private consumeActiveKey(key: string, atMs: number): { disposition: "capturing" | "queued" | "rejected"; captureId: string; result: PosScannerCaptureResult | null } {
    const active = this.active!;
    active.lastAtMs = atMs;
    const expectedSuffix = this.configuration.suffixKeys[active.pendingSuffixKeys.length];
    if (key === expectedSuffix) {
      active.pendingSuffixKeys.push(key);
      if (active.pendingSuffixKeys.length < this.configuration.suffixKeys.length) return { disposition: "capturing", captureId: active.captureId, result: null };
      return this.finalizeActive(atMs);
    }

    if (active.pendingSuffixKeys.length) {
      for (const pendingKey of active.pendingSuffixKeys) {
        const failure = this.appendPayloadKey(pendingKey, atMs);
        if (failure) return failure;
      }
      active.pendingSuffixKeys = [];
      if (key === this.configuration.suffixKeys[0]) {
        active.pendingSuffixKeys.push(key);
        return { disposition: "capturing", captureId: active.captureId, result: null };
      }
    }
    return this.appendPayloadKey(key, atMs) ?? { disposition: "capturing", captureId: active.captureId, result: null };
  }

  private appendPayloadKey(key: string, atMs: number): { disposition: "rejected"; captureId: string; result: PosScannerCaptureResult } | null {
    const active = this.active!;
    active.payloadLength += 1;
    if (!payloadKey(key)) {
      const captureId = active.captureId;
      const result = this.rejectActive(active.blockedReason ?? "invalid_key", atMs);
      this.startDiscard(atMs);
      return { disposition: "rejected", captureId, result };
    }
    if (!active.blockedReason) active.payloadKeys.push(key);
    if (active.payloadLength <= this.configuration.maximumLength) return null;
    const captureId = active.captureId;
    const result = this.rejectActive(active.blockedReason ?? "capture_too_long", atMs);
    this.startDiscard(atMs);
    return { disposition: "rejected", captureId, result };
  }

  private finalizeActive(atMs: number): { disposition: "queued" | "rejected"; captureId: string; result: PosScannerCaptureResult | null } {
    const active = this.active!;
    this.active = null;
    this.lastTerminatorAtMs = atMs;
    if (active.blockedReason) {
      const result = this.recordResult(active.captureId, "rejected", active.blockedReason, atMs);
      return { disposition: "rejected", captureId: active.captureId, result };
    }
    const offered = this.offerCode({
      captureId: active.captureId,
      code: active.payloadKeys.join(""),
      atMs,
      context: { operationActive: false, wedgeSessionActive: true },
    });
    return { disposition: offered.queued ? "queued" : "rejected", captureId: offered.captureId, result: offered.result };
  }

  private rejectActive(reasonCode: Extract<PosScannerCaptureReasonCode, "operation_active" | "protected_target" | "capture_timeout" | "capture_too_long" | "invalid_key">, atMs: number) {
    const captureId = this.active!.captureId;
    this.active = null;
    return this.recordResult(captureId, "rejected", reasonCode, atMs);
  }

  private repeatedStandaloneTerminator(key: string, atMs: number) {
    if (this.configuration.suffixKeys.length !== 1 || key !== this.configuration.suffixKeys[0] || this.lastTerminatorAtMs == null) return null;
    if (atMs - this.lastTerminatorAtMs < 0 || atMs - this.lastTerminatorAtMs > this.configuration.duplicateWindowMs) return null;
    return this.recordResult(this.nextCaptureId(), "duplicate", "duplicate_terminator", atMs);
  }

  private consumePrefix(key: string, atMs: number) {
    const expected = this.configuration.prefixKeys[this.prefixProgress];
    if (key === expected) {
      this.prefixProgress += 1;
      this.prefixLastAtMs = atMs;
      const complete = this.prefixProgress === this.configuration.prefixKeys.length;
      if (complete) this.resetPrefix();
      return { consumed: true, complete };
    }
    this.resetPrefix();
    if (key === this.configuration.prefixKeys[0]) {
      this.prefixProgress = 1;
      this.prefixLastAtMs = atMs;
      const complete = this.prefixProgress === this.configuration.prefixKeys.length;
      if (complete) this.resetPrefix();
      return { consumed: true, complete };
    }
    return { consumed: false, complete: false };
  }

  private consumeDiscardedKey(key: string) {
    if (key === this.configuration.suffixKeys[this.discardSuffixProgress]) {
      this.discardSuffixProgress += 1;
      if (this.discardSuffixProgress === this.configuration.suffixKeys.length) this.resetDiscard();
    } else this.discardSuffixProgress = key === this.configuration.suffixKeys[0] ? 1 : 0;
  }

  private startDiscard(atMs: number) {
    this.discardingUntilSuffix = true;
    this.discardSuffixProgress = 0;
    this.discardLastAtMs = atMs;
  }

  private resetDiscard() {
    this.discardingUntilSuffix = false;
    this.discardSuffixProgress = 0;
    this.discardLastAtMs = null;
  }

  private resetPrefix() {
    this.prefixProgress = 0;
    this.prefixLastAtMs = null;
  }

  private newActive(atMs: number, blockedReason: "operation_active" | "protected_target" | null): ActiveCapture {
    return { captureId: this.nextCaptureId(), payloadKeys: [], payloadLength: 0, pendingSuffixKeys: [], lastAtMs: atMs, blockedReason };
  }

  private markActiveBlocked(reason: "operation_active" | "protected_target") {
    const active = this.active!;
    active.blockedReason ??= reason;
    active.payloadKeys = [];
  }

  private nextCaptureId() {
    this.sequence += 1;
    return `${this.namespace}:${this.sequence}`;
  }

  private isKnownCapture(captureId: string, atMs: number) {
    if (this.inFlight.has(captureId) || this.pending.some(item => item.captureId === captureId)) return true;
    return this.isRecent(this.recentCaptureIds.get(captureId), atMs);
  }

  private isRecent(previousAtMs: number | undefined, atMs: number) {
    return previousAtMs != null && atMs - previousAtMs >= 0 && atMs - previousAtMs <= this.configuration.duplicateWindowMs;
  }

  private pruneRecent(atMs: number) {
    for (const [key, seenAtMs] of this.recentCaptureIds) if (atMs - seenAtMs > this.configuration.duplicateWindowMs) this.recentCaptureIds.delete(key);
    for (const [key, seenAtMs] of this.recentDeliveryIds) if (atMs - seenAtMs > this.configuration.duplicateWindowMs) this.recentDeliveryIds.delete(key);
  }

  private offerRejected(captureId: string, reasonCode: Exclude<PosScannerCaptureReasonCode, "resolved" | "duplicate_terminator" | "duplicate_delivery" | PosScannerProcessorRejectionReason>, atMs: number): PosScannerOfferOutcome {
    const result = this.recordResult(captureId, "rejected", reasonCode, atMs);
    return Object.freeze({ captureId, queued: false, result, queueDepth: this.queueDepth });
  }

  private recordResult(captureId: string, status: PosScannerCaptureResult["status"], reasonCode: PosScannerCaptureReasonCode, atMs: number) {
    const result: PosScannerCaptureResult = Object.freeze({ captureId, status, reasonCode, atMs });
    this.resultHistory.push(result);
    while (this.resultHistory.length > this.configuration.resultLimit) this.resultHistory.shift();
    return result;
  }

  private feedOutcome(
    disposition: PosScannerFeedOutcome["disposition"],
    consumed: boolean,
    sourceIdentified: boolean,
    immediateResults: readonly PosScannerCaptureResult[],
    captureId?: string,
    blockReason?: "operation_active" | "protected_target",
  ): PosScannerFeedOutcome {
    return Object.freeze({ disposition, consumed, sourceIdentified, immediateResults: Object.freeze([...immediateResults]), queueDepth: this.queueDepth, ...(captureId ? { captureId } : {}), ...(blockReason ? { blockReason } : {}) });
  }
}

function validateKeySequence(sequence: readonly string[], label: string, emptyAllowed: boolean, maximum: number) {
  if (!Array.isArray(sequence) || !emptyAllowed && !sequence.length || sequence.length > maximum || sequence.some(key => typeof key !== "string" || !key || key.length > 32)) {
    throw new Error(`A configuração de ${label} do scanner é inválida.`);
  }
}

function payloadKey(key: string) {
  return typeof key === "string" && Array.from(key).length === 1 && key !== "\r" && key !== "\n";
}

function positiveInteger(value: number, label: string, maximum: number) {
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum) throw new Error(`O ${label} deve ser um inteiro entre 1 e ${maximum}.`);
}

function nonNegativeInteger(value: number, label: string, maximum: number) {
  if (!Number.isSafeInteger(value) || value < 0 || value > maximum) throw new Error(`O ${label} deve ser um inteiro entre 0 e ${maximum}.`);
}

function timestamp(value: number) {
  if (!Number.isFinite(value) || value < 0) throw new Error("O timestamp monotônico da captura é inválido.");
}

function identifier(value: string, label: string, maximum: number) {
  const normalized = value.trim();
  if (!normalized || normalized.length > maximum || !/^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(normalized)) throw new Error(`${label} inválido.`);
  return normalized;
}
