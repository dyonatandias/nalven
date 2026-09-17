CREATE UNIQUE INDEX "pos_print_jobs_id_terminal_id_key"
  ON "pos_print_jobs"("id", "terminal_id");

CREATE TABLE "pos_print_acknowledgements" (
  "id" BIGSERIAL PRIMARY KEY,
  "terminal_id" TEXT NOT NULL,
  "job_id" TEXT NOT NULL,
  "claim_id" TEXT NOT NULL,
  "request_hash" TEXT NOT NULL,
  "state" TEXT NOT NULL,
  "result_status" TEXT NOT NULL,
  "attempt" INTEGER NOT NULL,
  "acknowledged_at" TIMESTAMP(3) NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT now(),
  CONSTRAINT "pos_print_ack_job_terminal_fkey"
    FOREIGN KEY ("job_id", "terminal_id")
    REFERENCES "pos_print_jobs"("id", "terminal_id")
    ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "pos_print_ack_claim_id_check"
    CHECK ("claim_id" ~* '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'),
  CONSTRAINT "pos_print_ack_request_hash_check"
    CHECK ("request_hash" ~ '^[0-9a-f]{64}$'),
  CONSTRAINT "pos_print_ack_state_result_check"
    CHECK (
      ("state" = 'printed' AND "result_status" = 'printed')
      OR
      ("state" = 'failed' AND "result_status" IN ('queued', 'failed'))
    ),
  CONSTRAINT "pos_print_ack_attempt_check"
    CHECK ("attempt" BETWEEN 1 AND 5)
);

CREATE UNIQUE INDEX "pos_print_acknowledgements_claim_id_key"
  ON "pos_print_acknowledgements"("claim_id");
CREATE UNIQUE INDEX "pos_print_ack_terminal_job_claim_key"
  ON "pos_print_acknowledgements"("terminal_id", "job_id", "claim_id");
CREATE INDEX "pos_print_ack_job_created_idx"
  ON "pos_print_acknowledgements"("job_id", "created_at");
CREATE INDEX "pos_print_ack_terminal_created_idx"
  ON "pos_print_acknowledgements"("terminal_id", "created_at");
