# Runbook — compensações eletrônicas

## Estado atual

A migration `20260829260000_pos_payment_compensations` e o serviço `pos-payment-compensation-persistence.ts` implementam o ciclo persistente próprio de `void` e `refund`: claim com lease, conclusão idempotente, T1/T2 separados, reconciliação de estados incertos e callback assinado. Isso **não habilita PSP, TEF ou SmartPOS**: não há adapter de produção/homologado neste repositório e os gates públicos de cancelamento/devolução eletrônicos continuam ativos.

## Invariantes

- a compensação referencia pagamento, intent, conector, credencial, venda, aprovação, terminal, turno e ator originais;
- a aprovação precisa ser independente e corresponder ao snapshot financeiro exato de cancelamento/devolução;
- o valor solicitado fica reservado antes do dispatch;
- reservas concorrentes e refunds materializados nunca podem superar o pagamento original;
- refund eletrônico sem `compensation_id` é recusado pelo banco;
- o resultado do provedor possui referência e evidência próprias e se torna imutável quando persistido;
- `provider_state=succeeded` não materializa refund local;
- a aplicação local ocorre em outra transação e cria exatamente um `PosSalePayment(type=refund)` vinculado;
- falha local depois de sucesso externo vira `application_state=blocked`/incidente e nunca volta ao dispatch financeiro;
- timeout ou lease expirado depois do claim vira `unknown`; somente uma tentativa `query` pode prosseguir;
- falha de transporte/contrato de uma `query` nunca equivale a recusa financeira e mantém a reserva em revisão manual;
- o callback usa segredo exclusivo `payment_compensation_callback_secret` e domínio HMAC `pos-compensation.v1`; segredos genéricos de webhook/pagamento não são aceitos.

## Fluxo persistente implementado

1. Recalcular a operação comercial e consumir snapshot/aprovação exatos sob lock.
2. `requestPosPaymentCompensation` reserva o delta e cria attempt/outbox.
3. O worker autorizado reclama `/api/internal/pdv/payment-compensations/outbox/:organizationId`, chama o provider fora da aplicação com a mesma chave idempotente e conclui a entrega. A aplicação nunca fabrica o resultado do provider.
4. Timeout pós-dispatch ou lease expirado vira `unknown` e agenda apenas `query`.
5. T1 persiste resultado/callback externo e evidência imutável.
6. T2 materializa o refund no ledger de pagamentos e atualiza o pagamento original de modo idempotente.
7. Divergência de valor, referência ou evidência abre incidente bloqueante; não há correção manual de status.

Na implementação atual, T2 cobre atomicamente o ledger de pagamentos: cria exatamente um `PosSalePayment(type=refund, compensationId=...)` e muda o pagamento original para `partially_refunded`/`refunded`. Os efeitos comerciais, físicos e fiscais continuam protegidos pelos gates públicos e precisam de finalização coordenada antes da habilitação operacional.

## Contratos internos

- `POST /api/internal/pdv/payment-compensations/outbox/:organizationId`, com bearer `NALVEN_INTERNAL_JOB_TOKEN`:
  - `{"action":"compensation.outbox.claim","workerId":"...","limit":25,"leaseSeconds":60}`;
  - `{"action":"compensation.outbox.complete","attemptId":"...","claimToken":"...","result":...}`.
- `POST /api/internal/pdv/payment-compensations/process`, com o mesmo bearer:
  - `{"action":"compensation.maintenance","organizationLimit":20,"itemLimit":25}`.
- `POST /api/webhooks/pos-payment-compensations/:organizationId/:provider`:
  - headers `x-pos-timestamp`, `x-pos-event-id`, `x-pos-key-id`, `x-pos-signature`;
  - assinatura `HMAC-SHA256(secret, "pos-compensation.v1.<timestamp>.<eventId>.<raw-body>")`;
  - segredo dedicado, com no mínimo 32 bytes, em `payment_compensation_callback_secret`.

`known_failure.retryable=true` declara que o provider comprovadamente não executou a operação e permite retry da mesma chave. Qualquer ausência dessa certeza deve ser retornada como `unknown`. O worker não deve transformar timeout, desconexão ou resposta ambígua em `known_failure`.

## Evidência local disponível

- parser/estado/hash: `tests/pos-payment-compensations.test.ts`;
- boundary/HMAC/PAN: `tests/pos-payment-compensation-persistence.test.ts`;
- contrato estático T1/T2/lease/callback: `tests/pos-payment-compensation-persistence-contract.test.ts`;
- concorrência, anti-overrefund, bloqueio de refund falso, worker T1, T2 e replay: `tests/pos-payment-compensations-postgres.integration.test.ts`;
- schema e constraints: `prisma/tenant/migrations/20260829260000_pos_payment_compensations/migration.sql`.

## Gate para habilitação

Não remover os bloqueios eletrônicos de `sale.cancel`/`return.create` antes de concluir: adapter real homologado, configuração segura do segredo dedicado, finalização comercial/física/fiscal completa, reconciliação operacional, alertas de incidentes, PostgreSQL/E2E com crash/timeout/callback fora de ordem e aceite do adquirente. A presença do outbox ou do T2 local, isoladamente, não autoriza ativação.
