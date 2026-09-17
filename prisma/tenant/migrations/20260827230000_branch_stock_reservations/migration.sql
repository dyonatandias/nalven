ALTER TABLE "warehouse_balances"
  ADD COLUMN "reserved_quantity" DOUBLE PRECISION NOT NULL DEFAULT 0;

CREATE TABLE "stock_reservations" (
  "id" SERIAL NOT NULL,
  "sales_order_id" INTEGER NOT NULL,
  "order_item_id" INTEGER NOT NULL,
  "branch_id" INTEGER NOT NULL,
  "warehouse_id" INTEGER NOT NULL,
  "product_id" INTEGER NOT NULL,
  "quantity" DOUBLE PRECISION NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'active',
  "reserved_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "released_at" TIMESTAMP(3),
  "consumed_at" TIMESTAMP(3),
  CONSTRAINT "stock_reservations_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "stock_reservations_order_item_id_warehouse_id_key"
  ON "stock_reservations"("order_item_id", "warehouse_id");
CREATE INDEX "stock_reservations_sales_order_id_status_idx"
  ON "stock_reservations"("sales_order_id", "status");
CREATE INDEX "stock_reservations_warehouse_id_product_id_status_idx"
  ON "stock_reservations"("warehouse_id", "product_id", "status");
CREATE INDEX "stock_reservations_branch_id_status_idx"
  ON "stock_reservations"("branch_id", "status");

ALTER TABLE "stock_reservations"
  ADD CONSTRAINT "stock_reservations_sales_order_id_fkey"
  FOREIGN KEY ("sales_order_id") REFERENCES "sales_orders"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "stock_reservations"
  ADD CONSTRAINT "stock_reservations_order_item_id_fkey"
  FOREIGN KEY ("order_item_id") REFERENCES "sales_order_items"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "stock_reservations"
  ADD CONSTRAINT "stock_reservations_branch_id_fkey"
  FOREIGN KEY ("branch_id") REFERENCES "branches"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "stock_reservations"
  ADD CONSTRAINT "stock_reservations_warehouse_id_fkey"
  FOREIGN KEY ("warehouse_id") REFERENCES "warehouses"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "stock_reservations"
  ADD CONSTRAINT "stock_reservations_product_id_fkey"
  FOREIGN KEY ("product_id") REFERENCES "products"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "stock_reservations"
  ADD CONSTRAINT "stock_reservations_quantity_check" CHECK ("quantity" > 0),
  ADD CONSTRAINT "stock_reservations_status_check" CHECK ("status" IN ('active', 'released', 'consumed'));
ALTER TABLE "warehouse_balances"
  ADD CONSTRAINT "warehouse_balances_reserved_quantity_check" CHECK ("reserved_quantity" >= 0);
