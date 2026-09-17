CREATE TABLE "branches" (
  "id" SERIAL PRIMARY KEY,
  "code" TEXT NOT NULL UNIQUE,
  "name" TEXT NOT NULL,
  "legal_name" TEXT NOT NULL,
  "document" TEXT NOT NULL UNIQUE,
  "type" TEXT NOT NULL DEFAULT 'branch',
  "status" TEXT NOT NULL DEFAULT 'active',
  "state_registration" TEXT,
  "municipal_registration" TEXT,
  "email" TEXT,
  "phone" TEXT,
  "zip" TEXT,
  "street" TEXT,
  "number" TEXT,
  "complement" TEXT,
  "district" TEXT,
  "city" TEXT,
  "state" TEXT,
  "timezone" TEXT NOT NULL DEFAULT 'America/Sao_Paulo',
  "primary" BOOLEAN NOT NULL DEFAULT false,
  "default_warehouse_id" INTEGER UNIQUE,
  "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX "branches_status_name_idx" ON "branches"("status", "name");
CREATE UNIQUE INDEX "branches_single_primary_idx" ON "branches"("primary") WHERE "primary" = true;

ALTER TABLE "warehouses" ADD COLUMN "branch_id" INTEGER REFERENCES "branches"("id") ON DELETE SET NULL;
CREATE INDEX "warehouses_branch_id_idx" ON "warehouses"("branch_id");
ALTER TABLE "branches" ADD CONSTRAINT "branches_default_warehouse_id_fkey" FOREIGN KEY ("default_warehouse_id") REFERENCES "warehouses"("id") ON DELETE SET NULL;

CREATE TABLE "branch_settings" (
  "id" SERIAL PRIMARY KEY,
  "branch_id" INTEGER NOT NULL UNIQUE REFERENCES "branches"("id") ON DELETE CASCADE,
  "tax_regime" TEXT NOT NULL DEFAULT 'simples_nacional',
  "fiscal_environment" TEXT NOT NULL DEFAULT 'homologation',
  "nfe_series" INTEGER NOT NULL DEFAULT 1,
  "nfce_series" INTEGER NOT NULL DEFAULT 1,
  "nfse_series" INTEGER NOT NULL DEFAULT 1,
  "next_nfe_number" INTEGER NOT NULL DEFAULT 1,
  "next_nfce_number" INTEGER NOT NULL DEFAULT 1,
  "next_nfse_number" INTEGER NOT NULL DEFAULT 1,
  "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

ALTER TABLE "tenant_user_profiles" ADD COLUMN "active_branch_id" INTEGER REFERENCES "branches"("id") ON DELETE SET NULL;
CREATE INDEX "tenant_user_profiles_active_branch_id_idx" ON "tenant_user_profiles"("active_branch_id");
