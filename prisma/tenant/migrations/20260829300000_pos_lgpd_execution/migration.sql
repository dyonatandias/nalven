-- POS-1104: executable LGPD workflow foundation.
-- No legal policy, KMS key, storage adapter or destructive producer is seeded.
-- Every execution job is born blocked and requires an explicit future adapter
-- integration before it can leave the blocked state.

CREATE TABLE "pos_lgpd_retention_policies" (
  "id" TEXT NOT NULL,
  "version" INTEGER NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'draft',
  "policy_hash" TEXT NOT NULL,
  "effective_from" TIMESTAMPTZ NOT NULL,
  "effective_until" TIMESTAMPTZ,
  "legal_approval_ref" TEXT,
  "proposed_by" TEXT NOT NULL,
  "homologated_by" TEXT,
  "homologated_at" TIMESTAMPTZ,
  "step_up_proof_hash" TEXT,
  "retired_by" TEXT,
  "retired_at" TIMESTAMPTZ,
  "retirement_reason" TEXT,
  "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "pos_lgpd_retention_policies_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "pos_lgpd_retention_policies_shape_check" CHECK (
    char_length("id") BETWEEN 8 AND 160 AND "version" > 0
    AND "status" IN ('draft', 'active', 'retired')
    AND "policy_hash" ~ '^[0-9a-f]{64}$'
    AND ("effective_until" IS NULL OR "effective_until" >= "effective_from")
    AND char_length("proposed_by") BETWEEN 1 AND 160
    AND ("legal_approval_ref" IS NULL OR char_length("legal_approval_ref") BETWEEN 8 AND 160)
    AND ("homologated_by" IS NULL OR char_length("homologated_by") BETWEEN 1 AND 160)
    AND ("step_up_proof_hash" IS NULL OR "step_up_proof_hash" ~ '^[0-9a-f]{64}$')
    AND ("status" = 'draft' OR (
      "legal_approval_ref" IS NOT NULL AND "homologated_by" IS NOT NULL
      AND "homologated_at" IS NOT NULL AND "step_up_proof_hash" IS NOT NULL
      AND "proposed_by" <> "homologated_by"
    ))
    AND (("status" = 'retired') = ("retired_by" IS NOT NULL AND "retired_at" IS NOT NULL AND "retirement_reason" IS NOT NULL))
  )
);
CREATE UNIQUE INDEX "pos_lgpd_retention_policies_version_key" ON "pos_lgpd_retention_policies"("version");
CREATE UNIQUE INDEX "pos_lgpd_retention_policies_one_active_key" ON "pos_lgpd_retention_policies"((1)) WHERE "status" = 'active';
CREATE INDEX "pos_lgpd_retention_policies_status_effective_idx" ON "pos_lgpd_retention_policies"("status", "effective_from", "effective_until");

CREATE TABLE "pos_lgpd_subject_requests" (
  "id" TEXT NOT NULL,
  "idempotency_key_hash" TEXT NOT NULL,
  "subject_token_hash" TEXT NOT NULL,
  "contact_token_hash" TEXT,
  "token_key_id" TEXT NOT NULL,
  "token_version" INTEGER NOT NULL DEFAULT 1,
  "request_type" TEXT NOT NULL,
  "state" TEXT NOT NULL DEFAULT 'received',
  "scope_hash" TEXT NOT NULL,
  "due_at" TIMESTAMPTZ NOT NULL,
  "version" INTEGER NOT NULL DEFAULT 1,
  "decision_proposed_by" TEXT,
  "decision_approved_by" TEXT,
  "decision_reason_code" TEXT,
  "decision_step_up_hash" TEXT,
  "verified_at" TIMESTAMPTZ,
  "decided_at" TIMESTAMPTZ,
  "completed_at" TIMESTAMPTZ,
  "created_by" TEXT NOT NULL,
  "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "pos_lgpd_subject_requests_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "pos_lgpd_subject_requests_shape_check" CHECK (
    char_length("id") BETWEEN 8 AND 160
    AND "idempotency_key_hash" ~ '^[0-9a-f]{64}$'
    AND "subject_token_hash" ~ '^[0-9a-f]{64}$'
    AND ("contact_token_hash" IS NULL OR "contact_token_hash" ~ '^[0-9a-f]{64}$')
    AND "token_key_id" ~ '^[a-z][a-z0-9._-]{2,79}$' AND "token_version" > 0
    AND "scope_hash" ~ '^[0-9a-f]{64}$'
    AND "request_type" IN ('access', 'export', 'portability', 'correction', 'restriction', 'objection', 'anonymization', 'deletion')
    AND "state" IN ('received', 'identity_pending', 'verified', 'scoping', 'decision_pending', 'approved', 'rejected', 'queued', 'in_progress', 'completed', 'failed', 'cancelled')
    AND "version" > 0 AND "due_at" >= "created_at"
    AND char_length("created_by") BETWEEN 1 AND 160
    AND ("decision_step_up_hash" IS NULL OR "decision_step_up_hash" ~ '^[0-9a-f]{64}$')
    AND ("decision_reason_code" IS NULL OR "decision_reason_code" ~ '^[a-z][a-z0-9._-]{2,79}$')
    AND ("state" NOT IN ('verified', 'scoping', 'decision_pending', 'approved', 'rejected', 'queued', 'in_progress', 'completed', 'failed') OR "verified_at" IS NOT NULL)
    AND ("state" NOT IN ('approved', 'rejected', 'queued', 'in_progress', 'completed', 'failed') OR "decided_at" IS NOT NULL)
    AND ("state" <> 'completed' OR "completed_at" IS NOT NULL)
    AND ("request_type" NOT IN ('anonymization', 'deletion') OR "state" NOT IN ('approved', 'queued', 'in_progress', 'completed', 'failed') OR (
      "decision_proposed_by" IS NOT NULL AND "decision_approved_by" IS NOT NULL
      AND "decision_proposed_by" <> "decision_approved_by"
      AND "decision_reason_code" IS NOT NULL AND "decision_step_up_hash" IS NOT NULL
    ))
  )
);
CREATE UNIQUE INDEX "pos_lgpd_subject_requests_idempotency_key_hash_key" ON "pos_lgpd_subject_requests"("idempotency_key_hash");
CREATE INDEX "pos_lgpd_subject_requests_state_due_idx" ON "pos_lgpd_subject_requests"("state", "due_at", "created_at");
CREATE INDEX "pos_lgpd_subject_requests_subject_idx" ON "pos_lgpd_subject_requests"("subject_token_hash", "created_at");

CREATE TABLE "pos_lgpd_request_state_ledger" (
  "id" BIGSERIAL NOT NULL,
  "request_id" TEXT NOT NULL,
  "sequence" INTEGER NOT NULL,
  "from_state" TEXT,
  "to_state" TEXT NOT NULL,
  "actor_id" TEXT NOT NULL,
  "reason_code" TEXT NOT NULL,
  "correlation_id" TEXT NOT NULL,
  "prior_hash" TEXT,
  "event_hash" TEXT NOT NULL,
  "creation_txid" BIGINT NOT NULL DEFAULT txid_current(),
  "occurred_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "pos_lgpd_request_state_ledger_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "pos_lgpd_request_state_ledger_shape_check" CHECK (
    "sequence" > 0
    AND ("from_state" IS NULL OR "from_state" IN ('received', 'identity_pending', 'verified', 'scoping', 'decision_pending', 'approved', 'rejected', 'queued', 'in_progress', 'completed', 'failed', 'cancelled'))
    AND "to_state" IN ('received', 'identity_pending', 'verified', 'scoping', 'decision_pending', 'approved', 'rejected', 'queued', 'in_progress', 'completed', 'failed', 'cancelled')
    AND char_length("actor_id") BETWEEN 1 AND 160
    AND "reason_code" ~ '^[a-z][a-z0-9._-]{2,79}$'
    AND char_length("correlation_id") BETWEEN 8 AND 160
    AND ("prior_hash" IS NULL OR "prior_hash" ~ '^[0-9a-f]{64}$')
    AND "event_hash" ~ '^[0-9a-f]{64}$' AND "creation_txid" > 0
  ),
  CONSTRAINT "pos_lgpd_request_state_ledger_request_id_fkey" FOREIGN KEY ("request_id") REFERENCES "pos_lgpd_subject_requests"("id") ON DELETE RESTRICT ON UPDATE RESTRICT
);
CREATE UNIQUE INDEX "pos_lgpd_request_state_ledger_event_hash_key" ON "pos_lgpd_request_state_ledger"("event_hash");
CREATE UNIQUE INDEX "pos_lgpd_request_state_ledger_request_sequence_key" ON "pos_lgpd_request_state_ledger"("request_id", "sequence");
CREATE INDEX "pos_lgpd_request_state_ledger_request_time_idx" ON "pos_lgpd_request_state_ledger"("request_id", "occurred_at");

CREATE TABLE "pos_lgpd_inventory_objects" (
  "id" TEXT NOT NULL,
  "object_type" TEXT NOT NULL,
  "object_key_hash" TEXT NOT NULL,
  "subject_token_hash" TEXT NOT NULL,
  "token_key_id" TEXT NOT NULL,
  "token_version" INTEGER NOT NULL DEFAULT 1,
  "data_category" TEXT NOT NULL,
  "source_version" INTEGER NOT NULL,
  "manifest_hash" TEXT NOT NULL,
  "state" TEXT NOT NULL DEFAULT 'observed',
  "retention_policy_id" TEXT,
  "discovered_at" TIMESTAMPTZ NOT NULL,
  "last_observed_at" TIMESTAMPTZ NOT NULL,
  "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "pos_lgpd_inventory_objects_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "pos_lgpd_inventory_objects_shape_check" CHECK (
    char_length("id") BETWEEN 8 AND 160
    AND "object_type" ~ '^[a-z][a-z0-9._-]{2,79}$'
    AND "object_key_hash" ~ '^[0-9a-f]{64}$' AND "subject_token_hash" ~ '^[0-9a-f]{64}$'
    AND "token_key_id" ~ '^[a-z][a-z0-9._-]{2,79}$' AND "token_version" > 0
    AND "data_category" ~ '^[a-z][a-z0-9._-]{2,79}$'
    AND "source_version" >= 0 AND "manifest_hash" ~ '^[0-9a-f]{64}$'
    AND "state" IN ('observed', 'action_planned', 'evidence_recorded')
    AND "last_observed_at" >= "discovered_at"
  ),
  CONSTRAINT "pos_lgpd_inventory_objects_retention_policy_id_fkey" FOREIGN KEY ("retention_policy_id") REFERENCES "pos_lgpd_retention_policies"("id") ON DELETE RESTRICT ON UPDATE RESTRICT
);
CREATE UNIQUE INDEX "pos_lgpd_inventory_objects_type_key_hash_key" ON "pos_lgpd_inventory_objects"("object_type", "object_key_hash");
CREATE INDEX "pos_lgpd_inventory_objects_subject_category_state_idx" ON "pos_lgpd_inventory_objects"("subject_token_hash", "data_category", "state");
CREATE INDEX "pos_lgpd_inventory_objects_policy_state_idx" ON "pos_lgpd_inventory_objects"("retention_policy_id", "state");

CREATE TABLE "pos_lgpd_legal_holds" (
  "id" TEXT NOT NULL,
  "idempotency_key_hash" TEXT NOT NULL,
  "subject_token_hash" TEXT NOT NULL,
  "token_key_id" TEXT NOT NULL,
  "token_version" INTEGER NOT NULL DEFAULT 1,
  "object_type" TEXT,
  "object_key_hash" TEXT,
  "data_category" TEXT,
  "state" TEXT NOT NULL DEFAULT 'active',
  "reason_code" TEXT NOT NULL,
  "legal_reference_hash" TEXT NOT NULL,
  "proposed_by" TEXT NOT NULL,
  "approved_by" TEXT NOT NULL,
  "step_up_proof_hash" TEXT NOT NULL,
  "starts_at" TIMESTAMPTZ NOT NULL,
  "expires_at" TIMESTAMPTZ,
  "release_proposed_by" TEXT,
  "released_by" TEXT,
  "release_step_up_hash" TEXT,
  "release_reason_code" TEXT,
  "released_at" TIMESTAMPTZ,
  "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "pos_lgpd_legal_holds_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "pos_lgpd_legal_holds_shape_check" CHECK (
    char_length("id") BETWEEN 8 AND 160 AND "idempotency_key_hash" ~ '^[0-9a-f]{64}$'
    AND "subject_token_hash" ~ '^[0-9a-f]{64}$'
    AND "token_key_id" ~ '^[a-z][a-z0-9._-]{2,79}$' AND "token_version" > 0
    AND ("object_type" IS NULL OR "object_type" ~ '^[a-z][a-z0-9._-]{2,79}$')
    AND ("object_key_hash" IS NULL OR "object_key_hash" ~ '^[0-9a-f]{64}$')
    AND (("object_type" IS NULL) = ("object_key_hash" IS NULL))
    AND ("data_category" IS NULL OR "data_category" ~ '^[a-z][a-z0-9._-]{2,79}$')
    AND "state" IN ('active', 'released')
    AND "reason_code" ~ '^[a-z][a-z0-9._-]{2,79}$' AND "legal_reference_hash" ~ '^[0-9a-f]{64}$'
    AND char_length("proposed_by") BETWEEN 1 AND 160 AND char_length("approved_by") BETWEEN 1 AND 160
    AND "proposed_by" <> "approved_by" AND "step_up_proof_hash" ~ '^[0-9a-f]{64}$'
    AND ("expires_at" IS NULL OR "expires_at" > "starts_at")
    AND ("state" = 'active' OR (
      "release_proposed_by" IS NOT NULL AND "released_by" IS NOT NULL
      AND "release_proposed_by" <> "released_by" AND "release_step_up_hash" ~ '^[0-9a-f]{64}$'
      AND "release_reason_code" ~ '^[a-z][a-z0-9._-]{2,79}$' AND "released_at" IS NOT NULL
    ))
  )
);
CREATE UNIQUE INDEX "pos_lgpd_legal_holds_idempotency_key_hash_key" ON "pos_lgpd_legal_holds"("idempotency_key_hash");
CREATE INDEX "pos_lgpd_legal_holds_subject_state_time_idx" ON "pos_lgpd_legal_holds"("subject_token_hash", "state", "starts_at", "expires_at");
CREATE INDEX "pos_lgpd_legal_holds_object_state_idx" ON "pos_lgpd_legal_holds"("object_type", "object_key_hash", "state");
CREATE INDEX "pos_lgpd_legal_holds_category_state_idx" ON "pos_lgpd_legal_holds"("data_category", "state");

CREATE TABLE "pos_lgpd_execution_jobs" (
  "id" TEXT NOT NULL,
  "request_id" TEXT NOT NULL,
  "inventory_object_id" TEXT,
  "retention_policy_id" TEXT,
  "action" TEXT NOT NULL,
  "state" TEXT NOT NULL DEFAULT 'blocked',
  "block_reason" TEXT,
  "idempotency_key_hash" TEXT NOT NULL,
  "token_key_id" TEXT NOT NULL,
  "token_version" INTEGER NOT NULL DEFAULT 1,
  "request_hash" TEXT NOT NULL,
  "policy_hash" TEXT,
  "adapter_id" TEXT,
  "attempt_count" INTEGER NOT NULL DEFAULT 0,
  "max_attempts" INTEGER NOT NULL DEFAULT 8,
  "claim_token_hash" TEXT,
  "claim_expires_at" TIMESTAMPTZ,
  "result_hash" TEXT,
  "matched_count" BIGINT NOT NULL DEFAULT 0,
  "processed_count" BIGINT NOT NULL DEFAULT 0,
  "failed_count" BIGINT NOT NULL DEFAULT 0,
  "completed_at" TIMESTAMPTZ,
  "created_by" TEXT NOT NULL,
  "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "pos_lgpd_execution_jobs_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "pos_lgpd_execution_jobs_shape_check" CHECK (
    char_length("id") BETWEEN 8 AND 160 AND "action" IN ('export', 'anonymize', 'delete')
    AND "state" IN ('blocked', 'ready', 'claimed', 'succeeded', 'failed', 'dead')
    AND "idempotency_key_hash" ~ '^[0-9a-f]{64}$' AND "request_hash" ~ '^[0-9a-f]{64}$'
    AND "token_key_id" ~ '^[a-z][a-z0-9._-]{2,79}$' AND "token_version" > 0
    AND ("policy_hash" IS NULL OR "policy_hash" ~ '^[0-9a-f]{64}$')
    AND ("adapter_id" IS NULL OR "adapter_id" ~ '^[a-z][a-z0-9._-]{2,79}$')
    AND "attempt_count" BETWEEN 0 AND "max_attempts" AND "max_attempts" BETWEEN 1 AND 20
    AND ("claim_token_hash" IS NULL OR "claim_token_hash" ~ '^[0-9a-f]{64}$')
    AND (("state" = 'claimed') = ("claim_token_hash" IS NOT NULL AND "claim_expires_at" IS NOT NULL))
    AND "matched_count" >= 0 AND "processed_count" >= 0 AND "failed_count" >= 0
    AND "processed_count" + "failed_count" <= "matched_count"
    AND ("state" <> 'blocked' OR "block_reason" IS NOT NULL)
    AND ("state" NOT IN ('ready', 'claimed', 'succeeded') OR "adapter_id" IS NOT NULL)
    AND ("action" = 'export' OR ("inventory_object_id" IS NOT NULL AND "retention_policy_id" IS NOT NULL AND "policy_hash" IS NOT NULL))
    AND ("state" <> 'succeeded' OR ("result_hash" ~ '^[0-9a-f]{64}$' AND "completed_at" IS NOT NULL AND "failed_count" = 0 AND "processed_count" = "matched_count"))
    AND char_length("created_by") BETWEEN 1 AND 160
  ),
  CONSTRAINT "pos_lgpd_execution_jobs_request_id_fkey" FOREIGN KEY ("request_id") REFERENCES "pos_lgpd_subject_requests"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT "pos_lgpd_execution_jobs_inventory_object_id_fkey" FOREIGN KEY ("inventory_object_id") REFERENCES "pos_lgpd_inventory_objects"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT "pos_lgpd_execution_jobs_retention_policy_id_fkey" FOREIGN KEY ("retention_policy_id") REFERENCES "pos_lgpd_retention_policies"("id") ON DELETE RESTRICT ON UPDATE RESTRICT
);
CREATE UNIQUE INDEX "pos_lgpd_execution_jobs_idempotency_key_hash_key" ON "pos_lgpd_execution_jobs"("idempotency_key_hash");
CREATE UNIQUE INDEX "pos_lgpd_execution_jobs_request_action_object_key" ON "pos_lgpd_execution_jobs"("request_id", "action", "inventory_object_id") WHERE "inventory_object_id" IS NOT NULL;
CREATE UNIQUE INDEX "pos_lgpd_execution_jobs_request_export_key" ON "pos_lgpd_execution_jobs"("request_id", "action") WHERE "inventory_object_id" IS NULL;
CREATE INDEX "pos_lgpd_execution_jobs_state_created_idx" ON "pos_lgpd_execution_jobs"("state", "created_at");
CREATE INDEX "pos_lgpd_execution_jobs_claim_expiry_idx" ON "pos_lgpd_execution_jobs"("claim_expires_at");

CREATE TABLE "pos_lgpd_execution_outbox" (
  "id" BIGSERIAL NOT NULL,
  "job_id" TEXT NOT NULL,
  "state" TEXT NOT NULL DEFAULT 'blocked',
  "payload_hash" TEXT NOT NULL,
  "delivery_count" INTEGER NOT NULL DEFAULT 0,
  "next_attempt_at" TIMESTAMPTZ,
  "claim_token_hash" TEXT,
  "claim_expires_at" TIMESTAMPTZ,
  "last_error_code" TEXT,
  "result_hash" TEXT,
  "completed_at" TIMESTAMPTZ,
  "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "pos_lgpd_execution_outbox_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "pos_lgpd_execution_outbox_shape_check" CHECK (
    "state" IN ('blocked', 'pending', 'claimed', 'completed', 'dead')
    AND "payload_hash" ~ '^[0-9a-f]{64}$' AND "delivery_count" BETWEEN 0 AND 20
    AND (("state" = 'claimed') = ("claim_token_hash" IS NOT NULL AND "claim_expires_at" IS NOT NULL))
    AND ("claim_token_hash" IS NULL OR "claim_token_hash" ~ '^[0-9a-f]{64}$')
    AND ("result_hash" IS NULL OR "result_hash" ~ '^[0-9a-f]{64}$')
    AND ("state" NOT IN ('completed', 'dead') OR "completed_at" IS NOT NULL)
  ),
  CONSTRAINT "pos_lgpd_execution_outbox_job_id_fkey" FOREIGN KEY ("job_id") REFERENCES "pos_lgpd_execution_jobs"("id") ON DELETE RESTRICT ON UPDATE RESTRICT
);
CREATE UNIQUE INDEX "pos_lgpd_execution_outbox_job_id_key" ON "pos_lgpd_execution_outbox"("job_id");
CREATE INDEX "pos_lgpd_execution_outbox_state_next_idx" ON "pos_lgpd_execution_outbox"("state", "next_attempt_at");
CREATE INDEX "pos_lgpd_execution_outbox_claim_expiry_idx" ON "pos_lgpd_execution_outbox"("claim_expires_at");

CREATE TABLE "pos_lgpd_evidence" (
  "id" BIGSERIAL NOT NULL,
  "aggregate_type" TEXT NOT NULL,
  "aggregate_id" TEXT NOT NULL,
  "evidence_type" TEXT NOT NULL,
  "schema_version" INTEGER NOT NULL DEFAULT 1,
  "manifest_hash" TEXT NOT NULL,
  "prior_evidence_hash" TEXT,
  "evidence_hash" TEXT NOT NULL,
  "matched_count" BIGINT NOT NULL DEFAULT 0,
  "planned_count" BIGINT NOT NULL DEFAULT 0,
  "processed_count" BIGINT NOT NULL DEFAULT 0,
  "failed_count" BIGINT NOT NULL DEFAULT 0,
  "actor_id" TEXT NOT NULL,
  "correlation_id" TEXT NOT NULL,
  "creation_txid" BIGINT NOT NULL DEFAULT txid_current(),
  "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "pos_lgpd_evidence_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "pos_lgpd_evidence_shape_check" CHECK (
    "aggregate_type" IN ('request', 'job', 'hold', 'policy', 'inventory')
    AND char_length("aggregate_id") BETWEEN 8 AND 160
    AND "evidence_type" ~ '^[a-z][a-z0-9._-]{2,79}$' AND "schema_version" > 0
    AND "manifest_hash" ~ '^[0-9a-f]{64}$'
    AND ("prior_evidence_hash" IS NULL OR "prior_evidence_hash" ~ '^[0-9a-f]{64}$')
    AND "evidence_hash" ~ '^[0-9a-f]{64}$'
    AND "matched_count" >= 0 AND "planned_count" >= 0 AND "processed_count" >= 0 AND "failed_count" >= 0
    AND "processed_count" + "failed_count" <= "planned_count"
    AND char_length("actor_id") BETWEEN 1 AND 160 AND char_length("correlation_id") BETWEEN 8 AND 160
    AND "creation_txid" > 0
  )
);
CREATE UNIQUE INDEX "pos_lgpd_evidence_evidence_hash_key" ON "pos_lgpd_evidence"("evidence_hash");
CREATE INDEX "pos_lgpd_evidence_aggregate_idx" ON "pos_lgpd_evidence"("aggregate_type", "aggregate_id", "id");

CREATE FUNCTION "pos_lgpd_forbid_mutation"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'LGPD evidence and state ledgers are append-only' USING ERRCODE = '55000';
END;
$$;

CREATE FUNCTION "pos_lgpd_policy_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'LGPD retention policies cannot be deleted' USING ERRCODE = '55000'; END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."status" <> 'draft' THEN RAISE EXCEPTION 'LGPD retention policies must be created as draft' USING ERRCODE = '23514'; END IF;
    RETURN NEW;
  END IF;
  IF OLD."id" IS DISTINCT FROM NEW."id" OR OLD."version" IS DISTINCT FROM NEW."version"
    OR OLD."policy_hash" IS DISTINCT FROM NEW."policy_hash" OR OLD."effective_from" IS DISTINCT FROM NEW."effective_from"
    OR OLD."effective_until" IS DISTINCT FROM NEW."effective_until" OR OLD."proposed_by" IS DISTINCT FROM NEW."proposed_by"
    OR OLD."created_at" IS DISTINCT FROM NEW."created_at"
  THEN RAISE EXCEPTION 'LGPD retention policy identity and content are immutable' USING ERRCODE = '55000'; END IF;
  IF OLD."status" = 'draft' AND NEW."status" NOT IN ('draft', 'active') THEN RAISE EXCEPTION 'invalid LGPD policy transition' USING ERRCODE = '23514'; END IF;
  IF OLD."status" = 'active' AND NEW."status" NOT IN ('active', 'retired') THEN RAISE EXCEPTION 'invalid LGPD policy transition' USING ERRCODE = '23514'; END IF;
  IF OLD."status" = 'retired' THEN RAISE EXCEPTION 'retired LGPD policy is immutable' USING ERRCODE = '55000'; END IF;
  IF OLD."status" <> 'draft' AND (
    OLD."legal_approval_ref" IS DISTINCT FROM NEW."legal_approval_ref" OR OLD."homologated_by" IS DISTINCT FROM NEW."homologated_by"
    OR OLD."homologated_at" IS DISTINCT FROM NEW."homologated_at" OR OLD."step_up_proof_hash" IS DISTINCT FROM NEW."step_up_proof_hash"
  ) THEN RAISE EXCEPTION 'homologated LGPD policy approval is immutable' USING ERRCODE = '55000'; END IF;
  RETURN NEW;
END;
$$;

CREATE FUNCTION "pos_lgpd_request_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE allowed BOOLEAN;
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'LGPD subject requests cannot be deleted' USING ERRCODE = '55000'; END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."state" <> 'received' OR NEW."version" <> 1 OR NEW."verified_at" IS NOT NULL OR NEW."decided_at" IS NOT NULL OR NEW."completed_at" IS NOT NULL
      OR NEW."decision_proposed_by" IS NOT NULL OR NEW."decision_approved_by" IS NOT NULL OR NEW."decision_reason_code" IS NOT NULL OR NEW."decision_step_up_hash" IS NOT NULL
    THEN RAISE EXCEPTION 'LGPD subject requests must be created in received state without a decision' USING ERRCODE = '23514'; END IF;
    RETURN NEW;
  END IF;
  IF OLD."id" IS DISTINCT FROM NEW."id" OR OLD."idempotency_key_hash" IS DISTINCT FROM NEW."idempotency_key_hash"
    OR OLD."subject_token_hash" IS DISTINCT FROM NEW."subject_token_hash" OR OLD."contact_token_hash" IS DISTINCT FROM NEW."contact_token_hash"
    OR OLD."token_key_id" IS DISTINCT FROM NEW."token_key_id" OR OLD."token_version" IS DISTINCT FROM NEW."token_version"
    OR OLD."request_type" IS DISTINCT FROM NEW."request_type" OR OLD."scope_hash" IS DISTINCT FROM NEW."scope_hash"
    OR OLD."due_at" IS DISTINCT FROM NEW."due_at" OR OLD."created_by" IS DISTINCT FROM NEW."created_by"
    OR OLD."created_at" IS DISTINCT FROM NEW."created_at"
  THEN RAISE EXCEPTION 'LGPD request identity and scope are immutable' USING ERRCODE = '55000'; END IF;
  IF NEW."version" <> OLD."version" + 1 OR NEW."state" = OLD."state" THEN RAISE EXCEPTION 'LGPD request updates require a state transition and CAS version increment' USING ERRCODE = '40001'; END IF;
  allowed := CASE OLD."state"
    WHEN 'received' THEN NEW."state" IN ('identity_pending', 'cancelled')
    WHEN 'identity_pending' THEN NEW."state" IN ('verified', 'cancelled')
    WHEN 'verified' THEN NEW."state" IN ('scoping', 'cancelled')
    WHEN 'scoping' THEN NEW."state" IN ('decision_pending', 'approved', 'rejected', 'cancelled')
    WHEN 'decision_pending' THEN NEW."state" IN ('approved', 'rejected', 'cancelled')
    WHEN 'approved' THEN NEW."state" IN ('queued', 'cancelled')
    WHEN 'queued' THEN NEW."state" IN ('in_progress', 'failed', 'cancelled')
    WHEN 'in_progress' THEN NEW."state" IN ('completed', 'failed')
    ELSE FALSE END;
  IF NOT allowed THEN RAISE EXCEPTION 'invalid LGPD request state transition' USING ERRCODE = '23514'; END IF;
  RETURN NEW;
END;
$$;

CREATE FUNCTION "pos_lgpd_request_ledger_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE previous_hash TEXT;
BEGIN
  IF NEW."sequence" = 1 THEN
    IF NEW."from_state" IS NOT NULL OR NEW."prior_hash" IS NOT NULL THEN RAISE EXCEPTION 'initial LGPD ledger event has no predecessor' USING ERRCODE = '23514'; END IF;
  ELSE
    SELECT "event_hash" INTO previous_hash FROM "pos_lgpd_request_state_ledger" WHERE "request_id" = NEW."request_id" AND "sequence" = NEW."sequence" - 1;
    IF previous_hash IS NULL OR NEW."prior_hash" IS DISTINCT FROM previous_hash THEN RAISE EXCEPTION 'LGPD request ledger hash chain is broken' USING ERRCODE = '23514'; END IF;
  END IF;
  RETURN NEW;
END;
$$;

CREATE FUNCTION "pos_lgpd_request_ledger_required"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE matching INTEGER;
BEGIN
  SELECT count(*) INTO matching FROM "pos_lgpd_request_state_ledger"
  WHERE "request_id" = NEW."id" AND "sequence" = NEW."version" AND "to_state" = NEW."state"
    AND "creation_txid" = txid_current()
    AND ((TG_OP = 'INSERT' AND "from_state" IS NULL) OR (TG_OP = 'UPDATE' AND "from_state" = OLD."state"));
  IF matching <> 1 THEN RAISE EXCEPTION 'LGPD request state transition requires exactly one append-only ledger event in the same transaction' USING ERRCODE = '23514'; END IF;
  RETURN NULL;
END;
$$;

CREATE FUNCTION "pos_lgpd_inventory_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'LGPD inventory objects cannot be deleted; record execution evidence' USING ERRCODE = '55000'; END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."state" <> 'observed' THEN RAISE EXCEPTION 'LGPD inventory objects must be created as observed' USING ERRCODE = '23514'; END IF;
    RETURN NEW;
  END IF;
  IF OLD."id" IS DISTINCT FROM NEW."id" OR OLD."object_type" IS DISTINCT FROM NEW."object_type"
    OR OLD."object_key_hash" IS DISTINCT FROM NEW."object_key_hash" OR OLD."subject_token_hash" IS DISTINCT FROM NEW."subject_token_hash"
    OR OLD."token_key_id" IS DISTINCT FROM NEW."token_key_id" OR OLD."token_version" IS DISTINCT FROM NEW."token_version"
    OR OLD."data_category" IS DISTINCT FROM NEW."data_category" OR OLD."discovered_at" IS DISTINCT FROM NEW."discovered_at"
    OR OLD."created_at" IS DISTINCT FROM NEW."created_at"
  THEN RAISE EXCEPTION 'LGPD inventory object identity is immutable' USING ERRCODE = '55000'; END IF;
  IF NEW."source_version" < OLD."source_version" OR NEW."last_observed_at" < OLD."last_observed_at" THEN RAISE EXCEPTION 'LGPD inventory observation cannot move backwards' USING ERRCODE = '23514'; END IF;
  IF OLD."retention_policy_id" IS NOT NULL AND OLD."retention_policy_id" IS DISTINCT FROM NEW."retention_policy_id" THEN RAISE EXCEPTION 'assigned LGPD retention policy is immutable' USING ERRCODE = '55000'; END IF;
  RETURN NEW;
END;
$$;

CREATE FUNCTION "pos_lgpd_hold_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'LGPD legal holds cannot be deleted' USING ERRCODE = '55000'; END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."state" <> 'active' THEN RAISE EXCEPTION 'LGPD legal holds must be created active' USING ERRCODE = '23514'; END IF;
    RETURN NEW;
  END IF;
  IF OLD."id" IS DISTINCT FROM NEW."id" OR OLD."idempotency_key_hash" IS DISTINCT FROM NEW."idempotency_key_hash"
    OR OLD."subject_token_hash" IS DISTINCT FROM NEW."subject_token_hash" OR OLD."object_type" IS DISTINCT FROM NEW."object_type"
    OR OLD."token_key_id" IS DISTINCT FROM NEW."token_key_id" OR OLD."token_version" IS DISTINCT FROM NEW."token_version"
    OR OLD."object_key_hash" IS DISTINCT FROM NEW."object_key_hash" OR OLD."data_category" IS DISTINCT FROM NEW."data_category"
    OR OLD."reason_code" IS DISTINCT FROM NEW."reason_code" OR OLD."legal_reference_hash" IS DISTINCT FROM NEW."legal_reference_hash"
    OR OLD."proposed_by" IS DISTINCT FROM NEW."proposed_by" OR OLD."approved_by" IS DISTINCT FROM NEW."approved_by"
    OR OLD."step_up_proof_hash" IS DISTINCT FROM NEW."step_up_proof_hash" OR OLD."starts_at" IS DISTINCT FROM NEW."starts_at"
    OR OLD."expires_at" IS DISTINCT FROM NEW."expires_at" OR OLD."created_at" IS DISTINCT FROM NEW."created_at"
  THEN RAISE EXCEPTION 'LGPD legal hold identity and approval are immutable' USING ERRCODE = '55000'; END IF;
  IF OLD."state" <> 'active' OR NEW."state" <> 'released' THEN RAISE EXCEPTION 'invalid LGPD legal hold transition' USING ERRCODE = '23514'; END IF;
  RETURN NEW;
END;
$$;

CREATE FUNCTION "pos_lgpd_job_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE request_record "pos_lgpd_subject_requests"%ROWTYPE;
DECLARE object_record "pos_lgpd_inventory_objects"%ROWTYPE;
DECLARE policy_record "pos_lgpd_retention_policies"%ROWTYPE;
DECLARE active_holds INTEGER;
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'LGPD execution jobs cannot be deleted' USING ERRCODE = '55000'; END IF;
  IF TG_OP = 'INSERT' AND NEW."state" <> 'blocked' THEN RAISE EXCEPTION 'LGPD execution jobs must be created fail-closed in blocked state' USING ERRCODE = '23514'; END IF;
  IF TG_OP = 'UPDATE' THEN
    IF OLD."id" IS DISTINCT FROM NEW."id" OR OLD."request_id" IS DISTINCT FROM NEW."request_id"
      OR OLD."inventory_object_id" IS DISTINCT FROM NEW."inventory_object_id" OR OLD."retention_policy_id" IS DISTINCT FROM NEW."retention_policy_id"
      OR OLD."action" IS DISTINCT FROM NEW."action" OR OLD."idempotency_key_hash" IS DISTINCT FROM NEW."idempotency_key_hash"
      OR OLD."token_key_id" IS DISTINCT FROM NEW."token_key_id" OR OLD."token_version" IS DISTINCT FROM NEW."token_version"
      OR OLD."request_hash" IS DISTINCT FROM NEW."request_hash" OR OLD."policy_hash" IS DISTINCT FROM NEW."policy_hash"
      OR OLD."created_by" IS DISTINCT FROM NEW."created_by" OR OLD."created_at" IS DISTINCT FROM NEW."created_at"
    THEN RAISE EXCEPTION 'LGPD execution job identity and policy snapshot are immutable' USING ERRCODE = '55000'; END IF;
    IF NOT (OLD."state" = NEW."state" OR (OLD."state" = 'blocked' AND NEW."state" = 'ready')
      OR (OLD."state" = 'ready' AND NEW."state" = 'claimed') OR (OLD."state" = 'claimed' AND NEW."state" IN ('ready', 'succeeded', 'failed', 'dead'))
      OR (OLD."state" = 'failed' AND NEW."state" IN ('ready', 'dead'))) THEN RAISE EXCEPTION 'invalid LGPD execution job transition' USING ERRCODE = '23514'; END IF;
  END IF;
  SELECT * INTO request_record FROM "pos_lgpd_subject_requests" WHERE "id" = NEW."request_id";
  IF request_record."state" NOT IN ('approved', 'queued', 'in_progress') THEN RAISE EXCEPTION 'LGPD execution job requires an approved request' USING ERRCODE = '23514'; END IF;
  IF (NEW."action" = 'export' AND request_record."request_type" NOT IN ('access', 'export', 'portability'))
    OR (NEW."action" = 'anonymize' AND request_record."request_type" NOT IN ('anonymization', 'deletion'))
    OR (NEW."action" = 'delete' AND request_record."request_type" <> 'deletion')
  THEN RAISE EXCEPTION 'LGPD job action does not match request type' USING ERRCODE = '23514'; END IF;
  IF NEW."action" IN ('anonymize', 'delete') THEN
    IF request_record."decision_proposed_by" IS NULL OR request_record."decision_approved_by" IS NULL
      OR request_record."decision_proposed_by" = request_record."decision_approved_by" OR request_record."decision_step_up_hash" IS NULL
    THEN RAISE EXCEPTION 'destructive LGPD job requires maker-checker and step-up approval' USING ERRCODE = '23514'; END IF;
    SELECT * INTO object_record FROM "pos_lgpd_inventory_objects" WHERE "id" = NEW."inventory_object_id";
    IF object_record."subject_token_hash" IS DISTINCT FROM request_record."subject_token_hash" THEN RAISE EXCEPTION 'LGPD inventory object does not belong to request subject token' USING ERRCODE = '23514'; END IF;
    SELECT * INTO policy_record FROM "pos_lgpd_retention_policies" WHERE "id" = NEW."retention_policy_id";
    IF policy_record."status" <> 'active' OR policy_record."policy_hash" IS DISTINCT FROM NEW."policy_hash"
      OR policy_record."legal_approval_ref" IS NULL OR policy_record."homologated_at" IS NULL
      OR CURRENT_TIMESTAMP < policy_record."effective_from" OR (policy_record."effective_until" IS NOT NULL AND CURRENT_TIMESTAMP > policy_record."effective_until")
      OR object_record."retention_policy_id" IS DISTINCT FROM policy_record."id"
    THEN RAISE EXCEPTION 'destructive LGPD job requires the exact active homologated retention policy' USING ERRCODE = '23514'; END IF;
    SELECT count(*) INTO active_holds FROM "pos_lgpd_legal_holds" hold
    WHERE hold."subject_token_hash" = request_record."subject_token_hash" AND hold."state" = 'active'
      AND hold."starts_at" <= CURRENT_TIMESTAMP AND (hold."expires_at" IS NULL OR hold."expires_at" > CURRENT_TIMESTAMP)
      AND (hold."object_type" IS NULL OR (hold."object_type" = object_record."object_type" AND hold."object_key_hash" = object_record."object_key_hash"))
      AND (hold."data_category" IS NULL OR hold."data_category" = object_record."data_category");
    IF active_holds > 0 AND (NEW."state" <> 'blocked' OR NEW."block_reason" <> 'legal_hold') THEN RAISE EXCEPTION 'active LGPD legal hold blocks destructive execution' USING ERRCODE = '23514'; END IF;
  END IF;
  RETURN NEW;
END;
$$;

CREATE FUNCTION "pos_lgpd_outbox_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE job_state TEXT;
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'LGPD execution outbox rows cannot be deleted' USING ERRCODE = '55000'; END IF;
  IF TG_OP = 'INSERT' AND NEW."state" <> 'blocked' THEN RAISE EXCEPTION 'LGPD outbox must be created fail-closed' USING ERRCODE = '23514'; END IF;
  IF TG_OP = 'UPDATE' THEN
    IF OLD."job_id" IS DISTINCT FROM NEW."job_id" OR OLD."payload_hash" IS DISTINCT FROM NEW."payload_hash" OR OLD."created_at" IS DISTINCT FROM NEW."created_at"
    THEN RAISE EXCEPTION 'LGPD outbox identity and payload hash are immutable' USING ERRCODE = '55000'; END IF;
    IF NOT (OLD."state" = NEW."state" OR (OLD."state" = 'blocked' AND NEW."state" = 'pending')
      OR (OLD."state" = 'pending' AND NEW."state" = 'claimed') OR (OLD."state" = 'claimed' AND NEW."state" IN ('pending', 'completed', 'dead')))
    THEN RAISE EXCEPTION 'invalid LGPD outbox transition' USING ERRCODE = '23514'; END IF;
  END IF;
  SELECT "state" INTO job_state FROM "pos_lgpd_execution_jobs" WHERE "id" = NEW."job_id";
  IF NEW."state" <> 'blocked' AND job_state = 'blocked' THEN RAISE EXCEPTION 'blocked LGPD job cannot publish an outbox event' USING ERRCODE = '23514'; END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "pos_lgpd_policy_guard" BEFORE INSERT OR UPDATE OR DELETE ON "pos_lgpd_retention_policies" FOR EACH ROW EXECUTE FUNCTION "pos_lgpd_policy_guard"();
CREATE TRIGGER "pos_lgpd_request_guard" BEFORE INSERT OR UPDATE OR DELETE ON "pos_lgpd_subject_requests" FOR EACH ROW EXECUTE FUNCTION "pos_lgpd_request_guard"();
CREATE CONSTRAINT TRIGGER "pos_lgpd_request_ledger_required" AFTER INSERT OR UPDATE ON "pos_lgpd_subject_requests" DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION "pos_lgpd_request_ledger_required"();
CREATE TRIGGER "pos_lgpd_request_ledger_chain_guard" BEFORE INSERT ON "pos_lgpd_request_state_ledger" FOR EACH ROW EXECUTE FUNCTION "pos_lgpd_request_ledger_guard"();
CREATE TRIGGER "pos_lgpd_request_ledger_immutable_guard" BEFORE UPDATE OR DELETE ON "pos_lgpd_request_state_ledger" FOR EACH ROW EXECUTE FUNCTION "pos_lgpd_forbid_mutation"();
CREATE TRIGGER "pos_lgpd_inventory_guard" BEFORE INSERT OR UPDATE OR DELETE ON "pos_lgpd_inventory_objects" FOR EACH ROW EXECUTE FUNCTION "pos_lgpd_inventory_guard"();
CREATE TRIGGER "pos_lgpd_hold_guard" BEFORE INSERT OR UPDATE OR DELETE ON "pos_lgpd_legal_holds" FOR EACH ROW EXECUTE FUNCTION "pos_lgpd_hold_guard"();
CREATE TRIGGER "pos_lgpd_job_guard" BEFORE INSERT OR UPDATE OR DELETE ON "pos_lgpd_execution_jobs" FOR EACH ROW EXECUTE FUNCTION "pos_lgpd_job_guard"();
CREATE TRIGGER "pos_lgpd_outbox_guard" BEFORE INSERT OR UPDATE OR DELETE ON "pos_lgpd_execution_outbox" FOR EACH ROW EXECUTE FUNCTION "pos_lgpd_outbox_guard"();
CREATE TRIGGER "pos_lgpd_evidence_immutable_guard" BEFORE UPDATE OR DELETE ON "pos_lgpd_evidence" FOR EACH ROW EXECUTE FUNCTION "pos_lgpd_forbid_mutation"();
