ALTER TABLE "suppliers"
  ADD COLUMN "type" TEXT NOT NULL DEFAULT 'PJ',
  ADD COLUMN "category" TEXT NOT NULL DEFAULT 'goods',
  ADD COLUMN "origin" TEXT NOT NULL DEFAULT 'manual',
  ADD COLUMN "buyer" TEXT,
  ADD COLUMN "risk_rating" TEXT NOT NULL DEFAULT 'unrated',
  ADD COLUMN "homologation_status" TEXT NOT NULL DEFAULT 'pending',
  ADD COLUMN "tax_regime" TEXT NOT NULL DEFAULT 'not_informed',
  ADD COLUMN "state_registration" TEXT,
  ADD COLUMN "municipal_registration" TEXT,
  ADD COLUMN "website" TEXT,
  ADD COLUMN "payment_terms_days" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "delivery_lead_time_days" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "minimum_order" DOUBLE PRECISION NOT NULL DEFAULT 0,
  ADD COLUMN "version" INTEGER NOT NULL DEFAULT 1;

ALTER TABLE "supplier_contacts" ADD COLUMN "archived_at" TIMESTAMP(3);
UPDATE "suppliers" SET "status" = 'active', "homologation_status" = 'pending', "origin" = 'invoice' WHERE "status" = 'pending_review';
DROP INDEX IF EXISTS "supplier_contacts_supplier_id_primary_idx";
CREATE INDEX "supplier_contacts_supplier_id_archived_at_primary_idx" ON "supplier_contacts"("supplier_id", "archived_at", "primary");
WITH ranked AS (SELECT "id", ROW_NUMBER() OVER (PARTITION BY "supplier_id" ORDER BY "id") AS position FROM "supplier_contacts" WHERE "primary" = true)
UPDATE "supplier_contacts" SET "primary" = false WHERE "id" IN (SELECT "id" FROM ranked WHERE position > 1);
CREATE UNIQUE INDEX "supplier_contacts_one_active_primary_idx" ON "supplier_contacts"("supplier_id") WHERE "primary" = true AND "archived_at" IS NULL;

CREATE INDEX "suppliers_category_status_idx" ON "suppliers"("category", "status");
CREATE INDEX "suppliers_homologation_status_status_idx" ON "suppliers"("homologation_status", "status");
CREATE INDEX "suppliers_risk_rating_status_idx" ON "suppliers"("risk_rating", "status");
CREATE INDEX "suppliers_created_at_idx" ON "suppliers"("created_at");
ALTER TABLE "suppliers" ADD CONSTRAINT "suppliers_type_check" CHECK ("type" IN ('PF','PJ'));
ALTER TABLE "suppliers" ADD CONSTRAINT "suppliers_status_check" CHECK ("status" IN ('active','inactive'));
ALTER TABLE "suppliers" ADD CONSTRAINT "suppliers_category_check" CHECK ("category" IN ('goods','services','logistics','technology','utilities','other'));
ALTER TABLE "suppliers" ADD CONSTRAINT "suppliers_origin_check" CHECK ("origin" IN ('manual','purchase','invoice','import','referral'));
ALTER TABLE "suppliers" ADD CONSTRAINT "suppliers_risk_rating_check" CHECK ("risk_rating" IN ('unrated','low','medium','high','blocked'));
ALTER TABLE "suppliers" ADD CONSTRAINT "suppliers_homologation_status_check" CHECK ("homologation_status" IN ('pending','approved','conditional','rejected','expired'));
ALTER TABLE "suppliers" ADD CONSTRAINT "suppliers_tax_regime_check" CHECK ("tax_regime" IN ('not_informed','mei','simples','presumed','actual','individual'));
ALTER TABLE "suppliers" ADD CONSTRAINT "suppliers_payment_terms_days_check" CHECK ("payment_terms_days" BETWEEN 0 AND 365);
ALTER TABLE "suppliers" ADD CONSTRAINT "suppliers_delivery_lead_time_days_check" CHECK ("delivery_lead_time_days" BETWEEN 0 AND 365);
ALTER TABLE "suppliers" ADD CONSTRAINT "suppliers_minimum_order_check" CHECK ("minimum_order" >= 0);
ALTER TABLE "suppliers" ADD CONSTRAINT "suppliers_version_check" CHECK ("version" > 0);

CREATE TABLE "supplier_addresses" (
  "id" SERIAL NOT NULL PRIMARY KEY, "supplier_id" INTEGER NOT NULL, "label" TEXT NOT NULL DEFAULT 'Principal',
  "zip" TEXT, "street" TEXT, "number" TEXT, "complement" TEXT, "district" TEXT, "city" TEXT, "state" TEXT,
  "primary" BOOLEAN NOT NULL DEFAULT false, "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "supplier_addresses_supplier_id_fkey" FOREIGN KEY ("supplier_id") REFERENCES "suppliers"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX "supplier_addresses_supplier_id_primary_idx" ON "supplier_addresses"("supplier_id", "primary");
CREATE UNIQUE INDEX "supplier_addresses_one_primary_idx" ON "supplier_addresses"("supplier_id") WHERE "primary" = true;

CREATE TABLE "supplier_tags" (
  "id" SERIAL NOT NULL PRIMARY KEY, "name" TEXT NOT NULL UNIQUE, "color" TEXT NOT NULL DEFAULT '#168151', "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE "supplier_tag_links" (
  "supplier_id" INTEGER NOT NULL, "tag_id" INTEGER NOT NULL, "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY ("supplier_id", "tag_id"),
  CONSTRAINT "supplier_tag_links_supplier_id_fkey" FOREIGN KEY ("supplier_id") REFERENCES "suppliers"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "supplier_tag_links_tag_id_fkey" FOREIGN KEY ("tag_id") REFERENCES "supplier_tags"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX "supplier_tag_links_tag_id_supplier_id_idx" ON "supplier_tag_links"("tag_id", "supplier_id");

CREATE TABLE "supplier_interactions" (
  "id" SERIAL NOT NULL PRIMARY KEY, "supplier_id" INTEGER NOT NULL, "type" TEXT NOT NULL, "subject" TEXT NOT NULL, "notes" TEXT,
  "due_at" TIMESTAMP(3), "completed_at" TIMESTAMP(3), "created_by" TEXT NOT NULL, "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "supplier_interactions_supplier_id_fkey" FOREIGN KEY ("supplier_id") REFERENCES "suppliers"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "supplier_interactions_type_check" CHECK ("type" IN ('note','call','email','meeting','task','negotiation'))
);
CREATE INDEX "supplier_interactions_supplier_id_created_at_idx" ON "supplier_interactions"("supplier_id", "created_at");
CREATE INDEX "supplier_interactions_supplier_id_completed_at_due_at_idx" ON "supplier_interactions"("supplier_id", "completed_at", "due_at");

CREATE TABLE "supplier_documents" (
  "id" SERIAL NOT NULL PRIMARY KEY, "supplier_id" INTEGER NOT NULL, "type" TEXT NOT NULL, "name" TEXT NOT NULL, "number" TEXT,
  "status" TEXT NOT NULL DEFAULT 'valid', "issued_at" DATE, "expires_at" DATE, "file_reference" TEXT, "notes" TEXT,
  "created_by" TEXT NOT NULL, "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "supplier_documents_supplier_id_fkey" FOREIGN KEY ("supplier_id") REFERENCES "suppliers"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "supplier_documents_type_check" CHECK ("type" IN ('tax','license','certificate','insurance','contract','bank','other')),
  CONSTRAINT "supplier_documents_status_check" CHECK ("status" IN ('valid','pending','expired','rejected'))
);
CREATE INDEX "supplier_documents_supplier_id_status_expires_at_idx" ON "supplier_documents"("supplier_id", "status", "expires_at");
CREATE INDEX "supplier_documents_expires_at_status_idx" ON "supplier_documents"("expires_at", "status");

CREATE TABLE "supplier_evaluations" (
  "id" SERIAL NOT NULL PRIMARY KEY, "supplier_id" INTEGER NOT NULL, "quality_score" INTEGER NOT NULL, "delivery_score" INTEGER NOT NULL,
  "commercial_score" INTEGER NOT NULL, "compliance_score" INTEGER NOT NULL, "notes" TEXT, "evaluated_by" TEXT NOT NULL,
  "evaluated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "supplier_evaluations_supplier_id_fkey" FOREIGN KEY ("supplier_id") REFERENCES "suppliers"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "supplier_evaluations_scores_check" CHECK ("quality_score" BETWEEN 0 AND 100 AND "delivery_score" BETWEEN 0 AND 100 AND "commercial_score" BETWEEN 0 AND 100 AND "compliance_score" BETWEEN 0 AND 100)
);
CREATE INDEX "supplier_evaluations_supplier_id_evaluated_at_idx" ON "supplier_evaluations"("supplier_id", "evaluated_at");
