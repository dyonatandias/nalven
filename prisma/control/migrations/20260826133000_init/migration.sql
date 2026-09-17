CREATE TABLE "saas_plans" (
  "id" TEXT PRIMARY KEY, "name" TEXT NOT NULL, "monthly_price" DOUBLE PRECISION NOT NULL,
  "annual_price" DOUBLE PRECISION NOT NULL, "seats" INTEGER NOT NULL, "modules" JSONB NOT NULL,
  "active" BOOLEAN NOT NULL DEFAULT true
);
CREATE TABLE "saas_tenants" (
  "id" TEXT PRIMARY KEY, "name" TEXT NOT NULL, "document" TEXT NOT NULL UNIQUE,
  "owner_name" TEXT NOT NULL, "email" TEXT NOT NULL, "plan_id" TEXT NOT NULL,
  "status" TEXT NOT NULL, "mrr" DOUBLE PRECISION NOT NULL DEFAULT 0,
  "seats_used" INTEGER NOT NULL DEFAULT 1, "modules" JSONB NOT NULL,
  "usage_score" INTEGER NOT NULL DEFAULT 0, "trial_ends_at" TEXT,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "saas_tenants_plan_id_fkey" FOREIGN KEY ("plan_id") REFERENCES "saas_plans"("id")
);
CREATE INDEX "saas_tenants_status_idx" ON "saas_tenants"("status");
CREATE TABLE "products" (
  "id" SERIAL PRIMARY KEY, "tenant_id" TEXT NOT NULL, "name" TEXT NOT NULL, "sku" TEXT NOT NULL,
  "barcode" TEXT, "type" TEXT NOT NULL DEFAULT 'product', "price" DOUBLE PRECISION NOT NULL DEFAULT 0,
  "cost" DOUBLE PRECISION NOT NULL DEFAULT 0, "category" TEXT NOT NULL, "supplier" TEXT,
  "stock" DOUBLE PRECISION NOT NULL DEFAULT 0, "min_stock" DOUBLE PRECISION NOT NULL DEFAULT 0,
  "unit" TEXT NOT NULL DEFAULT 'UN', "expiry" TEXT, "description" TEXT,
  "active" BOOLEAN NOT NULL DEFAULT true, "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL
);
CREATE UNIQUE INDEX "products_tenant_id_sku_key" ON "products"("tenant_id", "sku");
CREATE INDEX "products_tenant_id_name_idx" ON "products"("tenant_id", "name");
CREATE TABLE "stock_movements" (
  "id" SERIAL PRIMARY KEY, "tenant_id" TEXT NOT NULL, "product_id" INTEGER NOT NULL,
  "type" TEXT NOT NULL, "quantity" DOUBLE PRECISION NOT NULL,
  "previous_stock" DOUBLE PRECISION NOT NULL, "current_stock" DOUBLE PRECISION NOT NULL,
  "note" TEXT, "user_name" TEXT NOT NULL, "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "stock_movements_product_id_fkey" FOREIGN KEY ("product_id") REFERENCES "products"("id")
);
CREATE INDEX "stock_movements_tenant_id_product_id_idx" ON "stock_movements"("tenant_id", "product_id");
CREATE TABLE "sales" (
  "id" SERIAL PRIMARY KEY, "tenant_id" TEXT NOT NULL, "sale_number" TEXT NOT NULL,
  "customer" TEXT NOT NULL, "seller" TEXT NOT NULL, "cash_register" TEXT NOT NULL,
  "payment_method" TEXT NOT NULL, "total" DOUBLE PRECISION NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE UNIQUE INDEX "sales_tenant_id_sale_number_key" ON "sales"("tenant_id", "sale_number");
CREATE INDEX "sales_tenant_id_created_at_idx" ON "sales"("tenant_id", "created_at");
CREATE TABLE "sale_items" (
  "id" SERIAL PRIMARY KEY, "sale_id" INTEGER NOT NULL, "product_id" INTEGER NOT NULL,
  "product_name" TEXT NOT NULL, "quantity" DOUBLE PRECISION NOT NULL,
  "unit_price" DOUBLE PRECISION NOT NULL, "total" DOUBLE PRECISION NOT NULL,
  CONSTRAINT "sale_items_sale_id_fkey" FOREIGN KEY ("sale_id") REFERENCES "sales"("id") ON DELETE CASCADE,
  CONSTRAINT "sale_items_product_id_fkey" FOREIGN KEY ("product_id") REFERENCES "products"("id")
);
CREATE TABLE "saas_invoices" (
  "id" TEXT PRIMARY KEY, "tenant_id" TEXT NOT NULL, "description" TEXT NOT NULL,
  "amount" DOUBLE PRECISION NOT NULL, "status" TEXT NOT NULL, "due_at" TEXT NOT NULL, "paid_at" TEXT,
  CONSTRAINT "saas_invoices_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "saas_tenants"("id")
);
CREATE INDEX "saas_invoices_tenant_id_idx" ON "saas_invoices"("tenant_id");
CREATE TABLE "saas_tickets" (
  "id" TEXT PRIMARY KEY, "tenant_id" TEXT NOT NULL, "subject" TEXT NOT NULL,
  "priority" TEXT NOT NULL, "status" TEXT NOT NULL, "assignee" TEXT NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "saas_tickets_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "saas_tenants"("id")
);
CREATE INDEX "saas_tickets_status_idx" ON "saas_tickets"("status");
