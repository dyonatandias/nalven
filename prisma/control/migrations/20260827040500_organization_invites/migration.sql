CREATE TABLE "organization_invites" (
  "id" TEXT PRIMARY KEY,
  "organization_id" TEXT NOT NULL REFERENCES "organizations"("id") ON DELETE CASCADE,
  "email" TEXT NOT NULL,
  "name" TEXT,
  "role_key" TEXT NOT NULL,
  "token_hash" TEXT NOT NULL UNIQUE,
  "status" TEXT NOT NULL DEFAULT 'pending',
  "expires_at" TIMESTAMPTZ NOT NULL,
  "invited_by_id" TEXT NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
  "accepted_at" TIMESTAMPTZ,
  "revoked_at" TIMESTAMPTZ,
  "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX "organization_invites_organization_id_status_created_at_idx" ON "organization_invites"("organization_id", "status", "created_at");
CREATE INDEX "organization_invites_email_status_idx" ON "organization_invites"("email", "status");
