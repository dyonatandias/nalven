CREATE TABLE "pos_reconciliation_layouts" (
  "id" TEXT PRIMARY KEY,
  "branch_id" INTEGER NOT NULL REFERENCES "branches"("id") ON DELETE RESTRICT,
  "provider" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'active',
  "version" INTEGER NOT NULL DEFAULT 0,
  "delimiter" TEXT NOT NULL DEFAULT ',',
  "amount_mode" TEXT NOT NULL DEFAULT 'integer_cents',
  "decimal_separator" TEXT NOT NULL DEFAULT '.',
  "date_mode" TEXT NOT NULL DEFAULT 'iso8601',
  "column_mapping" JSONB NOT NULL,
  "kind_mapping" JSONB NOT NULL,
  "match_window_hours" INTEGER NOT NULL DEFAULT 24,
  "create_key" TEXT NOT NULL UNIQUE,
  "create_request_hash" TEXT NOT NULL,
  "created_by" TEXT NOT NULL,
  "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "pos_reconciliation_layouts_provider_check" CHECK ("provider" ~ '^[a-z0-9][a-z0-9._-]{1,79}$'),
  CONSTRAINT "pos_reconciliation_layouts_name_check" CHECK (length(btrim("name")) BETWEEN 2 AND 120),
  CONSTRAINT "pos_reconciliation_layouts_status_check" CHECK ("status" IN ('active', 'inactive')),
  CONSTRAINT "pos_reconciliation_layouts_version_check" CHECK ("version" >= 0),
  CONSTRAINT "pos_reconciliation_layouts_delimiter_check" CHECK ("delimiter" IN (',', ';', E'\t')),
  CONSTRAINT "pos_reconciliation_layouts_amount_mode_check" CHECK ("amount_mode" IN ('integer_cents', 'decimal')),
  CONSTRAINT "pos_reconciliation_layouts_decimal_separator_check" CHECK ("decimal_separator" IN ('.', ',')),
  CONSTRAINT "pos_reconciliation_layouts_date_mode_check" CHECK ("date_mode" IN ('iso8601', 'epoch_millis')),
  CONSTRAINT "pos_reconciliation_layouts_columns_check" CHECK (jsonb_typeof("column_mapping") = 'object'),
  CONSTRAINT "pos_reconciliation_layouts_kinds_check" CHECK (jsonb_typeof("kind_mapping") = 'object'),
  CONSTRAINT "pos_reconciliation_layouts_window_check" CHECK ("match_window_hours" BETWEEN 0 AND 168),
  CONSTRAINT "pos_reconciliation_layouts_create_key_check" CHECK (length("create_key") BETWEEN 16 AND 160),
  CONSTRAINT "pos_reconciliation_layouts_request_hash_check" CHECK ("create_request_hash" ~ '^[0-9a-f]{64}$'),
  UNIQUE ("branch_id", "provider", "name")
);
CREATE INDEX "pos_reconciliation_layouts_branch_provider_status_idx" ON "pos_reconciliation_layouts"("branch_id", "provider", "status");

CREATE TABLE "pos_reconciliation_batches" (
  "id" TEXT PRIMARY KEY,
  "branch_id" INTEGER NOT NULL REFERENCES "branches"("id") ON DELETE RESTRICT,
  "layout_id" TEXT NOT NULL REFERENCES "pos_reconciliation_layouts"("id") ON DELETE RESTRICT,
  "layout_version" INTEGER NOT NULL,
  "layout_snapshot" JSONB NOT NULL,
  "provider" TEXT NOT NULL,
  "digest" TEXT NOT NULL,
  "request_key" TEXT NOT NULL UNIQUE,
  "request_hash" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'pending',
  "version" INTEGER NOT NULL DEFAULT 0,
  "row_count" INTEGER NOT NULL,
  "matched_count" INTEGER NOT NULL DEFAULT 0,
  "issue_count" INTEGER NOT NULL DEFAULT 0,
  "production_blocking" BOOLEAN NOT NULL DEFAULT FALSE,
  "gross_cents" BIGINT NOT NULL DEFAULT 0,
  "fee_cents" BIGINT NOT NULL DEFAULT 0,
  "net_cents" BIGINT NOT NULL DEFAULT 0,
  "period_start" TIMESTAMPTZ NOT NULL,
  "period_end" TIMESTAMPTZ NOT NULL,
  "imported_by" TEXT NOT NULL,
  "last_processed_by" TEXT,
  "last_error_code" TEXT,
  "correlation_id" TEXT NOT NULL,
  "completed_at" TIMESTAMPTZ,
  "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "pos_reconciliation_batches_provider_check" CHECK ("provider" ~ '^[a-z0-9][a-z0-9._-]{1,79}$'),
  CONSTRAINT "pos_reconciliation_batches_digest_check" CHECK ("digest" ~ '^[0-9a-f]{64}$'),
  CONSTRAINT "pos_reconciliation_batches_request_key_check" CHECK (length("request_key") BETWEEN 16 AND 160),
  CONSTRAINT "pos_reconciliation_batches_request_hash_check" CHECK ("request_hash" ~ '^[0-9a-f]{64}$'),
  CONSTRAINT "pos_reconciliation_batches_status_check" CHECK ("status" IN ('pending', 'completed', 'failed')),
  CONSTRAINT "pos_reconciliation_batches_layout_check" CHECK ("layout_version" >= 0 AND jsonb_typeof("layout_snapshot") = 'object'),
  CONSTRAINT "pos_reconciliation_batches_version_check" CHECK ("version" >= 0),
  CONSTRAINT "pos_reconciliation_batches_counts_check" CHECK ("row_count" BETWEEN 1 AND 10000 AND "matched_count" >= 0 AND "issue_count" >= 0),
  CONSTRAINT "pos_reconciliation_batches_period_check" CHECK ("period_end" >= "period_start"),
  CONSTRAINT "pos_reconciliation_batches_error_check" CHECK ("last_error_code" IS NULL OR "last_error_code" ~ '^[A-Z0-9_]{2,60}$'),
  UNIQUE ("provider", "digest")
);
CREATE INDEX "pos_reconciliation_batches_branch_status_created_idx" ON "pos_reconciliation_batches"("branch_id", "status", "created_at");
CREATE INDEX "pos_reconciliation_batches_status_updated_idx" ON "pos_reconciliation_batches"("status", "updated_at");

CREATE TABLE "pos_reconciliation_lines" (
  "id" BIGSERIAL PRIMARY KEY,
  "batch_id" TEXT NOT NULL REFERENCES "pos_reconciliation_batches"("id") ON DELETE RESTRICT,
  "line_number" INTEGER NOT NULL,
  "settlement_id" TEXT NOT NULL,
  "transaction_id" TEXT NOT NULL,
  "reference_hash" TEXT NOT NULL,
  "kind" TEXT NOT NULL,
  "gross_cents" BIGINT NOT NULL,
  "fee_cents" BIGINT NOT NULL,
  "net_cents" BIGINT NOT NULL,
  "occurred_at" TIMESTAMPTZ NOT NULL,
  "settled_at" TIMESTAMPTZ NOT NULL,
  "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "pos_reconciliation_lines_number_check" CHECK ("line_number" BETWEEN 2 AND 10001),
  CONSTRAINT "pos_reconciliation_lines_reference_check" CHECK (length("settlement_id") BETWEEN 1 AND 160 AND length("transaction_id") BETWEEN 1 AND 160),
  CONSTRAINT "pos_reconciliation_lines_hash_check" CHECK ("reference_hash" ~ '^[0-9a-f]{64}$'),
  CONSTRAINT "pos_reconciliation_lines_kind_check" CHECK ("kind" IN ('payment', 'refund', 'chargeback')),
  CONSTRAINT "pos_reconciliation_lines_amount_check" CHECK ("gross_cents" > 0 AND "fee_cents" >= 0),
  CONSTRAINT "pos_reconciliation_lines_equation_check" CHECK (("kind" = 'payment' AND "net_cents" = "gross_cents" - "fee_cents") OR ("kind" IN ('refund', 'chargeback') AND "net_cents" = -("gross_cents" + "fee_cents"))),
  CONSTRAINT "pos_reconciliation_lines_period_check" CHECK ("settled_at" >= "occurred_at"),
  UNIQUE ("batch_id", "line_number")
);
CREATE INDEX "pos_reconciliation_lines_batch_transaction_idx" ON "pos_reconciliation_lines"("batch_id", "transaction_id");

CREATE TABLE "pos_reconciliation_runs" (
  "id" TEXT PRIMARY KEY,
  "batch_id" TEXT NOT NULL REFERENCES "pos_reconciliation_batches"("id") ON DELETE RESTRICT,
  "sequence" INTEGER NOT NULL,
  "input_version" INTEGER NOT NULL,
  "operation_key" TEXT NOT NULL UNIQUE,
  "request_hash" TEXT NOT NULL,
  "state" TEXT NOT NULL DEFAULT 'completed',
  "matched_count" INTEGER NOT NULL,
  "issue_count" INTEGER NOT NULL,
  "production_blocking" BOOLEAN NOT NULL,
  "gross_cents" BIGINT NOT NULL,
  "fee_cents" BIGINT NOT NULL,
  "net_cents" BIGINT NOT NULL,
  "processed_by" TEXT NOT NULL,
  "correlation_id" TEXT NOT NULL,
  "completed_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "pos_reconciliation_runs_sequence_check" CHECK ("sequence" > 0 AND "input_version" >= 0),
  CONSTRAINT "pos_reconciliation_runs_operation_key_check" CHECK (length("operation_key") BETWEEN 16 AND 160),
  CONSTRAINT "pos_reconciliation_runs_request_hash_check" CHECK ("request_hash" ~ '^[0-9a-f]{64}$'),
  CONSTRAINT "pos_reconciliation_runs_state_check" CHECK ("state" = 'completed'),
  CONSTRAINT "pos_reconciliation_runs_counts_check" CHECK ("matched_count" >= 0 AND "issue_count" >= 0),
  UNIQUE ("batch_id", "sequence")
);
CREATE INDEX "pos_reconciliation_runs_batch_completed_idx" ON "pos_reconciliation_runs"("batch_id", "completed_at");

CREATE TABLE "pos_reconciliation_issues" (
  "id" BIGSERIAL PRIMARY KEY,
  "run_id" TEXT NOT NULL REFERENCES "pos_reconciliation_runs"("id") ON DELETE RESTRICT,
  "line_id" BIGINT REFERENCES "pos_reconciliation_lines"("id") ON DELETE RESTRICT,
  "erp_payment_id" TEXT REFERENCES "pos_sale_payments"("id") ON DELETE SET NULL,
  "code" TEXT NOT NULL,
  "reference_hash" TEXT NOT NULL,
  "expected_cents" BIGINT,
  "actual_cents" BIGINT,
  "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "pos_reconciliation_issues_code_check" CHECK ("code" IN ('duplicate_settlement', 'duplicate_transaction', 'missing_provider_entry', 'unexpected_provider_entry', 'kind_mismatch', 'amount_mismatch', 'non_final_erp_state')),
  CONSTRAINT "pos_reconciliation_issues_hash_check" CHECK ("reference_hash" ~ '^[0-9a-f]{64}$')
);
CREATE INDEX "pos_reconciliation_issues_run_code_idx" ON "pos_reconciliation_issues"("run_id", "code");
CREATE INDEX "pos_reconciliation_issues_payment_idx" ON "pos_reconciliation_issues"("erp_payment_id");

CREATE FUNCTION "pos_reconciliation_immutable_record"() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'POS reconciliation evidence is immutable';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "pos_reconciliation_lines_immutable"
  BEFORE UPDATE OR DELETE ON "pos_reconciliation_lines"
  FOR EACH ROW EXECUTE FUNCTION "pos_reconciliation_immutable_record"();
CREATE TRIGGER "pos_reconciliation_runs_immutable"
  BEFORE UPDATE OR DELETE ON "pos_reconciliation_runs"
  FOR EACH ROW EXECUTE FUNCTION "pos_reconciliation_immutable_record"();
CREATE TRIGGER "pos_reconciliation_issues_immutable"
  BEFORE UPDATE OR DELETE ON "pos_reconciliation_issues"
  FOR EACH ROW EXECUTE FUNCTION "pos_reconciliation_immutable_record"();

CREATE FUNCTION "pos_reconciliation_layout_guard"() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'POS reconciliation layouts cannot be deleted'; END IF;
  IF NEW."branch_id" <> OLD."branch_id"
     OR NEW."provider" <> OLD."provider"
     OR NEW."create_key" <> OLD."create_key"
     OR NEW."create_request_hash" <> OLD."create_request_hash"
     OR NEW."created_by" <> OLD."created_by"
     OR NEW."created_at" <> OLD."created_at"
     OR NEW."version" <> OLD."version" + 1 THEN
    RAISE EXCEPTION 'Invalid POS reconciliation layout mutation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER "pos_reconciliation_layout_guard_trigger"
  BEFORE UPDATE OR DELETE ON "pos_reconciliation_layouts"
  FOR EACH ROW EXECUTE FUNCTION "pos_reconciliation_layout_guard"();

CREATE FUNCTION "pos_reconciliation_batch_guard"() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'POS reconciliation batches cannot be deleted'; END IF;
  IF NEW."branch_id" <> OLD."branch_id"
     OR NEW."layout_id" <> OLD."layout_id"
     OR NEW."layout_version" <> OLD."layout_version"
     OR NEW."layout_snapshot" <> OLD."layout_snapshot"
     OR NEW."provider" <> OLD."provider"
     OR NEW."digest" <> OLD."digest"
     OR NEW."request_key" <> OLD."request_key"
     OR NEW."request_hash" <> OLD."request_hash"
     OR NEW."row_count" <> OLD."row_count"
     OR NEW."period_start" <> OLD."period_start"
     OR NEW."period_end" <> OLD."period_end"
     OR NEW."imported_by" <> OLD."imported_by"
     OR NEW."correlation_id" <> OLD."correlation_id"
     OR NEW."created_at" <> OLD."created_at" THEN
    RAISE EXCEPTION 'Invalid POS reconciliation batch mutation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER "pos_reconciliation_batch_guard_trigger"
  BEFORE UPDATE OR DELETE ON "pos_reconciliation_batches"
  FOR EACH ROW EXECUTE FUNCTION "pos_reconciliation_batch_guard"();
