ALTER TABLE "pos_terminals"
  ADD COLUMN "token_issued_at" TIMESTAMP(3),
  ADD COLUMN "token_expires_at" TIMESTAMP(3),
  ADD COLUMN "credential_version" INTEGER NOT NULL DEFAULT 0;

-- Credenciais legadas sem envelope contextual não podem ser promovidas ao novo
-- protocolo. Elas falham fechadas e exigem novo pareamento.
UPDATE "pos_terminals"
SET
  "token_hash" = NULL,
  "certificate_fingerprint" = NULL,
  "status" = CASE WHEN "status" = 'revoked' THEN 'revoked' ELSE 'unpaired' END,
  "credential_version" = 0
WHERE "token_hash" IS NOT NULL
  AND "token_hash" !~ '^hmac-sha256:v1:[0-9a-f]{64}$';

UPDATE "pos_terminals"
SET
  "token_issued_at" = COALESCE("paired_at", "updated_at", now()),
  "token_expires_at" = now() + INTERVAL '30 days',
  "credential_version" = 1
WHERE "token_hash" ~ '^hmac-sha256:v1:[0-9a-f]{64}$';

ALTER TABLE "pos_terminals"
  ADD CONSTRAINT "pos_terminals_token_lifecycle_check"
  CHECK (
    ("token_hash" IS NULL AND "token_issued_at" IS NULL AND "token_expires_at" IS NULL)
    OR
    ("token_hash" ~ '^hmac-sha256:v1:[0-9a-f]{64}$' AND "token_issued_at" IS NOT NULL AND "token_expires_at" > "token_issued_at" AND "credential_version" > 0)
  );

CREATE INDEX "pos_terminals_token_expires_at_idx" ON "pos_terminals"("token_expires_at") WHERE "token_hash" IS NOT NULL;

CREATE TABLE "pos_terminal_pairings" (
  "id" TEXT PRIMARY KEY,
  "terminal_id" TEXT NOT NULL,
  "code_hash" TEXT NOT NULL,
  "code_last_four" TEXT NOT NULL,
  "state" TEXT NOT NULL DEFAULT 'pending',
  "attempts" INTEGER NOT NULL DEFAULT 0,
  "max_attempts" INTEGER NOT NULL DEFAULT 5,
  "idempotency_key" TEXT NOT NULL,
  "request_hash" TEXT NOT NULL,
  "correlation_id" TEXT NOT NULL,
  "created_by" TEXT NOT NULL,
  "expires_at" TIMESTAMP(3) NOT NULL,
  "consumed_at" TIMESTAMP(3),
  "revoked_at" TIMESTAMP(3),
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT now(),
  CONSTRAINT "pos_terminal_pairings_terminal_id_fkey" FOREIGN KEY ("terminal_id") REFERENCES "pos_terminals"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "pos_terminal_pairings_state_check" CHECK ("state" IN ('pending', 'consumed', 'revoked', 'expired')),
  CONSTRAINT "pos_terminal_pairings_attempts_check" CHECK ("attempts" >= 0 AND "max_attempts" BETWEEN 1 AND 20 AND "attempts" <= "max_attempts"),
  CONSTRAINT "pos_terminal_pairings_hash_check" CHECK ("code_hash" ~ '^hmac-sha256:v1:[0-9a-f]{64}$'),
  CONSTRAINT "pos_terminal_pairings_last_four_check" CHECK ("code_last_four" ~ '^[0-9A-F]{4}$'),
  CONSTRAINT "pos_terminal_pairings_idempotency_check" CHECK (char_length("idempotency_key") BETWEEN 16 AND 160 AND "idempotency_key" ~ '^[A-Za-z0-9._:-]+$'),
  CONSTRAINT "pos_terminal_pairings_request_hash_check" CHECK ("request_hash" ~ '^[0-9a-f]{64}$'),
  CONSTRAINT "pos_terminal_pairings_expiry_check" CHECK ("expires_at" > "created_at"),
  CONSTRAINT "pos_terminal_pairings_state_time_check" CHECK (
    ("state" = 'pending' AND "consumed_at" IS NULL AND "revoked_at" IS NULL)
    OR ("state" = 'consumed' AND "consumed_at" IS NOT NULL AND "revoked_at" IS NULL)
    OR ("state" = 'revoked' AND "consumed_at" IS NULL AND "revoked_at" IS NOT NULL)
    OR ("state" = 'expired' AND "consumed_at" IS NULL)
  )
);

CREATE UNIQUE INDEX "pos_terminal_pairings_code_hash_key" ON "pos_terminal_pairings"("code_hash");
CREATE UNIQUE INDEX "pos_terminal_pairings_idempotency_key_key" ON "pos_terminal_pairings"("idempotency_key");
CREATE INDEX "pos_terminal_pairings_terminal_id_state_expires_at_idx" ON "pos_terminal_pairings"("terminal_id", "state", "expires_at");
CREATE INDEX "pos_terminal_pairings_state_expires_at_idx" ON "pos_terminal_pairings"("state", "expires_at");

ALTER TABLE "pos_print_jobs"
  ADD COLUMN "claim_id" TEXT,
  ADD COLUMN "claimed_at" TIMESTAMP(3),
  ADD COLUMN "claim_expires_at" TIMESTAMP(3);

ALTER TABLE "pos_print_jobs"
  ADD CONSTRAINT "pos_print_jobs_claim_check"
  CHECK (
    ("claim_id" IS NULL AND "claimed_at" IS NULL AND "claim_expires_at" IS NULL)
    OR
    ("claim_id" IS NOT NULL AND "claimed_at" IS NOT NULL AND "claim_expires_at" > "claimed_at")
  );

CREATE UNIQUE INDEX "pos_print_jobs_claim_id_key" ON "pos_print_jobs"("claim_id");
CREATE INDEX "pos_print_jobs_claim_expiry_idx" ON "pos_print_jobs"("terminal_id", "status", "claim_expires_at");

ALTER TABLE "pos_admin_mutations" DROP CONSTRAINT "pos_admin_mutations_action_check";
ALTER TABLE "pos_admin_mutations" ADD CONSTRAINT "pos_admin_mutations_action_check" CHECK ("action" IN (
  'register.create', 'register.update', 'register.deactivate',
  'terminal.create', 'terminal.update', 'terminal.deactivate',
  'device.create', 'device.update', 'device.deactivate',
  'connector.create', 'connector.update', 'connector.deactivate',
  'terminal.pairing.issue', 'terminal.token.rotate', 'terminal.revoke'
));
