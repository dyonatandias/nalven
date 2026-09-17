ALTER TABLE "categories"
  ADD COLUMN "code" TEXT,
  ADD COLUMN "visibility" TEXT NOT NULL DEFAULT 'visible',
  ADD COLUMN "menu_order" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "seo_title" TEXT,
  ADD COLUMN "seo_description" TEXT,
  ADD COLUMN "seo_noindex" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "version" INTEGER NOT NULL DEFAULT 1;

CREATE UNIQUE INDEX "categories_code_key" ON "categories"("code");
DROP INDEX IF EXISTS "categories_active_name_idx";
CREATE INDEX "categories_active_visibility_menu_order_name_idx" ON "categories"("active", "visibility", "menu_order", "name");
CREATE INDEX "categories_type_active_idx" ON "categories"("type", "active");

ALTER TABLE "categories"
  ADD CONSTRAINT "categories_type_check" CHECK ("type" IN ('product', 'service', 'both')),
  ADD CONSTRAINT "categories_visibility_check" CHECK ("visibility" IN ('visible', 'catalog', 'hidden')),
  ADD CONSTRAINT "categories_color_check" CHECK ("color" ~ '^#[0-9A-Fa-f]{6}$'),
  ADD CONSTRAINT "categories_menu_order_check" CHECK ("menu_order" BETWEEN 0 AND 999999),
  ADD CONSTRAINT "categories_version_check" CHECK ("version" >= 1),
  ADD CONSTRAINT "categories_parent_self_check" CHECK ("parent_id" IS NULL OR "parent_id" <> "id");

CREATE OR REPLACE FUNCTION prevent_category_cycle() RETURNS trigger AS $$
BEGIN
  IF NEW.parent_id IS NULL THEN RETURN NEW; END IF;
  IF NEW.parent_id = NEW.id OR EXISTS (
    WITH RECURSIVE ancestors AS (
      SELECT id, parent_id FROM categories WHERE id = NEW.parent_id
      UNION ALL
      SELECT category.id, category.parent_id
      FROM categories category
      JOIN ancestors parent ON category.id = parent.parent_id
    )
    SELECT 1 FROM ancestors WHERE id = NEW.id
  ) THEN
    RAISE EXCEPTION 'category hierarchy cycle' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER categories_prevent_cycle
  BEFORE INSERT OR UPDATE OF parent_id ON categories
  FOR EACH ROW EXECUTE FUNCTION prevent_category_cycle();

CREATE TABLE "category_attribute_templates" (
  "id" SERIAL PRIMARY KEY,
  "category_id" INTEGER NOT NULL REFERENCES "categories"("id") ON DELETE CASCADE,
  "name" TEXT NOT NULL,
  "type" TEXT NOT NULL DEFAULT 'text',
  "required" BOOLEAN NOT NULL DEFAULT false,
  "options" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  "unit" TEXT,
  "sort_order" INTEGER NOT NULL DEFAULT 0,
  "active" BOOLEAN NOT NULL DEFAULT true,
  "version" INTEGER NOT NULL DEFAULT 1,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "category_attribute_templates_type_check" CHECK ("type" IN ('text', 'number', 'select', 'boolean', 'date')),
  CONSTRAINT "category_attribute_templates_sort_check" CHECK ("sort_order" BETWEEN 0 AND 999999),
  CONSTRAINT "category_attribute_templates_version_check" CHECK ("version" >= 1),
  CONSTRAINT "category_attribute_templates_select_options_check" CHECK ("type" <> 'select' OR cardinality("options") > 0)
);
CREATE UNIQUE INDEX "category_attribute_templates_category_id_name_key" ON "category_attribute_templates"("category_id", "name");
CREATE INDEX "category_attribute_templates_category_id_active_sort_order_idx" ON "category_attribute_templates"("category_id", "active", "sort_order");

CREATE TABLE "category_marketplace_mappings" (
  "id" SERIAL PRIMARY KEY,
  "category_id" INTEGER NOT NULL REFERENCES "categories"("id") ON DELETE CASCADE,
  "platform" TEXT NOT NULL,
  "remote_category_id" TEXT NOT NULL,
  "remote_category_name" TEXT,
  "status" TEXT NOT NULL DEFAULT 'mapped',
  "last_synced_at" TIMESTAMP(3),
  "updated_by" TEXT,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "category_marketplace_mappings_status_check" CHECK ("status" IN ('mapped', 'pending', 'error'))
);
CREATE UNIQUE INDEX "category_marketplace_mappings_category_id_platform_key" ON "category_marketplace_mappings"("category_id", "platform");
CREATE INDEX "category_marketplace_mappings_platform_status_idx" ON "category_marketplace_mappings"("platform", "status");

CREATE TABLE "category_slug_redirects" (
  "id" SERIAL PRIMARY KEY,
  "category_id" INTEGER NOT NULL REFERENCES "categories"("id") ON DELETE CASCADE,
  "old_slug" TEXT NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE UNIQUE INDEX "category_slug_redirects_old_slug_key" ON "category_slug_redirects"("old_slug");
CREATE INDEX "category_slug_redirects_category_id_idx" ON "category_slug_redirects"("category_id");
