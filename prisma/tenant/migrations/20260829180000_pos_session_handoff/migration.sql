ALTER TABLE "cash_register_sessions"
  ADD COLUMN "suspended_at" TIMESTAMPTZ,
  ADD COLUMN "suspended_by" TEXT,
  ADD COLUMN "suspended_reason" TEXT;

ALTER TABLE "cash_register_sessions"
  ADD CONSTRAINT "cash_register_sessions_status_check"
  CHECK ("status" IN ('open', 'suspended', 'closing', 'closed', 'reconciled', 'reopened')) NOT VALID;

DROP INDEX IF EXISTS "cash_register_sessions_one_open_per_register_idx";
DROP INDEX IF EXISTS "cash_register_sessions_one_open_per_operator_idx";

CREATE UNIQUE INDEX "cash_register_sessions_one_open_per_register_idx"
  ON "cash_register_sessions"("register_id")
  WHERE "register_id" IS NOT NULL AND "status" IN ('open', 'suspended', 'closing');

CREATE UNIQUE INDEX "cash_register_sessions_one_open_per_operator_idx"
  ON "cash_register_sessions"("operator_profile_id")
  WHERE "operator_profile_id" IS NOT NULL AND "status" IN ('open', 'suspended', 'closing');

CREATE TABLE "pos_session_handoffs" (
  "id" TEXT NOT NULL,
  "session_id" INTEGER NOT NULL,
  "branch_id" INTEGER NOT NULL,
  "register_id" INTEGER NOT NULL,
  "from_operator_profile_id" INTEGER NOT NULL,
  "to_operator_profile_id" INTEGER NOT NULL,
  "state" TEXT NOT NULL DEFAULT 'requested',
  "reason" TEXT NOT NULL,
  "expires_at" TIMESTAMPTZ NOT NULL,
  "revision" INTEGER NOT NULL DEFAULT 1,
  "request_idempotency_key" TEXT NOT NULL,
  "request_hash" TEXT NOT NULL,
  "held_sale_snapshot" JSONB NOT NULL,
  "transferred_held_sale_count" INTEGER NOT NULL DEFAULT 0,
  "resolution_idempotency_key" TEXT,
  "resolution_request_hash" TEXT,
  "requested_by_actor_id" TEXT NOT NULL,
  "resolved_by_actor_id" TEXT,
  "resolved_at" TIMESTAMPTZ,
  "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "pos_session_handoffs_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "pos_session_handoffs_state_check" CHECK ("state" IN ('requested', 'accepted', 'cancelled', 'expired')),
  CONSTRAINT "pos_session_handoffs_revision_check" CHECK ("revision" > 0),
  CONSTRAINT "pos_session_handoffs_distinct_operators_check" CHECK ("from_operator_profile_id" <> "to_operator_profile_id"),
  CONSTRAINT "pos_session_handoffs_expiry_check" CHECK ("expires_at" > "created_at"),
  CONSTRAINT "pos_session_handoffs_held_sale_count_check" CHECK (
    "transferred_held_sale_count" >= 0
    AND ("state" = 'accepted' OR "transferred_held_sale_count" = 0)
  ),
  CONSTRAINT "pos_session_handoffs_resolution_check" CHECK (
    ("state" = 'requested' AND "resolved_at" IS NULL AND "resolved_by_actor_id" IS NULL AND "resolution_idempotency_key" IS NULL AND "resolution_request_hash" IS NULL)
    OR
    ("state" <> 'requested' AND "resolved_at" IS NOT NULL AND "resolved_by_actor_id" IS NOT NULL AND "resolution_idempotency_key" IS NOT NULL AND "resolution_request_hash" IS NOT NULL)
  ),
  CONSTRAINT "pos_session_handoffs_session_id_fkey" FOREIGN KEY ("session_id") REFERENCES "cash_register_sessions"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "pos_session_handoffs_branch_id_fkey" FOREIGN KEY ("branch_id") REFERENCES "branches"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "pos_session_handoffs_register_id_fkey" FOREIGN KEY ("register_id") REFERENCES "pos_registers"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "pos_session_handoffs_from_operator_profile_id_fkey" FOREIGN KEY ("from_operator_profile_id") REFERENCES "tenant_user_profiles"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "pos_session_handoffs_to_operator_profile_id_fkey" FOREIGN KEY ("to_operator_profile_id") REFERENCES "tenant_user_profiles"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "pos_session_handoffs_request_idempotency_key_key" ON "pos_session_handoffs"("request_idempotency_key");
CREATE UNIQUE INDEX "pos_session_handoffs_resolution_idempotency_key_key" ON "pos_session_handoffs"("resolution_idempotency_key");
CREATE UNIQUE INDEX "pos_session_handoffs_one_requested_per_session_idx" ON "pos_session_handoffs"("session_id") WHERE "state" = 'requested';
CREATE INDEX "pos_session_handoffs_to_operator_profile_id_state_expires_at_idx" ON "pos_session_handoffs"("to_operator_profile_id", "state", "expires_at");
CREATE INDEX "pos_session_handoffs_from_operator_profile_id_state_created_at_idx" ON "pos_session_handoffs"("from_operator_profile_id", "state", "created_at");
CREATE INDEX "pos_session_handoffs_branch_id_created_at_idx" ON "pos_session_handoffs"("branch_id", "created_at");

CREATE FUNCTION "protect_pos_session_handoff_identity"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF OLD."id" IS DISTINCT FROM NEW."id"
    OR OLD."session_id" IS DISTINCT FROM NEW."session_id"
    OR OLD."branch_id" IS DISTINCT FROM NEW."branch_id"
    OR OLD."register_id" IS DISTINCT FROM NEW."register_id"
    OR OLD."from_operator_profile_id" IS DISTINCT FROM NEW."from_operator_profile_id"
    OR OLD."to_operator_profile_id" IS DISTINCT FROM NEW."to_operator_profile_id"
    OR OLD."reason" IS DISTINCT FROM NEW."reason"
    OR OLD."expires_at" IS DISTINCT FROM NEW."expires_at"
    OR OLD."request_idempotency_key" IS DISTINCT FROM NEW."request_idempotency_key"
    OR OLD."request_hash" IS DISTINCT FROM NEW."request_hash"
    OR OLD."held_sale_snapshot" IS DISTINCT FROM NEW."held_sale_snapshot"
    OR OLD."requested_by_actor_id" IS DISTINCT FROM NEW."requested_by_actor_id"
    OR OLD."created_at" IS DISTINCT FROM NEW."created_at"
  THEN
    RAISE EXCEPTION 'pos_session_handoff identity is immutable' USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "pos_session_handoffs_identity_guard"
BEFORE UPDATE ON "pos_session_handoffs"
FOR EACH ROW EXECUTE FUNCTION "protect_pos_session_handoff_identity"();
