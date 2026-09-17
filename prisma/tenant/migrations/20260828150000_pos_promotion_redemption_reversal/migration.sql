ALTER TABLE "pos_promotion_redemptions"
  ADD COLUMN "reversed_at" TIMESTAMP(3),
  ADD COLUMN "reversed_by" TEXT,
  ADD COLUMN "reversal_reason" TEXT,
  ADD CONSTRAINT "pos_promotion_redemptions_reversal_coherence_check" CHECK (
    ("reversed_at" IS NULL AND "reversed_by" IS NULL AND "reversal_reason" IS NULL)
    OR
    ("reversed_at" IS NOT NULL AND "reversed_by" IS NOT NULL AND char_length("reversed_by") BETWEEN 1 AND 160 AND "reversal_reason" IS NOT NULL AND char_length("reversal_reason") BETWEEN 1 AND 520)
  );

ALTER TABLE "pos_coupons"
  ADD CONSTRAINT "pos_coupons_used_count_nonnegative_check" CHECK ("used_count" >= 0);

CREATE INDEX "pos_promotion_redemptions_promotion_id_reversed_at_idx"
  ON "pos_promotion_redemptions"("promotion_id", "reversed_at");
CREATE INDEX "pos_promotion_redemptions_customer_id_promotion_id_reversed_at_idx"
  ON "pos_promotion_redemptions"("customer_id", "promotion_id", "reversed_at");
CREATE INDEX "pos_promotion_redemptions_coupon_id_reversed_at_idx"
  ON "pos_promotion_redemptions"("coupon_id", "reversed_at");
