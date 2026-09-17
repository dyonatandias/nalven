ALTER TABLE "sales_orders" ADD COLUMN "branch_id" INTEGER;
CREATE INDEX "sales_orders_branch_id_status_created_at_idx" ON "sales_orders"("branch_id", "status", "created_at");
ALTER TABLE "sales_orders" ADD CONSTRAINT "sales_orders_branch_id_fkey" FOREIGN KEY ("branch_id") REFERENCES "branches"("id") ON DELETE SET NULL ON UPDATE CASCADE;
UPDATE "sales_orders" so SET "branch_id" = b."id" FROM "branches" b WHERE b."primary" = true AND so."branch_id" IS NULL;
