ALTER TABLE "inventory_counts"
  ADD COLUMN "blind" BOOLEAN NOT NULL DEFAULT TRUE;

WITH duplicate_drafts AS (
  SELECT "id", row_number() OVER (PARTITION BY "warehouse_id" ORDER BY "created_at", "id") AS position
  FROM "inventory_counts"
  WHERE "status" = 'draft'
)
UPDATE "inventory_counts"
SET "status" = 'cancelled'
WHERE "id" IN (SELECT "id" FROM duplicate_drafts WHERE position > 1);

CREATE UNIQUE INDEX "inventory_counts_one_draft_per_warehouse_key"
  ON "inventory_counts"("warehouse_id")
  WHERE "status" = 'draft';

ALTER TABLE "purchase_quotation_offers"
  ADD COLUMN "subtotal" DOUBLE PRECISION NOT NULL DEFAULT 0,
  ADD COLUMN "freight" DOUBLE PRECISION NOT NULL DEFAULT 0,
  ADD COLUMN "discount" DOUBLE PRECISION NOT NULL DEFAULT 0;

UPDATE "purchase_quotation_offers" SET "subtotal" = "total";

ALTER TABLE "purchase_quotations"
  ADD COLUMN "purchase_order_id" INTEGER;

ALTER TABLE "purchase_quotations"
  ADD CONSTRAINT "purchase_quotations_purchase_order_id_fkey"
  FOREIGN KEY ("purchase_order_id") REFERENCES "purchase_orders"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

CREATE UNIQUE INDEX "purchase_quotations_purchase_order_id_key"
  ON "purchase_quotations"("purchase_order_id");

CREATE INDEX "production_orders_bom_id_status_created_at_idx"
  ON "production_orders"("bom_id", "status", "created_at");
