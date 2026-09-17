ALTER TABLE "legal_bases"
  ADD COLUMN "description" TEXT,
  ADD COLUMN "data_subjects" JSONB NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN "source_systems" JSONB NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN "recipients" JSONB NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN "international_transfer" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "safeguards" TEXT,
  ADD COLUMN "owner" TEXT,
  ADD COLUMN "review_at" DATE,
  ADD COLUMN "version" INTEGER NOT NULL DEFAULT 1,
  ADD COLUMN "updated_by" TEXT,
  ADD COLUMN "updated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP;

ALTER TABLE "retention_rules"
  ADD COLUMN "applies_to" TEXT,
  ADD COLUMN "owner" TEXT,
  ADD COLUMN "review_at" DATE,
  ADD COLUMN "version" INTEGER NOT NULL DEFAULT 1,
  ADD COLUMN "updated_by" TEXT;

ALTER TABLE "privacy_requests"
  ADD COLUMN "subject_document_hash" TEXT,
  ADD COLUMN "subject_document_last4" TEXT,
  ADD COLUMN "contact_preview" TEXT,
  ADD COLUMN "channel" TEXT NOT NULL DEFAULT 'email',
  ADD COLUMN "priority" TEXT NOT NULL DEFAULT 'normal',
  ADD COLUMN "requester_relation" TEXT NOT NULL DEFAULT 'self',
  ADD COLUMN "identity_method" TEXT,
  ADD COLUMN "response_summary" TEXT,
  ADD COLUMN "rejection_reason" TEXT,
  ADD COLUMN "version" INTEGER NOT NULL DEFAULT 1;

UPDATE "privacy_requests"
SET "subject_document_hash" = encode(pg_catalog.sha256(convert_to(regexp_replace("subject_document", '[^0-9]', '', 'g'), 'UTF8')), 'hex'),
    "subject_document_last4" = right(regexp_replace("subject_document", '[^0-9]', '', 'g'), 4),
    "contact_preview" = CASE
      WHEN position('@' IN "contact") > 0 THEN left("contact", 2) || '***@' || split_part("contact", '@', 2)
      ELSE '(**) *****-' || right(regexp_replace("contact", '[^0-9]', '', 'g'), 4)
    END
WHERE "subject_document_hash" IS NULL;

CREATE INDEX "privacy_requests_subject_document_hash_created_at_idx" ON "privacy_requests"("subject_document_hash", "created_at");
CREATE INDEX "privacy_requests_assigned_to_status_due_at_idx" ON "privacy_requests"("assigned_to", "status", "due_at");

CREATE TABLE "privacy_request_events" (
  "id" SERIAL PRIMARY KEY,
  "request_id" INTEGER NOT NULL REFERENCES "privacy_requests"("id") ON DELETE CASCADE,
  "kind" TEXT NOT NULL,
  "from_status" TEXT,
  "to_status" TEXT,
  "note" TEXT,
  "actor_id" TEXT NOT NULL,
  "actor_name" TEXT NOT NULL,
  "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX "privacy_request_events_request_id_created_at_idx" ON "privacy_request_events"("request_id", "created_at");

INSERT INTO "privacy_request_events" ("request_id", "kind", "to_status", "note", "actor_id", "actor_name", "created_at")
SELECT "id", 'migration', "status", 'Histórico inicial criado durante a evolução da central de privacidade.', "created_by", "created_by", "created_at"
FROM "privacy_requests";

ALTER TABLE "privacy_incidents"
  ADD COLUMN "risk_relevant" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "data_categories" JSONB NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN "detected_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  ADD COLUMN "notification_due_at" TIMESTAMPTZ,
  ADD COLUMN "contained_at" TIMESTAMPTZ,
  ADD COLUMN "anpd_notified_at" TIMESTAMPTZ,
  ADD COLUMN "subjects_notified_at" TIMESTAMPTZ,
  ADD COLUMN "root_cause" TEXT,
  ADD COLUMN "containment_measures" TEXT,
  ADD COLUMN "corrective_actions" TEXT,
  ADD COLUMN "decision_reason" TEXT,
  ADD COLUMN "assigned_to" TEXT,
  ADD COLUMN "version" INTEGER NOT NULL DEFAULT 1,
  ADD COLUMN "updated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP;

UPDATE "privacy_incidents" SET "detected_at" = "reported_at";
CREATE INDEX "privacy_incidents_risk_relevant_notification_due_at_idx" ON "privacy_incidents"("risk_relevant", "notification_due_at");

CREATE TABLE "privacy_incident_events" (
  "id" SERIAL PRIMARY KEY,
  "incident_id" INTEGER NOT NULL REFERENCES "privacy_incidents"("id") ON DELETE CASCADE,
  "kind" TEXT NOT NULL,
  "from_status" TEXT,
  "to_status" TEXT,
  "note" TEXT,
  "actor_id" TEXT NOT NULL,
  "actor_name" TEXT NOT NULL,
  "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX "privacy_incident_events_incident_id_created_at_idx" ON "privacy_incident_events"("incident_id", "created_at");

INSERT INTO "privacy_incident_events" ("incident_id", "kind", "to_status", "note", "actor_id", "actor_name", "created_at")
SELECT "id", 'migration', "status", 'Histórico inicial criado durante a evolução da central de privacidade.', "created_by", "created_by", "reported_at"
FROM "privacy_incidents";

CREATE TABLE "privacy_treatment_activities" (
  "id" TEXT PRIMARY KEY,
  "name" TEXT NOT NULL,
  "department" TEXT NOT NULL,
  "purpose" TEXT NOT NULL,
  "legal_basis" TEXT NOT NULL,
  "data_categories" JSONB NOT NULL DEFAULT '[]'::jsonb,
  "data_subjects" JSONB NOT NULL DEFAULT '[]'::jsonb,
  "operations" JSONB NOT NULL DEFAULT '[]'::jsonb,
  "collection_source" TEXT,
  "recipients" JSONB NOT NULL DEFAULT '[]'::jsonb,
  "systems" JSONB NOT NULL DEFAULT '[]'::jsonb,
  "sensitive_data" BOOLEAN NOT NULL DEFAULT false,
  "children_data" BOOLEAN NOT NULL DEFAULT false,
  "international_transfer" BOOLEAN NOT NULL DEFAULT false,
  "transfer_safeguards" TEXT,
  "security_measures" TEXT,
  "retention_summary" TEXT,
  "owner" TEXT NOT NULL,
  "risk_level" TEXT NOT NULL DEFAULT 'medium',
  "status" TEXT NOT NULL DEFAULT 'active',
  "last_reviewed_at" DATE,
  "next_review_at" DATE,
  "version" INTEGER NOT NULL DEFAULT 1,
  "created_by" TEXT NOT NULL,
  "updated_by" TEXT NOT NULL,
  "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX "privacy_treatments_status_risk_review_idx" ON "privacy_treatment_activities"("status", "risk_level", "next_review_at");
CREATE INDEX "privacy_treatment_activities_department_status_idx" ON "privacy_treatment_activities"("department", "status");

CREATE TABLE "privacy_impact_assessments" (
  "id" TEXT PRIMARY KEY,
  "treatment_id" TEXT REFERENCES "privacy_treatment_activities"("id") ON DELETE SET NULL,
  "title" TEXT NOT NULL,
  "reason" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'draft',
  "inherent_risk" TEXT NOT NULL DEFAULT 'high',
  "residual_risk" TEXT NOT NULL DEFAULT 'medium',
  "risks" JSONB NOT NULL DEFAULT '[]'::jsonb,
  "safeguards" JSONB NOT NULL DEFAULT '[]'::jsonb,
  "necessity" TEXT,
  "proportionality" TEXT,
  "dpo_opinion" TEXT,
  "approved_by" TEXT,
  "approved_at" TIMESTAMPTZ,
  "review_at" DATE,
  "version" INTEGER NOT NULL DEFAULT 1,
  "created_by" TEXT NOT NULL,
  "updated_by" TEXT NOT NULL,
  "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX "privacy_impact_assessments_status_residual_risk_review_at_idx" ON "privacy_impact_assessments"("status", "residual_risk", "review_at");
CREATE INDEX "privacy_impact_assessments_treatment_id_updated_at_idx" ON "privacy_impact_assessments"("treatment_id", "updated_at");

ALTER TABLE "tenant_settings"
  ADD COLUMN "data_protection_officer_name" TEXT,
  ADD COLUMN "data_protection_phone" TEXT,
  ADD COLUMN "privacy_small_agent" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "privacy_default_request_days" INTEGER NOT NULL DEFAULT 15,
  ADD COLUMN "privacy_program_review_at" DATE;

CREATE FUNCTION "reject_immutable_privacy_history"() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog AS $$
BEGIN
  RAISE EXCEPTION 'privacy history is append-only and immutable';
END
$$;

CREATE TRIGGER "privacy_request_events_immutable_guard"
BEFORE UPDATE OR DELETE ON "privacy_request_events"
FOR EACH ROW EXECUTE FUNCTION "reject_immutable_privacy_history"();
CREATE TRIGGER "privacy_incident_events_immutable_guard"
BEFORE UPDATE OR DELETE ON "privacy_incident_events"
FOR EACH ROW EXECUTE FUNCTION "reject_immutable_privacy_history"();

ALTER TABLE "privacy_requests" ADD CONSTRAINT "privacy_requests_status_check" CHECK ("status" IN ('received','identity_pending','verified','in_progress','completed','rejected'));
ALTER TABLE "privacy_requests" ADD CONSTRAINT "privacy_requests_type_check" CHECK ("type" IN ('access','correction','deletion','portability','revocation','restriction','objection','anonymization','info_sharing'));
ALTER TABLE "privacy_requests" ADD CONSTRAINT "privacy_requests_priority_check" CHECK ("priority" IN ('normal','high','urgent'));
ALTER TABLE "privacy_requests" ADD CONSTRAINT "privacy_requests_version_check" CHECK ("version" > 0);
ALTER TABLE "privacy_incidents" ADD CONSTRAINT "privacy_incidents_status_check" CHECK ("status" IN ('open','assessing','contained','notifying','resolved'));
ALTER TABLE "privacy_incidents" ADD CONSTRAINT "privacy_incidents_severity_check" CHECK ("severity" IN ('low','medium','high','critical'));
ALTER TABLE "privacy_incidents" ADD CONSTRAINT "privacy_incidents_version_check" CHECK ("version" > 0);
ALTER TABLE "privacy_treatment_activities" ADD CONSTRAINT "privacy_treatments_risk_check" CHECK ("risk_level" IN ('low','medium','high','critical'));
ALTER TABLE "privacy_treatment_activities" ADD CONSTRAINT "privacy_treatments_status_check" CHECK ("status" IN ('draft','active','review_due','archived'));
ALTER TABLE "privacy_treatment_activities" ADD CONSTRAINT "privacy_treatments_version_check" CHECK ("version" > 0);
ALTER TABLE "privacy_impact_assessments" ADD CONSTRAINT "privacy_assessments_status_check" CHECK ("status" IN ('draft','in_review','approved','superseded'));
ALTER TABLE "privacy_impact_assessments" ADD CONSTRAINT "privacy_assessments_inherent_risk_check" CHECK ("inherent_risk" IN ('low','medium','high','critical'));
ALTER TABLE "privacy_impact_assessments" ADD CONSTRAINT "privacy_assessments_residual_risk_check" CHECK ("residual_risk" IN ('low','medium','high','critical'));
ALTER TABLE "privacy_impact_assessments" ADD CONSTRAINT "privacy_assessments_version_check" CHECK ("version" > 0);
ALTER TABLE "tenant_settings" ADD CONSTRAINT "tenant_settings_privacy_default_request_days_check" CHECK ("privacy_default_request_days" BETWEEN 1 AND 60);

COMMENT ON TABLE "privacy_treatment_activities" IS 'Registro das operações de tratamento (ROPA) para governança e prestação de contas.';
COMMENT ON TABLE "privacy_impact_assessments" IS 'Relatórios de impacto e revisões de riscos de privacidade.';
COMMENT ON TABLE "privacy_request_events" IS 'Histórico append-only do atendimento aos direitos dos titulares.';
COMMENT ON TABLE "privacy_incident_events" IS 'Histórico append-only da resposta a incidentes de dados pessoais.';
