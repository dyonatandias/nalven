-- POS-1103: immutable, double-entry accounting subledger foundation.
-- No chart of accounts or accounting policy is seeded. Operational producers
-- remain fail-closed until a branch policy is mapped and accountant-approved.

CREATE TABLE "pos_accounting_accounts" (
  "id" TEXT NOT NULL,
  "code" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "account_type" TEXT NOT NULL,
  "normal_balance" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'draft',
  "external_code" TEXT,
  "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "pos_accounting_accounts_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "pos_accounting_accounts_shape_check" CHECK (
    char_length("id") BETWEEN 1 AND 160
    AND char_length("code") BETWEEN 1 AND 80
    AND "code" ~ '^[A-Za-z0-9][A-Za-z0-9._-]*$'
    AND char_length("name") BETWEEN 1 AND 160
    AND "account_type" IN ('asset', 'liability', 'equity', 'revenue', 'expense', 'contra_asset', 'contra_liability')
    AND "normal_balance" IN ('debit', 'credit')
    AND "status" IN ('draft', 'active', 'retired')
    AND ("external_code" IS NULL OR char_length("external_code") BETWEEN 1 AND 120)
  )
);
CREATE UNIQUE INDEX "pos_accounting_accounts_code_key" ON "pos_accounting_accounts"("code");
CREATE INDEX "pos_accounting_accounts_status_type_code_idx" ON "pos_accounting_accounts"("status", "account_type", "code");

CREATE TABLE "pos_accounting_periods" (
  "id" TEXT NOT NULL,
  "branch_id" INTEGER NOT NULL,
  "year" INTEGER NOT NULL,
  "month" INTEGER NOT NULL,
  "starts_at" DATE NOT NULL,
  "ends_at" DATE NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'open',
  "currency" TEXT NOT NULL DEFAULT 'BRL',
  "closed_at" TIMESTAMPTZ,
  "closed_by" TEXT,
  "close_reason" TEXT,
  "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "pos_accounting_periods_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "pos_accounting_periods_shape_check" CHECK (
    char_length("id") BETWEEN 8 AND 160
    AND "year" BETWEEN 2000 AND 2200 AND "month" BETWEEN 1 AND 12
    AND EXTRACT(YEAR FROM "starts_at") = "year" AND EXTRACT(MONTH FROM "starts_at") = "month"
    AND EXTRACT(DAY FROM "starts_at") = 1
    AND "ends_at" = ("starts_at" + INTERVAL '1 month' - INTERVAL '1 day')::date
    AND "status" IN ('open', 'closed') AND "currency" = 'BRL'
    AND (("status" = 'closed') = ("closed_at" IS NOT NULL AND "closed_by" IS NOT NULL AND "close_reason" IS NOT NULL))
    AND ("closed_by" IS NULL OR char_length("closed_by") BETWEEN 1 AND 160)
    AND ("close_reason" IS NULL OR char_length("close_reason") BETWEEN 3 AND 300)
  ),
  CONSTRAINT "pos_accounting_periods_branch_id_fkey" FOREIGN KEY ("branch_id") REFERENCES "branches"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "pos_accounting_periods_id_branch_key" ON "pos_accounting_periods"("id", "branch_id");
CREATE UNIQUE INDEX "pos_accounting_periods_branch_year_month_key" ON "pos_accounting_periods"("branch_id", "year", "month");
CREATE INDEX "pos_accounting_periods_status_dates_idx" ON "pos_accounting_periods"("status", "starts_at", "ends_at");

CREATE TABLE "pos_accounting_policies" (
  "id" TEXT NOT NULL,
  "branch_id" INTEGER NOT NULL,
  "version" INTEGER NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'draft',
  "currency" TEXT NOT NULL DEFAULT 'BRL',
  "effective_from" DATE NOT NULL,
  "effective_until" DATE,
  "mapping_hash" TEXT NOT NULL,
  "accountant_approval_ref" TEXT,
  "homologated_by" TEXT,
  "homologated_at" TIMESTAMPTZ,
  "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "pos_accounting_policies_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "pos_accounting_policies_shape_check" CHECK (
    char_length("id") BETWEEN 8 AND 160 AND "version" > 0
    AND "status" IN ('draft', 'active', 'retired') AND "currency" = 'BRL'
    AND ("effective_until" IS NULL OR "effective_until" >= "effective_from")
    AND "mapping_hash" ~ '^[0-9a-f]{64}$'
    AND (("status" = 'draft') OR ("accountant_approval_ref" IS NOT NULL AND "homologated_by" IS NOT NULL AND "homologated_at" IS NOT NULL))
    AND ("accountant_approval_ref" IS NULL OR char_length("accountant_approval_ref") BETWEEN 8 AND 160)
    AND ("homologated_by" IS NULL OR char_length("homologated_by") BETWEEN 1 AND 160)
  ),
  CONSTRAINT "pos_accounting_policies_branch_id_fkey" FOREIGN KEY ("branch_id") REFERENCES "branches"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "pos_accounting_policies_id_branch_key" ON "pos_accounting_policies"("id", "branch_id");
CREATE UNIQUE INDEX "pos_accounting_policies_branch_version_key" ON "pos_accounting_policies"("branch_id", "version");
CREATE INDEX "pos_accounting_policies_branch_status_dates_idx" ON "pos_accounting_policies"("branch_id", "status", "effective_from", "effective_until");

CREATE TABLE "pos_accounting_policy_mappings" (
  "id" TEXT NOT NULL,
  "policy_id" TEXT NOT NULL,
  "source_type" TEXT NOT NULL,
  "entry_key" TEXT NOT NULL,
  "account_id" TEXT NOT NULL,
  "direction" TEXT NOT NULL,
  "description" TEXT,
  "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "pos_accounting_policy_mappings_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "pos_accounting_policy_mappings_shape_check" CHECK (
    char_length("id") BETWEEN 8 AND 160
    AND "source_type" IN ('sale', 'refund_compensation', 'cash_ledger', 'inventory_cogs', 'fiscal_tax', 'mdr', 'value_account')
    AND char_length("entry_key") BETWEEN 1 AND 120 AND "entry_key" ~ '^[a-z][a-z0-9._-]*$'
    AND "direction" IN ('debit', 'credit')
    AND ("description" IS NULL OR char_length("description") BETWEEN 1 AND 300)
  ),
  CONSTRAINT "pos_accounting_policy_mappings_policy_id_fkey" FOREIGN KEY ("policy_id") REFERENCES "pos_accounting_policies"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "pos_accounting_policy_mappings_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "pos_accounting_accounts"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "pos_accounting_policy_mappings_id_account_key" ON "pos_accounting_policy_mappings"("id", "account_id");
CREATE UNIQUE INDEX "pos_accounting_policy_mappings_policy_source_entry_key" ON "pos_accounting_policy_mappings"("policy_id", "source_type", "entry_key");
CREATE INDEX "pos_accounting_policy_mappings_account_idx" ON "pos_accounting_policy_mappings"("account_id");

CREATE TABLE "pos_accounting_journals" (
  "id" TEXT NOT NULL,
  "branch_id" INTEGER NOT NULL,
  "cost_center_id" INTEGER NOT NULL,
  "period_id" TEXT NOT NULL,
  "policy_id" TEXT NOT NULL,
  "policy_hash" TEXT NOT NULL,
  "origin_type" TEXT NOT NULL,
  "origin_id" TEXT NOT NULL,
  "origin_version" INTEGER NOT NULL,
  "competence_date" DATE NOT NULL,
  "occurred_at" TIMESTAMPTZ NOT NULL,
  "posted_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "currency" TEXT NOT NULL DEFAULT 'BRL',
  "description" TEXT NOT NULL,
  "source_snapshot" JSONB NOT NULL,
  "source_snapshot_hash" TEXT NOT NULL,
  "total_debit_cents" BIGINT NOT NULL,
  "total_credit_cents" BIGINT NOT NULL,
  "idempotency_key" TEXT NOT NULL,
  "request_hash" TEXT NOT NULL,
  "reversal_of_id" TEXT,
  "reversal_reason" TEXT,
  "created_by" TEXT NOT NULL,
  "creation_txid" BIGINT NOT NULL DEFAULT txid_current(),
  "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "pos_accounting_journals_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "pos_accounting_journals_shape_check" CHECK (
    char_length("id") BETWEEN 8 AND 160
    AND "policy_hash" ~ '^[0-9a-f]{64}$'
    AND "origin_type" IN ('sale', 'refund_compensation', 'cash_ledger', 'inventory_cogs', 'fiscal_tax', 'mdr', 'value_account', 'accounting_reversal')
    AND char_length("origin_id") BETWEEN 1 AND 160 AND "origin_version" >= 0
    AND "currency" = 'BRL' AND char_length("description") BETWEEN 1 AND 300
    AND "source_snapshot_hash" ~ '^[0-9a-f]{64}$'
    AND "total_debit_cents" > 0 AND "total_credit_cents" > 0 AND "total_debit_cents" = "total_credit_cents"
    AND char_length("idempotency_key") BETWEEN 16 AND 160 AND "request_hash" ~ '^[0-9a-f]{64}$'
    AND char_length("created_by") BETWEEN 1 AND 160
    AND (("origin_type" = 'accounting_reversal') = ("reversal_of_id" IS NOT NULL AND "reversal_reason" IS NOT NULL))
    AND ("reversal_reason" IS NULL OR char_length("reversal_reason") BETWEEN 3 AND 300)
    AND "creation_txid" > 0
  ),
  CONSTRAINT "pos_accounting_journals_branch_id_fkey" FOREIGN KEY ("branch_id") REFERENCES "branches"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "pos_accounting_journals_cost_center_id_fkey" FOREIGN KEY ("cost_center_id") REFERENCES "cost_centers"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "pos_accounting_journals_period_branch_fkey" FOREIGN KEY ("period_id", "branch_id") REFERENCES "pos_accounting_periods"("id", "branch_id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "pos_accounting_journals_policy_branch_fkey" FOREIGN KEY ("policy_id", "branch_id") REFERENCES "pos_accounting_policies"("id", "branch_id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "pos_accounting_journals_reversal_of_id_fkey" FOREIGN KEY ("reversal_of_id") REFERENCES "pos_accounting_journals"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "pos_accounting_journals_idempotency_key_key" ON "pos_accounting_journals"("idempotency_key");
CREATE UNIQUE INDEX "pos_accounting_journals_origin_key" ON "pos_accounting_journals"("origin_type", "origin_id", "origin_version");
CREATE UNIQUE INDEX "pos_accounting_journals_reversal_of_id_key" ON "pos_accounting_journals"("reversal_of_id") WHERE "reversal_of_id" IS NOT NULL;
CREATE INDEX "pos_accounting_journals_branch_competence_idx" ON "pos_accounting_journals"("branch_id", "competence_date", "id");
CREATE INDEX "pos_accounting_journals_cost_center_competence_idx" ON "pos_accounting_journals"("cost_center_id", "competence_date", "id");
CREATE INDEX "pos_accounting_journals_period_idx" ON "pos_accounting_journals"("period_id", "id");
CREATE INDEX "pos_accounting_journals_policy_idx" ON "pos_accounting_journals"("policy_id", "id");

CREATE TABLE "pos_accounting_postings" (
  "id" BIGSERIAL NOT NULL,
  "journal_id" TEXT NOT NULL,
  "sequence" INTEGER NOT NULL,
  "policy_mapping_id" TEXT NOT NULL,
  "account_id" TEXT NOT NULL,
  "account_code_snapshot" TEXT NOT NULL,
  "account_name_snapshot" TEXT NOT NULL,
  "direction" TEXT NOT NULL,
  "amount_cents" BIGINT NOT NULL,
  "amount" DECIMAL(20,2) NOT NULL,
  "description" TEXT,
  "dimensions" JSONB,
  "creation_txid" BIGINT NOT NULL DEFAULT txid_current(),
  "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "pos_accounting_postings_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "pos_accounting_postings_shape_check" CHECK (
    "sequence" > 0 AND "direction" IN ('debit', 'credit') AND "amount_cents" > 0
    AND "amount" = ("amount_cents"::numeric / 100)
    AND char_length("account_code_snapshot") BETWEEN 1 AND 80
    AND char_length("account_name_snapshot") BETWEEN 1 AND 160
    AND ("description" IS NULL OR char_length("description") BETWEEN 1 AND 300)
    AND "creation_txid" > 0
  ),
  CONSTRAINT "pos_accounting_postings_journal_id_fkey" FOREIGN KEY ("journal_id") REFERENCES "pos_accounting_journals"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "pos_accounting_postings_mapping_account_fkey" FOREIGN KEY ("policy_mapping_id", "account_id") REFERENCES "pos_accounting_policy_mappings"("id", "account_id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "pos_accounting_postings_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "pos_accounting_accounts"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "pos_accounting_postings_journal_sequence_key" ON "pos_accounting_postings"("journal_id", "sequence");
CREATE INDEX "pos_accounting_postings_account_created_idx" ON "pos_accounting_postings"("account_id", "created_at");
CREATE INDEX "pos_accounting_postings_mapping_idx" ON "pos_accounting_postings"("policy_mapping_id");

CREATE TABLE "pos_accounting_export_outbox" (
  "id" BIGSERIAL NOT NULL,
  "journal_id" TEXT NOT NULL,
  "state" TEXT NOT NULL DEFAULT 'pending',
  "delivery_count" INTEGER NOT NULL DEFAULT 0,
  "max_deliveries" INTEGER NOT NULL DEFAULT 8,
  "next_attempt_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "claim_token" TEXT,
  "claim_expires_at" TIMESTAMPTZ,
  "last_error_code" TEXT,
  "external_reference" TEXT,
  "response_hash" TEXT,
  "exported_at" TIMESTAMPTZ,
  "completed_at" TIMESTAMPTZ,
  "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "pos_accounting_export_outbox_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "pos_accounting_export_outbox_shape_check" CHECK (
    "state" IN ('pending', 'claimed', 'retry', 'completed', 'dead')
    AND "delivery_count" BETWEEN 0 AND "max_deliveries" AND "max_deliveries" BETWEEN 1 AND 20
    AND (("state" = 'claimed') = ("claim_token" IS NOT NULL AND "claim_expires_at" IS NOT NULL))
    AND (("state" IN ('completed', 'dead')) = ("completed_at" IS NOT NULL))
    AND (("state" = 'completed') = ("external_reference" IS NOT NULL AND "response_hash" IS NOT NULL AND "exported_at" IS NOT NULL))
    AND ("response_hash" IS NULL OR "response_hash" ~ '^[0-9a-f]{64}$')
  ),
  CONSTRAINT "pos_accounting_export_outbox_journal_id_fkey" FOREIGN KEY ("journal_id") REFERENCES "pos_accounting_journals"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "pos_accounting_export_outbox_journal_id_key" ON "pos_accounting_export_outbox"("journal_id");
CREATE UNIQUE INDEX "pos_accounting_export_outbox_claim_token_key" ON "pos_accounting_export_outbox"("claim_token") WHERE "claim_token" IS NOT NULL;
CREATE INDEX "pos_accounting_export_outbox_state_next_idx" ON "pos_accounting_export_outbox"("state", "next_attempt_at");
CREATE INDEX "pos_accounting_export_outbox_claim_expires_idx" ON "pos_accounting_export_outbox"("claim_expires_at") WHERE "state" = 'claimed';

CREATE FUNCTION "pos_accounting_forbid_mutation"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'POS accounting journal and postings are append-only; post a reversal journal' USING ERRCODE = '55000';
END;
$$;

CREATE FUNCTION "pos_accounting_period_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'POS accounting periods cannot be deleted' USING ERRCODE = '55000'; END IF;
  IF OLD."id" IS DISTINCT FROM NEW."id" OR OLD."branch_id" IS DISTINCT FROM NEW."branch_id"
    OR OLD."year" IS DISTINCT FROM NEW."year" OR OLD."month" IS DISTINCT FROM NEW."month"
    OR OLD."starts_at" IS DISTINCT FROM NEW."starts_at" OR OLD."ends_at" IS DISTINCT FROM NEW."ends_at"
    OR OLD."currency" IS DISTINCT FROM NEW."currency" OR OLD."created_at" IS DISTINCT FROM NEW."created_at"
  THEN RAISE EXCEPTION 'POS accounting period identity is immutable' USING ERRCODE = '55000'; END IF;
  IF OLD."status" = 'closed' AND NEW."status" <> 'closed' THEN RAISE EXCEPTION 'closed POS accounting period cannot be reopened' USING ERRCODE = '55000'; END IF;
  IF OLD."status" = 'open' AND NEW."status" NOT IN ('open', 'closed') THEN RAISE EXCEPTION 'invalid POS accounting period transition' USING ERRCODE = '23514'; END IF;
  IF OLD."status" = 'closed' AND (OLD."closed_at" IS DISTINCT FROM NEW."closed_at" OR OLD."closed_by" IS DISTINCT FROM NEW."closed_by" OR OLD."close_reason" IS DISTINCT FROM NEW."close_reason")
  THEN RAISE EXCEPTION 'closed POS accounting period metadata is immutable' USING ERRCODE = '55000'; END IF;
  RETURN NEW;
END;
$$;

CREATE FUNCTION "pos_accounting_account_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'POS accounting accounts cannot be deleted' USING ERRCODE = '55000'; END IF;
  IF EXISTS (SELECT 1 FROM "pos_accounting_postings" WHERE "account_id" = OLD."id") AND (
    OLD."id" IS DISTINCT FROM NEW."id" OR OLD."code" IS DISTINCT FROM NEW."code"
    OR OLD."account_type" IS DISTINCT FROM NEW."account_type" OR OLD."normal_balance" IS DISTINCT FROM NEW."normal_balance"
  ) THEN RAISE EXCEPTION 'posted POS accounting account identity is immutable' USING ERRCODE = '55000'; END IF;
  IF OLD."status" = 'retired' AND NEW."status" <> 'retired' THEN RAISE EXCEPTION 'retired POS accounting account cannot be reactivated' USING ERRCODE = '55000'; END IF;
  RETURN NEW;
END;
$$;

CREATE FUNCTION "pos_accounting_policy_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE debit_count INTEGER; credit_count INTEGER;
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'POS accounting policies cannot be deleted' USING ERRCODE = '55000'; END IF;
  IF EXISTS (SELECT 1 FROM "pos_accounting_journals" WHERE "policy_id" = OLD."id") AND (
    OLD."id" IS DISTINCT FROM NEW."id" OR OLD."branch_id" IS DISTINCT FROM NEW."branch_id"
    OR OLD."version" IS DISTINCT FROM NEW."version" OR OLD."currency" IS DISTINCT FROM NEW."currency"
    OR OLD."effective_from" IS DISTINCT FROM NEW."effective_from" OR OLD."effective_until" IS DISTINCT FROM NEW."effective_until"
    OR OLD."mapping_hash" IS DISTINCT FROM NEW."mapping_hash"
    OR OLD."accountant_approval_ref" IS DISTINCT FROM NEW."accountant_approval_ref"
    OR OLD."homologated_by" IS DISTINCT FROM NEW."homologated_by" OR OLD."homologated_at" IS DISTINCT FROM NEW."homologated_at"
  ) THEN RAISE EXCEPTION 'used POS accounting policy is immutable' USING ERRCODE = '55000'; END IF;
  IF OLD."status" IN ('active', 'retired') AND (
    OLD."id" IS DISTINCT FROM NEW."id" OR OLD."branch_id" IS DISTINCT FROM NEW."branch_id"
    OR OLD."version" IS DISTINCT FROM NEW."version" OR OLD."currency" IS DISTINCT FROM NEW."currency"
    OR OLD."effective_from" IS DISTINCT FROM NEW."effective_from" OR OLD."effective_until" IS DISTINCT FROM NEW."effective_until"
    OR OLD."mapping_hash" IS DISTINCT FROM NEW."mapping_hash"
    OR OLD."accountant_approval_ref" IS DISTINCT FROM NEW."accountant_approval_ref"
    OR OLD."homologated_by" IS DISTINCT FROM NEW."homologated_by" OR OLD."homologated_at" IS DISTINCT FROM NEW."homologated_at"
  ) THEN RAISE EXCEPTION 'homologated POS accounting policy content is immutable' USING ERRCODE = '55000'; END IF;
  IF OLD."status" = 'retired' AND NEW."status" <> 'retired' THEN RAISE EXCEPTION 'retired POS accounting policy cannot be reactivated' USING ERRCODE = '55000'; END IF;
  IF OLD."status" = 'active' AND NEW."status" NOT IN ('active', 'retired') THEN RAISE EXCEPTION 'active POS accounting policy can only be retired' USING ERRCODE = '55000'; END IF;
  IF OLD."status" = 'draft' AND NEW."status" = 'active' THEN
    SELECT count(*) FILTER (WHERE "direction" = 'debit'), count(*) FILTER (WHERE "direction" = 'credit') INTO debit_count, credit_count
    FROM "pos_accounting_policy_mappings" WHERE "policy_id" = NEW."id";
    IF debit_count = 0 OR credit_count = 0 THEN RAISE EXCEPTION 'POS accounting policy needs mapped debit and credit entries before activation' USING ERRCODE = '23514'; END IF;
  END IF;
  RETURN NEW;
END;
$$;

CREATE FUNCTION "pos_accounting_mapping_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE policy_status TEXT; policy_id_value TEXT;
BEGIN
  policy_id_value := CASE WHEN TG_OP = 'DELETE' THEN OLD."policy_id" ELSE NEW."policy_id" END;
  SELECT "status" INTO STRICT policy_status FROM "pos_accounting_policies" WHERE "id" = policy_id_value FOR KEY SHARE;
  IF policy_status <> 'draft' THEN RAISE EXCEPTION 'active or retired POS accounting policy mappings are immutable' USING ERRCODE = '55000'; END IF;
  IF EXISTS (SELECT 1 FROM "pos_accounting_journals" WHERE "policy_id" = policy_id_value) THEN RAISE EXCEPTION 'used POS accounting policy mappings are immutable' USING ERRCODE = '55000'; END IF;
  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END;
$$;

CREATE FUNCTION "pos_accounting_journal_context_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE period_record "pos_accounting_periods"%ROWTYPE; policy_record "pos_accounting_policies"%ROWTYPE; original_record "pos_accounting_journals"%ROWTYPE;
BEGIN
  IF NEW."creation_txid" <> txid_current() THEN RAISE EXCEPTION 'invalid POS accounting journal transaction identity' USING ERRCODE = '23514'; END IF;
  SELECT * INTO STRICT period_record FROM "pos_accounting_periods" WHERE "id" = NEW."period_id" AND "branch_id" = NEW."branch_id" FOR KEY SHARE;
  IF period_record."status" <> 'open' THEN RAISE EXCEPTION 'closed POS accounting period rejects retroactive journal' USING ERRCODE = '23514'; END IF;
  IF NEW."competence_date" < period_record."starts_at" OR NEW."competence_date" > period_record."ends_at" OR NEW."currency" <> period_record."currency"
  THEN RAISE EXCEPTION 'POS accounting journal does not match its competence period' USING ERRCODE = '23514'; END IF;
  PERFORM 1 FROM "cost_centers" WHERE "id" = NEW."cost_center_id"
    AND (NEW."origin_type" = 'accounting_reversal' OR "active" = true) FOR KEY SHARE;
  IF NOT FOUND THEN RAISE EXCEPTION 'POS accounting journal requires a valid cost center (active for ordinary postings)' USING ERRCODE = '23514'; END IF;
  SELECT * INTO STRICT policy_record FROM "pos_accounting_policies" WHERE "id" = NEW."policy_id" AND "branch_id" = NEW."branch_id" FOR KEY SHARE;
  IF NEW."policy_hash" <> policy_record."mapping_hash" OR NEW."currency" <> policy_record."currency"
  THEN RAISE EXCEPTION 'POS accounting journal policy snapshot mismatch' USING ERRCODE = '23514'; END IF;
  IF NEW."origin_type" = 'accounting_reversal' THEN
    SELECT * INTO STRICT original_record FROM "pos_accounting_journals" WHERE "id" = NEW."reversal_of_id" FOR KEY SHARE;
    IF original_record."reversal_of_id" IS NOT NULL OR NEW."origin_id" <> original_record."id"
      OR NEW."branch_id" <> original_record."branch_id" OR NEW."cost_center_id" <> original_record."cost_center_id"
      OR NEW."policy_id" <> original_record."policy_id" OR NEW."policy_hash" <> original_record."policy_hash"
      OR NEW."currency" <> original_record."currency"
    THEN RAISE EXCEPTION 'invalid POS accounting reversal context' USING ERRCODE = '23514'; END IF;
  ELSE
    IF policy_record."status" <> 'active' OR policy_record."accountant_approval_ref" IS NULL OR policy_record."homologated_at" IS NULL
      OR NEW."competence_date" < policy_record."effective_from"
      OR (policy_record."effective_until" IS NOT NULL AND NEW."competence_date" > policy_record."effective_until")
    THEN RAISE EXCEPTION 'POS accounting policy is not active, homologated, or effective' USING ERRCODE = '23514'; END IF;
  END IF;
  RETURN NEW;
END;
$$;

CREATE FUNCTION "pos_accounting_posting_context_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE journal_record "pos_accounting_journals"%ROWTYPE; mapping_record "pos_accounting_policy_mappings"%ROWTYPE; account_record "pos_accounting_accounts"%ROWTYPE; expected_source TEXT; expected_direction TEXT;
BEGIN
  SELECT * INTO STRICT journal_record FROM "pos_accounting_journals" WHERE "id" = NEW."journal_id" FOR KEY SHARE;
  IF NEW."creation_txid" <> txid_current() OR NEW."creation_txid" <> journal_record."creation_txid"
  THEN RAISE EXCEPTION 'postings must be created in the journal transaction' USING ERRCODE = '55000'; END IF;
  SELECT * INTO STRICT mapping_record FROM "pos_accounting_policy_mappings" WHERE "id" = NEW."policy_mapping_id" AND "account_id" = NEW."account_id" FOR KEY SHARE;
  SELECT * INTO STRICT account_record FROM "pos_accounting_accounts" WHERE "id" = NEW."account_id" FOR KEY SHARE;
  IF journal_record."origin_type" = 'accounting_reversal' THEN
    SELECT "origin_type" INTO STRICT expected_source FROM "pos_accounting_journals" WHERE "id" = journal_record."reversal_of_id";
    expected_direction := CASE mapping_record."direction" WHEN 'debit' THEN 'credit' ELSE 'debit' END;
  ELSE
    expected_source := journal_record."origin_type"; expected_direction := mapping_record."direction";
    IF account_record."status" <> 'active' THEN RAISE EXCEPTION 'POS accounting posting requires an active mapped account' USING ERRCODE = '23514'; END IF;
  END IF;
  IF mapping_record."policy_id" <> journal_record."policy_id" OR mapping_record."source_type" <> expected_source
    OR NEW."direction" <> expected_direction OR NEW."account_code_snapshot" <> account_record."code" OR NEW."account_name_snapshot" <> account_record."name"
  THEN RAISE EXCEPTION 'POS accounting posting does not match the approved policy mapping' USING ERRCODE = '23514'; END IF;
  RETURN NEW;
END;
$$;

CREATE FUNCTION "pos_accounting_validate_balanced_journal"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE journal_id_value TEXT; journal_record "pos_accounting_journals"%ROWTYPE; posting_count BIGINT; debit_total NUMERIC; credit_total NUMERIC; outbox_count BIGINT; original_count BIGINT; mismatch_count BIGINT;
BEGIN
  journal_id_value := CASE WHEN TG_TABLE_NAME = 'pos_accounting_journals' THEN to_jsonb(NEW)->>'id' ELSE to_jsonb(NEW)->>'journal_id' END;
  SELECT * INTO STRICT journal_record FROM "pos_accounting_journals" WHERE "id" = journal_id_value;
  SELECT count(*), COALESCE(sum("amount_cents") FILTER (WHERE "direction" = 'debit'), 0), COALESCE(sum("amount_cents") FILTER (WHERE "direction" = 'credit'), 0)
    INTO posting_count, debit_total, credit_total FROM "pos_accounting_postings" WHERE "journal_id" = journal_id_value;
  IF posting_count < 2 OR debit_total <> credit_total OR debit_total <= 0
    OR debit_total <> journal_record."total_debit_cents" OR credit_total <> journal_record."total_credit_cents"
  THEN RAISE EXCEPTION 'POS accounting journal debits and credits must balance exactly' USING ERRCODE = '23514'; END IF;
  SELECT count(*) INTO outbox_count FROM "pos_accounting_export_outbox" WHERE "journal_id" = journal_id_value;
  IF outbox_count <> 1 THEN RAISE EXCEPTION 'POS accounting journal requires exactly one export outbox row' USING ERRCODE = '23514'; END IF;
  IF journal_record."reversal_of_id" IS NOT NULL THEN
    SELECT count(*) INTO original_count FROM "pos_accounting_postings" WHERE "journal_id" = journal_record."reversal_of_id";
    SELECT count(*) INTO mismatch_count FROM "pos_accounting_postings" original
      LEFT JOIN "pos_accounting_postings" reversal ON reversal."journal_id" = journal_id_value AND reversal."sequence" = original."sequence"
      WHERE original."journal_id" = journal_record."reversal_of_id" AND (
        reversal."id" IS NULL OR reversal."account_id" <> original."account_id" OR reversal."policy_mapping_id" <> original."policy_mapping_id"
        OR reversal."amount_cents" <> original."amount_cents"
        OR reversal."direction" <> CASE original."direction" WHEN 'debit' THEN 'credit' ELSE 'debit' END
      );
    IF posting_count <> original_count OR mismatch_count <> 0 THEN RAISE EXCEPTION 'POS accounting reversal must exactly invert the original journal' USING ERRCODE = '23514'; END IF;
  END IF;
  RETURN NEW;
END;
$$;

CREATE FUNCTION "pos_accounting_export_outbox_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'POS accounting export outbox cannot be deleted' USING ERRCODE = '55000'; END IF;
  IF OLD."journal_id" IS DISTINCT FROM NEW."journal_id" OR OLD."created_at" IS DISTINCT FROM NEW."created_at"
  THEN RAISE EXCEPTION 'POS accounting export outbox identity is immutable' USING ERRCODE = '55000'; END IF;
  IF (OLD."state" = 'completed' AND NEW."state" <> 'completed') OR (OLD."state" = 'dead' AND NEW."state" <> 'dead')
  THEN RAISE EXCEPTION 'terminal POS accounting export state is immutable' USING ERRCODE = '55000'; END IF;
  IF NEW."delivery_count" < OLD."delivery_count" THEN RAISE EXCEPTION 'POS accounting export delivery count cannot regress' USING ERRCODE = '23514'; END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "pos_accounting_journals_immutable_guard" BEFORE UPDATE OR DELETE ON "pos_accounting_journals" FOR EACH ROW EXECUTE FUNCTION "pos_accounting_forbid_mutation"();
CREATE TRIGGER "pos_accounting_postings_immutable_guard" BEFORE UPDATE OR DELETE ON "pos_accounting_postings" FOR EACH ROW EXECUTE FUNCTION "pos_accounting_forbid_mutation"();
CREATE TRIGGER "pos_accounting_periods_guard" BEFORE UPDATE OR DELETE ON "pos_accounting_periods" FOR EACH ROW EXECUTE FUNCTION "pos_accounting_period_guard"();
CREATE TRIGGER "pos_accounting_accounts_guard" BEFORE UPDATE OR DELETE ON "pos_accounting_accounts" FOR EACH ROW EXECUTE FUNCTION "pos_accounting_account_guard"();
CREATE TRIGGER "pos_accounting_policies_guard" BEFORE UPDATE OR DELETE ON "pos_accounting_policies" FOR EACH ROW EXECUTE FUNCTION "pos_accounting_policy_guard"();
CREATE TRIGGER "pos_accounting_policy_mappings_guard" BEFORE INSERT OR UPDATE OR DELETE ON "pos_accounting_policy_mappings" FOR EACH ROW EXECUTE FUNCTION "pos_accounting_mapping_guard"();
CREATE TRIGGER "pos_accounting_journal_context_guard" BEFORE INSERT ON "pos_accounting_journals" FOR EACH ROW EXECUTE FUNCTION "pos_accounting_journal_context_guard"();
CREATE TRIGGER "pos_accounting_posting_context_guard" BEFORE INSERT ON "pos_accounting_postings" FOR EACH ROW EXECUTE FUNCTION "pos_accounting_posting_context_guard"();
CREATE TRIGGER "pos_accounting_export_outbox_guard" BEFORE UPDATE OR DELETE ON "pos_accounting_export_outbox" FOR EACH ROW EXECUTE FUNCTION "pos_accounting_export_outbox_guard"();

CREATE CONSTRAINT TRIGGER "pos_accounting_journal_balance_guard"
AFTER INSERT ON "pos_accounting_journals" DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION "pos_accounting_validate_balanced_journal"();
CREATE CONSTRAINT TRIGGER "pos_accounting_posting_balance_guard"
AFTER INSERT ON "pos_accounting_postings" DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION "pos_accounting_validate_balanced_journal"();

COMMENT ON TABLE "pos_accounting_journals" IS 'Immutable POS double-entry journals. Never update/delete; post an exact reversal journal.';
COMMENT ON TABLE "pos_accounting_postings" IS 'Immutable BRL postings in integer cents and exact Decimal(20,2).';
COMMENT ON TABLE "pos_accounting_export_outbox" IS 'Mutable export delivery state kept outside the immutable journal.';
