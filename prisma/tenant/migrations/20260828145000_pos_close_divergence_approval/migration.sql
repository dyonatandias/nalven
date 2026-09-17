ALTER TABLE "tenant_settings"
  ADD COLUMN "pos_close_tolerance_cents" INTEGER NOT NULL DEFAULT 0;

ALTER TABLE "tenant_settings"
  ADD CONSTRAINT "tenant_settings_pos_close_tolerance_check"
  CHECK ("pos_close_tolerance_cents" BETWEEN 0 AND 1000000000);

ALTER TABLE "cash_register_sessions"
  ADD COLUMN "absolute_difference_cents" INTEGER,
  ADD COLUMN "close_approval_id" TEXT;

ALTER TABLE "cash_register_sessions"
  ADD CONSTRAINT "cash_register_sessions_absolute_difference_check"
  CHECK (
    "absolute_difference_cents" IS NULL
    OR (
      "absolute_difference_cents" >= 0
      AND "absolute_difference_cents" >= abs(COALESCE("difference_cents", 0))
    )
  ),
  ADD CONSTRAINT "cash_register_sessions_close_approval_fkey"
  FOREIGN KEY ("close_approval_id") REFERENCES "pos_approvals"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE INDEX "cash_register_sessions_close_approval_idx"
  ON "cash_register_sessions"("close_approval_id");
