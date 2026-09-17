-- Omnichannel control tower: channel policies, synchronization health and
-- auditable fulfillment details. Existing rows retain safe operational defaults.
ALTER TABLE "marketplace_channels"
  ADD COLUMN "stock_buffer" DOUBLE PRECISION NOT NULL DEFAULT 0,
  ADD COLUMN "price_adjustment" DOUBLE PRECISION NOT NULL DEFAULT 0,
  ADD COLUMN "sync_interval" INTEGER NOT NULL DEFAULT 15,
  ADD COLUMN "last_sync_status" TEXT NOT NULL DEFAULT 'pending',
  ADD COLUMN "last_sync_message" TEXT;

ALTER TABLE "shipments"
  ADD COLUMN "priority" TEXT NOT NULL DEFAULT 'normal',
  ADD COLUMN "dispatch_deadline_at" TIMESTAMP(3),
  ADD COLUMN "package_count" INTEGER NOT NULL DEFAULT 1,
  ADD COLUMN "weight_kg" DOUBLE PRECISION,
  ADD COLUMN "length_cm" DOUBLE PRECISION,
  ADD COLUMN "width_cm" DOUBLE PRECISION,
  ADD COLUMN "height_cm" DOUBLE PRECISION,
  ADD COLUMN "picking_started_at" TIMESTAMP(3),
  ADD COLUMN "packed_at" TIMESTAMP(3),
  ADD COLUMN "delivery_recipient" TEXT,
  ADD COLUMN "delivery_document" TEXT,
  ADD COLUMN "delivery_notes" TEXT,
  ADD COLUMN "proof_url" TEXT,
  ADD COLUMN "cancelled_at" TIMESTAMP(3),
  ADD COLUMN "cancelled_by" TEXT;

ALTER TABLE "marketplace_channels"
  ADD CONSTRAINT "marketplace_channels_stock_buffer_check" CHECK ("stock_buffer" >= 0),
  ADD CONSTRAINT "marketplace_channels_price_adjustment_check" CHECK ("price_adjustment" BETWEEN -90 AND 500),
  ADD CONSTRAINT "marketplace_channels_sync_interval_check" CHECK ("sync_interval" BETWEEN 1 AND 1440),
  ADD CONSTRAINT "marketplace_channels_sync_status_check" CHECK ("last_sync_status" IN ('pending', 'local_only', 'queued', 'healthy', 'warning', 'error'));

ALTER TABLE "shipments"
  ADD CONSTRAINT "shipments_priority_check" CHECK ("priority" IN ('low', 'normal', 'high', 'urgent')),
  ADD CONSTRAINT "shipments_package_count_check" CHECK ("package_count" BETWEEN 1 AND 999),
  ADD CONSTRAINT "shipments_weight_check" CHECK ("weight_kg" IS NULL OR "weight_kg" > 0),
  ADD CONSTRAINT "shipments_dimensions_check" CHECK (
    ("length_cm" IS NULL OR "length_cm" > 0) AND
    ("width_cm" IS NULL OR "width_cm" > 0) AND
    ("height_cm" IS NULL OR "height_cm" > 0)
  );

CREATE INDEX "shipments_dispatch_sla_idx" ON "shipments"("status", "dispatch_deadline_at");
CREATE INDEX "shipments_priority_created_idx" ON "shipments"("priority", "created_at");
