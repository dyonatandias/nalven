ALTER TABLE "pos_inventory_lots"
  ADD COLUMN "bucket_key" TEXT NOT NULL DEFAULT 'sellable';

ALTER TABLE "pos_inventory_lots"
  ADD CONSTRAINT "pos_inventory_lots_bucket_key_check"
  CHECK ("bucket_key" IN ('sellable', 'quarantine'));

DROP INDEX "pos_inventory_lots_lot_identity_key";

CREATE UNIQUE INDEX "pos_inventory_lots_lot_bucket_identity_key"
  ON "pos_inventory_lots"("warehouse_id", "product_id", "variation_id", "normalized_lot_code", "bucket_key") NULLS NOT DISTINCT
  WHERE "normalized_serial_number" IS NULL;

CREATE INDEX "pos_inventory_lots_warehouse_product_variation_lot_bucket_idx"
  ON "pos_inventory_lots"("warehouse_id", "product_id", "variation_id", "normalized_lot_code", "bucket_key");

ALTER TABLE "pos_inventory_lots"
  ADD CONSTRAINT "pos_inventory_lots_bucket_status_check"
  CHECK (
    ("bucket_key" = 'sellable')
    OR ("bucket_key" = 'quarantine' AND "status" = 'quarantine' AND "normalized_serial_number" IS NULL)
  );
