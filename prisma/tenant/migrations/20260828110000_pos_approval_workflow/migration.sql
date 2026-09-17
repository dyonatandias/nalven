ALTER TABLE "pos_approvals"
  ADD COLUMN "branch_id" INTEGER,
  ADD COLUMN "idempotency_key" TEXT,
  ADD COLUMN "request_hash" TEXT,
  ADD COLUMN "decision_reason" TEXT,
  ADD COLUMN "consumed_at" TIMESTAMP(3),
  ADD COLUMN "consumed_by" TEXT,
  ADD COLUMN "consumption_ref" TEXT;

CREATE UNIQUE INDEX "pos_approvals_branch_id_requester_id_idempotency_key_key"
  ON "pos_approvals"("branch_id", "requester_id", "idempotency_key");

CREATE INDEX "pos_approvals_branch_id_status_expires_at_idx"
  ON "pos_approvals"("branch_id", "status", "expires_at");

ALTER TABLE "pos_approvals"
  ADD CONSTRAINT "pos_approvals_branch_id_fkey"
  FOREIGN KEY ("branch_id") REFERENCES "branches"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;
