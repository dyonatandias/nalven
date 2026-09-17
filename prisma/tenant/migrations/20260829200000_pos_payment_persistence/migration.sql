-- Provider-agnostic persistence for electronic payment intents. This migration
-- deliberately does not install or claim conformance with any PSP adapter.

CREATE UNIQUE INDEX "pos_connectors_id_branch_id_provider_key"
  ON "pos_connectors"("id", "branch_id", "provider");

CREATE TABLE "pos_payment_intents" (
  "id" TEXT NOT NULL,
  "branch_id" INTEGER NOT NULL,
  "register_id" INTEGER NOT NULL,
  "session_id" INTEGER NOT NULL,
  "operator_profile_id" INTEGER NOT NULL,
  "terminal_id" TEXT,
  "connector_id" TEXT NOT NULL,
  "sale_draft_id" TEXT NOT NULL,
  "payment_index" INTEGER NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'created',
  "version" INTEGER NOT NULL DEFAULT 0,
  "amount_cents" INTEGER NOT NULL,
  "currency" TEXT NOT NULL DEFAULT 'BRL',
  "method" TEXT NOT NULL,
  "installments" INTEGER NOT NULL DEFAULT 1,
  "provider" TEXT NOT NULL,
  "provider_reference" TEXT,
  "transaction_id" TEXT,
  "end_to_end_id" TEXT,
  "nsu" TEXT,
  "authorization_code" TEXT,
  "card_brand" TEXT,
  "card_last_four" TEXT,
  "evidence_id" TEXT,
  "failure_code" TEXT,
  "failure_message" TEXT,
  "provider_sequence" BIGINT,
  "provider_occurred_at" TIMESTAMPTZ,
  "unknown_since" TIMESTAMPTZ,
  "next_reconcile_at" TIMESTAMPTZ,
  "expires_at" TIMESTAMPTZ NOT NULL,
  "idempotency_key" TEXT NOT NULL,
  "request_hash" TEXT NOT NULL,
  "consumed_at" TIMESTAMPTZ,
  "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "pos_payment_intents_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "pos_payment_intents_status_check" CHECK ("status" IN ('created', 'processing', 'authorized', 'captured', 'declined', 'unknown', 'manual_review', 'cancelled', 'partially_refunded', 'refunded')),
  CONSTRAINT "pos_payment_intents_context_check" CHECK (
    "version" >= 0
    AND "amount_cents" > 0
    AND "payment_index" BETWEEN 0 AND 9
    AND "currency" = 'BRL'
    AND "method" IN ('pix', 'credit', 'debit', 'voucher')
    AND "installments" BETWEEN 1 AND 24
    AND ("method" = 'credit' OR "installments" = 1)
    AND char_length("sale_draft_id") BETWEEN 16 AND 160
    AND char_length("provider") BETWEEN 2 AND 80
    AND char_length("idempotency_key") BETWEEN 16 AND 160
    AND "request_hash" ~ '^[0-9a-f]{64}$'
    AND "expires_at" > "created_at"
  ),
  CONSTRAINT "pos_payment_intents_provider_sequence_check" CHECK ("provider_sequence" IS NULL OR "provider_sequence" > 0),
  CONSTRAINT "pos_payment_intents_card_last_four_check" CHECK ("card_last_four" IS NULL OR "card_last_four" ~ '^[0-9]{4}$'),
  CONSTRAINT "pos_payment_intents_uncertain_check" CHECK (
    ("status" IN ('processing', 'authorized', 'unknown', 'manual_review') AND "next_reconcile_at" IS NOT NULL)
    OR ("status" NOT IN ('processing', 'authorized', 'unknown', 'manual_review') AND "next_reconcile_at" IS NULL)
  ),
  CONSTRAINT "pos_payment_intents_unknown_check" CHECK ("status" <> 'unknown' OR "unknown_since" IS NOT NULL),
  CONSTRAINT "pos_payment_intents_captured_evidence_check" CHECK (
    "status" NOT IN ('authorized', 'captured', 'partially_refunded', 'refunded')
    OR ("provider_reference" IS NOT NULL AND "provider_occurred_at" IS NOT NULL)
  ),
  CONSTRAINT "pos_payment_intents_method_evidence_check" CHECK (
    (
      "method" = 'pix'
      AND ("end_to_end_id" IS NULL OR "end_to_end_id" ~ '^E[0-9]{16}[A-Z0-9]{15}$')
      AND "nsu" IS NULL
      AND "authorization_code" IS NULL
      AND "card_brand" IS NULL
      AND "card_last_four" IS NULL
      AND ("status" NOT IN ('authorized', 'captured', 'partially_refunded', 'refunded') OR "end_to_end_id" IS NOT NULL)
    )
    OR (
      "method" IN ('credit', 'debit', 'voucher')
      AND "end_to_end_id" IS NULL
      AND (
        "status" NOT IN ('authorized', 'captured', 'partially_refunded', 'refunded')
        OR ("transaction_id" IS NOT NULL AND "authorization_code" IS NOT NULL AND "card_last_four" IS NOT NULL)
      )
    )
  ),
  CONSTRAINT "pos_payment_intents_consumed_check" CHECK ("consumed_at" IS NULL OR "status" IN ('captured', 'partially_refunded', 'refunded'))
);

CREATE UNIQUE INDEX "pos_payment_intents_idempotency_key_key" ON "pos_payment_intents"("idempotency_key");
CREATE UNIQUE INDEX "pos_payment_intents_provider_reference_key" ON "pos_payment_intents"("provider", "provider_reference") WHERE "provider_reference" IS NOT NULL;
CREATE UNIQUE INDEX "pos_payment_intents_pix_e2e_tenant_key" ON "pos_payment_intents"(upper("end_to_end_id")) WHERE "method" = 'pix' AND "end_to_end_id" IS NOT NULL;
CREATE UNIQUE INDEX "pos_payment_intents_provider_transaction_tenant_key" ON "pos_payment_intents"("provider", lower("transaction_id")) WHERE "transaction_id" IS NOT NULL;
CREATE INDEX "pos_payment_intents_session_id_status_idx" ON "pos_payment_intents"("session_id", "status");
CREATE INDEX "pos_payment_intents_status_next_reconcile_at_idx" ON "pos_payment_intents"("status", "next_reconcile_at");
CREATE INDEX "pos_payment_intents_connector_id_created_at_idx" ON "pos_payment_intents"("connector_id", "created_at");
CREATE INDEX "pos_payment_intents_sale_draft_id_idx" ON "pos_payment_intents"("sale_draft_id");

ALTER TABLE "pos_payment_intents"
  ADD CONSTRAINT "pos_payment_intents_branch_id_fkey" FOREIGN KEY ("branch_id") REFERENCES "branches"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "pos_payment_intents_register_id_fkey" FOREIGN KEY ("register_id") REFERENCES "pos_registers"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "pos_payment_intents_session_id_fkey" FOREIGN KEY ("session_id") REFERENCES "cash_register_sessions"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "pos_payment_intents_operator_profile_id_fkey" FOREIGN KEY ("operator_profile_id") REFERENCES "tenant_user_profiles"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "pos_payment_intents_terminal_id_fkey" FOREIGN KEY ("terminal_id") REFERENCES "pos_terminals"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "pos_payment_intents_connector_id_fkey" FOREIGN KEY ("connector_id") REFERENCES "pos_connectors"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "pos_payment_intents_session_register_fkey" FOREIGN KEY ("session_id", "register_id") REFERENCES "cash_register_sessions"("id", "register_id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "pos_payment_intents_register_branch_fkey" FOREIGN KEY ("register_id", "branch_id") REFERENCES "pos_registers"("id", "branch_id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "pos_payment_intents_connector_branch_provider_fkey" FOREIGN KEY ("connector_id", "branch_id", "provider") REFERENCES "pos_connectors"("id", "branch_id", "provider") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE TABLE "pos_payment_attempts" (
  "id" TEXT NOT NULL,
  "intent_id" TEXT NOT NULL,
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
  CONSTRAINT "pos_payment_attempts_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "pos_payment_attempts_operation_check" CHECK ("operation" IN ('create', 'query', 'cancel', 'refund')),
  CONSTRAINT "pos_payment_attempts_state_check" CHECK ("state" IN ('queued', 'claimed', 'retry', 'succeeded', 'unknown', 'failed')),
  CONSTRAINT "pos_payment_attempts_values_check" CHECK (
    "sequence" > 0
    AND "dispatch_count" >= 0
    AND char_length("operation_key") BETWEEN 16 AND 160
    AND char_length("provider_idempotency_key") BETWEEN 16 AND 160
    AND "request_hash" ~ '^[0-9a-f]{64}$'
    AND ("response_hash" IS NULL OR "response_hash" ~ '^[0-9a-f]{64}$')
  ),
  CONSTRAINT "pos_payment_attempts_completion_check" CHECK (
    ("state" IN ('succeeded', 'unknown', 'failed') AND "finished_at" IS NOT NULL)
    OR ("state" NOT IN ('succeeded', 'unknown', 'failed') AND "finished_at" IS NULL)
  ),
  CONSTRAINT "pos_payment_attempts_unknown_check" CHECK ("outcome_unknown" = ("state" = 'unknown')),
  CONSTRAINT "pos_payment_attempts_intent_id_fkey" FOREIGN KEY ("intent_id") REFERENCES "pos_payment_intents"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "pos_payment_attempts_operation_key_key" ON "pos_payment_attempts"("operation_key");
CREATE UNIQUE INDEX "pos_payment_attempts_intent_id_sequence_key" ON "pos_payment_attempts"("intent_id", "sequence");
CREATE INDEX "pos_payment_attempts_intent_id_created_at_idx" ON "pos_payment_attempts"("intent_id", "created_at");

CREATE TABLE "pos_payment_outbox" (
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
  CONSTRAINT "pos_payment_outbox_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "pos_payment_outbox_state_check" CHECK ("state" IN ('pending', 'claimed', 'retry', 'completed', 'dead')),
  CONSTRAINT "pos_payment_outbox_values_check" CHECK ("delivery_count" >= 0 AND "max_deliveries" BETWEEN 1 AND 20 AND "delivery_count" <= "max_deliveries"),
  CONSTRAINT "pos_payment_outbox_claim_check" CHECK (("state" = 'claimed') = ("claim_token" IS NOT NULL AND "claim_expires_at" IS NOT NULL)),
  CONSTRAINT "pos_payment_outbox_completion_check" CHECK (("state" IN ('completed', 'dead')) = ("completed_at" IS NOT NULL)),
  CONSTRAINT "pos_payment_outbox_attempt_id_fkey" FOREIGN KEY ("attempt_id") REFERENCES "pos_payment_attempts"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "pos_payment_outbox_attempt_id_key" ON "pos_payment_outbox"("attempt_id");
CREATE UNIQUE INDEX "pos_payment_outbox_claim_token_key" ON "pos_payment_outbox"("claim_token") WHERE "claim_token" IS NOT NULL;
CREATE INDEX "pos_payment_outbox_state_next_attempt_at_idx" ON "pos_payment_outbox"("state", "next_attempt_at");
CREATE INDEX "pos_payment_outbox_claim_expires_at_idx" ON "pos_payment_outbox"("claim_expires_at") WHERE "state" = 'claimed';

CREATE TABLE "pos_payment_callbacks" (
  "id" BIGSERIAL NOT NULL,
  "intent_id" TEXT NOT NULL,
  "provider" TEXT NOT NULL,
  "event_id" TEXT NOT NULL,
  "payload_hash" TEXT NOT NULL,
  "signature_key_id" TEXT NOT NULL,
  "provider_reference" TEXT NOT NULL,
  "reported_state" TEXT NOT NULL,
  "provider_sequence" BIGINT,
  "provider_occurred_at" TIMESTAMPTZ NOT NULL,
  "amount_cents" INTEGER NOT NULL,
  "currency" TEXT NOT NULL,
  "evidence" JSONB NOT NULL,
  "processing_result" TEXT NOT NULL,
  "resulting_state" TEXT NOT NULL,
  "resulting_version" INTEGER NOT NULL,
  "received_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "pos_payment_callbacks_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "pos_payment_callbacks_state_check" CHECK ("reported_state" IN ('created', 'processing', 'authorized', 'captured', 'declined', 'unknown', 'manual_review', 'cancelled', 'partially_refunded', 'refunded')),
  CONSTRAINT "pos_payment_callbacks_resulting_state_check" CHECK ("resulting_state" IN ('created', 'processing', 'authorized', 'captured', 'declined', 'unknown', 'manual_review', 'cancelled', 'partially_refunded', 'refunded')),
  CONSTRAINT "pos_payment_callbacks_result_check" CHECK ("processing_result" IN ('applied', 'no_change', 'ignored_stale', 'rejected_context', 'rejected_transition')),
  CONSTRAINT "pos_payment_callbacks_values_check" CHECK (
    "amount_cents" > 0
    AND "currency" = 'BRL'
    AND "resulting_version" >= 0
    AND ("provider_sequence" IS NULL OR "provider_sequence" > 0)
    AND char_length("event_id") BETWEEN 8 AND 160
    AND char_length("signature_key_id") BETWEEN 1 AND 160
    AND char_length("provider_reference") BETWEEN 1 AND 160
    AND "payload_hash" ~ '^[0-9a-f]{64}$'
  ),
  CONSTRAINT "pos_payment_callbacks_intent_id_fkey" FOREIGN KEY ("intent_id") REFERENCES "pos_payment_intents"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "pos_payment_callbacks_provider_event_id_key" ON "pos_payment_callbacks"("provider", "event_id");
CREATE INDEX "pos_payment_callbacks_intent_id_received_at_idx" ON "pos_payment_callbacks"("intent_id", "received_at");

CREATE TABLE "pos_payment_state_events" (
  "id" BIGSERIAL NOT NULL,
  "intent_id" TEXT NOT NULL,
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
  CONSTRAINT "pos_payment_state_events_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "pos_payment_state_events_source_check" CHECK ("source" IN ('api', 'worker', 'callback', 'sale_commit', 'maintenance')),
  CONSTRAINT "pos_payment_state_events_state_check" CHECK (
    ("from_state" IS NULL OR "from_state" IN ('created', 'processing', 'authorized', 'captured', 'declined', 'unknown', 'manual_review', 'cancelled', 'partially_refunded', 'refunded'))
    AND "to_state" IN ('created', 'processing', 'authorized', 'captured', 'declined', 'unknown', 'manual_review', 'cancelled', 'partially_refunded', 'refunded')
  ),
  CONSTRAINT "pos_payment_state_events_values_check" CHECK (
    "resulting_version" >= 0
    AND char_length("event_key") BETWEEN 8 AND 200
    AND char_length("source_id") BETWEEN 1 AND 200
    AND ("evidence_hash" IS NULL OR "evidence_hash" ~ '^[0-9a-f]{64}$')
  ),
  CONSTRAINT "pos_payment_state_events_intent_id_fkey" FOREIGN KEY ("intent_id") REFERENCES "pos_payment_intents"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "pos_payment_state_events_attempt_id_fkey" FOREIGN KEY ("attempt_id") REFERENCES "pos_payment_attempts"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "pos_payment_state_events_event_key_key" ON "pos_payment_state_events"("event_key");
CREATE UNIQUE INDEX "pos_payment_state_events_intent_id_resulting_version_key" ON "pos_payment_state_events"("intent_id", "resulting_version");
CREATE INDEX "pos_payment_state_events_intent_id_created_at_idx" ON "pos_payment_state_events"("intent_id", "created_at");

ALTER TABLE "pos_sale_payments" ADD COLUMN "payment_intent_id" TEXT;
CREATE UNIQUE INDEX "pos_sale_payments_payment_intent_id_key" ON "pos_sale_payments"("payment_intent_id") WHERE "payment_intent_id" IS NOT NULL;
ALTER TABLE "pos_sale_payments" ADD CONSTRAINT "pos_sale_payments_payment_intent_id_fkey" FOREIGN KEY ("payment_intent_id") REFERENCES "pos_payment_intents"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE FUNCTION "protect_pos_payment_intent"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF OLD."id" IS DISTINCT FROM NEW."id"
    OR OLD."branch_id" IS DISTINCT FROM NEW."branch_id"
    OR OLD."register_id" IS DISTINCT FROM NEW."register_id"
    OR OLD."session_id" IS DISTINCT FROM NEW."session_id"
    OR OLD."operator_profile_id" IS DISTINCT FROM NEW."operator_profile_id"
    OR OLD."terminal_id" IS DISTINCT FROM NEW."terminal_id"
    OR OLD."connector_id" IS DISTINCT FROM NEW."connector_id"
    OR OLD."sale_draft_id" IS DISTINCT FROM NEW."sale_draft_id"
    OR OLD."payment_index" IS DISTINCT FROM NEW."payment_index"
    OR OLD."amount_cents" IS DISTINCT FROM NEW."amount_cents"
    OR OLD."currency" IS DISTINCT FROM NEW."currency"
    OR OLD."method" IS DISTINCT FROM NEW."method"
    OR OLD."installments" IS DISTINCT FROM NEW."installments"
    OR OLD."provider" IS DISTINCT FROM NEW."provider"
    OR OLD."idempotency_key" IS DISTINCT FROM NEW."idempotency_key"
    OR OLD."request_hash" IS DISTINCT FROM NEW."request_hash"
    OR OLD."expires_at" IS DISTINCT FROM NEW."expires_at"
    OR OLD."created_at" IS DISTINCT FROM NEW."created_at"
  THEN RAISE EXCEPTION 'pos_payment_intent identity is immutable' USING ERRCODE = '55000';
  END IF;
  IF NEW."version" <> OLD."version" + 1 THEN RAISE EXCEPTION 'pos_payment_intent version must advance exactly once' USING ERRCODE = '40001'; END IF;
  IF OLD."provider_reference" IS NOT NULL AND NEW."provider_reference" IS DISTINCT FROM OLD."provider_reference" THEN
    RAISE EXCEPTION 'pos_payment_intent provider reference is immutable once bound' USING ERRCODE = '55000';
  END IF;
  IF OLD."consumed_at" IS NOT NULL AND NEW."consumed_at" IS DISTINCT FROM OLD."consumed_at" THEN
    RAISE EXCEPTION 'pos_payment_intent consumption is immutable once bound' USING ERRCODE = '55000';
  END IF;
  IF NEW."provider_sequence" IS NOT NULL AND OLD."provider_sequence" IS NOT NULL AND NEW."provider_sequence" < OLD."provider_sequence" THEN
    RAISE EXCEPTION 'pos_payment_intent provider sequence cannot regress' USING ERRCODE = '22000';
  END IF;
  IF OLD."status" <> NEW."status" AND NOT (
    (OLD."status" = 'created' AND NEW."status" IN ('processing', 'authorized', 'captured', 'declined', 'unknown', 'manual_review', 'cancelled'))
    OR (OLD."status" = 'processing' AND NEW."status" IN ('authorized', 'captured', 'declined', 'unknown', 'manual_review', 'cancelled'))
    OR (OLD."status" = 'authorized' AND NEW."status" IN ('captured', 'unknown', 'manual_review', 'cancelled'))
    OR (OLD."status" = 'unknown' AND NEW."status" IN ('processing', 'authorized', 'captured', 'declined', 'manual_review', 'cancelled'))
    OR (OLD."status" = 'manual_review' AND NEW."status" IN ('processing', 'authorized', 'captured', 'declined', 'cancelled'))
    OR (OLD."status" = 'captured' AND NEW."status" IN ('partially_refunded', 'refunded'))
    OR (OLD."status" = 'partially_refunded' AND NEW."status" IN ('partially_refunded', 'refunded'))
  ) THEN RAISE EXCEPTION 'invalid pos payment intent transition % -> %', OLD."status", NEW."status" USING ERRCODE = '22000'; END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "pos_payment_intents_guard"
BEFORE UPDATE ON "pos_payment_intents"
FOR EACH ROW EXECUTE FUNCTION "protect_pos_payment_intent"();

CREATE FUNCTION "protect_pos_payment_attempt"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF OLD."state" IN ('succeeded', 'unknown', 'failed') THEN
    RAISE EXCEPTION 'completed pos_payment_attempt is immutable' USING ERRCODE = '55000';
  END IF;
  IF OLD."id" IS DISTINCT FROM NEW."id" OR OLD."intent_id" IS DISTINCT FROM NEW."intent_id" OR OLD."sequence" IS DISTINCT FROM NEW."sequence"
    OR OLD."operation" IS DISTINCT FROM NEW."operation" OR OLD."operation_key" IS DISTINCT FROM NEW."operation_key"
    OR OLD."request_hash" IS DISTINCT FROM NEW."request_hash" OR OLD."provider_idempotency_key" IS DISTINCT FROM NEW."provider_idempotency_key"
    OR OLD."created_at" IS DISTINCT FROM NEW."created_at"
  THEN RAISE EXCEPTION 'pos_payment_attempt identity is immutable' USING ERRCODE = '55000'; END IF;
  IF OLD."state" <> NEW."state" AND NOT (
    (OLD."state" IN ('queued', 'retry') AND NEW."state" IN ('claimed', 'retry', 'failed'))
    OR (OLD."state" = 'claimed' AND NEW."state" IN ('succeeded', 'unknown', 'retry', 'failed'))
  ) THEN RAISE EXCEPTION 'invalid pos payment attempt transition % -> %', OLD."state", NEW."state" USING ERRCODE = '22000'; END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "pos_payment_attempts_guard" BEFORE UPDATE ON "pos_payment_attempts" FOR EACH ROW EXECUTE FUNCTION "protect_pos_payment_attempt"();

CREATE FUNCTION "protect_pos_payment_outbox"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF OLD."state" IN ('completed', 'dead') THEN
    RAISE EXCEPTION 'completed pos_payment_outbox is immutable' USING ERRCODE = '55000';
  END IF;
  IF OLD."id" IS DISTINCT FROM NEW."id" OR OLD."attempt_id" IS DISTINCT FROM NEW."attempt_id" OR OLD."max_deliveries" IS DISTINCT FROM NEW."max_deliveries" OR OLD."created_at" IS DISTINCT FROM NEW."created_at"
  THEN RAISE EXCEPTION 'pos_payment_outbox identity is immutable' USING ERRCODE = '55000'; END IF;
  IF OLD."state" <> NEW."state" AND NOT (
    (OLD."state" IN ('pending', 'retry') AND NEW."state" IN ('claimed', 'dead'))
    OR (OLD."state" = 'claimed' AND NEW."state" IN ('completed', 'retry', 'dead'))
  ) THEN RAISE EXCEPTION 'invalid pos payment outbox transition % -> %', OLD."state", NEW."state" USING ERRCODE = '22000'; END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "pos_payment_outbox_guard" BEFORE UPDATE ON "pos_payment_outbox" FOR EACH ROW EXECUTE FUNCTION "protect_pos_payment_outbox"();

CREATE FUNCTION "reject_pos_payment_history_mutation"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'pos payment history is immutable' USING ERRCODE = '55000';
END;
$$;

CREATE TRIGGER "pos_payment_callbacks_immutable_guard" BEFORE UPDATE OR DELETE ON "pos_payment_callbacks" FOR EACH ROW EXECUTE FUNCTION "reject_pos_payment_history_mutation"();
CREATE TRIGGER "pos_payment_state_events_immutable_guard" BEFORE UPDATE OR DELETE ON "pos_payment_state_events" FOR EACH ROW EXECUTE FUNCTION "reject_pos_payment_history_mutation"();
CREATE TRIGGER "pos_payment_attempts_delete_guard" BEFORE DELETE ON "pos_payment_attempts" FOR EACH ROW EXECUTE FUNCTION "reject_pos_payment_history_mutation"();
CREATE TRIGGER "pos_payment_outbox_delete_guard" BEFORE DELETE ON "pos_payment_outbox" FOR EACH ROW EXECUTE FUNCTION "reject_pos_payment_history_mutation"();
CREATE TRIGGER "pos_payment_intents_delete_guard" BEFORE DELETE ON "pos_payment_intents" FOR EACH ROW EXECUTE FUNCTION "reject_pos_payment_history_mutation"();
