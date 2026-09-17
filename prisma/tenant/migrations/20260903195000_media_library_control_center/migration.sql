ALTER TABLE "media_assets"
  ADD COLUMN "description" TEXT,
  ADD COLUMN "tags" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  ADD COLUMN "source" TEXT NOT NULL DEFAULT 'upload',
  ADD COLUMN "version" INTEGER NOT NULL DEFAULT 1,
  ADD COLUMN "expires_at" TIMESTAMP(3);

UPDATE "media_assets"
SET "source" = 'catalog'
WHERE "uploaded_by_id" = 'seed';

CREATE TABLE "media_asset_favorites" (
  "asset_id" TEXT NOT NULL,
  "user_id" TEXT NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "media_asset_favorites_pkey" PRIMARY KEY ("asset_id", "user_id")
);

CREATE TABLE "media_asset_versions" (
  "id" SERIAL NOT NULL,
  "asset_id" TEXT NOT NULL,
  "version" INTEGER NOT NULL,
  "storage_key" TEXT NOT NULL,
  "original_name" TEXT NOT NULL,
  "mime_type" TEXT NOT NULL,
  "kind" TEXT NOT NULL,
  "size_bytes" INTEGER NOT NULL,
  "checksum" TEXT NOT NULL,
  "remote_key" TEXT,
  "remote_url" TEXT,
  "local_available" BOOLEAN NOT NULL DEFAULT true,
  "change_note" TEXT,
  "uploaded_by_id" TEXT NOT NULL,
  "uploaded_by_name" TEXT NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "media_asset_versions_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "media_assets_expires_at_idx" ON "media_assets"("expires_at");
CREATE INDEX "media_assets_tags_idx" ON "media_assets" USING GIN ("tags");
CREATE INDEX "media_asset_favorites_user_id_created_at_idx" ON "media_asset_favorites"("user_id", "created_at");
CREATE UNIQUE INDEX "media_asset_versions_storage_key_key" ON "media_asset_versions"("storage_key");
CREATE UNIQUE INDEX "media_asset_versions_asset_id_version_key" ON "media_asset_versions"("asset_id", "version");
CREATE INDEX "media_asset_versions_asset_id_created_at_idx" ON "media_asset_versions"("asset_id", "created_at");

ALTER TABLE "media_asset_favorites"
  ADD CONSTRAINT "media_asset_favorites_asset_id_fkey"
  FOREIGN KEY ("asset_id") REFERENCES "media_assets"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "media_asset_versions"
  ADD CONSTRAINT "media_asset_versions_asset_id_fkey"
  FOREIGN KEY ("asset_id") REFERENCES "media_assets"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "media_assets"
  ADD CONSTRAINT "media_assets_kind_check" CHECK ("kind" IN ('image', 'document', 'video')),
  ADD CONSTRAINT "media_assets_source_check" CHECK ("source" IN ('upload', 'catalog', 'integration', 'seed')),
  ADD CONSTRAINT "media_assets_version_check" CHECK ("version" >= 1),
  ADD CONSTRAINT "media_assets_size_check" CHECK ("size_bytes" >= 0),
  ADD CONSTRAINT "media_assets_tags_limit_check" CHECK (COALESCE(array_length("tags", 1), 0) <= 12);

ALTER TABLE "media_asset_versions"
  ADD CONSTRAINT "media_asset_versions_kind_check" CHECK ("kind" IN ('image', 'document', 'video')),
  ADD CONSTRAINT "media_asset_versions_version_check" CHECK ("version" >= 1),
  ADD CONSTRAINT "media_asset_versions_size_check" CHECK ("size_bytes" >= 0);
