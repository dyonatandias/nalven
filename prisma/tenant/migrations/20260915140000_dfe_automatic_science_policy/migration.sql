ALTER TABLE "dfe_sync_cursors"
  ADD COLUMN "auto_science_enabled" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "auto_science_authorized_at" TIMESTAMP(3),
  ADD COLUMN "auto_science_authorized_by" TEXT;

ALTER TABLE "dfe_sync_cursors"
  ADD CONSTRAINT "dfe_sync_cursor_auto_science_scope_check" CHECK (
    NOT "auto_science_enabled" OR (
      "source" = 'sefaz_nfe'
      AND "environment" = 'production'
      AND "auto_science_authorized_at" IS NOT NULL
      AND length("auto_science_authorized_by") BETWEEN 3 AND 160
    )
  );

CREATE INDEX "dfe_sync_cursors_auto_science_enabled_idx"
  ON "dfe_sync_cursors"("auto_science_enabled", "branch_id")
  WHERE "auto_science_enabled";
