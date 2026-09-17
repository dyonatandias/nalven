ALTER TABLE "cash_register_sessions"
  ADD COLUMN "business_date" DATE,
  ADD COLUMN "opening_notes" TEXT,
  ADD COLUMN "opening_count" JSONB,
  ADD COLUMN "opened_by_user_id" TEXT,
  ADD COLUMN "terminal_id" TEXT;

UPDATE "cash_register_sessions"
   SET "business_date" = "opened_at"::date
 WHERE "business_date" IS NULL;

ALTER TABLE "cash_register_sessions"
  ALTER COLUMN "business_date" SET NOT NULL,
  ALTER COLUMN "business_date" SET DEFAULT CURRENT_DATE;

ALTER TABLE "cash_register_sessions"
  ADD CONSTRAINT "cash_register_sessions_terminal_id_fkey"
  FOREIGN KEY ("terminal_id") REFERENCES "pos_terminals"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE INDEX "cash_register_sessions_terminal_id_opened_at_idx"
  ON "cash_register_sessions"("terminal_id", "opened_at");
