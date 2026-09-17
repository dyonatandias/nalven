CREATE TABLE "pos_admin_mutations" (
  "id" BIGSERIAL PRIMARY KEY,
  "key" TEXT NOT NULL,
  "actor_id" TEXT NOT NULL,
  "action" TEXT NOT NULL,
  "request_hash" TEXT NOT NULL,
  "state" TEXT NOT NULL DEFAULT 'processing',
  "entity_type" TEXT,
  "entity_id" TEXT,
  "response_status" INTEGER,
  "response_body" JSONB,
  "expires_at" TIMESTAMP(3) NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT now(),
  "updated_at" TIMESTAMP(3) NOT NULL DEFAULT now(),
  CONSTRAINT "pos_admin_mutations_key_check" CHECK (char_length("key") BETWEEN 16 AND 160 AND "key" ~ '^[A-Za-z0-9._:-]+$'),
  CONSTRAINT "pos_admin_mutations_action_check" CHECK ("action" IN ('register.create', 'register.update', 'register.deactivate', 'terminal.create', 'terminal.update', 'terminal.deactivate', 'device.create', 'device.update', 'device.deactivate', 'connector.create', 'connector.update', 'connector.deactivate')),
  CONSTRAINT "pos_admin_mutations_hash_check" CHECK ("request_hash" ~ '^[0-9a-f]{64}$'),
  CONSTRAINT "pos_admin_mutations_state_check" CHECK ("state" IN ('processing', 'completed')),
  CONSTRAINT "pos_admin_mutations_response_status_check" CHECK ("response_status" IS NULL OR "response_status" BETWEEN 200 AND 599),
  CONSTRAINT "pos_admin_mutations_completion_check" CHECK (("state" = 'processing' AND "response_status" IS NULL AND "response_body" IS NULL) OR ("state" = 'completed' AND "response_status" IS NOT NULL AND "response_body" IS NOT NULL))
);

CREATE UNIQUE INDEX "pos_admin_mutations_key_key" ON "pos_admin_mutations"("key");
CREATE INDEX "pos_admin_mutations_state_expires_at_idx" ON "pos_admin_mutations"("state", "expires_at");

-- PostgreSQL otherwise treats NULL register_id values as distinct and would allow
-- duplicate branch-wide connectors with the same type/provider.
DROP INDEX "pos_connectors_branch_id_register_id_type_provider_key";
CREATE UNIQUE INDEX "pos_connectors_branch_id_register_id_type_provider_key"
  ON "pos_connectors"("branch_id", "register_id", "type", "provider") NULLS NOT DISTINCT;
