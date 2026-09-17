CREATE INDEX IF NOT EXISTS "integration_ai_usage_created_at_status_idx"
  ON "integration_ai_usage"("created_at", "status");

CREATE INDEX IF NOT EXISTS "integration_ai_usage_created_at_model_idx"
  ON "integration_ai_usage"("created_at", "model");

CREATE INDEX IF NOT EXISTS "integration_ai_usage_created_at_key_source_idx"
  ON "integration_ai_usage"("created_at", "key_source");

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'integration_ai_usage_units_cost_check'
  ) THEN
    ALTER TABLE "integration_ai_usage"
      ADD CONSTRAINT "integration_ai_usage_units_cost_check"
      CHECK ("units" >= 0 AND "cost" >= 0);
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'integration_ai_usage_status_check'
  ) THEN
    ALTER TABLE "integration_ai_usage"
      ADD CONSTRAINT "integration_ai_usage_status_check"
      CHECK ("status" IN ('completed', 'failed', 'incomplete', 'in_progress'));
  END IF;
END $$;
