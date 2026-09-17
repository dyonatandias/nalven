CREATE TABLE "purchase_quotations" (
  "id" SERIAL PRIMARY KEY,
  "number" TEXT NOT NULL UNIQUE,
  "title" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'open',
  "deadline_at" DATE,
  "notes" TEXT,
  "created_by" TEXT NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE "purchase_quotation_items" (
  "id" SERIAL PRIMARY KEY,
  "quotation_id" INTEGER NOT NULL REFERENCES "purchase_quotations"("id") ON DELETE CASCADE,
  "product_id" INTEGER NOT NULL REFERENCES "products"("id") ON DELETE RESTRICT,
  "quantity" DOUBLE PRECISION NOT NULL,
  CONSTRAINT "purchase_quotation_items_quotation_id_product_id_key" UNIQUE ("quotation_id", "product_id")
);

CREATE TABLE "purchase_quotation_offers" (
  "id" SERIAL PRIMARY KEY,
  "quotation_id" INTEGER NOT NULL REFERENCES "purchase_quotations"("id") ON DELETE CASCADE,
  "supplier_id" INTEGER NOT NULL REFERENCES "suppliers"("id") ON DELETE RESTRICT,
  "total" DOUBLE PRECISION NOT NULL,
  "lead_time_days" INTEGER NOT NULL DEFAULT 0,
  "payment_terms" TEXT,
  "notes" TEXT,
  "selected" BOOLEAN NOT NULL DEFAULT FALSE,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "purchase_quotation_offers_quotation_id_supplier_id_key" UNIQUE ("quotation_id", "supplier_id")
);

CREATE TABLE "purchase_quotation_offer_items" (
  "id" SERIAL PRIMARY KEY,
  "offer_id" INTEGER NOT NULL REFERENCES "purchase_quotation_offers"("id") ON DELETE CASCADE,
  "quotation_item_id" INTEGER NOT NULL REFERENCES "purchase_quotation_items"("id") ON DELETE CASCADE,
  "unit_cost" DOUBLE PRECISION NOT NULL,
  "total" DOUBLE PRECISION NOT NULL,
  CONSTRAINT "purchase_quotation_offer_items_offer_id_quotation_item_id_key" UNIQUE ("offer_id", "quotation_item_id")
);

CREATE INDEX "purchase_quotations_status_deadline_at_idx" ON "purchase_quotations"("status", "deadline_at");
CREATE INDEX "purchase_quotation_items_product_id_idx" ON "purchase_quotation_items"("product_id");
CREATE INDEX "purchase_quotation_offers_quotation_id_total_idx" ON "purchase_quotation_offers"("quotation_id", "total");
CREATE INDEX "purchase_quotation_offer_items_quotation_item_id_idx" ON "purchase_quotation_offer_items"("quotation_item_id");
