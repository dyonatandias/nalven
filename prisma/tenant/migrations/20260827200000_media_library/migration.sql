CREATE TABLE "media_assets" (
  "id" TEXT PRIMARY KEY,
  "name" TEXT NOT NULL,
  "original_name" TEXT NOT NULL,
  "storage_key" TEXT NOT NULL UNIQUE,
  "mime_type" TEXT NOT NULL,
  "kind" TEXT NOT NULL,
  "size_bytes" INTEGER NOT NULL,
  "checksum" TEXT NOT NULL,
  "alt_text" TEXT NOT NULL DEFAULT '',
  "folder" TEXT NOT NULL DEFAULT 'geral',
  "uploaded_by_id" TEXT NOT NULL,
  "uploaded_by_name" TEXT NOT NULL,
  "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "deleted_at" TIMESTAMPTZ
);
CREATE INDEX "media_assets_kind_folder_created_at_idx" ON "media_assets"("kind", "folder", "created_at");
CREATE INDEX "media_assets_deleted_at_created_at_idx" ON "media_assets"("deleted_at", "created_at");
ALTER TABLE "products" ADD COLUMN "image_media_id" TEXT REFERENCES "media_assets"("id") ON DELETE SET NULL;
CREATE INDEX "products_image_media_id_idx" ON "products"("image_media_id");
