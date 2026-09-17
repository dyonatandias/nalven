CREATE TABLE "pos_manual_payment_references" (
  "id" TEXT NOT NULL,
  "branch_id" INTEGER NOT NULL,
  "register_id" INTEGER NOT NULL,
  "session_id" INTEGER NOT NULL,
  "requester_profile_id" INTEGER NOT NULL,
  "requester_user_id" TEXT NOT NULL,
  "sale_draft_id" TEXT NOT NULL,
  "quote_hash" TEXT NOT NULL,
  "payment_index" INTEGER NOT NULL,
  "method" TEXT NOT NULL,
  "amount_cents" INTEGER NOT NULL,
  "provider" TEXT NOT NULL,
  "reference" TEXT NOT NULL,
  "reference_hash" TEXT NOT NULL,
  "reference_last_four" TEXT NOT NULL,
  "occurred_at" TIMESTAMP(3) NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'pending',
  "approval_id" TEXT NOT NULL,
  "idempotency_key" TEXT NOT NULL,
  "request_hash" TEXT NOT NULL,
  "consumed_sale_payment_id" TEXT,
  "consumed_at" TIMESTAMP(3),
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "pos_manual_payment_references_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "pos_manual_payment_references_state_check" CHECK (
    ("status" = 'pending' AND "consumed_sale_payment_id" IS NULL AND "consumed_at" IS NULL)
    OR ("status" = 'consumed' AND "consumed_sale_payment_id" IS NOT NULL AND "consumed_at" IS NOT NULL)
    OR ("status" = 'revoked' AND "consumed_sale_payment_id" IS NULL AND "consumed_at" IS NULL)
  ),
  CONSTRAINT "pos_manual_payment_references_values_check" CHECK (
    "payment_index" BETWEEN 0 AND 9
    AND "amount_cents" > 0
    AND "method" IN ('pix', 'credit', 'debit', 'voucher')
    AND char_length(btrim("provider")) BETWEEN 2 AND 80
    AND "provider" = lower("provider")
    AND "provider" ~ '^[a-z0-9][a-z0-9._:-]*$'
    AND char_length(btrim("reference")) BETWEEN 6 AND 160
    AND ("method" <> 'pix' OR "reference" ~ '^E[0-9]{16}[A-Z0-9]{15}$')
    AND char_length("reference_last_four") BETWEEN 1 AND 4
    AND "reference_last_four" = right("reference", LEAST(4, char_length("reference")))
    AND "reference_hash" ~ '^[a-f0-9]{64}$'
    AND "quote_hash" ~ '^[a-f0-9]{64}$'
    AND "request_hash" ~ '^[a-f0-9]{64}$'
    AND char_length("sale_draft_id") BETWEEN 8 AND 100
    AND char_length("idempotency_key") BETWEEN 8 AND 120
  ),
  CONSTRAINT "pos_manual_payment_references_branch_id_fkey"
    FOREIGN KEY ("branch_id") REFERENCES "branches"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "pos_manual_payment_references_register_id_fkey"
    FOREIGN KEY ("register_id") REFERENCES "pos_registers"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "pos_manual_payment_references_session_id_fkey"
    FOREIGN KEY ("session_id") REFERENCES "cash_register_sessions"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "pos_manual_payment_references_requester_profile_id_fkey"
    FOREIGN KEY ("requester_profile_id") REFERENCES "tenant_user_profiles"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "pos_manual_payment_references_approval_id_fkey"
    FOREIGN KEY ("approval_id") REFERENCES "pos_approvals"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "pos_manual_payment_references_consumed_sale_payment_id_fkey"
    FOREIGN KEY ("consumed_sale_payment_id") REFERENCES "pos_sale_payments"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "pos_manual_payment_references_register_branch_fkey"
    FOREIGN KEY ("register_id", "branch_id") REFERENCES "pos_registers"("id", "branch_id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "pos_manual_payment_references_session_register_fkey"
    FOREIGN KEY ("session_id", "register_id") REFERENCES "cash_register_sessions"("id", "register_id") ON DELETE RESTRICT ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "pos_manual_payment_references_approval_id_key"
  ON "pos_manual_payment_references"("approval_id");
CREATE UNIQUE INDEX "pos_manual_payment_references_consumed_sale_payment_id_key"
  ON "pos_manual_payment_references"("consumed_sale_payment_id");
CREATE UNIQUE INDEX "pos_manual_payment_references_branch_requester_idempotency_key"
  ON "pos_manual_payment_references"("branch_id", "requester_user_id", "idempotency_key");
CREATE UNIQUE INDEX "pos_manual_payment_references_external_reference_key"
  ON "pos_manual_payment_references"("branch_id", "provider", "method", "reference_hash");
CREATE UNIQUE INDEX "pos_manual_payment_references_pix_e2e_tenant_key"
  ON "pos_manual_payment_references"(upper("reference")) WHERE "method" = 'pix';
CREATE UNIQUE INDEX "pos_manual_payment_references_provider_reference_tenant_key"
  ON "pos_manual_payment_references"("provider", lower("reference")) WHERE "method" <> 'pix';
CREATE INDEX "pos_manual_payment_references_sale_draft_payment_status_idx"
  ON "pos_manual_payment_references"("sale_draft_id", "payment_index", "status");
CREATE INDEX "pos_manual_payment_references_session_status_created_idx"
  ON "pos_manual_payment_references"("session_id", "status", "created_at");
CREATE INDEX "pos_manual_payment_references_requester_status_created_idx"
  ON "pos_manual_payment_references"("requester_profile_id", "status", "created_at");

CREATE OR REPLACE FUNCTION reject_pos_manual_payment_reference_rewrite()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'pos_manual_payment_reference is immutable';
  END IF;
  IF NEW."id" IS DISTINCT FROM OLD."id"
    OR NEW."branch_id" IS DISTINCT FROM OLD."branch_id"
    OR NEW."register_id" IS DISTINCT FROM OLD."register_id"
    OR NEW."session_id" IS DISTINCT FROM OLD."session_id"
    OR NEW."requester_profile_id" IS DISTINCT FROM OLD."requester_profile_id"
    OR NEW."requester_user_id" IS DISTINCT FROM OLD."requester_user_id"
    OR NEW."sale_draft_id" IS DISTINCT FROM OLD."sale_draft_id"
    OR NEW."quote_hash" IS DISTINCT FROM OLD."quote_hash"
    OR NEW."payment_index" IS DISTINCT FROM OLD."payment_index"
    OR NEW."method" IS DISTINCT FROM OLD."method"
    OR NEW."amount_cents" IS DISTINCT FROM OLD."amount_cents"
    OR NEW."provider" IS DISTINCT FROM OLD."provider"
    OR NEW."reference" IS DISTINCT FROM OLD."reference"
    OR NEW."reference_hash" IS DISTINCT FROM OLD."reference_hash"
    OR NEW."reference_last_four" IS DISTINCT FROM OLD."reference_last_four"
    OR NEW."occurred_at" IS DISTINCT FROM OLD."occurred_at"
    OR NEW."approval_id" IS DISTINCT FROM OLD."approval_id"
    OR NEW."idempotency_key" IS DISTINCT FROM OLD."idempotency_key"
    OR NEW."request_hash" IS DISTINCT FROM OLD."request_hash"
    OR (OLD."status" <> 'pending' AND ROW(NEW."status", NEW."consumed_sale_payment_id", NEW."consumed_at") IS DISTINCT FROM ROW(OLD."status", OLD."consumed_sale_payment_id", OLD."consumed_at"))
  THEN
    RAISE EXCEPTION 'pos_manual_payment_reference is immutable';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "pos_manual_payment_references_immutable_guard"
BEFORE UPDATE OR DELETE ON "pos_manual_payment_references"
FOR EACH ROW EXECUTE FUNCTION reject_pos_manual_payment_reference_rewrite();
