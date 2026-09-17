export const POS_DRAFT_RECOVERY_INTENT_STATES = [
  "created",
  "processing",
  "authorized",
  "captured",
  "partially_refunded",
  "unknown",
  "manual_review",
] as const;

export type PosDraftRecoveryDraft = {
  id: string;
  revision: number;
  status: string;
};

export type PosDraftRecoveryIntent = {
  id: string;
  saleDraftId: string;
  paymentIndex: number;
  status: string;
  consumedAt: string | Date | null;
};

export type PosDraftRecoveryManualReference = {
  id: string;
  saleDraftId: string;
  paymentIndex: number;
  status: string;
  approvalStatus: string;
  approvalExpiresAt: string | Date;
  consumedSalePaymentId: string | null;
};

export type PosDraftRecoveryIssue = {
  code: "multiple_drafts" | "orphan_intent" | "captured_orphan" | "unknown_orphan" | "duplicate_payment_index" | "payment_index_gap";
  draftId?: string;
  intentId?: string;
};

export type PosDraftRecoveryPlan =
  | { mode: "none"; draftId: null; issues: [] }
  | { mode: "restore"; draftId: string; issues: []; paymentIntentIds: string[] }
  | { mode: "blocked"; draftId: null; issues: PosDraftRecoveryIssue[] };

const activeIntentStates = new Set<string>(POS_DRAFT_RECOVERY_INTENT_STATES);

/**
 * Chooses a recovery target only when the server state is unambiguous. It never
 * guesses a cart from amount, timestamp, operator, or payment status.
 */
export function planPosDraftRecovery(
  drafts: readonly PosDraftRecoveryDraft[],
  intents: readonly PosDraftRecoveryIntent[],
): PosDraftRecoveryPlan {
  const activeDrafts = drafts.filter((draft) => draft.status === "draft");
  const unresolvedIntents = intents.filter((intent) => intent.consumedAt == null && activeIntentStates.has(intent.status));
  if (!activeDrafts.length && !unresolvedIntents.length) return { mode: "none", draftId: null, issues: [] };

  const draftIds = new Set(activeDrafts.map((draft) => draft.id));
  const issues: PosDraftRecoveryIssue[] = [];
  if (activeDrafts.length > 1) issues.push({ code: "multiple_drafts" });

  for (const intent of unresolvedIntents) {
    if (draftIds.has(intent.saleDraftId)) continue;
    issues.push({
      code: intent.status === "captured" || intent.status === "partially_refunded" ? "captured_orphan" : intent.status === "unknown" || intent.status === "manual_review" ? "unknown_orphan" : "orphan_intent",
      draftId: intent.saleDraftId,
      intentId: intent.id,
    });
  }

  if (activeDrafts.length === 1) {
    const draft = activeDrafts[0];
    const linked = unresolvedIntents.filter((intent) => intent.saleDraftId === draft.id).sort((left, right) => left.paymentIndex - right.paymentIndex || left.id.localeCompare(right.id));
    const indices = new Set<number>();
    for (const intent of linked) {
      if (indices.has(intent.paymentIndex)) issues.push({ code: "duplicate_payment_index", draftId: draft.id, intentId: intent.id });
      indices.add(intent.paymentIndex);
    }
    if (linked.some((intent, index) => intent.paymentIndex !== index)) issues.push({ code: "payment_index_gap", draftId: draft.id });
    if (!issues.length) return { mode: "restore", draftId: draft.id, issues: [], paymentIntentIds: linked.map((intent) => intent.id) };
  }

  return { mode: "blocked", draftId: null, issues };
}

export function planPosDraftRecoveryWithManualReferences(
  drafts: readonly PosDraftRecoveryDraft[],
  intents: readonly PosDraftRecoveryIntent[],
  manualReferences: readonly PosDraftRecoveryManualReference[],
  now = new Date(),
) {
  const base = planPosDraftRecovery(drafts, intents), activeDrafts = drafts.filter(draft => draft.status === "draft"), draftIds = new Set(activeDrafts.map(draft => draft.id));
  const unresolvedManual = manualReferences.filter(reference => reference.status === "pending" && reference.consumedSalePaymentId == null);
  const issues: Array<{ code: string; draftId?: string; intentId?: string; manualReferenceId?: string }> = base.mode === "blocked"
    ? base.issues.filter(issue => !unresolvedManual.length || !["duplicate_payment_index", "payment_index_gap"].includes(issue.code))
    : [];
  for (const reference of unresolvedManual) {
    const expired = new Date(reference.approvalExpiresAt).valueOf() <= now.valueOf();
    const status = expired && reference.approvalStatus === "pending" ? "expired" : expired && reference.approvalStatus === "approved" ? "approved_expired" : reference.approvalStatus;
    if (!draftIds.has(reference.saleDraftId)) issues.push({ code: "orphan_manual_reference", draftId: reference.saleDraftId, manualReferenceId: reference.id });
    if (["rejected", "expired", "approved_expired"].includes(status)) issues.push({ code: status === "rejected" ? "manual_reference_rejected" : status === "approved_expired" ? "manual_reference_approved_expired" : "manual_reference_expired", draftId: reference.saleDraftId, manualReferenceId: reference.id });
  }
  if (activeDrafts.length === 1) {
    const draftId = activeDrafts[0].id;
    const evidence = [
      ...intents.filter(intent => intent.saleDraftId === draftId && intent.consumedAt == null && activeIntentStates.has(intent.status)).map(intent => ({ kind: "intent", id: intent.id, paymentIndex: intent.paymentIndex })),
      ...unresolvedManual.filter(reference => reference.saleDraftId === draftId).map(reference => ({ kind: "manual", id: reference.id, paymentIndex: reference.paymentIndex })),
    ].sort((left, right) => left.paymentIndex - right.paymentIndex || left.kind.localeCompare(right.kind) || left.id.localeCompare(right.id));
    const slots = new Set<number>();
    for (const item of evidence) {
      if (slots.has(item.paymentIndex)) issues.push({ code: "duplicate_payment_index", draftId, ...(item.kind === "intent" ? { intentId: item.id } : { manualReferenceId: item.id }) });
      slots.add(item.paymentIndex);
    }
    if (evidence.some((item, index) => item.paymentIndex !== index)) issues.push({ code: "payment_index_gap", draftId });
    if (!issues.length) return { mode: "restore" as const, draftId, issues: [], paymentIntentIds: evidence.filter(item => item.kind === "intent").map(item => item.id), manualReferenceIds: evidence.filter(item => item.kind === "manual").map(item => item.id) };
  }
  if (!activeDrafts.length && !intents.length && !unresolvedManual.length) return { mode: "none" as const, draftId: null, issues: [] };
  return { mode: "blocked" as const, draftId: null, issues };
}
