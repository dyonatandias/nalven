ALTER TABLE "sales"
  ADD COLUMN "fulfillment_mode" VARCHAR(20) NOT NULL DEFAULT 'on_site';

ALTER TABLE "pos_held_sales"
  ADD COLUMN "fulfillment_mode" VARCHAR(20) NOT NULL DEFAULT 'on_site';

ALTER TABLE "sales"
  ADD CONSTRAINT "sales_fulfillment_mode_check"
  CHECK ("fulfillment_mode" IN ('on_site', 'pickup', 'delivery'));

ALTER TABLE "pos_held_sales"
  ADD CONSTRAINT "pos_held_sales_fulfillment_mode_check"
  CHECK ("fulfillment_mode" IN ('on_site', 'pickup', 'delivery'));
