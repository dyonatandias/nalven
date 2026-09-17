ALTER TABLE "sales" ADD COLUMN "cost_center_id" INTEGER;
ALTER TABLE "sales" ADD CONSTRAINT "sales_cost_center_id_fkey"
  FOREIGN KEY ("cost_center_id") REFERENCES "cost_centers"("id") ON DELETE SET NULL;
CREATE INDEX "sales_cost_center_id_created_at_idx" ON "sales"("cost_center_id", "created_at");
