ALTER TABLE "shipments"
  ADD COLUMN "version" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "assigned_to" TEXT,
  ADD COLUMN "station" TEXT,
  ADD COLUMN "hold_reason" TEXT,
  ADD COLUMN "fiscal_required" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "fiscal_status" TEXT NOT NULL DEFAULT 'not_required',
  ADD COLUMN "quoted_freight_cents" INTEGER,
  ADD COLUMN "actual_freight_cents" INTEGER,
  ADD COLUMN "charged_freight_cents" INTEGER,
  ADD COLUMN "insurance_cents" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "declared_value_cents" INTEGER NOT NULL DEFAULT 0;

ALTER TABLE "shipment_items"
  ADD COLUMN "short_quantity" DOUBLE PRECISION NOT NULL DEFAULT 0,
  ADD COLUMN "location" TEXT;

ALTER TABLE "stock_reservations"
  ADD COLUMN "variation_id" INTEGER,
  ADD CONSTRAINT "stock_reservations_variation_id_fkey" FOREIGN KEY ("variation_id") REFERENCES "product_variations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

UPDATE "stock_reservations" reservation
SET "variation_id" = item."variation_id"
FROM "sales_order_items" item
WHERE item."id" = reservation."order_item_id";

CREATE INDEX "stock_reservations_warehouse_id_variation_id_status_idx"
  ON "stock_reservations"("warehouse_id", "variation_id", "status");

CREATE UNIQUE INDEX "order_shipping_labels_sales_order_id_external_id_key"
  ON "order_shipping_labels"("sales_order_id", "external_id");

ALTER TABLE "order_return_items"
  ADD COLUMN "received_quantity" DOUBLE PRECISION NOT NULL DEFAULT 0,
  ADD COLUMN "condition" TEXT NOT NULL DEFAULT 'pending',
  ADD COLUMN "disposition" TEXT NOT NULL DEFAULT 'pending',
  ADD COLUMN "inspection_notes" TEXT,
  ADD COLUMN "warehouse_id" INTEGER,
  ADD COLUMN "lot_id" TEXT,
  ADD COLUMN "inspected_by" TEXT,
  ADD COLUMN "inspected_at" TIMESTAMP(3),
  ADD CONSTRAINT "order_return_items_warehouse_id_fkey" FOREIGN KEY ("warehouse_id") REFERENCES "warehouses"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "order_return_items_lot_id_fkey" FOREIGN KEY ("lot_id") REFERENCES "pos_inventory_lots"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "order_return_items_received_quantity_check" CHECK ("received_quantity" >= 0 AND "received_quantity" <= "quantity"),
  ADD CONSTRAINT "order_return_items_condition_check" CHECK ("condition" IN ('pending', 'new', 'opened', 'used', 'damaged', 'defective')),
  ADD CONSTRAINT "order_return_items_disposition_check" CHECK ("disposition" IN ('pending', 'restock', 'quarantine', 'repair', 'scrap', 'return_to_supplier'));

CREATE INDEX "order_return_items_warehouse_id_disposition_idx" ON "order_return_items"("warehouse_id", "disposition");
CREATE INDEX "order_return_items_lot_id_idx" ON "order_return_items"("lot_id");

UPDATE "shipments" shipment
SET
  "fiscal_required" = true,
  "fiscal_status" = CASE
    WHEN marketplace."invoice_status" IN ('authorized', 'approved', 'issued') THEN 'authorized'
    WHEN marketplace."invoice_status" IS NOT NULL THEN marketplace."invoice_status"
    ELSE 'pending'
  END
FROM "marketplace_orders" marketplace
WHERE marketplace."id" = shipment."channel_order_id";

CREATE TABLE "shipment_packages" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "shipment_id" INTEGER NOT NULL,
  "sequence" INTEGER NOT NULL,
  "code" TEXT NOT NULL UNIQUE,
  "status" TEXT NOT NULL DEFAULT 'packed',
  "carrier" TEXT,
  "service" TEXT,
  "tracking_code" TEXT,
  "sscc" TEXT UNIQUE,
  "external_id" TEXT,
  "weight_kg" DOUBLE PRECISION NOT NULL,
  "length_cm" DOUBLE PRECISION NOT NULL,
  "width_cm" DOUBLE PRECISION NOT NULL,
  "height_cm" DOUBLE PRECISION NOT NULL,
  "volumetric_weight_kg" DOUBLE PRECISION NOT NULL,
  "quoted_freight_cents" INTEGER,
  "actual_freight_cents" INTEGER,
  "declared_value_cents" INTEGER NOT NULL DEFAULT 0,
  "insurance_cents" INTEGER NOT NULL DEFAULT 0,
  "label_format" TEXT,
  "label_url" TEXT,
  "label_generated_at" TIMESTAMP(3),
  "dispatched_at" TIMESTAMP(3),
  "delivered_at" TIMESTAMP(3),
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "shipment_packages_shipment_id_fkey" FOREIGN KEY ("shipment_id") REFERENCES "shipments"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "shipment_packages_sequence_check" CHECK ("sequence" BETWEEN 1 AND 999),
  CONSTRAINT "shipment_packages_status_check" CHECK ("status" IN ('draft', 'packed', 'label_pending', 'label_ready', 'dispatched', 'in_transit', 'out_for_delivery', 'delivered', 'delivery_failed', 'returned', 'cancelled')),
  CONSTRAINT "shipment_packages_dimensions_check" CHECK ("weight_kg" > 0 AND "length_cm" > 0 AND "width_cm" > 0 AND "height_cm" > 0 AND "volumetric_weight_kg" > 0),
  CONSTRAINT "shipment_packages_money_check" CHECK (
    ("quoted_freight_cents" IS NULL OR "quoted_freight_cents" >= 0)
    AND ("actual_freight_cents" IS NULL OR "actual_freight_cents" >= 0)
    AND "declared_value_cents" >= 0
    AND "insurance_cents" >= 0
  )
);

CREATE UNIQUE INDEX "shipment_packages_shipment_id_sequence_key" ON "shipment_packages"("shipment_id", "sequence");
CREATE INDEX "shipment_packages_tracking_code_idx" ON "shipment_packages"("tracking_code");
CREATE INDEX "shipment_packages_shipment_id_status_idx" ON "shipment_packages"("shipment_id", "status");

CREATE TABLE "shipment_package_items" (
  "id" SERIAL PRIMARY KEY,
  "package_id" TEXT NOT NULL,
  "shipment_item_id" INTEGER NOT NULL,
  "quantity" DOUBLE PRECISION NOT NULL,
  CONSTRAINT "shipment_package_items_package_id_fkey" FOREIGN KEY ("package_id") REFERENCES "shipment_packages"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "shipment_package_items_shipment_item_id_fkey" FOREIGN KEY ("shipment_item_id") REFERENCES "shipment_items"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "shipment_package_items_quantity_check" CHECK ("quantity" > 0),
  UNIQUE("package_id", "shipment_item_id")
);
CREATE INDEX "shipment_package_items_shipment_item_id_idx" ON "shipment_package_items"("shipment_item_id");

CREATE TABLE "shipment_pick_allocations" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "shipment_item_id" INTEGER NOT NULL,
  "lot_id" TEXT,
  "quantity" DOUBLE PRECISION NOT NULL,
  "location" TEXT,
  "scanned_code" TEXT,
  "picked_by" TEXT NOT NULL,
  "picked_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "shipment_pick_allocations_shipment_item_id_fkey" FOREIGN KEY ("shipment_item_id") REFERENCES "shipment_items"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "shipment_pick_allocations_lot_id_fkey" FOREIGN KEY ("lot_id") REFERENCES "pos_inventory_lots"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "shipment_pick_allocations_quantity_check" CHECK ("quantity" > 0)
);
CREATE INDEX "shipment_pick_allocations_shipment_item_id_picked_at_idx" ON "shipment_pick_allocations"("shipment_item_id", "picked_at");
CREATE INDEX "shipment_pick_allocations_lot_id_idx" ON "shipment_pick_allocations"("lot_id");

CREATE TABLE "picking_waves" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "number" TEXT NOT NULL UNIQUE,
  "branch_id" INTEGER NOT NULL,
  "warehouse_id" INTEGER NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'open',
  "priority" TEXT NOT NULL DEFAULT 'normal',
  "assigned_to" TEXT,
  "station" TEXT,
  "created_by" TEXT NOT NULL,
  "started_at" TIMESTAMP(3),
  "completed_at" TIMESTAMP(3),
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "picking_waves_branch_id_fkey" FOREIGN KEY ("branch_id") REFERENCES "branches"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "picking_waves_warehouse_id_fkey" FOREIGN KEY ("warehouse_id") REFERENCES "warehouses"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "picking_waves_status_check" CHECK ("status" IN ('open', 'in_progress', 'completed', 'cancelled')),
  CONSTRAINT "picking_waves_priority_check" CHECK ("priority" IN ('low', 'normal', 'high', 'urgent'))
);
CREATE INDEX "picking_waves_branch_id_status_created_at_idx" ON "picking_waves"("branch_id", "status", "created_at");
CREATE INDEX "picking_waves_warehouse_id_status_idx" ON "picking_waves"("warehouse_id", "status");

CREATE TABLE "picking_wave_shipments" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "wave_id" TEXT NOT NULL,
  "shipment_id" INTEGER NOT NULL,
  "position" INTEGER NOT NULL DEFAULT 0,
  "status" TEXT NOT NULL DEFAULT 'pending',
  CONSTRAINT "picking_wave_shipments_wave_id_fkey" FOREIGN KEY ("wave_id") REFERENCES "picking_waves"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "picking_wave_shipments_shipment_id_fkey" FOREIGN KEY ("shipment_id") REFERENCES "shipments"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "picking_wave_shipments_status_check" CHECK ("status" IN ('pending', 'in_progress', 'completed', 'short', 'cancelled')),
  UNIQUE("wave_id", "shipment_id")
);
CREATE INDEX "picking_wave_shipments_shipment_id_status_idx" ON "picking_wave_shipments"("shipment_id", "status");

CREATE TABLE "shipping_manifests" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "number" TEXT NOT NULL UNIQUE,
  "branch_id" INTEGER NOT NULL,
  "warehouse_id" INTEGER NOT NULL,
  "carrier" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'open',
  "pickup_window" TIMESTAMP(3),
  "dock" TEXT,
  "vehicle_plate" TEXT,
  "driver_name" TEXT,
  "driver_document" TEXT,
  "protocol" TEXT,
  "total_packages" INTEGER NOT NULL DEFAULT 0,
  "total_weight_kg" DOUBLE PRECISION NOT NULL DEFAULT 0,
  "created_by" TEXT NOT NULL,
  "closed_at" TIMESTAMP(3),
  "handed_off_at" TIMESTAMP(3),
  "cancelled_at" TIMESTAMP(3),
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "shipping_manifests_branch_id_fkey" FOREIGN KEY ("branch_id") REFERENCES "branches"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "shipping_manifests_warehouse_id_fkey" FOREIGN KEY ("warehouse_id") REFERENCES "warehouses"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "shipping_manifests_status_check" CHECK ("status" IN ('open', 'closed', 'handed_off', 'cancelled')),
  CONSTRAINT "shipping_manifests_totals_check" CHECK ("total_packages" >= 0 AND "total_weight_kg" >= 0)
);
CREATE INDEX "shipping_manifests_branch_id_status_created_at_idx" ON "shipping_manifests"("branch_id", "status", "created_at");
CREATE INDEX "shipping_manifests_warehouse_id_carrier_status_idx" ON "shipping_manifests"("warehouse_id", "carrier", "status");

CREATE TABLE "shipping_manifest_shipments" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "manifest_id" TEXT NOT NULL,
  "shipment_id" INTEGER NOT NULL,
  CONSTRAINT "shipping_manifest_shipments_manifest_id_fkey" FOREIGN KEY ("manifest_id") REFERENCES "shipping_manifests"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "shipping_manifest_shipments_shipment_id_fkey" FOREIGN KEY ("shipment_id") REFERENCES "shipments"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  UNIQUE("manifest_id", "shipment_id")
);
CREATE INDEX "shipping_manifest_shipments_shipment_id_idx" ON "shipping_manifest_shipments"("shipment_id");

CREATE TABLE "shipment_incidents" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "shipment_id" INTEGER NOT NULL,
  "category" TEXT NOT NULL,
  "severity" TEXT NOT NULL DEFAULT 'medium',
  "status" TEXT NOT NULL DEFAULT 'open',
  "owner" TEXT NOT NULL,
  "description" TEXT NOT NULL,
  "due_at" TIMESTAMP(3) NOT NULL,
  "root_cause" TEXT,
  "resolution" TEXT,
  "claim_cents" INTEGER NOT NULL DEFAULT 0,
  "created_by" TEXT NOT NULL,
  "resolved_by" TEXT,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "resolved_at" TIMESTAMP(3),
  "reopened_at" TIMESTAMP(3),
  CONSTRAINT "shipment_incidents_shipment_id_fkey" FOREIGN KEY ("shipment_id") REFERENCES "shipments"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "shipment_incidents_severity_check" CHECK ("severity" IN ('low', 'medium', 'high', 'critical')),
  CONSTRAINT "shipment_incidents_status_check" CHECK ("status" IN ('open', 'resolved', 'cancelled')),
  CONSTRAINT "shipment_incidents_claim_check" CHECK ("claim_cents" >= 0)
);
CREATE INDEX "shipment_incidents_shipment_id_status_created_at_idx" ON "shipment_incidents"("shipment_id", "status", "created_at");
CREATE INDEX "shipment_incidents_status_severity_due_at_idx" ON "shipment_incidents"("status", "severity", "due_at");

CREATE TABLE "logistics_operation_receipts" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "idempotency_key" TEXT NOT NULL UNIQUE,
  "action" TEXT NOT NULL,
  "request_hash" TEXT NOT NULL,
  "actor_id" TEXT NOT NULL,
  "state" TEXT NOT NULL DEFAULT 'accepted',
  "correlation_id" TEXT NOT NULL,
  "response_status" INTEGER,
  "response_body" JSONB,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "expires_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "logistics_operation_receipts_key_check" CHECK (char_length("idempotency_key") BETWEEN 16 AND 160),
  CONSTRAINT "logistics_operation_receipts_hash_check" CHECK ("request_hash" ~ '^[0-9a-f]{64}$'),
  CONSTRAINT "logistics_operation_receipts_state_check" CHECK ("state" IN ('accepted', 'completed', 'failed'))
);
CREATE INDEX "logistics_operation_receipts_actor_id_created_at_idx" ON "logistics_operation_receipts"("actor_id", "created_at");
CREATE INDEX "logistics_operation_receipts_expires_at_idx" ON "logistics_operation_receipts"("expires_at");

CREATE INDEX "shipments_warehouse_status_sla_idx" ON "shipments"("warehouse_id", "status", "dispatch_deadline_at");
CREATE INDEX "shipments_carrier_service_status_idx" ON "shipments"("carrier", "service", "status");

ALTER TABLE "shipments"
  ADD CONSTRAINT "shipments_fiscal_status_check" CHECK ("fiscal_status" IN ('not_required', 'pending', 'authorized', 'rejected', 'cancelled')),
  ADD CONSTRAINT "shipments_freight_cents_check" CHECK (
    ("quoted_freight_cents" IS NULL OR "quoted_freight_cents" >= 0)
    AND ("actual_freight_cents" IS NULL OR "actual_freight_cents" >= 0)
    AND ("charged_freight_cents" IS NULL OR "charged_freight_cents" >= 0)
    AND "insurance_cents" >= 0
    AND "declared_value_cents" >= 0
  ),
  ADD CONSTRAINT "shipments_version_check" CHECK ("version" >= 0);

ALTER TABLE "shipment_items"
  ADD CONSTRAINT "shipment_items_short_quantity_check" CHECK ("short_quantity" >= 0 AND "short_quantity" <= "quantity");

INSERT INTO "shipment_packages" (
  "id", "shipment_id", "sequence", "code", "status", "carrier", "service", "tracking_code",
  "weight_kg", "length_cm", "width_cm", "height_cm", "volumetric_weight_kg", "actual_freight_cents",
  "dispatched_at", "delivered_at"
)
SELECT
  'pkg_' || md5(shipment."id"::text || ':' || volume."sequence"::text),
  shipment."id",
  volume."sequence",
  shipment."number" || '-V' || lpad(volume."sequence"::text, 3, '0'),
  CASE
    WHEN shipment."status" = 'delivered' THEN 'delivered'
    WHEN shipment."status" = 'dispatched' THEN 'in_transit'
    WHEN shipment."status" = 'cancelled' THEN 'cancelled'
    ELSE 'packed'
  END,
  shipment."carrier",
  shipment."service",
  CASE WHEN volume."sequence" = 1 THEN shipment."tracking_code" ELSE NULL END,
  GREATEST(COALESCE(shipment."weight_kg", 0.1) / GREATEST(shipment."package_count", 1), 0.001),
  GREATEST(COALESCE(shipment."length_cm", 10), 0.01),
  GREATEST(COALESCE(shipment."width_cm", 10), 0.01),
  GREATEST(COALESCE(shipment."height_cm", 10), 0.01),
  GREATEST(COALESCE(shipment."length_cm", 10) * COALESCE(shipment."width_cm", 10) * COALESCE(shipment."height_cm", 10) / 6000.0, 0.001),
  CASE WHEN volume."sequence" = 1 THEN round(shipment."freight" * 100)::integer ELSE 0 END,
  shipment."dispatched_at",
  shipment."delivered_at"
FROM "shipments" shipment
CROSS JOIN LATERAL generate_series(1, GREATEST(shipment."package_count", 1)) AS volume("sequence");

INSERT INTO "shipment_package_items" ("package_id", "shipment_item_id", "quantity")
SELECT package."id", item."id", item."quantity"
FROM "shipment_items" item
JOIN "shipment_packages" package ON package."shipment_id" = item."shipment_id" AND package."sequence" = 1;

INSERT INTO "shipment_incidents" (
  "id", "shipment_id", "category", "severity", "status", "owner", "description", "due_at",
  "resolution", "created_by", "resolved_by", "created_at", "resolved_at"
)
SELECT
  'inc_' || md5(shipment."id"::text || ':' || shipment."created_at"::text),
  shipment."id",
  COALESCE(shipment."exception_category", 'operational'),
  CASE WHEN shipment."priority" = 'urgent' THEN 'critical' WHEN shipment."priority" = 'high' THEN 'high' ELSE 'medium' END,
  CASE WHEN shipment."exception_status" = 'resolved' THEN 'resolved' ELSE 'open' END,
  COALESCE(shipment."exception_owner", shipment."created_by"),
  COALESCE((SELECT event."description" FROM "shipment_events" event WHERE event."shipment_id" = shipment."id" AND event."type" = 'incident' ORDER BY event."created_at" DESC LIMIT 1), 'Ocorrência migrada do fluxo anterior.'),
  COALESCE(shipment."exception_due_at", shipment."created_at" + INTERVAL '1 day'),
  shipment."exception_resolution",
  shipment."created_by",
  CASE WHEN shipment."exception_status" = 'resolved' THEN COALESCE(shipment."exception_owner", shipment."created_by") ELSE NULL END,
  shipment."created_at",
  shipment."exception_resolved_at"
FROM "shipments" shipment
WHERE shipment."exception_status" IN ('open', 'resolved');

INSERT INTO "shipping_manifests" (
  "id", "number", "branch_id", "warehouse_id", "carrier", "status", "total_packages", "total_weight_kg",
  "created_by", "closed_at", "handed_off_at", "created_at"
)
SELECT
  'man_' || md5(shipment."manifest_number" || ':' || shipment."warehouse_id"::text),
  shipment."manifest_number",
  warehouse."branch_id",
  shipment."warehouse_id",
  COALESCE(max(shipment."carrier"), 'Transportadora não informada'),
  CASE WHEN max(shipment."handoff_at") IS NOT NULL THEN 'handed_off' ELSE 'closed' END,
  sum(shipment."package_count")::integer,
  sum(COALESCE(shipment."weight_kg", 0)),
  max(shipment."created_by"),
  max(shipment."manifested_at"),
  max(shipment."handoff_at"),
  min(COALESCE(shipment."manifested_at", shipment."created_at"))
FROM "shipments" shipment
JOIN "warehouses" warehouse ON warehouse."id" = shipment."warehouse_id"
WHERE shipment."manifest_number" IS NOT NULL AND warehouse."branch_id" IS NOT NULL
GROUP BY shipment."manifest_number", shipment."warehouse_id", warehouse."branch_id";

INSERT INTO "shipping_manifest_shipments" ("id", "manifest_id", "shipment_id")
SELECT
  'ms_' || md5(manifest."id" || ':' || shipment."id"::text),
  manifest."id",
  shipment."id"
FROM "shipments" shipment
JOIN "shipping_manifests" manifest
  ON manifest."number" = shipment."manifest_number" AND manifest."warehouse_id" = shipment."warehouse_id";
