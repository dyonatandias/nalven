ALTER TABLE "billing_accounts" ADD COLUMN "license_secret" TEXT;
CREATE TABLE "billing_provision_jobs" (
  "id" TEXT PRIMARY KEY, "organization_id" TEXT NOT NULL, "payload" JSONB NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'pending', "attempts" INTEGER NOT NULL DEFAULT 0,
  "next_attempt_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP, "last_error" TEXT,
  "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP, "finished_at" TIMESTAMPTZ
);
CREATE INDEX "billing_provision_jobs_status_next_attempt_at_idx" ON "billing_provision_jobs"("status", "next_attempt_at");
