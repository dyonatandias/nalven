CREATE TABLE "vault_secrets" (
  "key" TEXT PRIMARY KEY,
  "cipher_text" TEXT NOT NULL,
  "masked_value" TEXT NOT NULL,
  "fingerprint" TEXT NOT NULL,
  "category" TEXT NOT NULL,
  "updated_by_id" TEXT,
  "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX "vault_secrets_category_idx" ON "vault_secrets"("category");

INSERT INTO "system_settings" ("key", "value", "updated_at")
VALUES ('billing', '{"baseUrl":"https://sistema.agenciaexpresso.com.br/api/v1","headlessBaseUrl":"https://sistema.agenciaexpresso.com.br/api/v1/saas","publicAppUrl":"https://nalven.com.br","productCode":"nalven","appVersion":"0.9.0","licenseTimeoutMs":5000,"licenseCacheSeconds":300}'::jsonb, CURRENT_TIMESTAMP)
ON CONFLICT ("key") DO NOTHING;
