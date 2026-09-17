CREATE TABLE "site_redirects" (
  "source" TEXT PRIMARY KEY, "destination" TEXT NOT NULL,
  "status" INTEGER NOT NULL DEFAULT 308 CHECK ("status" IN (301,302,307,308)),
  "active" BOOLEAN NOT NULL DEFAULT true, "updated_at" TIMESTAMP(3) NOT NULL
);
CREATE TABLE "route_events" (
  "id" TEXT PRIMARY KEY, "request_id" TEXT NOT NULL, "path" TEXT NOT NULL,
  "destination" TEXT NOT NULL DEFAULT '', "status" INTEGER NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE UNIQUE INDEX "route_events_request_id_status_key" ON "route_events"("request_id", "status");
CREATE INDEX "route_events_created_at_status_idx" ON "route_events"("created_at", "status");
CREATE INDEX "route_events_path_created_at_idx" ON "route_events"("path", "created_at");
