CREATE TABLE "pos_internal_qr_issuances" (
    "id" TEXT NOT NULL,
    "branch_id" INTEGER NOT NULL,
    "kind" TEXT NOT NULL,
    "reference" TEXT NOT NULL,
    "key_id" TEXT NOT NULL,
    "nonce" TEXT NOT NULL,
    "token_hash" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'active',
    "issued_by" TEXT NOT NULL,
    "idempotency_key" TEXT NOT NULL,
    "request_hash" TEXT NOT NULL,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "revoked_at" TIMESTAMP(3),
    "revoked_by" TEXT,
    "revoke_reason" TEXT,
    "revoke_idempotency_key" TEXT,
    "revoke_request_hash" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "pos_internal_qr_issuances_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "pos_internal_qr_issuances_kind_check" CHECK ("kind" IN ('customer', 'held_cart', 'coupon', 'gift_card', 'order', 'receipt')),
    CONSTRAINT "pos_internal_qr_issuances_status_check" CHECK ("status" IN ('active', 'revoked', 'expired')),
    CONSTRAINT "pos_internal_qr_issuances_reference_check" CHECK (
      char_length("reference") BETWEEN 3 AND 160
      AND "reference" LIKE "kind" || ':%'
      AND char_length("reference") - char_length(replace("reference", ':', '')) = 1
    ),
    CONSTRAINT "pos_internal_qr_issuances_key_id_check" CHECK ("key_id" ~ '^[A-Za-z0-9][A-Za-z0-9_-]{0,39}$'),
    CONSTRAINT "pos_internal_qr_issuances_nonce_check" CHECK ("nonce" ~ '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'),
    CONSTRAINT "pos_internal_qr_issuances_token_hash_check" CHECK ("token_hash" ~ '^sha256:v1:[0-9a-f]{64}$'),
    CONSTRAINT "pos_internal_qr_issuances_request_hash_check" CHECK ("request_hash" ~ '^[0-9a-f]{64}$'),
    CONSTRAINT "pos_internal_qr_issuances_revoke_request_hash_check" CHECK ("revoke_request_hash" IS NULL OR "revoke_request_hash" ~ '^[0-9a-f]{64}$'),
    CONSTRAINT "pos_internal_qr_issuances_expiry_check" CHECK ("expires_at" > "created_at"),
    CONSTRAINT "pos_internal_qr_issuances_revoke_state_check" CHECK (
      ("status" = 'revoked' AND "revoked_at" IS NOT NULL AND "revoked_by" IS NOT NULL AND "revoke_reason" IS NOT NULL AND "revoke_idempotency_key" IS NOT NULL AND "revoke_request_hash" IS NOT NULL)
      OR ("status" IN ('active', 'expired') AND "revoked_at" IS NULL AND "revoked_by" IS NULL AND "revoke_reason" IS NULL AND "revoke_idempotency_key" IS NULL AND "revoke_request_hash" IS NULL)
    )
);

CREATE UNIQUE INDEX "pos_internal_qr_issuances_nonce_key" ON "pos_internal_qr_issuances"("nonce");
CREATE UNIQUE INDEX "pos_internal_qr_issuances_token_hash_key" ON "pos_internal_qr_issuances"("token_hash");
CREATE UNIQUE INDEX "pos_internal_qr_issuances_idempotency_key_key" ON "pos_internal_qr_issuances"("idempotency_key");
CREATE UNIQUE INDEX "pos_internal_qr_issuances_revoke_idempotency_key_key" ON "pos_internal_qr_issuances"("revoke_idempotency_key");
CREATE INDEX "pos_internal_qr_issuances_branch_kind_status_expires_idx" ON "pos_internal_qr_issuances"("branch_id", "kind", "status", "expires_at");
CREATE INDEX "pos_internal_qr_issuances_reference_status_idx" ON "pos_internal_qr_issuances"("reference", "status");

ALTER TABLE "pos_internal_qr_issuances"
  ADD CONSTRAINT "pos_internal_qr_issuances_branch_id_fkey"
  FOREIGN KEY ("branch_id") REFERENCES "branches"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
