CREATE TABLE "categories" (
  "id" SERIAL PRIMARY KEY,
  "name" TEXT NOT NULL UNIQUE,
  "slug" TEXT NOT NULL UNIQUE,
  "description" TEXT,
  "type" TEXT NOT NULL DEFAULT 'both',
  "color" TEXT NOT NULL DEFAULT '#168151',
  "active" BOOLEAN NOT NULL DEFAULT TRUE,
  "parent_id" INTEGER REFERENCES "categories"("id") ON DELETE SET NULL,
  "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX "categories_active_name_idx" ON "categories"("active", "name");
CREATE INDEX "categories_parent_id_idx" ON "categories"("parent_id");

ALTER TABLE "products" ADD COLUMN "category_id" INTEGER REFERENCES "categories"("id") ON DELETE SET NULL;
CREATE INDEX "products_category_id_idx" ON "products"("category_id");

CREATE TABLE "suppliers" (
  "id" SERIAL PRIMARY KEY,
  "name" TEXT NOT NULL,
  "trade_name" TEXT,
  "document" TEXT NOT NULL UNIQUE,
  "email" TEXT,
  "phone" TEXT,
  "status" TEXT NOT NULL DEFAULT 'active',
  "payment_terms" TEXT,
  "notes" TEXT,
  "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX "suppliers_name_idx" ON "suppliers"("name");
CREATE INDEX "suppliers_status_idx" ON "suppliers"("status");

CREATE TABLE "supplier_contacts" (
  "id" SERIAL PRIMARY KEY,
  "supplier_id" INTEGER NOT NULL REFERENCES "suppliers"("id") ON DELETE CASCADE,
  "name" TEXT NOT NULL,
  "role" TEXT,
  "email" TEXT,
  "phone" TEXT,
  "primary" BOOLEAN NOT NULL DEFAULT FALSE,
  "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX "supplier_contacts_supplier_id_primary_idx" ON "supplier_contacts"("supplier_id", "primary");

CREATE TABLE "supplier_products" (
  "id" SERIAL PRIMARY KEY,
  "supplier_id" INTEGER NOT NULL REFERENCES "suppliers"("id") ON DELETE CASCADE,
  "product_id" INTEGER NOT NULL REFERENCES "products"("id") ON DELETE CASCADE,
  "supplier_code" TEXT,
  "last_cost" DOUBLE PRECISION,
  "lead_time_days" INTEGER,
  "minimum_order" DOUBLE PRECISION,
  "preferred" BOOLEAN NOT NULL DEFAULT FALSE,
  "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE ("supplier_id", "product_id")
);
CREATE INDEX "supplier_products_product_id_preferred_idx" ON "supplier_products"("product_id", "preferred");
