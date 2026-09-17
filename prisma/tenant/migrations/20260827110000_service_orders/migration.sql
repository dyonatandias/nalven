CREATE TABLE "service_orders" (
 "id" SERIAL PRIMARY KEY,"number" TEXT NOT NULL UNIQUE,"status" TEXT NOT NULL DEFAULT 'open',
 "customer_id" INTEGER NOT NULL REFERENCES "customers"("id"),"customer_name" TEXT NOT NULL,
 "asset" TEXT NOT NULL,"asset_identifier" TEXT,"mileage" INTEGER,"complaint" TEXT NOT NULL,"diagnosis" TEXT,
 "scheduled_at" TIMESTAMPTZ,"technician" TEXT,"subtotal" DOUBLE PRECISION NOT NULL DEFAULT 0,
 "discount" DOUBLE PRECISION NOT NULL DEFAULT 0,"total" DOUBLE PRECISION NOT NULL DEFAULT 0,
 "warranty_days" INTEGER NOT NULL DEFAULT 90,"created_by" TEXT NOT NULL,"started_at" TIMESTAMPTZ,"completed_at" TIMESTAMPTZ,
 "created_at" TIMESTAMPTZ NOT NULL DEFAULT now(),"updated_at" TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX "service_orders_status_scheduled_at_idx" ON "service_orders"("status","scheduled_at");
CREATE INDEX "service_orders_customer_id_created_at_idx" ON "service_orders"("customer_id","created_at");
CREATE TABLE "service_order_items"("id" SERIAL PRIMARY KEY,"service_order_id" INTEGER NOT NULL REFERENCES "service_orders"("id") ON DELETE CASCADE,"product_id" INTEGER NOT NULL REFERENCES "products"("id"),"quantity" DOUBLE PRECISION NOT NULL,"unit_price" DOUBLE PRECISION NOT NULL,"total" DOUBLE PRECISION NOT NULL,UNIQUE("service_order_id","product_id"));
CREATE TABLE "service_checklist_items"("id" SERIAL PRIMARY KEY,"service_order_id" INTEGER NOT NULL REFERENCES "service_orders"("id") ON DELETE CASCADE,"label" TEXT NOT NULL,"required" BOOLEAN NOT NULL DEFAULT true,"completed" BOOLEAN NOT NULL DEFAULT false,"notes" TEXT);
CREATE INDEX "service_checklist_items_service_order_id_completed_idx" ON "service_checklist_items"("service_order_id","completed");
CREATE TABLE "service_order_history"("id" SERIAL PRIMARY KEY,"service_order_id" INTEGER NOT NULL REFERENCES "service_orders"("id") ON DELETE CASCADE,"from_status" TEXT,"to_status" TEXT NOT NULL,"actor" TEXT NOT NULL,"created_at" TIMESTAMPTZ NOT NULL DEFAULT now());
CREATE INDEX "service_order_history_service_order_id_created_at_idx" ON "service_order_history"("service_order_id","created_at");
