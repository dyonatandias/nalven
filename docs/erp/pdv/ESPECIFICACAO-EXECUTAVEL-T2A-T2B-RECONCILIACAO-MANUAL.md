# Especificação executável — T2a/T2b da reconciliação manual

Status: **CONTRATO EXECUTÁVEL PARA IMPLEMENTAÇÃO EM ONDAS / HARD-OFF**. Este
documento substitui a generalidade do plano 321b–321d por um contrato
implementável sobre o schema vigente depois de 321e.1 e 321f. Ele não autoriza
`proofKind=manual`, não ativa o gate e não permite concluir venda enquanto as
ondas T2-00..T2-07, os gates locais e os blockers externos do §14 não estiverem
todos verdes. Nenhuma onda deste documento pode alterar automaticamente
`pos_manual_payment_reconciliation_gates.enabled`.

## 1. Resultado e limites do recorte

T2 é deliberadamente bifásico:

1. **T2a/reserve**, chamado pelo runtime autenticado, consome a janela curta da
   confirmação e reserva um alvo comercial imutável. Ele não cria venda nem
   pagamento.
2. **T2b/apply**, chamado por um finalizador PostgreSQL isolado, cria e prova
   todos os efeitos obrigatórios em outra transação `SERIALIZABLE`. Falha
   intermediária reverte T2b por inteiro e deixa a reserva reaplicável.

O primeiro corte continua limitado a um único slot manual, `payment_index=0`,
que cobre 100% do plano. Não há pagamento misto, valor local, intent eletrônico,
troco ou chamada externa dentro de T2.

## 2. Auditoria do estado atual

### 2.1 Gaps P0 que a implementação precisa fechar

| Gap real                                                                                   | Evidência vigente                                                                                | Fechamento obrigatório                                                                                                              |
| ------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------- |
| A guarda de consumo do plano ainda exige `pos_manual_payment_references.status='consumed'` | `validate_consumed_pos_payment_plan` em `20260829310000_pos_authoritative_payment_plan`          | substituir somente em migration nova o ramo `proof_kind='manual'` por case/application/payment T2 exatos; o legado permanece selado |
| Não existem procedures T2 operacionais                                                     | o aggregate possui estados/linhas, mas nenhuma capability de reserve/apply                       | procedures abaixo, `SECURITY DEFINER`, ACL nominal e sem DML direto                                                                 |
| O grafo applied é insuficiente                                                             | `validate_pos_manual_application_commit` verifica apenas application, case e IDs de sale/payment | constraint diferida deve provar sale, items, payment, plan, draft, estoque, fiscal, contabilidade e outboxes no mesmo txid          |
| `PosSalePayment` não tem FK própria para o case                                            | a relação atual parte de `case.applied_sale_payment_id`                                          | adicionar `manual_payment_case_id` nullable, unique quando presente e obrigatório no ramo manual; provar vínculo bidirecional       |
| Checkout é orquestrado em TypeScript                                                       | `commitSale` em `app/api/erp/pdv/route.ts` cria os efeitos sequencialmente                       | T2b precisa de implementação SQL própria; chamar a rota ou helpers em commits separados é proibido                                  |
| Venda não produz contabilidade hoje                                                        | `postPosAccountingJournal` existe, mas não é chamado no commit da venda                          | T2a congela política/período/mappings e T2b cria journal/postings/export outbox no mesmo tx                                         |
| Fiscal pode retornar `not_configured`, `not_effective` ou `disabled`                       | `queuePosFiscalIssuanceForSale` permite essas disposições                                        | perfil de finalização declara `required_queue` ou `not_applicable` homologado; ambiguidade bloqueia T2a                             |
| Estoque e promoção não são reservados por application                                      | há reserva apenas para sales order                                                               | criar reservas próprias T2a, incluídas nos cálculos de disponibilidade dos fluxos normais                                           |
| Não há perfil operacional que una estoque, fiscal, accounting e webhook                    | gate atual vincula apenas adapter/config do provider                                             | perfil versionado/homologado, preso à revisão do gate antes de habilitação                                                          |
| A tabela de application pode conter linha fabricada pelo migrator embora não tenha producer | schema legado aceita `pending|applied` e não há capability T2 instalada                          | T2-00 aborta se existir qualquer application; não inventar backfill, snapshot, lease ou causalidade                                  |
| Sale/fiscal exigem identidade antes de T2b                                                   | snapshot fiscal inclui sale ID, número e instant; a sale só nasceria em T2b                       | T2a prealoca e congela ID, número e instant da sale sem criar a sale                                                                |
| A matriz DLP e o snapshot fiscal divergem                                                    | fiscal vigente persiste documento do cliente, enquanto a matriz proíbe CPF/CNPJ em todos os JSON | separar PII fiscal homologada em envelope cifrado/locator próprio; snapshots T2 e payloads operacionais permanecem sem PII           |

### 2.2 Gaps P1 a tratar na mesma onda

- `pos_manual_payment_applications` aceita no CHECK apenas `pending|applied`,
  embora já tenha campos de bloqueio; faltam version, TTL, lease e fencing.
- `guard_pos_manual_application` trava case e depois plan, divergindo da ordem
  universal. A função deve ser substituída e usar o helper canônico novo.
- Quantidades de quote/sale/balance ainda são `double precision`. T2 rejeita
  qualquer quantidade que não faça round-trip exato para micros, persiste
  micros no snapshot e mantém a migração integral do estoque para micros como
  requisito de habilitação geral.
- A metadata do pagamento legado contém claims manuais demais. O pagamento T2
  usa allowlist fechada e nenhum PAN, token do vault, referência aberta,
  transaction ID, EndToEndId, NSU ou autorização.
- Não há role de finalizador nem credential/service unit isolados.
- Webhooks são resolvidos dinamicamente no checkout; T2 precisa congelar o
  conjunto de endpoints e provar as deliveries exigidas.
- As guards de sessão atuais também tratam case `blocked` como financeiramente
  live. Depois de liberar todas as reservas, um blocked terminal não pode
  prender o fechamento do turno indefinidamente; a migration T2 deve distinguir
  `application_pending` de blocked investigativo e ajustar essas guards.
- O runtime recebe DML genérico no reconcile vigente. Toda tabela T2 entra na
  quarentena nominal e na lista de revogação depois do grant genérico, antes de
  qualquer EXECUTE operacional ser concedido.

## 3. Topologia de autoridade

Adicionar a role por tenant `<database>_mf` (**manual finalizer**), login
`NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS`.
Ela recebe uma credencial própria, arquivo root-owned e processo dedicado. Não
reutilizar `_mw`, `_mc`, `_mb`, `_si`, `_mh`, jobs ou runtime.

| Principal                                   | Capabilities T2                                                                              | Proibições                                   |
| ------------------------------------------- | -------------------------------------------------------------------------------------------- | -------------------------------------------- |
| runtime                                     | `put_finalization_profile` com assertion `_mpi`, `reserve_application`, status por application e por identidade da reserve | claim/apply/report/remediation, tabelas, sequences |
| `_mf`                                       | `claim_applications`, `report_application_failure`, `probe_application`; `apply_application` somente em T2-06 | reserve, callback, vault, tabelas, sequences |
| `_ms`                                       | `sweep_expired_applications`                                                                 | profile, reserve/claim/apply, tabelas         |
| `_mpi`                                      | emitir assertion one-shot de administração de profile                                        | put/activate/retire e DML                     |
| `_mpa`                                      | emitir assertion one-shot de aprovação contábil                                              | put/activate/retire e DML                     |
| `_mpf`                                      | emitir assertion one-shot de aprovação fiscal                                                | put/activate/retire e DML                     |
| `_mr`                                       | claim/consume/probe de compensação e remediar blocked                                         | fabricar/ingerir proof, profile, reserve/apply e DML |
| `_mri`                                      | emitir assertion one-shot de remediation                                                     | remediar, consumir assertion e DML             |
| `_mcc`                                      | ingerir callback de compensação manual autenticado e consultar seu status por identidade       | claim/consume/remediate, callbacks gerais e DML |
| `_mcm`                                      | match/reprocess one-shot da inbox, status do receipt e probe por ingress                       | ingest/claim/consume/remediate e DML direto    |
| `_mck`                                      | rotacionar/revogar revisions do keyring de compensação                                        | ingest/claim/consume/remediate e DML direto    |
| `_mcko`                                     | NOLOGIN owner do keyring e das funções HMAC-sensitive enumeradas abaixo                       | login, EXECUTE operacional e memberships       |
| `_mh`                                       | ativar/retirar perfil de finalização em onda separada                                        | reserve/apply e DML                          |
| migrator                                    | ownership/migrations e core de failpoint em teste                                            | não é identidade operacional                 |
| `_mw`, `_mc`, `_mb`, `_si`, `PUBLIC`, rogue | nenhuma capability T2                                                                        | tudo                                         |

Todas as funções públicas são `SECURITY DEFINER SET search_path=pg_catalog`,
usam nomes totalmente qualificados, têm `PUBLIC` revogado e grants por assinatura
exata reconciliados depois de cada deploy. O owner é migrator para toda
capability geral, inclusive matcher e remediation. `_mcko` é owner NOLOGIN
somente de rotate, revoke, ingest, status de ingest e helpers internos de
keyring/HMAC; essas funções não concedem membership nem EXECUTE a `_mcko`.
Grants operacionais continuam nominais: rotate/revoke somente `_mck`,
ingest/status somente `_mcc`, match/probe de matcher somente `_mcm`.

Dentro de uma função `SECURITY DEFINER`, a identidade invocadora é sempre
`session_user`; `current_user`/`current_role` identificam o owner e são
proibidos para autorização, auditoria ou composição de request hash. O helper
de autoridade exige `session_user` igual à role nominal esperada, recusa
memberships e persiste somente seu hash quando a prova não precisar da role em
claro.
A matriz de catálogo prova `current_user=migrator` para cada assinatura geral e
`current_user=<database>_mcko` somente para rotate/revoke/ingest/status de ingest
e lookup HMAC interno. Em todos os casos a autorização usa o `session_user`
nominal acima; chamada aninhada não transforma owner em identidade operacional.

T2-02 adiciona o executor isolado `_ms`; T2-01 adiciona as authorities isoladas
`_mpi/_mpa/_mpf`; T2-03 adiciona `_mf`; T2-07 adiciona
`_mr/_mri/_mcc/_mcm/_mck`. Cada uma recebe variável/credencial,
usuário/grupo Unix quando houver processo, diretório root-owned, cutover
root-only para tenants existentes e isolamento recíproco nos
`InaccessiblePaths`. O reconcile inclui todas na quarentena de
database/schema/tables/sequences e na auditoria de roles antes de conceder
qualquer EXECUTE.

O finalizador `_mf` usa uma chamada em autocommit por conexão/transação e a
role recebe limites explícitos de `statement_timeout`, `lock_timeout` e
`idle_in_transaction_session_timeout`. SQL não consegue obrigar um caller a
fazer COMMIT: a autoridade que declara apply concluído é o executor externo,
somente depois de receber confirmação de COMMIT da conexão autocommit. Retorno
da function sem confirmação de commit obedece literalmente: executor não presume; banco pode já estar applied; probe decide.

O mesmo contrato vale para T2a: runtime chama `reserve` em autocommit e somente
declara reserva concluída após ACK do COMMIT. Em lost-ACK, consulta `status` em
conexão primária nova pela identidade recuperável `(case_id,
reserve_idempotency_key,request_hash)`, sem depender do `application_id` que
pode ter sido perdido com a resposta. O probe serializa no mesmo namespace da
reserve e usa a mesma identidade runtime/ator. O protocolo tem exatamente três saídas:
`committed_same_request` devolve o winner; `authoritatively_absent` permite
repetir a **mesma** idempotency key; `unknown` exige novo probe, sem retry
concorrente. Timeout, erro, réplica ou leitura não autoritativa são sempre
`unknown`. Nenhuma saída autoriza nova key, segunda application/case transition
ou anúncio antes do ACK/probe committed.

## 4. Schema mínimo da migration T2

A implementação entra em migrations novas posteriores ao freeze de 321f. Não
editar migrations históricas.

T2-00 começa com um preflight transacional obrigatório:

```sql
DO $preflight$
BEGIN
  IF EXISTS (SELECT 1 FROM public.pos_manual_payment_applications) THEN
    RAISE EXCEPTION 'T2-00 requires an empty legacy application table';
  END IF;
END
$preflight$;
```

Nenhuma linha existente é convertida, completada ou classificada por
suposição. O preflight ocorre antes de alterar CHECKs, triggers ou ACLs. A
migration inteira reverte se a condição não for satisfeita.

### 4.1 Perfil de finalização

Criar `pos_manual_finalization_profiles`:

- `id uuid`, `branch_id`, `version`, `state=draft|active|retired`;
- `cost_center_id`, `accounting_policy_id`, `accounting_policy_hash`;
- `fiscal_mode=required_queue|not_applicable`, `fiscal_profile_id`,
  `fiscal_profile_version`, `fiscal_policy_hash`, `not_applicable_reason`;
- `webhook_mode=required|disabled`, `stock_mode=reserve_exact`;
- `reservation_ttl_seconds` entre 15 e 300;
- `config_hash`, `created_by`, homologator, aprovadores contábil/fiscal
  distintos e timestamps;
- unique `(branch_id,version)` e no máximo um active por branch.

`not_applicable` exige motivo e homologação explícitos. `required_queue` exige
perfil fiscal ativo, efetivo e ambiente homologado. O gate de reconciliação
ganha FK/revision/hash deste perfil; enquanto isso não existir e não coincidir,
o gate não pode ser ligado.

Profile draft pode ser criada ou substituída somente por capability runtime de
admin com assertion administrativa one-shot; `_mh` apenas ativa ou retira uma
versão já fechada, também mediante assertion administrativa vinculada à ação.
Ativação
recalcula `config_hash`, hashes fiscal/contábil, exige aprovações distintas e
grava operation/event append-only. Nenhuma migration ou seed cria profile
ativa. Retirada não altera applications já reservadas, mas impede novas T2a e
faz T2b bloquear após a revalidação pós-lock.

Criar três famílias append-only de assertions, sem assertion genérica:

- `pos_manual_profile_admin_assertions`, emitida somente por `_mpi`, vinculada
  a uma ação exata `put|activate|retire`, branch, profile,
  version/config hash quando existentes, ator/homologator, request hash,
  emissão e expiry;
- `pos_manual_profile_accounting_assertions`, emitida somente por `_mpa`,
  vinculada a `activate`, profile/version/config hash e policy hash contábil;
- `pos_manual_profile_fiscal_assertions`, emitida somente por `_mpf`, vinculada
  a `activate`, profile/version/config hash, fiscal mode e policy hash fiscal.

Cada linha guarda `issuer_subject_id` imutável e apenas o hash da assertion e
da authority, possui FK
`consumed_operation_id` para a operation do **mesmo aggregate** e
`consumed_at`, expira em no máximo cinco minutos e é
consumida exatamente uma vez, na mesma transação da operação autorizada.
Emissor não consome nem administra profile; runtime/`_mh` não emitem; `_mpi`
não substitui `_mpa`/`_mpf`; grants são por assinatura exata e sem SELECT/DML.
Para activate, `p_homologator_id`, approver contábil e approver fiscal são três
subject IDs não vazios e pairwise-distinct; comparar role/label não satisfaz
SoD. Para put/retire, issuer subject e executor subject também são distintos.

### 4.2 Application e snapshots

Evoluir `pos_manual_payment_applications` com:

- `version`, estados `pending|claimed|applied|blocked`;
- `case_version_before_reserve`, `case_version_after_reserve`,
  `confirmed_observation_id` e
  `confirmation_evidence_hash`;
- `reserved_by_user_id`, `reservation_expires_at`, `reserve_txid`;
- `snapshot_hash`, `manifest_hash`, `finalization_profile_id/version/hash`;
- `claim_token_hash`, `claim_expires_at`, `fencing_token`, `claimed_by_hash`;
- `apply_idempotency_key`, `apply_request_hash`, `apply_txid`;
- `planned_sale_id`, `planned_sale_number`, `planned_sale_occurred_at`;
- `failure_class`, `blocked_code` e timestamps coerentes por estado.

O `write_txid` legado passa a representar T2a ou é renomeado para
`reserve_txid`; T2b nunca o sobrescreve. Campos de identidade e snapshots são
imutáveis. Lease/fencing só mudam pela capability `_mf`.

`case_version_before_reserve` é a versão `confirmed_paid` validada pelo request;
`case_version_after_reserve` é a versão persistida após a transição para
`application_pending`. T2b exige a segunda; nenhuma coluna ambígua
`expected_case_version` participa de T2b.

O token textual nunca é persistido em application, receipt, operation, evento,
log ou erro. Claim recebe uma `p_request_idempotency_key` com formato fechado
de 64 caracteres hexadecimais ou 43 caracteres base64url, persiste seu hash e
deriva cada token como SHA-256 domain-separated
de `t2-claim-token-v1`, request key, batch ID, application ID, batch index e
fencing. O replay live recalcula o mesmo token a partir da mesma request key e
compara seu hash; chave igual com parâmetros diferentes retorna conflito
sanitizado. Batch expirado nunca deriva token novo sob a mesma chave. CSPRNG e
256 bits de entropia são contrato do executor; SQL valida somente
formato/comprimento e não promete detectar aleatoriedade ou previsibilidade.
O claim token transportado é exatamente base64url sem padding dos 32 bytes do
digest derivado, portanto 43 caracteres ASCII `[A-Za-z0-9_-]`; apply/report
rejeitam qualquer outro tamanho, alfabeto ou padding antes de lookup e comparam
somente o hash constant-time.

T2a prealoca `planned_sale_id` pela sequence owner-only e congela número e
instant da venda. Buracos de sequence após expiry são esperados e não autorizam
reuso. T2b insere a sale com esses valores exatos. `application.sale_id`
continua nulo até applied e deve então ser igual a `planned_sale_id`.

Criar `pos_manual_application_snapshots`, 1:1 e append-only, com JSONB canônico
separado e SHA-256 para:

- contexto operacional e ator;
- case/observation/provider proof;
- draft, quote lines e slot;
- customer opaque/eligibility sem PII, sale header e payment allowlist;
- produtos, variações, kits/BOM e tracking solicitado;
- reservas de estoque/lote e promoção;
- perfil fiscal, policy e snapshot fiscal esperado;
- período/policy/mappings/postings contábeis;
- endpoints e payloads de webhook;
- manifesto integral de efeitos.

O `snapshot_hash` agrega os hashes filhos em ordem fixa. JSONB recebido do
cliente não entra no snapshot; tudo é lido do banco após os locks.

O DLP usa classes explícitas: **A**, PAN/CVV/PIN/track, vault token, referência
aberta e códigos de autorização, proibida em todo objeto T2; **B**, nome,
e-mail, telefone, endereço, CPF/CNPJ e demais PII direta, proibida em JSON,
logs, erros, audit/accounting/webhook e admitida no fiscal apenas pelo envelope
opaco abaixo; **C**, labels operacionais/comerciais de exibição, admitidas
somente em colunas/snapshots nomeados, com limites, e nunca usadas para
autoridade, identidade, join ou decisão; **D**, IDs opacos, hashes e reason
codes allowlisted, admitida. Labels de actor/finalizer/homologator são apenas
observabilidade; a autoridade é sempre ID imutável, assertion e hash.

Quando emissão
fiscal exige documento do consumidor, um serviço homologado cria o envelope
cifrado antes de T2a. T2a não faz I/O: exige e congela somente locator opaco,
version e hash do envelope já existente; chave, plaintext e token de acesso não
entram no banco T2. T2b referencia esse locator na fila fiscal, e somente o
worker fiscal isolado pode resolver o envelope. `not_applicable` não exige
envelope. Até esse adapter existir e seus testes DLP estarem verdes,
`required_queue` permanece external-blocked e o gate global hard-off.

### 4.3 Manifesto e provas de efeitos

Criar duas tabelas append-only:

1. `pos_manual_application_manifest_entries`, produzida em T2a, unique
   `(application_id,effect_kind,effect_key)`, contendo `expected_hash`,
   cardinalidade e se o efeito é obrigatório.
2. `pos_manual_application_effects`, produzida em T2b, unique
   `(application_id,effect_kind,effect_key)`, contendo `manifest_entry_id`,
   `entity_type`, `entity_id`, `actual_hash` e `write_txid`.

Kinds mínimos:

`sale`, `sale_item`, `sale_payment`, `plan_consume`, `draft_convert`,
`promotion_redemption`, `kit_component`, `tracked_lot_movement`,
`stock_movement`, `warehouse_ledger`, `value_account`, `value_ledger_entry`,
`value_accrual`, `fiscal_document`, `fiscal_attempt`, `fiscal_outbox`,
`accounting_journal`,
`accounting_posting`, `accounting_export_outbox`, `sale_event`, `audit_event`
e `webhook_delivery`.

Se accrual puder abrir uma conta, `value_account` é obrigatório; se a conta já
existir, o manifesto declara cardinalidade zero para esse kind e aponta a conta
congelada no snapshot. Todo accrual exige um `value_ledger_entry` novo. Não é
permitido representar criação de conta e crédito apenas por `value_accrual`.

Cada tabela alvo criada por T2 precisa guardar `manual_application_id` e
`creation_txid`, ou ter trigger de INSERT que crie a effect row derivando a
application sem ambiguidade. Não usar `xmin` como prova. Constraint diferida
compara o manifesto como multiset: falta, excesso, hash divergente ou txid
distinto aborta o commit.

`effect_key` é lógico e determinístico. PKs `serial/bigserial` geradas em T2b
ficam em `entity_id`, mas não entram no `expected_hash`, exceto
`planned_sale_id`, que já foi congelado em T2a. O hash compara somente a
allowlist imutável de negócio de cada kind. Toda tabela alvo criada por T2 que
seja mutável por worker depois do commit protege identidade, application,
payload inicial e `creation_txid`; estado de delivery posterior não participa
do hash inicial.

### 4.4 Reservas físicas e promocionais

Criar `pos_manual_application_stock_reservations` e ledger append-only de
transições. Cada linha contém application, quote line/componente, warehouse,
product, variation, lot opcional, `quantity_micros`, estado
`reserved|consumed|released`, before/after e txids.

T2a:

- expande kit/BOM congelado;
- escolhe lotes por FEFO e série solicitada;
- incrementa reservas parent/variation e `reserved_micros` dos lotes;
- nunca aceita estoque negativo neste primeiro corte.

T2b consome **a própria** reserva: reduz reserved e quantity na mesma escrita
fenced, em vez de chamar a regra comum que descontaria a própria reserva da
disponibilidade. Fluxos normais de venda passam a considerar estas reservas.

Warehouse/variation balances ganham colunas micros autoritativas ou são
migrados integralmente para micros em T2-05. Até todos os writers normais
fazerem dual-write provado, T2 não pode receber gate. Float permanece apenas
como projeção compatível, com CHECK de round-trip exato; decisão de saldo,
reserva e manifesto usa exclusivamente micros.

Criar também `pos_manual_application_promotion_reservations`. Limites globais,
por cliente e por cupom precisam contar reservas T2a live; T2b converte uma
reserva em redemption, e expiry/block a libera por ledger causal.

### 4.5 Ligações sale/payment

- `sales.manual_payment_application_id uuid UNIQUE` e
  `source_type='manual_payment_application'`, `source_id=application_id`;
- `pos_sale_payments.manual_payment_case_id uuid NULL`; unique parcial quando
  não nulo e obrigatório somente pelo CHECK do ramo manual novo;
- `application.sale_id` também unique e `sale_payment_id` já unique;
- o vínculo application ↔ sale ↔ payment ↔ case é bidirecional e diferido.

Para `manual_payment_case_id IS NOT NULL`, exigir:

- `type='payment'`, `status='manual_confirmed'`, slot manual exato;
- `payment_intent_id`, `compensation_id`, value fields e original payment nulos;
- `transaction_id`, `end_to_end_id`, `nsu`, `authorization_code`, `card_brand`
  e `card_last_four` nulos;
- `tendered_cents=amount_cents`, `change_cents=0`;
- provider/method/amount/installments iguais ao case e ao slot;
- metadata exatamente `{schemaVersion,manualPaymentCaseId,observationId,
evidenceHash,provider,referenceLastFour}`. Nenhuma outra chave é aceita.

O ramo manual de `authorize_pos_sale_payment_plan_slot` e
`validate_consumed_pos_payment_plan` deve reconhecer somente este grafo novo.
`pos_manual_payment_references` não é atualizado nem consultado para financiar
venda T2.

Também substituir o ramo manual de
`validate_sale_authoritative_payment_plan_commit`: sale T2 é reconhecida por
`source_type='manual_payment_application'`, `source_id=application_id`,
`manual_payment_application_id=application_id` e planned identity exata. Os
três validadores — sale, payment/slot e plan consumption — preservam sem mudança
os ramos cash/value/intent. Não se exige que a idempotency key da sale T2 seja a
referência manual legada; sua relação com `sale_draft_id` e application é
provada pelo grafo novo.

### 4.6 Ledger de claim

Criar batches e receipts próprios do finalizador, append-only:

- batch com hash da request key, hash de parâmetros, finalizer hash, limit,
  lease, contagens, caller role e timestamp;
- receipt com batch, `batch_index`, application, application version, fencing,
  hash do claim token, expiry e indicador de reclaim;
- unique request hash, `(batch_id,batch_index)`, `(application_id,fencing)` e
  hash do token.

Não reutilizar receipt do worker de consulta: as autoridades, objetos e
fencings são distintos.

### 4.7 Canonical JSON, hashes e erros

Criar `pos_manual_canonical_json_v1(jsonb)` e helpers de hash internos com
vetores de teste compartilhados com TypeScript. A versão v1 obedece:

- UTF-8, objetos com chaves em ordem de byte, arrays preservam ordem declarada;
- timestamps em UTC com seis casas e sufixo `Z`, datas em `YYYY-MM-DD`;
- inteiros em decimal sem zeros à esquerda; dinheiro em cents e quantidade em
  micros; nenhum `double precision` entra em hash;
- `null` explícito é diferente de chave ausente;
- strings NFC, sem controle, tamanho limitado e sem trimming implícito depois
  da validação;
- cada digest começa por domínio e schema version, por exemplo
  `t2-snapshot-v1\0`, `t2-manifest-v1\0`, `t2-apply-request-v1\0`;
- JSONB recebido do caller nunca é usado como fonte; builders SQL produzem a
  allowlist a partir de linhas relidas pós-lock.

Hashes de request incluem assinatura da capability, `session_user`, todos os
parâmetros normalizados, versões, snapshot/manifest e idempotency key. Helpers
aplicam as classes DLP do §4.2: rejeitam classe A, classe B fora do envelope,
classe C fora de campos nomeados e qualquer campo desconhecido antes de
persistir.

As functions públicas capturam somente conflitos esperados e devolvem uma
allowlist fixa de SQLSTATE/mensagem: conflito idempotente `23505`, stale
fencing/boundary `23514`, autoridade `42501` e shape `22023`. Nunca propagar
constraint name, detail, hint, row ID concorrente, valor, erro do provider ou
texto dinâmico. Serialization/deadlock/cancelamento não são convertidos.

### 4.8 Endpoints, eventos e evidência durável

Endpoints webhook ganham `version` e `config_hash`. O snapshot guarda apenas
ID, version, topic, api version e hash; nunca URL ou secret. Delivery T2 guarda
`manual_application_id`, `creation_txid` e payload redigido. A FK deixa de
cascatear para deliveries T2: endpoint referenciado não pode ser apagado, e
editar/pausar entre T2a e T2b causa boundary failure.

Sale events, audit events, fiscal document/attempt/outbox/event, accounting
export outbox, sale items, kit components, lot movements, stock movements,
warehouse ledgers, promotion redemptions e value ledgers recebem
`manual_application_id`/`creation_txid` quando aplicável ou trigger inequívoco
que cria a effect row. Identidade e payload inicial de evento/outbox são
imutáveis; somente campos de entrega explicitamente allowlisted podem mudar.
Delete direto de qualquer vértice T2 é proibido.

## 5. Assinaturas SQL públicas

Contrato comum de shape: toda `p_idempotency_key` e
`p_request_idempotency_key` usa exatamente 64 hex lowercase ou 43 base64url;
todo `p_request_hash`, assertion/proof/config/snapshot/manifest hash usa 64 hex
lowercase. IDs textuais/subject IDs têm 1..128 bytes UTF-8 NFC e reason codes
1..64 ASCII allowlisted; JSON de profile tem no máximo 64 KiB. `p_limit` de
claim/sweep fica em 1..50, lease em 5..60 segundos e assertion TTL em 1..300
segundos. Validação ocorre antes de lookup/lock e erro de shape é sanitizado.
Cada idempotency key é namespaceada por capability e aggregate; chave igual
com request hash diferente conflita, sem lookup cross-aggregate.

### 5.0 Lifecycle do perfil

```sql
public.pos_manual_issue_profile_admin_assertion_v1(
  p_action text, p_branch_id integer, p_profile_id uuid,
  p_expected_version integer, p_expected_config_hash text,
  p_issuer_subject_id text, p_subject_id text,
  p_idempotency_key text, p_request_hash text
) returns jsonb

public.pos_manual_issue_profile_accounting_assertion_v1(
  p_profile_id uuid, p_expected_version integer,
  p_expected_config_hash text, p_expected_accounting_policy_hash text,
  p_issuer_subject_id text, p_approver_id text,
  p_idempotency_key text, p_request_hash text
) returns jsonb

public.pos_manual_issue_profile_fiscal_assertion_v1(
  p_profile_id uuid, p_expected_version integer,
  p_expected_config_hash text, p_expected_fiscal_policy_hash text,
  p_issuer_subject_id text, p_approver_id text,
  p_idempotency_key text, p_request_hash text
) returns jsonb

public.pos_manual_put_finalization_profile_v1(
  p_branch_id integer,
  p_version integer,
  p_profile jsonb,
  p_actor_profile_id integer,
  p_actor_user_id text,
  p_admin_assertion_hash text,
  p_idempotency_key text,
  p_request_hash text
) returns jsonb

public.pos_manual_activate_finalization_profile_v1(
  p_profile_id uuid,
  p_expected_version integer,
  p_homologator_id text,
  p_admin_assertion_hash text,
  p_accounting_assertion_hash text,
  p_fiscal_assertion_hash text,
  p_idempotency_key text,
  p_request_hash text
) returns jsonb

public.pos_manual_retire_finalization_profile_v1(
  p_profile_id uuid,
  p_expected_version integer,
  p_homologator_id text,
  p_reason_code text,
  p_admin_assertion_hash text,
  p_idempotency_key text,
  p_request_hash text
) returns jsonb
```

`_mpi`, `_mpa` e `_mpf` recebem apenas suas funções emissoras; runtime admin
recebe apenas `put`; `_mh` recebe apenas `activate/retire`. `put` e `retire`
consomem a assertion admin exata; `activate` consome, atomicamente, admin,
accounting e fiscal assertions distintas e ainda live. Replay aponta para a
mesma operation já consumidora; nenhuma assertion autoriza outra action.
Profile JSON tem schema/keys fechados e é reconstruída/canonicalizada do banco
antes do hash. Ativação não habilita o gate e retirada nunca apaga histórico.

### 5.1 T2a — runtime

```sql
public.pos_manual_reserve_application_v1(
  p_case_id uuid,
  p_expected_case_version_before_reserve integer,
  p_actor_profile_id integer,
  p_actor_user_id text,
  p_idempotency_key text,
  p_request_hash text
) returns jsonb
```

O banco deriva `application_id`, `sale_idempotency_key`, sale request,
snapshots, manifesto e TTL. O request hash fornecido precisa ser igual ao hash
canônico recalculado de case, versão, ator e idempotency key.

Retorno allowlist:

```json
{
  "applicationId": "uuid",
  "caseId": "uuid",
  "caseVersionBeforeReserve": 3,
  "caseVersionAfterReserve": 4,
  "applicationVersion": 0,
  "state": "pending",
  "reservationExpiresAt": "instant",
  "snapshotHash": "sha256",
  "manifestHash": "sha256",
  "replayed": false,
  "currentlyApplicable": true
}
```

`pos_manual_application_status_v1(p_application_id uuid,p_actor_user_id text)
returns jsonb` devolve somente
estado, versões, expiry, sale/payment IDs após applied e códigos sanitizados.
Não devolve snapshots, referência, vault, PII ou detalhes fiscais.
Ele exige `session_user=runtime`, profile/user ativo igual ao ator da reserva e
branch/register grants ainda válidos; application alheia é indistinguível de
inexistente.

O probe obrigatório de lost-response é
`pos_manual_application_status_by_reservation_v1(p_case_id uuid,
p_reserve_idempotency_key text,p_reserve_request_hash text,
p_actor_profile_id integer,p_actor_user_id text) returns jsonb`. O profile faz
parte do hash canônico da reserve e deve coincidir integralmente; não é inferido
do estado corrente. Ele valida shape antes de lookup, exige
`session_user=runtime`, os mesmos ator/profile e grants ainda válidos, e adquire
primeiro o mesmo advisory lock global de namespace
`(reserve capability,reserve_idempotency_key)` usado por `reserve`, seguido do
case.
Em conexão primária/autoritativa, depois de esperar qualquer reserve concorrente,
retorna exatamente `committed_same_request` com o winner allowlisted,
`authoritatively_absent`, ou `unknown`; key existente com hash/case/ator/profile
divergente é conflito sanitizado `23505`, nunca ausência. Réplica, timeout,
cancelamento, falha de lock ou leitura cuja autoridade não possa ser provada
retorna `unknown`. Runtime recebe somente essas duas assinaturas de status; o
probe não cria application, operation ou transition, e replay é read-only.

### 5.2 Claim do finalizador

```sql
public.pos_manual_claim_applications_v1(
  p_finalizer_id text,
  p_limit integer,
  p_lease_seconds integer,
  p_request_idempotency_key text
) returns jsonb
```

`p_request_idempotency_key` deve obedecer exatamente ao formato fechado do
§4.2. Formato ou comprimento inválido é rejeitado antes de consultar backlog;
o banco não infere entropia.

`p_lease_seconds` fica entre 5 e 60 segundos e cada
`claim_expires_at <= reservation_expires_at - interval '2 seconds'`;
`statement_timeout` do executor é estritamente menor que o lease. Replay usa o
expiry persistido, sem estender a janela.

Usa batch/receipt idempotente, fairness por sessão, `FOR UPDATE OF session SKIP
LOCKED`, no máximo `p_limit` session locks e um application por sessão em cada
sweep. Replay live devolve os mesmos claim tokens por `batch_index`; batch
expirado devolve `replayExpired=true`, nunca tokens novos sob a mesma chave.
Applications cuja reserva venceu antes do claim não recebem claim token; o
claim não as muta nem assume a authority do sweep. `_ms` as bloqueia
causalmente e libera reservas físicas/promocionais. A manutenção executa mesmo
sem backlog aplicável.

Cada comando contém somente application/case IDs, versões, fencing token,
claim token, expiry, snapshot/manifest hashes. O finalizador não recebe dados
de venda: T2b deriva tudo do snapshot persistido.

Fairness é implementada em duas etapas sem `DISTINCT/window` combinado com row
lock: selecionar/lockar até `p_limit` sessions candidatas por ordem causal com
`FOR UPDATE OF session SKIP LOCKED`, depois localizar e lockar no máximo uma
application por session pela ordem canônica. Claim apenas ignora expiradas; o
timer `_ms` é o único executor do expiry/release.

O sweep não depende do claim e é uma capability própria instalada em T2-02:

```sql
public.pos_manual_sweep_expired_applications_v1(
  p_sweeper_id text,
  p_limit integer,
  p_idempotency_key text,
  p_request_hash text
) returns jsonb
```

Somente `_ms` recebe EXECUTE. O executor roda mesmo com backlog vazio, trava o
grafo completo em ordem canônica e libera reservas físicas/promocionais
vencidas com ledgers, operation/event e incidente causal sanitizado.

### 5.3 T2b — finalizador

```sql
public.pos_manual_apply_application_v1(
  p_application_id uuid,
  p_expected_case_version_after_reserve integer,
  p_expected_application_version integer,
  p_fencing_token bigint,
  p_claim_token text,
  p_idempotency_key text,
  p_request_hash text
) returns jsonb
```

O request hash liga todos os parâmetros, hashes do snapshot/manifest e caller
role. Retorno: application/case/sale/payment IDs, resulting versions/state,
apply txid e `replayed`; nenhum detalhe sensível.

```sql
public.pos_manual_report_application_failure_v1(
  p_application_id uuid,
  p_fencing_token bigint,
  p_claim_token text,
  p_failure_kind text,
  p_idempotency_key text,
  p_request_hash text
) returns jsonb
```

Aceita apenas a taxonomia `retryable_internal|boundary_changed|reservation_expired`.
Não há I/O de provider dentro de T2b, mas pode haver falha de transporte entre
executor e PostgreSQL; ela segue o protocolo unknown/probe abaixo. Retryable
libera/reagenda o lease; boundary/expiry bloqueiam application e case com
operation/event/incidente no mesmo tx. `_mf` também recebe
`pos_manual_probe_application_v1(p_application_id uuid,p_finalizer_id text,
p_apply_idempotency_key text,p_apply_request_hash text,p_fencing_token bigint,
p_claim_token_hash text) returns jsonb`. O probe valida shape, exige
`session_user=_mf`, serializa no mesmo advisory namespace da apply e prova a
identidade integral de application, finalizer, apply key/hash, fencing e hash do
claim token sem aceitar o token bruto. Em primário autoritativo retorna somente
`committed_same_request` com winner allowlisted, `authoritatively_absent`, ou
`unknown`. Winner existente sob key/application com qualquer identidade
divergente é conflito sanitizado `23505`, nunca ausência nem sucesso; timeout,
réplica, lock/cancelamento ou leitura não autoritativa são `unknown`. O probe é
read-only e somente `authoritatively_absent` autoriza repetir a mesma apply key,
request hash, fencing e claim; nunca uma nova key ou segundo efeito.

Falha de COMMIT, desconexão, timeout, cancelamento, serialization/deadlock ou
resultado desconhecido nunca pode ser reportada como `boundary_changed` nem
gravar `blocked`. O executor primeiro executa probe em conexão nova e só usa
report para uma causa determinística observada e revalidável pelo próprio
banco.

Matriz fechada do probe T2b:

| Resultado | Prova | Única ação permitida |
| --- | --- | --- |
| `committed_same_request` | apply winner coincide integralmente com application/finalizer/key/hash/fencing/claim-token-hash | aceitar o winner, sem nova mutação |
| `authoritatively_absent` | primário, sob o mesmo lock, prova ausência da operation/effect dessa identidade | repetir uma vez a mesma chamada, com todos os campos idênticos |
| `unknown` | autoridade, lock ou conclusão não pode ser provada | novo probe serial; nenhum apply/report/retry |

Winner parcial ou divergente não pertence à matriz de sucesso: retorna conflito
sanitizado `23505` e bloqueia retry automático.

## 6. Ordem canônica de locks

Toda capability writer T2 deve usar o mesmo helper antes da primeira escrita e
prelockar o conjunto completo de roots que ela ou seus triggers alcançarão;
não reutilizar `guard_pos_manual_application` atual sem substituí-lo.

T2-01 substitui ainda `guard_pos_manual_operation`, o ramo de transição de
`protect_pos_manual_case`, `block_plan_release_with_manual_case` e qualquer
trigger de sale/payment/plan que adquira root fora desta ordem. Trigger nunca
adquire outra business root, chama helper de lock ou executa `FOR UPDATE`/`FOR
SHARE`: ele somente valida `OLD/NEW` e contexto já prelockado. Se uma escrita
exige outra root, o writer deve incluí-la no prelock canônico antes de escrever.
Isso vale também para expiry, close, handoff, revoke, callback/worker
contraditório, plan consume e writers migrados fora de T2; DML direto permanece
impossível por ACL.

1. advisory lock da action/capability e idempotency key;
2. cash register session;
3. terminal;
4. operator, actor, branch grants e register grants, por ID;
5. order claim, quando existir;
6. held sale/draft e itens, por ID;
7. payment plan, slot e quote lines;
8. connector, credential, reconciliation gate e finalization profile;
9. compensation keyring provider/revision;
10. compensation inbox ingress, por ingress ID;
11. manual case;
12. confirmed observation, incidentes e application;
13. compensation aggregate;
14. remediation assertion;
15. compensation proof owner;
16. proof consumption;
17. promotion/coupon e reservas promocionais;
18. products/variations/BOM/components, por scope key;
19. warehouse balances e variation balances, por warehouse/product/variation;
20. inventory lots por FEFO `(expiry,received_at,id)` e reservas;
21. fiscal profile/numbering scope;
22. accounting period, policy, mappings/accounts e cost center;
23. webhook endpoints, por ID;
24. sale/payment já existentes em replay.

O relógio é `clock_timestamp()` capturado **depois** de todos os locks de
boundary e recapturado antes da validação final da função. IDs vindos de uma leitura prévia
servem apenas para localizar raízes; toda decisão usa as linhas relidas após
lock.

O helper não confia em uma flag de sessão gravável pelo caller. Contexto
interno, quando indispensável para evitar relock de trigger, usa nonce local
gerado e validado pela capability owner-only. Advisory locks têm namespace T2
e colisão só pode reduzir concorrência, nunca autorizar operação.
O namespace é fechado por action — `reserve`, `apply`, `comp_claim`,
`comp_consume`, `comp_waive`, `comp_ingest`, `comp_match`, `key_rotate` ou
`key_revoke` — mais a idempotency key canônica; todo status/probe adquire
exatamente o namespace da writer que observa. Ingest/status, match/reprocess e
seu probe, claim/consume/waive e seus probes, rotate/revoke e qualquer helper
aninhado usam somente o subconjunto aplicável da lista acima, sem permutar
roots. Lookup pré-lock serve apenas para descobrir IDs e jamais decidir estado.

## 7. Algoritmo T2a

Em uma transação `SERIALIZABLE`:

1. validar shape, DLP e hash do request; advisory lock por idempotência;
2. buscar replay; conflito semântico retorna `23505`;
3. adquirir o grafo pela ordem canônica e recapturar o relógio;
4. exigir case `confirmed_paid`, versão exata, observation confirmadora
   `confirmed_paid` e `confirmation_expires_at > now`. Para source worker, a
   observation precisa chegar ao provider proof por delivery + consumption
   one-shot; para source callback, por callback + ingress proof owner accepted.
   Em ambos os caminhos a prova, observation e case precisam coincidir, e não
   pode existir incidente production-blocking aberto;
5. revalidar sessão open, terminal online/não revogado/live, actor/profile/user,
   maker grant, draft status/revision/request hash, plan active/version/TTL,
   slot único manual, quote/hash/valor, connector/credential/gate
   `enabled=true`/revisões e
   perfil de finalização;
6. materializar snapshot canônico; converter quantidade para micros e rejeitar
   qualquer perda de precisão;
7. prealocar `planned_sale_id`, derivar número/instant determinísticos e
   incluí-los nos snapshots fiscal, contábil e comercial;
8. expandir kit/BOM, selecionar tracking/FEFO e criar reservas físicas;
9. reservar promoção/cupom; congelar fiscal, accounting, valor-accrual e
   endpoints webhook;
10. quando fiscal required, exigir envelope previamente homologado e persistir
    apenas locator/version/hash;
11. criar application pending, snapshot e manifesto;
12. criar operation `reserve_application`, state event e mover case
    `confirmed_paid → application_pending`, todos com o mesmo txid;
13. constraint diferida prova application, snapshot, manifesto, reservas,
    operation/event e case.

Expiração ou boundary divergente antes da reserva não cria application. Uma
reserva existente não é reemitida como aplicável após perder autoridade:
replay retorna o mesmo ID, mas `currentlyApplicable=false`.

## 8. Algoritmo T2b

`apply` roda em `SERIALIZABLE`; serialization/deadlock é repetido com a mesma
idempotency key. Após validar lease/fencing e boundary pós-lock:

1. exigir application `claimed`, case `application_pending`, versões, TTL de
   confirmation/reservation, hashes e perfil iguais ao T2a;
2. recomputar todos os snapshots a partir das linhas travadas e comparar os
   hashes; não confiar no JSON isoladamente;
3. inserir sale com `planned_sale_id`, número e instant congelados,
   `source_type=manual_payment_application`, header e items exatamente iguais
   ao quote multiset;
4. inserir um `PosSalePayment(manual_confirmed)` com allowlist e FK do case;
5. inserir promotion redemption e consumir reservas promocionais;
6. criar plan operation `consume`, mover plan para consumed e converter draft;
7. criar kit components, consumir reservas de lotes/séries e produzir stock
   movement + warehouse ledger para cada scope; atualizar `totalSales`;
8. criar accruals de valor previstos no manifesto; nenhum pagamento por valor
   participa deste primeiro corte;
9. conforme perfil fiscal, criar document, state event, attempt e fiscal outbox
   no mesmo tx, ou provar uma disposição `not_applicable` homologada;
10. criar accounting journal, postings balanceados e export outbox usando
    período/policy/mappings congelados;
11. criar sale event, audit events e uma webhook delivery por endpoint
    congelado, com payload redigido;
12. materializar todas as effect rows e provar manifesto = efeitos;
13. atualizar application para applied, inserir operation `apply`/state event e
    mover case para applied com `applied_sale_payment_id`;
14. tornar imediatas por nome e executar as constraints estruturais e de
    multiset antes de devolver o resultado SQL.

SQL não força nem observa de modo autônomo o COMMIT do caller. Uma constraint
temporal `DEFERRABLE INITIALLY DEFERRED` permanece defesa adicional e pode
rejeitar no COMMIT, mas retorno da função não é prova de commit. A autoridade
transacional é o executor `_mf`: uma chamada por conexão em autocommit, sem
`BEGIN` controlado pela aplicação, e sucesso somente após o driver confirmar o
COMMIT. Retorno sem ACK, desconexão ou erro no commit segue as mesmas três
saídas exatas: `committed_same_request` é sucesso; `authoritatively_absent`
autoriza repetir somente a mesma key; `unknown` exige probe serial, sem
report/block/retry concorrente ou nova key. Até confirmação observável, o
executor não presume o estado: o banco pode já conter o grafo `applied` e todos
os efeitos T2b comprometidos atomicamente. Somente o probe autoritativo decide;
nenhuma saída cria uma segunda application, efeito ou idempotency key.

Não há commit parcial. Um erro depois da sale, payment, estoque, fiscal ou
accounting reverte todas essas linhas. A application T2a continua existente;
se o lease estiver live, a mesma chamada pode ser repetida, e após expiry um
novo fencing token pode ser adquirido.

### 8.1 Falhas determinísticas

Boundary, TTL, snapshot, manifesto, fiscal/accounting e reserva divergentes não
podem deixar uma sale parcial. Somente uma causa determinística detectada e
revalidada dentro da capability autorizada pode fazer o core abortar a
subtransação e o wrapper, ainda sem efeitos comerciais, gravar atomicamente
application/case blocked, operation/event, liberação das reservas e incidente
sanitizado.

Rollback da subtransação libera locks adquiridos depois do savepoint. Portanto
o wrapper não grava blocked imediatamente: readquire o grafo completo pela
ordem canônica, recaptura o relógio, revalida application version, claim hash,
lease e fencing, e só então bloqueia/libera. Se perdeu autoridade, retorna
stale `23514` e não presume causa nem altera estado.

Serialization/deadlock, cancelamento, desconexão, timeout, failpoint, falha no
COMMIT e resultado `unknown` fazem rollback ou exigem probe; nunca gravam
blocked por suposição. Se a transação falhar no commit, nenhuma tentativa de
registrar blocked naquela transação sobrevive. Após lease/reserva expirar,
somente `_ms` pode liberar/bloquear com uma nova observação causal.

### 8.2 Resolução e compensação de blocked

`blocked` é terminal para a application: suas reservas ficam released, ela
nunca reabre, nunca é aplicada e suas evidências não são reutilizadas. Não
reutilizar `pos_payment_compensations`, que pressupõe payment/sale. Criar o
aggregate próprio `pos_manual_application_compensations`, com application e
case 1:1, versions capturadas, estados
`required|proof_pending|compensated|waived`, amount/currency imutáveis,
`vault_proof_id/hash`, proof externo/callback ingress+consumption segregados,
`version`, `created_txid` e terminal timestamps. Criar também operation/state
event ledger append-only e `pos_manual_remediation_assertions` emitida somente
por `_mri`.

Cardinalidades são explícitas: unique/FK não diferível em
`compensation.application_id`, `compensation.case_id` e
`(application_id,case_id)`; exatamente um aggregate por application/case
blocked; um ingress matched pertence a exatamente uma compensation; um proof owner a um
ingress e compensation; um consumption a um proof e operation; um provider
event globalmente único. O `compensation_id` não vem do caller: claim deriva
UUIDv5 owner-only de namespace `t2-manual-compensation-v1` mais application ID,
case ID, e de nenhum outro dado. Replay deriva o mesmo UUID; colisão sem
igualdade integral é erro sanitizado.

Criar inbox autenticada durável append-only
`pos_manual_compensation_callback_ingress`, seu ledger de estados
`unmatched|matched|rejected|expired`, e proof owner
`pos_manual_compensation_proofs`. Header/payload/digests são imutáveis; cada
transição é state-event append-only com version/CAS. Somente `_mcc`,
credencial/processo isolados dos callbacks `_mc`, chama ingest. Ela valida HMAC sobre os bytes crus
exatos do body e framing versionado, com `key_revision` ativa, algoritmo
`HMAC-SHA-256`, comparação constant-time, timestamp dentro da janela anti-replay
de no máximo cinco minutos e nonce. Unique globais cobrem
`(provider,event_id)`, `(provider,key_revision,nonce)` e digest dos bytes
assinados. Parser fechado extrai provider, outcome `refund_succeeded`, amount
em minor units, currency, application ID, case ID e compensation ID. Depois de
HMAC/anti-replay e parse válidos, o ingress é committed como `unmatched` mesmo
sem aggregate; callback-before-claim nunca é descartado. Body, assinatura e secret não são
copiados para audit/erro; ingress guarda raw ciphertext/locator conforme DLP,
digests, key revision e timestamps.

Criar `pos_manual_compensation_hmac_keyring`, owner dedicado NOLOGIN
`<database>_mcko`, sem grant de tabela, com `(provider,key_revision)` unique,
estado `active|revoked`, algoritmo fixo `HMAC-SHA-256`, locator/version do
secret em KMS, `active_from/active_until`, created/revoked operation e no máximo
uma revision active por provider/instant, garantido por exclusion constraint
temporal. Ingest exige que a revision informada seja exatamente a única active
no `p_event_timestamp` e congela esse snapshot. `_mck` recebe somente capabilities
`rotate`/`revoke`; `_mcc` recebe somente ingest e seu status read-only. Rotate cria nova revision e
snapshot append-only; revoke nunca apaga e não invalida ingress já aceito. O
ingress congela provider, revision, algorithm e key-config hash; a capability
owner resolve o secret sem retorná-lo ou persistir plaintext.

Antes de parse, lookup de aggregate ou mensagem dinâmica, ingest exige raw body
1..65536 bytes, assinatura exatamente 32 bytes, provider/event/nonce headers
ASCII 1..128 bytes, revision positiva, timestamp parseável e request/hash no
shape comum. O framing assinado é exatamente
`t2-manual-comp-v1\0provider\0revision\0timestamp-UTC-micros\0event-id\0nonce\0raw-body`.
`signed_digest=SHA-256(framing)` possui unique **global**; não há segunda regra
por provider/revision que enfraqueça essa unicidade.

O matcher isolado `_mcm`, por timer mesmo sem backlog, recebe apenas
`match`, `match_status` e `probe_ingress` nas assinaturas fechadas abaixo.
`p_limit` segue 1..50; timer/credential/unit são próprios e quarantined. Após claim criar `required`, ele prelocka inbox/case/
application/compensation/proof na ordem universal, exige igualdade exata de provider/outcome/amount/currency/
application/case/compensation, consome o ingress one-shot, cria proof owner e
move `unmatched → matched` e `required → proof_pending` no mesmo tx. Divergência
determinística vira `rejected` + incidente; unmatched além do TTL fechado
(máximo 24 horas, configurado e snapshotado) vira `expired` + incidente. Match,
reject e expire têm operation/event próprios e replay idempotente. `_mcc` não
match/reprocess; `_mcm` não ingere nem consome proof.

Cada execução `_mcm` persiste receipt idempotente por
`(matcher_id,action,idempotency_key,request_hash)`, onde action é somente
`match|reprocess`. Lost-ACK usa `match_status` com essa identidade para recuperar
o receipt e seus ingress IDs mesmo quando a resposta inteira se perdeu; depois,
`probe_ingress` prova um ingress específico com a mesma identidade. Ambos
serializam no namespace `comp_match` da writer e retornam somente
`committed_same_request|authoritatively_absent|unknown`; identidade parcialmente
coincidente é conflito `23505`. Somente ausência autoritativa permite replay da
mesma action/key/hash/matcher; `unknown` não permite mutação. O probe/status não
match, reject, expire, cria proof ou muda estado.

Lost-ACK do ingest não depende do `ingress_id`. `_mcc` recebe também, e somente,
`pos_manual_compensation_callback_status_v1(p_provider text,p_event_id text,
p_nonce_hash text,p_signed_digest text,p_ingest_idempotency_key text,
p_ingest_request_hash text) returns jsonb`. O probe valida shapes, autentica
`session_user=_mcc`, serializa no mesmo namespace `(provider,event_id)` do
ingest e, em conexão primária, retorna exatamente `committed_same_request` com
`ingressId/state/version` allowlisted, `authoritatively_absent`, ou `unknown`.
O winner só é revelado quando idempotency key, request hash, nonce hash e signed
digest coincidem integralmente; qualquer identidade parcialmente coincidente é
conflito sanitizado `23505`, não ausência. Timeout, réplica, cancelamento ou
autoridade não demonstrável são `unknown`. O probe é read-only: não autentica
novo callback, não ingere, match, reprocessa, cria proof ou muda estado. Após
`authoritatively_absent`, `_mcc` pode repetir somente o ingest byte-a-byte com a
mesma key; `unknown` proíbe retry. Assim a recuperação preserva SoD e nunca
produz segundo ingress apesar de corrida, replay ou resposta totalmente perdida.

As únicas transições são `required → proof_pending → compensated` (ou
`required → waived` homologado). O pipeline ingest+matcher cria proof owner e
o matcher avança `required → proof_pending`; não compensa. Consume one-shot por `_mr`,
com assertion `_mri`, relê todas as igualdades e avança
`proof_pending → compensated`. `_mr` nunca fabrica, altera ou aceita proof do
caller; `_mcc` nunca consome ou remedia.

O lifecycle não se sobrepõe: `claim` apenas cria/replay aggregate em
`required`; `ingest` apenas cria inbox `unmatched`; matcher/reprocess apenas
aceita inbox unmatched + aggregate required e os move a matched/proof_pending;
`consume_proof` apenas aceita aggregate `proof_pending` e o
move a `compensated`; `resolve` aceita somente aggregate `required`, disposition
`waive`, e o move a `waived`. Qualquer outra combinação state/capability falha
antes de escrever. Nenhuma função genérica escolhe entre essas transições.

A remediation assertion é one-shot e liga exatamente application ID/version,
case ID/version, disposition, compensation ID/version quando existente,
remediator subject ID, request hash, expiry e hash da authority. Seu
`consumed_operation_id` referencia a operation do aggregate de compensation,
nunca operation de profile/application. Issuer `_mri` e executor `_mr` têm
subject IDs distintos; runtime, `_mpi`, `_mh` e `_mf` nunca emitem, consomem ou
remediam.

Criar as assinaturas:

```sql
public.pos_manual_rotate_compensation_hmac_key_v1(
  p_provider text, p_key_revision integer, p_kms_locator text,
  p_kms_version text, p_active_from timestamptz,
  p_active_until timestamptz, p_admin_subject_id text,
  p_idempotency_key text, p_request_hash text
) returns jsonb

public.pos_manual_revoke_compensation_hmac_key_v1(
  p_provider text, p_key_revision integer, p_expected_config_hash text,
  p_admin_subject_id text, p_reason_code text,
  p_idempotency_key text, p_request_hash text
) returns jsonb

public.pos_manual_claim_application_compensation_v1(
  p_application_id uuid, p_expected_application_version integer,
  p_case_id uuid, p_expected_case_version integer,
  p_remediator_subject_id text, p_idempotency_key text, p_request_hash text
) returns jsonb

public.pos_manual_ingest_compensation_callback_v1(
  p_provider text, p_key_revision integer, p_event_timestamp timestamptz,
  p_event_id text, p_nonce text, p_raw_body bytea, p_signature bytea,
  p_idempotency_key text, p_request_hash text
) returns jsonb

public.pos_manual_compensation_callback_status_v1(
  p_provider text, p_event_id text, p_nonce_hash text, p_signed_digest text,
  p_ingest_idempotency_key text, p_ingest_request_hash text
) returns jsonb

public.pos_manual_match_compensation_ingress_v1(
  p_matcher_id text, p_action text, p_limit integer,
  p_idempotency_key text, p_request_hash text
) returns jsonb

public.pos_manual_match_compensation_status_v1(
  p_matcher_id text, p_action text,
  p_match_idempotency_key text, p_match_request_hash text
) returns jsonb

public.pos_manual_probe_compensation_ingress_v1(
  p_ingress_id uuid, p_matcher_id text, p_action text,
  p_match_idempotency_key text, p_match_request_hash text
) returns jsonb

public.pos_manual_consume_compensation_proof_v1(
  p_compensation_id uuid, p_expected_compensation_version integer,
  p_proof_id uuid, p_remediator_subject_id text,
  p_remediation_assertion_hash text,
  p_idempotency_key text, p_request_hash text
) returns jsonb

public.pos_manual_probe_claim_application_compensation_v1(
  p_application_id uuid, p_expected_application_version integer,
  p_case_id uuid, p_expected_case_version integer,
  p_remediator_subject_id text,
  p_claim_idempotency_key text, p_claim_request_hash text
) returns jsonb

public.pos_manual_probe_consume_compensation_proof_v1(
  p_compensation_id uuid, p_expected_compensation_version integer,
  p_proof_id uuid, p_remediator_subject_id text,
  p_remediation_assertion_hash text,
  p_consume_idempotency_key text, p_consume_request_hash text
) returns jsonb

public.pos_manual_probe_waive_application_compensation_v1(
  p_compensation_id uuid, p_expected_compensation_version integer,
  p_application_id uuid, p_expected_application_version integer,
  p_case_id uuid, p_expected_case_version integer,
  p_remediator_subject_id text, p_remediation_assertion_hash text,
  p_waive_idempotency_key text, p_waive_request_hash text
) returns jsonb

public.pos_manual_issue_remediation_assertion_v1(
  p_application_id uuid,
  p_expected_application_version integer,
  p_case_id uuid,
  p_expected_case_version integer,
  p_disposition text,
  p_compensation_id uuid,
  p_expected_compensation_version integer,
  p_issuer_subject_id text,
  p_remediator_subject_id text,
  p_idempotency_key text,
  p_request_hash text
) returns jsonb

public.pos_manual_resolve_blocked_application_v1(
  p_application_id uuid,
  p_expected_application_version integer,
  p_case_id uuid,
  p_expected_case_version integer,
  p_remediator_subject_id text,
  p_remediation_assertion_hash text,
  p_disposition text,
  p_compensation_id uuid,
  p_expected_compensation_version integer,
  p_reason_code text,
  p_idempotency_key text,
  p_request_hash text
) returns jsonb
```

O resumo fechado de grants é: `_mck` somente rotate/revoke; `_mcc` somente
ingest/status de callback; `_mcm` somente match/status/probe de ingress; `_mri` somente
issue; `_mr` somente claim/consume/resolve e os três probes nominais. Nenhuma
dessas roles recebe helper interno ou assinatura de outra linha. A assertion liga uma única action
`consume_proof|waive`; `resolve` rejeita qualquer disposition diferente de
`waive`. Pagamento confirmado sem sale primeiro cria o aggregate em `required`;
somente ingest válido seguido do matcher `_mcm` o avança a `proof_pending`.
`required` e `proof_pending`
mantêm case e incidente abertos. Somente proof externo autenticado, ingerido por callback
segregado, ligado ao vault proof e consumido one-shot pode avançar a
`compensated`. `waived` exige assertion específica e reason code homologado.
Resolve relê/prelocka ingress, case, application, compensation, assertion,
proof/consumption na ordem universal, verifica versions/hashes e grava consumo+operation/event no mesmo
tx. A resolução nunca edita evidência. Nova venda exige novo
plan/case/application após compensated/waived.

Os três probes `_mr` são separados por action e read-only. Cada um exige
`session_user=_mr`, valida remediator, key e request hash e serializa no mesmo
advisory namespace da writer correspondente. O probe de claim não exige
`compensation_id`, pois ele pode ser desconhecido após perda integral da
resposta: localiza por application/case, versões anteriores à claim, remediator,
claim key e request hash, e só devolve o compensation ID no resultado
`committed_same_request`. Consume prova compensation ID/version,
proof e assertion; waive prova compensation/application/case versions e
assertion. Esses campos são a identidade de fencing/claim da action e entram no
hash canônico; não há probe genérico com identidade parcial. Em conexão primária
cada probe retorna exatamente `committed_same_request` com winner allowlisted,
`authoritatively_absent`, ou `unknown`. Winner sob a mesma key/aggregate com
qualquer identidade divergente — inclusive compensation winner divergente na
claim — é conflito sanitizado `23505`; timeout, réplica,
cancelamento, falha de lock ou autoridade não comprovada são `unknown`.
Somente ausência autoritativa permite repetir a mesma action/key/hash/identidade;
nenhum probe cria aggregate, proof, operation, event ou transição.

Claim, consume e resolve usam uma chamada autocommit cada; `_mr` só declara a
transição após ACK. Lost-ACK usa exatamente
`committed_same_request|authoritatively_absent|unknown`: respectivamente
devolve winner, repete a mesma key, ou faz novo probe serial sem mutação. Remediation e callback
continuam operacionais com o reconciliation gate HARD-OFF: suas guards não
consultam `gate.enabled` para autorizar reparação, embora nunca possam habilitar
reserve/apply.

## 9. Constraints e guards de commit

Substituir em migration nova, com testes negativos, as guards relevantes:

- application pending exige reserve operation/event, snapshot, manifesto e
  reservas no `reserve_txid`;
- application applied exige apply operation/event, case applied, sale, payment,
  plan consumed, draft converted e multiset integral no `apply_txid`;
- case applied aponta para o mesmo payment que aponta de volta ao case;
- sale manual aponta para uma única application applied;
- payment manual não pode coexistir com legacy reference, intent,
  compensation ou value proof;
- plan manual só consome através do case T2, nunca pelo legado;
- `authorize_pos_sale_payment_plan_slot`,
  `validate_consumed_pos_payment_plan` e
  `validate_sale_authoritative_payment_plan_commit` reconhecem o mesmo grafo
  T2 e preservam os ramos não manuais;
- cada balance decrement tem reservation consumed, movement e warehouse ledger
  correspondentes; lote/série tem movement em micros;
- kit manifesto e componentes persistidos são multisets idênticos;
- fiscal required tem document/event/attempt/outbox; accounting tem journal,
  postings balanceados e export outbox;
- todo manifest entry obrigatório tem exatamente um effect com mesmo hash e
  txid; nenhum effect extra é aceito;
- snapshots, manifesto, operations, state events, effects e ledgers são
  append-only; payment evidence permanece imutável.
- `pos_manual_application_stamp` legado é removido/substituído: update de claim
  nunca altera `reserve_txid`, e apply grava `apply_txid` uma única vez;
- a constraint temporal de application applied permanece diferida como defesa
  de COMMIT, sem alegar que a função SQL força ou confirma esse COMMIT.

Triggers são validadores puros de linhas/contexto prelockado: não adquirem
outras roots nem chamam helper. Cada writer, inclusive legado afetado, prova em
teste que prelocka o grafo completo na ordem do §6; DML operacional direto
continua impossível pela ACL.

## 10. Idempotência e concorrência

- T2a: unique global da idempotency key e unique case; replay exige o mesmo
  request hash, ator, versão e snapshot.
- Claim: batch/receipt por request key, ordem determinística, replay live dos
  mesmos tokens, conflito de parâmetros `23505` e replay expirado explícito.
- T2b: unique apply idempotency e sale source/application; concorrência idêntica
  devolve o winner, conteúdo divergente falha `23505`.
- Stale claim/fencing falha `23514`, mesmo que token textual coincida com uma
  delivery antiga.
- 20 T2a iguais produzem uma application; 20 T2b iguais produzem uma sale, um
  payment e uma baixa por efeito.
- close/handoff, revogação, edição, consume concorrente, expiry, callback
  contraditório e incidente disputam os mesmos roots e são revalidados após
  locks.

## 11. Failpoints de teste

O entrypoint operacional nunca aceita failpoint. Criar core interno sem grant:

```sql
public.pos_manual_apply_application_core_v1(..., p_test_failpoint text)
```

O wrapper `_mf` sempre passa `NULL`. Somente migrator no banco efêmero de teste
chama o core com:

`after_sale`, `after_items`, `after_payment`, `after_plan`, `after_draft`,
`after_promotion`, `after_tracking`, `after_stock`, `after_value`,
`after_fiscal_document`, `after_fiscal_outbox`, `after_accounting_journal`,
`after_accounting_outbox`, `after_webhooks`, `after_effects` e
`before_case_apply`.

Antes de avaliar qualquer `p_test_failpoint`, o core chama um verifier interno
owner-only que prova versão do schema, presença/assinatura de todos os
producers, validators, effect kinds, constraints e guard de onda. Verifier
incompleto levanta `0A000` e rollback; não é possível saltá-lo escolhendo um
failpoint tardio ou `NULL`. Em T2-04/T2-05, mesmo verifier completo para a onda
é seguido do guard terminal revert-only. Somente T2-06 remove esse guard após o
verifier integral. Cada failpoint levanta exceção e o teste prova zero efeitos;
repetição com `NULL` só obtém exatamente um grafo depois do gate T2-06.

## 12. Matriz PostgreSQL obrigatória

### Happy path e replay

- fresh migrate/seed; criar profile homologado sem ligar gate global;
- existe uma única regra/harness `withEphemeralManualGate`: somente banco fresh
  efêmero, marcado e verificado como tal, conexão migrator e connector exato;
  ela desabilita a hard-guard e habilita o gate só no escopo do callback,
  restaura ambos em `finally` e confirma o HARD-OFF por conexão nova. Qualquer
  `DISABLE TRIGGER`, update de gate, seed, env ou helper ad hoc é proibido;
- o callback do harness envolve a jornada inteira — profile/assertions,
  confirmação, T2a, claim, T2b, probe e remediation quando exercitada. Ele não
  devolve gate habilitado ao caller entre fases nem permite nested/partial
  harness;
- callback/response real chega a confirmed_paid;
- T2a e T2b em transações separadas, com txids distintos internamente e txid
  único dentro de cada fase;
- multiset quote/items, payment/case, reservas/stock, fiscal, accounting e
  webhooks completos;
- replay exato e conflito de idempotência em reserve, claim, apply e report.
- lost-ACK de reserve, inclusive resposta totalmente perdida antes de conhecer
  `applicationId`: status por `(caseId,reserve key,request hash,actor profile,
  actor user)` em conexão nova
  encontra o winner; somente uma ausência autoritativa permite repetir a mesma key; jamais duas
  applications/transições. Boundary que vence antes do
  COMMIT autocommit de T2a causa rollback e nunca é anunciado como reserved;
- conexão A chama apply em transação explícita e desconecta/ROLLBACK antes do
  COMMIT: mesmo que a função retorne, conexão B observa zero efeitos e T2a
  pending/claimed; chamada autocommit só é success após ACK e conexão nova
  observa applied; falha induzida de constraint no COMMIT deixa zero efeitos,
  não grava blocked e exige probe/retry.
- lost-ACK de apply cobre as três saídas com application/finalizer/key/hash/
  fencing/claim-token-hash exatos; winner divergente dá conflito, ausência
  autoriza apenas replay idêntico e `unknown` não autoriza mutação;
- fora de `withEphemeralManualGate`, conexão nova confirma
  `gate.enabled=false`; `_mcc` ainda ingere callback válido e `_mr` ainda
  claim/consume/probe/waive remediation, enquanto runtime reserve e `_mf` apply
  são negados. A conexão fecha e outra reconfirma HARD-OFF;
- com o mesmo HARD-OFF, o timer `_mcm` usa credencial e conexão PostgreSQL reais,
  executa match/reprocess/status/probe até `proof_pending` sem qualquer harness,
  SELECT/DML direto ou herança; todas as demais roles, inclusive `_mcc`, `_mr`,
  runtime e PUBLIC, recebem cross-denial nessas assinaturas;

### Corridas

- 20 reserve concorrentes; 20 apply concorrentes;
- dois finalizers, duas sessões e `limit=1`, ambos progridem sem over-lock;
- T2a versus expiry/callback/block/close/handoff/revoke/draft edit/plan consume;
- T2b versus revoke/profile retire/incident/stock/promotion/period close;
- duas vendas disputando último saldo, última série, último lote FEFO e último
  uso de cupom;
- lease expirado, reclaim e stale fencing.
- reserva vencida antes do primeiro claim libera todo estoque/promo e bloqueia
  o case sem criar sale/payment;
- callback antes de claim cria exatamente uma inbox autenticada `unmatched`,
  sem proof/aggregate fabricado; claim seguido do matcher converge em
  matched/proof_pending sem perda;
- callback duplicado por event, nonce ou signed digest produz um único ingress;
  duas ingests/consumes concorrentes produzem um proof/consumption/terminal;
- matcher antes do claim mantém unmatched; matcher depois do claim faz um único
  match; TTL vence para expired+incidente e reprocess posterior não ressuscita;
- tempestade cruzada ingest/status/match/reprocess/claim/consume/waive/
  rotate/revoke/probes usa a ordem universal keyring→inbox→case→application→
  compensation→assertion→proof→consumption, sem deadlock recorrente nem decisão
  baseada em lookup pré-lock;
- lost-ACK de claim/ingest/consume/waive percorre as três saídas exatas e replay
  com a mesma key, sem segunda operation ou transição;
- cada probe `_mr` de claim/consume/waive testa separadamente winner exato,
  ausência autoritativa, `unknown` e conflito por remediator/key/hash ou por sua
  identidade de compensation/application/case/version/proof/assertion;
- lost-ACK da claim antes de conhecer `compensationId` é resolvido por
  application/case/before-versions/remediator/key/hash; somente winner exato
  devolve o ID, winner divergente conflita e absent/unknown seguem o tri-state;
- lost-ACK de match/reprocess antes de conhecer ingress IDs usa primeiro o
  status do receipt por matcher/action/key/hash e depois o probe por ingress;
  replay idêntico produz um receipt, um match e um proof, sem ressuscitar TTL;
- lost-ACK de ingest antes de conhecer `ingressId` é recuperado por `_mcc` via
  `(provider,eventId,nonceHash,signedDigest,ingest key,request hash)`; winner,
  ausência autoritativa, conflito parcial e `unknown` concorrente são testados,
  e somente ausência autoriza replay byte-a-byte da mesma key;

### Integridade física e comercial

- item simples, variação, service, kit multinível, lote, série e FEFO;
- lote vencido/quarentena, scan divergente, saldo insuficiente e quantidade não
  representável em micros;
- promoção global/cliente/cupom e liberação após block/expiry;
- fiscal `required_queue`, `not_applicable` homologado e todas as configurações
  ausentes/divergentes;
- período fechado, policy/mapping/account/cost center divergentes e journal não
  balanceado;
- endpoint pausado/editado e payload com tentativa de PII/PAN.
- callback de compensação testa bytes crus alterados, assinatura/key revision,
  nonce/event replay, janela vencida e divergência de provider/outcome/amount/
  currency/case/application/compensation; todos falham sem avançar state;
- `_mc` e `_mr` não conseguem ingest, `_mcc` não consegue match/claim/consume,
  `_mcm` não consegue ingest/claim/consume nem usar o status `_mcc`; o status
  `_mcc` não escreve e não revela winner sob identidade/hash parcial,
  e somente a sequência required→proof_pending→compensated fecha incidente.
- rotate/revoke concorre com ingest: revision snapshot escolhida pós-lock decide;
  revision revogada nunca aceita novo ingress e ingress committed permanece
  verificável/consumível sem reabrir HMAC.

### SQL direto e ACL

- tentar fabricar/omitir cada vértice e tornar imediatas por nome todas as
  constraints estruturais; a constraint temporal é testada por COMMIT real do
  cliente, sem atribuir esse COMMIT à função;
- runtime só put-profile/reserve/status por application/status por identidade de
  reserve, sendo put condicionado à assertion
  admin `_mpi`; runtime nunca recebe remediation;
  `_mf` só claim/report/probe até T2-06 e então apply por assinatura exata;
- matriz positiva e cross-denial cobre individualmente runtime, `_mf`, `_ms`,
  `_mpi`, `_mpa`, `_mpf`, `_mh`, `_mr`, `_mri`, `_mcc`, `_mcm`, `_mck`, `_mcko`, migrator, `_mw`, `_mc`, `_mb`,
  `_si`, rogue e PUBLIC; cada role nova possui somente sua assinatura nominal;
- todas as roles operacionais sem SELECT/DML/sequences;
- ownership, `prosecdef`, `proconfig=['search_path=pg_catalog']`, temp shadowing e
  allowlist de assinaturas exata;
- reconcile executado duas vezes sem ampliar grants.
- verificar `session_user` em cada capability sob conexão real; provar
  `current_user=migrator` nas assinaturas gerais e
  `current_user=<database>_mcko` somente em rotate/revoke/ingest/status de ingest
  e lookup HMAC interno, sem usar owner para autorização/auditoria;
- runtime não possui DML nas tabelas T2 apesar do grant genérico anterior do
  reconcile; `_mf`, `_ms`, `_mpi`, `_mpa`, `_mpf`, `_mr`, `_mri`, `_mcc`,
  `_mcm` e `_mck` não possuem SELECT/DML/sequences.

### Rollback e privacidade

- todos os failpoints acima e serialization retry;
- varredura DLP por classe: A ausente de todo objeto; B ausente salvo envelope
  fiscal opaco; C presente apenas nos campos de exibição allowlisted e provada
  irrelevante para autoridade/joins; D limitada aos IDs/hashes/codes previstos;
  erros permanecem allowlisted e sanitizados;
- fiscal required contém somente locator opaco, cipher/hash e metadados
  allowlisted; nenhum plaintext, chave ou token de resolução aparece no banco;
- forçar cada unique/FK/CHECK esperada e provar SQLSTATE/mensagem sanitizados,
  sem constraint, detail, hint, valor ou identidade do winner.

## 13. Código e contratos reaproveitáveis

| Fonte atual                                                                             | O que reaproveitar                                                       | Limite para T2                                                              |
| --------------------------------------------------------------------------------------- | ------------------------------------------------------------------------ | --------------------------------------------------------------------------- |
| `app/api/erp/pdv/route.ts` — `commitSale`                                               | ordem funcional, sale/items, kits, stock, value, fiscal, audit e webhook | oracle de comportamento; não chamar de `_mf` nem dividir em commits         |
| `lib/erp/pos-payment-plan.ts` — `exactPosPaymentPlanForCommit`, `consumePosPaymentPlan` | contexto, multiset, state/version e consume operation                    | portar validação/hashing para SQL; ramo manual legado não serve             |
| migration `20260829310000_pos_authoritative_payment_plan`                               | guards de sale/plan/item/payment e multiset                              | substituir somente ramo manual e ampliar grafo T2                           |
| `lib/erp/pos-common-stock.ts`                                                           | CAS de balances e movimento+ledger                                       | precisa consumo de reserva própria e micros                                 |
| `lib/erp/pos-inventory-operations.ts` e `pos-inventory-tracking.ts`                     | parse bounded, FEFO, série e lot movement em micros                      | materializar algoritmo SQL/snapshot; TypeScript não é prova de commit       |
| `lib/erp/pos-kits.ts`                                                                   | expansão sem ciclo, BOM version e snapshot hash                          | congelar componentes em T2a e provar multiset em T2b                        |
| `lib/erp/pos-value-sale.ts`                                                             | accrual idempotente por sale                                             | T2 usa apenas accrual previsto; pagamentos por value ficam fora             |
| `lib/erp/pos-fiscal-persistence.ts` — `queuePosFiscalIssuanceForSale`                   | snapshot, profile, document/attempt/event/outbox e idempotência          | portar producer para função SQL interna; dispositions implícitas não servem |
| `lib/erp/pos-accounting-subledger.ts`                                                   | snapshot, policy hash, double entry, origin uniqueness e export outbox   | hoje abre transação própria; criar producer SQL same-tx                     |
| `lib/integrations/webhooks.ts` — `enqueueWebhook`                                       | delivery durável e payload redigido                                      | endpoint/payload precisam estar no manifesto T2a                            |
| migration `20260829320000` e `20260829321100`                                           | case ledger, operation/event, observation e estados                      | application guard/commit atuais são insuficientes e lock order deve mudar   |

Testes-base a estender: `pos-payment-plan-postgres`,
`pos-manual-payment-reconciliation-postgres`, service-PG manual,
`pos-stock-concurrency`, `pos-kits-postgres`, `pos-inventory-operations`,
`pos-fiscal-persistence-postgres`, `pos-accounting-subledger-postgres`,
`pos-value-sale`, `tenant-database-role-postgres` e contratos de deploy/ACL.

## 14. Sequência de implementação e gate

Cada onda é uma unidade versionada de migration/schema/teste/deploy. O gate
global fica hard-off em todas elas. Falha no gate de saída de uma onda impede a
seguinte; não se usa bypass permanente nem fixture para produzir autoridade em
runtime/deploy.

### T2-00 — fundação inerte

Escopo:

- preflight zero-row da application legada;
- profile, snapshots, manifest/effects e application columns corrigidas;
- `claim_token_hash`, planned sale identity, payment case nullable condicional;
- canonical JSON/hash/DLP e append-only dos objetos novos;
- FKs/checks/indexes criados sem capability de reserve/apply e sem profile
  ativa.

Gate de saída:

- fresh migrate/seed e migrate sobre fixture comprovadamente vazia;
- migration aborta atomicamente com uma application fabricada;
- Prisma validate/generate, catálogo de FK/CHECK/index e DLP verdes;
- runtime, `_mh`, roles manuais, PUBLIC e rogue sem DML/SELECT/EXECUTE T2;
- `gate.enabled=false` e nenhum plan manual novo autorizável.

Este é o menor primeiro corte fail-closed. Não expor reserve antes de expiry e
release causal existirem.

### T2-01 — lifecycle do profile e locks

Escopo:

- `put/activate/retire` do §5.0 e ledgers de profile;
- tabelas/emissores one-shot `_mpi/_mpa/_mpf`, grants separados e consumo
  atômico das assertions do §4.1;
- vínculo profile/version/hash no reconciliation gate, ainda hard-off;
- helper canônico e substituição de todos os guards inversores;
- três validadores históricos preparados para reconhecer T2, mas o ramo só
  aceita grafo completo inexistente e portanto continua fechado.

Gate de saída:

- profile draft/activate/retire com replay/conflito, assertions one-shot,
  cross-denials e aprovações distintas;
- corridas close/handoff/revoke/expire/plan/profile sem deadlock recorrente;
- prova negativa de que profile ativa não liga gate nem cria application;
- red-team de locks e catálogo sem P0/P1.

### T2-02 — T2a, reservas e release

Escopo:

- stock/promotion reservations e ledgers causais;
- integração das reservations live na disponibilidade e nos limites dos fluxos
  normais;
- reserve/status, prealocação da sale, snapshot/manifest e temporal guard;
- role/executor `_ms` e capability de sweep do §5.2, inclusive backlog vazio;
- sweep de expiry que libera todos os recursos e bloqueia causalmente.

Gate de saída:

- 20 reserves iguais produzem uma application e uma reserva por efeito;
- last stock/lot/serial/coupon, round-trip micros e replay não aplicável verdes;
- expiry antes de claim libera tudo, não cria sale/payment e não prende session;
- timer `_ms` ativo, lease/TTL limites e replay de sweep provados;
- somente agora runtime recebe EXECUTE reserve/status, mantendo zero DML nas
  tabelas.

### T2-03 — role `_mf`, claim e failure report

Escopo:

- role/credential/process/unit/cutover e quarantine nominal;
- claim batches/receipts, token derivado/hash-only, lease/fencing/fairness;
- probe/report e reclaim; `_mf` ainda não recebe EXECUTE de apply.

Gate de saída:

- autenticação real `_mf`, atributos/memberships/owners seguros e cross-denials;
- replay live devolve o mesmo token sem token persistido; replay expirado não
  reemite;
- dois finalizers/sessions progridem, stale fencing falha sanitizado;
- reconcile duas vezes não amplia grants; todos os diretórios/units isolados.

### T2-04 — core comercial mínimo revert-only

Escopo:

- sale/items/payment/plan/draft/application/case no mesmo T2b;
- planned sale ID/number/instant e vínculos bidirecionais;
- substituição efetiva dos três validadores históricos;
- structural constraints nomeadas, temporal constraint preservada ao commit;
- failpoints até `after_draft` e relock pós-subtransação.
- core interno sem grant permanece obrigatoriamente revert-only: failpoint
  terminal não removível nesta onda ou erro `0A000 T2 producers incomplete`;
  wrapper público de apply ainda não existe.

Gate de saída:

- toda tentativa termina em rollback com zero efeito, inclusive caminho sem
  failpoint solicitado; nenhum teste tenta inspecionar estado após exception.
  Producers são testados isoladamente em savepoints que o próprio teste
  controla e sempre reverte, enquanto o verifier interno atesta composição
  antes do raise terminal;
- retorno SQL seguido de rollback/desconexão e falha no COMMIT não produzem
  applied nem blocked;
- ramos cash/value/intent legados mantêm regressão verde e manual reference
  selada nunca financia sale T2.

### T2-05 — estoque, promoção, kit, tracking e value

Escopo:

- micros autoritativos/dual-write completo;
- consumo da própria reserva, movements/warehouse ledger, lote/série/FEFO;
- kit multiset, promoção/cupom consume/release;
- value account/ledger/accrual manifestados separadamente.
- core continua revert-only e sem grant operacional durante toda a onda.

Gate de saída:

- item/variation/service/kit multinível/lot/serial/FEFO completos;
- todos os writers normais consideram reservation T2 e mantêm micros;
- concorrência de último saldo/lote/série/cupom sem negativo ou double spend;
- effect multiset físico/comercial exato e todos os failpoints da onda verdes.
- nenhuma chamada operacional consegue comprometer grafo parcial ou completo.

### T2-06 — fiscal, accounting e webhooks

Escopo:

- producers SQL internos same-tx para fiscal e accounting;
- envelope fiscal cifrado/locator e adapter isolado;
- endpoint version/hash, delivery durable sem cascade e payload redigido;
- application/creation txid em todos os vértices e effect multiset integral.
- somente após todos os producers e validators verdes, remover o guard
  revert-only, criar o wrapper público apply e conceder sua assinatura a `_mf`.

Gate de saída:

- fiscal required/not_applicable, accounting balanced e webhook endpoint drift;
- ausência de plaintext PII/PAN/token/referência aberta em toda a varredura;
- journal/postings/outboxes/document/attempt/event/delivery no mesmo apply txid;
- endpoint deletion/edit/pause não apaga prova nem permite aplicação divergente;
- failpoints até `before_case_apply` verdes.
- 20 applies autocommit iguais produzem exatamente uma sale/payment e um efeito
  por entry; ACK, probe pós-corte de transporte e falha real de COMMIT verdes;
- antes deste gate, nenhuma onda permite commit de apply completo.

### T2-07 — hardening, freeze e homologação local

Escopo:

- matriz PostgreSQL integral, SQL direto negativo e tempestades concorrentes;
- normalização de erros, caller `session_user`, ACL/deploy e fresh DB;
- resolução/compensação de blocked, assertion one-shot e trilha causal;
- roles isoladas `_mr/_mri/_mcc/_mcm/_mck`, credentials/quarantine/reconcile,
  keyring owner `_mcko` e aggregate
  `pos_manual_application_compensations` com proof ingress segregado;
- segundo red-team independente, manifest de catálogo e freeze de checksums;
- PRD/traceability/readiness/runbooks atualizados sem alegar produção.

Gate de saída:

- duas auditorias independentes com zero P0/P1;
- migrate/seed, Prisma, TSC, lint, unit, build, focal PG e regressão POS verdes;
- checksums de migrations/reconcile/test fixtures sincronizados;
- `compensation_required` mantém case/incidente abertos; callback/proof
  segregado é o único caminho para compensated, com SoD e replay verdes;
- inbox `_mcc` unmatched/matched/rejected/expired, timer `_mcm`,
  callback-before-claim, TTL/incidente e cross-denials verdes com gate off;
- readiness declara T2 local completa e `productionReady=false` enquanto houver
  qualquer blocker externo.

Mesmo com T2 verde, o gate permanece off até 321f, boundary HTTP/HMAC
transitivo, reprocessamento geral de ingress pendentes, adapters reais, profile fiscal/accounting,
laboratório e runbooks de incidente/cutover passarem juntos. Nenhuma migration
T2 deve alterar automaticamente `gate.enabled` ou permitir criação pública de
`proofKind=manual`.

O cutover futuro da guarda manual do plano é uma decisão separada, fora de
T2-00..T2-07: exige aprovação explícita, reconcile já congelado, adapters reais,
vault/KMS/mTLS, fiscal/PSP/TEF/SmartPOS/SEFAZ homologados e laboratório físico.
Até lá, somente `withEphemeralManualGate` pode desabilitar temporariamente a
hard-guard: banco efêmero verificado, migrator, restauração em `finally` e
HARD-OFF confirmado por conexão nova.
