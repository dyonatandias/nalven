CREATE TABLE "sales_orders" (
  "id" SERIAL PRIMARY KEY, "number" TEXT NOT NULL UNIQUE, "kind" TEXT NOT NULL DEFAULT 'quote',
  "status" TEXT NOT NULL DEFAULT 'draft', "customer_id" INTEGER REFERENCES "customers"("id") ON DELETE SET NULL,
  "customer_name" TEXT NOT NULL, "valid_until" DATE, "expected_at" DATE,
  "subtotal" DOUBLE PRECISION NOT NULL DEFAULT 0, "discount" DOUBLE PRECISION NOT NULL DEFAULT 0,
  "total" DOUBLE PRECISION NOT NULL DEFAULT 0, "notes" TEXT, "created_by" TEXT NOT NULL,
  "approved_at" TIMESTAMPTZ, "completed_at" TIMESTAMPTZ,
  "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP, "updated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX "sales_orders_status_created_at_idx" ON "sales_orders"("status", "created_at");
CREATE INDEX "sales_orders_customer_id_created_at_idx" ON "sales_orders"("customer_id", "created_at");
CREATE TABLE "sales_order_items" (
  "id" SERIAL PRIMARY KEY, "sales_order_id" INTEGER NOT NULL REFERENCES "sales_orders"("id") ON DELETE CASCADE,
  "product_id" INTEGER NOT NULL REFERENCES "products"("id"), "quantity" DOUBLE PRECISION NOT NULL,
  "unit_price" DOUBLE PRECISION NOT NULL, "total" DOUBLE PRECISION NOT NULL, UNIQUE("sales_order_id", "product_id")
);
CREATE INDEX "sales_order_items_product_id_idx" ON "sales_order_items"("product_id");
CREATE TABLE "sales_order_history" (
  "id" SERIAL PRIMARY KEY, "sales_order_id" INTEGER NOT NULL REFERENCES "sales_orders"("id") ON DELETE CASCADE,
  "from_status" TEXT, "to_status" TEXT NOT NULL, "actor" TEXT NOT NULL, "notes" TEXT,
  "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX "sales_order_history_sales_order_id_created_at_idx" ON "sales_order_history"("sales_order_id", "created_at");
