ALTER TABLE "tenant_user_profiles"
  ADD COLUMN "job_title" TEXT,
  ADD COLUMN "department" TEXT,
  ADD COLUMN "phone" TEXT,
  ADD COLUMN "access_expires_at" TIMESTAMP(3),
  ADD COLUMN "last_access_review_at" TIMESTAMP(3),
  ADD COLUMN "access_reviewed_by" TEXT;

CREATE INDEX "tenant_user_profiles_status_access_expires_at_idx"
  ON "tenant_user_profiles"("status", "access_expires_at");
