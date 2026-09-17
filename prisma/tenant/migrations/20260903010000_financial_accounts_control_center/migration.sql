ALTER TABLE "financial_accounts"
  ADD COLUMN "code" TEXT,
  ADD COLUMN "branch_id" INTEGER,
  ADD COLUMN "description" TEXT,
  ADD COLUMN "institution_name" TEXT,
  ADD COLUMN "bank_code" TEXT,
  ADD COLUMN "agency" TEXT,
  ADD COLUMN "account_number_last4" TEXT,
  ADD COLUMN "color" TEXT NOT NULL DEFAULT '#168151',
  ADD COLUMN "credit_limit" DOUBLE PRECISION NOT NULL DEFAULT 0,
  ADD COLUMN "opening_balance_cents" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "current_balance_cents" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "credit_limit_cents" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "version" INTEGER NOT NULL DEFAULT 1,
  ADD COLUMN "archived_at" TIMESTAMPTZ;

UPDATE "financial_accounts"
SET "code" = 'ACC-' || LPAD("id"::text, 4, '0'),
    "opening_balance_cents" = ROUND("opening_balance"::numeric * 100)::integer,
    "current_balance_cents" = ROUND("current_balance"::numeric * 100)::integer;

ALTER TABLE "financial_accounts"
  ALTER COLUMN "code" SET NOT NULL,
  ALTER COLUMN "code" SET DEFAULT ('ACC-' || UPPER(SUBSTR(MD5(RANDOM()::text), 1, 10))),
  ADD CONSTRAINT "financial_accounts_branch_id_fkey" FOREIGN KEY ("branch_id") REFERENCES "branches"("id") ON DELETE SET NULL,
  ADD CONSTRAINT "financial_accounts_type_check" CHECK ("type" IN ('bank','cash','wallet','investment')),
  ADD CONSTRAINT "financial_accounts_currency_check" CHECK ("currency" ~ '^[A-Z]{3}$'),
  ADD CONSTRAINT "financial_accounts_money_check" CHECK (
    "opening_balance" NOT IN ('NaN','Infinity','-Infinity') AND
    "current_balance" NOT IN ('NaN','Infinity','-Infinity') AND
    "credit_limit" NOT IN ('NaN','Infinity','-Infinity') AND
    "opening_balance_cents" = ROUND("opening_balance"::numeric * 100)::integer AND
    "current_balance_cents" = ROUND("current_balance"::numeric * 100)::integer AND
    "credit_limit_cents" = ROUND("credit_limit"::numeric * 100)::integer AND
    "credit_limit_cents" >= 0 AND "version" > 0
  ),
  ADD CONSTRAINT "financial_accounts_last4_check" CHECK ("account_number_last4" IS NULL OR "account_number_last4" ~ '^[0-9A-Za-z]{2,8}$'),
  ADD CONSTRAINT "financial_accounts_color_check" CHECK ("color" ~ '^#[0-9A-Fa-f]{6}$');

CREATE UNIQUE INDEX "financial_accounts_code_key" ON "financial_accounts"("code");
CREATE INDEX "financial_accounts_branch_id_active_idx" ON "financial_accounts"("branch_id", "active");

ALTER TABLE "account_entries"
  ADD COLUMN "amount_cents" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "balance_after_cents" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "reference" TEXT,
  ADD COLUMN "correlation_id" TEXT,
  ADD COLUMN "reversal_of_id" INTEGER,
  ADD COLUMN "created_at" TIMESTAMPTZ NOT NULL DEFAULT now();

UPDATE "account_entries" SET "amount_cents" = ROUND(ABS("amount")::numeric * 100)::integer;

WITH running AS (
  SELECT entry."id",
    account."opening_balance_cents" + SUM(CASE WHEN entry."type"='credit' THEN entry."amount_cents" ELSE -entry."amount_cents" END)
      OVER (PARTITION BY entry."account_id" ORDER BY entry."occurred_at", entry."id" ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW) AS balance_after
  FROM "account_entries" entry
  JOIN "financial_accounts" account ON account."id"=entry."account_id"
)
UPDATE "account_entries" entry SET "balance_after_cents"=running.balance_after FROM running WHERE running."id"=entry."id";

ALTER TABLE "account_entries"
  ADD CONSTRAINT "account_entries_reversal_of_id_fkey" FOREIGN KEY ("reversal_of_id") REFERENCES "account_entries"("id") ON DELETE RESTRICT,
  ADD CONSTRAINT "account_entries_type_check" CHECK ("type" IN ('credit','debit')),
  ADD CONSTRAINT "account_entries_amount_check" CHECK ("amount_cents" > 0 AND "amount" NOT IN ('NaN','Infinity','-Infinity') AND "amount_cents"=ROUND(ABS("amount")::numeric * 100)::integer);

CREATE UNIQUE INDEX "account_entries_reversal_of_id_key" ON "account_entries"("reversal_of_id") WHERE "reversal_of_id" IS NOT NULL;
CREATE INDEX "account_entries_correlation_id_idx" ON "account_entries"("correlation_id");

ALTER TABLE "account_transfers"
  ADD COLUMN "amount_cents" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "status" TEXT NOT NULL DEFAULT 'posted',
  ADD COLUMN "idempotency_key" TEXT,
  ADD COLUMN "correlation_id" TEXT,
  ADD COLUMN "reversal_idempotency_key" TEXT,
  ADD COLUMN "reversed_at" TIMESTAMPTZ,
  ADD COLUMN "reversed_by" TEXT,
  ADD COLUMN "reversal_reason" TEXT;

UPDATE "account_transfers" SET "amount_cents"=ROUND(ABS("amount")::numeric * 100)::integer;

ALTER TABLE "account_transfers"
  ADD CONSTRAINT "account_transfers_distinct_accounts_check" CHECK ("from_account_id"<>"to_account_id"),
  ADD CONSTRAINT "account_transfers_amount_check" CHECK ("amount_cents">0 AND "amount" NOT IN ('NaN','Infinity','-Infinity') AND "amount_cents"=ROUND(ABS("amount")::numeric * 100)::integer),
  ADD CONSTRAINT "account_transfers_status_check" CHECK ("status" IN ('posted','reversed')),
  ADD CONSTRAINT "account_transfers_reversal_check" CHECK (
    ("status"='posted' AND "reversed_at" IS NULL AND "reversed_by" IS NULL AND "reversal_reason" IS NULL AND "reversal_idempotency_key" IS NULL) OR
    ("status"='reversed' AND "reversed_at" IS NOT NULL AND "reversed_by" IS NOT NULL AND "reversal_reason" IS NOT NULL AND "reversal_idempotency_key" IS NOT NULL)
  );

CREATE UNIQUE INDEX "account_transfers_idempotency_key_key" ON "account_transfers"("idempotency_key") WHERE "idempotency_key" IS NOT NULL;
CREATE UNIQUE INDEX "account_transfers_reversal_idempotency_key_key" ON "account_transfers"("reversal_idempotency_key") WHERE "reversal_idempotency_key" IS NOT NULL;
CREATE INDEX "account_transfers_status_created_at_idx" ON "account_transfers"("status", "created_at");
CREATE INDEX "account_transfers_correlation_id_idx" ON "account_transfers"("correlation_id");

CREATE FUNCTION "sync_financial_account_money"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='INSERT' THEN
    IF NEW."opening_balance_cents"=0 AND NEW."opening_balance"<>0 THEN NEW."opening_balance_cents":=ROUND(NEW."opening_balance"::numeric*100)::integer; END IF;
    IF NEW."current_balance_cents"=0 AND NEW."current_balance"<>0 THEN NEW."current_balance_cents":=ROUND(NEW."current_balance"::numeric*100)::integer; END IF;
    IF NEW."credit_limit_cents"=0 AND NEW."credit_limit"<>0 THEN NEW."credit_limit_cents":=ROUND(NEW."credit_limit"::numeric*100)::integer; END IF;
  ELSE
    IF NEW."opening_balance" IS DISTINCT FROM OLD."opening_balance" AND NEW."opening_balance_cents"=OLD."opening_balance_cents" THEN NEW."opening_balance_cents":=ROUND(NEW."opening_balance"::numeric*100)::integer;
    ELSIF NEW."opening_balance_cents" IS DISTINCT FROM OLD."opening_balance_cents" AND NEW."opening_balance"=OLD."opening_balance" THEN NEW."opening_balance":=NEW."opening_balance_cents"/100.0; END IF;
    IF NEW."current_balance" IS DISTINCT FROM OLD."current_balance" AND NEW."current_balance_cents"=OLD."current_balance_cents" THEN NEW."current_balance_cents":=ROUND(NEW."current_balance"::numeric*100)::integer;
    ELSIF NEW."current_balance_cents" IS DISTINCT FROM OLD."current_balance_cents" AND NEW."current_balance"=OLD."current_balance" THEN NEW."current_balance":=NEW."current_balance_cents"/100.0; END IF;
    IF NEW."credit_limit" IS DISTINCT FROM OLD."credit_limit" AND NEW."credit_limit_cents"=OLD."credit_limit_cents" THEN NEW."credit_limit_cents":=ROUND(NEW."credit_limit"::numeric*100)::integer;
    ELSIF NEW."credit_limit_cents" IS DISTINCT FROM OLD."credit_limit_cents" AND NEW."credit_limit"=OLD."credit_limit" THEN NEW."credit_limit":=NEW."credit_limit_cents"/100.0; END IF;
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER "financial_accounts_money_sync" BEFORE INSERT OR UPDATE ON "financial_accounts"
FOR EACH ROW EXECUTE FUNCTION "sync_financial_account_money"();

CREATE FUNCTION "prepare_account_entry_append"() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE account_row "financial_accounts"%ROWTYPE; original "account_entries"%ROWTYPE;
BEGIN
  SELECT * INTO account_row FROM "financial_accounts" WHERE "id"=NEW."account_id" FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'financial account not found' USING ERRCODE='23503'; END IF;
  IF NEW."amount_cents"=0 THEN NEW."amount_cents":=ROUND(ABS(NEW."amount")::numeric*100)::integer; END IF;
  NEW."amount":=NEW."amount_cents"/100.0;
  NEW."balance_after_cents":=account_row."current_balance_cents" + CASE WHEN NEW."type"='credit' THEN NEW."amount_cents" ELSE -NEW."amount_cents" END;
  IF NEW."reversal_of_id" IS NOT NULL THEN
    SELECT * INTO original FROM "account_entries" WHERE "id"=NEW."reversal_of_id" FOR SHARE;
    IF NOT FOUND OR original."account_id"<>NEW."account_id" OR original."amount_cents"<>NEW."amount_cents" OR original."type"=NEW."type" OR original."reversal_of_id" IS NOT NULL THEN
      RAISE EXCEPTION 'invalid account entry reversal' USING ERRCODE='23514';
    END IF;
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER "account_entries_append_prepare" BEFORE INSERT ON "account_entries"
FOR EACH ROW EXECUTE FUNCTION "prepare_account_entry_append"();

CREATE FUNCTION "protect_account_entry_history"() RETURNS trigger
LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'account ledger is append-only' USING ERRCODE='42501'; END $$;
CREATE TRIGGER "account_entries_history_guard" BEFORE UPDATE OR DELETE ON "account_entries"
FOR EACH ROW EXECUTE FUNCTION "protect_account_entry_history"();

CREATE FUNCTION "sync_account_transfer_money"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW."amount_cents"=0 THEN NEW."amount_cents":=ROUND(ABS(NEW."amount")::numeric*100)::integer; END IF;
  NEW."amount":=NEW."amount_cents"/100.0;
  RETURN NEW;
END $$;
CREATE TRIGGER "account_transfers_money_sync" BEFORE INSERT OR UPDATE OF "amount","amount_cents" ON "account_transfers"
FOR EACH ROW EXECUTE FUNCTION "sync_account_transfer_money"();
