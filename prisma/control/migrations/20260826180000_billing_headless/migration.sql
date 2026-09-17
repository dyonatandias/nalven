CREATE TABLE "billing_accounts" (
  "id" TEXT PRIMARY KEY, "organization_id" TEXT NOT NULL UNIQUE, "external_id" TEXT NOT NULL UNIQUE,
  "billing_customer_id" TEXT, "plan_code" TEXT, "payment_method" TEXT, "modules" JSONB NOT NULL,
  "subscription_status" TEXT, "license_status" TEXT, "entitlement_cache" JSONB, "portal_cache" JSONB,
  "last_synced_at" TIMESTAMPTZ, "last_error" TEXT,
  "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "billing_accounts_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE
);
CREATE INDEX "billing_accounts_subscription_status_last_synced_at_idx" ON "billing_accounts"("subscription_status", "last_synced_at");
CREATE TABLE "billing_webhook_events" (
  "webhook_id" TEXT PRIMARY KEY, "event" TEXT NOT NULL, "external_id" TEXT, "correlation_id" TEXT,
  "payload" JSONB NOT NULL, "received_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "processed_at" TIMESTAMPTZ, "error" TEXT
);
CREATE INDEX "billing_webhook_events_event_received_at_idx" ON "billing_webhook_events"("event", "received_at");
CREATE INDEX "billing_webhook_events_external_id_received_at_idx" ON "billing_webhook_events"("external_id", "received_at");
CREATE TABLE "billing_sync_runs" (
  "id" TEXT PRIMARY KEY, "kind" TEXT NOT NULL, "status" TEXT NOT NULL, "cursor" TEXT,
  "processed" INTEGER NOT NULL DEFAULT 0, "request_id" TEXT, "error" TEXT,
  "started_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP, "finished_at" TIMESTAMPTZ
);
CREATE INDEX "billing_sync_runs_started_at_idx" ON "billing_sync_runs"("started_at");
