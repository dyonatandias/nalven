CREATE TABLE "site_contents" (
  "key" TEXT PRIMARY KEY, "group" TEXT NOT NULL, "label" TEXT NOT NULL,
  "type" TEXT NOT NULL DEFAULT 'text', "value" JSONB NOT NULL,
  "public" BOOLEAN NOT NULL DEFAULT true, "sort_order" INTEGER NOT NULL DEFAULT 0,
  "updated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX "site_contents_group_sort_order_idx" ON "site_contents"("group", "sort_order");

CREATE TABLE "email_templates" (
  "id" TEXT PRIMARY KEY, "name" TEXT NOT NULL, "subject" TEXT NOT NULL,
  "body" TEXT NOT NULL, "active" BOOLEAN NOT NULL DEFAULT true,
  "updated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE "webhook_endpoints" (
  "id" TEXT PRIMARY KEY, "name" TEXT NOT NULL, "url" TEXT NOT NULL,
  "events" JSONB NOT NULL, "secret" TEXT NOT NULL, "active" BOOLEAN NOT NULL DEFAULT true,
  "last_at" TIMESTAMPTZ, "last_status" INTEGER,
  "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE "api_keys" (
  "id" TEXT PRIMARY KEY, "name" TEXT NOT NULL, "prefix" TEXT NOT NULL,
  "key_hash" TEXT NOT NULL UNIQUE, "scopes" JSONB NOT NULL, "user_id" TEXT NOT NULL,
  "last_used_at" TIMESTAMPTZ, "expires_at" TIMESTAMPTZ, "revoked_at" TIMESTAMPTZ,
  "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "api_keys_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE
);
CREATE INDEX "api_keys_user_id_revoked_at_idx" ON "api_keys"("user_id", "revoked_at");

CREATE TABLE "announcements" (
  "id" TEXT PRIMARY KEY, "title" TEXT NOT NULL, "message" TEXT NOT NULL,
  "audience" TEXT NOT NULL DEFAULT 'all', "level" TEXT NOT NULL DEFAULT 'info',
  "active" BOOLEAN NOT NULL DEFAULT true, "starts_at" TIMESTAMPTZ, "ends_at" TIMESTAMPTZ,
  "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX "announcements_active_starts_at_idx" ON "announcements"("active", "starts_at");
