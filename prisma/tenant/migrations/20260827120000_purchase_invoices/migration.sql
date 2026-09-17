CREATE TABLE "purchase_invoices"(
 "id" SERIAL PRIMARY KEY,"access_key" TEXT NOT NULL UNIQUE,"number" TEXT NOT NULL,"series" TEXT NOT NULL,
 "status" TEXT NOT NULL DEFAULT 'imported',"supplier_document" TEXT NOT NULL,"supplier_name" TEXT NOT NULL,
 "issue_date" TIMESTAMPTZ NOT NULL,"total" DOUBLE PRECISION NOT NULL,"warehouse_id" INTEGER REFERENCES "warehouses"("id") ON DELETE SET NULL,
 "due_at" DATE,"xml_text" TEXT NOT NULL,"imported_by" TEXT NOT NULL,"received_at" TIMESTAMPTZ,
 "created_at" TIMESTAMPTZ NOT NULL DEFAULT now(),"updated_at" TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX "purchase_invoices_status_issue_date_idx" ON "purchase_invoices"("status","issue_date");
CREATE INDEX "purchase_invoices_supplier_document_issue_date_idx" ON "purchase_invoices"("supplier_document","issue_date");
CREATE TABLE "purchase_invoice_items"(
 "id" SERIAL PRIMARY KEY,"purchase_invoice_id" INTEGER NOT NULL REFERENCES "purchase_invoices"("id") ON DELETE CASCADE,
 "item_number" INTEGER NOT NULL,"supplier_code" TEXT,"description" TEXT NOT NULL,"barcode" TEXT,"ncm" TEXT,"cfop" TEXT,
 "unit" TEXT NOT NULL,"quantity" DOUBLE PRECISION NOT NULL,"unit_cost" DOUBLE PRECISION NOT NULL,"total" DOUBLE PRECISION NOT NULL,
 "product_id" INTEGER REFERENCES "products"("id") ON DELETE SET NULL,UNIQUE("purchase_invoice_id","item_number")
);
CREATE INDEX "purchase_invoice_items_product_id_idx" ON "purchase_invoice_items"("product_id");
