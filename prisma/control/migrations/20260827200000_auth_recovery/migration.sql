CREATE TABLE "password_reset_tokens" (
  "id" TEXT PRIMARY KEY,
  "user_id" TEXT NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
  "token_hash" TEXT NOT NULL UNIQUE,
  "expires_at" TIMESTAMPTZ NOT NULL,
  "used_at" TIMESTAMPTZ,
  "requested_ip" TEXT,
  "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX "password_reset_tokens_user_id_created_at_idx" ON "password_reset_tokens"("user_id", "created_at");
CREATE INDEX "password_reset_tokens_expires_at_used_at_idx" ON "password_reset_tokens"("expires_at", "used_at");

CREATE TABLE "email_outbox" (
  "id" TEXT PRIMARY KEY,
  "recipient" TEXT NOT NULL,
  "template" TEXT NOT NULL,
  "subject" TEXT NOT NULL,
  "html_body" TEXT NOT NULL,
  "text_body" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'pending',
  "attempts" INTEGER NOT NULL DEFAULT 0,
  "last_error" TEXT,
  "sent_at" TIMESTAMPTZ,
  "next_attempt_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX "email_outbox_status_next_attempt_at_idx" ON "email_outbox"("status", "next_attempt_at");
