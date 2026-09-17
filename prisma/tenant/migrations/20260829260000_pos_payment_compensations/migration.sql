-- Separate lifecycle for electronic void/refund operations. This foundation
-- reserves value before dispatch and keeps provider confirmation independent
-- from local application. It does not enable any production provider adapter.

CREATE TABLE "pos_payment_compensations" (
  "id" TEXT NOT NULL,
  "branch_id" INTEGER NOT NULL,
  "register_id" INTEGER NOT NULL,
  "session_id" INTEGER NOT NULL,
  "requester_profile_id" INTEGER NOT NULL,
  "terminal_id" TEXT,
  "connector_id" TEXT NOT NULL,
  "credential_ref" TEXT NOT NULL,
  "original_intent_id" TEXT NOT NULL,
  "original_payment_id" TEXT NOT NULL,
  "sale_id" INTEGER NOT NULL,
  "return_id" TEXT,
  "approval_id" TEXT NOT NULL,
  "kind" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'requested',
  "provider_state" TEXT NOT NULL DEFAULT 'pending',
  "application_state" TEXT NOT NULL DEFAULT 'not_ready',
  "version" INTEGER NOT NULL DEFAULT 0,
  "requested_amount_cents" INTEGER NOT NULL,
  "confirmed_amount_cents" INTEGER,
  "currency" TEXT NOT NULL DEFAULT 'BRL',
  "method" TEXT NOT NULL,
  "provider" TEXT NOT NULL,
  "original_provider_reference" TEXT NOT NULL,
  "provider_operation_reference" TEXT,
  "provider_sequence" BIGINT,
  "provider_occurred_at" TIMESTAMPTZ,
  "evidence_hash" TEXT,
  "failure_code" TEXT,
  "failure_message" TEXT,
  "unknown_since" TIMESTAMPTZ,
  "next_reconcile_at" TIMESTAMPTZ,
  "idempotency_key" TEXT NOT NULL,
  "request_hash" TEXT NOT NULL,
  "provider_result_persisted_at" TIMESTAMPTZ,
  "applied_at" TIMESTAMPTZ,
  "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "pos_payment_compensations_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "pos_payment_compensations_kind_check" CHECK ("kind" IN ('void', 'refund')),
  CONSTRAINT "pos_payment_compensations_status_check" CHECK ("status" IN ('requested', 'processing', 'unknown', 'provider_succeeded', 'application_pending', 'applied', 'declined', 'manual_review', 'cancelled')),
  CONSTRAINT "pos_payment_compensations_provider_state_check" CHECK ("provider_state" IN ('pending', 'processing', 'unknown', 'succeeded', 'declined', 'manual_review', 'cancelled')),
  CONSTRAINT "pos_payment_compensations_application_state_check" CHECK ("application_state" IN ('not_ready', 'pending', 'applying', 'applied', 'blocked')),
  CONSTRAINT "pos_payment_compensations_values_check" CHECK (
    "version" >= 0
    AND "requested_amount_cents" > 0
    AND ("confirmed_amount_cents" IS NULL OR "confirmed_amount_cents" > 0)
    AND "currency" = 'BRL'
    AND "method" IN ('pix', 'credit', 'debit', 'voucher')
    AND char_length("provider") BETWEEN 2 AND 80
    AND char_length("original_provider_reference") BETWEEN 1 AND 160
    AND ("provider_operation_reference" IS NULL OR char_length("provider_operation_reference") BETWEEN 1 AND 160)
    AND char_length("idempotency_key") BETWEEN 16 AND 160
    AND "request_hash" ~ '^[0-9a-f]{64}$'
    AND ("evidence_hash" IS NULL OR "evidence_hash" ~ '^[0-9a-f]{64}$')
    AND ("provider_sequence" IS NULL OR "provider_sequence" > 0)
  ),
  CONSTRAINT "pos_payment_compensations_unknown_check" CHECK (
    ("provider_state" = 'unknown') = ("unknown_since" IS NOT NULL AND "next_reconcile_at" IS NOT NULL)
  ),
  CONSTRAINT "pos_payment_compensations_provider_result_check" CHECK (
    ("provider_state" = 'succeeded') = (
      "confirmed_amount_cents" = "requested_amount_cents"
      AND "provider_operation_reference" IS NOT NULL
      AND "provider_occurred_at" IS NOT NULL
      AND "evidence_hash" IS NOT NULL
      AND "provider_result_persisted_at" IS NOT NULL
    )
  ),
  CONSTRAINT "pos_payment_compensations_application_check" CHECK (
    ("application_state" = 'applied') = ("status" = 'applied' AND "provider_state" = 'succeeded' AND "applied_at" IS NOT NULL)
    AND ("status" <> 'applied' OR "application_state" = 'applied')
    AND ("application_state" NOT IN ('pending', 'applying', 'blocked') OR "provider_state" = 'succeeded')
  ),
  CONSTRAINT "pos_payment_compensations_session_register_fkey" FOREIGN KEY ("session_id", "register_id") REFERENCES "cash_register_sessions"("id", "register_id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "pos_payment_compensations_register_branch_fkey" FOREIGN KEY ("register_id", "branch_id") REFERENCES "pos_registers"("id", "branch_id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "pos_payment_compensations_connector_branch_provider_fkey" FOREIGN KEY ("connector_id", "branch_id", "provider") REFERENCES "pos_connectors"("id", "branch_id", "provider") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "pos_payment_compensations_branch_id_fkey" FOREIGN KEY ("branch_id") REFERENCES "branches"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "pos_payment_compensations_register_id_fkey" FOREIGN KEY ("register_id") REFERENCES "pos_registers"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "pos_payment_compensations_session_id_fkey" FOREIGN KEY ("session_id") REFERENCES "cash_register_sessions"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "pos_payment_compensations_requester_profile_id_fkey" FOREIGN KEY ("requester_profile_id") REFERENCES "tenant_user_profiles"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "pos_payment_compensations_terminal_id_fkey" FOREIGN KEY ("terminal_id") REFERENCES "pos_terminals"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "pos_payment_compensations_connector_id_fkey" FOREIGN KEY ("connector_id") REFERENCES "pos_connectors"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "pos_payment_compensations_credential_ref_fkey" FOREIGN KEY ("credential_ref") REFERENCES "integration_credentials"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "pos_payment_compensations_original_intent_id_fkey" FOREIGN KEY ("original_intent_id") REFERENCES "pos_payment_intents"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "pos_payment_compensations_original_payment_id_fkey" FOREIGN KEY ("original_payment_id") REFERENCES "pos_sale_payments"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "pos_payment_compensations_sale_id_fkey" FOREIGN KEY ("sale_id") REFERENCES "sales"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "pos_payment_compensations_return_id_fkey" FOREIGN KEY ("return_id") REFERENCES "pos_returns"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "pos_payment_compensations_approval_id_fkey" FOREIGN KEY ("approval_id") REFERENCES "pos_approvals"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "pos_payment_compensations_idempotency_key_key" ON "pos_payment_compensations"("idempotency_key");
CREATE UNIQUE INDEX "pos_payment_compensations_provider_operation_reference_key" ON "pos_payment_compensations"("provider", "provider_operation_reference") WHERE "provider_operation_reference" IS NOT NULL;
CREATE INDEX "pos_payment_compensations_original_payment_id_status_idx" ON "pos_payment_compensations"("original_payment_id", "status");
CREATE INDEX "pos_payment_compensations_session_id_status_idx" ON "pos_payment_compensations"("session_id", "status");
CREATE INDEX "pos_payment_compensations_status_next_reconcile_at_idx" ON "pos_payment_compensations"("status", "next_reconcile_at");
CREATE INDEX "pos_payment_compensations_credential_ref_status_idx" ON "pos_payment_compensations"("credential_ref", "status");
CREATE INDEX "pos_payment_compensations_return_id_status_idx" ON "pos_payment_compensations"("return_id", "status");

ALTER TABLE "pos_sale_payments" ADD COLUMN "compensation_id" TEXT;
CREATE UNIQUE INDEX "pos_sale_payments_compensation_id_key" ON "pos_sale_payments"("compensation_id") WHERE "compensation_id" IS NOT NULL;
ALTER TABLE "pos_sale_payments" ADD CONSTRAINT "pos_sale_payments_compensation_id_fkey"
  FOREIGN KEY ("compensation_id") REFERENCES "pos_payment_compensations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE TABLE "pos_payment_compensation_attempts" (
  "id" TEXT NOT NULL,
  "compensation_id" TEXT NOT NULL,
  "sequence" INTEGER NOT NULL,
  "operation" TEXT NOT NULL,
  "state" TEXT NOT NULL DEFAULT 'queued',
  "operation_key" TEXT NOT NULL,
  "request_hash" TEXT NOT NULL,
  "provider_idempotency_key" TEXT NOT NULL,
  "dispatch_count" INTEGER NOT NULL DEFAULT 0,
  "outcome_unknown" BOOLEAN NOT NULL DEFAULT false,
  "response_hash" TEXT,
  "failure_code" TEXT,
  "started_at" TIMESTAMPTZ,
  "finished_at" TIMESTAMPTZ,
  "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "pos_payment_compensation_attempts_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "pos_payment_compensation_attempts_operation_check" CHECK ("operation" IN ('void', 'refund', 'query')),
  CONSTRAINT "pos_payment_compensation_attempts_state_check" CHECK ("state" IN ('queued', 'claimed', 'retry', 'succeeded', 'unknown', 'failed')),
  CONSTRAINT "pos_payment_compensation_attempts_values_check" CHECK (
    "sequence" > 0 AND "dispatch_count" >= 0
    AND char_length("operation_key") BETWEEN 16 AND 160
    AND char_length("provider_idempotency_key") BETWEEN 16 AND 160
    AND "request_hash" ~ '^[0-9a-f]{64}$'
    AND ("response_hash" IS NULL OR "response_hash" ~ '^[0-9a-f]{64}$')
  ),
  CONSTRAINT "pos_payment_compensation_attempts_completion_check" CHECK (
    ("state" IN ('succeeded', 'unknown', 'failed') AND "finished_at" IS NOT NULL)
    OR ("state" NOT IN ('succeeded', 'unknown', 'failed') AND "finished_at" IS NULL)
  ),
  CONSTRAINT "pos_payment_compensation_attempts_unknown_check" CHECK ("outcome_unknown" = ("state" = 'unknown')),
  CONSTRAINT "pos_payment_compensation_attempts_compensation_id_fkey" FOREIGN KEY ("compensation_id") REFERENCES "pos_payment_compensations"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "pos_payment_compensation_attempts_operation_key_key" ON "pos_payment_compensation_attempts"("operation_key");
CREATE UNIQUE INDEX "pos_payment_compensation_attempts_compensation_sequence_key" ON "pos_payment_compensation_attempts"("compensation_id", "sequence");
CREATE INDEX "pos_payment_compensation_attempts_compensation_created_idx" ON "pos_payment_compensation_attempts"("compensation_id", "created_at");

CREATE TABLE "pos_payment_compensation_outbox" (
  "id" BIGSERIAL NOT NULL,
  "attempt_id" TEXT NOT NULL,
  "state" TEXT NOT NULL DEFAULT 'pending',
  "delivery_count" INTEGER NOT NULL DEFAULT 0,
  "max_deliveries" INTEGER NOT NULL DEFAULT 8,
  "next_attempt_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "claim_token" TEXT,
  "claim_expires_at" TIMESTAMPTZ,
  "last_error_code" TEXT,
  "completed_at" TIMESTAMPTZ,
  "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "pos_payment_compensation_outbox_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "pos_payment_compensation_outbox_state_check" CHECK ("state" IN ('pending', 'claimed', 'retry', 'completed', 'dead')),
  CONSTRAINT "pos_payment_compensation_outbox_values_check" CHECK ("delivery_count" >= 0 AND "max_deliveries" BETWEEN 1 AND 20 AND "delivery_count" <= "max_deliveries"),
  CONSTRAINT "pos_payment_compensation_outbox_claim_check" CHECK (("state" = 'claimed') = ("claim_token" IS NOT NULL AND "claim_expires_at" IS NOT NULL)),
  CONSTRAINT "pos_payment_compensation_outbox_completion_check" CHECK (("state" IN ('completed', 'dead')) = ("completed_at" IS NOT NULL)),
  CONSTRAINT "pos_payment_compensation_outbox_attempt_id_fkey" FOREIGN KEY ("attempt_id") REFERENCES "pos_payment_compensation_attempts"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "pos_payment_compensation_outbox_attempt_id_key" ON "pos_payment_compensation_outbox"("attempt_id");
CREATE UNIQUE INDEX "pos_payment_compensation_outbox_claim_token_key" ON "pos_payment_compensation_outbox"("claim_token") WHERE "claim_token" IS NOT NULL;
CREATE INDEX "pos_payment_compensation_outbox_state_next_attempt_idx" ON "pos_payment_compensation_outbox"("state", "next_attempt_at");
CREATE INDEX "pos_payment_compensation_outbox_claim_expires_idx" ON "pos_payment_compensation_outbox"("claim_expires_at") WHERE "state" = 'claimed';

CREATE TABLE "pos_payment_compensation_callbacks" (
  "id" BIGSERIAL NOT NULL,
  "compensation_id" TEXT NOT NULL,
  "provider" TEXT NOT NULL,
  "event_id" TEXT NOT NULL,
  "payload_hash" TEXT NOT NULL,
  "signature_key_id" TEXT NOT NULL,
  "original_provider_reference" TEXT NOT NULL,
  "provider_operation_reference" TEXT NOT NULL,
  "reported_state" TEXT NOT NULL,
  "provider_sequence" BIGINT,
  "provider_occurred_at" TIMESTAMPTZ NOT NULL,
  "requested_amount_cents" INTEGER NOT NULL,
  "confirmed_amount_cents" INTEGER NOT NULL,
  "currency" TEXT NOT NULL,
  "evidence_hash" TEXT NOT NULL,
  "evidence" JSONB NOT NULL,
  "processing_result" TEXT NOT NULL,
  "resulting_state" TEXT NOT NULL,
  "resulting_version" INTEGER NOT NULL,
  "received_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "pos_payment_compensation_callbacks_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "pos_payment_compensation_callbacks_reported_state_check" CHECK ("reported_state" IN ('processing', 'unknown', 'succeeded', 'declined')),
  CONSTRAINT "pos_payment_compensation_callbacks_resulting_state_check" CHECK ("resulting_state" IN ('requested', 'processing', 'unknown', 'provider_succeeded', 'application_pending', 'applied', 'declined', 'manual_review', 'cancelled')),
  CONSTRAINT "pos_payment_compensation_callbacks_result_check" CHECK ("processing_result" IN ('applied', 'no_change', 'ignored_stale', 'rejected_context', 'rejected_transition', 'manual_review')),
  CONSTRAINT "pos_payment_compensation_callbacks_values_check" CHECK (
    char_length("event_id") BETWEEN 8 AND 160
    AND char_length("signature_key_id") BETWEEN 1 AND 160
    AND char_length("original_provider_reference") BETWEEN 1 AND 160
    AND char_length("provider_operation_reference") BETWEEN 1 AND 160
    AND "payload_hash" ~ '^[0-9a-f]{64}$'
    AND "evidence_hash" ~ '^[0-9a-f]{64}$'
    AND "requested_amount_cents" > 0 AND "confirmed_amount_cents" > 0
    AND "currency" = 'BRL' AND "resulting_version" >= 0
    AND ("provider_sequence" IS NULL OR "provider_sequence" > 0)
  ),
  CONSTRAINT "pos_payment_compensation_callbacks_compensation_id_fkey" FOREIGN KEY ("compensation_id") REFERENCES "pos_payment_compensations"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "pos_payment_compensation_callbacks_provider_event_key" ON "pos_payment_compensation_callbacks"("provider", "event_id");
CREATE INDEX "pos_payment_compensation_callbacks_compensation_received_idx" ON "pos_payment_compensation_callbacks"("compensation_id", "received_at");

CREATE TABLE "pos_payment_compensation_state_events" (
  "id" BIGSERIAL NOT NULL,
  "compensation_id" TEXT NOT NULL,
  "attempt_id" TEXT,
  "event_key" TEXT NOT NULL,
  "source" TEXT NOT NULL,
  "source_id" TEXT NOT NULL,
  "from_state" TEXT,
  "to_state" TEXT NOT NULL,
  "resulting_version" INTEGER NOT NULL,
  "provider_occurred_at" TIMESTAMPTZ,
  "evidence_hash" TEXT,
  "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "pos_payment_compensation_state_events_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "pos_payment_compensation_state_events_state_check" CHECK (
    ("from_state" IS NULL OR "from_state" IN ('requested', 'processing', 'unknown', 'provider_succeeded', 'application_pending', 'applied', 'declined', 'manual_review', 'cancelled'))
    AND "to_state" IN ('requested', 'processing', 'unknown', 'provider_succeeded', 'application_pending', 'applied', 'declined', 'manual_review', 'cancelled')
  ),
  CONSTRAINT "pos_payment_compensation_state_events_values_check" CHECK ("resulting_version" >= 0 AND ("evidence_hash" IS NULL OR "evidence_hash" ~ '^[0-9a-f]{64}$')),
  CONSTRAINT "pos_payment_compensation_state_events_compensation_id_fkey" FOREIGN KEY ("compensation_id") REFERENCES "pos_payment_compensations"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "pos_payment_compensation_state_events_attempt_id_fkey" FOREIGN KEY ("attempt_id") REFERENCES "pos_payment_compensation_attempts"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "pos_payment_compensation_state_events_event_key_key" ON "pos_payment_compensation_state_events"("event_key");
CREATE UNIQUE INDEX "pos_payment_compensation_state_events_version_key" ON "pos_payment_compensation_state_events"("compensation_id", "resulting_version");
CREATE INDEX "pos_payment_compensation_state_events_created_idx" ON "pos_payment_compensation_state_events"("compensation_id", "created_at");

CREATE TABLE "pos_payment_compensation_delivery_results" (
  "id" BIGSERIAL NOT NULL,
  "compensation_id" TEXT NOT NULL,
  "attempt_id" TEXT NOT NULL,
  "outbox_id" BIGINT NOT NULL,
  "delivery_number" INTEGER NOT NULL,
  "claim_token_hash" TEXT NOT NULL,
  "response_hash" TEXT NOT NULL,
  "result_kind" TEXT NOT NULL,
  "retry_scheduled" BOOLEAN NOT NULL DEFAULT false,
  "superseded" BOOLEAN NOT NULL DEFAULT false,
  "resulting_attempt_state" TEXT NOT NULL,
  "resulting_compensation_state" TEXT NOT NULL,
  "resulting_compensation_version" INTEGER NOT NULL,
  "completed_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "pos_payment_compensation_delivery_results_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "pos_payment_compensation_delivery_results_kind_check" CHECK ("result_kind" IN ('result', 'unknown', 'known_failure')),
  CONSTRAINT "pos_payment_compensation_delivery_results_attempt_state_check" CHECK ("resulting_attempt_state" IN ('queued', 'claimed', 'retry', 'succeeded', 'unknown', 'failed')),
  CONSTRAINT "pos_payment_compensation_delivery_results_compensation_state_check" CHECK ("resulting_compensation_state" IN ('requested', 'processing', 'unknown', 'provider_succeeded', 'application_pending', 'applied', 'declined', 'manual_review', 'cancelled')),
  CONSTRAINT "pos_payment_compensation_delivery_results_values_check" CHECK (
    "delivery_number" > 0 AND "resulting_compensation_version" >= 0
    AND "claim_token_hash" ~ '^[0-9a-f]{64}$' AND "response_hash" ~ '^[0-9a-f]{64}$'
  ),
  CONSTRAINT "pos_payment_compensation_delivery_results_compensation_id_fkey" FOREIGN KEY ("compensation_id") REFERENCES "pos_payment_compensations"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "pos_payment_compensation_delivery_results_attempt_id_fkey" FOREIGN KEY ("attempt_id") REFERENCES "pos_payment_compensation_attempts"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "pos_payment_compensation_delivery_results_outbox_id_fkey" FOREIGN KEY ("outbox_id") REFERENCES "pos_payment_compensation_outbox"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "pos_payment_compensation_delivery_claim_key" ON "pos_payment_compensation_delivery_results"("claim_token_hash");
CREATE UNIQUE INDEX "pos_payment_compensation_delivery_attempt_number_key" ON "pos_payment_compensation_delivery_results"("attempt_id", "delivery_number");
CREATE INDEX "pos_payment_compensation_delivery_completed_idx" ON "pos_payment_compensation_delivery_results"("compensation_id", "completed_at");

CREATE TABLE "pos_payment_compensation_incidents" (
  "id" TEXT NOT NULL,
  "compensation_id" TEXT NOT NULL,
  "callback_id" BIGINT,
  "kind" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'open',
  "production_blocking" BOOLEAN NOT NULL DEFAULT true,
  "expected_amount_cents" INTEGER NOT NULL,
  "reported_amount_cents" INTEGER NOT NULL,
  "expected_evidence_hash" TEXT NOT NULL,
  "reported_evidence_hash" TEXT NOT NULL,
  "details" JSONB,
  "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "resolved_at" TIMESTAMPTZ,
  "resolved_by_actor_id" TEXT,
  "resolution_reason" TEXT,
  CONSTRAINT "pos_payment_compensation_incidents_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "pos_payment_compensation_incidents_kind_check" CHECK ("kind" IN ('amount_mismatch', 'reference_mismatch', 'evidence_mismatch', 'contradictory_result', 'unsolicited_refund', 'application_failure')),
  CONSTRAINT "pos_payment_compensation_incidents_status_check" CHECK ("status" IN ('open', 'acknowledged', 'resolved')),
  CONSTRAINT "pos_payment_compensation_incidents_values_check" CHECK (
    "expected_amount_cents" >= 0 AND "reported_amount_cents" >= 0
    AND "expected_evidence_hash" ~ '^[0-9a-f]{64}$' AND "reported_evidence_hash" ~ '^[0-9a-f]{64}$'
    AND (("status" = 'resolved') = ("resolved_at" IS NOT NULL AND "resolved_by_actor_id" IS NOT NULL AND "resolution_reason" IS NOT NULL))
  ),
  CONSTRAINT "pos_payment_compensation_incidents_compensation_id_fkey" FOREIGN KEY ("compensation_id") REFERENCES "pos_payment_compensations"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "pos_payment_compensation_incidents_callback_id_fkey" FOREIGN KEY ("callback_id") REFERENCES "pos_payment_compensation_callbacks"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "pos_payment_compensation_incidents_callback_id_key" ON "pos_payment_compensation_incidents"("callback_id") WHERE "callback_id" IS NOT NULL;
CREATE INDEX "pos_payment_compensation_incidents_status_blocking_idx" ON "pos_payment_compensation_incidents"("status", "production_blocking", "created_at");
CREATE INDEX "pos_payment_compensation_incidents_compensation_status_idx" ON "pos_payment_compensation_incidents"("compensation_id", "status");

CREATE FUNCTION "protect_pos_payment_compensation_history"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'payment compensation history is immutable' USING ERRCODE = '55000'; END IF;
  IF OLD."id" IS DISTINCT FROM NEW."id"
    OR OLD."branch_id" IS DISTINCT FROM NEW."branch_id"
    OR OLD."register_id" IS DISTINCT FROM NEW."register_id"
    OR OLD."session_id" IS DISTINCT FROM NEW."session_id"
    OR OLD."requester_profile_id" IS DISTINCT FROM NEW."requester_profile_id"
    OR OLD."terminal_id" IS DISTINCT FROM NEW."terminal_id"
    OR OLD."connector_id" IS DISTINCT FROM NEW."connector_id"
    OR OLD."credential_ref" IS DISTINCT FROM NEW."credential_ref"
    OR OLD."original_intent_id" IS DISTINCT FROM NEW."original_intent_id"
    OR OLD."original_payment_id" IS DISTINCT FROM NEW."original_payment_id"
    OR OLD."sale_id" IS DISTINCT FROM NEW."sale_id"
    OR OLD."return_id" IS DISTINCT FROM NEW."return_id"
    OR OLD."approval_id" IS DISTINCT FROM NEW."approval_id"
    OR OLD."kind" IS DISTINCT FROM NEW."kind"
    OR OLD."requested_amount_cents" IS DISTINCT FROM NEW."requested_amount_cents"
    OR OLD."currency" IS DISTINCT FROM NEW."currency"
    OR OLD."method" IS DISTINCT FROM NEW."method"
    OR OLD."provider" IS DISTINCT FROM NEW."provider"
    OR OLD."original_provider_reference" IS DISTINCT FROM NEW."original_provider_reference"
    OR OLD."idempotency_key" IS DISTINCT FROM NEW."idempotency_key"
    OR OLD."request_hash" IS DISTINCT FROM NEW."request_hash"
    OR OLD."created_at" IS DISTINCT FROM NEW."created_at"
  THEN RAISE EXCEPTION 'payment compensation request is immutable' USING ERRCODE = '55000'; END IF;
  IF NEW."version" < OLD."version" THEN RAISE EXCEPTION 'payment compensation version cannot regress' USING ERRCODE = '22000'; END IF;
  IF OLD."provider_result_persisted_at" IS NOT NULL AND (
    NEW."provider_state" IS DISTINCT FROM OLD."provider_state"
    OR NEW."confirmed_amount_cents" IS DISTINCT FROM OLD."confirmed_amount_cents"
    OR NEW."provider_operation_reference" IS DISTINCT FROM OLD."provider_operation_reference"
    OR NEW."provider_occurred_at" IS DISTINCT FROM OLD."provider_occurred_at"
    OR NEW."evidence_hash" IS DISTINCT FROM OLD."evidence_hash"
    OR NEW."provider_result_persisted_at" IS DISTINCT FROM OLD."provider_result_persisted_at"
  ) THEN RAISE EXCEPTION 'persisted provider compensation result is immutable' USING ERRCODE = '55000'; END IF;
  IF OLD."applied_at" IS NOT NULL AND NEW."applied_at" IS DISTINCT FROM OLD."applied_at" THEN
    RAISE EXCEPTION 'payment compensation application is immutable' USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER "pos_payment_compensations_history_guard"
BEFORE UPDATE OR DELETE ON "pos_payment_compensations"
FOR EACH ROW EXECUTE FUNCTION "protect_pos_payment_compensation_history"();

CREATE FUNCTION "lock_pos_payment_compensation_original"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  PERFORM 1 FROM "pos_sale_payments" WHERE "id" = NEW."original_payment_id" FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'original payment not found for compensation' USING ERRCODE = '23503'; END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER "pos_payment_compensations_original_lock"
BEFORE INSERT ON "pos_payment_compensations"
FOR EACH ROW EXECUTE FUNCTION "lock_pos_payment_compensation_original"();

CREATE FUNCTION "protect_pos_sale_payment_compensation_link"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND OLD."compensation_id" IS DISTINCT FROM NEW."compensation_id" THEN
    RAISE EXCEPTION 'payment compensation link is immutable' USING ERRCODE = '55000';
  END IF;
  IF NEW."compensation_id" IS NOT NULL AND NEW."type" <> 'refund' THEN
    RAISE EXCEPTION 'only refund payments may reference a compensation' USING ERRCODE = '22000';
  END IF;
  IF NEW."type" = 'refund' AND NEW."method" IN ('pix', 'credit', 'debit', 'voucher') AND NEW."compensation_id" IS NULL THEN
    RAISE EXCEPTION 'electronic refund requires a persisted compensation' USING ERRCODE = '22000';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER "pos_sale_payments_compensation_link_guard"
BEFORE INSERT OR UPDATE ON "pos_sale_payments"
FOR EACH ROW EXECUTE FUNCTION "protect_pos_sale_payment_compensation_link"();

CREATE FUNCTION "validate_pos_payment_compensation_context"() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  original_record "pos_sale_payments"%ROWTYPE;
  intent_record "pos_payment_intents"%ROWTYPE;
  reserved_total BIGINT;
  applied_count BIGINT;
BEGIN
  SELECT * INTO original_record FROM "pos_sale_payments" WHERE "id" = NEW."original_payment_id";
  SELECT * INTO intent_record FROM "pos_payment_intents" WHERE "id" = NEW."original_intent_id";
  IF original_record."id" IS NULL OR intent_record."id" IS NULL
    OR original_record."type" <> 'payment'
    OR original_record."sale_id" <> NEW."sale_id"
    OR original_record."payment_intent_id" <> NEW."original_intent_id"
    OR original_record."method" <> NEW."method"
    OR original_record."provider" IS DISTINCT FROM NEW."provider"
    OR original_record."connector_id" IS DISTINCT FROM NEW."connector_id"
    OR intent_record."branch_id" <> NEW."branch_id"
    OR intent_record."connector_id" <> NEW."connector_id"
    OR intent_record."credential_ref" <> NEW."credential_ref"
    OR intent_record."provider" <> NEW."provider"
    OR intent_record."method" <> NEW."method"
    OR intent_record."amount_cents" <> original_record."amount_cents"
    OR intent_record."provider_reference" IS DISTINCT FROM NEW."original_provider_reference"
  THEN RAISE EXCEPTION 'payment compensation does not match the original payment evidence' USING ERRCODE = '22000'; END IF;

  IF NEW."return_id" IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM "pos_returns" returned
    WHERE returned."id" = NEW."return_id" AND returned."sale_id" = NEW."sale_id"
      AND returned."total_refund_cents" >= NEW."requested_amount_cents"
  ) THEN RAISE EXCEPTION 'payment compensation does not match the return' USING ERRCODE = '22000'; END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM "pos_approvals" approval
    JOIN "tenant_user_profiles" requester ON requester."id" = NEW."requester_profile_id"
    WHERE approval."id" = NEW."approval_id"
      AND approval."branch_id" = NEW."branch_id"
      AND approval."entity_type" = 'sale'
      AND approval."entity_id" = NEW."sale_id"::text
      AND approval."action" = CASE WHEN NEW."return_id" IS NULL THEN 'sale.cancel' ELSE 'return.create' END
      AND approval."status" = 'approved'
      AND approval."requester_id" = requester."user_id"
      AND approval."approver_id" IS NOT NULL
      AND approval."approver_id" <> approval."requester_id"
  ) THEN RAISE EXCEPTION 'payment compensation requires an exact independent approval' USING ERRCODE = '22000'; END IF;

  SELECT COALESCE(sum("requested_amount_cents"), 0) INTO reserved_total
  FROM "pos_payment_compensations"
  WHERE "original_payment_id" = NEW."original_payment_id" AND "status" NOT IN ('declined', 'cancelled');
  IF reserved_total > original_record."amount_cents" THEN
    RAISE EXCEPTION 'payment compensation exceeds the original payment' USING ERRCODE = '22000';
  END IF;

  IF NEW."status" = 'applied' THEN
    SELECT count(*) INTO applied_count FROM "pos_sale_payments"
    WHERE "compensation_id" = NEW."id" AND "type" = 'refund'
      AND "original_payment_id" = NEW."original_payment_id"
      AND "sale_id" = NEW."sale_id" AND "method" = NEW."method"
      AND "provider" IS NOT DISTINCT FROM NEW."provider"
      AND "amount_cents" = NEW."confirmed_amount_cents";
    IF applied_count <> 1 THEN RAISE EXCEPTION 'applied compensation requires exactly one matching refund' USING ERRCODE = '22000'; END IF;
  END IF;
  RETURN NEW;
END;
$$;
CREATE CONSTRAINT TRIGGER "pos_payment_compensations_context_guard"
AFTER INSERT OR UPDATE ON "pos_payment_compensations"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION "validate_pos_payment_compensation_context"();

CREATE FUNCTION "validate_pos_sale_payment_refund_balance"() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  original_id TEXT;
  original_record "pos_sale_payments"%ROWTYPE;
  refunded_total BIGINT;
  compensation_record "pos_payment_compensations"%ROWTYPE;
BEGIN
  original_id := CASE WHEN NEW."type" = 'refund' THEN NEW."original_payment_id" ELSE NEW."id" END;
  IF original_id IS NULL THEN RETURN NEW; END IF;
  SELECT * INTO original_record FROM "pos_sale_payments" WHERE "id" = original_id AND "type" = 'payment';
  IF original_record."id" IS NULL THEN RETURN NEW; END IF;
  SELECT COALESCE(sum("amount_cents"), 0) INTO refunded_total FROM "pos_sale_payments"
    WHERE "type" = 'refund' AND "original_payment_id" = original_id;
  IF refunded_total > original_record."amount_cents" THEN
    RAISE EXCEPTION 'refund total exceeds the original payment' USING ERRCODE = '22000';
  END IF;
  IF refunded_total = original_record."amount_cents" AND original_record."status" <> 'refunded' THEN
    RAISE EXCEPTION 'fully refunded payment must have refunded status' USING ERRCODE = '22000';
  END IF;
  IF refunded_total > 0 AND refunded_total < original_record."amount_cents" AND original_record."status" <> 'partially_refunded' THEN
    RAISE EXCEPTION 'partially refunded payment must have partially_refunded status' USING ERRCODE = '22000';
  END IF;

  IF NEW."type" = 'refund' AND NEW."compensation_id" IS NOT NULL THEN
    SELECT * INTO compensation_record FROM "pos_payment_compensations" WHERE "id" = NEW."compensation_id";
    IF compensation_record."id" IS NULL
      OR compensation_record."status" <> 'applied'
      OR compensation_record."application_state" <> 'applied'
      OR compensation_record."provider_state" <> 'succeeded'
      OR compensation_record."original_payment_id" <> NEW."original_payment_id"
      OR compensation_record."sale_id" <> NEW."sale_id"
      OR compensation_record."method" <> NEW."method"
      OR compensation_record."provider" IS DISTINCT FROM NEW."provider"
      OR compensation_record."confirmed_amount_cents" <> NEW."amount_cents"
    THEN RAISE EXCEPTION 'electronic refund does not match its applied compensation' USING ERRCODE = '22000'; END IF;
  END IF;
  RETURN NEW;
END;
$$;
CREATE CONSTRAINT TRIGGER "pos_sale_payments_refund_balance_guard"
AFTER INSERT OR UPDATE ON "pos_sale_payments"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION "validate_pos_sale_payment_refund_balance"();
