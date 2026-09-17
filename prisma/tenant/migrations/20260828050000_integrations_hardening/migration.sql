DROP INDEX IF EXISTS "integration_webhook_deliveries_event_id_key";
CREATE UNIQUE INDEX "integration_webhook_deliveries_endpoint_id_event_id_key"
  ON "integration_webhook_deliveries"("endpoint_id", "event_id");

WITH ranked_defaults AS (
  SELECT "id", ROW_NUMBER() OVER (PARTITION BY "provider_id" ORDER BY "created_at", "id") AS position
  FROM "integration_credentials" WHERE "is_default" = true
)
UPDATE "integration_credentials" SET "is_default" = false
WHERE "id" IN (SELECT "id" FROM ranked_defaults WHERE position > 1);

CREATE UNIQUE INDEX "integration_credentials_one_default_per_provider"
  ON "integration_credentials"("provider_id") WHERE "is_default" = true;

CREATE TABLE "integration_rate_limits" (
  "id" TEXT NOT NULL,
  "count" INTEGER NOT NULL DEFAULT 0,
  "window_start" TIMESTAMP(3) NOT NULL,
  "expires_at" TIMESTAMP(3) NOT NULL,
  "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "integration_rate_limits_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "integration_rate_limits_expires_at_idx" ON "integration_rate_limits"("expires_at");

DROP INDEX IF EXISTS "integration_inbound_events_event_id_key";
CREATE UNIQUE INDEX "integration_inbound_events_provider_id_event_id_key"
  ON "integration_inbound_events"("provider_id", "event_id");
