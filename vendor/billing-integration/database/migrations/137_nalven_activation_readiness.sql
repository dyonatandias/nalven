-- 137: Metadados operacionais e separação explícita de ambiente para a
-- ativação headless do NALVEN. Nenhum segredo é persistido nesta migration.

ALTER TABLE produto_api_credentials
  ADD COLUMN IF NOT EXISTS ambiente VARCHAR(20) NOT NULL DEFAULT 'producao';

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname='produto_api_credentials_ambiente_check'
  ) THEN
    ALTER TABLE produto_api_credentials
      ADD CONSTRAINT produto_api_credentials_ambiente_check
      CHECK (ambiente IN ('local','sandbox','homologacao','producao'));
  END IF;
END $$;

UPDATE produto_api_credentials
SET ambiente='homologacao',updated_at=NOW()
WHERE metadata->>'origem'='smoke_deploy';

CREATE INDEX IF NOT EXISTS idx_produto_api_credentials_ambiente_status
  ON produto_api_credentials (produto_id, ambiente, status, expira_em);

UPDATE produtos_saas
SET versao_atual='0.9.0',
    metadata=metadata || jsonb_build_object(
      'api_headless_version','3.0.1',
      'saas_production_url','https://nalven.com.br',
      'webhook_url','https://nalven.com.br/api/webhooks/billing',
      'tenant_identifier','organization.slug',
      'license_cache_seconds',300,
      'release_strategy','releases imutáveis com rollback de symlink',
      'publication_blocker','Homologação de credencial, webhook assinado, cartão e NFS-e pendente'
    ),
    updated_at=NOW()
WHERE codigo='nalven';

UPDATE integration_connections
SET metadata=metadata || jsonb_build_object(
      'webhook_secret_sha256_prefix','2d01107bcefaac01',
      'saas_version','0.9.0',
      'tenant_identifier','organization.slug'
    ),
    updated_at=NOW()
WHERE produto_id=(SELECT id FROM produtos_saas WHERE codigo='nalven')
  AND provider='nalven'
  AND ambiente='producao'
  AND archived_at IS NULL;

COMMENT ON COLUMN produto_api_credentials.ambiente IS
  'Ambiente isolado da credencial; produção e homologação nunca compartilham segredo';
