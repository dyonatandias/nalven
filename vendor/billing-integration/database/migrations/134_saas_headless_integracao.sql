-- 134: Credenciais servidor-a-servidor por produto para a API headless.
-- O segredo é exibido apenas na criação; o banco persiste somente SHA-256.

CREATE TABLE IF NOT EXISTS produto_api_credentials (
  id BIGSERIAL PRIMARY KEY,
  produto_id INTEGER NOT NULL REFERENCES produtos_saas(id) ON DELETE RESTRICT,
  nome VARCHAR(160) NOT NULL,
  key_hash CHAR(64) NOT NULL,
  key_prefix VARCHAR(32) NOT NULL,
  scopes TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  status VARCHAR(20) NOT NULL DEFAULT 'ativa'
    CHECK (status IN ('ativa', 'suspensa', 'revogada')),
  redes_permitidas CIDR[] NOT NULL DEFAULT ARRAY[]::CIDR[],
  requests_por_minuto INTEGER NOT NULL DEFAULT 300
    CHECK (requests_por_minuto BETWEEN 1 AND 5000),
  expira_em TIMESTAMPTZ,
  ultimo_uso_em TIMESTAMPTZ,
  ultimo_ip INET,
  total_requests BIGINT NOT NULL DEFAULT 0 CHECK (total_requests >= 0),
  criado_por INTEGER REFERENCES admins(id) ON DELETE SET NULL,
  revogado_por INTEGER REFERENCES admins(id) ON DELETE SET NULL,
  revogado_em TIMESTAMPTZ,
  motivo_revogacao TEXT,
  metadata JSONB NOT NULL DEFAULT '{}'::JSONB
    CHECK (jsonb_typeof(metadata) = 'object'),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT produto_api_credentials_hash_unique UNIQUE (key_hash),
  CONSTRAINT produto_api_credentials_hash_check CHECK (key_hash ~ '^[0-9a-f]{64}$'),
  CONSTRAINT produto_api_credentials_expiracao_check
    CHECK (expira_em IS NULL OR expira_em > created_at),
  CONSTRAINT produto_api_credentials_revogacao_check
    CHECK (status <> 'revogada' OR revogado_em IS NOT NULL)
);

CREATE INDEX IF NOT EXISTS idx_produto_api_credentials_produto_status
  ON produto_api_credentials (produto_id, status)
  WHERE status <> 'revogada';

CREATE INDEX IF NOT EXISTS idx_produto_api_credentials_expira
  ON produto_api_credentials (expira_em)
  WHERE expira_em IS NOT NULL AND status = 'ativa';

COMMENT ON TABLE produto_api_credentials IS
  'Credenciais de integração headless por produto; nunca armazena o segredo em texto puro';
COMMENT ON COLUMN produto_api_credentials.scopes IS
  'Permissões mínimas concedidas ao backend externo';
COMMENT ON COLUMN produto_api_credentials.redes_permitidas IS
  'CIDRs autorizados; vazio significa qualquer origem, ainda sujeita ao rate limit';

