# Runbook — reconciliação manual de pagamento

Status: **IN PROGRESS / NÃO OPERACIONAL para novos casos**.

## Estado atual

O fluxo legado `PosManualPaymentReference` registra uma confirmação humana local; não consulta nem homologa PSP e não é prova de fundos. Ele permanece selado para leitura, revogação compatível e investigação histórica. Não crie novas operações financiáveis por esse mecanismo e nunca converta aprovação antiga em `confirmed_paid`.

O aggregate autoritativo da wave 320000 está especificado no [Plano 320000](./PLANO-RECONCILIACAO-MANUAL-320000.md). Sua fundação fail-closed já possui migration, schema, selagem do legado, domínio inicial e segregação negativa de roles; ainda não possui APIs/UI, procedures de capacidade, callback/T2a/T2b, vault ou adapter homologados. O aggregate 310000 continua recusando `proofKind=manual`.

## Semântica futura contratada

1. Maker abre um caso contextual e a referência aberta é tokenizada no cofre.
2. Checker distinto, com grant explícito, alçada viva e step-up, autoriza somente a consulta.
3. Worker consulta adapter homologado; resposta/callback autenticado gera observation append-only.
4. T1 pode produzir `confirmed_paid` com TTL curto do banco. `unknown`, `no_funds`, `expired` e `blocked` não financiam venda.
5. T2a reserva a prova para draft/plano/slot exatos; T2b cria venda/pagamento e consome a reserva atomicamente. Falha mantém `application_pending` para o finalizador idempotente.

`manual_confirmed` nunca é `captured`; IDs externos e timestamps de autorização/captura permanecem nulos. Confirmação tardia abre incidente, não autoaplica. Refund eletrônico continua exigindo compensação e adapter homologado.

## Operação enquanto bloqueado

- Não ofereça “marcar como pago”, não use referência manual como substituto de Pix/TEF/SmartPOS e não contorne o bloqueio do plano 310000.
- Para legado `consumed`, localize a venda vinculada e preserve toda evidência. Para `pending`/`revoked`, não reaproveite nem promova; classifique para a futura migração.
- Duplicidade, divergência de valor/provider/contexto ou confirmação externa tardia exigem incidente de conciliação. Nunca edite ou apague o histórico.
- Nunca registre PAN, CVV, trilha, PIN, credencial ou referência aberta em ticket, log, URL, auditoria ou mensagem de erro.

## Gates para habilitação futura

- migration/schema 320000, backfill reiniciável e clone representativo reconciliado;
- vault/KMS, HMAC com key-id, retenção e scrub verificável do texto legado;
- adapter/credencial/callback homologados, egress allowlist e consulta com arquivo/ambiente real;
- maker-checker dedicado, T1/T2a/T2b, worker/finalizador, incidentes, métricas e alertas;
- matriz PostgreSQL concorrente, SQL adversarial, HTTP/browser/E2E e runbook de resposta aprovado.

Até esses gates passarem, as flags de criação, consulta e aplicação permanecem desligadas. Simulador ou fake adapter comprova somente contrato local, nunca prontidão financeira.
