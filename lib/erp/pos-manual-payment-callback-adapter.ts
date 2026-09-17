import { createHash } from "node:crypto";
import {
  PosManualPaymentCallbackSecurityError,
  type PosManualPaymentCallbackSecurityInput,
  verifyPosManualPaymentCallback,
} from "./pos-manual-payment-callback-security";

const EVENT_ID_CONTEXT = "nalven-pos-manual-callback-event-id-v1";
const DISPOSITIONS = new Set(["accepted", "replay", "event_conflict", "nonce_conflict", "orphan_reference", "context_mismatch"]);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export const POS_MANUAL_RECORD_CALLBACK_SQL = `SELECT public."pos_manual_record_callback_v1"(
  $1,$2,$3,$4,$5,$6,$7,$8,$9::timestamptz,$10,$11,$12,$13,$14,$15::bigint,$16::timestamptz,$17,$18
) AS result`;

export type PosManualCallbackQuery = {
  query(sql: string, values: unknown[]): Promise<{ rows: Array<{ result: unknown }> }>;
};

export type PosManualCallbackTrustedContext = Readonly<{
  credentialRevision: number;
  verifierVersion: string;
}>;

export type PosManualCallbackAdapterInput = PosManualPaymentCallbackSecurityInput & Readonly<{
  database: PosManualCallbackQuery;
  trustedContext: PosManualCallbackTrustedContext;
}>;

export type PosManualCallbackAdapterResult = Readonly<{
  proofId: string;
  deliveryProofId?: string;
  callbackId?: number;
  caseId?: string;
  resultingState?: string;
  resultingVersion?: number;
  disposition: string;
  duplicate: boolean;
  quarantined: boolean;
}>;

export class PosManualCallbackAdapterError extends Error {
  constructor(public readonly code: string, public readonly status: number) {
    super("Callback manual recusado.");
    this.name = "PosManualCallbackAdapterError";
  }
}

/**
 * Internal process boundary for the dedicated `_mc` connection. It deliberately
 * exposes neither raw bytes, key material, nonce nor the provider's event id.
 */
export async function recordVerifiedPosManualPaymentCallback(input: PosManualCallbackAdapterInput): Promise<PosManualCallbackAdapterResult> {
  const context = trustedContext(input.trustedContext);
  try {
    const verified = verifyPosManualPaymentCallback(input);
    const eventId = derivedEventId(verified.provider, verified.eventId);
    const values = [
      verified.provider, eventId, verified.nonceHash, verified.payloadHash, verified.signatureHash,
      verified.canonicalEventHash, verified.evidenceHash, verified.authKeyId, verified.eventTimestamp,
      verified.outcome, verified.referenceHash, verified.method, verified.amountCents, verified.currency,
      verified.providerSequence.toString(), verified.providerOccurredAt, context.credentialRevision, context.verifierVersion,
    ];
    let response: { rows: Array<{ result: unknown }> };
    try { response = await input.database.query(POS_MANUAL_RECORD_CALLBACK_SQL, values); }
    catch { throw new PosManualCallbackAdapterError("persistence_failed", 503); }
    if (response.rows.length !== 1) throw new PosManualCallbackAdapterError("persistence_result_invalid", 503);
    return parseResult(response.rows[0]!.result);
  } catch (error) {
    if (error instanceof PosManualCallbackAdapterError) throw error;
    if (error instanceof PosManualPaymentCallbackSecurityError) throw new PosManualCallbackAdapterError("verification_failed", 400);
    throw new PosManualCallbackAdapterError("verification_failed", 400);
  }
}

function derivedEventId(provider: string, rawEventId: string) {
  const digest = createHash("sha256").update(EVENT_ID_CONTEXT).update("\0").update(provider).update("\0").update(rawEventId).digest("hex");
  return `evt:${digest}`;
}

function trustedContext(value: PosManualCallbackTrustedContext) {
  if (!value || !Number.isSafeInteger(value.credentialRevision) || value.credentialRevision < 1 || value.credentialRevision > 2_147_483_647
    || typeof value.verifierVersion !== "string" || !/^[a-z0-9][a-z0-9._-]{2,63}$/.test(value.verifierVersion)) {
    throw new PosManualCallbackAdapterError("trusted_context_invalid", 500);
  }
  return value;
}

function parseResult(value: unknown): PosManualCallbackAdapterResult {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new PosManualCallbackAdapterError("persistence_result_invalid", 503);
  const record = value as Record<string, unknown>;
  const allowed = new Set(["proofId", "deliveryProofId", "callbackId", "caseId", "resultingState", "resultingVersion", "disposition", "duplicate", "quarantined"]);
  if (Object.keys(record).some(key => !allowed.has(key)) || !isUuid(record.proofId) || !DISPOSITIONS.has(String(record.disposition))
    || typeof record.duplicate !== "boolean" || typeof record.quarantined !== "boolean") throw new PosManualCallbackAdapterError("persistence_result_invalid", 503);
  for (const key of ["deliveryProofId", "caseId"] as const) if (record[key] != null && !isUuid(record[key])) throw new PosManualCallbackAdapterError("persistence_result_invalid", 503);
  if (record.callbackId != null && (!Number.isSafeInteger(record.callbackId) || Number(record.callbackId) < 1)) throw new PosManualCallbackAdapterError("persistence_result_invalid", 503);
  if (record.resultingState != null && (typeof record.resultingState !== "string" || !/^[a-z_]{2,32}$/.test(record.resultingState))) throw new PosManualCallbackAdapterError("persistence_result_invalid", 503);
  if (record.resultingVersion != null && (!Number.isSafeInteger(record.resultingVersion) || Number(record.resultingVersion) < 0)) throw new PosManualCallbackAdapterError("persistence_result_invalid", 503);
  const result: Record<string, unknown> = {
    proofId: record.proofId, disposition: record.disposition,
    duplicate: record.duplicate, quarantined: record.quarantined,
  };
  for (const key of ["deliveryProofId", "callbackId", "caseId", "resultingState", "resultingVersion"] as const) if (record[key] != null) result[key] = record[key];
  return Object.freeze(result) as PosManualCallbackAdapterResult;
}

function isUuid(value: unknown): value is string { return typeof value === "string" && UUID.test(value); }
