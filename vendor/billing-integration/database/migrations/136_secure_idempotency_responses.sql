-- 136: Respostas idempotentes podem conter segredos exibidos uma única vez
-- (por exemplo, a primeira chave de licença headless). O JSON em claro fica
-- mantido apenas para compatibilidade de leitura durante a transição; novas
-- respostas são persistidas cifradas em AES-256-GCM pela aplicação.

ALTER TABLE api_idempotency_keys
  ADD COLUMN IF NOT EXISTS response_body_encrypted TEXT;

COMMENT ON COLUMN api_idempotency_keys.response_body IS
  'Compatibilidade legada; novas respostas devem usar response_body_encrypted';

COMMENT ON COLUMN api_idempotency_keys.response_body_encrypted IS
  'Resposta idempotente cifrada em AES-256-GCM; protege chaves retornadas uma única vez';
