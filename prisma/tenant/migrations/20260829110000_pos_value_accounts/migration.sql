ALTER TABLE "pos_admin_mutations"
  DROP CONSTRAINT "pos_admin_mutations_action_check";

ALTER TABLE "pos_admin_mutations"
  ADD CONSTRAINT "pos_admin_mutations_action_check" CHECK ("action" IN (
    'register.create', 'register.update', 'register.deactivate',
    'terminal.create', 'terminal.update', 'terminal.deactivate',
    'device.create', 'device.update', 'device.deactivate',
    'connector.create', 'connector.update', 'connector.deactivate',
    'terminal.pairing.issue', 'terminal.token.rotate', 'terminal.revoke',
    'promotion.create', 'promotion.update', 'promotion.deactivate',
    'coupon.create', 'coupon.update', 'coupon.rotate', 'coupon.deactivate',
    'inventory.receive', 'inventory.quarantine', 'inventory.release', 'inventory.discard',
    'value.program.create', 'value.program.deactivate',
    'value.account.issue', 'value.account.credit', 'value.account.debit', 'value.account.expire',
    'value.reservation.create', 'value.reservation.capture', 'value.reservation.release',
    'value.entry.reverse'
  ));

CREATE TABLE "pos_value_programs" (
  "id" TEXT NOT NULL,
  "branch_id" INTEGER NOT NULL,
  "name" TEXT NOT NULL,
  "kind" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'active',
  "earn_units" INTEGER NOT NULL,
  "spend_cents" INTEGER NOT NULL,
  "redeem_cents_per_unit" INTEGER NOT NULL,
  "expires_after_days" INTEGER,
  "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ NOT NULL,
  CONSTRAINT "pos_value_programs_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "pos_value_programs_kind_check" CHECK ("kind" IN ('loyalty_points', 'cashback')),
  CONSTRAINT "pos_value_programs_status_check" CHECK ("status" IN ('active', 'inactive')),
  CONSTRAINT "pos_value_programs_rules_check" CHECK (
    "earn_units" BETWEEN 1 AND 2147483647
    AND "spend_cents" BETWEEN 1 AND 2147483647
    AND "redeem_cents_per_unit" BETWEEN 1 AND 2147483647
    AND ("expires_after_days" IS NULL OR "expires_after_days" BETWEEN 1 AND 36500)
  ),
  CONSTRAINT "pos_value_programs_name_check" CHECK (char_length(btrim("name")) BETWEEN 2 AND 160)
);

CREATE TABLE "pos_value_accounts" (
  "id" TEXT NOT NULL,
  "branch_id" INTEGER NOT NULL,
  "customer_id" INTEGER,
  "program_id" TEXT,
  "kind" TEXT NOT NULL,
  "unit" TEXT NOT NULL,
  "label" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'active',
  "code_hash" TEXT,
  "code_last_four" TEXT,
  "pin_hash" TEXT,
  "balance_units" BIGINT NOT NULL DEFAULT 0,
  "reserved_units" BIGINT NOT NULL DEFAULT 0,
  "version" INTEGER NOT NULL DEFAULT 0,
  "expires_at" TIMESTAMPTZ,
  "metadata" JSONB,
  "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ NOT NULL,
  CONSTRAINT "pos_value_accounts_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "pos_value_accounts_kind_check" CHECK ("kind" IN ('loyalty_points', 'cashback', 'gift_card', 'store_credit')),
  CONSTRAINT "pos_value_accounts_unit_check" CHECK ("unit" IN ('points', 'cents')),
  CONSTRAINT "pos_value_accounts_status_check" CHECK ("status" IN ('active', 'blocked', 'expired', 'closed')),
  CONSTRAINT "pos_value_accounts_balance_check" CHECK (
    "balance_units" BETWEEN 0 AND 9000000000000000
    AND "reserved_units" BETWEEN 0 AND "balance_units"
    AND "version" >= 0
  ),
  CONSTRAINT "pos_value_accounts_label_check" CHECK (char_length(btrim("label")) BETWEEN 2 AND 160),
  CONSTRAINT "pos_value_accounts_identity_check" CHECK (
    ("kind" = 'loyalty_points' AND "unit" = 'points' AND "customer_id" IS NOT NULL AND "program_id" IS NOT NULL AND "code_hash" IS NULL AND "code_last_four" IS NULL AND "pin_hash" IS NULL)
    OR ("kind" = 'cashback' AND "unit" = 'cents' AND "customer_id" IS NOT NULL AND "program_id" IS NOT NULL AND "code_hash" IS NULL AND "code_last_four" IS NULL AND "pin_hash" IS NULL)
    OR ("kind" = 'store_credit' AND "unit" = 'cents' AND "customer_id" IS NOT NULL AND "program_id" IS NULL AND "code_hash" IS NULL AND "code_last_four" IS NULL AND "pin_hash" IS NULL)
    OR ("kind" = 'gift_card' AND "unit" = 'cents' AND "program_id" IS NULL AND "code_hash" IS NOT NULL AND "code_last_four" IS NOT NULL AND "pin_hash" ~ '^scrypt:')
  ),
  CONSTRAINT "pos_value_accounts_code_check" CHECK (
    ("code_hash" IS NULL AND "code_last_four" IS NULL)
    OR ("code_hash" ~ '^hmac-sha256:v1:[0-9a-f]{64}$' AND char_length("code_last_four") = 4)
  )
);

CREATE TABLE "pos_value_reservations" (
  "id" TEXT NOT NULL,
  "account_id" TEXT NOT NULL,
  "branch_id" INTEGER NOT NULL,
  "amount_units" BIGINT NOT NULL,
  "state" TEXT NOT NULL DEFAULT 'active',
  "operation_key" TEXT NOT NULL,
  "request_hash" TEXT NOT NULL,
  "reference_type" TEXT NOT NULL,
  "reference_id" TEXT NOT NULL,
  "expires_at" TIMESTAMPTZ NOT NULL,
  "completed_at" TIMESTAMPTZ,
  "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ NOT NULL,
  CONSTRAINT "pos_value_reservations_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "pos_value_reservations_amount_check" CHECK ("amount_units" BETWEEN 1 AND 9000000000000000),
  CONSTRAINT "pos_value_reservations_state_check" CHECK ("state" IN ('active', 'captured', 'released', 'expired')),
  CONSTRAINT "pos_value_reservations_completion_check" CHECK (
    ("state" = 'active' AND "completed_at" IS NULL)
    OR ("state" <> 'active' AND "completed_at" IS NOT NULL)
  ),
  CONSTRAINT "pos_value_reservations_hash_check" CHECK ("request_hash" ~ '^[0-9a-f]{64}$'),
  CONSTRAINT "pos_value_reservations_text_check" CHECK (
    char_length("operation_key") BETWEEN 16 AND 200
    AND char_length("reference_type") BETWEEN 1 AND 80
    AND char_length("reference_id") BETWEEN 1 AND 160
  )
);

CREATE TABLE "pos_value_ledger_entries" (
  "id" BIGSERIAL NOT NULL,
  "account_id" TEXT NOT NULL,
  "reservation_id" TEXT,
  "reversal_of_id" BIGINT,
  "type" TEXT NOT NULL,
  "amount_units" BIGINT NOT NULL,
  "balance_delta_units" BIGINT NOT NULL,
  "reserved_delta_units" BIGINT NOT NULL,
  "balance_before_units" BIGINT NOT NULL,
  "balance_after_units" BIGINT NOT NULL,
  "reserved_before_units" BIGINT NOT NULL,
  "reserved_after_units" BIGINT NOT NULL,
  "operation_key" TEXT NOT NULL,
  "request_hash" TEXT NOT NULL,
  "reference_type" TEXT NOT NULL,
  "reference_id" TEXT NOT NULL,
  "actor" TEXT NOT NULL,
  "reason" TEXT,
  "metadata" JSONB,
  "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "pos_value_ledger_entries_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "pos_value_ledger_entries_type_check" CHECK ("type" IN ('issue', 'credit', 'debit', 'reserve', 'capture', 'release', 'expire', 'reversal')),
  CONSTRAINT "pos_value_ledger_entries_equation_check" CHECK (
    "amount_units" BETWEEN 0 AND 9000000000000000
    AND "balance_after_units" = "balance_before_units" + "balance_delta_units"
    AND "reserved_after_units" = "reserved_before_units" + "reserved_delta_units"
    AND "balance_before_units" BETWEEN 0 AND 9000000000000000
    AND "balance_after_units" BETWEEN 0 AND 9000000000000000
    AND "reserved_before_units" BETWEEN 0 AND "balance_before_units"
    AND "reserved_after_units" BETWEEN 0 AND "balance_after_units"
  ),
  CONSTRAINT "pos_value_ledger_entries_delta_check" CHECK (
    ("type" = 'issue' AND "balance_delta_units" = "amount_units" AND "reserved_delta_units" = 0)
    OR ("type" = 'credit' AND "amount_units" > 0 AND "balance_delta_units" = "amount_units" AND "reserved_delta_units" = 0)
    OR ("type" = 'debit' AND "amount_units" > 0 AND "balance_delta_units" = -"amount_units" AND "reserved_delta_units" = 0)
    OR ("type" = 'reserve' AND "amount_units" > 0 AND "balance_delta_units" = 0 AND "reserved_delta_units" = "amount_units")
    OR ("type" = 'capture' AND "amount_units" > 0 AND "balance_delta_units" = -"amount_units" AND "reserved_delta_units" = -"amount_units")
    OR ("type" = 'release' AND "amount_units" > 0 AND "balance_delta_units" = 0 AND "reserved_delta_units" = -"amount_units")
    OR ("type" = 'expire' AND "balance_delta_units" = -"amount_units" AND "reserved_delta_units" = 0)
    OR ("type" = 'reversal' AND "amount_units" > 0 AND abs("balance_delta_units") = "amount_units" AND "reserved_delta_units" = 0)
  ),
  CONSTRAINT "pos_value_ledger_entries_reversal_check" CHECK (("type" = 'reversal') = ("reversal_of_id" IS NOT NULL)),
  CONSTRAINT "pos_value_ledger_entries_reservation_check" CHECK (("type" IN ('reserve', 'capture', 'release')) = ("reservation_id" IS NOT NULL)),
  CONSTRAINT "pos_value_ledger_entries_hash_check" CHECK ("request_hash" ~ '^[0-9a-f]{64}$'),
  CONSTRAINT "pos_value_ledger_entries_text_check" CHECK (
    char_length("operation_key") BETWEEN 16 AND 200
    AND char_length("reference_type") BETWEEN 1 AND 80
    AND char_length("reference_id") BETWEEN 1 AND 160
    AND char_length("actor") BETWEEN 1 AND 200
    AND ("reason" IS NULL OR char_length("reason") BETWEEN 4 AND 500)
  )
);

CREATE UNIQUE INDEX "pos_value_programs_branch_id_name_key" ON "pos_value_programs"("branch_id", "name");
CREATE INDEX "pos_value_programs_branch_id_kind_status_idx" ON "pos_value_programs"("branch_id", "kind", "status");
CREATE UNIQUE INDEX "pos_value_accounts_code_hash_key" ON "pos_value_accounts"("code_hash");
CREATE UNIQUE INDEX "pos_value_accounts_program_customer_key" ON "pos_value_accounts"("program_id", "customer_id");
CREATE UNIQUE INDEX "pos_value_accounts_store_credit_customer_key" ON "pos_value_accounts"("branch_id", "customer_id", "kind") WHERE "kind" = 'store_credit';
CREATE INDEX "pos_value_accounts_branch_id_kind_status_idx" ON "pos_value_accounts"("branch_id", "kind", "status");
CREATE INDEX "pos_value_accounts_customer_id_kind_status_idx" ON "pos_value_accounts"("customer_id", "kind", "status");
CREATE INDEX "pos_value_accounts_expires_at_status_idx" ON "pos_value_accounts"("expires_at", "status");
CREATE UNIQUE INDEX "pos_value_reservations_operation_key_key" ON "pos_value_reservations"("operation_key");
CREATE INDEX "pos_value_reservations_account_reference_idx" ON "pos_value_reservations"("account_id", "reference_type", "reference_id");
CREATE INDEX "pos_value_reservations_account_id_state_expires_at_idx" ON "pos_value_reservations"("account_id", "state", "expires_at");
CREATE INDEX "pos_value_reservations_branch_id_state_expires_at_idx" ON "pos_value_reservations"("branch_id", "state", "expires_at");
CREATE UNIQUE INDEX "pos_value_ledger_entries_operation_key_key" ON "pos_value_ledger_entries"("operation_key");
CREATE UNIQUE INDEX "pos_value_ledger_entries_reversal_of_id_key" ON "pos_value_ledger_entries"("reversal_of_id");
CREATE INDEX "pos_value_ledger_entries_account_id_created_at_idx" ON "pos_value_ledger_entries"("account_id", "created_at");
CREATE INDEX "pos_value_ledger_entries_reservation_id_created_at_idx" ON "pos_value_ledger_entries"("reservation_id", "created_at");
CREATE INDEX "pos_value_ledger_entries_reference_type_reference_id_idx" ON "pos_value_ledger_entries"("reference_type", "reference_id");

ALTER TABLE "pos_value_programs" ADD CONSTRAINT "pos_value_programs_branch_id_fkey" FOREIGN KEY ("branch_id") REFERENCES "branches"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "pos_value_accounts" ADD CONSTRAINT "pos_value_accounts_branch_id_fkey" FOREIGN KEY ("branch_id") REFERENCES "branches"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "pos_value_accounts" ADD CONSTRAINT "pos_value_accounts_customer_id_fkey" FOREIGN KEY ("customer_id") REFERENCES "customers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "pos_value_accounts" ADD CONSTRAINT "pos_value_accounts_program_id_fkey" FOREIGN KEY ("program_id") REFERENCES "pos_value_programs"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "pos_value_reservations" ADD CONSTRAINT "pos_value_reservations_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "pos_value_accounts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "pos_value_reservations" ADD CONSTRAINT "pos_value_reservations_branch_id_fkey" FOREIGN KEY ("branch_id") REFERENCES "branches"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "pos_value_ledger_entries" ADD CONSTRAINT "pos_value_ledger_entries_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "pos_value_accounts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "pos_value_ledger_entries" ADD CONSTRAINT "pos_value_ledger_entries_reservation_id_fkey" FOREIGN KEY ("reservation_id") REFERENCES "pos_value_reservations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "pos_value_ledger_entries" ADD CONSTRAINT "pos_value_ledger_entries_reversal_of_id_fkey" FOREIGN KEY ("reversal_of_id") REFERENCES "pos_value_ledger_entries"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE FUNCTION "reject_pos_value_ledger_mutation"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'pos_value_ledger_entries is immutable' USING ERRCODE = '55000';
END;
$$;

CREATE TRIGGER "pos_value_ledger_entries_immutable_guard"
BEFORE UPDATE OR DELETE ON "pos_value_ledger_entries"
FOR EACH ROW EXECUTE FUNCTION "reject_pos_value_ledger_mutation"();
