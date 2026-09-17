ALTER TABLE "pos_print_jobs"
  ADD COLUMN "idempotency_key" TEXT,
  ADD COLUMN "request_hash" TEXT,
  ADD COLUMN "requested_by_id" TEXT;

ALTER TABLE "pos_print_jobs"
  ADD CONSTRAINT "pos_print_jobs_idempotency_key_check"
    CHECK ("idempotency_key" IS NULL OR (char_length("idempotency_key") BETWEEN 16 AND 160 AND "idempotency_key" ~ '^[A-Za-z0-9._:-]+$')),
  ADD CONSTRAINT "pos_print_jobs_request_hash_check"
    CHECK ("request_hash" IS NULL OR "request_hash" ~ '^[0-9a-f]{64}$');

CREATE UNIQUE INDEX "pos_print_jobs_idempotency_key_key"
  ON "pos_print_jobs"("idempotency_key");

CREATE UNIQUE INDEX "pos_print_jobs_one_original_receipt_idx"
  ON "pos_print_jobs"("reference_type", "reference_id", "type")
  WHERE "type" = 'receipt.original';
