CREATE TABLE "tenant_roles" (
  "id" SERIAL PRIMARY KEY,
  "key" TEXT NOT NULL UNIQUE,
  "name" TEXT NOT NULL,
  "description" TEXT,
  "permissions" JSONB NOT NULL,
  "system" BOOLEAN NOT NULL DEFAULT false,
  "active" BOOLEAN NOT NULL DEFAULT true,
  "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX "tenant_roles_active_name_idx" ON "tenant_roles"("active", "name");

CREATE TABLE "tenant_user_profiles" (
  "id" SERIAL PRIMARY KEY,
  "user_id" TEXT NOT NULL UNIQUE,
  "role_id" INTEGER NOT NULL REFERENCES "tenant_roles"("id"),
  "display_name" TEXT NOT NULL,
  "email" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'active',
  "last_synced_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX "tenant_user_profiles_role_id_status_idx" ON "tenant_user_profiles"("role_id", "status");
