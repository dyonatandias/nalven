DROP FUNCTION "nalven_audit_fingerprint"(TEXT,TEXT,TEXT,TEXT,TEXT,TEXT,JSONB,JSONB,TEXT,TEXT,TEXT,INTEGER,TIMESTAMPTZ);
DROP EXTENSION "pgcrypto";

CREATE OR REPLACE FUNCTION "nalven_audit_fingerprint"(
  "event_key" TEXT, "event_actor" TEXT, "event_action" TEXT, "event_entity" TEXT,
  "event_entity_id" TEXT, "event_correlation" TEXT, "event_before" JSONB,
  "event_after" JSONB, "event_severity" TEXT, "event_category" TEXT,
  "event_source" TEXT, "event_schema_version" INTEGER, "event_created_at" TIMESTAMPTZ
) RETURNS TEXT
LANGUAGE sql IMMUTABLE PARALLEL SAFE SECURITY DEFINER
SET search_path = pg_catalog AS $$
  SELECT encode(pg_catalog.sha256(convert_to(jsonb_build_array(
    "event_key", "event_actor", "event_action", "event_entity", "event_entity_id",
    "event_correlation", "event_before", "event_after", "event_severity", "event_category",
    "event_source", "event_schema_version", extract(epoch FROM "event_created_at")::text
  )::text, 'UTF8')), 'hex')
$$;
REVOKE ALL ON FUNCTION "nalven_audit_fingerprint"(TEXT,TEXT,TEXT,TEXT,TEXT,TEXT,JSONB,JSONB,TEXT,TEXT,TEXT,INTEGER,TIMESTAMPTZ) FROM PUBLIC;

CREATE OR REPLACE FUNCTION "classify_and_fingerprint_tenant_audit_event"() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public AS $$
BEGIN
  NEW."severity" := public."nalven_audit_severity"(NEW."action");
  NEW."category" := public."nalven_audit_category"(NEW."action", NEW."entity_type");
  NEW."source" := CASE
    WHEN lower(NEW."action" || ' ' || NEW."entity_type") ~ '(^|[._ ])pos([._ ]|$)|pdv' THEN 'pos'
    WHEN lower(NEW."action" || ' ' || NEW."entity_type") ~ '(nfe|nfse|dfe|fiscal)' THEN 'fiscal'
    WHEN lower(NEW."action" || ' ' || NEW."entity_type") ~ '(integration|webhook|oauth|email|marketplace)' THEN 'integration'
    WHEN NEW."actor_id" IS NULL THEN 'system'
    ELSE 'erp'
  END;
  NEW."fingerprint" := public."nalven_audit_fingerprint"(
    'erp:' || NEW."id"::text, NEW."actor_id", NEW."action", NEW."entity_type", NEW."entity_id",
    NEW."correlation_id", NEW."before_data", NEW."after_data", NEW."severity", NEW."category",
    NEW."source", NEW."schema_version", NEW."created_at"
  );
  RETURN NEW;
END
$$;

CREATE OR REPLACE FUNCTION "classify_and_fingerprint_integration_audit_event"() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public AS $$
BEGIN
  NEW."severity" := public."nalven_audit_severity"(NEW."action");
  NEW."category" := public."nalven_audit_category"(NEW."action", NEW."target_type");
  NEW."source" := 'integration';
  NEW."fingerprint" := public."nalven_audit_fingerprint"(
    'integration:' || NEW."id", NEW."user_id", 'integration.' || NEW."action", NEW."target_type", NEW."target_id",
    NEW."correlation_id", NEW."before_data", NEW."after_data", NEW."severity", NEW."category",
    NEW."source", NEW."schema_version", NEW."created_at"
  );
  RETURN NEW;
END
$$;
