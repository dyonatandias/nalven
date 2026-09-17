ALTER TABLE "branch_settings"
  ADD COLUMN "reserve_stock_on_order" BOOLEAN NOT NULL DEFAULT true,
  ADD COLUMN "allow_cross_branch_fulfillment" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "auto_transfer_enabled" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "stock_allocation_strategy" TEXT NOT NULL DEFAULT 'local_first';

ALTER TABLE "branches"
  ADD COLUMN "manager_name" TEXT,
  ADD COLUMN "manager_email" TEXT,
  ADD COLUMN "manager_phone" TEXT,
  ADD COLUMN "cost_center_code" TEXT;

ALTER TABLE "stock_movements" ADD COLUMN "warehouse_id" INTEGER;
ALTER TABLE "sales" ADD COLUMN "branch_id" INTEGER, ADD COLUMN "warehouse_id" INTEGER;

CREATE TABLE "branch_products" (
  "id" SERIAL NOT NULL,
  "branch_id" INTEGER NOT NULL,
  "product_id" INTEGER NOT NULL,
  "active" BOOLEAN NOT NULL DEFAULT true,
  "sale_enabled" BOOLEAN NOT NULL DEFAULT true,
  "purchase_enabled" BOOLEAN NOT NULL DEFAULT true,
  "price_override" DOUBLE PRECISION,
  "cost_override" DOUBLE PRECISION,
  "min_stock" DOUBLE PRECISION,
  "max_stock" DOUBLE PRECISION,
  "reorder_point" DOUBLE PRECISION,
  "reorder_quantity" DOUBLE PRECISION,
  "preferred_warehouse_id" INTEGER,
  "location" TEXT,
  "lead_time_days" INTEGER NOT NULL DEFAULT 0,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "branch_products_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "branch_user_accesses" (
  "id" SERIAL NOT NULL,
  "branch_id" INTEGER NOT NULL,
  "user_profile_id" INTEGER NOT NULL,
  "can_sell" BOOLEAN NOT NULL DEFAULT true,
  "can_manage_stock" BOOLEAN NOT NULL DEFAULT false,
  "can_issue_fiscal" BOOLEAN NOT NULL DEFAULT false,
  "primary" BOOLEAN NOT NULL DEFAULT false,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "branch_user_accesses_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "branch_products_branch_id_product_id_key" ON "branch_products"("branch_id", "product_id");
CREATE INDEX "branch_products_branch_id_active_sale_enabled_idx" ON "branch_products"("branch_id", "active", "sale_enabled");
CREATE INDEX "branch_products_product_id_active_idx" ON "branch_products"("product_id", "active");
CREATE INDEX "branch_products_preferred_warehouse_id_idx" ON "branch_products"("preferred_warehouse_id");
CREATE UNIQUE INDEX "branch_user_accesses_branch_id_user_profile_id_key" ON "branch_user_accesses"("branch_id", "user_profile_id");
CREATE INDEX "branch_user_accesses_user_profile_id_branch_id_idx" ON "branch_user_accesses"("user_profile_id", "branch_id");
CREATE INDEX "stock_movements_warehouse_id_created_at_idx" ON "stock_movements"("warehouse_id", "created_at");
CREATE INDEX "sales_branch_id_created_at_idx" ON "sales"("branch_id", "created_at");
CREATE INDEX "sales_warehouse_id_created_at_idx" ON "sales"("warehouse_id", "created_at");

ALTER TABLE "branch_products" ADD CONSTRAINT "branch_products_branch_id_fkey" FOREIGN KEY ("branch_id") REFERENCES "branches"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "branch_products" ADD CONSTRAINT "branch_products_product_id_fkey" FOREIGN KEY ("product_id") REFERENCES "products"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "branch_products" ADD CONSTRAINT "branch_products_preferred_warehouse_id_fkey" FOREIGN KEY ("preferred_warehouse_id") REFERENCES "warehouses"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "branch_user_accesses" ADD CONSTRAINT "branch_user_accesses_branch_id_fkey" FOREIGN KEY ("branch_id") REFERENCES "branches"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "branch_user_accesses" ADD CONSTRAINT "branch_user_accesses_user_profile_id_fkey" FOREIGN KEY ("user_profile_id") REFERENCES "tenant_user_profiles"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "stock_movements" ADD CONSTRAINT "stock_movements_warehouse_id_fkey" FOREIGN KEY ("warehouse_id") REFERENCES "warehouses"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "sales" ADD CONSTRAINT "sales_branch_id_fkey" FOREIGN KEY ("branch_id") REFERENCES "branches"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "sales" ADD CONSTRAINT "sales_warehouse_id_fkey" FOREIGN KEY ("warehouse_id") REFERENCES "warehouses"("id") ON DELETE SET NULL ON UPDATE CASCADE;

UPDATE "stock_movements" sm SET "warehouse_id" = w."id" FROM "warehouses" w WHERE w."primary" = true AND sm."warehouse_id" IS NULL;
UPDATE "sales" s SET "branch_id" = b."id" FROM "branches" b WHERE b."primary" = true AND s."branch_id" IS NULL;
UPDATE "sales" s SET "warehouse_id" = b."default_warehouse_id" FROM "branches" b WHERE s."branch_id" = b."id" AND s."warehouse_id" IS NULL;

INSERT INTO "branch_products" ("branch_id", "product_id", "active", "sale_enabled", "purchase_enabled", "min_stock", "reorder_point", "reorder_quantity", "updated_at")
SELECT b."id", p."id", p."active", true, p."type" = 'product', CASE WHEN p."type" = 'product' THEN p."min_stock" ELSE NULL END, CASE WHEN p."type" = 'product' THEN p."min_stock" ELSE NULL END, CASE WHEN p."type" = 'product' THEN GREATEST(p."min_stock", 1) ELSE NULL END, CURRENT_TIMESTAMP
FROM "branches" b CROSS JOIN "products" p
ON CONFLICT ("branch_id", "product_id") DO NOTHING;

INSERT INTO "branch_user_accesses" ("branch_id", "user_profile_id", "can_sell", "can_manage_stock", "can_issue_fiscal", "primary", "updated_at")
SELECT b."id", u."id", true, true, true, COALESCE(b."id" = u."active_branch_id", false), CURRENT_TIMESTAMP
FROM "branches" b CROSS JOIN "tenant_user_profiles" u
WHERE u."status" = 'active'
ON CONFLICT ("branch_id", "user_profile_id") DO NOTHING;
