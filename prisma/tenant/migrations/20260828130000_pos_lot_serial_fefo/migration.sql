CREATE TABLE "pos_inventory_lots" (
  "id" TEXT NOT NULL,
  "warehouse_id" INTEGER NOT NULL,
  "product_id" INTEGER NOT NULL,
  "variation_id" INTEGER,
  "lot_code" TEXT,
  "normalized_lot_code" TEXT,
  "serial_number" TEXT,
  "normalized_serial_number" TEXT,
  "manufactured_on" DATE,
  "expires_on" DATE,
  "received_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "status" TEXT NOT NULL DEFAULT 'available',
  "quantity_micros" BIGINT NOT NULL,
  "reserved_micros" BIGINT NOT NULL DEFAULT 0,
  "metadata" JSONB,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "pos_inventory_lots_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "pos_inventory_lots_identity_check" CHECK (
    ("lot_code" IS NULL) = ("normalized_lot_code" IS NULL)
    AND ("serial_number" IS NULL) = ("normalized_serial_number" IS NULL)
    AND ("normalized_lot_code" IS NOT NULL OR "normalized_serial_number" IS NOT NULL)
    AND ("normalized_lot_code" IS NULL OR char_length("normalized_lot_code") BETWEEN 1 AND 160)
    AND ("normalized_serial_number" IS NULL OR char_length("normalized_serial_number") BETWEEN 1 AND 200)
  ),
  CONSTRAINT "pos_inventory_lots_status_check" CHECK ("status" IN ('available', 'quarantine', 'expired', 'depleted', 'blocked')),
  CONSTRAINT "pos_inventory_lots_quantity_check" CHECK (
    "quantity_micros" BETWEEN 0 AND 9007199254740991
    AND "reserved_micros" BETWEEN 0 AND "quantity_micros"
    AND ("normalized_serial_number" IS NULL OR (
      "quantity_micros" IN (0, 1000000)
      AND "reserved_micros" IN (0, 1000000)
    ))
  ),
  CONSTRAINT "pos_inventory_lots_dates_check" CHECK ("manufactured_on" IS NULL OR "expires_on" IS NULL OR "manufactured_on" <= "expires_on")
);

CREATE TABLE "pos_inventory_lot_movements" (
  "id" BIGSERIAL NOT NULL,
  "lot_id" TEXT NOT NULL,
  "sale_item_id" INTEGER,
  "return_item_id" INTEGER,
  "type" TEXT NOT NULL,
  "quantity_micros" BIGINT NOT NULL,
  "balance_before_micros" BIGINT NOT NULL,
  "balance_after_micros" BIGINT NOT NULL,
  "reference_type" TEXT,
  "reference_id" TEXT,
  "idempotency_key" TEXT,
  "actor" TEXT NOT NULL,
  "metadata" JSONB,
  "occurred_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "pos_inventory_lot_movements_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "pos_inventory_lot_movements_type_check" CHECK ("type" IN ('receipt', 'sale', 'return', 'transfer_in', 'transfer_out', 'adjustment', 'discard', 'status_change')),
  CONSTRAINT "pos_inventory_lot_movements_amount_check" CHECK (
    "balance_before_micros" BETWEEN 0 AND 9007199254740991
    AND "balance_after_micros" BETWEEN 0 AND 9007199254740991
    AND "balance_after_micros" = "balance_before_micros" + "quantity_micros"
    AND CASE
      WHEN "type" IN ('receipt', 'return', 'transfer_in') THEN "quantity_micros" > 0
      WHEN "type" IN ('sale', 'transfer_out', 'discard') THEN "quantity_micros" < 0
      WHEN "type" = 'adjustment' THEN "quantity_micros" <> 0
      ELSE "quantity_micros" = 0
    END
  ),
  CONSTRAINT "pos_inventory_lot_movements_reference_check" CHECK (
    ("sale_item_id" IS NULL OR "return_item_id" IS NULL)
    AND ("reference_type" IS NULL) = ("reference_id" IS NULL)
  )
);

CREATE INDEX "pos_inventory_lots_warehouse_id_product_id_variation_id_status_expires_on_idx"
  ON "pos_inventory_lots"("warehouse_id", "product_id", "variation_id", "status", "expires_on");
CREATE INDEX "pos_inventory_lots_product_id_normalized_lot_code_idx"
  ON "pos_inventory_lots"("product_id", "normalized_lot_code");
CREATE INDEX "pos_inventory_lots_status_expires_on_idx"
  ON "pos_inventory_lots"("status", "expires_on");
CREATE UNIQUE INDEX "pos_inventory_lots_lot_identity_key"
  ON "pos_inventory_lots"("warehouse_id", "product_id", "variation_id", "normalized_lot_code") NULLS NOT DISTINCT
  WHERE "normalized_serial_number" IS NULL;
CREATE UNIQUE INDEX "pos_inventory_lots_serial_identity_key"
  ON "pos_inventory_lots"("normalized_serial_number")
  WHERE "normalized_serial_number" IS NOT NULL;

CREATE UNIQUE INDEX "pos_inventory_lot_movements_idempotency_key_key"
  ON "pos_inventory_lot_movements"("idempotency_key");
CREATE INDEX "pos_inventory_lot_movements_lot_id_occurred_at_idx"
  ON "pos_inventory_lot_movements"("lot_id", "occurred_at");
CREATE INDEX "pos_inventory_lot_movements_sale_item_id_occurred_at_idx"
  ON "pos_inventory_lot_movements"("sale_item_id", "occurred_at");
CREATE INDEX "pos_inventory_lot_movements_return_item_id_occurred_at_idx"
  ON "pos_inventory_lot_movements"("return_item_id", "occurred_at");
CREATE INDEX "pos_inventory_lot_movements_reference_type_reference_id_idx"
  ON "pos_inventory_lot_movements"("reference_type", "reference_id");

ALTER TABLE "pos_inventory_lots"
  ADD CONSTRAINT "pos_inventory_lots_warehouse_id_fkey"
  FOREIGN KEY ("warehouse_id") REFERENCES "warehouses"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "pos_inventory_lots"
  ADD CONSTRAINT "pos_inventory_lots_product_id_fkey"
  FOREIGN KEY ("product_id") REFERENCES "products"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "pos_inventory_lots"
  ADD CONSTRAINT "pos_inventory_lots_variation_product_fkey"
  FOREIGN KEY ("variation_id", "product_id") REFERENCES "product_variations"("id", "product_id") ON DELETE RESTRICT ON UPDATE CASCADE
  DEFERRABLE INITIALLY DEFERRED;

ALTER TABLE "pos_inventory_lot_movements"
  ADD CONSTRAINT "pos_inventory_lot_movements_lot_id_fkey"
  FOREIGN KEY ("lot_id") REFERENCES "pos_inventory_lots"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "pos_inventory_lot_movements"
  ADD CONSTRAINT "pos_inventory_lot_movements_sale_item_id_fkey"
  FOREIGN KEY ("sale_item_id") REFERENCES "sale_items"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "pos_inventory_lot_movements"
  ADD CONSTRAINT "pos_inventory_lot_movements_return_item_id_fkey"
  FOREIGN KEY ("return_item_id") REFERENCES "pos_return_items"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
