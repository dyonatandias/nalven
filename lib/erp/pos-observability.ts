export class PosObservabilityError extends Error {
  constructor(message: string, readonly status = 422) {
    super(message);
    this.name = "PosObservabilityError";
  }
}

export const POS_OBSERVABILITY_DEFAULTS = Object.freeze({
  windowHours: 168,
  detailLimit: 25,
  maximumWindowHours: 720,
  maximumDetailLimit: 50,
  diagnosticScanLimit: 500,
});

export const POS_OBSERVABILITY_THRESHOLDS = Object.freeze({
  sessionStaleMinutes: 12 * 60,
  paymentPendingMinutes: 15,
  terminalStaleMinutes: 5,
  terminalOfflineMinutes: 15,
  syncProcessingMinutes: 5,
});

export type PosObservabilityQuery = {
  branchId: number | null;
  windowHours: number;
  limit: number;
};

export type PosSessionIncident = "open_stale" | "closing_stale";
export type PosPaymentIncident = "pending" | "unknown" | "manual_review";
export type PosPrintIncident = "queued" | "processing" | "failed" | "lease_expired";
export type PosTerminalIncident = "stale" | "offline" | "revoked";
export type PosDeviceIncident = "offline" | "error";
export type PosSyncIncident = "processing_stale" | "rejected" | "conflict";
export type PosLotIncident = "quarantine" | "expired";
export type PosPromotionIncident = "counter_mismatch" | "limit_exceeded" | "per_customer_limit_exceeded";

export function parsePosObservabilityQuery(parameters: URLSearchParams): PosObservabilityQuery {
  const allowed = new Set(["branchId", "windowHours", "limit"]);
  for (const key of parameters.keys()) {
    if (!allowed.has(key)) throw new PosObservabilityError(`Parâmetro de observabilidade não permitido: ${key}.`, 400);
    if (parameters.getAll(key).length !== 1) throw new PosObservabilityError(`Parâmetro repetido: ${key}.`, 400);
  }
  return {
    branchId: optionalPositiveInteger(parameters.get("branchId"), "Filial"),
    windowHours: boundedInteger(parameters.get("windowHours"), POS_OBSERVABILITY_DEFAULTS.windowHours, 1, POS_OBSERVABILITY_DEFAULTS.maximumWindowHours, "Janela"),
    limit: boundedInteger(parameters.get("limit"), POS_OBSERVABILITY_DEFAULTS.detailLimit, 1, POS_OBSERVABILITY_DEFAULTS.maximumDetailLimit, "Limite"),
  };
}

export function posAgeMinutes(now: Date, timestamp: Date): number {
  assertDate(now, "Relógio do servidor");
  assertDate(timestamp, "Timestamp operacional");
  return Math.max(0, Math.floor((now.valueOf() - timestamp.valueOf()) / 60_000));
}

export function classifyPosSession(status: string, openedAt: Date, now: Date): PosSessionIncident | null {
  if (!new Set(["open", "closing"]).has(status)) return null;
  if (posAgeMinutes(now, openedAt) < POS_OBSERVABILITY_THRESHOLDS.sessionStaleMinutes) return null;
  return status === "open" ? "open_stale" : "closing_stale";
}

export function classifyPosPayment(status: string, createdAt: Date, now: Date): PosPaymentIncident | null {
  if (status === "unknown" || status === "manual_review") return status;
  if (status === "pending") return "pending";
  if (["created", "processing"].includes(status) && posAgeMinutes(now, createdAt) >= POS_OBSERVABILITY_THRESHOLDS.paymentPendingMinutes) return "pending";
  return null;
}

export function classifyPosPrintJob(input: { status: string; createdAt: Date; claimedAt: Date | null; claimExpiresAt: Date | null }, now: Date): PosPrintIncident | null {
  if (input.status === "failed") return "failed";
  if (input.status === "processing" && input.claimExpiresAt && input.claimExpiresAt <= now) return "lease_expired";
  if (input.status === "processing") return "processing";
  if (input.status === "queued") return "queued";
  return null;
}

export function classifyPosTerminal(input: { status: string; lastSeenAt: Date | null; revokedAt?: Date | null }, now: Date): PosTerminalIncident | null {
  if (input.status === "revoked" || input.revokedAt) return "revoked";
  if (input.status === "unpaired") return null;
  if (input.status === "offline" || !input.lastSeenAt) return "offline";
  const age = posAgeMinutes(now, input.lastSeenAt);
  if (age >= POS_OBSERVABILITY_THRESHOLDS.terminalOfflineMinutes) return "offline";
  return age >= POS_OBSERVABILITY_THRESHOLDS.terminalStaleMinutes ? "stale" : null;
}

export function classifyPosDevice(status: string): PosDeviceIncident | null {
  return status === "offline" || status === "error" ? status : null;
}

export function classifyPosSync(input: { state: string; receivedAt: Date }, now: Date, windowStart: Date): PosSyncIncident | null {
  assertDate(windowStart, "Início da janela");
  if (input.state === "rejected" || input.state === "conflict") return input.receivedAt >= windowStart ? input.state : null;
  if (["received", "processing"].includes(input.state) && posAgeMinutes(now, input.receivedAt) >= POS_OBSERVABILITY_THRESHOLDS.syncProcessingMinutes) return "processing_stale";
  return null;
}

export function classifyPosLot(input: { status: string; bucketKey: string; quantityMicros: bigint; expiresOn: Date | null }, businessDate: Date): PosLotIncident[] {
  assertDate(businessDate, "Data operacional");
  if (input.quantityMicros <= BigInt(0)) return [];
  const incidents: PosLotIncident[] = [];
  if (input.status === "quarantine" || input.bucketKey === "quarantine") incidents.push("quarantine");
  if (input.status === "expired" || input.expiresOn && input.expiresOn < businessDate) incidents.push("expired");
  return incidents;
}

export function classifyPosCouponCounter(input: { usedCount: number; activeRedemptions: number; usageLimit: number | null }): PosPromotionIncident[] {
  const incidents: PosPromotionIncident[] = [];
  if (input.usedCount !== input.activeRedemptions) incidents.push("counter_mismatch");
  if (input.usageLimit != null && (input.usedCount > input.usageLimit || input.activeRedemptions > input.usageLimit)) incidents.push("limit_exceeded");
  return incidents;
}

export function classifyPosPromotionUsage(input: { activeRedemptions: number; usageLimit: number | null; exceededCustomerGroups?: number }): PosPromotionIncident[] {
  const incidents: PosPromotionIncident[] = [];
  if (input.usageLimit != null && input.activeRedemptions > input.usageLimit) incidents.push("limit_exceeded");
  if ((input.exceededCustomerGroups || 0) > 0) incidents.push("per_customer_limit_exceeded");
  return incidents;
}

function optionalPositiveInteger(value: string | null, label: string) {
  if (value == null || value === "") return null;
  return boundedInteger(value, 0, 1, Number.MAX_SAFE_INTEGER, label);
}

function boundedInteger(value: string | null, fallback: number, minimum: number, maximum: number, label: string) {
  if (value == null || value === "") return fallback;
  if (!/^\d+$/.test(value)) throw new PosObservabilityError(`${label} inválida.`, 400);
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) throw new PosObservabilityError(`${label} deve estar entre ${minimum} e ${maximum}.`, 400);
  return parsed;
}

function assertDate(value: Date, label: string) {
  if (!(value instanceof Date) || Number.isNaN(value.valueOf())) throw new PosObservabilityError(`${label} inválido.`);
}
