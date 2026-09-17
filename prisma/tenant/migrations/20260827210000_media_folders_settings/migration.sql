CREATE TABLE "media_folders" (
  "id" SERIAL PRIMARY KEY,
  "name" TEXT NOT NULL UNIQUE,
  "slug" TEXT NOT NULL UNIQUE,
  "color" TEXT NOT NULL DEFAULT '#168151',
  "system" BOOLEAN NOT NULL DEFAULT false,
  "created_by" TEXT NOT NULL,
  "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);
INSERT INTO "media_folders" ("name", "slug", "color", "system", "created_by") VALUES
  ('Geral', 'geral', '#168151', true, 'Sistema NALVEN'),
  ('Identidade visual', 'identidade-visual', '#6f58b5', true, 'Sistema NALVEN'),
  ('Produtos', 'produtos', '#2878a8', true, 'Sistema NALVEN'),
  ('Clientes', 'clientes', '#b06b35', true, 'Sistema NALVEN'),
  ('Fornecedores', 'fornecedores', '#4f7c68', true, 'Sistema NALVEN'),
  ('Documentos fiscais', 'documentos-fiscais', '#9b603f', true, 'Sistema NALVEN'),
  ('Contratos', 'contratos', '#526a99', true, 'Sistema NALVEN'),
  ('Marketing', 'marketing', '#a54972', true, 'Sistema NALVEN'),
  ('Temporários', 'temporarios', '#7b858b', true, 'Sistema NALVEN')
ON CONFLICT ("name") DO NOTHING;

ALTER TABLE "tenant_settings"
  ADD COLUMN "logo_media_id" TEXT REFERENCES "media_assets"("id") ON DELETE SET NULL,
  ADD COLUMN "accent_color" TEXT NOT NULL DEFAULT '#168151',
  ADD COLUMN "interface_density" TEXT NOT NULL DEFAULT 'comfortable',
  ADD COLUMN "default_sidebar_mode" TEXT NOT NULL DEFAULT 'expanded',
  ADD COLUMN "operational_phone" TEXT,
  ADD COLUMN "auto_generate_sku" BOOLEAN NOT NULL DEFAULT true,
  ADD COLUMN "allow_negative_stock" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "quote_validity_days" INTEGER NOT NULL DEFAULT 15,
  ADD COLUMN "max_discount_percent" DOUBLE PRECISION NOT NULL DEFAULT 20,
  ADD COLUMN "daily_summary_time" TEXT NOT NULL DEFAULT '18:00',
  ADD COLUMN "notify_overdue_titles" BOOLEAN NOT NULL DEFAULT true,
  ADD COLUMN "notify_new_sales" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "quote_footer" TEXT,
  ADD COLUMN "receipt_footer" TEXT,
  ADD COLUMN "terms_and_conditions" TEXT,
  ADD COLUMN "data_protection_email" TEXT;
CREATE INDEX "tenant_settings_logo_media_id_idx" ON "tenant_settings"("logo_media_id");
