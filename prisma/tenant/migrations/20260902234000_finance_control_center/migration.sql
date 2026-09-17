ALTER TABLE "financial_titles"
  ADD COLUMN "branch_id" INTEGER,
  ADD COLUMN "account_id" INTEGER,
  ADD COLUMN "cost_center_id" INTEGER,
  ADD COLUMN "issue_at" DATE NOT NULL DEFAULT CURRENT_DATE,
  ADD COLUMN "competence_at" DATE,
  ADD COLUMN "category" TEXT,
  ADD COLUMN "payment_method" TEXT,
  ADD COLUMN "barcode" TEXT,
  ADD COLUMN "priority" TEXT NOT NULL DEFAULT 'normal',
  ADD COLUMN "recurrence_key" TEXT,
  ADD COLUMN "installment_number" INTEGER,
  ADD COLUMN "installment_count" INTEGER;

ALTER TABLE "financial_settlements"
  ADD COLUMN "account_id" INTEGER,
  ADD COLUMN "fee" DOUBLE PRECISION NOT NULL DEFAULT 0,
  ADD COLUMN "status" TEXT NOT NULL DEFAULT 'posted',
  ADD COLUMN "occurred_at" DATE NOT NULL DEFAULT CURRENT_DATE,
  ADD COLUMN "reversed_at" TIMESTAMP(3),
  ADD COLUMN "reversed_by" TEXT,
  ADD COLUMN "reversal_reason" TEXT;

ALTER TABLE "financial_titles"
  ADD CONSTRAINT "financial_titles_branch_id_fkey" FOREIGN KEY ("branch_id") REFERENCES "branches"("id") ON DELETE SET NULL ON UPDATE CASCADE,
  ADD CONSTRAINT "financial_titles_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "financial_accounts"("id") ON DELETE SET NULL ON UPDATE CASCADE,
  ADD CONSTRAINT "financial_titles_cost_center_id_fkey" FOREIGN KEY ("cost_center_id") REFERENCES "cost_centers"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "financial_settlements"
  ADD CONSTRAINT "financial_settlements_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "financial_accounts"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "financial_titles"
  ADD CONSTRAINT "financial_titles_priority_check" CHECK ("priority" IN ('low', 'normal', 'high', 'urgent')),
  ADD CONSTRAINT "financial_titles_installment_check" CHECK (("installment_number" IS NULL AND "installment_count" IS NULL) OR ("installment_number" >= 1 AND "installment_count" >= "installment_number" AND "installment_count" <= 120)),
  ADD CONSTRAINT "financial_titles_amount_check" CHECK ("amount" > 0 AND "paid_amount" >= 0 AND "paid_amount" <= "amount");

ALTER TABLE "financial_settlements"
  ADD CONSTRAINT "financial_settlements_values_check" CHECK ("amount" >= 0 AND "interest" >= 0 AND "discount" >= 0 AND "fee" >= 0),
  ADD CONSTRAINT "financial_settlements_status_check" CHECK ("status" IN ('posted', 'reversed'));

CREATE INDEX "financial_titles_branch_id_type_status_due_at_idx" ON "financial_titles"("branch_id", "type", "status", "due_at");
CREATE INDEX "financial_titles_account_id_due_at_idx" ON "financial_titles"("account_id", "due_at");
CREATE INDEX "financial_titles_cost_center_id_due_at_idx" ON "financial_titles"("cost_center_id", "due_at");
CREATE INDEX "financial_titles_recurrence_key_installment_number_idx" ON "financial_titles"("recurrence_key", "installment_number");
CREATE INDEX "financial_settlements_account_id_occurred_at_idx" ON "financial_settlements"("account_id", "occurred_at");
CREATE INDEX "financial_settlements_status_occurred_at_idx" ON "financial_settlements"("status", "occurred_at");
