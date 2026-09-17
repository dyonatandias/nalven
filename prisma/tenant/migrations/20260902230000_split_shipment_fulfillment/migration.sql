ALTER TABLE "shipments"
  DROP CONSTRAINT IF EXISTS "shipments_sales_order_id_key";
ALTER TABLE "shipments"
  DROP CONSTRAINT IF EXISTS "shipments_channel_order_id_key";

DROP INDEX IF EXISTS "shipments_sales_order_id_key";
DROP INDEX IF EXISTS "shipments_channel_order_id_key";

CREATE INDEX "shipments_sales_order_status_idx"
  ON "shipments"("sales_order_id", "status");
CREATE INDEX "shipments_channel_order_status_idx"
  ON "shipments"("channel_order_id", "status");
