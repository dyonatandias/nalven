ALTER TABLE "product_cost_items"
  ALTER COLUMN "value" TYPE DECIMAL(12,2) USING ROUND("value"::numeric, 2),
  ADD COLUMN "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  ADD COLUMN "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;

ALTER TABLE "products" ADD COLUMN "cest_not_applicable" BOOLEAN NOT NULL DEFAULT false;

CREATE TABLE "report_settings" (
  "id" INTEGER NOT NULL DEFAULT 1,
  "pricing_mode" TEXT NOT NULL DEFAULT 'mixed',
  "global_target_margin" DECIMAL(7,2) NOT NULL DEFAULT 30,
  "global_minimum_margin" DECIMAL(7,2) NOT NULL DEFAULT 15,
  "fiscal_required_fields" TEXT[] NOT NULL DEFAULT ARRAY['ncm','cest','origin','gtin']::TEXT[],
  "updated_by" TEXT,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "report_settings_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "report_settings_singleton" CHECK ("id" = 1),
  CONSTRAINT "report_settings_pricing_mode" CHECK ("pricing_mode" IN ('global','product','mixed')),
  CONSTRAINT "report_settings_margin_range" CHECK ("global_target_margin" >= 0 AND "global_target_margin" <= 100 AND "global_minimum_margin" >= 0 AND "global_minimum_margin" <= 100)
);

CREATE TABLE "report_global_costs" (
  "id" SERIAL NOT NULL,
  "report_settings_id" INTEGER NOT NULL DEFAULT 1,
  "type" TEXT NOT NULL DEFAULT 'indirect',
  "label" VARCHAR(255) NOT NULL,
  "value" DECIMAL(12,2) NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "report_global_costs_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "report_global_costs_type" CHECK ("type" IN ('direct','indirect')),
  CONSTRAINT "report_global_costs_value" CHECK ("value" >= 0),
  CONSTRAINT "report_global_costs_report_settings_id_fkey" FOREIGN KEY ("report_settings_id") REFERENCES "report_settings"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE TABLE "category_pricing_overrides" (
  "id" SERIAL NOT NULL,
  "report_settings_id" INTEGER NOT NULL DEFAULT 1,
  "category_id" INTEGER NOT NULL,
  "target_margin" DECIMAL(7,2) NOT NULL,
  "minimum_margin" DECIMAL(7,2) NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "category_pricing_overrides_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "category_pricing_overrides_margin_range" CHECK ("target_margin" >= 0 AND "target_margin" <= 100 AND "minimum_margin" >= 0 AND "minimum_margin" <= 100),
  CONSTRAINT "category_pricing_overrides_report_settings_id_fkey" FOREIGN KEY ("report_settings_id") REFERENCES "report_settings"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "category_pricing_overrides_category_id_fkey" FOREIGN KEY ("category_id") REFERENCES "categories"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE INDEX "report_global_costs_report_settings_id_type_idx" ON "report_global_costs"("report_settings_id", "type");
CREATE UNIQUE INDEX "category_pricing_overrides_category_id_key" ON "category_pricing_overrides"("category_id");
CREATE INDEX "category_pricing_overrides_report_settings_id_idx" ON "category_pricing_overrides"("report_settings_id");

INSERT INTO "report_settings" ("id") VALUES (1) ON CONFLICT ("id") DO NOTHING;
