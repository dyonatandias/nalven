# Plano 321b–321d — reserva e aplicação da reconciliação manual

Status: **PLANNED / BLOQUEADO**. A 321a entrega apenas issuer/review. Este
plano não libera o gate e não permite `proofKind=manual` até toda a matriz de
aceite passar.

## Gaps P0 identificados

1. A guarda 310000 ainda exige a referência manual legada `consumed`; a tabela
   foi selada em 320000. O ramo manual precisa ser substituído pelo aggregate
   320000 sem alterar a migration histórica.
2. A guarda de application atual não prova, no commit, a ligação integral entre
   case, observation, application, venda, pagamento, plano consumido e txid.
3. `PosSalePayment` precisa de FK única para o case manual e de exclusividade
   contra intent, value account e referência legada.
4. O checkout atual concentra venda, itens, estoque rastreado, kits, promoção,
   valor, fiscal e outboxes em TypeScript. T2b não pode criar somente
   Sale/Payment e deixar efeitos obrigatórios para um commit posterior.
5. Quantidades legadas ainda usam ponto flutuante em partes do domínio. O
   primeiro corte deve comparar o snapshot vigente exatamente e registrar
   manifesto/hash; a migração para micros permanece obrigatória.

## 321b — T2a: reserva comercial

Procedure proposta:

`pos_manual_reserve_application_v1(case_id, expected_case_version,
actor_profile_id, actor_user_id, idempotency_key, request_hash)`

Ela deve ser `SECURITY DEFINER`, com `search_path` fixo, `PUBLIC` revogado e
`EXECUTE` nominal. O banco recalcula tempo e hash contextual. A ordem de locks é
sessão, terminal, perfis/grants, claim, draft, plano/slot,
connector/credential/gate, case, observation, incidentes e application.

Pré-condições: `confirmed_paid`, versão esperada, observation exata e causal,
`confirmation_expires_at` vigente após os locks, nenhum incidente bloqueante,
plano/draft/quote/slot inalterados e ator com identidade/grants explícitos.
O commit cria application pending, operation/event e move o case para
`application_pending` no mesmo txid.

Campos adicionais previstos em application: versão esperada, expiração da
reserva, ator, idempotência/hash de apply, txid, hashes de snapshot/manifesto,
disposição fiscal e failure code. Estados pending/applied/blocked terão CHECKs
mutuamente exclusivos.

## 321c — T2b: aplicação final

Procedure proposta:

`pos_manual_apply_application_v1(application_id, expected_case_version,
actor_profile_id, actor_user_id, idempotency_key, request_hash)`

Ela deriva preço, itens, pagamento e referência exclusivamente do banco. Após
revalidar aggregate, TTL, gate/revisões, observation e ausência de incidente,
cria uma única venda, itens e `PosSalePayment(status=manual_confirmed)` ligado
por FK ao case; converte draft/claim, consome plano, aplica application e move o
case para `applied`. Duas execuções devem produzir uma venda e um pagamento.
Falha intermediária reverte integralmente e preserva T2a para replay.

O pagamento manual não pode carregar transactionId, EndToEndId, NSU,
autorização, cartão, vault token ou referência aberta. A metadata é allowlist de
case, observation, provider e últimos quatro seguros.

## 321d — efeitos comerciais, estoque e fiscal

Criar ledger append-only `pos_manual_application_effects`, único por
application/kind/key, para manifestar cada efeito exigível: quote line, kit,
lote/série, stock movement + warehouse ledger, promoção, valor, fiscal,
webhook, contabilidade, claim e conversão do draft.

Venda manual só pode commitar quando constraints diferidas provarem:

- application pending ↔ case `application_pending` ↔ reserve operation/event;
- application applied ↔ case `applied` ↔ apply operation/event ↔ Sale ↔
  Payment ↔ plan consumed, todos com contexto, valor e txid exatos;
- multiset do quote igual aos itens da venda;
- toda baixa controlada com allocation e par de ledgers;
- kits/componentes exatos e disposição fiscal/outboxes obrigatórios presentes.

Eventos pós-venda usam outbox durável e idempotente. Quando a política fiscal é
`before_sale`, documento, attempt e fiscal outbox precisam nascer no mesmo T2b;
um outbox genérico posterior não satisfaz a obrigação.

## Matriz mínima de aceite

- happy path T2a/T2b em duas transações, com grafo/txid, estoque, fiscal e
  outboxes completos;
- replay idêntico e conflito de idempotência em ambos;
- 20 reservas e 20 aplicações concorrentes resultando em uma application,
  venda, pagamento e baixa;
- disputa com close, consume, edição do draft, revogação de grant, incidente e
  expiração durante espera de lock, sempre fail-closed pós-lock;
- failpoint após cada escrita de T2b, comprovando rollback total e retry único;
- SQL direto tentando fabricar cada vértice ou omitir item/ledger/fiscal;
- FEFO, série, lote vencido, saldo insuficiente, estoque negativo, kit,
  variação e disputa pelo último saldo;
- fiscal before-sale, revisão de profile, outbox/fencing, webhook e accounting
  exatamente uma vez;
- varredura PCI/PII em inputs, erros, auditoria, metadata e outboxes;
- testes de privilégios, ownership, search-path/temp shadowing e ausência de
  DML direto.

O gate só pode ser considerado para habilitação depois que 321a–321d e a
ingestão callback/T1 passarem juntas, além dos adapters e laboratório externos.
