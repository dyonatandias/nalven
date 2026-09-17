CREATE TABLE "purchase_orders" (
  "id" SERIAL PRIMARY KEY,
  "number" TEXT NOT NULL UNIQUE,
  "supplier_id" INTEGER NOT NULL REFERENCES "suppliers"("id"),
  "status" TEXT NOT NULL DEFAULT 'draft',
  "expected_at" DATE,
  "due_at" DATE,
  "subtotal" DOUBLE PRECISION NOT NULL DEFAULT 0,
  "freight" DOUBLE PRECISION NOT NULL DEFAULT 0,
  "discount" DOUBLE PRECISION NOT NULL DEFAULT 0,
  "total" DOUBLE PRECISION NOT NULL DEFAULT 0,
  "notes" TEXT,
  "created_by" TEXT NOT NULL,
  "ordered_at" TIMESTAMPTZ,
  "completed_at" TIMESTAMPTZ,
  "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX "purchase_orders_status_expected_at_idx" ON "purchase_orders"("status", "expected_at");
CREATE INDEX "purchase_orders_supplier_id_created_at_idx" ON "purchase_orders"("supplier_id", "created_at");

CREATE TABLE "purchase_order_items" (
  "id" SERIAL PRIMARY KEY,
  "purchase_order_id" INTEGER NOT NULL REFERENCES "purchase_orders"("id") ON DELETE CASCADE,
  "product_id" INTEGER NOT NULL REFERENCES "products"("id"),
  "quantity" DOUBLE PRECISION NOT NULL,
  "received_quantity" DOUBLE PRECISION NOT NULL DEFAULT 0,
  "unit_cost" DOUBLE PRECISION NOT NULL,
  "total" DOUBLE PRECISION NOT NULL,
  CONSTRAINT "purchase_order_items_purchase_order_id_product_id_key" UNIQUE ("purchase_order_id", "product_id")
);
CREATE INDEX "purchase_order_items_product_id_idx" ON "purchase_order_items"("product_id");

CREATE TABLE "goods_receipts" (
  "id" SERIAL PRIMARY KEY,
  "number" TEXT NOT NULL UNIQUE,
  "purchase_order_id" INTEGER NOT NULL REFERENCES "purchase_orders"("id"),
  "received_by" TEXT NOT NULL,
  "notes" TEXT,
  "received_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX "goods_receipts_purchase_order_id_received_at_idx" ON "goods_receipts"("purchase_order_id", "received_at");

CREATE TABLE "goods_receipt_items" (
  "id" SERIAL PRIMARY KEY,
  "goods_receipt_id" INTEGER NOT NULL REFERENCES "goods_receipts"("id") ON DELETE CASCADE,
  "purchase_order_item_id" INTEGER NOT NULL REFERENCES "purchase_order_items"("id"),
  "product_id" INTEGER NOT NULL REFERENCES "products"("id"),
  "quantity" DOUBLE PRECISION NOT NULL,
  "unit_cost" DOUBLE PRECISION NOT NULL
);
CREATE INDEX "goods_receipt_items_product_id_idx" ON "goods_receipt_items"("product_id");

CREATE TABLE "financial_titles" (
  "id" SERIAL PRIMARY KEY,
  "type" TEXT NOT NULL,
  "description" TEXT NOT NULL,
  "supplier_id" INTEGER REFERENCES "suppliers"("id") ON DELETE SET NULL,
  "source_type" TEXT NOT NULL,
  "source_id" TEXT NOT NULL,
  "amount" DOUBLE PRECISION NOT NULL,
  "due_at" DATE NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'open',
  "paid_at" TIMESTAMPTZ,
  "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "financial_titles_source_type_source_id_key" UNIQUE ("source_type", "source_id")
);
CREATE INDEX "financial_titles_type_status_due_at_idx" ON "financial_titles"("type", "status", "due_at");
CREATE INDEX "financial_titles_supplier_id_idx" ON "financial_titles"("supplier_id");
