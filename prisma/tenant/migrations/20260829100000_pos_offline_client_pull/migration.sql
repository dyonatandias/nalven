-- Offline/PWA hardening: short-lived user credential, monotonic pull ACK and
-- revisioned cart-draft projection. No financial, payment or fiscal state is
-- represented by these tables.

ALTER TABLE "pos_terminals"
  ADD COLUMN "last_sync_ack_cursor" BIGINT NOT NULL DEFAULT 0;

ALTER TABLE "pos_terminals"
  ADD CONSTRAINT "pos_terminals_last_sync_ack_cursor_check"
  CHECK (
    "last_sync_ack_cursor" >= 0
    AND "last_sync_ack_cursor" <= "last_sync_cursor"
  ) NOT VALID;

ALTER TABLE "pos_terminals"
  VALIDATE CONSTRAINT "pos_terminals_last_sync_ack_cursor_check";

CREATE TABLE "pos_offline_credentials" (
  "id" UUID NOT NULL,
  "terminal_id" TEXT NOT NULL,
  "user_profile_id" INTEGER NOT NULL,
  "user_id" TEXT NOT NULL,
  "token_hash" TEXT NOT NULL,
  "credential_version" INTEGER NOT NULL,
  "state" TEXT NOT NULL DEFAULT 'active',
  "idempotency_key" TEXT NOT NULL,
  "request_hash" TEXT NOT NULL,
  "revocation_key" TEXT,
  "revocation_request_hash" TEXT,
  "expires_at" TIMESTAMP(3) NOT NULL,
  "last_used_at" TIMESTAMP(3),
  "revoked_at" TIMESTAMP(3),
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "pos_offline_credentials_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "pos_offline_credentials_terminal_id_fkey"
    FOREIGN KEY ("terminal_id") REFERENCES "pos_terminals"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "pos_offline_credentials_user_profile_id_fkey"
    FOREIGN KEY ("user_profile_id") REFERENCES "tenant_user_profiles"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "pos_offline_credentials_state_check"
    CHECK ("state" IN ('active', 'revoked', 'expired')),
  CONSTRAINT "pos_offline_credentials_token_hash_check"
    CHECK ("token_hash" ~ '^hmac-sha256:v1:[0-9a-f]{64}$'),
  CONSTRAINT "pos_offline_credentials_request_hash_check"
    CHECK ("request_hash" ~ '^[0-9a-f]{64}$'),
  CONSTRAINT "pos_offline_credentials_revocation_hash_check"
    CHECK (
      ("revocation_key" IS NULL AND "revocation_request_hash" IS NULL)
      OR (
        char_length("revocation_key") BETWEEN 16 AND 160
        AND "revocation_key" ~ '^[A-Za-z0-9._:-]+$'
        AND "revocation_request_hash" ~ '^[0-9a-f]{64}$'
      )
    ),
  CONSTRAINT "pos_offline_credentials_version_check"
    CHECK ("credential_version" >= 0),
  CONSTRAINT "pos_offline_credentials_idempotency_key_check"
    CHECK (char_length("idempotency_key") BETWEEN 16 AND 160 AND "idempotency_key" ~ '^[A-Za-z0-9._:-]+$'),
  CONSTRAINT "pos_offline_credentials_lifecycle_check"
    CHECK (
      ("state" = 'active' AND "revoked_at" IS NULL AND "expires_at" > "created_at")
      OR ("state" = 'revoked' AND "revoked_at" IS NOT NULL)
      OR ("state" = 'expired' AND "revoked_at" IS NULL)
    )
);

CREATE UNIQUE INDEX "pos_offline_credentials_idempotency_key_key"
  ON "pos_offline_credentials"("idempotency_key");
CREATE UNIQUE INDEX "pos_offline_credentials_revocation_key_key"
  ON "pos_offline_credentials"("revocation_key");
CREATE INDEX "pos_offline_credentials_terminal_state_expires_idx"
  ON "pos_offline_credentials"("terminal_id", "state", "expires_at");
CREATE INDEX "pos_offline_credentials_profile_state_expires_idx"
  ON "pos_offline_credentials"("user_profile_id", "state", "expires_at");
CREATE UNIQUE INDEX "pos_offline_credentials_one_active_user_terminal_idx"
  ON "pos_offline_credentials"("terminal_id", "user_profile_id") WHERE "state" = 'active';

CREATE TABLE "pos_offline_drafts" (
  "id" BIGSERIAL NOT NULL,
  "terminal_id" TEXT NOT NULL,
  "draft_id" UUID NOT NULL,
  "revision" INTEGER NOT NULL,
  "state" TEXT NOT NULL DEFAULT 'active',
  "payload" JSONB NOT NULL,
  "last_operation_id" UUID NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "pos_offline_drafts_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "pos_offline_drafts_terminal_id_fkey"
    FOREIGN KEY ("terminal_id") REFERENCES "pos_terminals"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "pos_offline_drafts_revision_check" CHECK ("revision" > 0),
  CONSTRAINT "pos_offline_drafts_state_check" CHECK ("state" IN ('active', 'discarded')),
  CONSTRAINT "pos_offline_drafts_payload_object_check" CHECK (jsonb_typeof("payload") = 'object')
);

CREATE UNIQUE INDEX "pos_offline_drafts_terminal_draft_key"
  ON "pos_offline_drafts"("terminal_id", "draft_id");
CREATE UNIQUE INDEX "pos_offline_drafts_terminal_operation_key"
  ON "pos_offline_drafts"("terminal_id", "last_operation_id");
CREATE INDEX "pos_offline_drafts_terminal_state_updated_idx"
  ON "pos_offline_drafts"("terminal_id", "state", "updated_at");
