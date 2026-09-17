-- 140: Segredos específicos de conectores e webhooks passam a ser cifrados no
-- banco. Apenas uma chave-mestra global permanece no ambiente/KMS do Billing.

ALTER TABLE integration_connections
  ADD COLUMN IF NOT EXISTS secret_encrypted TEXT,
  ADD COLUMN IF NOT EXISTS secret_fingerprint VARCHAR(16),
  ADD COLUMN IF NOT EXISTS secret_updated_at TIMESTAMPTZ;

ALTER TABLE webhook_subscriptions
  ADD COLUMN IF NOT EXISTS secret_encrypted TEXT,
  ADD COLUMN IF NOT EXISTS secret_fingerprint VARCHAR(16),
  ADD COLUMN IF NOT EXISTS secret_updated_at TIMESTAMPTZ;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='integration_connections_secret_fingerprint_check') THEN
    ALTER TABLE integration_connections ADD CONSTRAINT integration_connections_secret_fingerprint_check CHECK (secret_fingerprint IS NULL OR secret_fingerprint ~ '^[0-9a-f]{16}$');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='webhook_subscriptions_secret_fingerprint_check') THEN
    ALTER TABLE webhook_subscriptions ADD CONSTRAINT webhook_subscriptions_secret_fingerprint_check CHECK (secret_fingerprint IS NULL OR secret_fingerprint ~ '^[0-9a-f]{16}$');
  END IF;
END $$;

COMMENT ON COLUMN integration_connections.secret_encrypted IS 'Credencial cifrada em AES-256-GCM; nunca devolvida pelas APIs administrativas';
COMMENT ON COLUMN webhook_subscriptions.secret_encrypted IS 'Segredo HMAC cifrado em AES-256-GCM; nunca devolvido pelas APIs administrativas';
COMMENT ON COLUMN integration_connections.secret_fingerprint IS 'Primeiros 16 caracteres do SHA-256 para conferência sem revelar o segredo';
COMMENT ON COLUMN webhook_subscriptions.secret_fingerprint IS 'Primeiros 16 caracteres do SHA-256 para conferência sem revelar o segredo';
