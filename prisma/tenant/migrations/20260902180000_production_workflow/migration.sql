ALTER TABLE "production_orders"
  ADD COLUMN "priority" TEXT NOT NULL DEFAULT 'normal',
  ADD COLUMN "tags" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  ADD COLUMN "assigned_to" TEXT,
  ADD COLUMN "due_at" DATE,
  ADD COLUMN "started_at" TIMESTAMPTZ,
  ADD COLUMN "paused_at" TIMESTAMPTZ,
  ADD COLUMN "updated_at" TIMESTAMPTZ NOT NULL DEFAULT now();

ALTER TABLE "production_orders"
  ADD CONSTRAINT "production_orders_status_check"
    CHECK ("status" IN ('planned', 'in_progress', 'paused', 'completed', 'cancelled')),
  ADD CONSTRAINT "production_orders_priority_check"
    CHECK ("priority" IN ('low', 'normal', 'high', 'urgent')),
  ADD CONSTRAINT "production_orders_tags_check"
    CHECK (cardinality("tags") <= 12);

CREATE INDEX "production_orders_status_priority_due_idx"
  ON "production_orders"("status", "priority", "due_at");
