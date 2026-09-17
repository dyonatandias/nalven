CREATE TABLE "integration_oauth_states" (
  "state" TEXT NOT NULL,
  "organization_id" TEXT NOT NULL,
  "user_id" TEXT NOT NULL,
  "platform" TEXT NOT NULL,
  "credential_id" TEXT,
  "redirect_uri" TEXT NOT NULL,
  "token_url" TEXT NOT NULL,
  "code_verifier" TEXT,
  "expires_at" TIMESTAMP(3) NOT NULL,
  "used_at" TIMESTAMP(3),
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "integration_oauth_states_pkey" PRIMARY KEY ("state")
);
CREATE INDEX "integration_oauth_states_organization_id_expires_at_idx" ON "integration_oauth_states"("organization_id", "expires_at");
