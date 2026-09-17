ALTER TABLE "pos_register_accesses"
  ADD COLUMN "can_transfer_held" BOOLEAN NOT NULL DEFAULT false;

ALTER TABLE "pos_held_sales"
  ADD COLUMN "revision" INTEGER NOT NULL DEFAULT 0,
  ADD CONSTRAINT "pos_held_sales_revision_check" CHECK ("revision" >= 0);

CREATE TABLE "pos_held_sale_transfers" (
  "id" BIGSERIAL NOT NULL,
  "held_sale_id" TEXT NOT NULL,
  "branch_id" INTEGER NOT NULL,
  "from_register_id" INTEGER NOT NULL,
  "from_session_id" INTEGER NOT NULL,
  "from_operator_profile_id" INTEGER NOT NULL,
  "to_register_id" INTEGER NOT NULL,
  "to_session_id" INTEGER NOT NULL,
  "to_operator_profile_id" INTEGER NOT NULL,
  "actor_profile_id" INTEGER NOT NULL,
  "actor_user_id" TEXT NOT NULL,
  "expected_revision" INTEGER NOT NULL,
  "resulting_revision" INTEGER NOT NULL,
  "idempotency_key" TEXT NOT NULL,
  "request_hash" TEXT NOT NULL,
  "reason" TEXT NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "pos_held_sale_transfers_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "pos_held_sale_transfers_revision_check" CHECK (
    "expected_revision" >= 0 AND "resulting_revision" = "expected_revision" + 1
  ),
  CONSTRAINT "pos_held_sale_transfers_distinct_check" CHECK (
    "from_session_id" <> "to_session_id"
    AND "from_register_id" <> "to_register_id"
    AND "from_operator_profile_id" <> "to_operator_profile_id"
  ),
  CONSTRAINT "pos_held_sale_transfers_hash_check" CHECK ("request_hash" ~ '^[0-9a-f]{64}$'),
  CONSTRAINT "pos_held_sale_transfers_text_check" CHECK (
    char_length("idempotency_key") BETWEEN 16 AND 160
    AND char_length("actor_user_id") BETWEEN 1 AND 160
    AND char_length(btrim("reason")) BETWEEN 4 AND 300
  )
);

CREATE UNIQUE INDEX "pos_held_sale_transfers_idempotency_key_key"
  ON "pos_held_sale_transfers"("idempotency_key");
CREATE UNIQUE INDEX "pos_held_sale_transfers_held_sale_id_resulting_revision_key"
  ON "pos_held_sale_transfers"("held_sale_id", "resulting_revision");
CREATE INDEX "pos_held_sale_transfers_branch_id_created_at_idx"
  ON "pos_held_sale_transfers"("branch_id", "created_at");
CREATE INDEX "pos_held_sale_transfers_from_operator_profile_id_created_at_idx"
  ON "pos_held_sale_transfers"("from_operator_profile_id", "created_at");
CREATE INDEX "pos_held_sale_transfers_to_operator_profile_id_created_at_idx"
  ON "pos_held_sale_transfers"("to_operator_profile_id", "created_at");

-- These composite keys make the register/session and register/branch snapshots
-- self-consistent even if a writer bypasses the application service.
CREATE UNIQUE INDEX "pos_registers_id_branch_id_key"
  ON "pos_registers"("id", "branch_id");

ALTER TABLE "pos_held_sale_transfers"
  ADD CONSTRAINT "pos_held_sale_transfers_held_sale_id_fkey" FOREIGN KEY ("held_sale_id") REFERENCES "pos_held_sales"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "pos_held_sale_transfers_branch_id_fkey" FOREIGN KEY ("branch_id") REFERENCES "branches"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "pos_held_sale_transfers_from_register_id_fkey" FOREIGN KEY ("from_register_id") REFERENCES "pos_registers"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "pos_held_sale_transfers_from_session_id_fkey" FOREIGN KEY ("from_session_id") REFERENCES "cash_register_sessions"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "pos_held_sale_transfers_from_operator_profile_id_fkey" FOREIGN KEY ("from_operator_profile_id") REFERENCES "tenant_user_profiles"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "pos_held_sale_transfers_to_register_id_fkey" FOREIGN KEY ("to_register_id") REFERENCES "pos_registers"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "pos_held_sale_transfers_to_session_id_fkey" FOREIGN KEY ("to_session_id") REFERENCES "cash_register_sessions"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "pos_held_sale_transfers_to_operator_profile_id_fkey" FOREIGN KEY ("to_operator_profile_id") REFERENCES "tenant_user_profiles"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "pos_held_sale_transfers_actor_profile_id_fkey" FOREIGN KEY ("actor_profile_id") REFERENCES "tenant_user_profiles"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "pos_held_sale_transfers_from_session_register_fkey" FOREIGN KEY ("from_session_id", "from_register_id") REFERENCES "cash_register_sessions"("id", "register_id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "pos_held_sale_transfers_to_session_register_fkey" FOREIGN KEY ("to_session_id", "to_register_id") REFERENCES "cash_register_sessions"("id", "register_id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "pos_held_sale_transfers_from_register_branch_fkey" FOREIGN KEY ("from_register_id", "branch_id") REFERENCES "pos_registers"("id", "branch_id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "pos_held_sale_transfers_to_register_branch_fkey" FOREIGN KEY ("to_register_id", "branch_id") REFERENCES "pos_registers"("id", "branch_id") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE FUNCTION "reject_pos_held_sale_transfer_mutation"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'pos_held_sale_transfers is immutable' USING ERRCODE = '55000';
END;
$$;

CREATE TRIGGER "pos_held_sale_transfers_immutable_guard"
BEFORE UPDATE OR DELETE ON "pos_held_sale_transfers"
FOR EACH ROW EXECUTE FUNCTION "reject_pos_held_sale_transfer_mutation"();
