-- Persistent payment-integrity incidents, per-delivery completion ledger and
-- database enforcement for authoritative evidence after sale consumption.

ALTER TABLE "pos_payment_callbacks" DROP CONSTRAINT "pos_payment_callbacks_result_check";
ALTER TABLE "pos_payment_callbacks" ADD CONSTRAINT "pos_payment_callbacks_result_check" CHECK (
  "processing_result" IN ('applied', 'no_change', 'ignored_stale', 'rejected_context', 'rejected_transition', 'supplemental_after_consumption')
);
ALTER TABLE "pos_payment_callbacks" DROP CONSTRAINT "pos_payment_callbacks_values_check";
ALTER TABLE "pos_payment_callbacks" ADD CONSTRAINT "pos_payment_callbacks_values_check" CHECK (
  "amount_cents" > 0
  AND "currency" ~ '^[A-Z]{3}$'
  AND "resulting_version" >= 0
  AND ("provider_sequence" IS NULL OR "provider_sequence" > 0)
  AND char_length("event_id") BETWEEN 8 AND 160
  AND char_length("signature_key_id") BETWEEN 1 AND 160
  AND char_length("provider_reference") BETWEEN 1 AND 160
  AND "payload_hash" ~ '^[0-9a-f]{64}$'
);

CREATE TABLE "pos_payment_delivery_results" (
  "id" BIGSERIAL NOT NULL,
  "intent_id" TEXT NOT NULL,
  "attempt_id" TEXT NOT NULL,
  "outbox_id" BIGINT NOT NULL,
  "delivery_number" INTEGER NOT NULL,
  "claim_token_hash" TEXT NOT NULL,
  "response_hash" TEXT NOT NULL,
  "result_kind" TEXT NOT NULL,
  "retry_scheduled" BOOLEAN NOT NULL DEFAULT false,
  "superseded" BOOLEAN NOT NULL DEFAULT false,
  "resulting_attempt_state" TEXT NOT NULL,
  "resulting_intent_state" TEXT NOT NULL,
  "resulting_intent_version" INTEGER NOT NULL,
  "completed_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "pos_payment_delivery_results_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "pos_payment_delivery_results_values_check" CHECK (
    "delivery_number" > 0
    AND "claim_token_hash" ~ '^[0-9a-f]{64}$'
    AND "response_hash" ~ '^[0-9a-f]{64}$'
    AND "result_kind" IN ('result', 'unknown', 'known_failure')
    AND "resulting_attempt_state" IN ('claimed', 'retry', 'succeeded', 'unknown', 'failed')
    AND "resulting_intent_state" IN ('created', 'processing', 'authorized', 'captured', 'declined', 'unknown', 'manual_review', 'cancelled', 'partially_refunded', 'refunded')
    AND "resulting_intent_version" >= 0
  ),
  CONSTRAINT "pos_payment_delivery_results_intent_id_fkey" FOREIGN KEY ("intent_id") REFERENCES "pos_payment_intents"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "pos_payment_delivery_results_attempt_id_fkey" FOREIGN KEY ("attempt_id") REFERENCES "pos_payment_attempts"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "pos_payment_delivery_results_outbox_id_fkey" FOREIGN KEY ("outbox_id") REFERENCES "pos_payment_outbox"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "pos_payment_delivery_results_claim_token_hash_key" ON "pos_payment_delivery_results"("claim_token_hash");
CREATE UNIQUE INDEX "pos_payment_delivery_results_attempt_id_delivery_number_key" ON "pos_payment_delivery_results"("attempt_id", "delivery_number");
CREATE INDEX "pos_payment_delivery_results_intent_id_completed_at_idx" ON "pos_payment_delivery_results"("intent_id", "completed_at");

CREATE TABLE "pos_payment_integrity_incidents" (
  "id" TEXT NOT NULL,
  "intent_id" TEXT NOT NULL,
  "callback_id" BIGINT NOT NULL,
  "kind" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'open',
  "production_blocking" BOOLEAN NOT NULL DEFAULT true,
  "expected_amount_cents" INTEGER NOT NULL,
  "reported_amount_cents" INTEGER NOT NULL,
  "expected_currency" TEXT NOT NULL,
  "reported_currency" TEXT NOT NULL,
  "expected_evidence_hash" TEXT NOT NULL,
  "reported_evidence_hash" TEXT NOT NULL,
  "details" JSONB,
  "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "resolved_at" TIMESTAMPTZ,
  "resolved_by_actor_id" TEXT,
  "resolution_reason" TEXT,
  CONSTRAINT "pos_payment_integrity_incidents_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "pos_payment_integrity_incidents_kind_check" CHECK ("kind" IN ('callback_monetary_mismatch', 'consumed_evidence_mismatch')),
  CONSTRAINT "pos_payment_integrity_incidents_status_check" CHECK ("status" IN ('open', 'resolved')),
  CONSTRAINT "pos_payment_integrity_incidents_values_check" CHECK (
    "expected_amount_cents" > 0
    AND "reported_amount_cents" > 0
    AND "expected_currency" ~ '^[A-Z]{3}$'
    AND "reported_currency" ~ '^[A-Z]{3}$'
    AND "expected_evidence_hash" ~ '^[0-9a-f]{64}$'
    AND "reported_evidence_hash" ~ '^[0-9a-f]{64}$'
  ),
  CONSTRAINT "pos_payment_integrity_incidents_resolution_check" CHECK (
    ("status" = 'open' AND "production_blocking" AND "resolved_at" IS NULL AND "resolved_by_actor_id" IS NULL AND "resolution_reason" IS NULL)
    OR ("status" = 'resolved' AND NOT "production_blocking" AND "resolved_at" IS NOT NULL AND "resolved_by_actor_id" IS NOT NULL AND char_length("resolution_reason") BETWEEN 8 AND 500)
  ),
  CONSTRAINT "pos_payment_integrity_incidents_intent_id_fkey" FOREIGN KEY ("intent_id") REFERENCES "pos_payment_intents"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "pos_payment_integrity_incidents_callback_id_fkey" FOREIGN KEY ("callback_id") REFERENCES "pos_payment_callbacks"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "pos_payment_integrity_incidents_callback_id_key" ON "pos_payment_integrity_incidents"("callback_id");
CREATE INDEX "pos_payment_integrity_incidents_status_blocking_created_idx" ON "pos_payment_integrity_incidents"("status", "production_blocking", "created_at");
CREATE INDEX "pos_payment_integrity_incidents_intent_id_status_idx" ON "pos_payment_integrity_incidents"("intent_id", "status");

CREATE FUNCTION "reject_pos_payment_integrity_history_mutation"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'pos payment integrity history is immutable' USING ERRCODE = '55000';
END;
$$;

CREATE TRIGGER "pos_payment_delivery_results_immutable_guard"
BEFORE UPDATE OR DELETE ON "pos_payment_delivery_results"
FOR EACH ROW EXECUTE FUNCTION "reject_pos_payment_integrity_history_mutation"();

CREATE FUNCTION "protect_pos_payment_integrity_incident"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF OLD."id" IS DISTINCT FROM NEW."id"
    OR OLD."intent_id" IS DISTINCT FROM NEW."intent_id"
    OR OLD."callback_id" IS DISTINCT FROM NEW."callback_id"
    OR OLD."kind" IS DISTINCT FROM NEW."kind"
    OR OLD."expected_amount_cents" IS DISTINCT FROM NEW."expected_amount_cents"
    OR OLD."reported_amount_cents" IS DISTINCT FROM NEW."reported_amount_cents"
    OR OLD."expected_currency" IS DISTINCT FROM NEW."expected_currency"
    OR OLD."reported_currency" IS DISTINCT FROM NEW."reported_currency"
    OR OLD."expected_evidence_hash" IS DISTINCT FROM NEW."expected_evidence_hash"
    OR OLD."reported_evidence_hash" IS DISTINCT FROM NEW."reported_evidence_hash"
    OR OLD."details" IS DISTINCT FROM NEW."details"
    OR OLD."created_at" IS DISTINCT FROM NEW."created_at"
  THEN RAISE EXCEPTION 'pos payment integrity incident evidence is immutable' USING ERRCODE = '55000'; END IF;
  IF OLD."status" <> 'open' OR NEW."status" <> 'resolved' OR NEW."production_blocking"
    OR NEW."resolved_at" IS NULL OR NEW."resolved_by_actor_id" IS NULL OR NEW."resolution_reason" IS NULL
  THEN RAISE EXCEPTION 'invalid pos payment integrity incident resolution' USING ERRCODE = '22000'; END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "pos_payment_integrity_incidents_guard"
BEFORE UPDATE ON "pos_payment_integrity_incidents"
FOR EACH ROW EXECUTE FUNCTION "protect_pos_payment_integrity_incident"();
CREATE TRIGGER "pos_payment_integrity_incidents_delete_guard"
BEFORE DELETE ON "pos_payment_integrity_incidents"
FOR EACH ROW EXECUTE FUNCTION "reject_pos_payment_integrity_history_mutation"();

CREATE FUNCTION "protect_consumed_pos_payment_evidence"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF OLD."consumed_at" IS NOT NULL AND (
    OLD."provider_reference" IS DISTINCT FROM NEW."provider_reference"
    OR OLD."transaction_id" IS DISTINCT FROM NEW."transaction_id"
    OR OLD."end_to_end_id" IS DISTINCT FROM NEW."end_to_end_id"
    OR OLD."nsu" IS DISTINCT FROM NEW."nsu"
    OR OLD."authorization_code" IS DISTINCT FROM NEW."authorization_code"
    OR OLD."card_brand" IS DISTINCT FROM NEW."card_brand"
    OR OLD."card_last_four" IS DISTINCT FROM NEW."card_last_four"
    OR OLD."evidence_id" IS DISTINCT FROM NEW."evidence_id"
    OR OLD."provider_sequence" IS DISTINCT FROM NEW."provider_sequence"
    OR OLD."provider_occurred_at" IS DISTINCT FROM NEW."provider_occurred_at"
  ) THEN RAISE EXCEPTION 'consumed pos payment evidence is immutable' USING ERRCODE = '55000'; END IF;

  IF OLD."consumed_at" IS NULL AND NEW."consumed_at" IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM "pos_sale_payments" p
    WHERE p."payment_intent_id" = NEW."id"
      AND p."type" = 'payment'
      AND p."status" = 'captured'
      AND p."amount_cents" = NEW."amount_cents"
      AND p."tendered_cents" = NEW."amount_cents"
      AND p."change_cents" = 0
      AND p."method" = NEW."method"
      AND p."provider" IS NOT DISTINCT FROM NEW."provider"
      AND p."transaction_id" IS NOT DISTINCT FROM COALESCE(NEW."transaction_id", NEW."provider_reference")
      AND p."end_to_end_id" IS NOT DISTINCT FROM NEW."end_to_end_id"
      AND p."nsu" IS NOT DISTINCT FROM NEW."nsu"
      AND p."authorization_code" IS NOT DISTINCT FROM NEW."authorization_code"
      AND p."card_brand" IS NOT DISTINCT FROM NEW."card_brand"
      AND p."card_last_four" IS NOT DISTINCT FROM NEW."card_last_four"
      AND p."installments" = NEW."installments"
      AND p."authorized_at" IS NOT DISTINCT FROM NEW."provider_occurred_at"
      AND p."captured_at" IS NOT DISTINCT FROM NEW."provider_occurred_at"
  ) THEN RAISE EXCEPTION 'consumed pos payment evidence does not match sale payment' USING ERRCODE = '22000'; END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "pos_payment_intents_consumed_evidence_guard"
BEFORE UPDATE ON "pos_payment_intents"
FOR EACH ROW EXECUTE FUNCTION "protect_consumed_pos_payment_evidence"();

CREATE FUNCTION "protect_intent_bound_sale_payment_evidence"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF OLD."payment_intent_id" IS NOT NULL AND (
    OLD."payment_intent_id" IS DISTINCT FROM NEW."payment_intent_id"
    OR OLD."sale_id" IS DISTINCT FROM NEW."sale_id"
    OR OLD."connector_id" IS DISTINCT FROM NEW."connector_id"
    OR OLD."processing_session_id" IS DISTINCT FROM NEW."processing_session_id"
    OR OLD."type" IS DISTINCT FROM NEW."type"
    OR OLD."method" IS DISTINCT FROM NEW."method"
    OR OLD."amount_cents" IS DISTINCT FROM NEW."amount_cents"
    OR OLD."tendered_cents" IS DISTINCT FROM NEW."tendered_cents"
    OR OLD."change_cents" IS DISTINCT FROM NEW."change_cents"
    OR OLD."provider" IS DISTINCT FROM NEW."provider"
    OR OLD."transaction_id" IS DISTINCT FROM NEW."transaction_id"
    OR OLD."end_to_end_id" IS DISTINCT FROM NEW."end_to_end_id"
    OR OLD."nsu" IS DISTINCT FROM NEW."nsu"
    OR OLD."authorization_code" IS DISTINCT FROM NEW."authorization_code"
    OR OLD."card_brand" IS DISTINCT FROM NEW."card_brand"
    OR OLD."card_last_four" IS DISTINCT FROM NEW."card_last_four"
    OR OLD."installments" IS DISTINCT FROM NEW."installments"
    OR OLD."authorized_at" IS DISTINCT FROM NEW."authorized_at"
    OR OLD."captured_at" IS DISTINCT FROM NEW."captured_at"
    OR OLD."created_at" IS DISTINCT FROM NEW."created_at"
  ) THEN RAISE EXCEPTION 'intent-bound sale payment evidence is immutable' USING ERRCODE = '55000'; END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "pos_sale_payments_intent_evidence_guard"
BEFORE UPDATE ON "pos_sale_payments"
FOR EACH ROW EXECUTE FUNCTION "protect_intent_bound_sale_payment_evidence"();
