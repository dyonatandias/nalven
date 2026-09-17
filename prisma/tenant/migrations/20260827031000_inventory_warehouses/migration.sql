CREATE TABLE "warehouses" (
  "id" SERIAL PRIMARY KEY,
  "code" TEXT NOT NULL UNIQUE,
  "name" TEXT NOT NULL,
  "description" TEXT,
  "active" BOOLEAN NOT NULL DEFAULT true,
  "primary" BOOLEAN NOT NULL DEFAULT false,
  "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX "warehouses_active_name_idx" ON "warehouses"("active", "name");
CREATE UNIQUE INDEX "warehouses_single_primary_idx" ON "warehouses"("primary") WHERE "primary" = true;

CREATE TABLE "warehouse_balances" (
  "id" SERIAL PRIMARY KEY,
  "warehouse_id" INTEGER NOT NULL REFERENCES "warehouses"("id"),
  "product_id" INTEGER NOT NULL REFERENCES "products"("id"),
  "quantity" DOUBLE PRECISION NOT NULL DEFAULT 0,
  "updated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "warehouse_balances_warehouse_id_product_id_key" UNIQUE ("warehouse_id", "product_id")
);
CREATE INDEX "warehouse_balances_product_id_idx" ON "warehouse_balances"("product_id");

CREATE TABLE "inventory_counts" (
  "id" SERIAL PRIMARY KEY,
  "number" TEXT NOT NULL UNIQUE,
  "warehouse_id" INTEGER NOT NULL REFERENCES "warehouses"("id"),
  "status" TEXT NOT NULL DEFAULT 'draft',
  "notes" TEXT,
  "created_by" TEXT NOT NULL,
  "counted_by" TEXT,
  "completed_at" TIMESTAMPTZ,
  "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX "inventory_counts_warehouse_id_status_created_at_idx" ON "inventory_counts"("warehouse_id", "status", "created_at");

CREATE TABLE "inventory_count_items" (
  "id" SERIAL PRIMARY KEY,
  "inventory_count_id" INTEGER NOT NULL REFERENCES "inventory_counts"("id") ON DELETE CASCADE,
  "product_id" INTEGER NOT NULL REFERENCES "products"("id"),
  "system_quantity" DOUBLE PRECISION NOT NULL,
  "counted_quantity" DOUBLE PRECISION,
  "difference" DOUBLE PRECISION,
  CONSTRAINT "inventory_count_items_inventory_count_id_product_id_key" UNIQUE ("inventory_count_id", "product_id")
);
CREATE INDEX "inventory_count_items_product_id_idx" ON "inventory_count_items"("product_id");

CREATE TABLE "stock_transfers" (
  "id" SERIAL PRIMARY KEY,
  "number" TEXT NOT NULL UNIQUE,
  "from_warehouse_id" INTEGER NOT NULL REFERENCES "warehouses"("id"),
  "to_warehouse_id" INTEGER NOT NULL REFERENCES "warehouses"("id"),
  "status" TEXT NOT NULL DEFAULT 'completed',
  "notes" TEXT,
  "transferred_by" TEXT NOT NULL,
  "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "stock_transfers_distinct_warehouses" CHECK ("from_warehouse_id" <> "to_warehouse_id")
);
CREATE INDEX "stock_transfers_from_warehouse_id_created_at_idx" ON "stock_transfers"("from_warehouse_id", "created_at");
CREATE INDEX "stock_transfers_to_warehouse_id_created_at_idx" ON "stock_transfers"("to_warehouse_id", "created_at");

CREATE TABLE "stock_transfer_items" (
  "id" SERIAL PRIMARY KEY,
  "stock_transfer_id" INTEGER NOT NULL REFERENCES "stock_transfers"("id") ON DELETE CASCADE,
  "product_id" INTEGER NOT NULL REFERENCES "products"("id"),
  "quantity" DOUBLE PRECISION NOT NULL,
  CONSTRAINT "stock_transfer_items_stock_transfer_id_product_id_key" UNIQUE ("stock_transfer_id", "product_id")
);
CREATE INDEX "stock_transfer_items_product_id_idx" ON "stock_transfer_items"("product_id");

CREATE TABLE "warehouse_ledger_entries" (
  "id" BIGSERIAL PRIMARY KEY,
  "warehouse_id" INTEGER NOT NULL REFERENCES "warehouses"("id"),
  "product_id" INTEGER NOT NULL REFERENCES "products"("id"),
  "type" TEXT NOT NULL,
  "quantity" DOUBLE PRECISION NOT NULL,
  "balance_before" DOUBLE PRECISION NOT NULL,
  "balance_after" DOUBLE PRECISION NOT NULL,
  "reference_type" TEXT,
  "reference_id" TEXT,
  "actor" TEXT NOT NULL,
  "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX "warehouse_ledger_entries_warehouse_id_created_at_idx" ON "warehouse_ledger_entries"("warehouse_id", "created_at");
CREATE INDEX "warehouse_ledger_entries_product_id_created_at_idx" ON "warehouse_ledger_entries"("product_id", "created_at");
