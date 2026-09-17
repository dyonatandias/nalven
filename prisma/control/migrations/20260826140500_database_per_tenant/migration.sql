DROP TABLE IF EXISTS "sale_items" CASCADE;
DROP TABLE IF EXISTS "stock_movements" CASCADE;
DROP TABLE IF EXISTS "sales" CASCADE;
DROP TABLE IF EXISTS "products" CASCADE;
DROP TABLE IF EXISTS "saas_invoices" CASCADE;
DROP TABLE IF EXISTS "saas_tickets" CASCADE;
DROP TABLE IF EXISTS "saas_tenants" CASCADE;
DROP TABLE IF EXISTS "saas_plans" CASCADE;

CREATE TABLE "plans" (
  "id" TEXT PRIMARY KEY, "name" TEXT NOT NULL, "monthly_price" DOUBLE PRECISION NOT NULL,
  "annual_price" DOUBLE PRECISION NOT NULL, "seats" INTEGER NOT NULL, "modules" JSONB NOT NULL,
  "active" BOOLEAN NOT NULL DEFAULT true
);
CREATE TABLE "organizations" (
  "id" TEXT PRIMARY KEY, "slug" TEXT NOT NULL UNIQUE, "name" TEXT NOT NULL,
  "document" TEXT NOT NULL UNIQUE, "owner_name" TEXT NOT NULL, "email" TEXT NOT NULL,
  "plan_id" TEXT NOT NULL REFERENCES "plans"("id"), "status" TEXT NOT NULL,
  "mrr" DOUBLE PRECISION NOT NULL DEFAULT 0,
  "seats_used" INTEGER NOT NULL DEFAULT 1, "modules" JSONB NOT NULL,
  "usage_score" INTEGER NOT NULL DEFAULT 0, "trial_ends_at" TEXT,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL
);
CREATE INDEX "organizations_status_idx" ON "organizations"("status");
CREATE TABLE "tenant_databases" (
  "id" TEXT PRIMARY KEY, "organization_id" TEXT NOT NULL UNIQUE REFERENCES "organizations"("id") ON DELETE CASCADE,
  "database_name" TEXT NOT NULL UNIQUE, "config_key" TEXT NOT NULL UNIQUE,
  "schema_version" TEXT NOT NULL DEFAULT 'initial', "status" TEXT NOT NULL DEFAULT 'active',
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, "updated_at" TIMESTAMP(3) NOT NULL
);
CREATE TABLE "organization_domains" (
  "id" TEXT PRIMARY KEY, "organization_id" TEXT NOT NULL REFERENCES "organizations"("id") ON DELETE CASCADE,
  "hostname" TEXT NOT NULL UNIQUE, "primary" BOOLEAN NOT NULL DEFAULT false, "verified_at" TIMESTAMP(3)
);
CREATE TABLE "invoices" (
  "id" TEXT PRIMARY KEY, "organization_id" TEXT NOT NULL REFERENCES "organizations"("id"),
  "description" TEXT NOT NULL, "amount" DOUBLE PRECISION NOT NULL, "status" TEXT NOT NULL,
  "due_at" TEXT NOT NULL, "paid_at" TEXT
);
CREATE INDEX "invoices_organization_id_idx" ON "invoices"("organization_id");
CREATE TABLE "tickets" (
  "id" TEXT PRIMARY KEY, "organization_id" TEXT NOT NULL REFERENCES "organizations"("id"),
  "subject" TEXT NOT NULL, "priority" TEXT NOT NULL, "status" TEXT NOT NULL, "assignee" TEXT NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, "updated_at" TIMESTAMP(3) NOT NULL
);
CREATE INDEX "tickets_status_idx" ON "tickets"("status");
