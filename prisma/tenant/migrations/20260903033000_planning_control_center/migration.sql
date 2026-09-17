ALTER TABLE "budgets"
  ALTER COLUMN "status" SET DEFAULT 'draft',
  ADD COLUMN "version" INTEGER NOT NULL DEFAULT 1,
  ADD COLUMN "notes" TEXT,
  ADD COLUMN "approved_by" TEXT,
  ADD COLUMN "approved_at" TIMESTAMPTZ,
  ADD COLUMN "locked_at" TIMESTAMPTZ,
  ADD COLUMN "updated_at" TIMESTAMPTZ NOT NULL DEFAULT now();

ALTER TABLE "budget_lines"
  ADD COLUMN "revenue_cents" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "cogs_cents" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "expense_cents" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "notes" TEXT;

UPDATE "budget_lines"
SET "revenue_cents" = round("revenue" * 100)::integer,
    "expense_cents" = round("expense" * 100)::integer;

ALTER TABLE "budget_lines"
  ADD CONSTRAINT "budget_lines_month_check" CHECK ("month" BETWEEN 1 AND 12),
  ADD CONSTRAINT "budget_lines_values_check" CHECK ("revenue_cents" >= 0 AND "cogs_cents" >= 0 AND "expense_cents" >= 0);

ALTER TABLE "business_goals"
  ADD COLUMN "unit" TEXT NOT NULL DEFAULT 'currency',
  ADD COLUMN "direction" TEXT NOT NULL DEFAULT 'increase',
  ADD COLUMN "baseline" DOUBLE PRECISION NOT NULL DEFAULT 0,
  ADD COLUMN "owner" TEXT,
  ADD COLUMN "weight" INTEGER NOT NULL DEFAULT 100,
  ADD COLUMN "notes" TEXT,
  ADD COLUMN "started_at" DATE NOT NULL DEFAULT CURRENT_DATE,
  ADD COLUMN "completed_at" TIMESTAMPTZ;

ALTER TABLE "business_goals"
  ADD CONSTRAINT "business_goals_weight_check" CHECK ("weight" BETWEEN 1 AND 100),
  ADD CONSTRAINT "business_goals_direction_check" CHECK ("direction" IN ('increase', 'decrease')),
  ADD CONSTRAINT "business_goals_unit_check" CHECK ("unit" IN ('currency', 'percent', 'number'));

CREATE TABLE "business_goal_updates" (
  "id" SERIAL PRIMARY KEY,
  "goal_id" INTEGER NOT NULL REFERENCES "business_goals"("id") ON DELETE CASCADE,
  "value" DOUBLE PRECISION NOT NULL,
  "note" TEXT,
  "created_by" TEXT NOT NULL,
  "created_at" TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX "business_goal_updates_goal_id_created_at_idx" ON "business_goal_updates"("goal_id", "created_at");

INSERT INTO "business_goal_updates" ("goal_id", "value", "note", "created_by", "created_at")
SELECT "id", "current", 'Histórico inicial migrado', "created_by", "created_at" FROM "business_goals";

CREATE TABLE "dre_category_rules" (
  "id" SERIAL PRIMARY KEY,
  "category_key" TEXT NOT NULL UNIQUE,
  "category_label" TEXT NOT NULL,
  "dre_group" TEXT NOT NULL,
  "active" BOOLEAN NOT NULL DEFAULT true,
  "created_by" TEXT NOT NULL,
  "created_at" TIMESTAMPTZ NOT NULL DEFAULT now(),
  "updated_at" TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT "dre_category_rules_group_check" CHECK ("dre_group" IN ('revenue', 'deductions', 'cogs', 'operating_expense', 'financial_result', 'income_tax', 'excluded'))
);
CREATE INDEX "dre_category_rules_dre_group_active_idx" ON "dre_category_rules"("dre_group", "active");

CREATE OR REPLACE FUNCTION "sync_budget_line_amounts"() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'INSERT' OR NEW."revenue_cents" IS DISTINCT FROM OLD."revenue_cents" THEN
    NEW."revenue" := NEW."revenue_cents" / 100.0;
  ELSIF NEW."revenue" IS DISTINCT FROM OLD."revenue" THEN
    NEW."revenue_cents" := round(NEW."revenue" * 100)::integer;
  END IF;
  IF TG_OP = 'INSERT' OR NEW."expense_cents" IS DISTINCT FROM OLD."expense_cents" THEN
    NEW."expense" := NEW."expense_cents" / 100.0;
  ELSIF NEW."expense" IS DISTINCT FROM OLD."expense" THEN
    NEW."expense_cents" := round(NEW."expense" * 100)::integer;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "budget_lines_sync_amounts"
BEFORE INSERT OR UPDATE OF "revenue", "expense", "revenue_cents", "expense_cents" ON "budget_lines"
FOR EACH ROW EXECUTE FUNCTION "sync_budget_line_amounts"();
