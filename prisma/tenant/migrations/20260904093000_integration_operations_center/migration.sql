ALTER TABLE "integration_credentials"
  ADD COLUMN "owner_label" TEXT,
  ADD COLUMN "expires_at" TIMESTAMP(3),
  ADD COLUMN "last_rotated_at" TIMESTAMP(3),
  ADD COLUMN "revoked_at" TIMESTAMP(3),
  ADD COLUMN "created_by" TEXT,
  ADD COLUMN "updated_by" TEXT;

ALTER TABLE "integration_routing"
  ADD COLUMN "revision" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "updated_by" TEXT;

ALTER TABLE "integration_settings"
  ADD COLUMN "revision" INTEGER NOT NULL DEFAULT 0;

CREATE INDEX "integration_credentials_revoked_at_expires_at_idx"
  ON "integration_credentials"("revoked_at", "expires_at");
