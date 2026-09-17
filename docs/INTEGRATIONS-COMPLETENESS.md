# Mapa de completude das integrações

Revisão item a item da especificação `Integrações — Especificação Completa de Implementação`, atualizada em 02/09/2026. O estado `concluído` significa que há modelo, regra de domínio, API e/ou operação correspondente no NALVEN; não significa que uma credencial, equipamento ou homologação externa de produção já foi fornecida.

|   # | Recurso                          | Estado    | Implementação e melhoria aplicada                                                                                                                                       |
| --: | -------------------------------- | --------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
|   1 | Catálogo declarativo             | Concluído | `IntegrationProvider`, catálogo tipado e seed idempotente.                                                                                                              |
|   2 | Configuração e segredo separados | Concluído | JSON não sensível separado de `secrets_cipher_text`.                                                                                                                    |
|   3 | Criptografia at-rest versionada  | Concluído | AES-256-GCM `v1`; chave fora do banco.                                                                                                                                  |
|   4 | Máscara e preservação            | Concluído | Preview de quatro caracteres e POST vazio preserva o valor.                                                                                                             |
|   5 | Redação                          | Concluído | Redação recursiva em auditoria, diagnósticos e eventos expostos.                                                                                                        |
|   6 | Contrato de provider             | Concluído | Retorno discriminado com `message_id` e falha de transporte/negócio.                                                                                                    |
|   7 | Registro e fallback seguro       | Concluído | Resolução centralizada; configuração inválida degrada para provider universal.                                                                                          |
|   8 | Providers reais                  | Concluído | SMTP, OpenAI, armazenamento, marketplaces e catálogo multiprovedor de pagamento. WhatsApp direto foi removido.                                                          |
|   9 | Roteamento por contexto          | Concluído | Notificação, link de pagamento e automação; WhatsApp externo recebe eventos por webhook neutro.                                                                         |
|  10 | Automático e `_none`             | Concluído | Prioridade declarativa e desativação explícita do fallback.                                                                                                             |
|  11 | Contrato de saúde                | Concluído | Resultado uniforme com sucesso, mensagem, latência e detalhes seguros.                                                                                                  |
|  12 | Health isolado                   | Concluído | Timeout, identidade da conta e teste específico de escrita/leitura no S3.                                                                                               |
|  13 | Agregado e leitura de cache      | Concluído | Teste de todas as contas e endpoint `last` sem chamada externa.                                                                                                         |
|  14 | Histórico e estado atual         | Concluído | Log por conta e estado agregado por provider.                                                                                                                           |
|  15 | Abas e URLs                      | Concluído | Dez abas, allowlist e redirects de parâmetros legados.                                                                                                                  |
|  16 | Responsividade                   | Concluído | Grade desktop e `select` móvel bloqueado até hidratação.                                                                                                                |
|  17 | Card operacional                 | Concluído | Toggle, formulário pelo schema, teste inline por conta e cooldown.                                                                                                      |
|  18 | Estado compartilhado             | Concluído | Painéis permanecem montados; rascunhos sobrevivem à troca de aba.                                                                                                       |
|  19 | Limites por destinatário e IP    | Concluído | Janela persistente de OTP, cooldown entre envios e limites distribuídos para APIs administrativas.                                                                      |
|  20 | Fraude                           | Concluído | Score por frequência e diversidade, faixa suspeita e bloqueio.                                                                                                          |
|  21 | Mensageria                       | Concluído | Envio SMTP real, fallback apenas para transporte, armazenamento do ID remoto e rejeição fechada de canais diretos removidos.                                            |
|  22 | SSRF e DNS rebinding             | Concluído | HTTPS, DNS público, IP fixado e revalidação em redirects. Headers sensíveis são removidos ao trocar de origem.                                                          |
|  23 | Templates                        | Concluído | Central com 66 eventos, versões draft/publicada/arquivada, preview, teste e histórico por versão.                                                                       |
|  24 | OTP por contexto                 | Concluído | Política por contexto, SMTP obrigatório, hash salgado, expiração, rate limit e métricas.                                                                                |
|  25 | Webhooks de saída                | Concluído | HMAC, timestamp, UUID comum por evento e tópicos de pedidos/produtos/clientes/cupons. Eventos das entidades existentes são emitidos no mesmo commit.                    |
|  26 | Retentativas                     | Concluído | Backoff, dead letter, reenvio manual, resposta truncada e auto-pausa.                                                                                                   |
|  27 | Fila e métricas                  | Concluído | Filtros, paginação, payload, top errors, canais, séries e métricas OTP.                                                                                                 |
|  28 | Auditoria                        | Concluído | Antes/depois redigido, ator, IP, filtros e detalhe no painel.                                                                                                           |
|  29 | Monitor ativo                    | Concluído | Todas as contas, limiar, anti-flapping, teto diário, recuperação e alerta via outbox de e-mail independente.                                                            |
|  30 | OAuth                            | Concluído | State de uso único, PKCE S256, callback, expiração, refresh sob advisory lock transacional de 40 s e limpeza de states.                                                 |
|  31 | Multi-conta                      | Concluído | Gestão de várias contas, padrão único no banco e recursos de marketplace vinculados por `credential_id`.                                                                |
|  32 | Pagamentos recebidos             | Concluído | Hub para Mercado Pago, Banco Inter, Cielo, Stone e PagBank; rotas por caixa, intents, artefatos Pix/link cifrados, assinatura, anti-replay e reconciliação idempotente. |
|  33 | Frete                            | Concluído | Cotação real com markup e tarifa plana de continuidade quando o serviço falha.                                                                                          |
|  34 | IA                               | Concluído | OpenAI via Responses API, modos gerenciado/BYOK/híbrido, retenção desligada, redação, orçamento, limites e observabilidade de tokens/latência.                          |
|  35 | Armazenamento/CDN                | Concluído | Teste PUT/GET/DELETE, migração retomável, progresso, verificação remota e retenção local.                                                                               |

## Endurecimentos adicionais desta revisão

- Segredo de webhook rotacionável com confirmação e exibição única.
- Histórico de entregas com payload/resposta, HTTP, latência e retry.
- Opt-outs exportáveis em CSV; auditoria filtrável por ação, alvo e período.
- Eventos recebidos visíveis no painel e processados pelo worker.
- Índice parcial garante uma única conta padrão por provider mesmo sob concorrência.
- Exclusão permite remover uma conta secundária sem bloquear por rotas que usam a conta padrão, mas continua impedindo órfãos reais.
- Central de pagamentos exige conta testada antes da ativação de cada rota.
- Artefatos de pagamento expostos ao operador possuem tipo fechado, HTTPS quando aplicável, expiração e armazenamento cifrado.
- A fila de e-mail transacional protege destinatário e variáveis em repouso e recupera execuções interrompidas.

## Dependências de ativação externa

Providers continuam `não configurados` até que cada organização forneça suas próprias credenciais, URLs, remetentes, contas e equipamentos. OAuth depende do cadastro do callback no provedor; SmartPOS/TEF dependem também de sandbox, dispositivo e homologação da adquirente. Essas são ações operacionais externas, não lacunas de código.
