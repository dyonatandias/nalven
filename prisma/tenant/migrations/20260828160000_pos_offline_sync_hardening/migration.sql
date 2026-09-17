-- PosSyncOperation was introduced as a neutral ledger in the POS foundation.
-- Harden its lifecycle before exposing the terminal offline synchronization API.
-- NOT VALID preserves rollout compatibility with pre-existing rows while still
-- enforcing every new or changed row. Validate the constraints after the
-- pre-deploy audit described in the offline synchronization runbook.

ALTER TABLE "pos_terminals"
  ADD CONSTRAINT "pos_terminals_last_sync_cursor_check"
  CHECK ("last_sync_cursor" >= 0) NOT VALID;

ALTER TABLE "pos_sync_operations"
  ADD CONSTRAINT "pos_sync_operations_sequence_check"
  CHECK ("sequence" > 0) NOT VALID,
  ADD CONSTRAINT "pos_sync_operations_operation_id_check"
  CHECK (
    "operation_id" ~ '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
  ) NOT VALID,
  ADD CONSTRAINT "pos_sync_operations_type_check"
  CHECK (
    char_length("type") BETWEEN 3 AND 64
    AND "type" ~ '^[a-z][a-z0-9]*(\.[a-z][a-z0-9]*){1,3}$'
  ) NOT VALID,
  ADD CONSTRAINT "pos_sync_operations_state_check"
  CHECK ("state" IN ('received', 'processing', 'applied', 'rejected', 'conflict')) NOT VALID,
  ADD CONSTRAINT "pos_sync_operations_request_hash_check"
  CHECK ("request_hash" ~ '^[0-9a-f]{64}$') NOT VALID,
  ADD CONSTRAINT "pos_sync_operations_payload_object_check"
  CHECK (jsonb_typeof("payload") = 'object') NOT VALID,
  ADD CONSTRAINT "pos_sync_operations_response_object_check"
  CHECK ("response" IS NULL OR jsonb_typeof("response") = 'object') NOT VALID,
  ADD CONSTRAINT "pos_sync_operations_conflict_object_check"
  CHECK ("conflict" IS NULL OR jsonb_typeof("conflict") = 'object') NOT VALID,
  ADD CONSTRAINT "pos_sync_operations_lifecycle_check"
  CHECK (
    ("state" IN ('received', 'processing') AND "processed_at" IS NULL AND "response" IS NULL AND "conflict" IS NULL)
    OR ("state" IN ('applied', 'rejected') AND "processed_at" IS NOT NULL AND "response" IS NOT NULL AND "conflict" IS NULL)
    OR ("state" = 'conflict' AND "processed_at" IS NOT NULL AND "conflict" IS NOT NULL)
  ) NOT VALID;

CREATE INDEX "pos_sync_operations_terminal_state_sequence_idx"
  ON "pos_sync_operations"("terminal_id", "state", "sequence");

CREATE INDEX "pos_sync_operations_terminal_occurred_idx"
  ON "pos_sync_operations"("terminal_id", "occurred_at");
