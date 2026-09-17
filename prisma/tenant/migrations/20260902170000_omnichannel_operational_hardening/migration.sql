ALTER TABLE "marketplace_listings"
  ADD COLUMN "desired_price" DOUBLE PRECISION,
  ADD COLUMN "desired_stock" DOUBLE PRECISION,
  ADD COLUMN "sync_state" TEXT NOT NULL DEFAULT 'unverified',
  ADD COLUMN "sync_message" TEXT;

UPDATE "marketplace_listings"
SET
  "desired_price" = "price",
  "desired_stock" = "synced_stock",
  "sync_state" = CASE
    WHEN "status" = 'error' THEN 'error'
    ELSE 'observed'
  END,
  "sync_message" = 'Estado publicado existente preservado durante a migração.';

ALTER TABLE "marketplace_orders"
  ADD COLUMN "payment_status" TEXT NOT NULL DEFAULT 'unknown',
  ADD COLUMN "risk_status" TEXT NOT NULL DEFAULT 'unknown',
  ADD COLUMN "buyer_cancel_requested" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "ship_by_at" TIMESTAMP(3),
  ADD COLUMN "deliver_by_at" TIMESTAMP(3),
  ADD COLUMN "cancel_by_at" TIMESTAMP(3);

ALTER TABLE "shipments"
  ADD COLUMN "exception_status" TEXT NOT NULL DEFAULT 'none',
  ADD COLUMN "exception_category" TEXT,
  ADD COLUMN "exception_owner" TEXT,
  ADD COLUMN "exception_due_at" TIMESTAMP(3),
  ADD COLUMN "exception_resolved_at" TIMESTAMP(3),
  ADD COLUMN "exception_resolution" TEXT,
  ADD COLUMN "manifest_number" TEXT,
  ADD COLUMN "manifested_at" TIMESTAMP(3),
  ADD COLUMN "handoff_at" TIMESTAMP(3),
  ADD COLUMN "cancellation_reason" TEXT;

ALTER TABLE "order_returns"
  ADD COLUMN "reverse_provider" TEXT,
  ADD COLUMN "reverse_code" TEXT,
  ADD COLUMN "reverse_tracking_code" TEXT,
  ADD COLUMN "reverse_label_url" TEXT,
  ADD COLUMN "reverse_requested_at" TIMESTAMP(3),
  ADD COLUMN "received_at" TIMESTAMP(3);

CREATE INDEX "marketplace_listings_sync_state_idx"
  ON "marketplace_listings" ("sync_state", "last_synced_at");
CREATE INDEX "marketplace_orders_operational_risk_idx"
  ON "marketplace_orders" ("buyer_cancel_requested", "risk_status", "ship_by_at");
CREATE INDEX "shipments_exception_status_due_idx"
  ON "shipments" ("exception_status", "exception_due_at");
CREATE INDEX "shipments_manifest_number_at_idx"
  ON "shipments" ("manifest_number", "manifested_at");
CREATE INDEX "order_returns_reverse_status_idx"
  ON "order_returns" ("status", "reverse_requested_at");

ALTER TABLE "shipments"
  ADD CONSTRAINT "shipments_exception_status_check"
    CHECK ("exception_status" IN ('none', 'open', 'resolved')),
  ADD CONSTRAINT "shipments_exception_resolution_check"
    CHECK (
      ("exception_status" = 'open' AND "exception_resolved_at" IS NULL)
      OR ("exception_status" = 'resolved' AND "exception_resolved_at" IS NOT NULL)
      OR ("exception_status" = 'none')
    );

