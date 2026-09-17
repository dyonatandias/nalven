import { Prisma } from "@/generated/tenant/client";

export type PosPaymentIntentWriteAction =
  | "create"
  | "retry"
  | "apply_delivery"
  | "apply_callback"
  | "cancel_before_dispatch"
  | "expire_before_dispatch"
  | "schedule_reconcile"
  | "force_manual_review"
  | "consume";

export type PosManualPaymentReferenceWriteAction = "create" | "revoke" | "consume";

export type PosSalePaymentWriteAction =
  | "create_commit"
  | "create_intent_consumption"
  | "insert_refund_compensation"
  | "insert_refund_cancel"
  | "insert_refund_return"
  | "update_refund_status";

type PosPaymentArtifactWrite<Action extends string> = {
  action: Action;
  id: string;
  expectedVersion: number;
  actorUserId: string;
  idempotencyKey: string;
  requestHash: string;
  target: Prisma.InputJsonObject;
};

export type PosPaymentIntentWrite = Omit<PosPaymentArtifactWrite<PosPaymentIntentWriteAction>, "requestHash" | "target"> & {
  target: PosPaymentIntentTarget;
};
export type PosManualPaymentReferenceWrite = Omit<PosPaymentArtifactWrite<PosManualPaymentReferenceWriteAction>, "requestHash" | "target"> & {
  target: PosManualPaymentReferenceTarget;
};
export type PosSalePaymentWrite = Omit<PosPaymentArtifactWrite<PosSalePaymentWriteAction>, "requestHash" | "target"> & {
  target: PosSalePaymentTarget;
};

export async function preparePosPaymentIntentWrite(
  tx: Prisma.TransactionClient,
  input: PosPaymentIntentWrite,
) {
  const target = JSON.stringify(input.target);
  const [preview] = await tx.$queryRaw<Array<{ requestHash: string }>>(Prisma.sql`
    SELECT public."pos_manual_t2_payment_intent_request_hash_v1"(
      ${input.action}, ${input.id}, ${input.expectedVersion}, ${input.actorUserId},
      ${input.idempotencyKey}, CAST(${target} AS jsonb)
    ) AS "requestHash"
  `);
  if (!preview?.requestHash) throw new Error("A prévia da capability da intenção não retornou hash.");
  await tx.$queryRaw(Prisma.sql`
    SELECT public."pos_manual_prepare_payment_intent_write_v1"(
      ${input.action}, ${input.id}, ${input.expectedVersion}, ${input.actorUserId},
      ${input.idempotencyKey}, ${preview.requestHash}, CAST(${target} AS jsonb)
    )
  `);
  return preview.requestHash;
}

export type PosPaymentIntentTarget = {
  id: string; branch_id: number; register_id: number; session_id: number; operator_profile_id: number;
  terminal_id: string | null; connector_id: string; credential_ref: string; sale_draft_id: string;
  payment_plan_id: string; payment_index: number; status: string; version: number; amount_cents: number;
  currency: string; method: string; installments: number; provider: string; provider_reference: string | null;
  transaction_id: string | null; end_to_end_id: string | null; nsu: string | null; authorization_code: string | null;
  card_brand: string | null; card_last_four: string | null; evidence_id: string | null; failure_code: string | null;
  failure_message: string | null; provider_sequence: string | null; provider_occurred_at: string | null;
  unknown_since: string | null; next_reconcile_at: string | null; expires_at: string; idempotency_key: string;
  request_hash: string; consumed_at: string | null;
};

type PosPaymentIntentTargetSource = {
  id: string; branchId: number; registerId: number; sessionId: number; operatorProfileId: number;
  terminalId: string | null; connectorId: string; credentialRef: string; saleDraftId: string;
  paymentPlanId: string | null; paymentIndex: number; status: string; version: number; amountCents: number;
  currency: string; method: string; installments: number; provider: string; providerReference: string | null;
  transactionId: string | null; endToEndId: string | null; nsu: string | null; authorizationCode: string | null;
  cardBrand: string | null; cardLastFour: string | null; evidenceId: string | null; failureCode: string | null;
  failureMessage: string | null; providerSequence: bigint | null; providerOccurredAt: Date | null;
  unknownSince: Date | null; nextReconcileAt: Date | null; expiresAt: Date; idempotencyKey: string;
  requestHash: string; consumedAt: Date | null;
};

export function posPaymentIntentWriteTarget(value: PosPaymentIntentTargetSource): PosPaymentIntentTarget {
  if (!value.paymentPlanId) throw new Error("A intenção protegida exige paymentPlanId.");
  return {
    id: value.id, branch_id: value.branchId, register_id: value.registerId, session_id: value.sessionId,
    operator_profile_id: value.operatorProfileId, terminal_id: value.terminalId, connector_id: value.connectorId,
    credential_ref: value.credentialRef, sale_draft_id: value.saleDraftId, payment_plan_id: value.paymentPlanId,
    payment_index: value.paymentIndex, status: value.status, version: value.version, amount_cents: value.amountCents,
    currency: value.currency, method: value.method, installments: value.installments, provider: value.provider,
    provider_reference: value.providerReference, transaction_id: value.transactionId, end_to_end_id: value.endToEndId,
    nsu: value.nsu, authorization_code: value.authorizationCode, card_brand: value.cardBrand,
    card_last_four: value.cardLastFour, evidence_id: value.evidenceId, failure_code: value.failureCode,
    failure_message: value.failureMessage, provider_sequence: value.providerSequence?.toString() ?? null,
    provider_occurred_at: iso(value.providerOccurredAt), unknown_since: iso(value.unknownSince),
    next_reconcile_at: iso(value.nextReconcileAt), expires_at: value.expiresAt.toISOString(),
    idempotency_key: value.idempotencyKey, request_hash: value.requestHash, consumed_at: iso(value.consumedAt),
  };
}

function iso(value: Date | null) { return value?.toISOString() ?? null; }

export async function preparePosManualPaymentReferenceWrite(
  tx: Prisma.TransactionClient,
  input: PosManualPaymentReferenceWrite,
) {
  const target = JSON.stringify(input.target);
  const [preview] = await tx.$queryRaw<Array<{ requestHash: string }>>(Prisma.sql`
    SELECT public."pos_manual_t2_manual_reference_request_hash_v1"(
      ${input.action}, ${input.id}, ${input.expectedVersion}, ${input.actorUserId},
      ${input.idempotencyKey}, CAST(${target} AS jsonb)
    ) AS "requestHash"
  `);
  if (!preview?.requestHash) throw new Error("A prévia da capability da referência manual não retornou hash.");
  await tx.$queryRaw(Prisma.sql`
    SELECT public."pos_manual_prepare_manual_payment_reference_write_v1"(
      ${input.action}, ${input.id}, ${input.expectedVersion}, ${input.actorUserId},
      ${input.idempotencyKey}, ${preview.requestHash}, CAST(${target} AS jsonb)
    )
  `);
  return preview.requestHash;
}

export type PosManualPaymentReferenceTarget = {
  id: string; branch_id: number; register_id: number; session_id: number; requester_profile_id: number;
  requester_user_id: string; sale_draft_id: string; payment_plan_id: string; quote_hash: string;
  payment_index: number; method: string; amount_cents: number; installments: number; provider: string;
  reference: string; reference_hash: string; reference_last_four: string; occurred_at: string; status: string;
  approval_id: string; idempotency_key: string; request_hash: string; consumed_sale_payment_id: string | null;
  consumed_at: string | null; revoked_at: string | null; revoked_by: string | null; revoke_reason: string | null;
  revoke_idempotency_key: string | null; revoke_request_hash: string | null;
};

type PosManualPaymentReferenceTargetSource = {
  id: string; branchId: number; registerId: number; sessionId: number; requesterProfileId: number;
  requesterUserId: string; saleDraftId: string; paymentPlanId: string | null; quoteHash: string;
  paymentIndex: number; method: string; amountCents: number; installments: number; provider: string;
  reference: string; referenceHash: string; referenceLastFour: string; occurredAt: Date; status: string;
  approvalId: string; idempotencyKey: string; requestHash: string; consumedSalePaymentId: string | null;
  consumedAt: Date | null; revokedAt: Date | null; revokedBy: string | null; revokeReason: string | null;
  revokeIdempotencyKey: string | null; revokeRequestHash: string | null;
};

export function posManualPaymentReferenceWriteTarget(value: PosManualPaymentReferenceTargetSource): PosManualPaymentReferenceTarget {
  if (!value.paymentPlanId) throw new Error("A referência manual protegida exige paymentPlanId.");
  return {
    id: value.id, branch_id: value.branchId, register_id: value.registerId, session_id: value.sessionId,
    requester_profile_id: value.requesterProfileId, requester_user_id: value.requesterUserId,
    sale_draft_id: value.saleDraftId, payment_plan_id: value.paymentPlanId, quote_hash: value.quoteHash,
    payment_index: value.paymentIndex, method: value.method, amount_cents: value.amountCents,
    installments: value.installments, provider: value.provider, reference: value.reference,
    reference_hash: value.referenceHash, reference_last_four: value.referenceLastFour,
    occurred_at: value.occurredAt.toISOString(), status: value.status, approval_id: value.approvalId,
    idempotency_key: value.idempotencyKey, request_hash: value.requestHash,
    consumed_sale_payment_id: value.consumedSalePaymentId, consumed_at: iso(value.consumedAt),
    revoked_at: iso(value.revokedAt), revoked_by: value.revokedBy, revoke_reason: value.revokeReason,
    revoke_idempotency_key: value.revokeIdempotencyKey, revoke_request_hash: value.revokeRequestHash,
  };
}

export async function preparePosSalePaymentWrite(
  tx: Prisma.TransactionClient,
  input: PosSalePaymentWrite,
) {
  const target = JSON.stringify(input.target);
  const [preview] = await tx.$queryRaw<Array<{ requestHash: string }>>(Prisma.sql`
    SELECT public."pos_manual_t2_sale_payment_request_hash_v1"(
      ${input.action}, ${input.id}, ${input.expectedVersion}, ${input.actorUserId},
      ${input.idempotencyKey}, CAST(${target} AS jsonb)
    ) AS "requestHash"
  `);
  if (!preview?.requestHash) throw new Error("A prévia da capability do pagamento da venda não retornou hash.");
  await tx.$queryRaw(Prisma.sql`
    SELECT public."pos_manual_prepare_sale_payment_write_v1"(
      ${input.action}, ${input.id}, ${input.expectedVersion}, ${input.actorUserId},
      ${input.idempotencyKey}, ${preview.requestHash}, CAST(${target} AS jsonb)
    )
  `);
  return preview.requestHash;
}

export type PosSalePaymentTarget = Prisma.InputJsonObject & {
  id: string; sale_id: number; connector_id: string | null; original_payment_id: string | null;
  processing_session_id: number | null; type: string; method: string; status: string; amount_cents: number;
  tendered_cents: number; change_cents: number; provider: string | null; transaction_id: string | null;
  end_to_end_id: string | null; nsu: string | null; authorization_code: string | null; card_brand: string | null;
  card_last_four: string | null; installments: number; idempotency_key: string; payment_intent_id: string | null;
  compensation_id: string | null; payment_plan_id: string | null; payment_index: number | null;
  value_reservation_id: string | null; value_capture_entry_id: string | null; value_amount_units: string | null;
  manual_payment_case_id: string | null; metadata: Prisma.InputJsonValue | null; authorized_at: string | null;
  captured_at: string | null; refunded_at: string | null;
};

type PosSalePaymentTargetSource = {
  id: string; saleId: number; connectorId?: string | null; originalPaymentId?: string | null;
  processingSessionId?: number | null; type: string; method: string; status: string; amountCents: number;
  tenderedCents?: number; changeCents?: number; provider?: string | null; transactionId?: string | null;
  endToEndId?: string | null; nsu?: string | null; authorizationCode?: string | null; cardBrand?: string | null;
  cardLastFour?: string | null; installments?: number; idempotencyKey: string; paymentIntentId?: string | null;
  compensationId?: string | null; paymentPlanId?: string | null; paymentIndex?: number | null;
  valueReservationId?: string | null; valueCaptureEntryId?: bigint | number | string | null;
  valueAmountUnits?: bigint | number | string | null;
  manualPaymentCaseId?: string | null; metadata?: Prisma.InputJsonValue | null; authorizedAt?: Date | null;
  capturedAt?: Date | null; refundedAt?: Date | null;
};

export function posSalePaymentWriteTarget(value: PosSalePaymentTargetSource): PosSalePaymentTarget {
  return {
    id: value.id, sale_id: value.saleId, connector_id: value.connectorId ?? null,
    original_payment_id: value.originalPaymentId ?? null, processing_session_id: value.processingSessionId ?? null,
    type: value.type, method: value.method, status: value.status, amount_cents: value.amountCents,
    tendered_cents: value.tenderedCents ?? 0, change_cents: value.changeCents ?? 0,
    provider: value.provider ?? null, transaction_id: value.transactionId ?? null, end_to_end_id: value.endToEndId ?? null,
    nsu: value.nsu ?? null, authorization_code: value.authorizationCode ?? null, card_brand: value.cardBrand ?? null,
    card_last_four: value.cardLastFour ?? null, installments: value.installments ?? 1,
    idempotency_key: value.idempotencyKey, payment_intent_id: value.paymentIntentId ?? null,
    compensation_id: value.compensationId ?? null, payment_plan_id: value.paymentPlanId ?? null,
    payment_index: value.paymentIndex ?? null, value_reservation_id: value.valueReservationId ?? null,
    value_capture_entry_id: value.valueCaptureEntryId?.toString() ?? null,
    value_amount_units: value.valueAmountUnits?.toString() ?? null,
    manual_payment_case_id: value.manualPaymentCaseId ?? null, metadata: value.metadata ?? null,
    authorized_at: iso(value.authorizedAt ?? null), captured_at: iso(value.capturedAt ?? null),
    refunded_at: iso(value.refundedAt ?? null),
  };
}
