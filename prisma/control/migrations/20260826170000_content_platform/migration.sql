CREATE TABLE "media_assets" (
  "id" TEXT PRIMARY KEY, "name" TEXT NOT NULL, "file_name" TEXT NOT NULL,
  "mime_type" TEXT NOT NULL, "size_bytes" INTEGER NOT NULL, "path" TEXT NOT NULL,
  "alt_text" TEXT NOT NULL DEFAULT '', "folder" TEXT NOT NULL DEFAULT 'geral',
  "uploaded_by_id" TEXT NOT NULL, "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX "media_assets_folder_created_at_idx" ON "media_assets"("folder", "created_at");
CREATE TABLE "seo_entries" (
  "path" TEXT PRIMARY KEY, "title" TEXT NOT NULL, "description" TEXT NOT NULL,
  "canonical" TEXT, "robots" TEXT NOT NULL DEFAULT 'index,follow', "image_url" TEXT,
  "schema_json" JSONB, "updated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE "blog_posts" (
  "id" TEXT PRIMARY KEY, "slug" TEXT NOT NULL UNIQUE, "title" TEXT NOT NULL,
  "excerpt" TEXT NOT NULL, "content" TEXT NOT NULL, "cover_url" TEXT,
  "status" TEXT NOT NULL DEFAULT 'draft', "author_name" TEXT NOT NULL,
  "seo_title" TEXT, "seo_description" TEXT, "published_at" TIMESTAMPTZ,
  "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX "blog_posts_status_published_at_idx" ON "blog_posts"("status", "published_at");
CREATE TABLE "glossary_terms" (
  "id" TEXT PRIMARY KEY, "slug" TEXT NOT NULL UNIQUE, "term" TEXT NOT NULL,
  "definition" TEXT NOT NULL, "related" JSONB NOT NULL, "status" TEXT NOT NULL DEFAULT 'draft',
  "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX "glossary_terms_status_term_idx" ON "glossary_terms"("status", "term");
