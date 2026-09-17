ALTER TABLE "integration_ai_usage"
  ADD COLUMN "request_id" TEXT,
  ADD COLUMN "input_tokens" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "output_tokens" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "latency_ms" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "key_source" TEXT NOT NULL DEFAULT 'platform',
  ADD COLUMN "status" TEXT NOT NULL DEFAULT 'completed';
ALTER TABLE "integration_ai_usage" ADD CONSTRAINT "integration_ai_usage_tokens_check" CHECK ("input_tokens" >= 0 AND "output_tokens" >= 0 AND "latency_ms" >= 0);
ALTER TABLE "integration_ai_usage" ADD CONSTRAINT "integration_ai_usage_key_source_check" CHECK ("key_source" IN ('platform','byok'));
CREATE INDEX "integration_ai_usage_request_id_idx" ON "integration_ai_usage"("request_id");
