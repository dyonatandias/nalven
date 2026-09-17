CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE "analytics_sessions" (
  "id" TEXT PRIMARY KEY,
  "session_hash" VARCHAR(64) NOT NULL UNIQUE,
  "visitor_hash" VARCHAR(64) NOT NULL,
  "ip_hash" VARCHAR(64) NOT NULL,
  "page_type" VARCHAR(30) NOT NULL,
  "page_path" VARCHAR(500) NOT NULL,
  "device_type" VARCHAR(10) NOT NULL,
  "session_started_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "last_seen_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX "analytics_sessions_visitor_hash_idx" ON "analytics_sessions"("visitor_hash");
CREATE INDEX "analytics_sessions_page_type_idx" ON "analytics_sessions"("page_type");
CREATE INDEX "analytics_sessions_last_seen_at_idx" ON "analytics_sessions"("last_seen_at");

CREATE TABLE "analytics_events" (
  "id" BIGSERIAL PRIMARY KEY,
  "session_hash" VARCHAR(64) NOT NULL,
  "visitor_hash" VARCHAR(64) NOT NULL,
  "ip_hash" VARCHAR(64) NOT NULL,
  "event_kind" VARCHAR(20) NOT NULL DEFAULT 'page_view',
  "action" VARCHAR(30),
  "page_type" VARCHAR(30) NOT NULL,
  "page_path" VARCHAR(500) NOT NULL,
  "referrer_source" VARCHAR(120) NOT NULL DEFAULT 'direct',
  "device_type" VARCHAR(10) NOT NULL,
  "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX "analytics_events_created_at_idx" ON "analytics_events"("created_at");
CREATE INDEX "analytics_events_page_type_created_at_idx" ON "analytics_events"("page_type", "created_at");
CREATE INDEX "analytics_events_event_kind_created_at_idx" ON "analytics_events"("event_kind", "created_at");
CREATE INDEX "analytics_events_session_hash_idx" ON "analytics_events"("session_hash");
CREATE INDEX "analytics_events_visitor_hash_idx" ON "analytics_events"("visitor_hash");
CREATE INDEX "analytics_events_ip_hash_created_at_idx" ON "analytics_events"("ip_hash", "created_at");

CREATE TABLE "analytics_daily" (
  "id" BIGSERIAL PRIMARY KEY,
  "stat_date" DATE NOT NULL,
  "page_type" VARCHAR(30) NOT NULL,
  "views" INTEGER NOT NULL DEFAULT 0,
  "unique_visitors" INTEGER NOT NULL DEFAULT 0,
  "sessions" INTEGER NOT NULL DEFAULT 0,
  "desktop_views" INTEGER NOT NULL DEFAULT 0,
  "mobile_views" INTEGER NOT NULL DEFAULT 0,
  "tablet_views" INTEGER NOT NULL DEFAULT 0,
  "avg_duration_seconds" INTEGER NOT NULL DEFAULT 0,
  CONSTRAINT "analytics_daily_stat_date_page_type_key" UNIQUE ("stat_date", "page_type")
);
CREATE INDEX "analytics_daily_stat_date_idx" ON "analytics_daily"("stat_date");

CREATE TABLE "analytics_pages_daily" (
  "id" BIGSERIAL PRIMARY KEY,
  "stat_date" DATE NOT NULL,
  "page_hash" CHAR(64) NOT NULL,
  "page_path" VARCHAR(500) NOT NULL,
  "page_type" VARCHAR(30) NOT NULL,
  "views" INTEGER NOT NULL DEFAULT 0,
  "unique_visitors" INTEGER NOT NULL DEFAULT 0,
  CONSTRAINT "analytics_pages_daily_stat_date_page_hash_key" UNIQUE ("stat_date", "page_hash")
);
CREATE INDEX "analytics_pages_daily_stat_date_page_type_idx" ON "analytics_pages_daily"("stat_date", "page_type");

CREATE TABLE "analytics_referrers_daily" (
  "id" BIGSERIAL PRIMARY KEY,
  "stat_date" DATE NOT NULL,
  "source_hash" CHAR(64) NOT NULL,
  "source" VARCHAR(120) NOT NULL,
  "views" INTEGER NOT NULL DEFAULT 0,
  "unique_visitors" INTEGER NOT NULL DEFAULT 0,
  CONSTRAINT "analytics_referrers_daily_stat_date_source_hash_key" UNIQUE ("stat_date", "source_hash")
);
CREATE INDEX "analytics_referrers_daily_stat_date_idx" ON "analytics_referrers_daily"("stat_date");

CREATE TABLE "analytics_funnel_daily" (
  "id" BIGSERIAL PRIMARY KEY,
  "stat_date" DATE NOT NULL,
  "step" VARCHAR(30) NOT NULL,
  "count" INTEGER NOT NULL DEFAULT 0,
  CONSTRAINT "analytics_funnel_daily_stat_date_step_key" UNIQUE ("stat_date", "step")
);
CREATE INDEX "analytics_funnel_daily_stat_date_idx" ON "analytics_funnel_daily"("stat_date");

CREATE TABLE "analytics_settings" (
  "id" INTEGER PRIMARY KEY DEFAULT 1,
  "enabled" BOOLEAN NOT NULL DEFAULT TRUE,
  "track_admins" BOOLEAN NOT NULL DEFAULT FALSE,
  "raw_retention_days" INTEGER NOT NULL DEFAULT 7,
  "daily_retention_days" INTEGER NOT NULL DEFAULT 365,
  "heartbeat_interval_seconds" INTEGER NOT NULL DEFAULT 30,
  "timezone" VARCHAR(64) NOT NULL DEFAULT 'America/Sao_Paulo',
  "updated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "analytics_settings_singleton" CHECK ("id" = 1),
  CONSTRAINT "analytics_settings_raw_retention" CHECK ("raw_retention_days" BETWEEN 1 AND 30),
  CONSTRAINT "analytics_settings_daily_retention" CHECK ("daily_retention_days" BETWEEN 30 AND 3650),
  CONSTRAINT "analytics_settings_heartbeat" CHECK ("heartbeat_interval_seconds" BETWEEN 10 AND 120)
);
INSERT INTO "analytics_settings" ("id") VALUES (1);
