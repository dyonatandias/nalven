ALTER TABLE "billing_accounts"
  ADD COLUMN "remote_status" TEXT NOT NULL DEFAULT 'pending',
  ADD COLUMN "last_checked_at" TIMESTAMPTZ,
  ADD COLUMN "provisioned_at" TIMESTAMPTZ;

ALTER TABLE "billing_provision_jobs"
  ADD COLUMN "error_code" TEXT,
  ADD COLUMN "request_id" TEXT,
  ADD COLUMN "locked_at" TIMESTAMPTZ,
  ADD COLUMN "last_attempt_at" TIMESTAMPTZ,
  ADD COLUMN "updated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP;

CREATE INDEX "billing_provision_jobs_organization_id_created_at_idx"
  ON "billing_provision_jobs"("organization_id", "created_at");

UPDATE "billing_accounts" account
SET "remote_status" = CASE
  WHEN account."last_synced_at" IS NOT NULL THEN 'linked'
  ELSE 'pending'
END;

UPDATE "organizations"
SET "status" = 'trial', "trial_ends_at" = '2026-09-09', "updated_at" = CURRENT_TIMESTAMP
WHERE "id" = 'org-demo' AND "trial_ends_at" IS NULL;
