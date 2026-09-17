-- Link a completed local return to its replacement draft and eventual sale.
-- Refund state remains independent: this migration does not authorize or mark
-- any provider-side refund as completed.

ALTER TABLE "pos_returns"
  ADD COLUMN "exchange_status" TEXT,
  ADD COLUMN "exchange_held_sale_id" TEXT,
  ADD COLUMN "exchange_sale_id" INTEGER,
  ADD COLUMN "exchange_started_at" TIMESTAMP(3),
  ADD COLUMN "exchange_completed_at" TIMESTAMP(3),
  ADD COLUMN "exchange_cancelled_at" TIMESTAMP(3);

ALTER TABLE "pos_returns"
  ADD CONSTRAINT "pos_returns_exchange_held_sale_id_fkey"
    FOREIGN KEY ("exchange_held_sale_id") REFERENCES "pos_held_sales"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "pos_returns_exchange_sale_id_fkey"
    FOREIGN KEY ("exchange_sale_id") REFERENCES "sales"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "pos_returns_exchange_lifecycle_check"
    CHECK (
      ("exchange_status" IS NULL AND "exchange_held_sale_id" IS NULL AND "exchange_sale_id" IS NULL AND "exchange_started_at" IS NULL AND "exchange_completed_at" IS NULL AND "exchange_cancelled_at" IS NULL)
      OR ("exchange_status" = 'draft' AND "exchange_held_sale_id" IS NOT NULL AND "exchange_sale_id" IS NULL AND "exchange_started_at" IS NOT NULL AND "exchange_completed_at" IS NULL AND "exchange_cancelled_at" IS NULL)
      OR ("exchange_status" = 'completed' AND "exchange_held_sale_id" IS NOT NULL AND "exchange_sale_id" IS NOT NULL AND "exchange_started_at" IS NOT NULL AND "exchange_completed_at" IS NOT NULL AND "exchange_cancelled_at" IS NULL)
      OR ("exchange_status" = 'cancelled' AND "exchange_held_sale_id" IS NOT NULL AND "exchange_sale_id" IS NULL AND "exchange_started_at" IS NOT NULL AND "exchange_completed_at" IS NULL AND "exchange_cancelled_at" IS NOT NULL)
    ) NOT VALID;

CREATE UNIQUE INDEX "pos_returns_exchange_held_sale_id_key" ON "pos_returns"("exchange_held_sale_id");
CREATE UNIQUE INDEX "pos_returns_exchange_sale_id_key" ON "pos_returns"("exchange_sale_id");
CREATE INDEX "pos_returns_exchange_status_started_idx" ON "pos_returns"("exchange_status", "exchange_started_at");

ALTER TABLE "pos_returns" VALIDATE CONSTRAINT "pos_returns_exchange_lifecycle_check";
