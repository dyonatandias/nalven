CREATE TABLE "saved_report_views" (
  "id" SERIAL NOT NULL,
  "name" TEXT NOT NULL,
  "description" TEXT,
  "report_key" TEXT NOT NULL,
  "filters" JSONB NOT NULL DEFAULT '{}',
  "visibility" TEXT NOT NULL DEFAULT 'private',
  "owner_user_id" TEXT NOT NULL,
  "owner_name" TEXT NOT NULL,
  "last_opened_at" TIMESTAMP(3),
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "saved_report_views_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "report_view_favorites" (
  "report_view_id" INTEGER NOT NULL,
  "user_id" TEXT NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "report_view_favorites_pkey" PRIMARY KEY ("report_view_id", "user_id")
);

CREATE TABLE "report_schedules" (
  "id" SERIAL NOT NULL,
  "saved_report_view_id" INTEGER,
  "name" TEXT NOT NULL,
  "report_key" TEXT NOT NULL,
  "filters" JSONB NOT NULL DEFAULT '{}',
  "format" TEXT NOT NULL DEFAULT 'csv',
  "frequency" TEXT NOT NULL,
  "weekday" INTEGER,
  "day_of_month" INTEGER,
  "time" TEXT NOT NULL,
  "timezone" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'active',
  "next_run_at" TIMESTAMP(3),
  "last_run_at" TIMESTAMP(3),
  "last_status" TEXT,
  "created_by" TEXT NOT NULL,
  "created_by_name" TEXT NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "report_schedules_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "report_export_events" (
  "id" SERIAL NOT NULL,
  "report_key" TEXT NOT NULL,
  "report_name" TEXT NOT NULL,
  "format" TEXT NOT NULL DEFAULT 'csv',
  "scope" TEXT NOT NULL DEFAULT 'manual',
  "status" TEXT NOT NULL DEFAULT 'completed',
  "file_name" TEXT,
  "requested_by" TEXT NOT NULL,
  "requested_by_name" TEXT NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "report_export_events_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "saved_report_views_owner_user_id_name_key" ON "saved_report_views"("owner_user_id", "name");
CREATE INDEX "saved_report_views_report_key_visibility_updated_at_idx" ON "saved_report_views"("report_key", "visibility", "updated_at");
CREATE INDEX "saved_report_views_last_opened_at_idx" ON "saved_report_views"("last_opened_at");
CREATE INDEX "report_view_favorites_user_id_created_at_idx" ON "report_view_favorites"("user_id", "created_at");
CREATE INDEX "report_schedules_status_next_run_at_idx" ON "report_schedules"("status", "next_run_at");
CREATE INDEX "report_schedules_created_by_updated_at_idx" ON "report_schedules"("created_by", "updated_at");
CREATE INDEX "report_export_events_created_at_idx" ON "report_export_events"("created_at");
CREATE INDEX "report_export_events_requested_by_created_at_idx" ON "report_export_events"("requested_by", "created_at");

ALTER TABLE "report_view_favorites"
  ADD CONSTRAINT "report_view_favorites_report_view_id_fkey"
  FOREIGN KEY ("report_view_id") REFERENCES "saved_report_views"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "report_schedules"
  ADD CONSTRAINT "report_schedules_saved_report_view_id_fkey"
  FOREIGN KEY ("saved_report_view_id") REFERENCES "saved_report_views"("id") ON DELETE SET NULL ON UPDATE CASCADE;
