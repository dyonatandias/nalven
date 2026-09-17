CREATE TABLE "transactional_email_definitions" (
  "id" TEXT NOT NULL,
  "event_key" TEXT NOT NULL,
  "label" TEXT NOT NULL,
  "category" TEXT NOT NULL,
  "description" TEXT NOT NULL,
  "variables" JSONB NOT NULL,
  "critical" BOOLEAN NOT NULL DEFAULT false,
  "enabled" BOOLEAN NOT NULL DEFAULT true,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "transactional_email_definitions_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "transactional_email_definitions_event_key_key" ON "transactional_email_definitions"("event_key");
CREATE INDEX "transactional_email_definitions_category_enabled_idx" ON "transactional_email_definitions"("category", "enabled");

CREATE TABLE "transactional_email_versions" (
  "id" TEXT NOT NULL,
  "definition_id" TEXT NOT NULL,
  "version" INTEGER NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'draft',
  "subject" TEXT NOT NULL,
  "html_body" TEXT NOT NULL,
  "text_body" TEXT NOT NULL,
  "created_by" TEXT NOT NULL,
  "published_at" TIMESTAMP(3),
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "transactional_email_versions_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "transactional_email_versions_definition_id_fkey" FOREIGN KEY ("definition_id") REFERENCES "transactional_email_definitions"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "transactional_email_versions_definition_id_version_key" ON "transactional_email_versions"("definition_id", "version");
CREATE INDEX "transactional_email_versions_definition_id_status_version_idx" ON "transactional_email_versions"("definition_id", "status", "version");

CREATE TABLE "transactional_email_deliveries" (
  "id" TEXT NOT NULL,
  "event_id" TEXT NOT NULL,
  "event_key" TEXT NOT NULL,
  "version_id" TEXT,
  "credential_id" TEXT,
  "recipient_masked" TEXT NOT NULL,
  "payload" JSONB NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'pending',
  "attempts" INTEGER NOT NULL DEFAULT 0,
  "max_attempts" INTEGER NOT NULL DEFAULT 8,
  "remote_message_id" TEXT,
  "last_error" TEXT,
  "next_attempt_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "sent_at" TIMESTAMP(3),
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "transactional_email_deliveries_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "transactional_email_deliveries_version_id_fkey" FOREIGN KEY ("version_id") REFERENCES "transactional_email_versions"("id") ON DELETE SET NULL ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "transactional_email_deliveries_event_id_key" ON "transactional_email_deliveries"("event_id");
CREATE INDEX "transactional_email_deliveries_status_next_attempt_at_idx" ON "transactional_email_deliveries"("status", "next_attempt_at");
CREATE INDEX "transactional_email_deliveries_event_key_created_at_idx" ON "transactional_email_deliveries"("event_key", "created_at");
