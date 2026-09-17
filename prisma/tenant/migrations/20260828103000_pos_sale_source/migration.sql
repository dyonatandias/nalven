ALTER TABLE "sales"
  ADD COLUMN "source_type" TEXT,
  ADD COLUMN "source_id" TEXT;

ALTER TABLE "sales"
  ADD CONSTRAINT "sales_source_pair_check"
  CHECK (("source_type" IS NULL AND "source_id" IS NULL) OR (NULLIF(BTRIM("source_type"), '') IS NOT NULL AND NULLIF(BTRIM("source_id"), '') IS NOT NULL));

CREATE UNIQUE INDEX "sales_source_type_source_id_key" ON "sales"("source_type", "source_id");
