# Plano 321000 — habilitação segura da reconciliação manual

Status: **IN PROGRESS / issuer+review 321000 aprovados localmente; gate ainda bloqueado**.

A fundação e as primeiras fatias 321000 foram reaplicadas do zero com 72 migrations e seed, e passaram contratos,
PostgreSQL estrutural/comportamental, contenção temporal, TypeScript, lint e build.
A migration `20260829321000_pos_manual_payment_issuer_review_procedures`
entregou `pos_manual_issue_step_up_v1` e `pos_manual_review_case_v1`, grants
nominais exatos e imutabilidade do binding de vault. Os testes cobrem replay,
conflito, identidade profile↔user, expectedVersion, ledger no mesmo tx, consumo
one-shot e corrida entre revisores. Isso não autoriza produção:
callback/T1 transitivo, T2a/T2b, vault/provider reais e homologações continuam
como bloqueadores explícitos.

## Objetivo

Transformar a fundação fail-closed 320000 em um fluxo executável sem reabrir os atalhos legados. A 321000 só pode retirar o hard-disable depois que banco, processos e credenciais provarem origens distintas para HTTP, worker, callback, issuer de step-up e homologator.

## Pré-condições não negociáveis

- migration 320000 aplicada do zero e em clone, seed, schema e testes PostgreSQL aprovados;
- runtime sem DML direto e sem leitura de vault/assertion/claim token;
- roles worker, callback, issuer e homologator provisionadas com credenciais e processos separados;
- vault/KMS homologado emitindo token não bearer, HMAC versionado e blind index estável cross-key;
- adapter de consulta homologado, egress allowlist, assinatura/callback com keyring e rotação;
- connector e credential revisions congeladas no gate;
- nenhuma pendência/duplicidade/órfão no legado ou no vault;
- métricas, alertas, ownership e runbooks aprovados.

## Bloqueios encontrados por red-team antes do enablement

- o HMAC do callback precisa chegar ao fato persistido e à transição T1; um
  `responseHash` público e um `authKeyId` em allowlist não constituem prova;
- callback deve persistir unicidade de `(provider,eventId)` e nonce
  separadamente: mesmo evento e mesmo corpo é replay, corpo divergente vira
  incidente, nunca nova confirmação;
- o worker deve receber a `providerIdempotencyKey` autoritativa e usar relógio
  pós-lock para lease, TTL e elegibilidade;
- o binding do vault deve ser imutável e sua limpeza nunca pode preservar erro
  bruto/`cause` do adapter;
- resposta autenticada `unknown`, retry agendado e desconhecimento de transporte
  precisam de taxonomia persistida distinta;
- antes de grants positivos, a procedure de review deve impor
  `review_pending`, TTL vigente e operation/event causal na mesma transação.

## Superfície SQL

As tabelas 320000 permanecem sem DML direto. A migration 321000 cria funções `SECURITY DEFINER`, owner-owned, schema-qualified, com `search_path` fixo, `PUBLIC` revogado e `EXECUTE` nominal:

| Função | Role | Efeito atômico |
|---|---|---|
| `pos_manual_open_case_v1` | HTTP runtime | valida plano/contexto e grava case, binding, operation/event |
| `pos_manual_issue_step_up_v1` | issuer | **implementada localmente**; grava assertion one-shot após identidade ativa e caso vivo |
| `pos_manual_review_case_v1` | HTTP runtime | **implementada localmente**; consome assertion, snapshot de grants e, ao autorizar, cria attempt/outbox |
| `pos_manual_claim_outbox_v1` | worker | lease por sessão, sem head-of-line blocking |
| `pos_manual_complete_delivery_v1` | worker | delivery, observation e T1 ou unknown/no_funds/block |
| `pos_manual_record_callback_v1` | callback | envelope autenticado, anti-replay, observation/incidente |
| `pos_manual_reserve_application_v1` | HTTP runtime | T2a exata, `confirmed_paid → application_pending` |
| `pos_manual_apply_application_v1` | finalizer | T2b, venda/pagamento/consume/application/case |
| `pos_manual_maintain_v1` | worker | lease recovery, retry, expiry e incidentes |
| `pos_manual_set_gate_v1` | homologator | habilita somente se attestation e grants estiverem íntegros |

Funções não recebem referência aberta, segredo, timestamps autoritativos, estado resultante ou `writeTxid` do chamador. O relógio, versão, TTL, lease, IDs causais e resultados são definidos no banco.

A assertion persiste explicitamente `expectedCaseVersion`, `decision` e
`reasonCode`; `requestHash` continua como evidência adicional, não como substituto
opaco desses campos. O replay do issuer informa `consumed`, `consumedAt`,
`consumedReviewId` e `currentlyValid`. A review recaptura o relógio depois dos
locks e revalida maker, sessão, terminal/heartbeat/token/app, filial, caixa,
grants, draft, claim, plano/slot, connector, credential, provider e gate antes
de consumir a assertion.

## Substituição explícita das guardas 310000

A 321000 deve substituir ou complementar, sem editar migrations históricas:

1. ativação: manual somente single slot índice 0, total integral e gate atestado;
2. release/expiry: casos bloqueantes impedem liberação; trabalho liberável não sofre starvation;
3. `PosSalePayment`: `manual_confirmed` exige case/application exatos e todos os campos eletrônicos nulos;
4. consume: slot manual exige case/application/payment aplicados na mesma transação;
5. sessão/draft/claim: close, suspend, handoff ou mutação concorrente perdem para o case bloqueante.

O vínculo é bidirecional e diferido: case ↔ observation ↔ application ↔ payment ↔ sale ↔ plan. Nenhuma metade pode fazer `COMMIT` sozinha.

## Transações financeiras

### T1 — confirmação externa

Somente delivery/callback autenticado e exato pode fazer `unknown → confirmed_paid`. Provider, referência, método, valor, moeda, connector/credential revisions, sequência e ocorrência devem coincidir. O banco define `confirmationExpiresAt`. Fato tardio ou contraditório é persistido como incidente, nunca autoaplicado.

### T2a — reserva comercial

Em `SERIALIZABLE`, revalida sessão, terminal, grants, claim, draft/revisão/hash, plano/slot, gate/revisions, observation confirmadora, TTL e ausência de incidente. Cria uma application imutável para sale idempotency/request hashes exatos e faz `confirmed_paid → application_pending`.

### T2b — aplicação final

Transação `SERIALIZABLE` separada e repetível. Cria a venda e itens, `PosSalePayment(status=manual_confirmed)`, consome o plano, aplica a reservation e faz `application_pending → applied`. Falha reverte somente T2b, preservando T2a para replay. Duas execuções produzem uma venda e um pagamento.

## Worker e callback

- seleção session-root com `FOR UPDATE SKIP LOCKED`;
- filtro acionável antes de `LIMIT`; backlog bloqueado em métrica separada;
- lease e completion pelo relógio do banco;
- crash pré-dispatch volta a retry; possível efeito externo vira `unknown`;
- mesmo claim/event + mesmo hash é replay; hash diferente abre incidente;
- HMAC sobre bytes crus antes do parse, key-id, timestamp/skew, nonce/event-id e sequência monotônica;
- nenhuma chamada externa mantém locks PostgreSQL.

## APIs e UI

- abrir caso: referência enviada apenas ao boundary de vault e imediatamente descartada;
- revisar: checker distinto, grant explícito, alçada e assertion one-shot;
- consultar: DTO mascarado, sem token/hash/segredo;
- reservar/aplicar: comandos explícitos e idempotentes, sem botão “marcar como pago”;
- telas distintas para maker, checker e acompanhamento/incidente;
- estados, TTL e indisponibilidade anunciados de forma acessível, sem polling agressivo.

## Matriz de aceite

- migrations limpas, clone, seed e checksum congelado;
- owner/runtime/worker/callback/issuer/homologator com testes positivos e negativos de ACL;
- SQL direto tentando fabricar cada vértice do grafo;
- rotação HMAC seguida da mesma referência, normalização Unicode e concorrência de duplicidade;
- step-up de outro user/profile/case/purpose/hash, expirado e replay;
- callback versus completion/expiry/T2a; T2a versus expiry; duas T2a e duas T2b;
- falha injetada em cada etapa de T2b;
- close/handoff/draft/claim/connector-update concorrentes, zero deadlock não tratado;
- fairness com sessões bloqueadas e lote menor que o backlog;
- PAN/CVV/trilha/PIN e vazamento em DTO/log/erro/outbox/audit;
- HTTP/browser/WCAG, adapter e arquivo/callback reais em homologação;
- observabilidade, alertas, DR e rollback do gate.

Status de saída: somente após duas revisões independentes sem P0/P1, `productionReady` ainda dependerá dos gates externos de vault, provider, infraestrutura e laboratório físico.
