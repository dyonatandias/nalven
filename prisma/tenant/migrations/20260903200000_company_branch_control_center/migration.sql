ALTER TABLE "branches"
  ADD COLUMN "version" INTEGER NOT NULL DEFAULT 1,
  ADD COLUMN "parent_branch_id" INTEGER,
  ADD COLUMN "opening_date" DATE,
  ADD COLUMN "activity_code" TEXT,
  ADD COLUMN "notes" TEXT,
  ADD COLUMN "state_registration_exempt" BOOLEAN NOT NULL DEFAULT false;

ALTER TABLE "branches"
  ADD CONSTRAINT "branches_parent_branch_id_fkey"
  FOREIGN KEY ("parent_branch_id") REFERENCES "branches"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "branches"
  ADD CONSTRAINT "branches_type_check" CHECK ("type" IN ('headquarters', 'branch')),
  ADD CONSTRAINT "branches_status_check" CHECK ("status" IN ('planned', 'active', 'inactive')),
  ADD CONSTRAINT "branches_parent_not_self_check" CHECK ("parent_branch_id" IS NULL OR "parent_branch_id" <> "id"),
  ADD CONSTRAINT "branches_activity_code_check" CHECK ("activity_code" IS NULL OR "activity_code" ~ '^[0-9]{7}$');

CREATE INDEX "branches_parent_branch_id_status_idx" ON "branches"("parent_branch_id", "status");
CREATE INDEX "branches_state_status_idx" ON "branches"("state", "status");

ALTER TABLE "branch_settings"
  ADD COLUMN "sales_enabled" BOOLEAN NOT NULL DEFAULT true,
  ADD COLUMN "purchases_enabled" BOOLEAN NOT NULL DEFAULT true,
  ADD COLUMN "stock_enabled" BOOLEAN NOT NULL DEFAULT true,
  ADD COLUMN "fiscal_enabled" BOOLEAN NOT NULL DEFAULT true,
  ADD COLUMN "services_enabled" BOOLEAN NOT NULL DEFAULT true,
  ADD COLUMN "business_hours" JSONB NOT NULL DEFAULT '[{"day":0,"enabled":false,"opensAt":"08:00","closesAt":"18:00"},{"day":1,"enabled":true,"opensAt":"08:00","closesAt":"18:00"},{"day":2,"enabled":true,"opensAt":"08:00","closesAt":"18:00"},{"day":3,"enabled":true,"opensAt":"08:00","closesAt":"18:00"},{"day":4,"enabled":true,"opensAt":"08:00","closesAt":"18:00"},{"day":5,"enabled":true,"opensAt":"08:00","closesAt":"18:00"},{"day":6,"enabled":false,"opensAt":"08:00","closesAt":"12:00"}]'::jsonb;

CREATE INDEX "branch_settings_operational_capabilities_idx"
  ON "branch_settings"("sales_enabled", "purchases_enabled", "stock_enabled", "fiscal_enabled", "services_enabled");
