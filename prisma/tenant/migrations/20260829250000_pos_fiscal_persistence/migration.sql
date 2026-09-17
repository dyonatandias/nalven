-- Provider-agnostic persistence for POS fiscal documents. This migration does
-- not install a SEFAZ/provider adapter and does not claim fiscal homologation.

CREATE TABLE "pos_fiscal_profiles" (
  "id" TEXT NOT NULL,
  "branch_id" INTEGER NOT NULL,
  "connector_id" TEXT NOT NULL,
  "credential_ref" TEXT NOT NULL,
  "version" INTEGER NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'draft',
  "document_model" TEXT NOT NULL DEFAULT 'nfce',
  "environment" TEXT NOT NULL,
  "uf" TEXT NOT NULL,
  "tax_regime" TEXT NOT NULL,
  "schema_version" TEXT NOT NULL,
  "provider" TEXT NOT NULL,
  "numbering_owner" TEXT NOT NULL DEFAULT 'provider',
  "series" INTEGER,
  "next_number" INTEGER,
  "policy_snapshot" JSONB NOT NULL,
  "policy_digest" TEXT NOT NULL,
  "certificate_fingerprint" TEXT,
  "effective_from" TIMESTAMPTZ,
  "effective_until" TIMESTAMPTZ,
  "activated_by" TEXT,
  "activated_at" TIMESTAMPTZ,
  "retired_by" TEXT,
  "retired_at" TIMESTAMPTZ,
  "created_by" TEXT NOT NULL,
  "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "pos_fiscal_profiles_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "pos_fiscal_profiles_status_check" CHECK ("status" IN ('draft', 'active', 'retired')),
  CONSTRAINT "pos_fiscal_profiles_model_check" CHECK ("document_model" IN ('nfce', 'nfe', 'cfe')),
  CONSTRAINT "pos_fiscal_profiles_environment_check" CHECK ("environment" IN ('homologation', 'production')),
  CONSTRAINT "pos_fiscal_profiles_values_check" CHECK (
    "version" > 0
    AND "uf" ~ '^[A-Z]{2}$'
    AND char_length("tax_regime") BETWEEN 2 AND 80
    AND char_length("schema_version") BETWEEN 1 AND 80
    AND char_length("provider") BETWEEN 2 AND 80
    AND "numbering_owner" IN ('provider', 'local')
    AND ("series" IS NULL OR "series" BETWEEN 0 AND 999)
    AND ("next_number" IS NULL OR "next_number" > 0)
    AND "policy_digest" ~ '^[0-9a-f]{64}$'
    AND ("certificate_fingerprint" IS NULL OR "certificate_fingerprint" ~ '^[0-9a-f]{16,128}$')
    AND ("effective_until" IS NULL OR "effective_from" IS NOT NULL)
    AND ("effective_until" IS NULL OR "effective_until" > "effective_from")
    AND (("numbering_owner" = 'local' AND "series" IS NOT NULL AND "next_number" IS NOT NULL) OR "numbering_owner" = 'provider')
  ),
  CONSTRAINT "pos_fiscal_profiles_activation_check" CHECK (
    ("status" = 'draft' AND "activated_by" IS NULL AND "activated_at" IS NULL AND "retired_by" IS NULL AND "retired_at" IS NULL)
    OR ("status" = 'active' AND "effective_from" IS NOT NULL AND "activated_by" IS NOT NULL AND "activated_at" IS NOT NULL AND "retired_by" IS NULL AND "retired_at" IS NULL)
    OR ("status" = 'retired' AND "effective_from" IS NOT NULL AND "activated_by" IS NOT NULL AND "activated_at" IS NOT NULL AND "retired_by" IS NOT NULL AND "retired_at" IS NOT NULL)
  ),
  CONSTRAINT "pos_fiscal_profiles_branch_id_fkey" FOREIGN KEY ("branch_id") REFERENCES "branches"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "pos_fiscal_profiles_connector_context_fkey" FOREIGN KEY ("connector_id", "branch_id", "provider") REFERENCES "pos_connectors"("id", "branch_id", "provider") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "pos_fiscal_profiles_credential_ref_fkey" FOREIGN KEY ("credential_ref") REFERENCES "integration_credentials"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "pos_fiscal_profiles_branch_model_environment_version_key"
  ON "pos_fiscal_profiles"("branch_id", "document_model", "environment", "version");
CREATE UNIQUE INDEX "pos_fiscal_profiles_id_version_key"
  ON "pos_fiscal_profiles"("id", "version");
CREATE UNIQUE INDEX "pos_fiscal_profiles_full_context_key"
  ON "pos_fiscal_profiles"("id", "version", "branch_id", "connector_id", "credential_ref", "provider", "document_model", "environment", "numbering_owner");
CREATE UNIQUE INDEX "pos_fiscal_profiles_one_active_key"
  ON "pos_fiscal_profiles"("branch_id", "document_model", "environment") WHERE "status" = 'active';
CREATE INDEX "pos_fiscal_profiles_branch_status_model_environment_idx"
  ON "pos_fiscal_profiles"("branch_id", "status", "document_model", "environment");
CREATE INDEX "pos_fiscal_profiles_credential_status_idx"
  ON "pos_fiscal_profiles"("credential_ref", "status");

CREATE UNIQUE INDEX "sales_id_branch_session_operator_pos_fiscal_key"
  ON "sales"("id", "branch_id", "session_id", "operator_profile_id");
CREATE UNIQUE INDEX "pos_terminals_id_register_pos_fiscal_key"
  ON "pos_terminals"("id", "register_id");

CREATE TABLE "pos_fiscal_documents" (
  "id" TEXT NOT NULL,
  "sale_id" INTEGER NOT NULL,
  "branch_id" INTEGER NOT NULL,
  "register_id" INTEGER NOT NULL,
  "session_id" INTEGER NOT NULL,
  "operator_profile_id" INTEGER NOT NULL,
  "terminal_id" TEXT,
  "connector_id" TEXT NOT NULL,
  "credential_ref" TEXT NOT NULL,
  "profile_id" TEXT NOT NULL,
  "profile_version" INTEGER NOT NULL,
  "purpose" TEXT NOT NULL DEFAULT 'issue',
  "revision" INTEGER NOT NULL DEFAULT 1,
  "status" TEXT NOT NULL DEFAULT 'created',
  "version" INTEGER NOT NULL DEFAULT 0,
  "document_model" TEXT NOT NULL DEFAULT 'nfce',
  "environment" TEXT NOT NULL,
  "provider" TEXT NOT NULL,
  "numbering_owner" TEXT NOT NULL,
  "series" INTEGER,
  "number" INTEGER,
  "provider_reference" TEXT,
  "access_key" TEXT,
  "authorization_protocol" TEXT,
  "cancellation_protocol" TEXT,
  "rejection_code" TEXT,
  "rejection_message" TEXT,
  "provider_sequence" BIGINT,
  "provider_occurred_at" TIMESTAMPTZ,
  "unknown_since" TIMESTAMPTZ,
  "next_reconcile_at" TIMESTAMPTZ,
  "contingency_started_at" TIMESTAMPTZ,
  "contingency_reason" TEXT,
  "cancel_requested_at" TIMESTAMPTZ,
  "cancellation_reason" TEXT,
  "authorized_at" TIMESTAMPTZ,
  "cancelled_at" TIMESTAMPTZ,
  "currency" TEXT NOT NULL DEFAULT 'BRL',
  "total_cents" INTEGER NOT NULL,
  "sale_snapshot" JSONB NOT NULL,
  "snapshot_hash" TEXT NOT NULL,
  "idempotency_key" TEXT NOT NULL,
  "request_hash" TEXT NOT NULL,
  "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "pos_fiscal_documents_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "pos_fiscal_documents_status_check" CHECK ("status" IN ('created', 'queued', 'processing', 'authorized', 'rejected', 'technical_error', 'contingency_pending', 'contingency', 'unknown', 'cancellation_pending', 'cancelled', 'manual_review')),
  CONSTRAINT "pos_fiscal_documents_values_check" CHECK (
    "purpose" IN ('issue', 'correction')
    AND "revision" > 0
    AND "version" >= 0
    AND "document_model" IN ('nfce', 'nfe', 'cfe')
    AND "environment" IN ('homologation', 'production')
    AND "numbering_owner" IN ('provider', 'local')
    AND char_length("provider") BETWEEN 2 AND 80
    AND "currency" = 'BRL'
    AND "total_cents" > 0
    AND "snapshot_hash" ~ '^[0-9a-f]{64}$'
    AND "request_hash" ~ '^[0-9a-f]{64}$'
    AND char_length("idempotency_key") BETWEEN 16 AND 160
    AND ("provider_sequence" IS NULL OR "provider_sequence" > 0)
    AND (("series" IS NULL AND "number" IS NULL) OR ("series" BETWEEN 0 AND 999 AND "number" > 0))
    AND ("numbering_owner" = 'provider' OR ("series" IS NOT NULL AND "number" IS NOT NULL))
    AND ("access_key" IS NULL OR "access_key" ~ '^[0-9]{44}$')
  ),
  CONSTRAINT "pos_fiscal_documents_reconcile_check" CHECK (
    ("status" IN ('queued', 'processing', 'unknown', 'contingency_pending', 'contingency', 'cancellation_pending') AND "next_reconcile_at" IS NOT NULL)
    OR ("status" NOT IN ('queued', 'processing', 'unknown', 'contingency_pending', 'contingency', 'cancellation_pending') AND "next_reconcile_at" IS NULL)
  ),
  CONSTRAINT "pos_fiscal_documents_unknown_check" CHECK (("status" = 'unknown') = ("unknown_since" IS NOT NULL)),
  CONSTRAINT "pos_fiscal_documents_authorization_check" CHECK (
    "status" NOT IN ('authorized', 'cancellation_pending', 'cancelled')
    OR ("access_key" IS NOT NULL AND "authorization_protocol" IS NOT NULL AND "provider_reference" IS NOT NULL AND "provider_occurred_at" IS NOT NULL AND "authorized_at" IS NOT NULL)
  ),
  CONSTRAINT "pos_fiscal_documents_rejection_check" CHECK (
    ("status" = 'rejected' AND "rejection_code" IS NOT NULL AND "rejection_message" IS NOT NULL AND "access_key" IS NULL AND "authorization_protocol" IS NULL AND "authorized_at" IS NULL)
    OR ("status" <> 'rejected' AND "rejection_code" IS NULL AND "rejection_message" IS NULL)
  ),
  CONSTRAINT "pos_fiscal_documents_contingency_check" CHECK (
    ("status" IN ('contingency_pending', 'contingency') AND "contingency_started_at" IS NOT NULL AND char_length("contingency_reason") BETWEEN 15 AND 255)
    OR ("status" NOT IN ('contingency_pending', 'contingency') AND "contingency_started_at" IS NULL AND "contingency_reason" IS NULL)
  ),
  CONSTRAINT "pos_fiscal_documents_cancellation_check" CHECK (
    ("status" = 'cancellation_pending' AND "cancel_requested_at" IS NOT NULL AND char_length("cancellation_reason") BETWEEN 15 AND 255 AND "cancelled_at" IS NULL AND "cancellation_protocol" IS NULL)
    OR ("status" = 'cancelled' AND "cancel_requested_at" IS NOT NULL AND char_length("cancellation_reason") BETWEEN 15 AND 255 AND "cancelled_at" IS NOT NULL AND "cancellation_protocol" IS NOT NULL)
    OR ("status" NOT IN ('cancellation_pending', 'cancelled') AND "cancel_requested_at" IS NULL AND "cancellation_reason" IS NULL AND "cancelled_at" IS NULL AND "cancellation_protocol" IS NULL)
  ),
  CONSTRAINT "pos_fiscal_documents_sale_context_fkey" FOREIGN KEY ("sale_id", "branch_id", "session_id", "operator_profile_id") REFERENCES "sales"("id", "branch_id", "session_id", "operator_profile_id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "pos_fiscal_documents_register_branch_fkey" FOREIGN KEY ("register_id", "branch_id") REFERENCES "pos_registers"("id", "branch_id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "pos_fiscal_documents_session_register_fkey" FOREIGN KEY ("session_id", "register_id") REFERENCES "cash_register_sessions"("id", "register_id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "pos_fiscal_documents_terminal_register_fkey" FOREIGN KEY ("terminal_id", "register_id") REFERENCES "pos_terminals"("id", "register_id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "pos_fiscal_documents_connector_context_fkey" FOREIGN KEY ("connector_id", "branch_id", "provider") REFERENCES "pos_connectors"("id", "branch_id", "provider") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "pos_fiscal_documents_credential_ref_fkey" FOREIGN KEY ("credential_ref") REFERENCES "integration_credentials"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "pos_fiscal_documents_profile_context_fkey" FOREIGN KEY ("profile_id", "profile_version", "branch_id", "connector_id", "credential_ref", "provider", "document_model", "environment", "numbering_owner") REFERENCES "pos_fiscal_profiles"("id", "version", "branch_id", "connector_id", "credential_ref", "provider", "document_model", "environment", "numbering_owner") ON DELETE RESTRICT ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "pos_fiscal_documents_sale_model_purpose_revision_key"
  ON "pos_fiscal_documents"("sale_id", "document_model", "purpose", "revision");
CREATE UNIQUE INDEX "pos_fiscal_documents_idempotency_key_key"
  ON "pos_fiscal_documents"("idempotency_key");
CREATE UNIQUE INDEX "pos_fiscal_documents_access_key_key"
  ON "pos_fiscal_documents"("access_key") WHERE "access_key" IS NOT NULL;
CREATE UNIQUE INDEX "pos_fiscal_documents_provider_reference_key"
  ON "pos_fiscal_documents"("provider", "provider_reference") WHERE "provider_reference" IS NOT NULL;
CREATE UNIQUE INDEX "pos_fiscal_documents_number_key"
  ON "pos_fiscal_documents"("branch_id", "document_model", "environment", "series", "number") WHERE "series" IS NOT NULL AND "number" IS NOT NULL;
CREATE INDEX "pos_fiscal_documents_session_status_idx" ON "pos_fiscal_documents"("session_id", "status");
CREATE INDEX "pos_fiscal_documents_status_reconcile_idx" ON "pos_fiscal_documents"("status", "next_reconcile_at");
CREATE INDEX "pos_fiscal_documents_connector_created_idx" ON "pos_fiscal_documents"("connector_id", "created_at");
CREATE INDEX "pos_fiscal_documents_profile_version_idx" ON "pos_fiscal_documents"("profile_id", "profile_version");
CREATE INDEX "pos_fiscal_documents_credential_status_idx" ON "pos_fiscal_documents"("credential_ref", "status");

CREATE TABLE "pos_fiscal_attempts" (
  "id" TEXT NOT NULL,
  "document_id" TEXT NOT NULL,
  "sequence" INTEGER NOT NULL,
  "operation" TEXT NOT NULL,
  "state" TEXT NOT NULL DEFAULT 'queued',
  "operation_key" TEXT NOT NULL,
  "request_hash" TEXT NOT NULL,
  "provider_idempotency_key" TEXT NOT NULL,
  "reason" TEXT,
  "dispatch_count" INTEGER NOT NULL DEFAULT 0,
  "outcome_unknown" BOOLEAN NOT NULL DEFAULT false,
  "response_hash" TEXT,
  "failure_code" TEXT,
  "started_at" TIMESTAMPTZ,
  "finished_at" TIMESTAMPTZ,
  "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "pos_fiscal_attempts_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "pos_fiscal_attempts_operation_check" CHECK ("operation" IN ('issue', 'query', 'contingency', 'cancel')),
  CONSTRAINT "pos_fiscal_attempts_state_check" CHECK ("state" IN ('queued', 'claimed', 'retry', 'succeeded', 'unknown', 'failed', 'dead')),
  CONSTRAINT "pos_fiscal_attempts_values_check" CHECK (
    "sequence" > 0 AND "dispatch_count" >= 0
    AND char_length("operation_key") BETWEEN 16 AND 160
    AND char_length("provider_idempotency_key") BETWEEN 16 AND 160
    AND "request_hash" ~ '^[0-9a-f]{64}$'
    AND ("response_hash" IS NULL OR "response_hash" ~ '^[0-9a-f]{64}$')
    AND ("reason" IS NULL OR char_length("reason") BETWEEN 15 AND 255)
  ),
  CONSTRAINT "pos_fiscal_attempts_completion_check" CHECK (
    ("state" IN ('succeeded', 'unknown', 'failed', 'dead') AND "finished_at" IS NOT NULL)
    OR ("state" NOT IN ('succeeded', 'unknown', 'failed', 'dead') AND "finished_at" IS NULL)
  ),
  CONSTRAINT "pos_fiscal_attempts_unknown_check" CHECK ("outcome_unknown" = ("state" = 'unknown')),
  CONSTRAINT "pos_fiscal_attempts_document_id_fkey" FOREIGN KEY ("document_id") REFERENCES "pos_fiscal_documents"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "pos_fiscal_attempts_operation_key_key" ON "pos_fiscal_attempts"("operation_key");
CREATE UNIQUE INDEX "pos_fiscal_attempts_document_sequence_key" ON "pos_fiscal_attempts"("document_id", "sequence");
CREATE INDEX "pos_fiscal_attempts_document_created_idx" ON "pos_fiscal_attempts"("document_id", "created_at");

CREATE TABLE "pos_fiscal_outbox" (
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
  CONSTRAINT "pos_fiscal_outbox_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "pos_fiscal_outbox_state_check" CHECK ("state" IN ('pending', 'claimed', 'retry', 'completed', 'dead')),
  CONSTRAINT "pos_fiscal_outbox_values_check" CHECK ("delivery_count" >= 0 AND "max_deliveries" BETWEEN 1 AND 20 AND "delivery_count" <= "max_deliveries"),
  CONSTRAINT "pos_fiscal_outbox_claim_check" CHECK (("state" = 'claimed') = ("claim_token" IS NOT NULL AND "claim_expires_at" IS NOT NULL)),
  CONSTRAINT "pos_fiscal_outbox_completion_check" CHECK (("state" IN ('completed', 'dead')) = ("completed_at" IS NOT NULL)),
  CONSTRAINT "pos_fiscal_outbox_attempt_id_fkey" FOREIGN KEY ("attempt_id") REFERENCES "pos_fiscal_attempts"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "pos_fiscal_outbox_attempt_id_key" ON "pos_fiscal_outbox"("attempt_id");
CREATE UNIQUE INDEX "pos_fiscal_outbox_claim_token_key" ON "pos_fiscal_outbox"("claim_token") WHERE "claim_token" IS NOT NULL;
CREATE INDEX "pos_fiscal_outbox_state_next_attempt_idx" ON "pos_fiscal_outbox"("state", "next_attempt_at");
CREATE INDEX "pos_fiscal_outbox_claim_expires_idx" ON "pos_fiscal_outbox"("claim_expires_at") WHERE "state" = 'claimed';

CREATE TABLE "pos_fiscal_callbacks" (
  "id" BIGSERIAL NOT NULL,
  "document_id" TEXT NOT NULL,
  "provider" TEXT NOT NULL,
  "event_id" TEXT NOT NULL,
  "payload_hash" TEXT NOT NULL,
  "signature_key_id" TEXT NOT NULL,
  "provider_reference" TEXT NOT NULL,
  "reported_state" TEXT NOT NULL,
  "provider_sequence" BIGINT,
  "provider_occurred_at" TIMESTAMPTZ NOT NULL,
  "total_cents" INTEGER NOT NULL,
  "currency" TEXT NOT NULL,
  "evidence" JSONB NOT NULL,
  "processing_result" TEXT NOT NULL,
  "resulting_state" TEXT NOT NULL,
  "resulting_version" INTEGER NOT NULL,
  "received_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "pos_fiscal_callbacks_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "pos_fiscal_callbacks_state_check" CHECK ("reported_state" IN ('processing', 'authorized', 'rejected', 'contingency', 'cancelled', 'unknown')),
  CONSTRAINT "pos_fiscal_callbacks_result_state_check" CHECK ("resulting_state" IN ('created', 'queued', 'processing', 'authorized', 'rejected', 'technical_error', 'contingency_pending', 'contingency', 'unknown', 'cancellation_pending', 'cancelled', 'manual_review')),
  CONSTRAINT "pos_fiscal_callbacks_result_check" CHECK ("processing_result" IN ('applied', 'no_change', 'ignored_stale', 'rejected_context', 'rejected_transition', 'incident_opened')),
  CONSTRAINT "pos_fiscal_callbacks_values_check" CHECK (
    char_length("provider") BETWEEN 2 AND 80
    AND char_length("event_id") BETWEEN 8 AND 160
    AND char_length("signature_key_id") BETWEEN 1 AND 160
    AND char_length("provider_reference") BETWEEN 1 AND 160
    AND "payload_hash" ~ '^[0-9a-f]{64}$'
    AND ("provider_sequence" IS NULL OR "provider_sequence" > 0)
    AND "total_cents" > 0 AND "currency" = 'BRL' AND "resulting_version" >= 0
  ),
  CONSTRAINT "pos_fiscal_callbacks_document_id_fkey" FOREIGN KEY ("document_id") REFERENCES "pos_fiscal_documents"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "pos_fiscal_callbacks_provider_event_key" ON "pos_fiscal_callbacks"("provider", "event_id");
CREATE INDEX "pos_fiscal_callbacks_document_received_idx" ON "pos_fiscal_callbacks"("document_id", "received_at");

CREATE TABLE "pos_fiscal_state_events" (
  "id" BIGSERIAL NOT NULL,
  "document_id" TEXT NOT NULL,
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
  CONSTRAINT "pos_fiscal_state_events_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "pos_fiscal_state_events_source_check" CHECK ("source" IN ('sale_commit', 'api', 'worker', 'callback', 'maintenance')),
  CONSTRAINT "pos_fiscal_state_events_state_check" CHECK (
    ("from_state" IS NULL OR "from_state" IN ('created', 'queued', 'processing', 'authorized', 'rejected', 'technical_error', 'contingency_pending', 'contingency', 'unknown', 'cancellation_pending', 'cancelled', 'manual_review'))
    AND "to_state" IN ('created', 'queued', 'processing', 'authorized', 'rejected', 'technical_error', 'contingency_pending', 'contingency', 'unknown', 'cancellation_pending', 'cancelled', 'manual_review')
  ),
  CONSTRAINT "pos_fiscal_state_events_values_check" CHECK (
    "resulting_version" >= 0 AND char_length("event_key") BETWEEN 8 AND 200
    AND char_length("source_id") BETWEEN 1 AND 200
    AND ("evidence_hash" IS NULL OR "evidence_hash" ~ '^[0-9a-f]{64}$')
  ),
  CONSTRAINT "pos_fiscal_state_events_document_id_fkey" FOREIGN KEY ("document_id") REFERENCES "pos_fiscal_documents"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "pos_fiscal_state_events_attempt_id_fkey" FOREIGN KEY ("attempt_id") REFERENCES "pos_fiscal_attempts"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "pos_fiscal_state_events_event_key_key" ON "pos_fiscal_state_events"("event_key");
CREATE UNIQUE INDEX "pos_fiscal_state_events_document_version_key" ON "pos_fiscal_state_events"("document_id", "resulting_version");
CREATE INDEX "pos_fiscal_state_events_document_created_idx" ON "pos_fiscal_state_events"("document_id", "created_at");

CREATE TABLE "pos_fiscal_artifacts" (
  "id" TEXT NOT NULL,
  "document_id" TEXT NOT NULL,
  "type" TEXT NOT NULL,
  "provider_artifact_id" TEXT,
  "storage_key" TEXT NOT NULL,
  "mime_type" TEXT NOT NULL,
  "size_bytes" INTEGER NOT NULL,
  "sha256" TEXT NOT NULL,
  "encryption_key_id" TEXT,
  "retention_until" TIMESTAMPTZ,
  "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "pos_fiscal_artifacts_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "pos_fiscal_artifacts_type_check" CHECK ("type" IN ('authorized_xml', 'contingency_xml', 'authorization_protocol', 'cancellation_protocol', 'danfe', 'qr', 'provider_response_redacted')),
  CONSTRAINT "pos_fiscal_artifacts_values_check" CHECK (
    char_length("storage_key") BETWEEN 8 AND 500
    AND "mime_type" IN ('application/xml', 'text/xml', 'application/pdf', 'application/json', 'text/plain', 'image/png')
    AND "size_bytes" BETWEEN 1 AND 52428800
    AND "sha256" ~ '^[0-9a-f]{64}$'
    AND ("encryption_key_id" IS NULL OR char_length("encryption_key_id") BETWEEN 1 AND 160)
  ),
  CONSTRAINT "pos_fiscal_artifacts_document_id_fkey" FOREIGN KEY ("document_id") REFERENCES "pos_fiscal_documents"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "pos_fiscal_artifacts_storage_key_key" ON "pos_fiscal_artifacts"("storage_key");
CREATE UNIQUE INDEX "pos_fiscal_artifacts_document_type_key" ON "pos_fiscal_artifacts"("document_id", "type");
CREATE INDEX "pos_fiscal_artifacts_document_created_idx" ON "pos_fiscal_artifacts"("document_id", "created_at");

CREATE TABLE "pos_fiscal_delivery_results" (
  "id" BIGSERIAL NOT NULL,
  "document_id" TEXT NOT NULL,
  "attempt_id" TEXT NOT NULL,
  "outbox_id" BIGINT NOT NULL,
  "delivery_number" INTEGER NOT NULL,
  "claim_token_hash" TEXT NOT NULL,
  "response_hash" TEXT NOT NULL,
  "result_kind" TEXT NOT NULL,
  "retry_scheduled" BOOLEAN NOT NULL DEFAULT false,
  "superseded" BOOLEAN NOT NULL DEFAULT false,
  "resulting_attempt_state" TEXT NOT NULL,
  "resulting_document_state" TEXT NOT NULL,
  "resulting_document_version" INTEGER NOT NULL,
  "completed_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "pos_fiscal_delivery_results_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "pos_fiscal_delivery_results_values_check" CHECK (
    "delivery_number" > 0
    AND "claim_token_hash" ~ '^[0-9a-f]{64}$'
    AND "response_hash" ~ '^[0-9a-f]{64}$'
    AND "result_kind" IN ('result', 'unknown', 'known_failure')
    AND "resulting_attempt_state" IN ('claimed', 'retry', 'succeeded', 'unknown', 'failed', 'dead')
    AND "resulting_document_state" IN ('created', 'queued', 'processing', 'authorized', 'rejected', 'technical_error', 'contingency_pending', 'contingency', 'unknown', 'cancellation_pending', 'cancelled', 'manual_review')
    AND "resulting_document_version" >= 0
  ),
  CONSTRAINT "pos_fiscal_delivery_results_document_id_fkey" FOREIGN KEY ("document_id") REFERENCES "pos_fiscal_documents"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "pos_fiscal_delivery_results_attempt_id_fkey" FOREIGN KEY ("attempt_id") REFERENCES "pos_fiscal_attempts"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "pos_fiscal_delivery_results_outbox_id_fkey" FOREIGN KEY ("outbox_id") REFERENCES "pos_fiscal_outbox"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "pos_fiscal_delivery_claim_hash_key" ON "pos_fiscal_delivery_results"("claim_token_hash");
CREATE UNIQUE INDEX "pos_fiscal_delivery_attempt_number_key" ON "pos_fiscal_delivery_results"("attempt_id", "delivery_number");
CREATE INDEX "pos_fiscal_delivery_document_completed_idx" ON "pos_fiscal_delivery_results"("document_id", "completed_at");

CREATE TABLE "pos_fiscal_integrity_incidents" (
  "id" TEXT NOT NULL,
  "document_id" TEXT NOT NULL,
  "callback_id" BIGINT,
  "kind" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'open',
  "production_blocking" BOOLEAN NOT NULL DEFAULT true,
  "expected_evidence_hash" TEXT NOT NULL,
  "reported_evidence_hash" TEXT NOT NULL,
  "details" JSONB,
  "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "resolved_at" TIMESTAMPTZ,
  "resolved_by_actor_id" TEXT,
  "resolution_reason" TEXT,
  CONSTRAINT "pos_fiscal_integrity_incidents_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "pos_fiscal_integrity_incidents_kind_check" CHECK ("kind" IN ('callback_context_mismatch', 'final_state_contradiction', 'number_mismatch', 'snapshot_mismatch', 'artifact_mismatch', 'unsolicited_event')),
  CONSTRAINT "pos_fiscal_integrity_incidents_status_check" CHECK ("status" IN ('open', 'resolved')),
  CONSTRAINT "pos_fiscal_integrity_incidents_values_check" CHECK ("expected_evidence_hash" ~ '^[0-9a-f]{64}$' AND "reported_evidence_hash" ~ '^[0-9a-f]{64}$'),
  CONSTRAINT "pos_fiscal_integrity_incidents_resolution_check" CHECK (
    ("status" = 'open' AND "production_blocking" AND "resolved_at" IS NULL AND "resolved_by_actor_id" IS NULL AND "resolution_reason" IS NULL)
    OR ("status" = 'resolved' AND NOT "production_blocking" AND "resolved_at" IS NOT NULL AND "resolved_by_actor_id" IS NOT NULL AND char_length("resolution_reason") BETWEEN 8 AND 500)
  ),
  CONSTRAINT "pos_fiscal_integrity_incidents_document_id_fkey" FOREIGN KEY ("document_id") REFERENCES "pos_fiscal_documents"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "pos_fiscal_integrity_incidents_callback_id_fkey" FOREIGN KEY ("callback_id") REFERENCES "pos_fiscal_callbacks"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "pos_fiscal_integrity_callback_key" ON "pos_fiscal_integrity_incidents"("callback_id") WHERE "callback_id" IS NOT NULL;
CREATE INDEX "pos_fiscal_integrity_status_blocking_created_idx" ON "pos_fiscal_integrity_incidents"("status", "production_blocking", "created_at");
CREATE INDEX "pos_fiscal_integrity_document_status_idx" ON "pos_fiscal_integrity_incidents"("document_id", "status");

CREATE FUNCTION "validate_pos_fiscal_profile_context"() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  credential_valid BOOLEAN;
BEGIN
  IF NEW."status" = 'active' AND NEW."environment" = 'production' THEN
    RAISE EXCEPTION 'production fiscal profile requires external homologation gate not installed by this migration' USING ERRCODE = '0A000';
  END IF;
  IF NEW."status" = 'active' AND NEW."numbering_owner" <> 'provider' THEN
    RAISE EXCEPTION 'local fiscal numbering is not enabled without a dedicated immutable reservation ledger' USING ERRCODE = '0A000';
  END IF;
  SELECT EXISTS (
    SELECT 1
      FROM "integration_credentials" c
      JOIN "integration_providers" p ON p."id" = c."provider_id"
     WHERE c."id" = NEW."credential_ref"
       AND c."provider_id" = NEW."provider"
       AND p."family" = 'fiscal'
       AND (NEW."status" <> 'active' OR c."enabled")
  ) INTO credential_valid;
  IF NOT credential_valid THEN
    RAISE EXCEPTION 'fiscal profile credential/provider context is invalid' USING ERRCODE = '22000';
  END IF;
  IF NEW."status" = 'active' AND NOT EXISTS (
    SELECT 1 FROM "pos_connectors" c
     WHERE c."id" = NEW."connector_id" AND c."branch_id" = NEW."branch_id"
       AND c."provider" = NEW."provider" AND c."status" = 'active'
       AND c."type" LIKE 'fiscal%'
  ) THEN
    RAISE EXCEPTION 'active fiscal profile requires active fiscal connector' USING ERRCODE = '22000';
  END IF;
  IF NEW."status" = 'active' THEN
    PERFORM 1 FROM "branches" WHERE "id" = NEW."branch_id" FOR UPDATE;
    IF EXISTS (
      SELECT 1 FROM "pos_fiscal_profiles" p
       WHERE p."id" <> NEW."id" AND p."branch_id" = NEW."branch_id"
         AND p."document_model" = NEW."document_model" AND p."environment" = NEW."environment"
         AND p."status" = 'active'
         AND tstzrange(COALESCE(p."effective_from", '-infinity'::timestamptz), COALESCE(p."effective_until", 'infinity'::timestamptz), '[)')
             && tstzrange(COALESCE(NEW."effective_from", '-infinity'::timestamptz), COALESCE(NEW."effective_until", 'infinity'::timestamptz), '[)')
    ) THEN
      RAISE EXCEPTION 'active fiscal profile validity overlaps another profile' USING ERRCODE = '23P01';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "pos_fiscal_profiles_context_guard"
BEFORE INSERT OR UPDATE ON "pos_fiscal_profiles"
FOR EACH ROW EXECUTE FUNCTION "validate_pos_fiscal_profile_context"();

CREATE FUNCTION "protect_pos_fiscal_profile"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF OLD."id" IS DISTINCT FROM NEW."id" OR OLD."branch_id" IS DISTINCT FROM NEW."branch_id"
    OR OLD."connector_id" IS DISTINCT FROM NEW."connector_id" OR OLD."credential_ref" IS DISTINCT FROM NEW."credential_ref"
    OR OLD."version" IS DISTINCT FROM NEW."version" OR OLD."document_model" IS DISTINCT FROM NEW."document_model"
    OR OLD."environment" IS DISTINCT FROM NEW."environment" OR OLD."uf" IS DISTINCT FROM NEW."uf"
    OR OLD."tax_regime" IS DISTINCT FROM NEW."tax_regime" OR OLD."schema_version" IS DISTINCT FROM NEW."schema_version"
    OR OLD."provider" IS DISTINCT FROM NEW."provider" OR OLD."numbering_owner" IS DISTINCT FROM NEW."numbering_owner"
    OR OLD."series" IS DISTINCT FROM NEW."series" OR OLD."next_number" IS DISTINCT FROM NEW."next_number"
    OR OLD."policy_snapshot" IS DISTINCT FROM NEW."policy_snapshot" OR OLD."policy_digest" IS DISTINCT FROM NEW."policy_digest"
    OR OLD."certificate_fingerprint" IS DISTINCT FROM NEW."certificate_fingerprint" OR OLD."effective_from" IS DISTINCT FROM NEW."effective_from"
    OR OLD."created_by" IS DISTINCT FROM NEW."created_by" OR OLD."created_at" IS DISTINCT FROM NEW."created_at"
  THEN
    IF OLD."status" <> 'draft' OR EXISTS (SELECT 1 FROM "pos_fiscal_documents" d WHERE d."profile_id" = OLD."id") THEN
      RAISE EXCEPTION 'active or used fiscal profile evidence is immutable' USING ERRCODE = '55000';
    END IF;
  END IF;
  IF OLD."status" = 'retired' OR (OLD."status" = 'active' AND NEW."status" NOT IN ('active', 'retired'))
    OR (OLD."status" = 'draft' AND NEW."status" NOT IN ('draft', 'active'))
  THEN RAISE EXCEPTION 'invalid fiscal profile transition' USING ERRCODE = '22000'; END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "pos_fiscal_profiles_immutable_guard"
BEFORE UPDATE ON "pos_fiscal_profiles"
FOR EACH ROW EXECUTE FUNCTION "protect_pos_fiscal_profile"();

CREATE FUNCTION "protect_pos_fiscal_document"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF OLD."id" IS DISTINCT FROM NEW."id" OR OLD."sale_id" IS DISTINCT FROM NEW."sale_id"
    OR OLD."branch_id" IS DISTINCT FROM NEW."branch_id" OR OLD."register_id" IS DISTINCT FROM NEW."register_id"
    OR OLD."session_id" IS DISTINCT FROM NEW."session_id" OR OLD."operator_profile_id" IS DISTINCT FROM NEW."operator_profile_id"
    OR OLD."terminal_id" IS DISTINCT FROM NEW."terminal_id" OR OLD."connector_id" IS DISTINCT FROM NEW."connector_id"
    OR OLD."credential_ref" IS DISTINCT FROM NEW."credential_ref" OR OLD."profile_id" IS DISTINCT FROM NEW."profile_id"
    OR OLD."profile_version" IS DISTINCT FROM NEW."profile_version" OR OLD."purpose" IS DISTINCT FROM NEW."purpose"
    OR OLD."revision" IS DISTINCT FROM NEW."revision" OR OLD."document_model" IS DISTINCT FROM NEW."document_model"
    OR OLD."environment" IS DISTINCT FROM NEW."environment" OR OLD."provider" IS DISTINCT FROM NEW."provider"
    OR OLD."numbering_owner" IS DISTINCT FROM NEW."numbering_owner" OR OLD."currency" IS DISTINCT FROM NEW."currency"
    OR OLD."total_cents" IS DISTINCT FROM NEW."total_cents" OR OLD."sale_snapshot" IS DISTINCT FROM NEW."sale_snapshot"
    OR OLD."snapshot_hash" IS DISTINCT FROM NEW."snapshot_hash" OR OLD."idempotency_key" IS DISTINCT FROM NEW."idempotency_key"
    OR OLD."request_hash" IS DISTINCT FROM NEW."request_hash" OR OLD."created_at" IS DISTINCT FROM NEW."created_at"
  THEN RAISE EXCEPTION 'fiscal document identity and snapshot are immutable' USING ERRCODE = '55000'; END IF;
  IF NEW."version" <> OLD."version" + 1 THEN
    RAISE EXCEPTION 'fiscal document version must advance exactly once' USING ERRCODE = '40001';
  END IF;
  IF OLD."provider_reference" IS NOT NULL AND NEW."provider_reference" IS DISTINCT FROM OLD."provider_reference" THEN
    RAISE EXCEPTION 'fiscal provider reference is immutable once bound' USING ERRCODE = '55000';
  END IF;
  IF OLD."series" IS NOT NULL AND NEW."series" IS DISTINCT FROM OLD."series" OR OLD."number" IS NOT NULL AND NEW."number" IS DISTINCT FROM OLD."number" THEN
    RAISE EXCEPTION 'fiscal numbering is immutable once bound' USING ERRCODE = '55000';
  END IF;
  IF OLD."access_key" IS NOT NULL AND NEW."access_key" IS DISTINCT FROM OLD."access_key" THEN
    RAISE EXCEPTION 'fiscal access key is immutable once bound' USING ERRCODE = '55000';
  END IF;
  IF NEW."provider_sequence" IS NOT NULL AND OLD."provider_sequence" IS NOT NULL AND NEW."provider_sequence" < OLD."provider_sequence" THEN
    RAISE EXCEPTION 'fiscal provider sequence cannot regress' USING ERRCODE = '22000';
  END IF;
  IF OLD."status" <> NEW."status" AND NOT (
    (OLD."status" = 'created' AND NEW."status" IN ('queued', 'contingency_pending'))
    OR (OLD."status" = 'queued' AND NEW."status" IN ('processing', 'authorized', 'rejected', 'technical_error', 'unknown', 'contingency_pending'))
    OR (OLD."status" = 'processing' AND NEW."status" IN ('authorized', 'rejected', 'technical_error', 'unknown', 'contingency_pending'))
    OR (OLD."status" = 'unknown' AND NEW."status" IN ('processing', 'authorized', 'rejected', 'technical_error', 'contingency_pending', 'manual_review'))
    OR (OLD."status" = 'technical_error' AND NEW."status" IN ('queued', 'processing', 'contingency_pending', 'manual_review'))
    OR (OLD."status" = 'contingency_pending' AND NEW."status" IN ('contingency', 'authorized', 'rejected', 'technical_error', 'unknown'))
    OR (OLD."status" = 'contingency' AND NEW."status" IN ('authorized', 'rejected', 'cancellation_pending', 'manual_review'))
    OR (OLD."status" = 'authorized' AND NEW."status" IN ('cancellation_pending', 'manual_review'))
    OR (OLD."status" = 'cancellation_pending' AND NEW."status" IN ('authorized', 'cancelled', 'manual_review'))
    OR (OLD."status" = 'manual_review' AND NEW."status" IN ('processing', 'authorized', 'rejected', 'contingency', 'cancellation_pending', 'cancelled'))
  ) THEN RAISE EXCEPTION 'invalid fiscal document transition % -> %', OLD."status", NEW."status" USING ERRCODE = '22000'; END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "pos_fiscal_documents_guard"
BEFORE UPDATE ON "pos_fiscal_documents"
FOR EACH ROW EXECUTE FUNCTION "protect_pos_fiscal_document"();

CREATE FUNCTION "validate_pos_fiscal_document_evidence"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW."status" IN ('authorized', 'cancellation_pending', 'cancelled') AND NOT EXISTS (
    SELECT 1 FROM "pos_fiscal_artifacts" a WHERE a."document_id" = NEW."id" AND a."type" = 'authorized_xml'
  ) THEN RAISE EXCEPTION 'authorized fiscal document requires immutable XML artifact' USING ERRCODE = '22000'; END IF;
  IF NEW."status" = 'contingency' AND NOT EXISTS (
    SELECT 1 FROM "pos_fiscal_artifacts" a WHERE a."document_id" = NEW."id" AND a."type" = 'contingency_xml'
  ) THEN RAISE EXCEPTION 'fiscal contingency requires immutable XML artifact' USING ERRCODE = '22000'; END IF;
  IF NEW."status" = 'cancelled' AND NOT EXISTS (
    SELECT 1 FROM "pos_fiscal_artifacts" a WHERE a."document_id" = NEW."id" AND a."type" = 'cancellation_protocol'
  ) THEN RAISE EXCEPTION 'cancelled fiscal document requires cancellation artifact' USING ERRCODE = '22000'; END IF;
  RETURN NULL;
END;
$$;

CREATE CONSTRAINT TRIGGER "pos_fiscal_documents_evidence_guard"
AFTER INSERT OR UPDATE ON "pos_fiscal_documents"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION "validate_pos_fiscal_document_evidence"();

CREATE FUNCTION "protect_pos_fiscal_attempt"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF OLD."state" IN ('succeeded', 'unknown', 'failed', 'dead') THEN
    RAISE EXCEPTION 'completed fiscal attempt is immutable' USING ERRCODE = '55000';
  END IF;
  IF OLD."id" IS DISTINCT FROM NEW."id" OR OLD."document_id" IS DISTINCT FROM NEW."document_id"
    OR OLD."sequence" IS DISTINCT FROM NEW."sequence" OR OLD."operation" IS DISTINCT FROM NEW."operation"
    OR OLD."operation_key" IS DISTINCT FROM NEW."operation_key" OR OLD."request_hash" IS DISTINCT FROM NEW."request_hash"
    OR OLD."provider_idempotency_key" IS DISTINCT FROM NEW."provider_idempotency_key" OR OLD."reason" IS DISTINCT FROM NEW."reason"
    OR OLD."created_at" IS DISTINCT FROM NEW."created_at"
  THEN RAISE EXCEPTION 'fiscal attempt identity is immutable' USING ERRCODE = '55000'; END IF;
  IF OLD."state" <> NEW."state" AND NOT (
    (OLD."state" IN ('queued', 'retry') AND NEW."state" IN ('claimed', 'retry', 'failed', 'dead'))
    OR (OLD."state" = 'claimed' AND NEW."state" IN ('succeeded', 'unknown', 'retry', 'failed', 'dead'))
  ) THEN RAISE EXCEPTION 'invalid fiscal attempt transition' USING ERRCODE = '22000'; END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "pos_fiscal_attempts_guard" BEFORE UPDATE ON "pos_fiscal_attempts"
FOR EACH ROW EXECUTE FUNCTION "protect_pos_fiscal_attempt"();

CREATE FUNCTION "protect_pos_fiscal_outbox"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF OLD."state" IN ('completed', 'dead') THEN
    RAISE EXCEPTION 'completed fiscal outbox is immutable' USING ERRCODE = '55000';
  END IF;
  IF OLD."id" IS DISTINCT FROM NEW."id" OR OLD."attempt_id" IS DISTINCT FROM NEW."attempt_id"
    OR OLD."max_deliveries" IS DISTINCT FROM NEW."max_deliveries" OR OLD."created_at" IS DISTINCT FROM NEW."created_at"
  THEN RAISE EXCEPTION 'fiscal outbox identity is immutable' USING ERRCODE = '55000'; END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "pos_fiscal_outbox_guard" BEFORE UPDATE ON "pos_fiscal_outbox"
FOR EACH ROW EXECUTE FUNCTION "protect_pos_fiscal_outbox"();

CREATE FUNCTION "reject_pos_fiscal_history_mutation"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'fiscal evidence history is immutable' USING ERRCODE = '55000';
END;
$$;

CREATE TRIGGER "pos_fiscal_profiles_delete_guard" BEFORE DELETE ON "pos_fiscal_profiles" FOR EACH ROW EXECUTE FUNCTION "reject_pos_fiscal_history_mutation"();
CREATE TRIGGER "pos_fiscal_documents_delete_guard" BEFORE DELETE ON "pos_fiscal_documents" FOR EACH ROW EXECUTE FUNCTION "reject_pos_fiscal_history_mutation"();
CREATE TRIGGER "pos_fiscal_attempts_delete_guard" BEFORE DELETE ON "pos_fiscal_attempts" FOR EACH ROW EXECUTE FUNCTION "reject_pos_fiscal_history_mutation"();
CREATE TRIGGER "pos_fiscal_outbox_delete_guard" BEFORE DELETE ON "pos_fiscal_outbox" FOR EACH ROW EXECUTE FUNCTION "reject_pos_fiscal_history_mutation"();
CREATE TRIGGER "pos_fiscal_callbacks_immutable_guard" BEFORE UPDATE OR DELETE ON "pos_fiscal_callbacks" FOR EACH ROW EXECUTE FUNCTION "reject_pos_fiscal_history_mutation"();
CREATE TRIGGER "pos_fiscal_state_events_immutable_guard" BEFORE UPDATE OR DELETE ON "pos_fiscal_state_events" FOR EACH ROW EXECUTE FUNCTION "reject_pos_fiscal_history_mutation"();
CREATE TRIGGER "pos_fiscal_artifacts_immutable_guard" BEFORE UPDATE OR DELETE ON "pos_fiscal_artifacts" FOR EACH ROW EXECUTE FUNCTION "reject_pos_fiscal_history_mutation"();
CREATE TRIGGER "pos_fiscal_delivery_results_immutable_guard" BEFORE UPDATE OR DELETE ON "pos_fiscal_delivery_results" FOR EACH ROW EXECUTE FUNCTION "reject_pos_fiscal_history_mutation"();

CREATE FUNCTION "protect_pos_fiscal_integrity_incident"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF OLD."id" IS DISTINCT FROM NEW."id" OR OLD."document_id" IS DISTINCT FROM NEW."document_id"
    OR OLD."callback_id" IS DISTINCT FROM NEW."callback_id" OR OLD."kind" IS DISTINCT FROM NEW."kind"
    OR OLD."expected_evidence_hash" IS DISTINCT FROM NEW."expected_evidence_hash"
    OR OLD."reported_evidence_hash" IS DISTINCT FROM NEW."reported_evidence_hash"
    OR OLD."details" IS DISTINCT FROM NEW."details" OR OLD."created_at" IS DISTINCT FROM NEW."created_at"
  THEN RAISE EXCEPTION 'fiscal integrity incident evidence is immutable' USING ERRCODE = '55000'; END IF;
  IF OLD."status" <> 'open' OR NEW."status" <> 'resolved' OR NEW."production_blocking"
    OR NEW."resolved_at" IS NULL OR NEW."resolved_by_actor_id" IS NULL OR NEW."resolution_reason" IS NULL
  THEN RAISE EXCEPTION 'invalid fiscal integrity incident resolution' USING ERRCODE = '22000'; END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "pos_fiscal_integrity_incidents_guard" BEFORE UPDATE ON "pos_fiscal_integrity_incidents"
FOR EACH ROW EXECUTE FUNCTION "protect_pos_fiscal_integrity_incident"();
CREATE TRIGGER "pos_fiscal_integrity_incidents_delete_guard" BEFORE DELETE ON "pos_fiscal_integrity_incidents"
FOR EACH ROW EXECUTE FUNCTION "reject_pos_fiscal_history_mutation"();
