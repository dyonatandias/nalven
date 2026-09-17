-- Canonical product catalog: core, pricing, stock, fiscal, media, variations and channels.
CREATE TABLE "product_brands" (
  "id" SERIAL PRIMARY KEY,
  "name" TEXT NOT NULL,
  "slug" TEXT NOT NULL,
  "description" TEXT,
  "logo_media_id" TEXT,
  "active" BOOLEAN NOT NULL DEFAULT true,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "product_brands_name_key" UNIQUE ("name"),
  CONSTRAINT "product_brands_slug_key" UNIQUE ("slug"),
  CONSTRAINT "product_brands_logo_media_id_fkey" FOREIGN KEY ("logo_media_id") REFERENCES "media_assets"("id") ON DELETE SET NULL ON UPDATE CASCADE
);

CREATE INDEX "product_brands_active_name_idx" ON "product_brands"("active", "name");

ALTER TABLE "products"
  ADD COLUMN "slug" TEXT,
  ADD COLUMN "gtin" TEXT,
  ADD COLUMN "gtin_tributary" TEXT,
  ADD COLUMN "mpn" TEXT,
  ADD COLUMN "model" TEXT,
  ADD COLUMN "catalog_type" TEXT NOT NULL DEFAULT 'simple',
  ADD COLUMN "status" TEXT NOT NULL DEFAULT 'publish',
  ADD COLUMN "catalog_visibility" TEXT NOT NULL DEFAULT 'visible',
  ADD COLUMN "featured" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "short_description" TEXT,
  ADD COLUMN "menu_order" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "regular_price" DOUBLE PRECISION NOT NULL DEFAULT 0,
  ADD COLUMN "sale_price" DOUBLE PRECISION,
  ADD COLUMN "sale_starts_at" TIMESTAMP(3),
  ADD COLUMN "sale_ends_at" TIMESTAMP(3),
  ADD COLUMN "installment_price" DOUBLE PRECISION,
  ADD COLUMN "cash_price" DOUBLE PRECISION,
  ADD COLUMN "minimum_sale_price" DOUBLE PRECISION,
  ADD COLUMN "target_margin" DOUBLE PRECISION,
  ADD COLUMN "pricing_source" TEXT NOT NULL DEFAULT 'auto',
  ADD COLUMN "cogs_value" DOUBLE PRECISION,
  ADD COLUMN "brand_id" INTEGER,
  ADD COLUMN "manage_stock" BOOLEAN NOT NULL DEFAULT true,
  ADD COLUMN "stock_status" TEXT NOT NULL DEFAULT 'instock',
  ADD COLUMN "backorders" TEXT NOT NULL DEFAULT 'no',
  ADD COLUMN "sold_individually" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "total_sales" DOUBLE PRECISION NOT NULL DEFAULT 0,
  ADD COLUMN "weight" DOUBLE PRECISION,
  ADD COLUMN "weight_unit" TEXT NOT NULL DEFAULT 'kg',
  ADD COLUMN "length" DOUBLE PRECISION,
  ADD COLUMN "width" DOUBLE PRECISION,
  ADD COLUMN "height" DOUBLE PRECISION,
  ADD COLUMN "dimension_unit" TEXT NOT NULL DEFAULT 'cm',
  ADD COLUMN "net_weight" DOUBLE PRECISION,
  ADD COLUMN "gross_weight" DOUBLE PRECISION,
  ADD COLUMN "volumes" INTEGER,
  ADD COLUMN "items_per_box" DOUBLE PRECISION,
  ADD COLUMN "shipping_class" TEXT,
  ADD COLUMN "cross_docking_days" INTEGER,
  ADD COLUMN "free_shipping" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "virtual" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "tax_status" TEXT NOT NULL DEFAULT 'taxable',
  ADD COLUMN "tax_class" TEXT,
  ADD COLUMN "downloadable" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "download_limit" INTEGER,
  ADD COLUMN "download_expiry_days" INTEGER,
  ADD COLUMN "external_url" TEXT,
  ADD COLUMN "button_text" TEXT,
  ADD COLUMN "reviews_allowed" BOOLEAN NOT NULL DEFAULT true,
  ADD COLUMN "average_rating" DOUBLE PRECISION NOT NULL DEFAULT 0,
  ADD COLUMN "rating_count" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "likes_count" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "purchase_note" TEXT,
  ADD COLUMN "warranty_months" DOUBLE PRECISION,
  ADD COLUMN "condition" TEXT NOT NULL DEFAULT 'new',
  ADD COLUMN "fiscal_type" TEXT NOT NULL DEFAULT 'product',
  ADD COLUMN "production" TEXT,
  ADD COLUMN "expiry_date" DATE,
  ADD COLUMN "ncm" TEXT,
  ADD COLUMN "cest" TEXT,
  ADD COLUMN "origin" TEXT,
  ADD COLUMN "sped_item_type" TEXT,
  ADD COLUMN "tax_burden_rate" DOUBLE PRECISION,
  ADD COLUMN "additional_invoice_info" TEXT,
  ADD COLUMN "icms_st_base" DOUBLE PRECISION,
  ADD COLUMN "icms_st_value" DOUBLE PRECISION,
  ADD COLUMN "icms_substitute_value" DOUBLE PRECISION,
  ADD COLUMN "ipi_exception_code" TEXT,
  ADD COLUMN "ipi_classification" TEXT,
  ADD COLUMN "pis_fixed_value" DOUBLE PRECISION,
  ADD COLUMN "cofins_fixed_value" DOUBLE PRECISION,
  ADD COLUMN "csosn" TEXT,
  ADD COLUMN "fci" TEXT,
  ADD COLUMN "anatel_code" TEXT,
  ADD COLUMN "anvisa_code" TEXT,
  ADD COLUMN "inmetro_code" TEXT,
  ADD COLUMN "mapa_code" TEXT,
  ADD COLUMN "gender" TEXT,
  ADD COLUMN "seo_title" TEXT,
  ADD COLUMN "seo_description" TEXT,
  ADD COLUMN "seo_noindex" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "seo_canonical" TEXT,
  ADD COLUMN "seo_focus_keyword" TEXT,
  ADD COLUMN "seo_secondary_keywords" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  ADD COLUMN "seo_score" INTEGER,
  ADD COLUMN "seo_schema_type" TEXT NOT NULL DEFAULT 'Product',
  ADD COLUMN "seo_og_image_media_id" TEXT,
  ADD COLUMN "video_type" TEXT,
  ADD COLUMN "video_url" TEXT,
  ADD COLUMN "video_media_id" TEXT,
  ADD COLUMN "video_thumbnail_media_id" TEXT,
  ADD COLUMN "video_aspect_ratio" TEXT,
  ADD COLUMN "default_variation_rule" TEXT NOT NULL DEFAULT 'lowest_price',
  ADD COLUMN "badges" JSONB,
  ADD COLUMN "carousel_config" JSONB,
  ADD COLUMN "configurator_data" JSONB,
  ADD COLUMN "custom_fields" JSONB;

UPDATE "products"
SET "slug" = COALESCE(NULLIF(TRIM(BOTH '-' FROM REGEXP_REPLACE(LOWER(TRANSLATE("name", 'áàâãäéèêëíìîïóòôõöúùûüçñ', 'aaaaaeeeeiiiiooooouuuucn')), '[^a-z0-9]+', '-', 'g')), ''), 'produto') || '-' || "id",
    "regular_price" = "price",
    "fiscal_type" = CASE WHEN "type" = 'service' THEN 'service' ELSE 'product' END,
    "virtual" = CASE WHEN "type" = 'service' THEN true ELSE false END,
    "manage_stock" = CASE WHEN "type" = 'service' THEN false ELSE true END,
    "stock_status" = CASE WHEN "stock" > 0 THEN 'instock' ELSE 'outofstock' END,
    "seo_schema_type" = CASE WHEN "type" = 'service' THEN 'Service' ELSE 'Product' END;

UPDATE "products" SET "expiry_date" = "expiry"::DATE WHERE "expiry" ~ '^\d{4}-\d{2}-\d{2}$';

ALTER TABLE "products" ALTER COLUMN "slug" SET NOT NULL;
ALTER TABLE "products" ADD CONSTRAINT "products_slug_key" UNIQUE ("slug");
ALTER TABLE "products" ADD CONSTRAINT "products_brand_id_fkey" FOREIGN KEY ("brand_id") REFERENCES "product_brands"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "products" ADD CONSTRAINT "products_seo_og_image_media_id_fkey" FOREIGN KEY ("seo_og_image_media_id") REFERENCES "media_assets"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "products" ADD CONSTRAINT "products_video_media_id_fkey" FOREIGN KEY ("video_media_id") REFERENCES "media_assets"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "products" ADD CONSTRAINT "products_video_thumbnail_media_id_fkey" FOREIGN KEY ("video_thumbnail_media_id") REFERENCES "media_assets"("id") ON DELETE SET NULL ON UPDATE CASCADE;

CREATE INDEX "products_brand_id_idx" ON "products"("brand_id");
CREATE INDEX "products_status_catalog_visibility_idx" ON "products"("status", "catalog_visibility");
CREATE INDEX "products_gtin_idx" ON "products"("gtin");

CREATE TABLE "product_slug_redirects" (
  "id" SERIAL PRIMARY KEY,
  "product_id" INTEGER NOT NULL,
  "old_slug" TEXT NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "product_slug_redirects_old_slug_key" UNIQUE ("old_slug"),
  CONSTRAINT "product_slug_redirects_product_id_fkey" FOREIGN KEY ("product_id") REFERENCES "products"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX "product_slug_redirects_product_id_idx" ON "product_slug_redirects"("product_id");

CREATE TABLE "product_images" (
  "id" SERIAL PRIMARY KEY,
  "product_id" INTEGER NOT NULL,
  "media_asset_id" TEXT NOT NULL,
  "position" INTEGER NOT NULL DEFAULT 0,
  "alt_text" TEXT,
  CONSTRAINT "product_images_product_id_media_asset_id_key" UNIQUE ("product_id", "media_asset_id"),
  CONSTRAINT "product_images_product_id_fkey" FOREIGN KEY ("product_id") REFERENCES "products"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "product_images_media_asset_id_fkey" FOREIGN KEY ("media_asset_id") REFERENCES "media_assets"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX "product_images_product_id_position_idx" ON "product_images"("product_id", "position");

CREATE TABLE "product_category_links" (
  "product_id" INTEGER NOT NULL,
  "category_id" INTEGER NOT NULL,
  "primary" BOOLEAN NOT NULL DEFAULT false,
  CONSTRAINT "product_category_links_pkey" PRIMARY KEY ("product_id", "category_id"),
  CONSTRAINT "product_category_links_product_id_fkey" FOREIGN KEY ("product_id") REFERENCES "products"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "product_category_links_category_id_fkey" FOREIGN KEY ("category_id") REFERENCES "categories"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX "product_category_links_category_id_idx" ON "product_category_links"("category_id");
INSERT INTO "product_category_links" ("product_id", "category_id", "primary") SELECT "id", "category_id", true FROM "products" WHERE "category_id" IS NOT NULL ON CONFLICT DO NOTHING;

CREATE TABLE "product_tags" (
  "id" SERIAL PRIMARY KEY,
  "name" TEXT NOT NULL,
  "slug" TEXT NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "product_tags_name_key" UNIQUE ("name"),
  CONSTRAINT "product_tags_slug_key" UNIQUE ("slug")
);

CREATE TABLE "product_tag_links" (
  "product_id" INTEGER NOT NULL,
  "tag_id" INTEGER NOT NULL,
  CONSTRAINT "product_tag_links_pkey" PRIMARY KEY ("product_id", "tag_id"),
  CONSTRAINT "product_tag_links_product_id_fkey" FOREIGN KEY ("product_id") REFERENCES "products"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "product_tag_links_tag_id_fkey" FOREIGN KEY ("tag_id") REFERENCES "product_tags"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX "product_tag_links_tag_id_idx" ON "product_tag_links"("tag_id");

CREATE TABLE "product_attributes" (
  "id" SERIAL PRIMARY KEY,
  "product_id" INTEGER NOT NULL,
  "name" TEXT NOT NULL,
  "slug" TEXT NOT NULL,
  "type" TEXT NOT NULL DEFAULT 'select',
  "swatch_type" TEXT NOT NULL DEFAULT 'select',
  "scope" TEXT NOT NULL DEFAULT 'local',
  "visible" BOOLEAN NOT NULL DEFAULT true,
  "variation" BOOLEAN NOT NULL DEFAULT false,
  "position" INTEGER NOT NULL DEFAULT 0,
  CONSTRAINT "product_attributes_product_id_slug_key" UNIQUE ("product_id", "slug"),
  CONSTRAINT "product_attributes_product_id_fkey" FOREIGN KEY ("product_id") REFERENCES "products"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX "product_attributes_product_id_position_idx" ON "product_attributes"("product_id", "position");

CREATE TABLE "product_attribute_options" (
  "id" SERIAL PRIMARY KEY,
  "attribute_id" INTEGER NOT NULL,
  "name" TEXT NOT NULL,
  "value" TEXT NOT NULL,
  "color" TEXT,
  "image_media_id" TEXT,
  "position" INTEGER NOT NULL DEFAULT 0,
  CONSTRAINT "product_attribute_options_attribute_id_value_key" UNIQUE ("attribute_id", "value"),
  CONSTRAINT "product_attribute_options_attribute_id_fkey" FOREIGN KEY ("attribute_id") REFERENCES "product_attributes"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "product_attribute_options_image_media_id_fkey" FOREIGN KEY ("image_media_id") REFERENCES "media_assets"("id") ON DELETE SET NULL ON UPDATE CASCADE
);
CREATE INDEX "product_attribute_options_attribute_id_position_idx" ON "product_attribute_options"("attribute_id", "position");

CREATE TABLE "product_variations" (
  "id" SERIAL PRIMARY KEY,
  "product_id" INTEGER NOT NULL,
  "sku" TEXT,
  "gtin" TEXT,
  "status" TEXT NOT NULL DEFAULT 'publish',
  "attributes" JSONB NOT NULL,
  "regular_price" DOUBLE PRECISION,
  "sale_price" DOUBLE PRECISION,
  "sale_starts_at" TIMESTAMP(3),
  "sale_ends_at" TIMESTAMP(3),
  "manage_stock" TEXT NOT NULL DEFAULT 'parent',
  "stock" DOUBLE PRECISION,
  "stock_status" TEXT,
  "backorders" TEXT,
  "weight" DOUBLE PRECISION,
  "length" DOUBLE PRECISION,
  "width" DOUBLE PRECISION,
  "height" DOUBLE PRECISION,
  "image_media_id" TEXT,
  "video_url" TEXT,
  "description" TEXT,
  "enabled" BOOLEAN NOT NULL DEFAULT true,
  "menu_order" INTEGER NOT NULL DEFAULT 0,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "product_variations_sku_key" UNIQUE ("sku"),
  CONSTRAINT "product_variations_product_id_fkey" FOREIGN KEY ("product_id") REFERENCES "products"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "product_variations_image_media_id_fkey" FOREIGN KEY ("image_media_id") REFERENCES "media_assets"("id") ON DELETE SET NULL ON UPDATE CASCADE
);
CREATE INDEX "product_variations_product_id_menu_order_idx" ON "product_variations"("product_id", "menu_order");
CREATE INDEX "product_variations_gtin_idx" ON "product_variations"("gtin");

CREATE TABLE "product_variation_images" (
  "id" SERIAL PRIMARY KEY,
  "variation_id" INTEGER NOT NULL,
  "media_asset_id" TEXT NOT NULL,
  "position" INTEGER NOT NULL DEFAULT 0,
  CONSTRAINT "product_variation_images_variation_id_media_asset_id_key" UNIQUE ("variation_id", "media_asset_id"),
  CONSTRAINT "product_variation_images_variation_id_fkey" FOREIGN KEY ("variation_id") REFERENCES "product_variations"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "product_variation_images_media_asset_id_fkey" FOREIGN KEY ("media_asset_id") REFERENCES "media_assets"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX "product_variation_images_variation_id_position_idx" ON "product_variation_images"("variation_id", "position");

CREATE TABLE "product_downloads" (
  "id" SERIAL PRIMARY KEY,
  "product_id" INTEGER NOT NULL,
  "name" TEXT NOT NULL,
  "url" TEXT,
  "media_asset_id" TEXT,
  "position" INTEGER NOT NULL DEFAULT 0,
  CONSTRAINT "product_downloads_product_id_fkey" FOREIGN KEY ("product_id") REFERENCES "products"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "product_downloads_media_asset_id_fkey" FOREIGN KEY ("media_asset_id") REFERENCES "media_assets"("id") ON DELETE SET NULL ON UPDATE CASCADE
);
CREATE INDEX "product_downloads_product_id_position_idx" ON "product_downloads"("product_id", "position");

CREATE TABLE "product_cost_items" (
  "id" SERIAL PRIMARY KEY,
  "product_id" INTEGER NOT NULL,
  "type" TEXT NOT NULL DEFAULT 'direct',
  "label" TEXT NOT NULL,
  "value" DOUBLE PRECISION NOT NULL,
  CONSTRAINT "product_cost_items_product_id_fkey" FOREIGN KEY ("product_id") REFERENCES "products"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX "product_cost_items_product_id_type_idx" ON "product_cost_items"("product_id", "type");

CREATE TABLE "product_price_tiers" (
  "id" SERIAL PRIMARY KEY,
  "product_id" INTEGER NOT NULL,
  "minimum_qty" DOUBLE PRECISION NOT NULL,
  "maximum_qty" DOUBLE PRECISION,
  "price" DOUBLE PRECISION NOT NULL,
  CONSTRAINT "product_price_tiers_product_id_fkey" FOREIGN KEY ("product_id") REFERENCES "products"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX "product_price_tiers_product_id_minimum_qty_idx" ON "product_price_tiers"("product_id", "minimum_qty");

CREATE TABLE "product_relations" (
  "product_id" INTEGER NOT NULL,
  "related_product_id" INTEGER NOT NULL,
  "type" TEXT NOT NULL,
  "position" INTEGER NOT NULL DEFAULT 0,
  CONSTRAINT "product_relations_pkey" PRIMARY KEY ("product_id", "related_product_id", "type"),
  CONSTRAINT "product_relations_product_id_fkey" FOREIGN KEY ("product_id") REFERENCES "products"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "product_relations_related_product_id_fkey" FOREIGN KEY ("related_product_id") REFERENCES "products"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX "product_relations_related_product_id_type_idx" ON "product_relations"("related_product_id", "type");

CREATE TABLE "product_marketplace_profiles" (
  "id" SERIAL PRIMARY KEY,
  "product_id" INTEGER NOT NULL,
  "channel_id" INTEGER,
  "platform" TEXT NOT NULL,
  "remote_category_id" TEXT,
  "remote_catalog_product_id" TEXT,
  "listing_type" TEXT,
  "attributes" JSONB,
  "sale_terms" JSONB,
  "price_override" DOUBLE PRECISION,
  "stock_override" DOUBLE PRECISION,
  "readiness" INTEGER NOT NULL DEFAULT 0,
  "ready" BOOLEAN NOT NULL DEFAULT false,
  "missing_fields" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  "warnings" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  "content_hash" TEXT,
  "drift_detected_at" TIMESTAMP(3),
  "last_validated_at" TIMESTAMP(3),
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "product_marketplace_profiles_product_id_channel_id_platform_key" UNIQUE ("product_id", "channel_id", "platform"),
  CONSTRAINT "product_marketplace_profiles_product_id_fkey" FOREIGN KEY ("product_id") REFERENCES "products"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "product_marketplace_profiles_channel_id_fkey" FOREIGN KEY ("channel_id") REFERENCES "marketplace_channels"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX "product_marketplace_profiles_platform_ready_idx" ON "product_marketplace_profiles"("platform", "ready");
