ALTER TABLE "customers"
  ADD COLUMN "segment" TEXT NOT NULL DEFAULT 'standard',
  ADD COLUMN "origin" TEXT NOT NULL DEFAULT 'manual',
  ADD COLUMN "salesperson" TEXT,
  ADD COLUMN "payment_terms_days" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "risk_rating" TEXT NOT NULL DEFAULT 'unrated',
  ADD COLUMN "preferred_channel" TEXT NOT NULL DEFAULT 'email',
  ADD COLUMN "version" INTEGER NOT NULL DEFAULT 1;

CREATE INDEX "customers_segment_status_idx" ON "customers"("segment", "status");
CREATE INDEX "customers_risk_rating_status_idx" ON "customers"("risk_rating", "status");
CREATE INDEX "customers_created_at_idx" ON "customers"("created_at");
ALTER TABLE "customers" ADD CONSTRAINT "customers_segment_check" CHECK ("segment" IN ('standard','vip','wholesale','strategic'));
ALTER TABLE "customers" ADD CONSTRAINT "customers_origin_check" CHECK ("origin" IN ('manual','referral','website','marketplace','campaign','store'));
ALTER TABLE "customers" ADD CONSTRAINT "customers_risk_rating_check" CHECK ("risk_rating" IN ('unrated','low','medium','high','blocked'));
ALTER TABLE "customers" ADD CONSTRAINT "customers_preferred_channel_check" CHECK ("preferred_channel" IN ('email','phone','whatsapp','in_person'));
ALTER TABLE "customers" ADD CONSTRAINT "customers_payment_terms_days_check" CHECK ("payment_terms_days" BETWEEN 0 AND 365);
ALTER TABLE "customers" ADD CONSTRAINT "customers_version_check" CHECK ("version" > 0);

CREATE TABLE "customer_contacts" (
  "id" SERIAL NOT NULL,
  "customer_id" INTEGER NOT NULL,
  "name" TEXT NOT NULL,
  "role" TEXT,
  "email" TEXT,
  "phone" TEXT,
  "primary" BOOLEAN NOT NULL DEFAULT false,
  "archived_at" TIMESTAMP(3),
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "customer_contacts_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "customer_contacts_customer_id_fkey" FOREIGN KEY ("customer_id") REFERENCES "customers"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX "customer_contacts_customer_id_archived_at_primary_idx" ON "customer_contacts"("customer_id", "archived_at", "primary");
CREATE UNIQUE INDEX "customer_contacts_one_active_primary_idx" ON "customer_contacts"("customer_id") WHERE "primary" = true AND "archived_at" IS NULL;

CREATE TABLE "customer_tags" (
  "id" SERIAL NOT NULL,
  "name" TEXT NOT NULL,
  "color" TEXT NOT NULL DEFAULT '#168151',
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "customer_tags_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "customer_tags_name_key" UNIQUE ("name")
);

CREATE TABLE "customer_tag_links" (
  "customer_id" INTEGER NOT NULL,
  "tag_id" INTEGER NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "customer_tag_links_pkey" PRIMARY KEY ("customer_id", "tag_id"),
  CONSTRAINT "customer_tag_links_customer_id_fkey" FOREIGN KEY ("customer_id") REFERENCES "customers"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "customer_tag_links_tag_id_fkey" FOREIGN KEY ("tag_id") REFERENCES "customer_tags"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX "customer_tag_links_tag_id_customer_id_idx" ON "customer_tag_links"("tag_id", "customer_id");

CREATE TABLE "customer_interactions" (
  "id" SERIAL NOT NULL,
  "customer_id" INTEGER NOT NULL,
  "type" TEXT NOT NULL,
  "subject" TEXT NOT NULL,
  "notes" TEXT,
  "due_at" TIMESTAMP(3),
  "completed_at" TIMESTAMP(3),
  "created_by" TEXT NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "customer_interactions_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "customer_interactions_customer_id_fkey" FOREIGN KEY ("customer_id") REFERENCES "customers"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX "customer_interactions_customer_id_created_at_idx" ON "customer_interactions"("customer_id", "created_at");
CREATE INDEX "customer_interactions_customer_id_completed_at_due_at_idx" ON "customer_interactions"("customer_id", "completed_at", "due_at");
ALTER TABLE "customer_interactions" ADD CONSTRAINT "customer_interactions_type_check" CHECK ("type" IN ('note','call','email','meeting','task'));

CREATE TABLE "customer_consents" (
  "id" SERIAL NOT NULL,
  "customer_id" INTEGER NOT NULL,
  "purpose" TEXT NOT NULL,
  "status" TEXT NOT NULL,
  "legal_basis" TEXT NOT NULL,
  "channel" TEXT,
  "source" TEXT NOT NULL,
  "proof_reference" TEXT,
  "expires_at" TIMESTAMP(3),
  "recorded_by" TEXT NOT NULL,
  "recorded_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "customer_consents_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "customer_consents_customer_id_fkey" FOREIGN KEY ("customer_id") REFERENCES "customers"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
CREATE INDEX "customer_consents_customer_id_purpose_recorded_at_idx" ON "customer_consents"("customer_id", "purpose", "recorded_at");
CREATE INDEX "customer_consents_status_expires_at_idx" ON "customer_consents"("status", "expires_at");
ALTER TABLE "customer_consents" ADD CONSTRAINT "customer_consents_purpose_check" CHECK ("purpose" IN ('marketing_email','marketing_whatsapp','profiling','service'));
ALTER TABLE "customer_consents" ADD CONSTRAINT "customer_consents_status_check" CHECK ("status" IN ('granted','revoked'));
ALTER TABLE "customer_consents" ADD CONSTRAINT "customer_consents_legal_basis_check" CHECK ("legal_basis" IN ('consent','contract','legal_obligation','legitimate_interest','credit_protection'));
