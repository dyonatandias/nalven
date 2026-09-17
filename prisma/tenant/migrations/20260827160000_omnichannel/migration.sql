CREATE TABLE "marketplace_channels" (
  "id" SERIAL PRIMARY KEY, "name" TEXT NOT NULL, "provider" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'active', "environment" TEXT NOT NULL DEFAULT 'production',
  "auto_import" BOOLEAN NOT NULL DEFAULT true, "last_sync_at" TIMESTAMPTZ,
  "created_at" TIMESTAMPTZ NOT NULL DEFAULT now(), "updated_at" TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX "marketplace_channels_status_provider_idx" ON "marketplace_channels"("status", "provider");

CREATE TABLE "marketplace_listings" (
  "id" SERIAL PRIMARY KEY, "channel_id" INTEGER NOT NULL REFERENCES "marketplace_channels"("id") ON DELETE CASCADE,
  "product_id" INTEGER NOT NULL REFERENCES "products"("id"), "external_id" TEXT NOT NULL,
  "title" TEXT NOT NULL, "status" TEXT NOT NULL DEFAULT 'active', "price" DOUBLE PRECISION NOT NULL,
  "synced_stock" DOUBLE PRECISION NOT NULL DEFAULT 0, "last_synced_at" TIMESTAMPTZ,
  "created_at" TIMESTAMPTZ NOT NULL DEFAULT now(), "updated_at" TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE("channel_id", "external_id"), UNIQUE("channel_id", "product_id")
);
CREATE INDEX "marketplace_listings_status_last_synced_at_idx" ON "marketplace_listings"("status", "last_synced_at");

CREATE TABLE "marketplace_orders" (
  "id" SERIAL PRIMARY KEY, "channel_id" INTEGER NOT NULL REFERENCES "marketplace_channels"("id"),
  "external_id" TEXT NOT NULL, "status" TEXT NOT NULL DEFAULT 'imported', "customer_name" TEXT NOT NULL,
  "customer_document" TEXT, "total" DOUBLE PRECISION NOT NULL, "fee" DOUBLE PRECISION NOT NULL DEFAULT 0,
  "sales_order_id" INTEGER NOT NULL UNIQUE REFERENCES "sales_orders"("id"),
  "imported_at" TIMESTAMPTZ NOT NULL DEFAULT now(), "updated_at" TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE("channel_id", "external_id")
);
CREATE INDEX "marketplace_orders_status_imported_at_idx" ON "marketplace_orders"("status", "imported_at");

CREATE TABLE "shipments" (
  "id" SERIAL PRIMARY KEY, "number" TEXT NOT NULL UNIQUE, "sales_order_id" INTEGER NOT NULL UNIQUE REFERENCES "sales_orders"("id"),
  "channel_order_id" INTEGER UNIQUE REFERENCES "marketplace_orders"("id"), "warehouse_id" INTEGER NOT NULL REFERENCES "warehouses"("id"),
  "status" TEXT NOT NULL DEFAULT 'picking', "carrier" TEXT, "service" TEXT, "tracking_code" TEXT,
  "freight" DOUBLE PRECISION NOT NULL DEFAULT 0, "deadline_at" DATE, "packed_by" TEXT,
  "dispatched_at" TIMESTAMPTZ, "delivered_at" TIMESTAMPTZ, "created_by" TEXT NOT NULL,
  "created_at" TIMESTAMPTZ NOT NULL DEFAULT now(), "updated_at" TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX "shipments_status_deadline_at_idx" ON "shipments"("status", "deadline_at");

CREATE TABLE "shipment_items" (
  "id" SERIAL PRIMARY KEY, "shipment_id" INTEGER NOT NULL REFERENCES "shipments"("id") ON DELETE CASCADE,
  "sales_order_item_id" INTEGER NOT NULL REFERENCES "sales_order_items"("id"), "quantity" DOUBLE PRECISION NOT NULL,
  "picked_quantity" DOUBLE PRECISION NOT NULL DEFAULT 0, UNIQUE("shipment_id", "sales_order_item_id")
);

CREATE TABLE "shipment_events" (
  "id" SERIAL PRIMARY KEY, "shipment_id" INTEGER NOT NULL REFERENCES "shipments"("id") ON DELETE CASCADE,
  "type" TEXT NOT NULL, "description" TEXT NOT NULL, "actor" TEXT NOT NULL,
  "created_at" TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX "shipment_events_shipment_id_created_at_idx" ON "shipment_events"("shipment_id", "created_at");
