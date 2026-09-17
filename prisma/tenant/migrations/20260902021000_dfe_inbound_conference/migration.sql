ALTER TABLE "products"
  ADD COLUMN "onboarding_status" TEXT NOT NULL DEFAULT 'complete',
  ADD COLUMN "onboarding_source" TEXT,
  ADD COLUMN "onboarding_missing_fields" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  ADD COLUMN "last_purchase_at" TIMESTAMP(3);

ALTER TABLE "purchase_invoices"
  ADD COLUMN "source" TEXT NOT NULL DEFAULT 'manual_xml',
  ADD COLUMN "branch_id" INTEGER,
  ADD COLUMN "supplier_id" INTEGER;

ALTER TABLE "purchase_invoice_items"
  ADD COLUMN "match_source" TEXT,
  ADD COLUMN "match_confidence" INTEGER,
  ADD COLUMN "match_reason" TEXT;

CREATE TABLE "dfe_sync_cursors" (
  "id" SERIAL PRIMARY KEY,
  "branch_id" INTEGER NOT NULL,
  "source" TEXT NOT NULL DEFAULT 'sefaz_nfe',
  "environment" TEXT NOT NULL DEFAULT 'production',
  "enabled" BOOLEAN NOT NULL DEFAULT true,
  "processing_mode" TEXT NOT NULL DEFAULT 'review',
  "default_warehouse_id" INTEGER,
  "default_due_days" INTEGER NOT NULL DEFAULT 30,
  "last_nsu" TEXT NOT NULL DEFAULT '000000000000000',
  "max_nsu" TEXT NOT NULL DEFAULT '000000000000000',
  "status" TEXT NOT NULL DEFAULT 'idle',
  "last_sync_at" TIMESTAMP(3),
  "last_success_at" TIMESTAMP(3),
  "next_sync_at" TIMESTAMP(3),
  "last_error" TEXT,
  "consecutive_failures" INTEGER NOT NULL DEFAULT 0,
  "lease_token" TEXT,
  "lease_expires_at" TIMESTAMP(3),
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "dfe_sync_cursors_branch_id_fkey" FOREIGN KEY ("branch_id") REFERENCES "branches"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "dfe_sync_cursors_default_warehouse_id_fkey" FOREIGN KEY ("default_warehouse_id") REFERENCES "warehouses"("id") ON DELETE SET NULL ON UPDATE CASCADE,
  CONSTRAINT "dfe_sync_cursor_source_check" CHECK ("source" IN ('sefaz_nfe','nfse_adn')),
  CONSTRAINT "dfe_sync_cursor_environment_check" CHECK ("environment" IN ('production','homologation')),
  CONSTRAINT "dfe_sync_cursor_mode_check" CHECK ("processing_mode" IN ('review','auto_prepare','auto_receive')),
  CONSTRAINT "dfe_sync_cursor_status_check" CHECK ("status" IN ('idle','syncing','error','waiting_certificate','rate_limited')),
  CONSTRAINT "dfe_sync_cursor_nsu_check" CHECK ("last_nsu" ~ '^[0-9]{15}$' AND "max_nsu" ~ '^[0-9]{15}$'),
  CONSTRAINT "dfe_sync_cursor_due_days_check" CHECK ("default_due_days" BETWEEN 0 AND 365),
  CONSTRAINT "dfe_sync_cursor_failures_check" CHECK ("consecutive_failures" >= 0),
  CONSTRAINT "dfe_sync_cursor_auto_destination_check" CHECK ("processing_mode" <> 'auto_receive' OR "default_warehouse_id" IS NOT NULL)
);

CREATE UNIQUE INDEX "dfe_sync_cursors_branch_id_source_environment_key" ON "dfe_sync_cursors"("branch_id", "source", "environment");
CREATE INDEX "dfe_sync_cursors_enabled_next_sync_at_idx" ON "dfe_sync_cursors"("enabled", "next_sync_at");
CREATE INDEX "dfe_sync_cursors_status_lease_expires_at_idx" ON "dfe_sync_cursors"("status", "lease_expires_at");

CREATE TABLE "inbound_fiscal_documents" (
  "id" SERIAL PRIMARY KEY,
  "source" TEXT NOT NULL,
  "document_type" TEXT NOT NULL,
  "schema_name" TEXT NOT NULL,
  "nsu" TEXT NOT NULL,
  "access_key" TEXT,
  "branch_id" INTEGER NOT NULL,
  "recipient_document" TEXT NOT NULL,
  "issuer_document" TEXT,
  "issuer_name" TEXT,
  "number" TEXT,
  "series" TEXT,
  "issue_date" TIMESTAMP(3),
  "authorization_date" TIMESTAMP(3),
  "total" DOUBLE PRECISION,
  "status" TEXT NOT NULL DEFAULT 'detected',
  "classification" TEXT NOT NULL DEFAULT 'unknown',
  "manifestation_status" TEXT NOT NULL DEFAULT 'pending',
  "manifestation_deadline" DATE,
  "full_document_available" BOOLEAN NOT NULL DEFAULT false,
  "encrypted_xml" TEXT,
  "payload_hash" TEXT NOT NULL,
  "purchase_invoice_id" INTEGER,
  "ignored_reason" TEXT,
  "reviewed_by" TEXT,
  "reviewed_at" TIMESTAMP(3),
  "detected_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "inbound_fiscal_documents_branch_id_fkey" FOREIGN KEY ("branch_id") REFERENCES "branches"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "inbound_fiscal_documents_purchase_invoice_id_fkey" FOREIGN KEY ("purchase_invoice_id") REFERENCES "purchase_invoices"("id") ON DELETE SET NULL ON UPDATE CASCADE,
  CONSTRAINT "inbound_fiscal_source_check" CHECK ("source" IN ('sefaz_nfe','nfse_adn','manual_xml','provider')),
  CONSTRAINT "inbound_fiscal_type_check" CHECK ("document_type" IN ('nfe','cte','nfse','event','unknown')),
  CONSTRAINT "inbound_fiscal_status_check" CHECK ("status" IN ('detected','awaiting_document','ready','in_review','reconciled','received','ignored','cancelled','error')),
  CONSTRAINT "inbound_fiscal_classification_check" CHECK ("classification" IN ('unknown','goods','service','freight','expense','asset','other')),
  CONSTRAINT "inbound_fiscal_manifestation_check" CHECK ("manifestation_status" IN ('pending','science','confirmed','unknown_operation','not_performed','not_required')),
  CONSTRAINT "inbound_fiscal_nsu_check" CHECK ("nsu" ~ '^[0-9]{15}$'),
  CONSTRAINT "inbound_fiscal_access_key_check" CHECK ("access_key" IS NULL OR "access_key" ~ '^[0-9]{44,60}$'),
  CONSTRAINT "inbound_fiscal_documents_payload_hash_check" CHECK ("payload_hash" ~ '^[0-9a-f]{64}$'),
  CONSTRAINT "inbound_fiscal_document_payload_check" CHECK (NOT "full_document_available" OR "encrypted_xml" IS NOT NULL)
);

CREATE UNIQUE INDEX "inbound_fiscal_documents_source_branch_id_nsu_key" ON "inbound_fiscal_documents"("source", "branch_id", "nsu");
CREATE UNIQUE INDEX "inbound_fiscal_documents_source_access_key_key" ON "inbound_fiscal_documents"("source", "access_key");
CREATE UNIQUE INDEX "inbound_fiscal_documents_purchase_invoice_id_key" ON "inbound_fiscal_documents"("purchase_invoice_id");
CREATE INDEX "inbound_fiscal_documents_branch_id_status_issue_date_idx" ON "inbound_fiscal_documents"("branch_id", "status", "issue_date");
CREATE INDEX "inbound_fiscal_documents_document_type_classification_status_idx" ON "inbound_fiscal_documents"("document_type", "classification", "status");
CREATE INDEX "inbound_fiscal_documents_issuer_document_issue_date_idx" ON "inbound_fiscal_documents"("issuer_document", "issue_date");

CREATE TABLE "inbound_fiscal_document_events" (
  "id" BIGSERIAL PRIMARY KEY,
  "document_id" INTEGER NOT NULL,
  "type" TEXT NOT NULL,
  "actor_id" TEXT NOT NULL,
  "correlation_id" TEXT NOT NULL,
  "metadata" JSONB,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "inbound_fiscal_document_events_document_id_fkey" FOREIGN KEY ("document_id") REFERENCES "inbound_fiscal_documents"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "inbound_fiscal_document_events_type_check" CHECK ("type" ~ '^[a-z0-9_.-]{3,80}$'),
  CONSTRAINT "inbound_fiscal_document_events_correlation_check" CHECK (length("correlation_id") BETWEEN 8 AND 100)
);

CREATE INDEX "inbound_fiscal_document_events_document_id_created_at_idx" ON "inbound_fiscal_document_events"("document_id", "created_at");
CREATE INDEX "inbound_fiscal_document_events_correlation_id_idx" ON "inbound_fiscal_document_events"("correlation_id");

ALTER TABLE "purchase_invoices"
  ADD CONSTRAINT "purchase_invoices_branch_id_fkey" FOREIGN KEY ("branch_id") REFERENCES "branches"("id") ON DELETE SET NULL ON UPDATE CASCADE,
  ADD CONSTRAINT "purchase_invoices_supplier_id_fkey" FOREIGN KEY ("supplier_id") REFERENCES "suppliers"("id") ON DELETE SET NULL ON UPDATE CASCADE,
  ADD CONSTRAINT "purchase_invoices_source_check" CHECK ("source" IN ('manual_xml','sefaz_nfe','nfse_adn','provider'));

ALTER TABLE "purchase_invoice_items"
  ADD CONSTRAINT "purchase_invoice_items_match_confidence_check" CHECK ("match_confidence" IS NULL OR "match_confidence" BETWEEN 0 AND 100),
  ADD CONSTRAINT "purchase_invoice_items_match_source_check" CHECK ("match_source" IS NULL OR "match_source" IN ('gtin','supplier_code','supplier_history','manual','created_from_invoice'));

ALTER TABLE "products"
  ADD CONSTRAINT "products_onboarding_status_check" CHECK ("onboarding_status" IN ('complete','pending','blocked'));

CREATE INDEX "purchase_invoices_branch_id_status_issue_date_idx" ON "purchase_invoices"("branch_id", "status", "issue_date");
CREATE INDEX "purchase_invoices_supplier_id_issue_date_idx" ON "purchase_invoices"("supplier_id", "issue_date");

CREATE FUNCTION protect_inbound_fiscal_event_append_only() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'inbound fiscal events are append-only';
END;
$$;

CREATE TRIGGER "inbound_fiscal_events_append_only"
BEFORE UPDATE OR DELETE ON "inbound_fiscal_document_events"
FOR EACH ROW EXECUTE FUNCTION protect_inbound_fiscal_event_append_only();
