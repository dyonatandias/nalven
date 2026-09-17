# Plano 321e — prova transitiva de provider, callback e T1

Status: **IMPLEMENTED LOCALLY / FAIL-CLOSED / NOT ENABLED**. A migration
`20260829321100_pos_manual_payment_callback_t1_proofs` implementa o recorte SQL
de proof, callback e consumo T1. O gate e `proofKind=manual` permanecem
desligados: abertura one-shot do vault 321f, boundary HTTP/processo, reprocessamento de
órfãos e homologação externa ainda são bloqueadores P0.

## Entrega 321e

Foram implementados os ledgers append-only de proof/consumption, a taxonomia
fechada de delivery, `record_callback`, `attest_query_response`,
`complete_delivery` e `report_transport`. Somente `_mc` recebe as duas
capabilities de atestação; somente `_mw` recebe complete/transport. Runtime,
issuer, homologator, `PUBLIC` e rogue não recebem DML nem EXECUTE. O reconciler
revoga wildcards e reaplica a allowlist por assinatura exata.

O `event_id` persistido não é o identificador cru do provider: o boundary deve
fornecer `evt:<sha256-hex>`. Isso impede PAN/PII formatado de atravessar o DLP do
banco. `(provider,event_id)` e `(provider,nonce_hash)` têm owner único; o índice
de payload+assinatura é apenas lookup. A serialização dos conflitos usa locks
consultivos de evento/nonce mais os índices de owner, permitindo registrar um
novo proof de replay vinculado ao claim/delivery atual.

O serviço TypeScript legado não pode mais concluir `confirmed_paid`,
`not_found`, `voided` ou `refunded`: sem proof ele aceita somente
`transport_outcome_unknown`, agenda nova consulta e nunca cria observation T1.

## Modelo de prova

Criar `pos_manual_payment_provider_proofs` append-only para callbacks e respostas
de consulta autenticadas. O registro recebe ID aleatório do banco e contém,
sem segredo aberto: source kind, vínculo opcional a case/attempt/delivery,
provider idempotency key, provider/event id, nonce hash, payload/signature/
canonical/evidence hashes, auth key id, tempos, sequence, outcome, referência
HMAC, método, centavos, moeda, credential revision, verifier version, relógio do
banco, caller role e disposition.

Unicidades separadas são obrigatórias:

- owner de `(provider,event_id)`;
- owner de `(provider,nonce_hash)`;
- lookup byte-identical de `(provider,payload_hash,signature_hash)`; a
  identidade autoritativa continua sendo o owner de evento e nonce, para que um
  replay legítimo possa receber proof próprio ligado à delivery atual.

Mesmo event/body/canonical event retorna o receipt anterior, inclusive quando
foi reautenticado por outra key; `signature_hash` identifica transporte exato,
mas não define replay semântico. Opcionalmente um novo envelope aponta
`replay_of_proof_id`, sem callback/transição adicionais. Mesmo event com body
diferente ou mesmo nonce em outro evento cria proof quarantined + incidente e
nunca nova confirmação. A precedência é replay semântico, conflito de evento e,
por fim, conflito de nonce. `replayKeyHash` sozinho não substitui essas
identidades.

Criar `pos_manual_payment_proof_consumptions` append-only para ligar cada proof a
um único delivery result. Callback deve ter `ingress_proof_id UNIQUE NOT NULL`;
incidente pode apontar proof e aceitar case nulo para referência autenticada mas
órfã. O vault binding recebe proteção UPDATE/DELETE deny.

## Capabilities SQL

- `pos_manual_record_callback_v1`: somente callback role; valida envelope
  tipado, skew, gate/revisions/key id, resolve case por provider+reference,
  persiste anti-replay e produz observation/T1 ou incidente.
- `pos_manual_attest_query_response_v1`: somente callback/attestor; a resposta
  assinada ecoa provider idempotency key e gera proof para attempt claimed, sem
  mudar estado financeiro.
- `pos_manual_complete_delivery_v1`: somente worker; recebe attempt, claim,
  proof e idempotency key. Outcome/valor/referência/revisões vêm exclusivamente
  do proof persistido.
- `pos_manual_report_transport_v1`: somente worker; registra
  `pre_dispatch_failure`, `outcome_unknown` ou `protocol_rejected`, nunca
  confirmação/no-funds.
- `pos_manual_claim_queries_v1`: **IMPLEMENTADO EM 321e.1**, exclusivamente
  `_mw`, com fairness por sessão, `SKIP LOCKED`, lease/fencing, batch idempotente
  e receipts append-only. Retorna somente `vaultBindingId` não-bearer e
  `vaultOpenAvailable=false`; sem 321f o worker não recebe a referência e não
  pode despachar consulta real.

As quatro capabilities entregues são `SECURITY DEFINER`, owner migrator,
objetos qualificados, `search_path=pg_catalog, public` fixo (os triggers
históricos ainda resolvem relações no schema `public`, cujo CREATE é revogado
das roles operacionais), `PUBLIC` revogado e ACL nominal por assinatura. A
reconciliação de grants deve auditar owner, `prosecdef`, `proconfig` e ACL exata.

## T1 e causalidade

Com case `unknown`, proof exato `confirmed_paid`, sequence monotônica, ocorrência
causal e TTL/gate válidos, a mesma transação cria callback/delivery,
observation, operation/event e move para `confirmed_paid`. O banco define
`confirmation_expires_at = LEAST(clock + 5 minutes, case.expires_at)`.

`not_found`/`voided` levam a `no_funds`. Resultado provider autenticado
`unknown` produz observation e retry; timeout sem resposta é transporte e não
provider result. Refund, mismatch, sequência contraditória ou fato tardio abrem
incidente. Fato concordante após confirmação é no-change auditado; divergente
bloqueia quando seguro. Case `applied` nunca é revertido automaticamente.

As guards precisam aceitar observation same-state com versão crescente e grafo
completo; hoje a fundação não representa esse caso adequadamente.

## Taxonomia persistida

`result_kind` deve distinguir `provider_result`,
`transport_pre_dispatch_failure`, `transport_outcome_unknown` e
`protocol_rejected`. A decisão fica em `processing_result`:
`applied_transition`, `applied_no_change`, `retry_scheduled`, `ignored_stale`,
`incident_opened` ou `terminal_blocked`. Retry não é natureza da prova.

## Processo e HTTP

O callback roda em processo isolado com DB role própria. Lê `arrayBuffer()` uma
vez, copia bytes, valida HMAC antes de parse, limita 32 KiB, exige identity
encoding e rejeita headers de segurança duplicados. O keyring não fica no
runtime. A resposta crua do worker é atestada pelo mesmo boundary por Unix
socket privado; o worker recebe somente `proof_id`.

## Testes bloqueantes

- matriz de ACL por login e ataques de PUBLIC/rogue/search-path/temp shadowing;
- tentativa atual de confirmar apenas com objeto/hash público deve falhar;
- proof aleatório, cross-attempt/claim/case e reuso;
- replay/conflito concorrente de event e nonce, rotação de chaves e órfãos;
- callback versus completion, expiry e sequence; provider unknown versus
  transporte; fatos tardios em cada estado;
- lease pós-contenção e fairness por sessão;
- PAN colado a letras, Unicode/separadores, CVV/track/PIN e vazamento em
  DTO/log/error/cause/outbox/audit;
- migrations/seed/restore, failpoints em cada escrita e duas red-teams sem
  P0/P1.

O processo callback role ainda é uma raiz de confiança. Para resistir ao seu
comprometimento, a homologação deve exigir assinatura assimétrica do provider
ou attestation KMS verificável, além do isolamento de role/processo.

## Validação local e bloqueadores restantes

- 72 migrations em banco PostgreSQL descartável + seed: PASS;
- contratos de reconciliação manual: 18/18 PASS;
- integração service/PostgreSQL: 2/2 PASS, incluindo proof de replay semântico,
  claim errado, key/revision divergentes, consumo único e completion replay;
- contratos de deploy: 17/17 PASS; matriz real de roles: 1/1 PASS; TypeScript:
  PASS.

Ainda bloqueiam qualquer enablement: abertura one-shot do vault 321f;
API/processo que lê raw bytes e verifica HMAC antes do parse;
attach/reprocess explícito para proof órfão/context mismatch; adapters e keys de
provider homologados; T2a/T2b; testes concorrentes específicos de callback
versus completion e segunda red-team independente. Nenhum stub simula essas
capacidades e a migration não altera gate nem `proofKind`.

O helper 321e trava plan/slot antes do case, enquanto a guard histórica da
application T2 ainda percorre case antes de plan. Como nenhuma capability T2
foi habilitada, isso permanece fail-closed; a onda T2 deve unificar a ordem e
provar ausência de deadlock antes de qualquer cutover.
