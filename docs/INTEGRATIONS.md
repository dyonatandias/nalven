# Integrações NALVEN

O domínio de integrações pertence ao banco isolado de cada organização. O catálogo é declarativo, enquanto credenciais, rotas, health, filas, webhooks, opt-outs, auditoria, uso de IA, e-mails transacionais e migrações de mídia são dados do tenant.

## Segurança

- `secrets_cipher_text` contém somente JSON cifrado por AES-256-GCM (`v1`) com `NALVEN_SECRETS_MASTER_KEY` fora do banco.
- Leituras devolvem apenas `has_*` e preview dos quatro últimos caracteres; valores vazios ou mascarados preservam o segredo atual.
- URLs de saída exigem HTTPS, DNS exclusivamente público, porta permitida e IP fixado na conexão para impedir SSRF e DNS rebinding. Redirects para outra origem perdem automaticamente tokens, cookies e chaves de autenticação.
- Webhooks usam HMAC-SHA256 sobre `timestamp.corpo`, janela anti-replay de cinco minutos e ID único de evento.
- Auditoria e respostas de diagnóstico passam por redaction recursiva.
- OTP armazena apenas hash salgado do código e aplica limites simultâneos por destinatário e IP. Endpoints administrativos usam limites persistentes no banco, válidos entre réplicas.
- Destinatários e variáveis da central transacional ficam cifrados; histórico e auditoria exibem somente o endereço mascarado.
- O ERP não recebe nem persiste PAN, CVV ou PIN. Cartão é processado pelo equipamento/adquirente homologado e o PDV guarda apenas referências permitidas.

## Fronteiras de produto

- WhatsApp não é provider interno. Automações externas consomem os webhooks neutros e autenticados do ERP.
- OTP é exclusivamente por e-mail SMTP.
- Pagamentos presenciais, Pix, links, TEF e SmartPOS são administrados na Central de pagamentos e associados ao caixa por rotas explícitas.
- OpenAI possui política gerenciada, BYOK ou híbrida, orçamento por tenant, limites por recurso e telemetria sem conteúdo da solicitação.

## Operação

As áreas são separadas por responsabilidade: `/erp/integracoes` para webhooks e serviços gerais, `/erp/pagamentos` para adquirentes e rotas do PDV, `/erp/emails-transacionais` para catálogo/versionamento/histórico, `/erp/ia` para OpenAI e `/erp/configuracoes-pdv` para caixas, terminais e periféricos. A API autenticada está sob `/api/erp/integrations`, webhooks de saída sob `/api/erp/webhooks` e callbacks públicos assinados sob `/api/webhooks/integrations/{organizationId}/{provider}`.

O worker `npm run jobs:integrations` processa:

1. health checks de todas as contas e alertas por outbox de e-mail independente, com anti-flapping;
2. fila de mensagens com fallback somente para falhas de transporte;
3. fila transacional SMTP com idempotência, dados cifrados, opt-out, backoff e dead letter;
4. webhooks com backoff, dead letter e auto-pausa;
5. webhooks recebidos, incluindo reconciliação idempotente de pagamentos;
6. offload retomável de mídia e remoção local somente após confirmação remota e retenção;
7. limpeza de states OAuth expirados e limites distribuídos vencidos.

Ele é executado pelo timer de tenants existente, via `deploy/process-tenant-jobs.sh`.

## Implantação

Aplicar primeiro as migrações do control-plane e depois a migração em todos os bancos de tenant:

```bash
prisma migrate deploy --config prisma.control.config.ts
prisma migrate deploy --config prisma.tenant.config.ts
```

O bootstrap já executa essa ordem para novas instalações e novos tenants. Configure `NALVEN_SECRETS_MASTER_KEY` antes de salvar a primeira credencial; perder essa chave torna os segredos irrecuperáveis.

Rotas de pagamento começam inativas. Para ativá-las é obrigatório vincular uma credencial, manter a família de pagamentos habilitada e concluir o teste de saúde. Credenciais e terminais reais, sandbox e homologação continuam sendo etapas externas de cada adquirente.

## Validação local

```bash
npm run test:integrations
npm run lint
npx tsc --noEmit
npx next build --experimental-build-mode compile
```
