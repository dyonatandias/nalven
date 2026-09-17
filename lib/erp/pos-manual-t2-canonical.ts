import { createHash } from "node:crypto";

export const POS_MANUAL_T2_EFFECT_KINDS = [
  "sale", "sale_item", "sale_payment", "plan_consume", "draft_convert",
  "promotion_redemption", "kit_component", "tracked_lot_movement", "stock_movement",
  "warehouse_ledger", "value_account", "value_ledger_entry", "value_accrual",
  "fiscal_document", "fiscal_attempt", "fiscal_outbox", "accounting_journal",
  "accounting_posting", "accounting_export_outbox", "sale_event", "audit_event",
  "webhook_delivery",
] as const;

export const POS_MANUAL_T2_HASH_DOMAINS = {
  snapshotComponent: "t2-snapshot-component-v1\0",
  snapshot: "t2-snapshot-v1\0",
  manifest: "t2-manifest-v1\0",
  effect: "t2-effect-v1\0",
  profile: "t2-profile-v1\0",
} as const;

export const POS_MANUAL_T2_ALLOWED_HASH_DOMAINS = [
  "t2-snapshot-component-v1", "t2-snapshot-v1", "t2-manifest-v1", "t2-effect-v1", "t2-profile-v1",
  "t2-reserve-request-v1", "t2-reserve-identity-v1", "t2-reservation-id-v1", "t2-reservation-event-id-v1",
  "t2-stock-reservation-key-v1", "t2-promotion-reservation-key-v1", "t2-effect-key-v1", "t2-sale-idempotency-v1",
  "t2-sale-request-v1", "t2-sale-payment-identity-v1", "t2-sale-payment-idempotency-v1", "t2-sweep-request-v1",
  "t2-sweep-identity-v1", "t2-sweep-receipt-id-v1", "t2-sweeper-subject-v1", "t2-sweep-result-v1",
  "t2-promotion-policy-v1", "t2-reservation-graph-v1", "t2-release-result-v1", "t2-customer-opaque-v1",
  "t2-customer-eligibility-v1", "t2-tracking-request-v1", "t2-catalog-product-v1", "t2-catalog-variation-v1",
  "t2-value-program-v1", "t2-value-account-identity-v1", "t2-value-entry-key-v1", "t2-value-ledger-request-v1",
  "t2-accounting-period-v1", "t2-accounting-mapping-v1", "t2-accounting-journal-identity-v1",
  "t2-accounting-journal-idempotency-v1", "t2-accounting-journal-request-v1", "t2-stock-multiset-v1",
  "t2-promotion-multiset-v1", "t2-stock-release-multiset-v1", "t2-promotion-release-multiset-v1",
  "t2-webhook-config-v1", "t2-webhook-payload-v1", "t2-fiscal-envelope-identity-v1",
  "t2-fiscal-envelope-prepare-v1", "t2-fiscal-envelope-binding-v1", "t2-fiscal-document-identity-v1",
  "t2-fiscal-document-idempotency-v1", "t2-fiscal-document-request-v1", "t2-fiscal-attempt-identity-v1",
  "t2-fiscal-attempt-operation-v1", "t2-fiscal-attempt-request-v1", "t2-fiscal-provider-idempotency-v1",
  "t2-fiscal-number-allocation-identity-v1", "t2-webhook-event-identity-v1", "t2-webhook-delivery-identity-v1",
  "t2-boundary-operation-identity-v1", "t2-catalog-boundary-request-v1", "t2-value-program-boundary-request-v1",
  "t2-accounting-period-boundary-request-v1", "t2-accounting-period-put-request-v1", "t2-webhook-boundary-request-v1",
] as const;

export type PosManualT2HashDomain = typeof POS_MANUAL_T2_ALLOWED_HASH_DOMAINS[number];

const POS_MANUAL_T2_HASH_DOMAIN_SET = new Set<string>(POS_MANUAL_T2_ALLOWED_HASH_DOMAINS);
const POS_MANUAL_T2_DOCUMENT_MAX_BYTES = 4_194_304;
const POS_MANUAL_T2_STRING_MAX_BYTES = 65_536;

export const POS_MANUAL_T2_HASH_VECTORS = [{
  domain: "snapshot" as const,
  canonical: '{"a":[2,1],"z":null}',
  sha256: "81f3fd0946a771a4f0efc2267efc651f82244ab05d75ecf9fe32ad7109a8980f",
}] as const;

export type T2CanonicalValue = null | boolean | number | string | T2CanonicalValue[] | { [key: string]: T2CanonicalValue };
export type T2SnapshotDocumentKind = "operationalActor" | "caseEvidence" | "draftQuoteSlot" | "customerSalePayment" | "catalogBomTracking" | "inventoryPromotion" | "fiscal" | "accounting" | "webhooks" | "manifest";

const controlCharacter = /[\u0000-\u001f\u007f]/u;
const forbiddenClassA = /(?:cvv|cvc|pin|track[12]|vault[_ -]?token|open[_ -]?reference|authorization[_ -]?code|(?:^|[^a-z])nsu(?:[^a-z]|$)|end[_ -]?to[_ -]?end|e2e)/iu;
const forbiddenIdentityMarker = /(?:^|[^A-Za-z0-9_])(?:customer[_ -]?(?:name|email|phone|address)|name|nome|e-?mail|telefone|phone|street|avenue|address|logradouro|postal[_ -]?code|cep|cpf|cnpj)(?:[^A-Za-z0-9_]|$)/iu;
const forbiddenEmail = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/iu;
const forbiddenTaxIdentifier = /(?:^|[^0-9])(?:[0-9]{3}\.?[0-9]{3}\.?[0-9]{3}-?[0-9]{2}|[0-9]{2}\.?[0-9]{3}\.?[0-9]{3}\/?[0-9]{4}-?[0-9]{2})(?:[^0-9]|$)/u;
const forbiddenPhone = /(?:\+55\s?)?\([0-9]{2}\)\s?[0-9]{4,5}-[0-9]{4}/u;
const forbiddenPostalCode = /"[0-9]{5}-[0-9]{3}"/u;
const forbiddenStreetAddress = /"(?:rua|avenida|av\.|travessa|street|avenue)\s[^"\u0000-\u001f\u007f]{2,160}"/iu;
const documentKeys: Record<T2SnapshotDocumentKind, ReadonlySet<string>> = {
  operationalActor: new Set(["schemaVersion", "branchId", "registerId", "sessionId", "terminalId", "actorProfileId", "actorUserId", "branchGrantId", "registerGrantId"]),
  caseEvidence: new Set(["schemaVersion", "caseId", "caseVersion", "observationId", "evidenceHash", "provider", "method", "amountCents", "currency", "referenceLastFour"]),
  draftQuoteSlot: new Set(["schemaVersion", "draftId", "draftRevision", "draftRequestHash", "quoteHash", "planId", "planVersion", "paymentIndex", "slot", "method", "amountCents", "installments", "proofKind", "provider", "connectorId", "connectorRevision", "credentialRef", "credentialRevision"]),
  customerSalePayment: new Set(["schemaVersion", "customerOpaqueId", "eligibilityHash", "sale", "payment", "plannedSaleId", "saleNumber", "occurredAt", "saleIdempotencyKey", "saleRequestHash", "method", "amountCents", "currency", "installments", "provider"]),
  catalogBomTracking: new Set(["schemaVersion", "products", "variations", "kits", "bom", "tracking", "id", "version", "productId", "variationId", "kitId", "componentId", "quantityMicros", "unit", "lotId", "serialId", "expiry", "hash"]),
  inventoryPromotion: new Set(["schemaVersion", "inventoryReservations", "lotReservations", "promotionReservations", "id", "scopeKey", "productId", "variationId", "warehouseId", "lotId", "quantityMicros", "promotionId", "couponId", "policyHash", "expiresAt"]),
  fiscal: new Set(["schemaVersion", "mode", "profileId", "profileVersion", "policyHash", "envelopeLocator", "envelopeVersion", "envelopeHash", "expected", "documentModel", "environment", "series", "amountCents", "currency", "disposition"]),
  accounting: new Set(["schemaVersion", "period", "policyId", "policyVersion", "policyHash", "mappings", "postings", "periodId", "periodVersion", "mappingId", "mappingHash", "accountId", "costCenterId", "direction", "amountCents", "currency", "entryKey"]),
  webhooks: new Set(["schemaVersion", "endpoints", "payloads", "endpointId", "endpointVersion", "topic", "apiVersion", "configHash", "payloadHash", "eventKind"]),
  manifest: new Set(["schemaVersion", "entries", "manifestHash", "effectKind", "effectKey", "expectedHash", "expectedCardinality", "required"]),
};

export function canonicalizePosManualT2(value: T2CanonicalValue): string {
  const canonical = canonicalize(value, 0);
  if (Buffer.byteLength(canonical, "utf8") > POS_MANUAL_T2_DOCUMENT_MAX_BYTES) throw new Error("T2_CANONICAL_SIZE_EXCEEDED");
  return canonical;
}

function canonicalize(value: T2CanonicalValue, depth: number): string {
  if (depth > 32) throw new Error("T2_CANONICAL_DEPTH_EXCEEDED");
  if (value === null || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value)) throw new Error("T2_CANONICAL_INTEGER_REQUIRED");
    return String(value);
  }
  if (typeof value === "string") {
    if (value !== value.normalize("NFC")) throw new Error("T2_CANONICAL_NFC_REQUIRED");
    if (controlCharacter.test(value)) throw new Error("T2_CANONICAL_CONTROL_CHARACTER");
    if (Buffer.byteLength(value, "utf8") > POS_MANUAL_T2_STRING_MAX_BYTES) throw new Error("T2_CANONICAL_STRING_SIZE_EXCEEDED");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map((child) => canonicalize(child, depth + 1)).join(",")}]`;
  const entries = Object.entries(value).map(([key, child]) => {
    if (key !== key.normalize("NFC")) throw new Error("T2_CANONICAL_NFC_REQUIRED");
    if (controlCharacter.test(key)) throw new Error("T2_CANONICAL_CONTROL_CHARACTER");
    if (Buffer.byteLength(key, "utf8") < 1 || Buffer.byteLength(key, "utf8") > 128) throw new Error("T2_CANONICAL_KEY_SIZE_INVALID");
    return [key, child] as const;
  })
    .sort(([left], [right]) => Buffer.from(left, "utf8").compare(Buffer.from(right, "utf8")));
  for (let index = 1; index < entries.length; index += 1) {
    if (entries[index - 1]![0] === entries[index]![0]) throw new Error("T2_CANONICAL_DUPLICATE_NORMALIZED_KEY");
  }
  return `{${entries.map(([key, child]) => `${canonicalize(key, depth + 1)}:${canonicalize(child, depth + 1)}`).join(",")}}`;
}

export function hashPosManualT2(domain: keyof typeof POS_MANUAL_T2_HASH_DOMAINS, value: T2CanonicalValue): string {
  return createHash("sha256").update(POS_MANUAL_T2_HASH_DOMAINS[domain], "utf8").update(canonicalizePosManualT2(value), "utf8").digest("hex");
}

export function hashPosManualT2Domain(domain: PosManualT2HashDomain, value: T2CanonicalValue): string {
  if (!POS_MANUAL_T2_HASH_DOMAIN_SET.has(domain) || domain.includes("\0")) throw new Error("T2_HASH_DOMAIN_NOT_ALLOWED");
  return createHash("sha256").update(domain, "utf8").update("\0", "utf8").update(canonicalizePosManualT2(value), "utf8").digest("hex");
}

export function formatPosManualT2Timestamp(value: Date | string): string {
  if (typeof value === "string") {
    if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/u.test(value)) throw new Error("T2_CANONICAL_TIMESTAMP_INVALID");
    const millisecondProjection = `${value.slice(0, 23)}Z`;
    const parsed = new Date(millisecondProjection);
    if (!Number.isFinite(parsed.getTime()) || parsed.toISOString() !== millisecondProjection) throw new Error("T2_CANONICAL_TIMESTAMP_INVALID");
    return value;
  }
  if (!Number.isFinite(value.getTime())) throw new Error("T2_CANONICAL_TIMESTAMP_INVALID");
  return value.toISOString().replace(/\.(\d{3})Z$/u, ".$1000Z");
}

export function assertPosManualT2DlpSafe(value: T2CanonicalValue): void {
  const canonical = canonicalizePosManualT2(value);
  if (containsLuhnPan(canonical) || forbiddenClassA.test(canonical)) throw new Error("T2_DLP_CLASS_A_FORBIDDEN");
  if (forbiddenIdentityMarker.test(canonical) || forbiddenEmail.test(canonical)
    || forbiddenTaxIdentifier.test(canonical) || forbiddenPhone.test(canonical)
    || forbiddenPostalCode.test(canonical) || forbiddenStreetAddress.test(canonical)) {
    throw new Error("T2_DLP_CLASS_B_FORBIDDEN");
  }
}

function containsLuhnPan(value: string): boolean {
  for (const match of value.matchAll(/[0-9][0-9 ./_():-]{10,42}[0-9]/gu)) {
    const digits = match[0].replace(/[^0-9]/gu, "");
    if (digits.length < 12 || digits.length > 19) continue;
    let total = 0;
    let alternate = false;
    for (let index = digits.length - 1; index >= 0; index -= 1) {
      let digit = Number(digits[index]);
      if (alternate) { digit *= 2; if (digit > 9) digit -= 9; }
      total += digit;
      alternate = !alternate;
    }
    if (total % 10 === 0) return true;
  }
  return false;
}

export function assertPosManualT2SnapshotDocument(kind: T2SnapshotDocumentKind, value: T2CanonicalValue): void {
  if (value === null || Array.isArray(value) || typeof value !== "object") throw new Error("T2_DOCUMENT_OBJECT_REQUIRED");
  assertDocumentKeys(kind, value);
  if (value.schemaVersion !== 1) throw new Error("T2_DOCUMENT_SCHEMA_VERSION_REQUIRED");
  if (kind === "caseEvidence"
    && (typeof value.referenceLastFour !== "string" || !/^[A-Za-z0-9*#._:-]{4}$/u.test(value.referenceLastFour))) {
    throw new Error("T2_DOCUMENT_REFERENCE_LAST_FOUR_INVALID");
  }
  assertPosManualT2DlpSafe(value);
}

function assertDocumentKeys(kind: T2SnapshotDocumentKind, value: T2CanonicalValue): void {
  if (value === null || typeof value !== "object") return;
  if (Array.isArray(value)) { for (const child of value) assertDocumentKeys(kind, child); return; }
  for (const [key, child] of Object.entries(value)) {
    if (!documentKeys[kind].has(key)) throw new Error("T2_DOCUMENT_UNKNOWN_KEY");
    assertDocumentKeys(kind, child);
  }
}
