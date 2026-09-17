ALTER TABLE "bank_statement_imports"
  ADD COLUMN "format" TEXT NOT NULL DEFAULT 'csv',
  ADD COLUMN "file_size" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "imported_row_count" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "duplicate_row_count" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "total_credit_cents" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "total_debit_cents" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "period_start" DATE,
  ADD COLUMN "period_end" DATE,
  ADD COLUMN "status" TEXT NOT NULL DEFAULT 'completed',
  ADD COLUMN "correlation_id" TEXT;

UPDATE "bank_statement_imports" statement_import
SET "format" = CASE WHEN lower(statement_import."file_name") LIKE '%.ofx' THEN 'ofx' ELSE 'csv' END,
    "imported_row_count" = statement_import."row_count",
    "total_credit_cents" = COALESCE((SELECT SUM(GREATEST(ROUND(transaction."amount"::numeric * 100)::integer, 0)) FROM "bank_transactions" transaction WHERE transaction."import_id"=statement_import."id"), 0),
    "total_debit_cents" = COALESCE((SELECT SUM(GREATEST(-ROUND(transaction."amount"::numeric * 100)::integer, 0)) FROM "bank_transactions" transaction WHERE transaction."import_id"=statement_import."id"), 0),
    "period_start" = (SELECT MIN(transaction."occurred_at") FROM "bank_transactions" transaction WHERE transaction."import_id"=statement_import."id"),
    "period_end" = (SELECT MAX(transaction."occurred_at") FROM "bank_transactions" transaction WHERE transaction."import_id"=statement_import."id");

ALTER TABLE "bank_statement_imports"
  ADD CONSTRAINT "bank_statement_imports_format_check" CHECK ("format" IN ('csv','ofx')),
  ADD CONSTRAINT "bank_statement_imports_status_check" CHECK ("status" IN ('completed')),
  ADD CONSTRAINT "bank_statement_imports_counts_check" CHECK (
    "file_size">=0 AND "row_count">=0 AND "imported_row_count">=0 AND "duplicate_row_count">=0 AND
    "imported_row_count"+"duplicate_row_count"="row_count" AND "total_credit_cents">=0 AND "total_debit_cents">=0
  ),
  ADD CONSTRAINT "bank_statement_imports_period_check" CHECK (
    ("period_start" IS NULL AND "period_end" IS NULL) OR
    ("period_start" IS NOT NULL AND "period_end" IS NOT NULL AND "period_start"<="period_end")
  );

CREATE INDEX "bank_statement_imports_status_imported_at_idx" ON "bank_statement_imports"("status","imported_at");

ALTER TABLE "bank_transactions"
  ADD COLUMN "amount_cents" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "bank_reference" TEXT,
  ADD COLUMN "document_number" TEXT,
  ADD COLUMN "category" TEXT,
  ADD COLUMN "resolution_type" TEXT,
  ADD COLUMN "resolution_reason" TEXT,
  ADD COLUMN "reconciliation_sequence" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "version" INTEGER NOT NULL DEFAULT 1,
  ADD COLUMN "correlation_id" TEXT;

UPDATE "bank_transactions"
SET "amount_cents"=ROUND("amount"::numeric * 100)::integer,
    "resolution_type"=CASE
      WHEN "status"='reconciled' AND "matched_title_id" IS NOT NULL THEN 'title'
      WHEN "status"='reconciled' THEN 'manual'
      WHEN "status"='ignored' THEN 'ignored'
      ELSE NULL END,
    "resolution_reason"=CASE
      WHEN "status"='reconciled' AND "matched_title_id" IS NULL THEN 'Conciliação registrada antes da trilha detalhada.'
      WHEN "status"='ignored' THEN 'Movimento ignorado antes da exigência de justificativa.'
      ELSE NULL END,
    "category"=CASE WHEN "status"='reconciled' AND "matched_title_id" IS NULL THEN 'Não classificado' ELSE NULL END,
    "reconciliation_sequence"=CASE WHEN "status"='reconciled' THEN 1 ELSE 0 END;

ALTER TABLE "bank_transactions"
  DROP CONSTRAINT "bank_transactions_import_id_fkey",
  DROP CONSTRAINT "bank_transactions_account_id_fkey",
  ADD CONSTRAINT "bank_transactions_import_id_fkey" FOREIGN KEY ("import_id") REFERENCES "bank_statement_imports"("id") ON DELETE RESTRICT,
  ADD CONSTRAINT "bank_transactions_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "financial_accounts"("id") ON DELETE RESTRICT,
  ADD CONSTRAINT "bank_transactions_amount_check" CHECK (
    "amount_cents"<>0 AND "amount" NOT IN ('NaN','Infinity','-Infinity') AND "amount_cents"=ROUND("amount"::numeric * 100)::integer
  ),
  ADD CONSTRAINT "bank_transactions_status_check" CHECK ("status" IN ('pending','reconciled','ignored')),
  ADD CONSTRAINT "bank_transactions_resolution_type_check" CHECK ("resolution_type" IS NULL OR "resolution_type" IN ('title','split','manual','automatic','ignored')),
  ADD CONSTRAINT "bank_transactions_version_check" CHECK ("version">0 AND "reconciliation_sequence">=0),
  ADD CONSTRAINT "bank_transactions_resolution_check" CHECK (
    ("status"='pending' AND "resolution_type" IS NULL AND "resolution_reason" IS NULL AND "reconciled_by" IS NULL AND "reconciled_at" IS NULL AND "matched_title_id" IS NULL) OR
    ("status"='reconciled' AND "resolution_type" IN ('title','split','manual','automatic') AND "reconciled_by" IS NOT NULL AND "reconciled_at" IS NOT NULL AND
      ("resolution_type" NOT IN ('manual') OR ("category" IS NOT NULL AND length(btrim("category"))>=2 AND "resolution_reason" IS NOT NULL))) OR
    ("status"='ignored' AND "resolution_type"='ignored' AND "resolution_reason" IS NOT NULL AND length(btrim("resolution_reason"))>=8 AND "reconciled_by" IS NOT NULL AND "reconciled_at" IS NOT NULL AND "matched_title_id" IS NULL)
  );

CREATE INDEX "bank_transactions_account_id_status_occurred_at_idx" ON "bank_transactions"("account_id","status","occurred_at");
CREATE INDEX "bank_transactions_correlation_id_idx" ON "bank_transactions"("correlation_id");

CREATE TABLE "bank_reconciliation_allocations" (
  "id" SERIAL PRIMARY KEY,
  "transaction_id" INTEGER NOT NULL REFERENCES "bank_transactions"("id") ON DELETE RESTRICT,
  "title_id" INTEGER NOT NULL REFERENCES "financial_titles"("id") ON DELETE RESTRICT,
  "settlement_id" INTEGER NOT NULL UNIQUE REFERENCES "financial_settlements"("id") ON DELETE RESTRICT,
  "sequence" INTEGER NOT NULL,
  "amount_cents" INTEGER NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'posted',
  "created_by" TEXT NOT NULL,
  "created_at" TIMESTAMPTZ NOT NULL DEFAULT now(),
  "reversed_by" TEXT,
  "reversed_at" TIMESTAMPTZ,
  "reversal_reason" TEXT,
  CONSTRAINT "bank_reconciliation_allocations_transaction_title_sequence_key" UNIQUE ("transaction_id","title_id","sequence"),
  CONSTRAINT "bank_reconciliation_allocations_values_check" CHECK ("sequence">0 AND "amount_cents">0),
  CONSTRAINT "bank_reconciliation_allocations_status_check" CHECK (
    ("status"='posted' AND "reversed_by" IS NULL AND "reversed_at" IS NULL AND "reversal_reason" IS NULL) OR
    ("status"='reversed' AND "reversed_by" IS NOT NULL AND "reversed_at" IS NOT NULL AND "reversal_reason" IS NOT NULL)
  )
);
CREATE INDEX "bank_reconciliation_allocations_title_id_status_idx" ON "bank_reconciliation_allocations"("title_id","status");
CREATE INDEX "bank_reconciliation_allocations_transaction_id_sequence_idx" ON "bank_reconciliation_allocations"("transaction_id","sequence");

CREATE TABLE "bank_reconciliation_operations" (
  "id" SERIAL PRIMARY KEY,
  "transaction_id" INTEGER NOT NULL REFERENCES "bank_transactions"("id") ON DELETE RESTRICT,
  "action" TEXT NOT NULL,
  "idempotency_key" TEXT NOT NULL UNIQUE,
  "request_hash" TEXT NOT NULL,
  "sequence" INTEGER NOT NULL,
  "actor_id" TEXT NOT NULL,
  "correlation_id" TEXT NOT NULL,
  "created_at" TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT "bank_reconciliation_operations_action_check" CHECK ("action" IN ('reconcile','ignore','reopen')),
  CONSTRAINT "bank_reconciliation_operations_values_check" CHECK ("sequence">=0 AND "request_hash" ~ '^[0-9a-f]{64}$' AND length("idempotency_key") BETWEEN 8 AND 120)
);
CREATE INDEX "bank_reconciliation_operations_transaction_id_created_at_idx" ON "bank_reconciliation_operations"("transaction_id","created_at");
CREATE INDEX "bank_reconciliation_operations_actor_id_created_at_idx" ON "bank_reconciliation_operations"("actor_id","created_at");

CREATE FUNCTION "sync_bank_transaction_amount"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='INSERT' THEN
    IF NEW."amount_cents"=0 AND NEW."amount"<>0 THEN NEW."amount_cents":=ROUND(NEW."amount"::numeric*100)::integer; END IF;
    NEW."amount":=NEW."amount_cents"/100.0;
  ELSE
    IF NEW."amount" IS DISTINCT FROM OLD."amount" AND NEW."amount_cents"=OLD."amount_cents" THEN NEW."amount_cents":=ROUND(NEW."amount"::numeric*100)::integer;
    ELSIF NEW."amount_cents" IS DISTINCT FROM OLD."amount_cents" AND NEW."amount"=OLD."amount" THEN NEW."amount":=NEW."amount_cents"/100.0; END IF;
  END IF;
  -- Keep writes from the previous application release valid during a rolling cutover.
  IF NEW."status"='pending' THEN
    NEW."resolution_type":=NULL; NEW."resolution_reason":=NULL; NEW."category":=NULL;
  ELSIF NEW."status"='reconciled' AND NEW."resolution_type" IS NULL THEN
    NEW."resolution_type":=CASE WHEN NEW."matched_title_id" IS NULL THEN 'manual' ELSE 'title' END;
    NEW."resolution_reason":=COALESCE(NEW."resolution_reason", 'Conciliação registrada durante a atualização do sistema.');
    NEW."category":=CASE WHEN NEW."matched_title_id" IS NULL THEN COALESCE(NEW."category", 'Não classificado') ELSE NEW."category" END;
    NEW."reconciliation_sequence":=GREATEST(NEW."reconciliation_sequence", 1);
  ELSIF NEW."status"='ignored' AND NEW."resolution_type" IS NULL THEN
    NEW."resolution_type":='ignored';
    NEW."resolution_reason":=COALESCE(NEW."resolution_reason", 'Movimento ignorado durante a atualização do sistema.');
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER "bank_transactions_amount_sync" BEFORE INSERT OR UPDATE ON "bank_transactions"
FOR EACH ROW EXECUTE FUNCTION "sync_bank_transaction_amount"();

CREATE FUNCTION "sync_bank_statement_import_compat"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  -- The previous release only sends row_count. Preserve availability until the
  -- immutable release switch has completed.
  IF NEW."imported_row_count"+NEW."duplicate_row_count"<>NEW."row_count" THEN
    NEW."imported_row_count":=NEW."row_count";
    NEW."duplicate_row_count":=0;
  END IF;
  IF lower(NEW."file_name") LIKE '%.ofx' THEN NEW."format":='ofx'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER "bank_statement_imports_compat_sync" BEFORE INSERT ON "bank_statement_imports"
FOR EACH ROW EXECUTE FUNCTION "sync_bank_statement_import_compat"();

CREATE FUNCTION "protect_bank_statement_history"() RETURNS trigger
LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'bank statement history is append-only' USING ERRCODE='42501'; END $$;
CREATE TRIGGER "bank_statement_imports_history_guard" BEFORE UPDATE OR DELETE ON "bank_statement_imports"
FOR EACH ROW EXECUTE FUNCTION "protect_bank_statement_history"();

CREATE FUNCTION "protect_bank_transaction_source"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='DELETE' OR NEW."import_id" IS DISTINCT FROM OLD."import_id" OR NEW."account_id" IS DISTINCT FROM OLD."account_id" OR
    NEW."external_id" IS DISTINCT FROM OLD."external_id" OR NEW."occurred_at" IS DISTINCT FROM OLD."occurred_at" OR
    NEW."description" IS DISTINCT FROM OLD."description" OR NEW."amount_cents" IS DISTINCT FROM OLD."amount_cents" THEN
    RAISE EXCEPTION 'bank transaction source is immutable' USING ERRCODE='42501';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER "bank_transactions_source_guard" BEFORE UPDATE OR DELETE ON "bank_transactions"
FOR EACH ROW EXECUTE FUNCTION "protect_bank_transaction_source"();

CREATE FUNCTION "protect_bank_reconciliation_allocation_source"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='DELETE' OR NEW."transaction_id" IS DISTINCT FROM OLD."transaction_id" OR
    NEW."title_id" IS DISTINCT FROM OLD."title_id" OR NEW."settlement_id" IS DISTINCT FROM OLD."settlement_id" OR
    NEW."sequence" IS DISTINCT FROM OLD."sequence" OR NEW."amount_cents" IS DISTINCT FROM OLD."amount_cents" OR
    NEW."created_by" IS DISTINCT FROM OLD."created_by" OR NEW."created_at" IS DISTINCT FROM OLD."created_at" THEN
    RAISE EXCEPTION 'bank reconciliation allocation source is immutable' USING ERRCODE='42501';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER "bank_reconciliation_allocations_source_guard" BEFORE UPDATE OR DELETE ON "bank_reconciliation_allocations"
FOR EACH ROW EXECUTE FUNCTION "protect_bank_reconciliation_allocation_source"();

CREATE FUNCTION "protect_bank_reconciliation_operation"() RETURNS trigger
LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'bank reconciliation operation is append-only' USING ERRCODE='42501'; END $$;
CREATE TRIGGER "bank_reconciliation_operations_history_guard" BEFORE UPDATE OR DELETE ON "bank_reconciliation_operations"
FOR EACH ROW EXECUTE FUNCTION "protect_bank_reconciliation_operation"();
