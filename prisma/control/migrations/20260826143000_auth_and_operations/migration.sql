CREATE TABLE "users" (
  "id" TEXT PRIMARY KEY, "name" TEXT NOT NULL, "email" TEXT NOT NULL UNIQUE,
  "password_hash" TEXT NOT NULL, "role" TEXT NOT NULL DEFAULT 'user',
  "status" TEXT NOT NULL DEFAULT 'active', "email_verified_at" TIMESTAMP(3),
  "last_login_at" TIMESTAMP(3), "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL
);
CREATE INDEX "users_role_status_idx" ON "users"("role", "status");
CREATE TABLE "sessions" (
  "id" TEXT PRIMARY KEY, "user_id" TEXT NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
  "token_hash" TEXT NOT NULL UNIQUE, "expires_at" TIMESTAMP(3) NOT NULL,
  "ip_address" TEXT, "user_agent" TEXT, "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX "sessions_user_id_expires_at_idx" ON "sessions"("user_id", "expires_at");
CREATE TABLE "memberships" (
  "id" TEXT PRIMARY KEY, "user_id" TEXT NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
  "organization_id" TEXT NOT NULL REFERENCES "organizations"("id") ON DELETE CASCADE,
  "role" TEXT NOT NULL DEFAULT 'member', "status" TEXT NOT NULL DEFAULT 'active',
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE("user_id", "organization_id")
);
CREATE INDEX "memberships_organization_id_status_idx" ON "memberships"("organization_id", "status");
CREATE TABLE "audit_logs" (
  "id" TEXT PRIMARY KEY, "user_id" TEXT REFERENCES "users"("id") ON DELETE SET NULL,
  "action" TEXT NOT NULL, "entity_type" TEXT NOT NULL, "entity_id" TEXT,
  "ip_address" TEXT, "metadata" JSONB, "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX "audit_logs_created_at_idx" ON "audit_logs"("created_at");
CREATE INDEX "audit_logs_entity_type_entity_id_idx" ON "audit_logs"("entity_type", "entity_id");
CREATE TABLE "integrations" (
  "id" TEXT PRIMARY KEY, "organization_id" TEXT REFERENCES "organizations"("id") ON DELETE CASCADE,
  "provider" TEXT NOT NULL, "name" TEXT NOT NULL, "status" TEXT NOT NULL DEFAULT 'disconnected',
  "config" JSONB, "last_sync_at" TIMESTAMP(3), "last_error" TEXT,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, "updated_at" TIMESTAMP(3) NOT NULL,
  UNIQUE("organization_id", "provider")
);
CREATE INDEX "integrations_status_idx" ON "integrations"("status");
CREATE TABLE "backup_runs" (
  "id" TEXT PRIMARY KEY, "database_name" TEXT NOT NULL, "kind" TEXT NOT NULL,
  "status" TEXT NOT NULL, "file_name" TEXT, "size_bytes" BIGINT, "error" TEXT,
  "started_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, "finished_at" TIMESTAMP(3)
);
CREATE INDEX "backup_runs_started_at_idx" ON "backup_runs"("started_at");
CREATE TABLE "export_jobs" (
  "id" TEXT PRIMARY KEY, "organization_id" TEXT REFERENCES "organizations"("id") ON DELETE SET NULL,
  "requested_by_id" TEXT NOT NULL REFERENCES "users"("id"), "type" TEXT NOT NULL,
  "format" TEXT NOT NULL, "status" TEXT NOT NULL DEFAULT 'pending', "file_path" TEXT,
  "error" TEXT, "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, "completed_at" TIMESTAMP(3)
);
CREATE INDEX "export_jobs_status_created_at_idx" ON "export_jobs"("status", "created_at");
CREATE TABLE "provisioning_jobs" (
  "id" TEXT PRIMARY KEY, "organization_id" TEXT NOT NULL REFERENCES "organizations"("id") ON DELETE CASCADE,
  "type" TEXT NOT NULL DEFAULT 'create_database', "status" TEXT NOT NULL DEFAULT 'pending',
  "attempts" INTEGER NOT NULL DEFAULT 0, "error" TEXT,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, "started_at" TIMESTAMP(3), "finished_at" TIMESTAMP(3)
);
CREATE INDEX "provisioning_jobs_status_created_at_idx" ON "provisioning_jobs"("status", "created_at");
CREATE TABLE "system_settings" (
  "key" TEXT PRIMARY KEY, "value" JSONB NOT NULL, "updated_at" TIMESTAMP(3) NOT NULL
);
