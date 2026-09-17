# Decisões executáveis — T2-01 lifecycle de profile e locks

Este addendum fecha as ambiguidades identificadas depois do freeze da
especificação T2a/T2b. Ele não altera o checksum da especificação congelada e
não habilita `reserve`, `apply`, gate ou `proofKind=manual`.

## Assertion one-shot

- a issuer gera 32 bytes aleatórios e retorna uma única vez o handle em 64 hex;
- apesar do nome histórico `p_*_assertion_hash`, o parâmetro consumer recebe
  esse handle secreto; a tabela persiste somente `sha256(handle)`;
- o handle nunca entra em log, audit, erro, request hash ou DTO posterior;
- a authority é `sha256(domain || NUL || current_database || NUL ||
  session_user)` e a autorização compara `session_user` com a role nominal;
- TTL é fixo em 120 segundos, definido pelo banco; relógio é recapturado depois
  dos locks e antes do consumo;
- replay de emissão idêntica não devolve novamente o handle. Ele retorna apenas
  `alreadyIssued=true`, metadados não sensíveis e exige que o caller preserve o
  resultado da primeira chamada. Lost response resulta em nova idempotency key
  e nova assertion; a anterior expira sem poder ser descoberta;
- consumo exige action, aggregate, version, config/policy hashes, subject e
  request hash exatos. Rollback não queima a assertion.

## Draft e CAS

Profiles são imutáveis por `(branch_id, version)`. `put` cria o draft ou
reproduz exatamente o mesmo winner; configuração diferente na mesma versão
retorna conflito `23505`. Correção funcional cria uma versão nova. Essa decisão
elimina last-write-wins sem ampliar as assinaturas congeladas.

Para `put`, `p_expected_config_hash` da assertion é o hash canônico da
configuração desejada. O `profile_id` novo vem exclusivamente da assertion
administrativa; não entra no JSON de profile nem é escolhido pelo runtime.

## Gate e lifecycle

- `activate` vincula o profile a todos os reconciliation gates cujos connectors
  pertencem à mesma branch, em ordem por connector ID;
- a escrita preserva `enabled=false`, `enabled_by/enabled_at/config_hash` de
  habilitação nulos e não concede capability operacional;
- se existir outro profile ativo na branch, activation falha; a troca exige
  `retire` explícito seguido de `activate` da nova versão;
- `retire` mantém o triple histórico nos gates. Reserve futuro bloqueará porque
  o profile não está ativo; uma activation posterior substitui o triple;
- profile `required_queue` pode ser ativado localmente apenas contra perfil
  fiscal ativo, efetivo e de ambiente homologado. Isso não afirma que o adapter
  externo está homologado e não libera o gate;
- `not_applicable` exige reason code e fiscal policy hash homologado pela
  assertion fiscal, sem perfil fiscal fictício.

## Autoridades e identidade

`_mpi`, `_mpa` e `_mpf` autenticam serviços emissores distintos. Os subject IDs
declarados são evidência fornecida por esses boundaries e são vinculados a
request/authority hashes; a integração IAM/mTLS real permanece blocker externo.
`activate` exige homologator, aprovador contábil e aprovador fiscal pairwise
distinct. `put` e `retire` exigem issuer e executor distintos.

## Locks e retrofit

T2-01 não remove lock de trigger antes de todos os producers existentes usarem
o helper canônico. O rollout é atômico na migration: instala contexto
owner-only por transação, migra cada producer histórico, substitui os guards e
só então expõe as capabilities de profile. Qualquer producer não reconhecido,
contexto ausente, nonce inválido ou grafo T2 incompleto falha fechado.

Triggers não adquirem business roots. Capabilities prelockam o conjunto
completo na ordem da especificação e os triggers validam apenas `OLD/NEW` e o
contexto owner-only.

## Gate de saída

T2-01 só pode ser congelada com fresh/upgrade PostgreSQL, catálogo/ACL/roles,
replay e conflito, expiry/rollback, SoD, concorrência/deadlock, tamper e
cross-auditoria sem P0/P1. Ao final, applications continuam vazias e não existe
`reserve` ou `apply` executável.

## ABI operacional do retrofit

O retrofit usa três capabilities SQL tipadas. Elas retornam `void`; não
retornam `context_id`, nonce ou qualquer segredo ao processo da aplicação.

```sql
pos_manual_prepare_session_transition_v1(
  p_action text,                 -- close | suspend | resume
  p_session_id integer,
  p_expected_version integer,
  p_actor_profile_id integer,
  p_actor_user_id text,
  p_idempotency_key text,
  p_request_hash text
) returns void

pos_manual_prepare_handoff_transition_v1(
  p_action text,                 -- request | accept | cancel | expire
  p_handoff_id text,             -- gerado antes da chamada, inclusive request
  p_session_id integer,
  p_expected_session_version integer,
  p_expected_handoff_revision integer, -- 0 apenas para request
  p_target_operator_profile_id integer, -- obrigatório em request/accept; NULL em cancel/expire
  p_actor_profile_id integer,
  p_actor_user_id text,
  p_idempotency_key text,
  p_request_hash text,
  p_reason text,                 -- obrigatório apenas em request
  p_expires_at timestamptz,      -- obrigatório apenas em request
  p_held_sale_snapshot jsonb     -- obrigatório apenas em request
) returns void

pos_manual_prepare_plan_release_v1(
  p_action text,                 -- supersede | expire
  p_plan_id text,
  p_expected_version integer,
  p_actor_user_id text,
  p_idempotency_key text,
  p_request_hash text
) returns void
```

Cada função valida forma/NFC/DLP, autoridade nominal e o formato do request
hash causal já persistido pelo producer. Esse hash externo não é redefinido:
o SQL calcula adicionalmente um digest interno domain-separated contendo
`session_user`, todos os parâmetros normalizados e `p_request_hash`.
Ela adquire advisory lock para a chave de idempotência; trava e relê as roots
na ordem sessão, handoff/plano e casos manuais por `id`; em `request`, trava
também o namespace do `handoff_id` ainda inexistente. A decisão e os digests
de transição são calculados somente de valores relidos do banco e dos campos
de destino tipados pela `action`; hashes opacos de `OLD`/`NEW` nunca são
aceitos do caller.

O nonce é criado uma vez por transação e seu hash fica ancorado somente na
tabela owner-only `pos_manual_t2_transaction_nonces`, identificada por
`(backend_pid, transaction_txid)`. Nenhuma GUC é autoridade e o runtime não
recebe `SELECT`/DML na âncora. O hash é reutilizado por todos os contextos da
transação; um constraint trigger diferido exige zero contextos sobreviventes
e remove a âncora antes do commit. Cada contexto
registra capability, action, aggregate, txid, identidade nominal, digest de
`OLD` e digest de `NEW`. As projeções fechadas são:

- sessão: `(id,status,operator_profile_id,version)`;
- handoff: `(id,session_id,branch_id,register_id,from_operator_profile_id,to_operator_profile_id,state,reason,expires_at,revision,request_idempotency_key,request_hash,held_sale_snapshot,requested_by_actor_id,resolution_request_hash,resolved_by_actor_id)`;
- plano: `(id,session_id,state,version)`.

O trigger puro recomputa os dois digests dessas projeções de `OLD/NEW`
sem consultar business roots e consome exatamente uma linha com
`DELETE ... RETURNING`. Ausência, duplicidade, nonce divergente, transição
divergente ou tentativa de reutilização falha `42501`/`23514`.

Chamadas que atualizam a mesma root mais de uma vez precisam preparar um
contexto novo imediatamente antes de cada DML. `close` infere
`open -> closing, version + 1` na primeira preparação e
`closing -> closed, mesma version` na segunda. `request` cria contextos pareados,
para suspensão da sessão e INSERT do handoff; `accept`/`cancel` criam os dois
contextos exigidos pelas suas mutações e `expire` cria um. O timer de expiração
usa o ator literal homologado `system:pos-payment-maintenance` somente para o
timer de expiração de plano; handoff stale preserva o ator autenticado. O locator pode
ser lido antes da capability somente para obter IDs: a capability sempre relê
e valida id/session/revision/expiry sob locks sessão -> handoff. A rotina de
stale primeiro prepara/finaliza `expire` e somente depois prepara a nova ação.

Os ramos cash/value/intent e o
fluxo legacy permanecem inalterados; qualquer ramo T2 cujo grafo completo ainda
não exista falha fechado.

## Retrofit atômico §6: grafo completo de plano, artefatos, itens e claim

O rollout §6 é indivisível: as quatro capabilities abaixo, todos os producers
enumerados, seus grants nominais, os contextos one-shot e os onze triggers
puros entram na mesma migration. Enquanto qualquer componente estiver ausente,
os grants permanecem revogados e os ramos novos falham fechados. Nenhum
parâmetro aceita digest de `OLD`, `NEW`, linha ou lote calculado pelo caller.

```sql
pos_manual_prepare_payment_plan_graph_write_v1(
  p_action text,                 -- quote | activate | consume | supersede | expire
  p_plan_id text,
  p_expected_version integer,    -- quote: NEW plan.version exigida = 0; demais: versão corrente >=0
  p_actor_user_id text,
  p_idempotency_key text,
  p_request_hash text,
  p_target_plan jsonb,           -- objeto fechado e tipado para a action
  p_target_quote_lines jsonb,    -- array fechado; [] fora de quote
  p_target_slots jsonb           -- array fechado; [] fora de activate
) returns void

pos_manual_prepare_payment_artifact_write_v1(
  p_kind text,                   -- intent | manual_reference | sale_payment
  p_action text,                 -- literal fechado por kind, conforme matriz abaixo
  p_artifact_id text,
  p_plan_id text,                -- nullable somente para refund; raiz vem do original bloqueado
  p_expected_plan_version integer,
  p_actor_user_id text,
  p_idempotency_key text,
  p_request_hash text,
  p_target_artifact jsonb        -- objeto fechado específico de kind/action
) returns void

pos_manual_prepare_held_sale_items_write_v1(
  p_action text,                 -- insert | update | delete | replace_batch
  p_held_sale_id text,
  p_expected_revision integer,
  p_actor_user_id text,
  p_idempotency_key text,
  p_request_hash text,
  p_operational_context jsonb,  -- branch/register/session/profile/terminal/claim exatos
  p_target_items jsonb           -- array fechado; INSERT usa ordinal de transporte, não id
) returns void

pos_manual_prepare_order_claim_write_v1(
  p_action text,                 -- claim | renew | release | expire | convert
  p_claim_id text,
  p_session_id integer,
  p_sales_order_id integer,
  p_expected_version integer,
  p_actor_user_id text,
  p_idempotency_key text,
  p_request_hash text,
  p_target_claim jsonb           -- objeto fechado específico da transição
) returns void
```

Quando o request hash depende de valores derivados de raízes (por exemplo
`heldSaleItemId`, snapshot do draft ou `credentialRef`), o producer usa o
helper read-only versionado `pos_manual_t2_payment_plan_graph_request_hash_v1`
com as mesmas entradas de transporte da capability, exceto o próprio hash. O
helper reconstrói a projeção tipada e devolve hash domain-separated por banco e
`session_user`. A capability principal relê tudo sob os locks, repete a mesma
reconstrução e exige igualdade; o preview nunca abre contexto nem autoriza DML.
Somente as assinaturas exatas do helper e da capability recebem EXECUTE no
runtime durante reconcile.

Cada JSON é somente transporte, nunca fonte de autoridade ou entrada direta de
canonical/hash. Antes de qualquer lookup/lock, a capability exige chaves
literais exatas por `kind/action`, tipos JSON exatos, inteiros safe, NFC/DLP,
limites, identidades/ordinais conforme a action e nulabilidade fechada. Ela extrai os valores para scalars
PL/pgSQL tipados e descarta o documento raw. Após reler as roots sob locks,
reconstrói com `jsonb_build_object` somente a projeção allowlisted a partir dos
scalars extraídos e valores autoritativos do banco. Todo digest/canonical usa
exclusivamente essa reconstrução; jamais `p_target_*` raw.

No ABI de held items, `p_operational_context` aceita exatamente
`branchId,registerId,sessionId,operatorProfileId,terminalId,orderClaimId`.
Esses scalars permitem prelock e releitura do grafo mesmo no INSERT em que o
parent `pos_held_sales` ainda não existe. Em `replace_batch`, a capability exige
que os mesmos valores coincidam com o parent relido; em INSERT, serializa o ID
ausente por advisory e valida que o statement nested criará o parent nesse
contexto. `orderClaimId` é nullable, mas, quando informado, precisa ser a claim
ativa exata do contexto.

No ABI do grafo de planos, campos que só podem ser conhecidos após bloquear e
reler as raízes não são autoridade do transporte. Em `quote`, `planId`,
`heldSaleItemId`, índices materializados e timestamps são derivados do plano
reservado, do parent e dos held items bloqueados; em `activate`,
`credentialRef` é derivado do connector/credential bloqueado. O producer pode
enriquecer o documento interno enviado à capability, mas a capability sempre
recalcula e compara esses campos com as raízes autoritativas antes de montar a
projeção hasheada.

As actions `quote`, `activate`, `consume` e `supersede` exigem o contexto
operacional vivo completo: sessão, terminal, perfil, filial, caixa e grants.
`expire` é manutenção sistêmica e continua autorizada quando terminal, perfil
ou grant históricos já foram revogados/expiraram; ela bloqueia e relê as
identidades históricas do plano, claim, draft, filhos e evidências, autentica a
authority de manutenção e não transforma revogação posterior em impedimento
para expirar um plano vencido. Esse relaxamento vale somente para `expire` e
jamais autoriza criar prova financeira ou consumir o plano.

No checkout, o `saleId` é reservado explicitamente no PostgreSQL antes de
qualquer writer de artefato que dependa do consumo. A capability `consume`
recebe esse ID futuro, abre os roots do plano e da operation e somente então os
artefatos/pagamentos e a venda são persistidos com IDs explícitos. A transação
continua atômica: reserva de sequência abortada pode deixar apenas um gap, nunca
uma venda ou cobrança parcial. Chamar a capability depois de criar pagamentos
é proibido.

Para lotes de quote lines e slots, há um único contexto raiz
`(capability, aggregate, action, table)` com cardinalidade e hash esperado do
multiset reconstruído e ordenado. O row trigger puro não consome filhos: ele
insere uma observation owner-only contendo txid, contexto raiz, operação DML e
digest da projeção efetiva `OLD/NEW`. Isso admite IDs autoincrement gerados no
INSERT, duplicatas legítimas do multiset, vários statements e replace
delete+insert. No commit, o constraint trigger da âncora agrega observations
por `(root,table,action)`, compara cardinalidade e multiset hash esperado,
rejeita linhas extras/ausentes/table/action divergentes e, em caso exato,
remove observations e raiz antes de remover a âncora. Qualquer sobra ou segundo
uso falha `23514`; runtime não recebe SELECT/DML nas observations.

Os limites fechados são: quote lines `1..200`, slots `1..10` e held-sale items
`1..200` para todos os writers hoje inventariados. Cardinalidade zero só poderá
ser adicionada a uma action futura que homologue explicitamente esvaziar o lote;
nenhuma action atual a aceita. O limite de chaves é exato por projeção/action
(não há teto global de 32); intent aceita a quantidade integral de campos
enumerada abaixo. Strings têm 256 bytes salvo limite menor da coluna, e
documentos de transporte têm no máximo 64 KiB. As projeções exatas
reconstruídas são:

- plan `quote`: `id,branchId,registerId,sessionId,operatorProfileId,terminalId,saleDraftId,draftRevision,draftRequestHash,draftStatus,orderClaimId,quoteHash,promotionId,couponId,promotionDiscountCents,evaluatedAt,expiresAt,currency,totalCents,state,version,idempotencyKey,requestHash,lifecycleTxid,createdAt,updatedAt`; essa é a única criação de plan: `p_expected_version` e `NEW.version` são obrigatoriamente `0`, enquanto a operation quote associada usa `expectedVersion=-1,resultingVersion=0`;
- plan `activate|consume|supersede|expire`: `id,state,version,activatedAt,consumedSaleId,consumedAt,supersededAt,expiredAt,lifecycleTxid,updatedAt`; immutable identity e `createdAt` vêm da root relida e continuam comparados pelo guard;
- operation: `planId,action,expectedVersion,resultingVersion,resultingState,idempotencyKey,requestHash,actorUserId,saleId,writeTxid,createdAt`; a operação `quote` inicial usa `expectedVersion=-1,resultingVersion=0` enquanto a linha do plano é criada diretamente em `version=0`; demais usam versão corrente e `resultingVersion=expectedVersion+1`, exceto transição homologada que preserve versão explicitamente enumerada;
- quote line: `planId,lineIndex,heldSaleItemId,productId,variationId,quantityFloat8Hex,unitPriceCents,grossCents,baseDiscountCents,orderDiscountCents,promotionDiscountCents,surchargeCents,totalCents,createdAt`;
- slot: `planId,paymentIndex,method,amountCents,installments,proofKind,connectorId,credentialRef,provider,createdAt`;
- held item tem expectativas separadas por `TG_OP`: INSERT projeta `heldSaleId,productId,variationId,quantityFloat8Hex,unitPriceCents,discountCents,scanData,notes` e exclui `id`; DELETE projeta o `OLD` integral `id,heldSaleId,productId,variationId,quantityFloat8Hex,unitPriceCents,discountCents,scanData,notes`; UPDATE projeta separadamente `OLD` e `NEW`, ambos incluindo o mesmo `id`. No INSERT o transporte proíbe `id` e exige `transportOrdinal` inteiro único `0..199`, descartado antes da projeção/hash. Linhas materialmente idênticas continuam membros distintos do multiset por multiplicidade;
- intent: `id,branchId,registerId,sessionId,operatorProfileId,terminalId,connectorId,credentialRef,saleDraftId,paymentPlanId,paymentIndex,status,version,amountCents,currency,method,installments,provider,cardBrand,cardLastFour,providerSequence,providerOccurredAt,unknownSince,nextReconcileAt,expiresAt,idempotencyKey,requestHash,consumedAt,lifecycleTxid,createdAt,updatedAt,commitments`; `commitments.v0..v6` são hashes de evidência de provider (incluindo referências, IDs externos, código de autorização, evidence e failure message). Os valores brutos nunca entram em preview material, root ou observation;
- manual reference: `id,branchId,registerId,sessionId,requesterProfileId,requesterUserId,saleDraftId,paymentPlanId,quoteHash,paymentIndex,method,amountCents,installments,provider,referenceHash,referenceLastFour,occurredAt,status,approvalId,idempotencyKey,requestHash,consumedSalePaymentId,consumedAt,revokedAt,revokedBy,commitment,revokeIdempotencyKey,revokeRequestHash,createdAt,updatedAt` — `commitment` é SHA-256 de `revokeReason`; nem a referência nem o motivo bruto entram em projeção, root ou observation;
- sale payment: `id,saleId,connectorId,originalPaymentId,processingSessionId,type,method,status,amountCents,tenderedCents,changeCents,provider,cardBrand,cardLastFour,installments,idempotencyKey,paymentIntentId,compensationId,paymentPlanId,paymentIndex,valueReservationId,valueCaptureEntryId,valueAmountUnits,manualPaymentCaseId,proofCommitments,authorizedAt,capturedAt,refundedAt,createdAt,updatedAt`; `proofCommitments` contém hashes neutros de transaction/e2e/nsu/authorization e metadata canonicalizada. Nenhum desses valores brutos é material de root/observation;
- order claim para `claim|renew|release|expire|convert`: `id,salesOrderId,branchId,registerId,sessionId,operatorProfileId,terminalId,state,version,leaseExpiresAt,idempotencyKey,requestHash,convertedSaleId,claimedAt,renewedAt,releasedAt,convertedAt,lifecycleTxid,updatedAt`; operation: `claimId,action,expectedVersion,resultingVersion,resultingState,idempotencyKey,requestHash,leaseExpiresAt,writeTxid,createdAt`. `convert` exige `convertedSaleId` e `convertedAt`; as demais actions os mantêm nulos, salvo relido histórico já homologado.

`replace_batch` de held items nunca usa um único multiset final. A capability
cria dois roots literais e independentes: `held_items:delete` com expectativa
do multiset `OLD` (IDs conhecidos e incluídos) e `held_items:insert` com
expectativa material sem IDs (ordinais apenas no transporte). Observations são
agregadas e comparadas separadamente por `TG_OP`; UPDATE possui root próprio.
Commit falha se qualquer um dos roots/cardinalidades não for consumido exato.

As actions de artefato também são literais, sem o antigo `observe` genérico:

- intent: `create`, `retry`, `apply_delivery`, `apply_callback`,
  `cancel_before_dispatch`, `expire_before_dispatch`, `schedule_reconcile`,
  `force_manual_review` e `consume`;
- manual reference: `create`, `revoke` e `consume`;
- sale payment: `create_commit`, `create_intent_consumption`,
  `insert_refund_compensation`, `insert_refund_cancel`,
  `insert_refund_return` e `update_refund_status`.

Cada INSERT de claim ou sale payment gera UUID explicitamente no producer antes
da capability e persiste esse mesmo ID no DML; defaults CUID não participam do
contrato. Refunds mantêm `paymentPlanId/paymentIndex` nulos. Para eles,
`p_plan_id` é nulo e a capability resolve a raiz autoritativa somente pelo
`originalPaymentId` bloqueado, sem copiar o plano para `NEW`. Inserção do refund
e atualização do status do original recebem contextos separados.

Timestamps server-owned usados no digest (`createdAt`, `updatedAt`,
`activatedAt`, `consumedAt`, `supersededAt`, `expiredAt`, `claimedAt`,
`renewedAt`, `releasedAt`, `convertedAt`, `lifecycleTxid` e `writeTxid`) são
reconstruídos pela capability e estampados pelo guard com
`transaction_timestamp()` na precisão da coluna. O caller nunca fornece esses
instantes. Timestamps de evidência externa, como `providerOccurredAt`, continuam
scalars validados da ação específica.

Campos PostgreSQL `double precision`, hoje `quantity` em held item e quote
line, nunca entram no canonical JSON como número fracionário raw. Capability e
guard convertem o scalar relido por um helper único para
`quantityFloat8Hex = encode(float8send(quantity),'hex')`; essa string canônica
é a representação hasheada nos dois lados. O transporte ainda recebe
`quantity`, valida número finito/positivo e o descarta após a conversão.

As chaves aceitas em cada `p_target_*` são exatamente as chaves da projeção da
respectiva `kind/action`, menos campos derivados exclusivamente pelo banco
(`id` autogerado somente de held item, timestamps default e `*Txid`). Campos imutáveis já existentes
podem ser omitidos somente quando a action declara que serão relidos; nenhuma
chave adicional é ignorada.

A matriz obrigatória é:

| Trigger | Producers que devem preparar | Capability/contexto |
|---|---|---|
| `pos_held_sale_items_payment_plan_guard` | `app/api/erp/pdv/route.ts` create/update/delete de item e nested writes | `held_sale_items`, roots/observations separados por TG_OP |
| `pos_manual_payment_references_authoritative_plan_guard` | manual-payments create/revoke; consumo no checkout | `payment_artifact:manual_reference` |
| `pos_payment_intents_authoritative_plan_guard` | persistence create e transições; cancel API | `payment_artifact:intent` |
| `pos_payment_plan_operations_insert_guard` | quote/activate/consume/supersede/expire | `payment_plan_graph:operation` |
| `pos_payment_plan_operations_immutable_guard` | nenhum UPDATE/DELETE legítimo | rejeição append-only pura, sem contexto |
| `pos_payment_plan_quote_lines_immutable_guard` | quote | `payment_plan_graph:quote_lines`, root + observations |
| `pos_payment_plan_slots_immutable_guard` | activate | `payment_plan_graph:slots`, root + observations |
| `pos_payment_plans_activation_guard` | activate/consume | `payment_plan_graph:plan_transition` |
| `pos_payment_plans_immutable_guard` | quote inicial/activate/consume/supersede/expire | `payment_plan_graph:plan_transition` |
| `pos_sale_payments_authoritative_plan_guard` | persistence commit; compensation/refunds com raiz indireta no pagamento original | `payment_artifact:sale_payment` |
| `pos_order_claim_identity_guard` | claim/renew/release/expire/convert no PDV route | `order_claim` |
| `pos_order_claim_operations_write_guard` | operation de claim/renew/release/expire/convert criada junto da transição | `order_claim:operation`, root independente e observation INSERT |

Cada action de order claim abre dois roots independentes antes do DML: um para
a linha de `pos_order_claims` e outro para o INSERT append-only de
`pos_order_claim_operations`. O guard da operation apenas estampa
`writeTxid/createdAt`, projeta `NEW` e observa o root; UPDATE/DELETE continuam
rejeitados sem consultar relações de negócio. `expire` usa exclusivamente o
ator `system:pos-order-claim-expiry`, exige lease vencida e ausência de prova
financeira pendente, mas não exige que terminal, sessão ou grants históricos
continuem ativos. As demais actions exigem boundary operacional vivo.

Prelocks: advisory namespaces ordenados → sessão → terminal →
perfis/branch/register/grants ordenados → sales order → claim → held sale →
held items ordenados → connector/credential ordenados → plano →
quote lines/slots/operations → intent/manual reference/payment por identidade.
Zero-row inserts usam advisory namespace antes das raízes e são relidos após
os locks. Triggers desse catálogo não executam `FOR UPDATE`, `FOR SHARE` nem
consultas bloqueantes de business roots; recomputam apenas projeções de
`OLD/NEW`, validam caller/action/request/cardinalidade e consomem contexto via
`DELETE ... RETURNING`.

Quando há claim, `sales_orders` é sempre travada antes de `pos_order_claims` em
qualquer producer de claim, plano ou artefato. O locator anterior aos advisories
pode descobrir `salesOrderId`, mas nenhuma decisão usa esse snapshot: depois
da cadeia de locks, order e claim são relidas e seus bindings comparados.

Como `pos_payment_plans` possui dois BEFORE UPDATE relevantes, somente
`activate|consume` criam dois contextos distintos,
`plan_transition:immutable_guard` e `plan_transition:activation_guard`, ambos
ligados à mesma projeção/request e com `consumer_count=1` e
`trigger_identity` literal. `quote` cria apenas o contexto do immutable guard;
`supersede|expire` também criam apenas o immutable, porque o activation guard é
historicamente no-op nessas transições. Cada trigger consome apenas o contexto
que lhe pertence; não há dependência de ordem de criação/execução dos triggers.

Cada root/context possui allowlist literal de uma única `capability + table +
action + trigger_identity`; não existem curingas, prefix matching, aggregate
genérico ou contexto reutilizável entre actions/tabelas. O deferred validator
também rejeita observation cujo par literal não corresponda ao root.

### Addendum — referência manual selada e consume reservado

Enquanto o trigger histórico
`pos_manual_payment_references_000_legacy_sealed` e o gate 320000 estiverem
ativos, nenhuma inserção ou atualização de referência manual é habilitada. A
capability T2 e seu guard puro existem somente como fundação verificável: o
guard projeta `OLD/NEW`, carimba timestamps server-owned e consome a raiz; o
selo histórico continua sendo o primeiro trigger que aborta a transação. Um
cutover futuro só pode remover esse selo na mesma migração atômica que homologar
vault/gate e substituir também os triggers legados `draft_slot_guard` e
`immutable_guard`; removê-lo isoladamente é proibido.

`consume` recebe `consumedSalePaymentId` já reservado, abre sua root antes do
INSERT de sale/payment e serializa a identidade com
`pos-manual-payment-reference:v1:sale-payment:<id>`. A capability não consulta
nem bloqueia a linha ainda inexistente. O constraint trigger diferido
`pos_manual_payment_references_consumed_context_guard` continua sendo a prova
causal no COMMIT, depois de sale/payment/approval terem sido materializados.
Os namespaces T2 da família são, todos ordenados bytewise antes dos locks de
business roots: `pos-manual-payment-reference:v1:reference:<id>`,
`...:operation:<idempotencyKey>`, `...:slot:<planId>:<paymentIndex>` e, em
consume, `...:sale-payment:<reservedPaymentId>`, além dos namespaces já
definidos de plan/draft/claim/held sale.
