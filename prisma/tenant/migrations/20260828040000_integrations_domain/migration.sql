CREATE TABLE "integration_providers" (
  "id" TEXT NOT NULL, "family" TEXT NOT NULL, "label" TEXT NOT NULL, "description" TEXT NOT NULL,
  "recipient_type" TEXT NOT NULL DEFAULT 'none', "auth_type" TEXT NOT NULL DEFAULT 'api_key',
  "capabilities" JSONB NOT NULL, "credential_schema" JSONB NOT NULL, "supports_test" BOOLEAN NOT NULL DEFAULT true,
  "docs_url" TEXT, "priority" INTEGER NOT NULL DEFAULT 100,
  CONSTRAINT "integration_providers_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "integration_providers_family_priority_idx" ON "integration_providers"("family", "priority");

CREATE TABLE "integration_credentials" (
  "id" TEXT NOT NULL, "provider_id" TEXT NOT NULL, "label" TEXT NOT NULL DEFAULT '', "enabled" BOOLEAN NOT NULL DEFAULT false,
  "config" JSONB NOT NULL, "secrets_cipher_text" TEXT, "sandbox" BOOLEAN NOT NULL DEFAULT false, "is_default" BOOLEAN NOT NULL DEFAULT false,
  "last_test_at" TIMESTAMP(3), "last_test_ok" BOOLEAN, "last_test_message" TEXT,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "integration_credentials_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "integration_credentials_provider_id_fkey" FOREIGN KEY ("provider_id") REFERENCES "integration_providers"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
CREATE INDEX "integration_credentials_provider_id_idx" ON "integration_credentials"("provider_id");
CREATE INDEX "integration_credentials_provider_id_is_default_idx" ON "integration_credentials"("provider_id", "is_default");
CREATE INDEX "integration_credentials_enabled_idx" ON "integration_credentials"("enabled");
ALTER TABLE "marketplace_channels" ADD COLUMN "credential_id" TEXT;
ALTER TABLE "marketplace_channels" ADD CONSTRAINT "marketplace_channels_credential_id_fkey" FOREIGN KEY ("credential_id") REFERENCES "integration_credentials"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
CREATE INDEX "marketplace_channels_credential_id_idx" ON "marketplace_channels"("credential_id");

CREATE TABLE "integration_routing" (
  "context" TEXT NOT NULL, "provider_id" TEXT, "fallback_provider_id" TEXT, "enabled" BOOLEAN NOT NULL DEFAULT true,
  "config" JSONB NOT NULL, "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "integration_routing_pkey" PRIMARY KEY ("context")
);
CREATE TABLE "integration_health_state" (
  "provider_id" TEXT NOT NULL, "status" TEXT NOT NULL DEFAULT 'unknown', "since" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "last_check_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, "consecutive_failures" INTEGER NOT NULL DEFAULT 0,
  "last_alert_at" TIMESTAMP(3), "alerts_today" INTEGER NOT NULL DEFAULT 0, "alerts_date" DATE, "events" JSONB NOT NULL,
  CONSTRAINT "integration_health_state_pkey" PRIMARY KEY ("provider_id")
);
CREATE TABLE "integration_health_log" (
  "id" TEXT NOT NULL, "provider_id" TEXT NOT NULL, "credential_id" TEXT, "success" BOOLEAN NOT NULL,
  "latency_ms" INTEGER NOT NULL, "message" TEXT NOT NULL, "details" JSONB NOT NULL, "triggered_by" TEXT NOT NULL DEFAULT 'manual',
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, CONSTRAINT "integration_health_log_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "integration_health_log_provider_id_fkey" FOREIGN KEY ("provider_id") REFERENCES "integration_providers"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "integration_health_log_credential_id_fkey" FOREIGN KEY ("credential_id") REFERENCES "integration_credentials"("id") ON DELETE SET NULL ON UPDATE CASCADE
);
CREATE INDEX "integration_health_log_provider_id_created_at_idx" ON "integration_health_log"("provider_id", "created_at");
CREATE INDEX "integration_health_log_credential_id_created_at_idx" ON "integration_health_log"("credential_id", "created_at");

CREATE TABLE "integration_settings" (
  "id" INTEGER NOT NULL DEFAULT 1, "general" JSONB NOT NULL, "email" JSONB NOT NULL, "smtp" JSONB NOT NULL,
  "whatsapp" JSONB NOT NULL, "webhook_otp" JSONB NOT NULL, "otp" JSONB NOT NULL, "ai" JSONB NOT NULL,
  "monitor" JSONB NOT NULL, "payment" JSONB NOT NULL, "shipping" JSONB NOT NULL, "storage" JSONB NOT NULL,
  "updated_by" TEXT, "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "integration_settings_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "integration_webhook_endpoints" (
  "id" TEXT NOT NULL, "name" TEXT NOT NULL, "topic" TEXT NOT NULL, "delivery_url" TEXT NOT NULL,
  "secret_cipher" TEXT NOT NULL, "secret_preview" TEXT NOT NULL, "status" TEXT NOT NULL DEFAULT 'active',
  "api_version" TEXT NOT NULL DEFAULT 'v1', "failure_count" INTEGER NOT NULL DEFAULT 0,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "integration_webhook_endpoints_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "integration_webhook_endpoints_topic_status_idx" ON "integration_webhook_endpoints"("topic", "status");
CREATE TABLE "integration_webhook_deliveries" (
  "id" TEXT NOT NULL, "endpoint_id" TEXT NOT NULL, "event_id" TEXT NOT NULL, "topic" TEXT NOT NULL, "payload" JSONB NOT NULL,
  "attempts" INTEGER NOT NULL DEFAULT 0, "state" TEXT NOT NULL DEFAULT 'pending', "response_code" INTEGER,
  "response_body" TEXT, "duration_ms" INTEGER, "next_attempt_at" TIMESTAMP(3) DEFAULT CURRENT_TIMESTAMP,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, "delivered_at" TIMESTAMP(3),
  CONSTRAINT "integration_webhook_deliveries_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "integration_webhook_deliveries_endpoint_id_fkey" FOREIGN KEY ("endpoint_id") REFERENCES "integration_webhook_endpoints"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "integration_webhook_deliveries_event_id_key" ON "integration_webhook_deliveries"("event_id");
CREATE INDEX "integration_webhook_deliveries_state_next_attempt_at_idx" ON "integration_webhook_deliveries"("state", "next_attempt_at");
CREATE INDEX "integration_webhook_deliveries_endpoint_id_created_at_idx" ON "integration_webhook_deliveries"("endpoint_id", "created_at");

CREATE TABLE "integration_queue" (
  "id" TEXT NOT NULL, "event_type" TEXT NOT NULL, "trigger" TEXT, "context" TEXT NOT NULL, "provider_id" TEXT,
  "credential_id" TEXT, "channel" TEXT NOT NULL, "recipient" TEXT, "recipient_masked" TEXT, "payload" JSONB NOT NULL,
  "remote_message_id" TEXT, "attempts" INTEGER NOT NULL DEFAULT 0, "max_attempts" INTEGER NOT NULL DEFAULT 6,
  "state" TEXT NOT NULL DEFAULT 'pending', "failure_type" TEXT, "last_error" TEXT,
  "next_attempt_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, "claimed_at" TIMESTAMP(3), "finished_at" TIMESTAMP(3),
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "integration_queue_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "integration_queue_state_next_attempt_at_idx" ON "integration_queue"("state", "next_attempt_at");
CREATE INDEX "integration_queue_channel_state_created_at_idx" ON "integration_queue"("channel", "state", "created_at");
CREATE INDEX "integration_queue_context_created_at_idx" ON "integration_queue"("context", "created_at");

CREATE TABLE "integration_opt_outs" (
  "id" TEXT NOT NULL, "contact_hash" TEXT NOT NULL, "contact_masked" TEXT NOT NULL, "channel" TEXT NOT NULL,
  "source" TEXT NOT NULL, "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "integration_opt_outs_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "integration_opt_outs_contact_hash_channel_key" ON "integration_opt_outs"("contact_hash", "channel");
CREATE INDEX "integration_opt_outs_created_at_idx" ON "integration_opt_outs"("created_at");
CREATE TABLE "integration_audit_log" (
  "id" TEXT NOT NULL, "user_id" TEXT NOT NULL, "action" TEXT NOT NULL, "target_type" TEXT NOT NULL, "target_id" TEXT NOT NULL,
  "before_data" JSONB, "after_data" JSONB, "ip" TEXT, "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "integration_audit_log_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "integration_audit_log_target_type_target_id_idx" ON "integration_audit_log"("target_type", "target_id");
CREATE INDEX "integration_audit_log_created_at_idx" ON "integration_audit_log"("created_at");

CREATE TABLE "integration_oauth_states" (
  "state" TEXT NOT NULL, "platform" TEXT NOT NULL, "user_id" TEXT NOT NULL, "redirect_uri" TEXT NOT NULL,
  "code_verifier" TEXT, "expires_at" TIMESTAMP(3) NOT NULL, "used_at" TIMESTAMP(3), "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "integration_oauth_states_pkey" PRIMARY KEY ("state")
);
CREATE INDEX "integration_oauth_states_expires_at_idx" ON "integration_oauth_states"("expires_at");
CREATE TABLE "integration_templates" (
  "id" TEXT NOT NULL, "provider_id" TEXT NOT NULL, "credential_id" TEXT, "name" TEXT NOT NULL, "language" TEXT NOT NULL,
  "status" TEXT NOT NULL, "category" TEXT NOT NULL, "components" JSONB NOT NULL, "synced_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "integration_templates_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "integration_templates_provider_id_fkey" FOREIGN KEY ("provider_id") REFERENCES "integration_providers"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "integration_templates_credential_id_fkey" FOREIGN KEY ("credential_id") REFERENCES "integration_credentials"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "integration_templates_provider_id_credential_id_name_language_key" ON "integration_templates"("provider_id", "credential_id", "name", "language");
CREATE INDEX "integration_templates_provider_id_status_idx" ON "integration_templates"("provider_id", "status");
CREATE TABLE "integration_ai_usage" (
  "id" TEXT NOT NULL, "feature" TEXT NOT NULL, "model" TEXT NOT NULL, "units" INTEGER NOT NULL DEFAULT 1,
  "cost" DOUBLE PRECISION NOT NULL DEFAULT 0, "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "integration_ai_usage_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "integration_ai_usage_created_at_feature_idx" ON "integration_ai_usage"("created_at", "feature");
CREATE TABLE "integration_media_migrations" (
  "id" TEXT NOT NULL, "status" TEXT NOT NULL DEFAULT 'pending', "total" INTEGER NOT NULL DEFAULT 0,
  "processed" INTEGER NOT NULL DEFAULT 0, "failed" INTEGER NOT NULL DEFAULT 0, "cursor" TEXT, "details" JSONB NOT NULL,
  "started_at" TIMESTAMP(3), "finished_at" TIMESTAMP(3), "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL, CONSTRAINT "integration_media_migrations_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "integration_media_migrations_status_created_at_idx" ON "integration_media_migrations"("status", "created_at");

CREATE TABLE "integration_inbound_events" (
  "id" TEXT NOT NULL, "event_id" TEXT NOT NULL, "provider_id" TEXT NOT NULL, "topic" TEXT NOT NULL,
  "payload" JSONB NOT NULL, "status" TEXT NOT NULL DEFAULT 'pending', "received_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "processed_at" TIMESTAMP(3), "error" TEXT, CONSTRAINT "integration_inbound_events_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "integration_inbound_events_event_id_key" ON "integration_inbound_events"("event_id");
CREATE INDEX "integration_inbound_events_provider_id_status_received_at_idx" ON "integration_inbound_events"("provider_id", "status", "received_at");

CREATE TABLE "integration_otp_challenges" (
  "id" TEXT NOT NULL, "context" TEXT NOT NULL, "recipient_hash" TEXT NOT NULL, "recipient_masked" TEXT NOT NULL,
  "ip_hash" TEXT NOT NULL, "code_hash" TEXT NOT NULL, "attempts" INTEGER NOT NULL DEFAULT 0, "max_attempts" INTEGER NOT NULL DEFAULT 5,
  "fraud_score" INTEGER NOT NULL DEFAULT 0, "expires_at" TIMESTAMP(3) NOT NULL, "verified_at" TIMESTAMP(3),
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, CONSTRAINT "integration_otp_challenges_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "integration_otp_challenges_recipient_hash_context_created_at_idx" ON "integration_otp_challenges"("recipient_hash", "context", "created_at");
CREATE INDEX "integration_otp_challenges_ip_hash_context_created_at_idx" ON "integration_otp_challenges"("ip_hash", "context", "created_at");
CREATE INDEX "integration_otp_challenges_expires_at_idx" ON "integration_otp_challenges"("expires_at");

ALTER TABLE "media_assets" ADD COLUMN "remote_key" TEXT;
ALTER TABLE "media_assets" ADD COLUMN "remote_url" TEXT;
ALTER TABLE "media_assets" ADD COLUMN "offloaded_at" TIMESTAMP(3);
ALTER TABLE "media_assets" ADD COLUMN "local_delete_after" TIMESTAMP(3);
ALTER TABLE "media_assets" ADD COLUMN "local_available" BOOLEAN NOT NULL DEFAULT true;
CREATE INDEX "media_assets_offloaded_at_local_delete_after_idx" ON "media_assets"("offloaded_at", "local_delete_after");

INSERT INTO "integration_settings" ("id","general","email","smtp","whatsapp","webhook_otp","otp","ai","monitor","payment","shipping","storage","updated_at") VALUES
(1,'{}','{}','{}','{}','{}','{}','{}','{}','{}','{}','{}',CURRENT_TIMESTAMP)
ON CONFLICT ("id") DO NOTHING;
