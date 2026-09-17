CREATE TABLE "products" (
  "id" SERIAL PRIMARY KEY, "name" TEXT NOT NULL, "sku" TEXT NOT NULL UNIQUE, "barcode" TEXT,
  "type" TEXT NOT NULL DEFAULT 'product', "price" DOUBLE PRECISION NOT NULL DEFAULT 0,
  "cost" DOUBLE PRECISION NOT NULL DEFAULT 0, "category" TEXT NOT NULL, "supplier" TEXT,
  "stock" DOUBLE PRECISION NOT NULL DEFAULT 0, "min_stock" DOUBLE PRECISION NOT NULL DEFAULT 0,
  "unit" TEXT NOT NULL DEFAULT 'UN', "expiry" TEXT, "description" TEXT, "active" BOOLEAN NOT NULL DEFAULT true,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, "updated_at" TIMESTAMP(3) NOT NULL
);
CREATE INDEX "products_name_idx" ON "products"("name");
CREATE TABLE "stock_movements" (
  "id" SERIAL PRIMARY KEY, "product_id" INTEGER NOT NULL REFERENCES "products"("id"), "type" TEXT NOT NULL,
  "quantity" DOUBLE PRECISION NOT NULL, "previous_stock" DOUBLE PRECISION NOT NULL,
  "current_stock" DOUBLE PRECISION NOT NULL, "note" TEXT, "user_name" TEXT NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX "stock_movements_product_id_idx" ON "stock_movements"("product_id");
CREATE TABLE "sales" (
  "id" SERIAL PRIMARY KEY, "sale_number" TEXT NOT NULL UNIQUE, "customer" TEXT NOT NULL,
  "seller" TEXT NOT NULL, "cash_register" TEXT NOT NULL, "payment_method" TEXT NOT NULL,
  "total" DOUBLE PRECISION NOT NULL, "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX "sales_created_at_idx" ON "sales"("created_at");
CREATE TABLE "sale_items" (
  "id" SERIAL PRIMARY KEY, "sale_id" INTEGER NOT NULL REFERENCES "sales"("id") ON DELETE CASCADE,
  "product_id" INTEGER NOT NULL REFERENCES "products"("id"), "product_name" TEXT NOT NULL,
  "quantity" DOUBLE PRECISION NOT NULL, "unit_price" DOUBLE PRECISION NOT NULL, "total" DOUBLE PRECISION NOT NULL
);
