CREATE TABLE "customers" (
  "id" SERIAL PRIMARY KEY,
  "type" TEXT NOT NULL DEFAULT 'PF',
  "name" TEXT NOT NULL,
  "trade_name" TEXT,
  "document" TEXT NOT NULL UNIQUE,
  "email" TEXT,
  "phone" TEXT,
  "status" TEXT NOT NULL DEFAULT 'active',
  "credit_limit" DOUBLE PRECISION NOT NULL DEFAULT 0,
  "notes" TEXT,
  "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX "customers_name_idx" ON "customers"("name");
CREATE INDEX "customers_status_idx" ON "customers"("status");

CREATE TABLE "customer_addresses" (
  "id" SERIAL PRIMARY KEY,
  "customer_id" INTEGER NOT NULL REFERENCES "customers"("id") ON DELETE CASCADE,
  "label" TEXT NOT NULL DEFAULT 'Principal',
  "zip" TEXT,
  "street" TEXT,
  "number" TEXT,
  "complement" TEXT,
  "district" TEXT,
  "city" TEXT,
  "state" TEXT,
  "primary" BOOLEAN NOT NULL DEFAULT TRUE,
  "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX "customer_addresses_customer_id_primary_idx" ON "customer_addresses"("customer_id", "primary");

CREATE TABLE "audit_events" (
  "id" BIGSERIAL PRIMARY KEY,
  "actor_id" TEXT,
  "action" TEXT NOT NULL,
  "entity_type" TEXT NOT NULL,
  "entity_id" TEXT,
  "correlation_id" TEXT,
  "before_data" JSONB,
  "after_data" JSONB,
  "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX "audit_events_entity_type_entity_id_created_at_idx" ON "audit_events"("entity_type", "entity_id", "created_at");
CREATE INDEX "audit_events_created_at_idx" ON "audit_events"("created_at");
