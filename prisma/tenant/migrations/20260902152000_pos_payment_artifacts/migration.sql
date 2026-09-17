CREATE TABLE "pos_payment_artifacts" (
  "id" TEXT NOT NULL,
  "intent_id" TEXT NOT NULL,
  "kind" TEXT NOT NULL,
  "value_cipher" TEXT NOT NULL,
  "display_text" TEXT,
  "status" TEXT NOT NULL DEFAULT 'active',
  "expires_at" TIMESTAMP(3),
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "pos_payment_artifacts_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "pos_payment_artifacts_kind_check" CHECK ("kind" IN ('pix_copy_paste','pix_qr_url','payment_link','terminal_instruction')),
  CONSTRAINT "pos_payment_artifacts_status_check" CHECK ("status" IN ('active','expired','revoked')),
  CONSTRAINT "pos_payment_artifacts_intent_id_fkey" FOREIGN KEY ("intent_id") REFERENCES "pos_payment_intents"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "pos_payment_artifacts_intent_id_kind_key" ON "pos_payment_artifacts"("intent_id", "kind");
CREATE INDEX "pos_payment_artifacts_status_expires_at_idx" ON "pos_payment_artifacts"("status", "expires_at");
