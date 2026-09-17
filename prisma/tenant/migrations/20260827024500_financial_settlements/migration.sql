ALTER TABLE "financial_titles"
  ADD COLUMN "customer_id" INTEGER REFERENCES "customers"("id") ON DELETE SET NULL,
  ADD COLUMN "document_number" TEXT,
  ADD COLUMN "paid_amount" DOUBLE PRECISION NOT NULL DEFAULT 0,
  ADD COLUMN "notes" TEXT;
CREATE INDEX "financial_titles_customer_id_idx" ON "financial_titles"("customer_id");

CREATE TABLE "financial_settlements" (
  "id" SERIAL PRIMARY KEY,
  "title_id" INTEGER NOT NULL REFERENCES "financial_titles"("id"),
  "amount" DOUBLE PRECISION NOT NULL,
  "interest" DOUBLE PRECISION NOT NULL DEFAULT 0,
  "discount" DOUBLE PRECISION NOT NULL DEFAULT 0,
  "method" TEXT NOT NULL,
  "notes" TEXT,
  "settled_by" TEXT NOT NULL,
  "settled_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX "financial_settlements_title_id_settled_at_idx" ON "financial_settlements"("title_id", "settled_at");
