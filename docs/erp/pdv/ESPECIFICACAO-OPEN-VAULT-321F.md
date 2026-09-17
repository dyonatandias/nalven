# Especificação executável 321f — abertura manual e boundary do vault

Status: **IMPLEMENTADO E VALIDADO LOCALMENTE / HOMOLOGAÇÃO EXTERNA PENDENTE / HARD-OFF**. A migration `20260829321200_pos_manual_open_vault_capabilities`, o schema Prisma, as capabilities SQL e a role segregada `_mb` implementam este contrato local. O checksum congelado da migration é `ec7b4f84b9321a93a204d6b15b0c727169e3752d0e5a580f1b4dcb730adfc281`. Isso não autoriza habilitar o gate, não substitui o boundary/vault reais nem permite que referência aberta ou token resgatável atravessem o runtime Next, Prisma ou o PostgreSQL tenant.

## Decisão de arquitetura

O fluxo é bifásico. O runtime prepara uma solicitação sem referência aberta; browser ou agente envia o ticket e os bytes da referência diretamente a um Vault Binder isolado. O binder adquire lease no banco antes de tocar o vault, usa idempotência estável no vault e finaliza no banco com uma prova não bearer. O runtime consulta apenas status sanitizado.

É obrigatória uma role dedicada `${database}_mb`, denominada manual vault binder. Ela deve ser `LOGIN`, `NOINHERIT`, `NOSUPERUSER`, `NOCREATEDB`, `NOCREATEROLE`, `NOREPLICATION` e `NOBYPASSRLS`, com credencial e identidade de processo distintas. Ela não pode ser membro de runtime, worker, callback, issuer, homologator ou migrator, nem receber memberships dessas roles.

O identificador local da prova não é token do vault e não pode resolver o segredo sem o boundary autenticado. O token real permanece exclusivamente no vault. Novos fluxos não podem usar a função TypeScript legada que recebe `rawReference` e devolve `vaultReference`; essa função permanece inacessível enquanto o gate estiver desligado e deve ser deprecada quando as capabilities 321f forem integradas.

## Modelo persistente

### `pos_manual_open_requests`

A tabela contém somente contexto comercial congelado e coordenação do protocolo:

- `id uuid primary key default gen_random_uuid()`;
- snapshots obrigatórios `branch_id`, `register_id`, `session_id`, `operator_profile_id`, `terminal_id`, `sale_draft_id`, `draft_revision`, `draft_request_hash`, `quote_hash`, `order_claim_id`, `payment_plan_id`, `payment_index`, `method`, `amount_cents`, `currency`, `installments`, `provider`, `connector_id`, `connector_revision`, `credential_ref`, `credential_revision`, `vault_adapter_id`, `provider_adapter_version` e `gate_config_hash`;
- autoria e intenção: `occurred_at`, `reason_code`, `maker_profile_id`, `maker_user_id`, `intent_hash` e `idempotency_key`;
- ticket: `ticket_hash` único, `ticket_expires_at` e `ticket_consumed_at`; somente o hash SHA-256 fica no banco;
- coordenação do vault: `vault_idempotency_key` único, derivado pelo banco do database/tenant e UUID da request;
- estado `prepared|binding|finalized|rejected|expired`;
- lease: `lease_token_hash` único e anulável, `lease_expires_at` e `fencing_token bigint not null default 0`;
- resultado: `case_id` e `vault_proof_id`, ambos únicos e anuláveis, mais `terminal_code` de allowlist;
- auditoria: `lifecycle_txid numeric(20,0)`, `prepared_at`, `binding_at`, `finalized_at`, `abandoned_at`, `created_at` e `updated_at`, todos autoritativos do banco.

Checks mínimos:

- índices e valores monetários seguem o recorte single-slot: `payment_index = 0`, `amount_cents > 0`, `currency = 'BRL'`, `installments between 1 and 24`;
- hashes de request, draft, quote, gate, intent, ticket e lease obedecem aos formatos definidos; revisões e fencing não são negativos;
- `prepared` possui ticket vigente, nenhum lease e nenhum resultado;
- `binding` possui ticket consumido, lease/hash e fencing positivo, sem case/proof;
- `finalized` possui case, proof, `finalized_at` e nenhum lease ativo;
- `rejected|expired` possuem terminalização e nenhum case/proof;
- case e proof aparecem juntos; estados não finalizados não podem apontá-los.

Unicidades: `(branch_id, maker_user_id, idempotency_key)`, `ticket_hash`, `vault_idempotency_key`, `lease_token_hash`, `case_id` e `vault_proof_id`. FKs devem espelhar o aggregate: slot composto, sessão/caixa, terminal/caixa, connector/contexto, credential, draft, claim opcional, case e proof com `ON DELETE RESTRICT`. Índices operacionais: `(state, lease_expires_at)`, `(session_id, state)` e `(payment_plan_id, payment_index)`.

### `pos_manual_vault_proofs`

Ledger append-only da resposta autenticada do binder:

- `id uuid primary key default gen_random_uuid()`, identificador local opaco e não bearer;
- `open_request_id uuid unique not null` e `case_id uuid unique not null`;
- `vault_adapter_id`, `provider` e `external_proof_id unique`; este último é attestation não resgatável, nunca token;
- `stable_reference_index unique` no formato `vault-blind:vN:<hex64>`;
- `reference_hash` no formato `hmac-sha256:vN:<hex64>`, `reference_key_id` e `reference_last_four` seguro;
- `vault_key_id`, `binding_hash unique`, `proof_hash`, `signature_hash`, `issued_at`, `retention_expires_at`, `verifier_version`, `write_txid` e `created_at`.

Proofs não admitem `UPDATE` ou `DELETE`. FKs para request e case usam `RESTRICT`.

### Compatibilidade do binding existente

Adicionar `vault_proof_id uuid unique not null` a `pos_manual_payment_vault_bindings`, com FK para a prova. Para novas linhas, o campo legado `vault_reference` guarda apenas `vault-proof:<proof_uuid>`, um locator não bearer; nunca recebe token externo. `vault_provider`, `vault_key_id`, `binding_hash`, blind index e retenção devem ser idênticos aos snapshots da prova.

O schema Prisma recebe modelos e relações para request/proof e `vaultProofId`. Procedures são chamadas exclusivamente por `$queryRaw` parametrizado; runtime e binder não usam Prisma DML nessas tabelas. Timestamps autoritativos não podem depender de `@updatedAt` do cliente.

## Máquina de estados e fencing

Transições permitidas:

```text
prepared ──claim──> binding ──finalize──> finalized
   │                   ├────abandon────> rejected
   └────expiry────────> expired
                       └────expiry─────> expired
```

`binding → binding` só é permitido para retomada de lease expirado, preservando `vault_idempotency_key` e incrementando estritamente o fencing. Ticket é one-shot. Finalize e abandon exigem o hash do claim token, fencing exato e lease vigente. Um binder atrasado nunca pode vencer um binder com fence maior.

Replay de prepare exige o mesmo `intent_hash` e os mesmos snapshots. Antes do consumo, pode rotacionar atomicamente o ticket para não depender de recuperar segredo antigo. Replay de claim com a mesma idempotência e lease vigente devolve o mesmo resultado; outro binder recebe conflito opaco. Replay de finalize exige request, fence, idempotência e `proof_hash` idênticos. Colisões de blind index são sempre opacas e não revelam o caso vencedor.

## Assinaturas das capabilities

Todas usam `SECURITY DEFINER`, owner migrator/NOLOGIN, objetos totalmente qualificados e `SET search_path = pg_catalog`. `PUBLIC` perde `EXECUTE`.

```sql
public.pos_manual_prepare_open_v1(
  text, integer, integer, text, timestamptz, text, text, text
) returns jsonb
```

Parâmetros: payment plan, payment index, maker profile/user, occurred-at, reason, idempotency e intent hash. Retorna somente `requestId`, ticket, expiração e estado. O ticket tem 32 bytes aleatórios e só seu digest é persistido.

```sql
public.pos_manual_claim_open_for_vault_v1(
  uuid, text, text, text, integer
) returns jsonb
```

Parâmetros: request, ticket, binder ID, idempotência do claim e segundos de lease. Retorna request, claim token, fencing, expiração, idempotência do vault, provider, adapter e retenção solicitada. Não retorna referência, blind index ou token.

```sql
public.pos_manual_open_case_v1(
  uuid, text, bigint, text,
  text, text, text, text, text, text, text, text, text,
  timestamptz, timestamptz, text
) returns jsonb
```

Parâmetros: request, claim token, fencing, idempotência de finalize; external proof ID, blind index, reference hash/key/last-four, vault key, binding/proof/signature hashes, emissão, retenção e versão do verifier. Cria prova, case, binding, operação open, evento e finaliza a request numa transação. Retorna apenas case, estado, versão e replay.

```sql
public.pos_manual_open_status_v1(uuid, integer, text, text) returns jsonb
```

Parâmetros: request, maker profile/user e idempotência. Retorna DTO sanitizado com estado, case ID, código terminal e tempos. Nunca retorna ticket, lease, proof ou hashes.

```sql
public.pos_manual_abandon_open_v1(uuid, text, bigint, text, text) returns jsonb
```

Parâmetros: request, claim token, fencing, idempotência e motivo. Só terminaliza se não existir case, proof ou binding. Retorna estado, idempotência do vault e `safeToCompensate=true`.

```sql
public.pos_manual_probe_open_v1(uuid, text) returns jsonb
```

Parâmetros: request e idempotência do vault. Sob lock no primário, retorna estado, case ID, aceitação de proof/binding, fencing e `safeToCompensate`. Prepared, binding ou resultado ambíguo sempre retornam `safeToCompensate=false`.

## Ordem de locks e revalidação

Advisory locks de idempotência/request usam namespace e ordem comuns nas seis funções. A localização inicial usa apenas identidades imutáveis. A ordem de rows é:

1. sessão;
2. terminal;
3. perfis, ordenados;
4. branch e register;
5. grants de branch/register, ordenados;
6. claim opcional;
7. draft;
8. payment plan e slot;
9. connector, credential, provider e gate;
10. open request `FOR UPDATE`;
11. case, proof e binding.

Nenhuma função pode travar request e depois o grafo operacional. Depois de qualquer espera, captura novo `clock_timestamp()` e relê/revalida sessão aberta, terminal vivo e não revogado, profile↔user, grants e validade, claim/lease, draft revision/hash/status, plan/quote/slot, connector/credential revisions, gate/adapter/config e todos os TTLs.

`case_expires_at = least(plan.expires_at, clock_timestamp() + interval '15 minutes')`. A retenção deve ser maior que o case e no máximo `plan.expires_at + interval '60 seconds'`.

## Constraints diferidas

Constraint triggers diferidos em request, proof, case, binding, operation e event validam no commit:

- request finalizada, proof, binding, case, operação open e evento existem exatamente uma vez;
- todos compartilham o mesmo `write_txid/lifecycle_txid`;
- snapshots da request são byte-a-byte iguais aos do case;
- request/proof/case e binding/proof/case são recíprocos;
- snapshots criptográficos e retenção do binding são iguais aos da proof;
- operação open usa expected version `-1`, resulting version `0`, estado `review_pending` e possui exatamente um evento correspondente;
- request rejeitada/expirada não possui qualquer metade do grafo.

Guards imediatos protegem a máquina de estados, ticket one-shot, lease e fencing monotônicos, snapshots imutáveis e append-only da prova. O guard atual de abertura do case deve passar a exigir a request finalizada e sua proof, preservando a exigência de binding e ledger no mesmo tx.

## ACL e deploy

O runtime recebe apenas prepare e status. `_mb` recebe apenas claim, finalize, abandon e probe. `_mw`, `_mc`, `_si`, `_mh`, roles rogue e `PUBLIC` não recebem nenhuma capability 321f. Nenhuma dessas roles recebe acesso a tabelas, sequences ou DML.

Provision, bootstrap, release, systemd e os scripts `reconcile-tenant-runtime-grants.sql/.sh` devem receber a nova role/credencial. Readiness deve provar por assinatura:

- `prosecdef=true`, owner correto e `proconfig` seguro;
- grants positivos exatos e grants cruzados negativos;
- ausência de privilégios em tabelas/sequences;
- ausência de memberships e reuse de credencial;
- default privileges e `PUBLIC` revogados;
- resistência a temp-schema/search-path shadowing.

## Crash, probe e compensação

Antes de mutar o vault, o binder grava journal/outbox durável no próprio domínio do vault usando `vault_idempotency_key`. Timeout após bind ou commit ambíguo nunca autoriza release por suposição. O binder repete finalize e consulta probe no banco primário.

Somente abandon ou probe terminal com `safeToCompensate=true` autoriza compensação. Se case, proof ou binding existirem, o token é preservado. Crash após commit converge por replay; crash após bind converge pelo journal/refcount do vault. Retry de compensação diferida também pertence ao vault, não ao runtime tenant.

## Matriz de testes bloqueante

- banco fresco com todas migrations e seed; Prisma validate/generate e TSC focal;
- happy path comprovando request/proof/binding/case/op/event no mesmo txid;
- busca de sentinel raw em todo `text`, `json/jsonb`, `bytea`, audit e logs do tenant;
- 20 prepare/claim/finalize concorrentes produzindo um único grafo;
- conflitos de idempotência e colisão de blind index com erro opaco;
- replay/expiração de ticket, reclaim de lease e stale fencing em finalize/abandon;
- finalize versus abandon/probe e commit ambíguo;
- expiração sob contenção em cada lock canônico;
- corridas com close, handoff, revoke, grants, draft, plan, claim, connector, credential e gate;
- negativos para proof, adapter, key, assinatura, retenção, timestamps, PAN e formatos;
- falha de commit para cada metade ausente ou divergente do grafo diferido;
- ACL real para runtime, binder, worker, callback, issuer, homologator, rogue e PUBLIC;
- default privileges, owner/membership, search-path e temp shadowing;
- prova de que o fluxo TypeScript legado não invoca as novas functions;
- worker recebe proof ID, nunca token;
- testes externos de proxy/log/APM, refcount, orphan release, retry diferido e rotação de chave.

## Blockers externos e decisão hard-off

Não é possível declarar a 321f pronta para produção sem:

- processo binder isolado, preferencialmente Go/Rust/bytes, com mTLS, identidade de SO e segredo exclusivos;
- canal direto browser/agente→binder, CSP/egress allowlist e body/APM/access logs desabilitados;
- vault/KMS real com idempotency journal, probe, refcount, compensação de órfão e rotação;
- HMAC e blind index domain-separated por tenant/provider, com key IDs auditáveis;
- trust roots e verifier para provar que `external_proof_id` não é bearer/resgatável;
- homologação de que referência aberta nunca atravessa Next, Prisma, PostgreSQL, logs ou telemetria.

A migration e as procedures podem ser desenvolvidas e validadas localmente com simulador. Isso não remove os blockers. O trigger de hard-disable permanece habilitado, nenhuma configuração de produção ativa criação/dispatch/aplicação e `productionReady` continua falso até toda a matriz e os gates externos serem aprovados.

## Baseline local congelada

- migration 321f: `ec7b4f84b9321a93a204d6b15b0c727169e3752d0e5a580f1b4dcb730adfc281`;
- teste PostgreSQL 321f: `7a05b951e085310ee03bef9112be7a9caf57cee1b1315c1f79e31af8b373f2c0`;
- reconcile de roles: `4d72411bf75e2eec59d5ab40616f9f820e1f2ec33f73d18e82626bb926de3148`;
- teste PostgreSQL de role: `01d26d3d2c894ca2f6c0c2c21cba5a8137eb4d8f4ee99d8841db3f3a47d244f7`.

Essa baseline passou em banco fresco, `3/3` testes 321f, `1/1` teste de role,
`17/17` contratos de deploy, TypeScript e lint. Ondas posteriores devem atualizar
seus próprios manifests sem editar a migration 321f congelada.
