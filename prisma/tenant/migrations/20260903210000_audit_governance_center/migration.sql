CREATE EXTENSION IF NOT EXISTS "pgcrypto";

ALTER TABLE "audit_events"
  ADD COLUMN "severity" TEXT NOT NULL DEFAULT 'info',
  ADD COLUMN "category" TEXT NOT NULL DEFAULT 'business',
  ADD COLUMN "source" TEXT NOT NULL DEFAULT 'erp',
  ADD COLUMN "fingerprint" TEXT,
  ADD COLUMN "schema_version" INTEGER NOT NULL DEFAULT 1;

ALTER TABLE "integration_audit_log"
  ADD COLUMN "correlation_id" TEXT,
  ADD COLUMN "severity" TEXT NOT NULL DEFAULT 'info',
  ADD COLUMN "category" TEXT NOT NULL DEFAULT 'integration',
  ADD COLUMN "source" TEXT NOT NULL DEFAULT 'integration',
  ADD COLUMN "fingerprint" TEXT,
  ADD COLUMN "schema_version" INTEGER NOT NULL DEFAULT 1;

CREATE FUNCTION "nalven_audit_severity"("event_action" TEXT) RETURNS TEXT
LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT CASE
    WHEN lower("event_action") ~ '(deleted|revoked|failed|blocked|incident|reversed|cancelled|denied|breach)' THEN 'critical'
    WHEN lower("event_action") ~ '(updated|changed|status|ignored|rejected|expired|reopened|adjusted|override|disabled)' THEN 'warning'
    ELSE 'info'
  END
$$;

CREATE FUNCTION "nalven_audit_category"("event_action" TEXT, "event_entity" TEXT) RETURNS TEXT
LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT CASE
    WHEN lower("event_action" || ' ' || "event_entity") ~ '(lgpd|privacy|consent|retention)' THEN 'privacy'
    WHEN lower("event_action" || ' ' || "event_entity") ~ '(membership|tenant_role|invite|session|credential|user)' THEN 'identity'
    WHEN lower("event_action" || ' ' || "event_entity") ~ '(nfe|nfse|dfe|fiscal|invoice|certificate)' THEN 'fiscal'
    WHEN lower("event_action" || ' ' || "event_entity") ~ '(financial|finance|bank|cash|payment|accounting|reconciliation|settlement)' THEN 'finance'
    WHEN lower("event_action" || ' ' || "event_entity") ~ '(stock|inventory|warehouse|product|kit|production|purchase|supplier)' THEN 'supply'
    WHEN lower("event_action" || ' ' || "event_entity") ~ '(integration|webhook|oauth|email|marketplace|channel|carrier|shipment)' THEN 'integration'
    WHEN lower("event_action" || ' ' || "event_entity") ~ '(sale|order|quote|customer|crm|contract|service)' THEN 'commercial'
    ELSE 'governance'
  END
$$;

CREATE FUNCTION "nalven_audit_fingerprint"(
  "event_key" TEXT, "event_actor" TEXT, "event_action" TEXT, "event_entity" TEXT,
  "event_entity_id" TEXT, "event_correlation" TEXT, "event_before" JSONB,
  "event_after" JSONB, "event_severity" TEXT, "event_category" TEXT,
  "event_source" TEXT, "event_schema_version" INTEGER, "event_created_at" TIMESTAMPTZ
) RETURNS TEXT
LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT encode(digest(convert_to(jsonb_build_array(
    "event_key", "event_actor", "event_action", "event_entity", "event_entity_id",
    "event_correlation", "event_before", "event_after", "event_severity", "event_category",
    "event_source", "event_schema_version", extract(epoch FROM "event_created_at")::text
  )::text, 'UTF8'), 'sha256'), 'hex')
$$;

CREATE FUNCTION "classify_and_fingerprint_tenant_audit_event"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  NEW."severity" := "nalven_audit_severity"(NEW."action");
  NEW."category" := "nalven_audit_category"(NEW."action", NEW."entity_type");
  NEW."source" := CASE
    WHEN lower(NEW."action" || ' ' || NEW."entity_type") ~ '(^|[._ ])pos([._ ]|$)|pdv' THEN 'pos'
    WHEN lower(NEW."action" || ' ' || NEW."entity_type") ~ '(nfe|nfse|dfe|fiscal)' THEN 'fiscal'
    WHEN lower(NEW."action" || ' ' || NEW."entity_type") ~ '(integration|webhook|oauth|email|marketplace)' THEN 'integration'
    WHEN NEW."actor_id" IS NULL THEN 'system'
    ELSE 'erp'
  END;
  NEW."fingerprint" := "nalven_audit_fingerprint"(
    'erp:' || NEW."id"::text, NEW."actor_id", NEW."action", NEW."entity_type", NEW."entity_id",
    NEW."correlation_id", NEW."before_data", NEW."after_data", NEW."severity", NEW."category",
    NEW."source", NEW."schema_version", NEW."created_at"
  );
  RETURN NEW;
END
$$;

CREATE FUNCTION "classify_and_fingerprint_integration_audit_event"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  NEW."severity" := "nalven_audit_severity"(NEW."action");
  NEW."category" := "nalven_audit_category"(NEW."action", NEW."target_type");
  NEW."source" := 'integration';
  NEW."fingerprint" := "nalven_audit_fingerprint"(
    'integration:' || NEW."id", NEW."user_id", 'integration.' || NEW."action", NEW."target_type", NEW."target_id",
    NEW."correlation_id", NEW."before_data", NEW."after_data", NEW."severity", NEW."category",
    NEW."source", NEW."schema_version", NEW."created_at"
  );
  RETURN NEW;
END
$$;

UPDATE "audit_events" SET
  "severity" = "nalven_audit_severity"("action"),
  "category" = "nalven_audit_category"("action", "entity_type"),
  "source" = CASE
    WHEN lower("action" || ' ' || "entity_type") ~ '(^|[._ ])pos([._ ]|$)|pdv' THEN 'pos'
    WHEN lower("action" || ' ' || "entity_type") ~ '(nfe|nfse|dfe|fiscal)' THEN 'fiscal'
    WHEN lower("action" || ' ' || "entity_type") ~ '(integration|webhook|oauth|email|marketplace)' THEN 'integration'
    WHEN "actor_id" IS NULL THEN 'system'
    ELSE 'erp'
  END;
UPDATE "audit_events" SET "fingerprint" = "nalven_audit_fingerprint"(
  'erp:' || "id"::text, "actor_id", "action", "entity_type", "entity_id", "correlation_id",
  "before_data", "after_data", "severity", "category", "source", "schema_version", "created_at"
);

UPDATE "integration_audit_log" SET
  "severity" = "nalven_audit_severity"("action"),
  "category" = "nalven_audit_category"("action", "target_type"),
  "source" = 'integration';
UPDATE "integration_audit_log" SET "fingerprint" = "nalven_audit_fingerprint"(
  'integration:' || "id", "user_id", 'integration.' || "action", "target_type", "target_id", "correlation_id",
  "before_data", "after_data", "severity", "category", "source", "schema_version", "created_at"
);

CREATE TRIGGER "audit_events_classification_fingerprint"
BEFORE INSERT ON "audit_events" FOR EACH ROW EXECUTE FUNCTION "classify_and_fingerprint_tenant_audit_event"();
CREATE TRIGGER "integration_audit_log_classification_fingerprint"
BEFORE INSERT ON "integration_audit_log" FOR EACH ROW EXECUTE FUNCTION "classify_and_fingerprint_integration_audit_event"();

CREATE FUNCTION "protect_audit_history"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'audit history is append-only and immutable' USING ERRCODE = '42501';
END
$$;
CREATE TRIGGER "audit_events_immutable_guard" BEFORE UPDATE OR DELETE ON "audit_events"
FOR EACH ROW EXECUTE FUNCTION "protect_audit_history"();
CREATE TRIGGER "integration_audit_log_immutable_guard" BEFORE UPDATE OR DELETE ON "integration_audit_log"
FOR EACH ROW EXECUTE FUNCTION "protect_audit_history"();

ALTER TABLE "audit_events"
  ADD CONSTRAINT "audit_events_severity_check" CHECK ("severity" IN ('info', 'warning', 'critical')),
  ADD CONSTRAINT "audit_events_category_check" CHECK ("category" IN ('business', 'commercial', 'supply', 'finance', 'fiscal', 'identity', 'privacy', 'integration', 'governance')),
  ADD CONSTRAINT "audit_events_source_check" CHECK ("source" IN ('erp', 'pos', 'fiscal', 'integration', 'system')),
  ADD CONSTRAINT "audit_events_fingerprint_check" CHECK ("fingerprint" IS NULL OR "fingerprint" ~ '^[0-9a-f]{64}$'),
  ADD CONSTRAINT "audit_events_schema_version_check" CHECK ("schema_version" > 0);
ALTER TABLE "integration_audit_log"
  ADD CONSTRAINT "integration_audit_log_severity_check" CHECK ("severity" IN ('info', 'warning', 'critical')),
  ADD CONSTRAINT "integration_audit_log_category_check" CHECK ("category" IN ('business', 'commercial', 'supply', 'finance', 'fiscal', 'identity', 'privacy', 'integration', 'governance')),
  ADD CONSTRAINT "integration_audit_log_source_check" CHECK ("source" = 'integration'),
  ADD CONSTRAINT "integration_audit_log_fingerprint_check" CHECK ("fingerprint" IS NULL OR "fingerprint" ~ '^[0-9a-f]{64}$'),
  ADD CONSTRAINT "integration_audit_log_schema_version_check" CHECK ("schema_version" > 0);

CREATE INDEX "audit_events_actor_id_created_at_idx" ON "audit_events"("actor_id", "created_at");
CREATE INDEX "audit_events_action_created_at_idx" ON "audit_events"("action", "created_at");
CREATE INDEX "audit_events_severity_created_at_idx" ON "audit_events"("severity", "created_at");
CREATE INDEX "audit_events_category_created_at_idx" ON "audit_events"("category", "created_at");
CREATE INDEX "audit_events_source_created_at_idx" ON "audit_events"("source", "created_at");
CREATE INDEX "audit_events_correlation_id_created_at_idx" ON "audit_events"("correlation_id", "created_at");
CREATE INDEX "integration_audit_log_user_id_created_at_idx" ON "integration_audit_log"("user_id", "created_at");
CREATE INDEX "integration_audit_log_action_created_at_idx" ON "integration_audit_log"("action", "created_at");
CREATE INDEX "integration_audit_log_severity_created_at_idx" ON "integration_audit_log"("severity", "created_at");
CREATE INDEX "integration_audit_log_category_created_at_idx" ON "integration_audit_log"("category", "created_at");
CREATE INDEX "integration_audit_log_correlation_id_created_at_idx" ON "integration_audit_log"("correlation_id", "created_at");

CREATE TABLE "audit_investigations" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "title" TEXT NOT NULL,
  "summary" TEXT,
  "status" TEXT NOT NULL DEFAULT 'open',
  "severity" TEXT NOT NULL DEFAULT 'medium',
  "assignee_id" TEXT,
  "opened_by" TEXT NOT NULL,
  "resolved_by" TEXT,
  "resolution" TEXT,
  "due_at" TIMESTAMP(3),
  "resolved_at" TIMESTAMP(3),
  "version" INTEGER NOT NULL DEFAULT 1,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "audit_investigations_status_check" CHECK ("status" IN ('open', 'in_review', 'resolved', 'dismissed')),
  CONSTRAINT "audit_investigations_severity_check" CHECK ("severity" IN ('low', 'medium', 'high', 'critical')),
  CONSTRAINT "audit_investigations_version_check" CHECK ("version" > 0),
  CONSTRAINT "audit_investigations_resolution_check" CHECK ("status" NOT IN ('resolved', 'dismissed') OR length(trim(COALESCE("resolution", ''))) >= 5)
);

CREATE TABLE "audit_investigation_events" (
  "id" SERIAL NOT NULL PRIMARY KEY,
  "investigation_id" TEXT NOT NULL,
  "event_key" TEXT NOT NULL,
  "event_fingerprint" TEXT,
  "linked_by" TEXT NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "audit_investigation_events_investigation_id_fkey" FOREIGN KEY ("investigation_id") REFERENCES "audit_investigations"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "audit_investigation_events_event_key_check" CHECK ("event_key" ~ '^(erp|integration):[A-Za-z0-9_-]+$'),
  CONSTRAINT "audit_investigation_events_fingerprint_check" CHECK ("event_fingerprint" IS NULL OR "event_fingerprint" ~ '^[0-9a-f]{64}$')
);

CREATE TABLE "audit_investigation_notes" (
  "id" SERIAL NOT NULL PRIMARY KEY,
  "investigation_id" TEXT NOT NULL,
  "author_id" TEXT NOT NULL,
  "body" TEXT NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "audit_investigation_notes_investigation_id_fkey" FOREIGN KEY ("investigation_id") REFERENCES "audit_investigations"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "audit_investigation_notes_body_check" CHECK (length(trim("body")) BETWEEN 2 AND 4000)
);

CREATE TABLE "audit_saved_views" (
  "id" SERIAL NOT NULL PRIMARY KEY,
  "name" TEXT NOT NULL,
  "description" TEXT,
  "filters" JSONB NOT NULL DEFAULT '{}',
  "visibility" TEXT NOT NULL DEFAULT 'private',
  "owner_id" TEXT NOT NULL,
  "owner_name" TEXT NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "audit_saved_views_visibility_check" CHECK ("visibility" IN ('private', 'shared'))
);

CREATE TABLE "audit_export_events" (
  "id" SERIAL NOT NULL PRIMARY KEY,
  "format" TEXT NOT NULL,
  "filters" JSONB NOT NULL DEFAULT '{}',
  "estimated_rows" INTEGER NOT NULL DEFAULT 0,
  "requested_by" TEXT NOT NULL,
  "requested_name" TEXT NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "audit_export_events_format_check" CHECK ("format" IN ('csv', 'jsonl')),
  CONSTRAINT "audit_export_events_rows_check" CHECK ("estimated_rows" >= 0)
);

CREATE UNIQUE INDEX "audit_investigation_events_investigation_id_event_key_key" ON "audit_investigation_events"("investigation_id", "event_key");
CREATE INDEX "audit_investigations_status_severity_updated_at_idx" ON "audit_investigations"("status", "severity", "updated_at");
CREATE INDEX "audit_investigations_assignee_id_status_due_at_idx" ON "audit_investigations"("assignee_id", "status", "due_at");
CREATE INDEX "audit_investigation_events_event_key_created_at_idx" ON "audit_investigation_events"("event_key", "created_at");
CREATE INDEX "audit_investigation_notes_investigation_id_created_at_idx" ON "audit_investigation_notes"("investigation_id", "created_at");
CREATE UNIQUE INDEX "audit_saved_views_owner_id_name_key" ON "audit_saved_views"("owner_id", "name");
CREATE INDEX "audit_saved_views_visibility_updated_at_idx" ON "audit_saved_views"("visibility", "updated_at");
CREATE INDEX "audit_export_events_requested_by_created_at_idx" ON "audit_export_events"("requested_by", "created_at");
CREATE INDEX "audit_export_events_created_at_idx" ON "audit_export_events"("created_at");
