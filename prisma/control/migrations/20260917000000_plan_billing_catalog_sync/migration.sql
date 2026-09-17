-- Additive step of the "Plan becomes a read-only cache of Billing's catalog" migration.
-- Existing columns (name, monthly_price, annual_price, seats, modules, visibility,
-- owner_organization_id) are untouched, so the seat-capacity and private-plan-ownership
-- triggers from 20260909090000/20260909100000 keep working without modification. `modules`
-- keeps carrying the derived internal RBAC grant array (still required by
-- enforce_organization_plan_owner(), which copies plans.modules onto organizations.modules on
-- every plan assignment) — it is now computed by the sync job via lib/billing/module-map.ts
-- instead of being admin-authored.
--
-- This migration only adds the columns needed to mirror Billing's catalog. A follow-up
-- migration drops `visibility`/`owner_organization_id`/legacy admin-authored semantics once the
-- manual reconciliation queue (see scripts/migrate-plan-catalog.ts) is empty in production —
-- do not run it before that.
ALTER TABLE plans
  ADD COLUMN billing_code TEXT,
  ADD COLUMN card_monthly_price DOUBLE PRECISION,
  ADD COLUMN billing_modules JSONB,
  ADD COLUMN last_synced_at TIMESTAMP(3),
  ADD COLUMN raw JSONB;

CREATE UNIQUE INDEX plans_billing_code_key ON plans(billing_code);
