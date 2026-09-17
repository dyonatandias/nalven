-- Manual payment reconciliation is a new aggregate. The legacy
-- pos_manual_payment_references table is sealed explicitly below.

ALTER TABLE "pos_register_accesses" ADD COLUMN "can_review_manual_payment" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "pos_register_accesses" ADD COLUMN "manual_payment_review_limit_cents" INTEGER NOT NULL DEFAULT 0 CHECK ("manual_payment_review_limit_cents" >= 0);
ALTER TABLE "pos_connectors" ADD COLUMN "revision" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "integration_credentials" ADD COLUMN "revision" INTEGER NOT NULL DEFAULT 0;
CREATE FUNCTION "bump_pos_manual_resource_revision"() RETURNS trigger AS $$ BEGIN
  -- NEW/OLD are polymorphic records. Keep table-specific field access inside
  -- mutually exclusive branches so PostgreSQL never resolves connector fields
  -- against a credential row (or credential fields against a connector row).
  IF TG_TABLE_NAME = 'pos_connectors' THEN
    IF ROW(NEW."type",NEW."mode",NEW."provider",NEW."credential_ref",NEW."status",NEW."settings",NEW."branch_id",NEW."register_id")
      IS DISTINCT FROM ROW(OLD."type",OLD."mode",OLD."provider",OLD."credential_ref",OLD."status",OLD."settings",OLD."branch_id",OLD."register_id")
    THEN NEW."revision":=OLD."revision"+1;
    ELSE NEW."revision":=OLD."revision";
    END IF;
  ELSIF TG_TABLE_NAME = 'integration_credentials' THEN
    IF ROW(NEW."provider_id",NEW."enabled",NEW."config",NEW."secrets_cipher_text",NEW."sandbox")
      IS DISTINCT FROM ROW(OLD."provider_id",OLD."enabled",OLD."config",OLD."secrets_cipher_text",OLD."sandbox")
    THEN NEW."revision":=OLD."revision"+1;
    ELSE NEW."revision":=OLD."revision";
    END IF;
  ELSE
    RAISE EXCEPTION 'manual resource revision trigger attached to unsupported table' USING ERRCODE='55000';
  END IF;
  RETURN NEW;
END; $$ LANGUAGE plpgsql;
CREATE TRIGGER "pos_connectors_manual_revision" BEFORE UPDATE ON "pos_connectors" FOR EACH ROW EXECUTE FUNCTION "bump_pos_manual_resource_revision"();
CREATE TRIGGER "integration_credentials_manual_revision" BEFORE UPDATE ON "integration_credentials" FOR EACH ROW EXECUTE FUNCTION "bump_pos_manual_resource_revision"();

CREATE TABLE "pos_manual_payment_reconciliation_gates" (
  "connector_id" TEXT PRIMARY KEY REFERENCES "pos_connectors"("id") ON DELETE RESTRICT,
  "connector_revision" INTEGER NOT NULL, "credential_ref" TEXT REFERENCES "integration_credentials"("id") ON DELETE RESTRICT,
  "credential_revision" INTEGER,
  "enabled" BOOLEAN NOT NULL DEFAULT false, "vault_adapter_id" TEXT, "provider_adapter_version" TEXT,
  "enabled_by" TEXT, "enabled_at" TIMESTAMPTZ, "config_hash" TEXT,
  "created_at" TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(), "updated_at" TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  CHECK ("connector_revision">=0 AND ("credential_revision" IS NULL OR "credential_revision">=0)),
  CHECK (("credential_ref" IS NULL)=("credential_revision" IS NULL)),
  CHECK (("enabled"=false) OR ("credential_ref" IS NOT NULL AND "vault_adapter_id" IS NOT NULL AND "provider_adapter_version" IS NOT NULL AND "enabled_by" IS NOT NULL AND "enabled_at" IS NOT NULL AND "config_hash" ~ '^[0-9a-f]{64}$'))
);
CREATE FUNCTION "protect_pos_manual_reconciliation_gate"() RETURNS trigger AS $$
BEGIN
  IF NEW."enabled"=true THEN
    RAISE EXCEPTION 'manual reconciliation remains hard-disabled until worker/vault roles and T2 application guards are installed' USING ERRCODE='42501';
  END IF;
  IF TG_OP='UPDATE' AND OLD."enabled"=true AND NEW."enabled"=false THEN NEW."updated_at":=clock_timestamp(); RETURN NEW; END IF;
  IF TG_OP='UPDATE' AND ROW(NEW."connector_id",NEW."connector_revision",NEW."credential_ref",NEW."credential_revision",NEW."enabled",NEW."vault_adapter_id",NEW."provider_adapter_version",NEW."enabled_by",NEW."enabled_at",NEW."config_hash")
    IS DISTINCT FROM ROW(OLD."connector_id",OLD."connector_revision",OLD."credential_ref",OLD."credential_revision",OLD."enabled",OLD."vault_adapter_id",OLD."provider_adapter_version",OLD."enabled_by",OLD."enabled_at",OLD."config_hash")
    THEN
    RAISE EXCEPTION 'manual reconciliation gate is immutable to runtime' USING ERRCODE='42501';
  END IF;
  RETURN NEW;
END; $$ LANGUAGE plpgsql;
CREATE TRIGGER "pos_manual_reconciliation_gate_guard" BEFORE INSERT OR UPDATE ON "pos_manual_payment_reconciliation_gates" FOR EACH ROW EXECUTE FUNCTION "protect_pos_manual_reconciliation_gate"();

ALTER TABLE "pos_payment_plan_slots" DROP CONSTRAINT "pos_payment_plan_slots_values_check";
ALTER TABLE "pos_payment_plan_slots" ADD CONSTRAINT "pos_payment_plan_slots_values_check" CHECK (
  "payment_index" BETWEEN 0 AND 9 AND "amount_cents" > 0 AND "installments" BETWEEN 1 AND 24
  AND "method" IN ('cash','pix','credit','debit','voucher','store_credit') AND "proof_kind" IN ('cash','value','intent','manual')
  AND ("method"='credit' OR "installments"=1) AND (
  ("proof_kind" = 'cash' AND "method" = 'cash' AND "connector_id" IS NULL AND "credential_ref" IS NULL AND "provider" IS NULL)
  OR ("proof_kind" = 'value' AND "method" = 'store_credit' AND "connector_id" IS NULL AND "credential_ref" IS NULL AND "provider" IS NULL)
  OR ("proof_kind" = 'intent' AND "method" IN ('pix', 'credit', 'debit', 'voucher') AND "connector_id" IS NOT NULL AND "credential_ref" IS NOT NULL AND "provider" IS NOT NULL)
  OR ("proof_kind" = 'manual' AND "method" IN ('pix', 'credit', 'debit', 'voucher') AND "connector_id" IS NOT NULL AND "credential_ref" IS NOT NULL AND "provider" IS NOT NULL)
));

DO $$
DECLARE
  function_source TEXT;
  old_guard TEXT := E'    IF EXISTS (SELECT 1 FROM "pos_payment_plan_slots" WHERE "plan_id" = NEW."id" AND "proof_kind" = \'manual\') THEN\n      RAISE EXCEPTION \'manual payment plan slots remain disabled until the reconciliation workflow is installed\' USING ERRCODE = \'23514\';\n    END IF;';
  new_guard TEXT := E'    IF EXISTS (SELECT 1 FROM "pos_payment_plan_slots" WHERE "plan_id" = NEW."id" AND "proof_kind" = \'manual\') AND NOT (\n      slot_count = 1 AND minimum_index = 0 AND maximum_index = 0 AND slot_sum = NEW."total_cents"\n      AND EXISTS (\n        SELECT 1 FROM "pos_payment_plan_slots" manual_slot\n        JOIN "pos_connectors" connector ON connector."id" = manual_slot."connector_id"\n          AND connector."branch_id" = NEW."branch_id" AND connector."provider" = manual_slot."provider"\n          AND connector."status" = \'active\' AND connector."credential_ref" = manual_slot."credential_ref"\n        JOIN "integration_credentials" credential ON credential."id" = manual_slot."credential_ref"\n+          AND credential."provider_id" = manual_slot."provider" AND credential."enabled" = true\n        WHERE manual_slot."plan_id" = NEW."id" AND manual_slot."payment_index" = 0\n          AND manual_slot."proof_kind" = \'manual\'\n          AND connector."settings" @> \'{"manualReconciliation":{"enabled":true,"vaultBindingRequired":true}}\'::jsonb\n          AND connector."settings"->\'capabilities\' ? \'manual_reference_query\'\n      )\n    ) THEN\n      RAISE EXCEPTION \'manual payment plan requires the single-slot feature-gated reconciliation connector\' USING ERRCODE = \'23514\';\n    END IF;';
BEGIN
  new_guard := replace(new_guard, E'\n+', E'\n');
  SELECT pg_get_functiondef('validate_pos_payment_plan_activation()'::regprocedure) INTO function_source;
  IF position(old_guard IN function_source) = 0 THEN
    RAISE EXCEPTION '310000 manual activation guard signature changed; refusing unsafe replacement';
  END IF;
  EXECUTE replace(function_source, old_guard, new_guard);
END;
$$;

CREATE FUNCTION "require_pos_manual_reconciliation_gate"() RETURNS trigger AS $$
BEGIN
  IF OLD."state"='quoted' AND NEW."state"='active' AND EXISTS (
    SELECT 1 FROM "pos_payment_plan_slots" slot WHERE slot."plan_id"=NEW."id" AND slot."proof_kind"='manual'
  ) AND NOT EXISTS (
    SELECT 1 FROM "pos_payment_plan_slots" slot
    JOIN "pos_manual_payment_reconciliation_gates" gate ON gate."connector_id"=slot."connector_id" AND gate."enabled"=true
    WHERE slot."plan_id"=NEW."id" AND gate."vault_adapter_id" IS NOT NULL AND gate."provider_adapter_version" IS NOT NULL
  ) THEN RAISE EXCEPTION 'manual reconciliation feature gate is disabled' USING ERRCODE='23514'; END IF;
  RETURN NEW;
END; $$ LANGUAGE plpgsql;
CREATE TRIGGER "pos_payment_plans_320_manual_gate" BEFORE UPDATE ON "pos_payment_plans" FOR EACH ROW EXECUTE FUNCTION "require_pos_manual_reconciliation_gate"();

-- The old aggregate stored the raw provider reference. It is retained only as
-- historical evidence: no new rows, lifecycle rewrites, or deletes are allowed.
-- The 320000 aggregate stores an HMAC index plus a separate vault binding.
CREATE FUNCTION "seal_legacy_pos_manual_payment_reference"() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'legacy manual payment references are sealed history-only; use the reconciliation aggregate'
    USING ERRCODE='42501';
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER "pos_manual_payment_references_000_legacy_sealed"
BEFORE INSERT OR UPDATE OR DELETE ON "pos_manual_payment_references"
FOR EACH ROW EXECUTE FUNCTION "seal_legacy_pos_manual_payment_reference"();

CREATE TABLE "pos_manual_payment_cases" (
  "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "branch_id" INTEGER NOT NULL,
  "register_id" INTEGER NOT NULL,
  "session_id" INTEGER NOT NULL,
  "operator_profile_id" INTEGER NOT NULL,
  "terminal_id" TEXT NOT NULL,
  "sale_draft_id" TEXT NOT NULL,
  "draft_revision" INTEGER NOT NULL,
  "draft_request_hash" TEXT NOT NULL,
  "quote_hash" TEXT NOT NULL,
  "order_claim_id" TEXT,
  "payment_plan_id" TEXT NOT NULL,
  "payment_index" INTEGER NOT NULL,
  "method" TEXT NOT NULL,
  "amount_cents" INTEGER NOT NULL,
  "currency" TEXT NOT NULL DEFAULT 'BRL',
  "installments" INTEGER NOT NULL DEFAULT 1,
  "provider" TEXT NOT NULL,
  "connector_id" TEXT NOT NULL,
  "connector_revision" INTEGER NOT NULL,
  "credential_ref" TEXT NOT NULL,
  "credential_revision" INTEGER NOT NULL,
  "reference_hash" TEXT NOT NULL,
  "reference_key_id" TEXT NOT NULL,
  "reference_last_four" TEXT NOT NULL,
  "occurred_at" TIMESTAMPTZ NOT NULL,
  "reason_code" TEXT NOT NULL,
  "maker_profile_id" INTEGER NOT NULL,
  "maker_user_id" TEXT NOT NULL,
  "state" TEXT NOT NULL DEFAULT 'review_pending',
  "version" INTEGER NOT NULL DEFAULT 0,
  "provider_outcome" TEXT,
  "unknown_since" TIMESTAMPTZ,
  "next_reconcile_at" TIMESTAMPTZ,
  "confirmed_observation_id" BIGINT,
  "confirmed_at" TIMESTAMPTZ,
  "confirmation_expires_at" TIMESTAMPTZ,
  "applied_sale_payment_id" TEXT,
  "lifecycle_txid" NUMERIC(20,0) NOT NULL,
  "idempotency_key" TEXT NOT NULL,
  "request_hash" TEXT NOT NULL,
  "expires_at" TIMESTAMPTZ NOT NULL,
  "reviewed_at" TIMESTAMPTZ,
  "rejected_at" TIMESTAMPTZ,
  "no_funds_at" TIMESTAMPTZ,
  "blocked_at" TIMESTAMPTZ,
  "applied_at" TIMESTAMPTZ,
  "expired_at" TIMESTAMPTZ,
  "created_at" TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  "updated_at" TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT "pos_manual_cases_state_check" CHECK ("state" IN ('review_pending','rejected','unknown','confirmed_paid','no_funds','application_pending','blocked','applied','expired')),
  CONSTRAINT "pos_manual_cases_outcome_check" CHECK ("provider_outcome" IS NULL OR "provider_outcome" IN ('confirmed_paid','not_found','voided','refunded','unknown')),
  CONSTRAINT "pos_manual_cases_money_check" CHECK ("amount_cents" > 0 AND "currency" = 'BRL' AND "installments" BETWEEN 1 AND 24),
  CONSTRAINT "pos_manual_cases_hashes_check" CHECK (
    "draft_request_hash" ~ '^[0-9a-f]{64}$' AND "quote_hash" ~ '^[0-9a-f]{64}$' AND "connector_revision" >= 0 AND "credential_revision" >= 0
    AND "reference_hash" ~ '^hmac-sha256:v[0-9]+:[0-9a-f]{64}$' AND "request_hash" ~ '^[0-9a-f]{64}$'
    AND "reference_last_four" ~ '^[A-Za-z0-9]{4}$'
  ),
  CONSTRAINT "pos_manual_cases_provider_reference_key" UNIQUE ("provider", "reference_hash"),
  CONSTRAINT "pos_manual_cases_plan_slot_key" UNIQUE ("payment_plan_id", "payment_index"),
  CONSTRAINT "pos_manual_cases_maker_idempotency_key" UNIQUE ("branch_id", "maker_user_id", "idempotency_key"),
  CONSTRAINT "pos_manual_cases_applied_payment_key" UNIQUE ("applied_sale_payment_id"),
  CONSTRAINT "pos_manual_cases_plan_slot_fkey" FOREIGN KEY ("payment_plan_id", "payment_index") REFERENCES "pos_payment_plan_slots"("plan_id", "payment_index") ON DELETE RESTRICT,
  CONSTRAINT "pos_manual_cases_session_register_fkey" FOREIGN KEY ("session_id", "register_id") REFERENCES "cash_register_sessions"("id", "register_id") ON DELETE RESTRICT,
  CONSTRAINT "pos_manual_cases_terminal_register_fkey" FOREIGN KEY ("terminal_id", "register_id") REFERENCES "pos_terminals"("id", "register_id") ON DELETE RESTRICT,
  CONSTRAINT "pos_manual_cases_connector_context_fkey" FOREIGN KEY ("connector_id", "branch_id", "provider") REFERENCES "pos_connectors"("id", "branch_id", "provider") ON DELETE RESTRICT,
  CONSTRAINT "pos_manual_cases_credential_fkey" FOREIGN KEY ("credential_ref") REFERENCES "integration_credentials"("id") ON DELETE RESTRICT
);
CREATE INDEX "pos_manual_cases_session_state_expires_idx" ON "pos_manual_payment_cases"("session_id", "state", "expires_at");

CREATE TABLE "pos_manual_payment_vault_bindings" (
  "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(), "case_id" UUID NOT NULL UNIQUE REFERENCES "pos_manual_payment_cases"("id") ON DELETE RESTRICT,
  "vault_provider" TEXT NOT NULL, "vault_reference" TEXT NOT NULL, "vault_key_id" TEXT NOT NULL,
  "binding_hash" TEXT NOT NULL CHECK ("binding_hash" ~ '^[0-9a-f]{64}$'),
  "stable_reference_index" TEXT NOT NULL UNIQUE CHECK ("stable_reference_index" ~ '^vault-blind:v[0-9]+:[0-9a-f]{64}$'),
  "retention_expires_at" TIMESTAMPTZ NOT NULL,
  "created_at" TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(), UNIQUE ("vault_provider", "vault_reference"),
  CHECK (length("vault_reference") BETWEEN 8 AND 160 AND length("vault_key_id") BETWEEN 3 AND 80)
);

CREATE TABLE "pos_manual_payment_step_up_assertions" (
  "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(), "case_id" UUID NOT NULL REFERENCES "pos_manual_payment_cases"("id") ON DELETE RESTRICT,
  "checker_profile_id" INTEGER NOT NULL, "checker_user_id" TEXT NOT NULL, "purpose" TEXT NOT NULL CHECK ("purpose"='manual_payment.review'),
  "request_hash" TEXT NOT NULL CHECK ("request_hash" ~ '^[0-9a-f]{64}$'), "assertion_hash" TEXT NOT NULL UNIQUE CHECK ("assertion_hash" ~ '^[0-9a-f]{64}$'),
  "idempotency_key" TEXT NOT NULL UNIQUE,
  "verified_at" TIMESTAMPTZ NOT NULL, "expires_at" TIMESTAMPTZ NOT NULL, "consumed_review_id" UUID UNIQUE,
  "consumed_at" TIMESTAMPTZ, "created_at" TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  CHECK ("expires_at" > "verified_at" AND "expires_at" <= "verified_at"+interval '5 minutes'),
  CHECK (("consumed_review_id" IS NULL) = ("consumed_at" IS NULL))
);

CREATE TABLE "pos_manual_payment_reviews" (
  "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(), "case_id" UUID NOT NULL UNIQUE,
  "decision" TEXT NOT NULL CHECK ("decision" IN ('authorize_query','reject')),
  "maker_profile_id" INTEGER NOT NULL, "maker_user_id" TEXT NOT NULL, "checker_profile_id" INTEGER NOT NULL, "checker_user_id" TEXT NOT NULL,
  "step_up_evidence_id" TEXT NOT NULL UNIQUE, "step_up_proof_hash" TEXT NOT NULL CHECK ("step_up_proof_hash" ~ '^[0-9a-f]{64}$'),
  "step_up_verified_at" TIMESTAMPTZ NOT NULL, "step_up_expires_at" TIMESTAMPTZ NOT NULL, "branch_grant_id" INTEGER NOT NULL, "register_grant_id" INTEGER NOT NULL,
  "grant_valid_from" TIMESTAMPTZ, "grant_valid_until" TIMESTAMPTZ, "authority_limit_cents" INTEGER NOT NULL,
  "reason_code" TEXT NOT NULL, "idempotency_key" TEXT NOT NULL UNIQUE, "request_hash" TEXT NOT NULL CHECK ("request_hash" ~ '^[0-9a-f]{64}$'),
  "write_txid" NUMERIC(20,0) NOT NULL, "created_at" TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY ("case_id") REFERENCES "pos_manual_payment_cases"("id") ON DELETE RESTRICT,
  CHECK ("maker_profile_id" <> "checker_profile_id")
);

CREATE FUNCTION "protect_pos_manual_step_up_assertion"() RETURNS trigger AS $$
BEGIN
  IF TG_OP='INSERT' THEN NEW."verified_at":=clock_timestamp(); NEW."expires_at":=NEW."verified_at"+interval '5 minutes'; RETURN NEW; END IF;
  IF ROW(NEW."case_id",NEW."checker_profile_id",NEW."checker_user_id",NEW."purpose",NEW."request_hash",NEW."assertion_hash",NEW."idempotency_key",NEW."verified_at",NEW."expires_at",NEW."created_at")
    IS DISTINCT FROM ROW(OLD."case_id",OLD."checker_profile_id",OLD."checker_user_id",OLD."purpose",OLD."request_hash",OLD."assertion_hash",OLD."idempotency_key",OLD."verified_at",OLD."expires_at",OLD."created_at")
    OR OLD."consumed_review_id" IS NOT NULL OR NEW."consumed_review_id" IS NULL OR NEW."consumed_at" IS NULL
  THEN RAISE EXCEPTION 'step-up assertion is immutable and single-use' USING ERRCODE='23514'; END IF;
  RETURN NEW;
END; $$ LANGUAGE plpgsql;
CREATE TRIGGER "pos_manual_step_up_assertion_guard" BEFORE INSERT OR UPDATE OR DELETE ON "pos_manual_payment_step_up_assertions" FOR EACH ROW EXECUTE FUNCTION "protect_pos_manual_step_up_assertion"();

CREATE TABLE "pos_manual_payment_attempts" (
  "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(), "case_id" UUID NOT NULL, "sequence" INTEGER NOT NULL,
  "operation" TEXT NOT NULL DEFAULT 'query' CHECK ("operation" IN ('query','finalize')),
  "state" TEXT NOT NULL DEFAULT 'queued' CHECK ("state" IN ('queued','claimed','succeeded','failed','unknown')),
  "dispatch_count" INTEGER NOT NULL DEFAULT 0 CHECK ("dispatch_count" >= 0), "outcome_unknown" BOOLEAN NOT NULL DEFAULT false,
  "provider_idempotency_key" TEXT NOT NULL UNIQUE, "request_hash" TEXT NOT NULL CHECK ("request_hash" ~ '^[0-9a-f]{64}$'),
  "started_at" TIMESTAMPTZ, "finished_at" TIMESTAMPTZ, "created_at" TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  UNIQUE ("case_id", "sequence"), FOREIGN KEY ("case_id") REFERENCES "pos_manual_payment_cases"("id") ON DELETE RESTRICT
);
CREATE TABLE "pos_manual_payment_outbox" (
  "id" BIGSERIAL PRIMARY KEY, "attempt_id" UUID NOT NULL UNIQUE REFERENCES "pos_manual_payment_attempts"("id") ON DELETE RESTRICT,
  "state" TEXT NOT NULL DEFAULT 'pending' CHECK ("state" IN ('pending','claimed','retry','completed','dead')),
  "delivery_count" INTEGER NOT NULL DEFAULT 0 CHECK ("delivery_count" >= 0), "max_deliveries" INTEGER NOT NULL DEFAULT 8 CHECK ("max_deliveries" BETWEEN 1 AND 32), "next_attempt_at" TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  "claim_token" TEXT UNIQUE, "claim_expires_at" TIMESTAMPTZ, "completed_at" TIMESTAMPTZ, "last_error_code" TEXT, "created_at" TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  CHECK (("state" = 'claimed') = ("claim_token" IS NOT NULL AND "claim_expires_at" IS NOT NULL))
);
CREATE INDEX "pos_manual_outbox_due_idx" ON "pos_manual_payment_outbox"("state", "next_attempt_at", "id");
CREATE TABLE "pos_manual_payment_delivery_results" (
  "id" BIGSERIAL PRIMARY KEY, "attempt_id" UUID NOT NULL REFERENCES "pos_manual_payment_attempts"("id") ON DELETE RESTRICT,
  "delivery_number" INTEGER NOT NULL, "claim_token_hash" TEXT NOT NULL UNIQUE CHECK ("claim_token_hash" ~ '^[0-9a-f]{64}$'),
  "response_hash" TEXT NOT NULL CHECK ("response_hash" ~ '^[0-9a-f]{64}$'), "result_kind" TEXT NOT NULL CHECK ("result_kind" IN ('result','retry','transport_unknown')),
  "outcome" TEXT NOT NULL CHECK ("outcome" IN ('confirmed_paid','not_found','voided','refunded','unknown')),
  "evidence_hash" TEXT NOT NULL CHECK ("evidence_hash" ~ '^[0-9a-f]{64}$'), "provider_sequence" BIGINT,
  "occurred_at" TIMESTAMPTZ, "retryable" BOOLEAN NOT NULL DEFAULT false, "superseded" BOOLEAN NOT NULL DEFAULT false,
  "resulting_state" TEXT NOT NULL, "resulting_version" INTEGER NOT NULL, "received_at" TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  UNIQUE ("attempt_id", "delivery_number")
);
CREATE TABLE "pos_manual_payment_callbacks" (
  "id" BIGSERIAL PRIMARY KEY, "case_id" UUID NOT NULL REFERENCES "pos_manual_payment_cases"("id") ON DELETE RESTRICT,
  "provider" TEXT NOT NULL, "event_key" TEXT NOT NULL, "key_id" TEXT NOT NULL,
  "payload_hash" TEXT NOT NULL CHECK ("payload_hash" ~ '^[0-9a-f]{64}$'), "signature_hash" TEXT NOT NULL CHECK ("signature_hash" ~ '^[0-9a-f]{64}$'),
  "outcome" TEXT NOT NULL CHECK ("outcome" IN ('confirmed_paid','not_found','voided','refunded','unknown')),
  "reference_hash" TEXT NOT NULL, "method" TEXT NOT NULL, "amount_cents" INTEGER NOT NULL, "currency" TEXT NOT NULL,
  "provider_sequence" BIGINT, "provider_occurred_at" TIMESTAMPTZ, "auth_key_id" TEXT NOT NULL,
  "processing_result" TEXT NOT NULL CHECK ("processing_result" IN ('applied','late_incident','duplicate','rejected')),
  "resulting_state" TEXT NOT NULL, "resulting_version" INTEGER NOT NULL,
  "received_at" TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(), UNIQUE ("provider", "event_key")
);
CREATE TABLE "pos_manual_payment_observations" (
  "id" BIGSERIAL PRIMARY KEY, "case_id" UUID NOT NULL REFERENCES "pos_manual_payment_cases"("id") ON DELETE RESTRICT,
  "attempt_id" UUID REFERENCES "pos_manual_payment_attempts"("id") ON DELETE RESTRICT, "callback_id" BIGINT REFERENCES "pos_manual_payment_callbacks"("id") ON DELETE RESTRICT,
  "source" TEXT NOT NULL CHECK ("source" IN ('worker','callback')), "outcome" TEXT NOT NULL CHECK ("outcome" IN ('confirmed_paid','not_found','voided','refunded','unknown')),
  "reference_hash" TEXT NOT NULL, "method" TEXT NOT NULL, "amount_cents" INTEGER NOT NULL, "currency" TEXT NOT NULL,
  "provider_sequence" BIGINT, "provider_occurred_at" TIMESTAMPTZ, "auth_key_id" TEXT NOT NULL, "processing_result" TEXT NOT NULL,
  "evidence_hash" TEXT NOT NULL CHECK ("evidence_hash" ~ '^[0-9a-f]{64}$'),
  "resulting_state" TEXT NOT NULL, "resulting_version" INTEGER NOT NULL, "write_txid" NUMERIC(20,0) NOT NULL,
  "created_at" TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(), UNIQUE ("case_id", "source", "evidence_hash"),
  CHECK (("source" = 'worker' AND "attempt_id" IS NOT NULL AND "callback_id" IS NULL) OR ("source" = 'callback' AND "callback_id" IS NOT NULL AND "attempt_id" IS NULL))
);
ALTER TABLE "pos_manual_payment_cases" ADD CONSTRAINT "pos_manual_cases_confirmed_observation_fkey"
  FOREIGN KEY ("confirmed_observation_id") REFERENCES "pos_manual_payment_observations"("id") ON DELETE RESTRICT;
CREATE TABLE "pos_manual_payment_incidents" (
  "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(), "case_id" UUID NOT NULL REFERENCES "pos_manual_payment_cases"("id") ON DELETE RESTRICT,
  "callback_id" BIGINT UNIQUE REFERENCES "pos_manual_payment_callbacks"("id") ON DELETE RESTRICT,
  "observation_id" BIGINT REFERENCES "pos_manual_payment_observations"("id") ON DELETE RESTRICT, "code" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'open' CHECK ("status" IN ('open','resolved')),
  "production_blocking" BOOLEAN NOT NULL DEFAULT true, "expected_hash" TEXT NOT NULL CHECK ("expected_hash" ~ '^[0-9a-f]{64}$'),
  "reported_hash" TEXT NOT NULL CHECK ("reported_hash" ~ '^[0-9a-f]{64}$'), "resolution_code" TEXT, "resolved_by_profile_id" INTEGER,
  "resolved_at" TIMESTAMPTZ, "created_at" TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX "pos_manual_incidents_open_idx" ON "pos_manual_payment_incidents"("case_id", "production_blocking", "resolved_at");
CREATE TABLE "pos_manual_payment_applications" (
  "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(), "case_id" UUID NOT NULL UNIQUE REFERENCES "pos_manual_payment_cases"("id") ON DELETE RESTRICT,
  "payment_plan_id" TEXT NOT NULL, "payment_index" INTEGER NOT NULL, "sale_draft_id" TEXT NOT NULL, "quote_hash" TEXT NOT NULL,
  "expected_plan_version" INTEGER NOT NULL, "sale_idempotency_key" TEXT NOT NULL, "sale_request_hash" TEXT NOT NULL,
  "sale_id" INTEGER REFERENCES "sales"("id") ON DELETE RESTRICT, "sale_payment_id" TEXT UNIQUE REFERENCES "pos_sale_payments"("id") ON DELETE RESTRICT,
  "state" TEXT NOT NULL DEFAULT 'pending' CHECK ("state" IN ('pending','applied')), "idempotency_key" TEXT NOT NULL UNIQUE,
  "request_hash" TEXT NOT NULL CHECK ("request_hash" ~ '^[0-9a-f]{64}$'), "write_txid" NUMERIC(20,0) NOT NULL,
  "reserved_by_profile_id" INTEGER NOT NULL, "reserved_at" TIMESTAMPTZ NOT NULL, "applied_at" TIMESTAMPTZ,
  "blocked_at" TIMESTAMPTZ, "blocked_code" TEXT, "created_at" TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY ("payment_plan_id", "payment_index") REFERENCES "pos_payment_plan_slots"("plan_id","payment_index") ON DELETE RESTRICT
);
CREATE TABLE "pos_manual_payment_operations" (
  "id" BIGSERIAL PRIMARY KEY, "case_id" UUID NOT NULL REFERENCES "pos_manual_payment_cases"("id") ON DELETE RESTRICT,
  "action" TEXT NOT NULL CHECK ("action" IN ('open','authorize_query','reject','observe','reserve_application','apply','expire','block')),
  "expected_version" INTEGER NOT NULL, "resulting_version" INTEGER NOT NULL, "resulting_state" TEXT NOT NULL,
  "actor_profile_id" INTEGER, "idempotency_key" TEXT NOT NULL UNIQUE, "request_hash" TEXT NOT NULL CHECK ("request_hash" ~ '^[0-9a-f]{64}$'),
  "review_id" UUID REFERENCES "pos_manual_payment_reviews"("id") ON DELETE RESTRICT,
  "observation_id" BIGINT REFERENCES "pos_manual_payment_observations"("id") ON DELETE RESTRICT,
  "application_id" UUID REFERENCES "pos_manual_payment_applications"("id") ON DELETE RESTRICT,
  "write_txid" NUMERIC(20,0) NOT NULL, "created_at" TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(), UNIQUE ("case_id", "resulting_version")
);
CREATE TABLE "pos_manual_payment_state_events" (
  "id" BIGSERIAL PRIMARY KEY, "case_id" UUID NOT NULL REFERENCES "pos_manual_payment_cases"("id") ON DELETE RESTRICT,
  "operation_id" BIGINT UNIQUE REFERENCES "pos_manual_payment_operations"("id") ON DELETE RESTRICT, "from_state" TEXT, "to_state" TEXT NOT NULL,
  "resulting_version" INTEGER NOT NULL, "source" TEXT NOT NULL CHECK ("source" IN ('api','worker','callback','maintenance','application')),
  "source_id" TEXT NOT NULL, "write_txid" NUMERIC(20,0) NOT NULL, "created_at" TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  UNIQUE ("case_id", "resulting_version")
);

CREATE FUNCTION "protect_pos_manual_append_only"() RETURNS trigger AS $$ BEGIN
  RAISE EXCEPTION 'manual payment reconciliation evidence is append-only' USING ERRCODE = '23514';
END; $$ LANGUAGE plpgsql;
CREATE TRIGGER "pos_manual_reviews_append_only" BEFORE UPDATE OR DELETE ON "pos_manual_payment_reviews" FOR EACH ROW EXECUTE FUNCTION "protect_pos_manual_append_only"();
CREATE TRIGGER "pos_manual_delivery_append_only" BEFORE UPDATE OR DELETE ON "pos_manual_payment_delivery_results" FOR EACH ROW EXECUTE FUNCTION "protect_pos_manual_append_only"();
CREATE TRIGGER "pos_manual_callbacks_append_only" BEFORE UPDATE OR DELETE ON "pos_manual_payment_callbacks" FOR EACH ROW EXECUTE FUNCTION "protect_pos_manual_append_only"();
CREATE TRIGGER "pos_manual_observations_append_only" BEFORE UPDATE OR DELETE ON "pos_manual_payment_observations" FOR EACH ROW EXECUTE FUNCTION "protect_pos_manual_append_only"();
CREATE TRIGGER "pos_manual_operations_append_only" BEFORE UPDATE OR DELETE ON "pos_manual_payment_operations" FOR EACH ROW EXECUTE FUNCTION "protect_pos_manual_append_only"();
CREATE TRIGGER "pos_manual_state_events_append_only" BEFORE UPDATE OR DELETE ON "pos_manual_payment_state_events" FOR EACH ROW EXECUTE FUNCTION "protect_pos_manual_append_only"();

CREATE FUNCTION "protect_pos_manual_case"() RETURNS trigger AS $$
DECLARE
  plan_record "pos_payment_plans"%ROWTYPE;
  slot_record "pos_payment_plan_slots"%ROWTYPE;
  matching_operation "pos_manual_payment_operations"%ROWTYPE;
BEGIN
  IF TG_OP = 'INSERT' THEN
    SELECT * INTO plan_record FROM "pos_payment_plans" WHERE "id" = NEW."payment_plan_id";
    IF plan_record."id" IS NULL THEN RAISE EXCEPTION 'manual case requires an authoritative plan' USING ERRCODE='23503'; END IF;
    PERFORM 1 FROM "cash_register_sessions" WHERE "id"=plan_record."session_id" AND "status"='open' FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'manual case requires an open session' USING ERRCODE='23514'; END IF;
    PERFORM 1 FROM "pos_terminals" WHERE "id"=plan_record."terminal_id" AND "status"='online' AND "revoked_at" IS NULL FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'manual case requires a live terminal' USING ERRCODE='23514'; END IF;
    PERFORM "assert_pos_payment_plan_live_access"(plan_record);
    IF plan_record."order_claim_id" IS NOT NULL THEN PERFORM 1 FROM "pos_order_claims" WHERE "id"=plan_record."order_claim_id" FOR UPDATE; END IF;
    PERFORM 1 FROM "pos_held_sales" WHERE "id"=plan_record."sale_draft_id" FOR UPDATE;
    SELECT * INTO plan_record FROM "pos_payment_plans" WHERE "id"=NEW."payment_plan_id" FOR UPDATE;
    SELECT * INTO slot_record FROM "pos_payment_plan_slots" WHERE "plan_id"=NEW."payment_plan_id" AND "payment_index"=NEW."payment_index" FOR UPDATE;
    IF plan_record."state" <> 'active' OR plan_record."expires_at" <= clock_timestamp() OR slot_record."proof_kind" <> 'manual'
      OR NEW."payment_index" <> 0 OR (SELECT count(*) FROM "pos_payment_plan_slots" WHERE "plan_id"=NEW."payment_plan_id") <> 1
      OR ROW(NEW."branch_id",NEW."register_id",NEW."session_id",NEW."operator_profile_id",NEW."terminal_id",NEW."sale_draft_id",NEW."draft_revision",NEW."draft_request_hash",NEW."quote_hash",NEW."order_claim_id")
        IS DISTINCT FROM ROW(plan_record."branch_id",plan_record."register_id",plan_record."session_id",plan_record."operator_profile_id",plan_record."terminal_id",plan_record."sale_draft_id",plan_record."draft_revision",plan_record."draft_request_hash",plan_record."quote_hash",plan_record."order_claim_id")
      OR ROW(NEW."method",NEW."amount_cents",NEW."installments",NEW."provider",NEW."connector_id",NEW."credential_ref")
        IS DISTINCT FROM ROW(slot_record."method",slot_record."amount_cents",slot_record."installments",slot_record."provider",slot_record."connector_id",slot_record."credential_ref")
      OR NEW."currency" <> plan_record."currency" OR NEW."amount_cents" <> plan_record."total_cents"
      OR NOT EXISTS (SELECT 1 FROM "pos_connectors" c JOIN "integration_credentials" credential ON credential."id"=c."credential_ref"
        WHERE c."id"=NEW."connector_id" AND c."revision"=NEW."connector_revision" AND c."status"='active'
          AND credential."id"=NEW."credential_ref" AND credential."revision"=NEW."credential_revision" AND credential."enabled"=true
          AND c."settings" @> '{"manualReconciliation":{"enabled":true,"vaultBindingRequired":true}}'::jsonb
          AND c."settings"->'capabilities' ? 'manual_reference_query')
    THEN RAISE EXCEPTION 'manual case diverges from its single authoritative slot' USING ERRCODE='23514'; END IF;
    IF NEW."maker_profile_id" <> NEW."operator_profile_id" OR NEW."state" <> 'review_pending' OR NEW."version" <> 0 THEN
      RAISE EXCEPTION 'manual case must start review_pending by its operator' USING ERRCODE='23514';
    END IF;
    NEW."created_at" := clock_timestamp(); NEW."updated_at" := NEW."created_at";
    NEW."expires_at" := LEAST(plan_record."expires_at", NEW."created_at" + interval '15 minutes');
    NEW."lifecycle_txid" := txid_current()::numeric;
    RETURN NEW;
  END IF;
  IF ROW(NEW."branch_id",NEW."register_id",NEW."session_id",NEW."operator_profile_id",NEW."terminal_id",NEW."sale_draft_id",NEW."draft_revision",NEW."draft_request_hash",NEW."quote_hash",NEW."order_claim_id",NEW."payment_plan_id",NEW."payment_index",NEW."method",NEW."amount_cents",NEW."currency",NEW."installments",NEW."provider",NEW."connector_id",NEW."connector_revision",NEW."credential_ref",NEW."credential_revision",NEW."reference_hash",NEW."reference_key_id",NEW."reference_last_four",NEW."occurred_at",NEW."reason_code",NEW."maker_profile_id",NEW."maker_user_id",NEW."idempotency_key",NEW."request_hash",NEW."expires_at",NEW."created_at")
    IS DISTINCT FROM ROW(OLD."branch_id",OLD."register_id",OLD."session_id",OLD."operator_profile_id",OLD."terminal_id",OLD."sale_draft_id",OLD."draft_revision",OLD."draft_request_hash",OLD."quote_hash",OLD."order_claim_id",OLD."payment_plan_id",OLD."payment_index",OLD."method",OLD."amount_cents",OLD."currency",OLD."installments",OLD."provider",OLD."connector_id",OLD."connector_revision",OLD."credential_ref",OLD."credential_revision",OLD."reference_hash",OLD."reference_key_id",OLD."reference_last_four",OLD."occurred_at",OLD."reason_code",OLD."maker_profile_id",OLD."maker_user_id",OLD."idempotency_key",OLD."request_hash",OLD."expires_at",OLD."created_at")
  THEN RAISE EXCEPTION 'manual case identity and TTL are immutable' USING ERRCODE='23514'; END IF;
  IF NEW."state" IS DISTINCT FROM OLD."state" THEN
    SELECT * INTO matching_operation FROM "pos_manual_payment_operations" operation
      WHERE operation."case_id"=OLD."id" AND operation."expected_version"=OLD."version"
        AND operation."resulting_version"=NEW."version" AND operation."resulting_state"=NEW."state"
        AND operation."write_txid"=txid_current()::numeric;
    IF matching_operation."id" IS NULL OR NEW."version" <> OLD."version"+1 THEN
      RAISE EXCEPTION 'manual case transition requires exact same-tx operation' USING ERRCODE='23514'; END IF;
    IF NOT ((OLD."state"='review_pending' AND NEW."state" IN ('rejected','unknown','expired'))
      OR (OLD."state"='unknown' AND NEW."state" IN ('unknown','confirmed_paid','no_funds','blocked','expired'))
      OR (OLD."state"='confirmed_paid' AND NEW."state" IN ('application_pending','blocked','expired'))
      OR (OLD."state"='application_pending' AND NEW."state" IN ('applied','blocked'))
      OR (OLD."state" IN ('rejected','no_funds','expired') AND NEW."state"='blocked')) THEN
      RAISE EXCEPTION 'invalid manual payment case transition' USING ERRCODE='23514'; END IF;
    NEW."lifecycle_txid":=txid_current()::numeric; NEW."updated_at":=clock_timestamp();
    IF NEW."state" IN ('rejected','unknown') AND OLD."state"='review_pending' THEN NEW."reviewed_at":=clock_timestamp(); END IF;
    IF NEW."state"='confirmed_paid' THEN NEW."confirmation_expires_at":=LEAST(clock_timestamp()+interval '5 minutes', NEW."expires_at"); END IF;
    IF NEW."state"='expired' THEN NEW."expired_at":=clock_timestamp(); END IF;
    IF NEW."state"='applied' THEN NEW."applied_at":=clock_timestamp(); END IF;
  ELSE
    IF ROW(NEW."version",NEW."provider_outcome",NEW."confirmation_expires_at",NEW."applied_sale_payment_id",NEW."lifecycle_txid",NEW."reviewed_at",NEW."applied_at",NEW."expired_at")
      IS DISTINCT FROM ROW(OLD."version",OLD."provider_outcome",OLD."confirmation_expires_at",OLD."applied_sale_payment_id",OLD."lifecycle_txid",OLD."reviewed_at",OLD."applied_at",OLD."expired_at")
    THEN RAISE EXCEPTION 'manual case lifecycle evidence requires transition' USING ERRCODE='23514'; END IF;
  END IF;
  RETURN NEW;
END; $$ LANGUAGE plpgsql;
CREATE TRIGGER "pos_manual_case_guard" BEFORE INSERT OR UPDATE ON "pos_manual_payment_cases" FOR EACH ROW EXECUTE FUNCTION "protect_pos_manual_case"();

CREATE FUNCTION "stamp_pos_manual_ledger"() RETURNS trigger AS $$ BEGIN NEW."write_txid":=txid_current()::numeric; RETURN NEW; END; $$ LANGUAGE plpgsql;
CREATE TRIGGER "pos_manual_review_stamp" BEFORE INSERT ON "pos_manual_payment_reviews" FOR EACH ROW EXECUTE FUNCTION "stamp_pos_manual_ledger"();
CREATE TRIGGER "pos_manual_observation_stamp" BEFORE INSERT ON "pos_manual_payment_observations" FOR EACH ROW EXECUTE FUNCTION "stamp_pos_manual_ledger"();
CREATE TRIGGER "pos_manual_application_stamp" BEFORE INSERT OR UPDATE ON "pos_manual_payment_applications" FOR EACH ROW EXECUTE FUNCTION "stamp_pos_manual_ledger"();
CREATE TRIGGER "pos_manual_state_event_stamp" BEFORE INSERT ON "pos_manual_payment_state_events" FOR EACH ROW EXECUTE FUNCTION "stamp_pos_manual_ledger"();

CREATE FUNCTION "guard_pos_manual_operation"() RETURNS trigger AS $$
DECLARE case_record "pos_manual_payment_cases"%ROWTYPE;
BEGIN
  NEW."write_txid":=txid_current()::numeric;
  SELECT * INTO case_record FROM "pos_manual_payment_cases" WHERE "id"=NEW."case_id";
  IF case_record."id" IS NULL THEN RAISE EXCEPTION 'manual operation requires an existing case' USING ERRCODE='23503'; END IF;
  PERFORM 1 FROM "cash_register_sessions" WHERE "id"=case_record."session_id" FOR UPDATE;
  PERFORM 1 FROM "pos_terminals" WHERE "id"=case_record."terminal_id" FOR UPDATE;
  PERFORM 1 FROM "tenant_user_profiles" WHERE "id"=case_record."operator_profile_id" FOR SHARE;
  PERFORM 1 FROM "branches" WHERE "id"=case_record."branch_id" FOR SHARE;
  PERFORM 1 FROM "pos_registers" WHERE "id"=case_record."register_id" FOR SHARE;
  IF case_record."order_claim_id" IS NOT NULL THEN PERFORM 1 FROM "pos_order_claims" WHERE "id"=case_record."order_claim_id" FOR UPDATE; END IF;
  PERFORM 1 FROM "pos_held_sales" WHERE "id"=case_record."sale_draft_id" FOR UPDATE;
  PERFORM 1 FROM "pos_payment_plans" WHERE "id"=case_record."payment_plan_id" FOR UPDATE;
  PERFORM 1 FROM "pos_payment_plan_slots" WHERE "plan_id"=case_record."payment_plan_id" AND "payment_index"=case_record."payment_index" FOR UPDATE;
  PERFORM 1 FROM "pos_connectors" WHERE "id"=case_record."connector_id" FOR SHARE;
  PERFORM 1 FROM "integration_credentials" WHERE "id"=case_record."credential_ref" FOR SHARE;
  SELECT * INTO case_record FROM "pos_manual_payment_cases" WHERE "id"=NEW."case_id" FOR UPDATE;
  IF NEW."expected_version" IS DISTINCT FROM (CASE WHEN NEW."action"='open' THEN -1 ELSE case_record."version" END)
    OR NEW."resulting_version"<>NEW."expected_version"+1
    OR NOT ((NEW."action"='open' AND case_record."state"='review_pending' AND NEW."resulting_state"='review_pending' AND NEW."review_id" IS NULL AND NEW."observation_id" IS NULL AND NEW."application_id" IS NULL)
      OR (NEW."action"='authorize_query' AND case_record."state"='review_pending' AND NEW."resulting_state"='unknown' AND NEW."review_id" IS NOT NULL)
      OR (NEW."action"='reject' AND case_record."state"='review_pending' AND NEW."resulting_state"='rejected' AND NEW."review_id" IS NOT NULL)
      OR (NEW."action"='observe' AND case_record."state" IN ('unknown','rejected','no_funds','expired') AND NEW."resulting_state" IN ('unknown','confirmed_paid','no_funds','blocked') AND NEW."observation_id" IS NOT NULL)
      OR (NEW."action"='reserve_application' AND case_record."state"='confirmed_paid' AND NEW."resulting_state"='application_pending' AND NEW."application_id" IS NOT NULL)
      OR (NEW."action"='apply' AND case_record."state"='application_pending' AND NEW."resulting_state"='applied' AND NEW."application_id" IS NOT NULL)
      OR (NEW."action"='expire' AND case_record."state" IN ('review_pending','unknown','confirmed_paid') AND NEW."resulting_state"='expired')
      OR (NEW."action"='block' AND NEW."resulting_state"='blocked'))
  THEN RAISE EXCEPTION 'manual operation action/state/causal row mismatch' USING ERRCODE='23514'; END IF;
  RETURN NEW;
END; $$ LANGUAGE plpgsql;
CREATE TRIGGER "pos_manual_operation_insert_guard" BEFORE INSERT ON "pos_manual_payment_operations" FOR EACH ROW EXECUTE FUNCTION "guard_pos_manual_operation"();

CREATE FUNCTION "guard_pos_manual_state_event"() RETURNS trigger AS $$
DECLARE operation_record "pos_manual_payment_operations"%ROWTYPE;
BEGIN
  SELECT * INTO operation_record FROM "pos_manual_payment_operations" WHERE "id"=NEW."operation_id" FOR SHARE;
  IF operation_record."id" IS NULL OR ROW(NEW."case_id",NEW."to_state",NEW."resulting_version") IS DISTINCT FROM ROW(operation_record."case_id",operation_record."resulting_state",operation_record."resulting_version")
    OR NEW."from_state" IS DISTINCT FROM (CASE WHEN operation_record."action"='open' THEN NULL ELSE (SELECT "state" FROM "pos_manual_payment_cases" WHERE "id"=NEW."case_id") END)
  THEN RAISE EXCEPTION 'manual state event does not match its operation' USING ERRCODE='23514'; END IF;
  RETURN NEW;
END; $$ LANGUAGE plpgsql;
CREATE TRIGGER "pos_manual_state_event_insert_guard" BEFORE INSERT ON "pos_manual_payment_state_events" FOR EACH ROW EXECUTE FUNCTION "guard_pos_manual_state_event"();

CREATE FUNCTION "validate_pos_manual_transition_commit"() RETURNS trigger AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM "pos_manual_payment_cases" c
    JOIN "pos_manual_payment_operations" o ON o."case_id"=c."id" AND o."resulting_version"=c."version" AND o."resulting_state"=c."state" AND o."write_txid"=c."lifecycle_txid"
    JOIN "pos_manual_payment_state_events" e ON e."case_id"=c."id" AND e."operation_id"=o."id" AND e."resulting_version"=c."version" AND e."to_state"=c."state" AND e."write_txid"=c."lifecycle_txid"
    WHERE c."id"=NEW."case_id"
  ) THEN RAISE EXCEPTION 'manual case operation/state-event graph is incomplete' USING ERRCODE='23514'; END IF;
  RETURN NULL;
END; $$ LANGUAGE plpgsql;
CREATE CONSTRAINT TRIGGER "pos_manual_operation_graph_guard" AFTER INSERT ON "pos_manual_payment_operations" DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION "validate_pos_manual_transition_commit"();
CREATE CONSTRAINT TRIGGER "pos_manual_state_event_graph_guard" AFTER INSERT ON "pos_manual_payment_state_events" DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION "validate_pos_manual_transition_commit"();

CREATE FUNCTION "validate_pos_manual_review"() RETURNS trigger AS $$
DECLARE case_record "pos_manual_payment_cases"%ROWTYPE;
DECLARE assertion_record "pos_manual_payment_step_up_assertions"%ROWTYPE;
BEGIN
  SELECT * INTO case_record FROM "pos_manual_payment_cases" WHERE "id"=NEW."case_id";
  PERFORM 1 FROM "cash_register_sessions" WHERE "id"=case_record."session_id" AND "status"='open' FOR UPDATE;
  PERFORM 1 FROM "pos_terminals" WHERE "id"=case_record."terminal_id" AND "status"='online' AND "revoked_at" IS NULL FOR UPDATE;
  PERFORM 1 FROM "branch_user_accesses" b JOIN "pos_register_accesses" r ON r."user_profile_id"=b."user_profile_id"
    WHERE b."id"=NEW."branch_grant_id" AND r."id"=NEW."register_grant_id"
      AND b."branch_id"=case_record."branch_id" AND b."user_profile_id"=NEW."checker_profile_id" AND b."can_sell"=true
      AND r."register_id"=case_record."register_id" AND r."active"=true AND r."can_review_manual_payment"=true
      AND r."manual_payment_review_limit_cents">=case_record."amount_cents" AND NEW."authority_limit_cents"=r."manual_payment_review_limit_cents"
      AND (r."valid_from" IS NULL OR r."valid_from"<=clock_timestamp()) AND (r."valid_until" IS NULL OR r."valid_until">=clock_timestamp())
      AND NEW."grant_valid_from" IS NOT DISTINCT FROM r."valid_from" AND NEW."grant_valid_until" IS NOT DISTINCT FROM r."valid_until"
    FOR SHARE OF b,r;
  IF NOT FOUND OR NEW."maker_profile_id" IS DISTINCT FROM case_record."maker_profile_id" OR NEW."maker_user_id" IS DISTINCT FROM case_record."maker_user_id"
    OR NEW."checker_profile_id"=case_record."maker_profile_id" OR NEW."checker_user_id"=case_record."maker_user_id"
  THEN RAISE EXCEPTION 'manual payment review requires distinct checker, live grants and bounded step-up' USING ERRCODE='23514'; END IF;
  SELECT * INTO assertion_record FROM "pos_manual_payment_step_up_assertions" assertion
    WHERE assertion."assertion_hash"=NEW."step_up_proof_hash" AND assertion."case_id"=NEW."case_id"
      AND assertion."checker_profile_id"=NEW."checker_profile_id" AND assertion."checker_user_id"=NEW."checker_user_id"
      AND assertion."purpose"='manual_payment.review' AND assertion."request_hash"=NEW."request_hash"
      AND assertion."consumed_review_id" IS NULL AND assertion."verified_at"=NEW."step_up_verified_at"
      AND assertion."expires_at"=NEW."step_up_expires_at" AND assertion."expires_at">clock_timestamp()
    FOR UPDATE;
  IF assertion_record."id" IS NULL THEN RAISE EXCEPTION 'manual payment review requires a live one-shot server assertion' USING ERRCODE='23514'; END IF;
  UPDATE "pos_manual_payment_step_up_assertions" SET "consumed_review_id"=NEW."id", "consumed_at"=clock_timestamp() WHERE "id"=assertion_record."id";
  RETURN NEW;
END; $$ LANGUAGE plpgsql;
CREATE TRIGGER "pos_manual_review_guard" BEFORE INSERT ON "pos_manual_payment_reviews" FOR EACH ROW EXECUTE FUNCTION "validate_pos_manual_review"();

CREATE FUNCTION "protect_pos_manual_observation"() RETURNS trigger AS $$
DECLARE case_record "pos_manual_payment_cases"%ROWTYPE;
BEGIN
  SELECT * INTO case_record FROM "pos_manual_payment_cases" WHERE "id"=NEW."case_id" FOR UPDATE;
  IF (NEW."source"='worker' AND NOT EXISTS (SELECT 1 FROM "pos_manual_payment_attempts" attempt WHERE attempt."id"=NEW."attempt_id" AND attempt."case_id"=NEW."case_id"))
    OR (NEW."source"='callback' AND NOT EXISTS (SELECT 1 FROM "pos_manual_payment_callbacks" callback WHERE callback."id"=NEW."callback_id" AND callback."case_id"=NEW."case_id" AND callback."provider"=case_record."provider"))
  THEN RAISE EXCEPTION 'manual observation causal source diverges from case' USING ERRCODE='23514'; END IF;
  IF ROW(NEW."reference_hash",NEW."method",NEW."amount_cents",NEW."currency") IS DISTINCT FROM
    ROW(case_record."reference_hash",case_record."method",case_record."amount_cents",case_record."currency") THEN
    RAISE EXCEPTION 'confirmed manual observation must match exact amount and currency' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END; $$ LANGUAGE plpgsql;
CREATE TRIGGER "pos_manual_observation_guard" BEFORE INSERT ON "pos_manual_payment_observations" FOR EACH ROW EXECUTE FUNCTION "protect_pos_manual_observation"();

CREATE FUNCTION "validate_pos_manual_observation_commit"() RETURNS trigger AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM "pos_manual_payment_operations" operation JOIN "pos_manual_payment_state_events" event ON event."operation_id"=operation."id"
    WHERE operation."case_id"=NEW."case_id" AND operation."observation_id"=NEW."id" AND operation."action" IN ('observe','block')
      AND operation."resulting_version"=NEW."resulting_version" AND operation."resulting_state"=NEW."resulting_state"
      AND operation."write_txid"=NEW."write_txid" AND event."write_txid"=NEW."write_txid")
    OR (NEW."source"='worker' AND NOT EXISTS (
      SELECT 1 FROM "pos_manual_payment_delivery_results" delivery WHERE delivery."attempt_id"=NEW."attempt_id"
        AND delivery."outcome"=NEW."outcome" AND delivery."evidence_hash"=NEW."evidence_hash"
        AND delivery."resulting_state"=NEW."resulting_state" AND delivery."resulting_version"=NEW."resulting_version"))
    OR (NEW."source"='callback' AND NOT EXISTS (
      SELECT 1 FROM "pos_manual_payment_callbacks" callback WHERE callback."id"=NEW."callback_id"
        AND callback."outcome"=NEW."outcome" AND callback."reference_hash"=NEW."reference_hash"
        AND callback."method"=NEW."method" AND callback."amount_cents"=NEW."amount_cents" AND callback."currency"=NEW."currency"
        AND callback."resulting_state"=NEW."resulting_state" AND callback."resulting_version"=NEW."resulting_version"))
  THEN RAISE EXCEPTION 'manual observation delivery/callback/ledger graph is incomplete' USING ERRCODE='23514'; END IF;
  RETURN NULL;
END; $$ LANGUAGE plpgsql;
CREATE CONSTRAINT TRIGGER "pos_manual_observation_graph_guard" AFTER INSERT ON "pos_manual_payment_observations"
DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION "validate_pos_manual_observation_commit"();

CREATE FUNCTION "guard_pos_manual_application"() RETURNS trigger AS $$
DECLARE case_record "pos_manual_payment_cases"%ROWTYPE;
DECLARE plan_record "pos_payment_plans"%ROWTYPE;
BEGIN
  IF TG_OP='INSERT' THEN
    SELECT * INTO case_record FROM "pos_manual_payment_cases" WHERE "id"=NEW."case_id" FOR UPDATE;
    SELECT * INTO plan_record FROM "pos_payment_plans" WHERE "id"=case_record."payment_plan_id" FOR UPDATE;
    IF case_record."state"<>'confirmed_paid' OR case_record."confirmation_expires_at"<=clock_timestamp()
      OR EXISTS (SELECT 1 FROM "pos_manual_payment_incidents" incident WHERE incident."case_id"=case_record."id" AND incident."status"='open' AND incident."production_blocking"=true)
      OR ROW(NEW."payment_plan_id",NEW."payment_index",NEW."sale_draft_id",NEW."quote_hash",NEW."expected_plan_version")
        IS DISTINCT FROM ROW(case_record."payment_plan_id",case_record."payment_index",case_record."sale_draft_id",case_record."quote_hash",plan_record."version")
      OR NEW."sale_id" IS NOT NULL OR NEW."sale_payment_id" IS NOT NULL OR NEW."state"<>'pending'
    THEN RAISE EXCEPTION 'manual application reservation diverges from confirmed case' USING ERRCODE='23514'; END IF;
    NEW."reserved_at":=clock_timestamp(); RETURN NEW;
  END IF;
  IF ROW(NEW."case_id",NEW."payment_plan_id",NEW."payment_index",NEW."sale_draft_id",NEW."quote_hash",NEW."expected_plan_version",NEW."sale_idempotency_key",NEW."sale_request_hash",NEW."idempotency_key",NEW."request_hash",NEW."reserved_by_profile_id",NEW."reserved_at",NEW."created_at")
    IS DISTINCT FROM ROW(OLD."case_id",OLD."payment_plan_id",OLD."payment_index",OLD."sale_draft_id",OLD."quote_hash",OLD."expected_plan_version",OLD."sale_idempotency_key",OLD."sale_request_hash",OLD."idempotency_key",OLD."request_hash",OLD."reserved_by_profile_id",OLD."reserved_at",OLD."created_at")
  THEN RAISE EXCEPTION 'manual application reservation identity is immutable' USING ERRCODE='23514'; END IF;
  RETURN NEW;
END; $$ LANGUAGE plpgsql;
CREATE TRIGGER "pos_manual_application_guard" BEFORE INSERT OR UPDATE ON "pos_manual_payment_applications" FOR EACH ROW EXECUTE FUNCTION "guard_pos_manual_application"();

CREATE FUNCTION "validate_pos_manual_application_commit"() RETURNS trigger AS $$
BEGIN
  IF NEW."state"='pending' AND NOT EXISTS (
    SELECT 1 FROM "pos_manual_payment_cases" c JOIN "pos_manual_payment_operations" operation ON operation."case_id"=c."id"
    JOIN "pos_manual_payment_state_events" event ON event."operation_id"=operation."id"
    WHERE c."id"=NEW."case_id" AND c."state"='application_pending' AND operation."application_id"=NEW."id"
      AND operation."action"='reserve_application' AND operation."resulting_version"=c."version"
      AND operation."write_txid"=c."lifecycle_txid" AND event."write_txid"=c."lifecycle_txid"
  ) THEN RAISE EXCEPTION 'manual application reservation requires exact same-tx transition' USING ERRCODE='23514'; END IF;
  IF NEW."state"='applied' AND (NEW."sale_id" IS NULL OR NEW."sale_payment_id" IS NULL OR NOT EXISTS (
    SELECT 1 FROM "pos_manual_payment_cases" c WHERE c."id"=NEW."case_id" AND c."state"='applied' AND c."applied_sale_payment_id"=NEW."sale_payment_id"
  )) THEN RAISE EXCEPTION 'manual application/payment/case graph is incomplete' USING ERRCODE='23514'; END IF;
  RETURN NULL;
END; $$ LANGUAGE plpgsql;
CREATE CONSTRAINT TRIGGER "pos_manual_application_graph_guard" AFTER INSERT OR UPDATE ON "pos_manual_payment_applications"
DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION "validate_pos_manual_application_commit"();

CREATE TRIGGER "pos_manual_incidents_append_only" BEFORE DELETE ON "pos_manual_payment_incidents" FOR EACH ROW EXECUTE FUNCTION "protect_pos_manual_append_only"();

CREATE FUNCTION "block_pos_session_with_manual_case"() RETURNS trigger AS $$
BEGIN
  IF (NEW."status" IS DISTINCT FROM OLD."status" OR NEW."operator_profile_id" IS DISTINCT FROM OLD."operator_profile_id") AND EXISTS (
    SELECT 1 FROM "pos_manual_payment_cases" c WHERE c."session_id"=OLD."id" AND c."state" IN ('review_pending','unknown','confirmed_paid','application_pending','blocked')
  ) THEN RAISE EXCEPTION 'cash session has unresolved manual payment reconciliation' USING ERRCODE='23514'; END IF;
  RETURN NEW;
END; $$ LANGUAGE plpgsql;
CREATE TRIGGER "cash_session_manual_reconciliation_guard" BEFORE UPDATE ON "cash_register_sessions" FOR EACH ROW EXECUTE FUNCTION "block_pos_session_with_manual_case"();

CREATE FUNCTION "block_plan_release_with_manual_case"() RETURNS trigger AS $$
BEGIN
  IF NEW."state" IN ('expired','superseded') AND OLD."state" IN ('quoted','active') AND EXISTS (
    SELECT 1 FROM "pos_manual_payment_cases" c WHERE c."payment_plan_id"=OLD."id"
      AND c."state" IN ('review_pending','unknown','confirmed_paid','application_pending','blocked')
  ) THEN RAISE EXCEPTION 'payment plan has unresolved manual reconciliation evidence' USING ERRCODE='23514'; END IF;
  RETURN NEW;
END; $$ LANGUAGE plpgsql;
CREATE TRIGGER "pos_payment_plans_320_manual_release_guard" BEFORE UPDATE ON "pos_payment_plans" FOR EACH ROW EXECUTE FUNCTION "block_plan_release_with_manual_case"();

CREATE FUNCTION "block_handoff_with_manual_case"() RETURNS trigger AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM "pos_manual_payment_cases" c WHERE c."session_id"=NEW."session_id"
    AND c."state" IN ('review_pending','unknown','confirmed_paid','application_pending','blocked'))
  THEN RAISE EXCEPTION 'session handoff has unresolved manual payment reconciliation' USING ERRCODE='23514'; END IF;
  RETURN NEW;
END; $$ LANGUAGE plpgsql;
CREATE TRIGGER "pos_session_handoff_manual_reconciliation_guard" BEFORE INSERT OR UPDATE ON "pos_session_handoffs" FOR EACH ROW EXECUTE FUNCTION "block_handoff_with_manual_case"();

CREATE FUNCTION "validate_pos_manual_case_open_commit"() RETURNS trigger AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM "pos_manual_payment_vault_bindings" vault WHERE vault."case_id"=NEW."id" AND vault."retention_expires_at">NEW."expires_at")
    OR NOT EXISTS (
      SELECT 1 FROM "pos_manual_payment_operations" operation
      JOIN "pos_manual_payment_state_events" event ON event."operation_id"=operation."id" AND event."case_id"=operation."case_id"
      WHERE operation."case_id"=NEW."id" AND operation."action"='open' AND operation."expected_version"=-1
        AND operation."resulting_version"=0 AND operation."resulting_state"='review_pending'
        AND operation."write_txid"=NEW."lifecycle_txid" AND event."from_state" IS NULL
        AND event."to_state"='review_pending' AND event."resulting_version"=0 AND event."write_txid"=NEW."lifecycle_txid"
    )
  THEN RAISE EXCEPTION 'manual case requires same-tx vault binding and complete opening ledger' USING ERRCODE='23514'; END IF;
  RETURN NULL;
END; $$ LANGUAGE plpgsql;
CREATE CONSTRAINT TRIGGER "pos_manual_case_open_commit_guard" AFTER INSERT ON "pos_manual_payment_cases"
DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION "validate_pos_manual_case_open_commit"();
