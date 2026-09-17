ALTER TABLE "sales_orders"
  ADD COLUMN "customer_document" TEXT,
  ADD COLUMN "customer_email" TEXT,
  ADD COLUMN "customer_phone" TEXT,
  ADD COLUMN "contact_name" TEXT,
  ADD COLUMN "sales_channel" TEXT NOT NULL DEFAULT 'direct',
  ADD COLUMN "salesperson" TEXT,
  ADD COLUMN "salesperson_profile_id" INTEGER,
  ADD COLUMN "priority" TEXT NOT NULL DEFAULT 'normal',
  ADD COLUMN "external_reference" TEXT,
  ADD COLUMN "purchase_order_number" TEXT,
  ADD COLUMN "discount_type" TEXT NOT NULL DEFAULT 'value',
  ADD COLUMN "discount_value" DOUBLE PRECISION NOT NULL DEFAULT 0,
  ADD COLUMN "freight_amount" DOUBLE PRECISION NOT NULL DEFAULT 0,
  ADD COLUMN "freight_type" TEXT NOT NULL DEFAULT 'none',
  ADD COLUMN "payment_method" TEXT,
  ADD COLUMN "payment_terms" TEXT,
  ADD COLUMN "payment_installments" INTEGER NOT NULL DEFAULT 1,
  ADD COLUMN "first_due_date" DATE,
  ADD COLUMN "delivery_type" TEXT NOT NULL DEFAULT 'pickup',
  ADD COLUMN "delivery_zip" TEXT,
  ADD COLUMN "delivery_street" TEXT,
  ADD COLUMN "delivery_number" TEXT,
  ADD COLUMN "delivery_complement" TEXT,
  ADD COLUMN "delivery_district" TEXT,
  ADD COLUMN "delivery_city" TEXT,
  ADD COLUMN "delivery_state" TEXT,
  ADD COLUMN "internal_notes" TEXT,
  ADD COLUMN "terms_accepted" BOOLEAN NOT NULL DEFAULT false;

ALTER TABLE "sales_order_items"
  ADD COLUMN "description" TEXT,
  ADD COLUMN "list_price" DOUBLE PRECISION NOT NULL DEFAULT 0,
  ADD COLUMN "discount" DOUBLE PRECISION NOT NULL DEFAULT 0,
  ADD COLUMN "discount_percent" DOUBLE PRECISION NOT NULL DEFAULT 0,
  ADD COLUMN "notes" TEXT;

UPDATE "sales_order_items"
SET "list_price" = "unit_price"
WHERE "list_price" = 0;

UPDATE "sales_orders" so
SET
  "customer_document" = c."document",
  "customer_email" = c."email",
  "customer_phone" = c."phone",
  "salesperson" = so."created_by"
FROM "customers" c
WHERE c."id" = so."customer_id";

UPDATE "sales_orders"
SET "salesperson" = "created_by"
WHERE "salesperson" IS NULL;

ALTER TABLE "sales_orders"
  ADD CONSTRAINT "sales_orders_sales_channel_check" CHECK ("sales_channel" IN ('direct', 'store', 'phone', 'whatsapp', 'email', 'field', 'ecommerce', 'marketplace')),
  ADD CONSTRAINT "sales_orders_priority_check" CHECK ("priority" IN ('low', 'normal', 'high', 'urgent')),
  ADD CONSTRAINT "sales_orders_discount_type_check" CHECK ("discount_type" IN ('value', 'percent')),
  ADD CONSTRAINT "sales_orders_freight_type_check" CHECK ("freight_type" IN ('none', 'cif', 'fob')),
  ADD CONSTRAINT "sales_orders_delivery_type_check" CHECK ("delivery_type" IN ('pickup', 'delivery', 'carrier')),
  ADD CONSTRAINT "sales_orders_payment_installments_check" CHECK ("payment_installments" BETWEEN 1 AND 120),
  ADD CONSTRAINT "sales_orders_amounts_check" CHECK ("subtotal" >= 0 AND "discount" >= 0 AND "discount_value" >= 0 AND "freight_amount" >= 0 AND "total" >= 0);

ALTER TABLE "sales_order_items"
  ADD CONSTRAINT "sales_order_items_amounts_check" CHECK ("quantity" > 0 AND "list_price" >= 0 AND "unit_price" >= 0 AND "discount" >= 0 AND "discount_percent" BETWEEN 0 AND 100 AND "total" >= 0);

CREATE INDEX "sales_orders_sales_channel_created_at_idx" ON "sales_orders"("sales_channel", "created_at");
CREATE INDEX "sales_orders_priority_status_idx" ON "sales_orders"("priority", "status");
CREATE INDEX "sales_orders_salesperson_profile_id_created_at_idx" ON "sales_orders"("salesperson_profile_id", "created_at");
ALTER TABLE "sales_orders"
  ADD CONSTRAINT "sales_orders_salesperson_profile_id_fkey"
  FOREIGN KEY ("salesperson_profile_id") REFERENCES "tenant_user_profiles"("id") ON DELETE SET NULL ON UPDATE CASCADE;
