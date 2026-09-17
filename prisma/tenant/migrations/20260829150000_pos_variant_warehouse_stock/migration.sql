-- Authoritative common-stock scope for variations. The parent warehouse
-- balance remains the aggregate guard; this table prevents one warehouse
-- from spending stock held by another warehouse for the same variation.

CREATE TABLE "warehouse_variation_balances" (
  "id" SERIAL PRIMARY KEY,
  "warehouse_id" INTEGER NOT NULL,
  "product_id" INTEGER NOT NULL,
  "variation_id" INTEGER NOT NULL,
  "quantity" DOUBLE PRECISION NOT NULL DEFAULT 0,
  "reserved_quantity" DOUBLE PRECISION NOT NULL DEFAULT 0,
  "updated_at" TIMESTAMP(3) NOT NULL DEFAULT now(),
  CONSTRAINT "warehouse_variation_balances_warehouse_id_fkey"
    FOREIGN KEY ("warehouse_id") REFERENCES "warehouses"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "warehouse_variation_balances_product_id_fkey"
    FOREIGN KEY ("product_id") REFERENCES "products"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "warehouse_variation_balances_variation_product_fkey"
    FOREIGN KEY ("variation_id", "product_id") REFERENCES "product_variations"("id", "product_id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "warehouse_variation_balances_numbers_check"
    CHECK (
      "quantity" = "quantity"
      AND "quantity" NOT IN ('Infinity'::DOUBLE PRECISION, '-Infinity'::DOUBLE PRECISION)
      AND "reserved_quantity" = "reserved_quantity"
      AND "reserved_quantity" NOT IN ('Infinity'::DOUBLE PRECISION, '-Infinity'::DOUBLE PRECISION)
      AND "reserved_quantity" >= 0
    )
);

CREATE UNIQUE INDEX "warehouse_variation_balances_warehouse_variation_key"
  ON "warehouse_variation_balances"("warehouse_id", "variation_id");
CREATE INDEX "warehouse_variation_balances_warehouse_product_idx"
  ON "warehouse_variation_balances"("warehouse_id", "product_id");
CREATE INDEX "warehouse_variation_balances_product_variation_idx"
  ON "warehouse_variation_balances"("product_id", "variation_id");

ALTER TABLE "warehouse_balances"
  ADD CONSTRAINT "warehouse_balances_pos_numbers_check"
    CHECK (
      "quantity" = "quantity"
      AND "quantity" NOT IN ('Infinity'::DOUBLE PRECISION, '-Infinity'::DOUBLE PRECISION)
      AND "reserved_quantity" = "reserved_quantity"
      AND "reserved_quantity" NOT IN ('Infinity'::DOUBLE PRECISION, '-Infinity'::DOUBLE PRECISION)
      AND "reserved_quantity" >= 0
    ) NOT VALID;

-- Legacy ProductVariation.stock had no warehouse dimension. Preserve its
-- aggregate exactly and apportion it deterministically using positive parent
-- warehouse balances as weights. If all weights are zero, assign the legacy
-- amount to the first warehouse so no stock is silently multiplied.
WITH ranked AS (
  SELECT
    wb."warehouse_id",
    pv."product_id",
    pv."id" AS "variation_id",
    COALESCE(pv."stock", 0) AS "legacy_stock",
    GREATEST(wb."quantity", 0) AS "weight",
    SUM(GREATEST(wb."quantity", 0)) OVER (PARTITION BY pv."id") AS "total_weight",
    ROW_NUMBER() OVER (PARTITION BY pv."id" ORDER BY wb."warehouse_id") AS "warehouse_rank"
  FROM "product_variations" pv
  JOIN "warehouse_balances" wb ON wb."product_id" = pv."product_id"
  WHERE pv."manage_stock" = 'true'
)
INSERT INTO "warehouse_variation_balances" (
  "warehouse_id", "product_id", "variation_id", "quantity", "reserved_quantity", "updated_at"
)
SELECT
  "warehouse_id",
  "product_id",
  "variation_id",
  CASE
    WHEN "total_weight" > 0 THEN "legacy_stock" * "weight" / "total_weight"
    WHEN "warehouse_rank" = 1 THEN "legacy_stock"
    ELSE 0
  END,
  0,
  now()
FROM ranked;

ALTER TABLE "stock_movements"
  ADD COLUMN "variation_id" INTEGER,
  ADD COLUMN "variation_previous_stock" DOUBLE PRECISION,
  ADD COLUMN "variation_current_stock" DOUBLE PRECISION,
  ADD CONSTRAINT "stock_movements_variation_id_fkey"
    FOREIGN KEY ("variation_id") REFERENCES "product_variations"("id") ON DELETE SET NULL ON UPDATE CASCADE,
  ADD CONSTRAINT "stock_movements_variation_balance_check"
    CHECK (
      ("variation_id" IS NULL AND "variation_previous_stock" IS NULL AND "variation_current_stock" IS NULL)
      OR ("variation_previous_stock" IS NOT NULL AND "variation_current_stock" IS NOT NULL)
    ) NOT VALID;

CREATE INDEX "stock_movements_variation_warehouse_created_idx"
  ON "stock_movements"("variation_id", "warehouse_id", "created_at");

ALTER TABLE "warehouse_ledger_entries"
  ADD COLUMN "variation_id" INTEGER,
  ADD COLUMN "variation_balance_before" DOUBLE PRECISION,
  ADD COLUMN "variation_balance_after" DOUBLE PRECISION,
  ADD CONSTRAINT "warehouse_ledger_entries_variation_id_fkey"
    FOREIGN KEY ("variation_id") REFERENCES "product_variations"("id") ON DELETE SET NULL ON UPDATE CASCADE,
  ADD CONSTRAINT "warehouse_ledger_entries_variation_balance_check"
    CHECK (
      ("variation_id" IS NULL AND "variation_balance_before" IS NULL AND "variation_balance_after" IS NULL)
      OR ("variation_balance_before" IS NOT NULL AND "variation_balance_after" IS NOT NULL)
    ) NOT VALID;

CREATE INDEX "warehouse_ledger_entries_variation_warehouse_created_idx"
  ON "warehouse_ledger_entries"("variation_id", "warehouse_id", "created_at");

ALTER TABLE "stock_movements" VALIDATE CONSTRAINT "stock_movements_variation_balance_check";
ALTER TABLE "warehouse_ledger_entries" VALIDATE CONSTRAINT "warehouse_ledger_entries_variation_balance_check";
ALTER TABLE "warehouse_balances" VALIDATE CONSTRAINT "warehouse_balances_pos_numbers_check";
