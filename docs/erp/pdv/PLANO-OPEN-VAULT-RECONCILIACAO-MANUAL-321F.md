# Plano 321f — abertura manual e boundary do vault

Status: **IMPLEMENTADO LOCALMENTE / P0 EXTERNO PARA ENABLEMENT / HARD-OFF**. A
migration, o grafo SQL, fencing, replay, constraints diferidas, testes
PostgreSQL e segregação da role `_mb` estão implementados. A referência aberta
continua proibida no Next runtime, Prisma e PostgreSQL tenant; boundary, mTLS,
vault/KMS e binder de produção ainda não existem/homologaram, e o token real não
pode ficar legível no tenant nem ser devolvido pelo claim do worker.

## Fluxo de capabilities

1. Runtime chama `pos_manual_prepare_open_v1` sem referência aberta. O banco
   cria um open request inerte e devolve ticket curto para o binder.
2. Browser/agente envia ticket + referência diretamente ao processo Vault
   Binder isolado, com body/APM/access logs desabilitados.
3. Antes de tocar o vault, o binder chama
   `pos_manual_claim_open_for_vault_v1`. A capability consome ticket one-shot,
   revalida request/gate/plan, cria lease/fencing e move `prepared → binding`.
4. Binder usa `tenant:open_request_id` como idempotência no vault e recebe proof
   não bearer.
5. Binder chama `pos_manual_open_case_v1` com open request, proof e fencing. O
   banco revalida todo o aggregate pós-lock e cria proof/binding, case, open
   operation/event e request finalized no mesmo txid.
6. Runtime consulta apenas `pos_manual_open_status_v1`, com DTO sanitizado.

Lease expirado pode ser retomado somente com a mesma vault idempotency. Finalize
e abandon exigem fencing vigente. Isso impede dois binders e evita criar binding
externo para request já inválido.

## Modelo persistente

`pos_manual_open_requests` contém somente contexto comercial, intent hash,
revisões congeladas, estados `prepared|binding|finalized|rejected|expired`,
lease/fencing, case final e tempos do banco. Nenhum hash da referência fica no
request.

`pos_manual_vault_proofs` é append-only e contém proof id, request/case,
adapter/provider, blind index e HMACs versionados, key ids, últimos quatro,
binding hash, emissão, retenção e txid. O proof id não é token resgatável. O
token real permanece no vault; o worker resolve proof→token por boundary
isolado.

Constraints diferidas exigem request finalized + proof/binding + case + open
operation/event no mesmo contexto e txid. Qualquer metade falha no commit.

## Validação prepare/finalize

Locks: sessão, terminal, perfis/acessos, claim, draft, plano/slot,
connector/credential/gate, request e case/proof. Após qualquer espera, o banco
recaptura relógio e revalida sessão/terminal, perfil↔user, grants, claim, draft,
plan/quote/slot, connector/credential revisions, gate/adapter e TTL.

O recorte inicial continua single slot manual índice 0 e total integral.
`case_expires_at = least(plan.expires_at, db_clock + 15 minutes)`. Blind index e
reference hash são HMACs domain-separated e tenant/provider scoped. Retenção
deve superar o case e respeitar limite do plano. Duplicidade por blind index
retorna erro opaco, sem revelar o caso vencedor.

## ACL e processo

- runtime: somente prepare/status; sem finalize, vault ou DML;
- binder: somente claim/finalize/abandon/probe; sem prepare/status/tabelas;
- worker/callback/issuer: nenhuma capability de abertura;
- `PUBLIC`: nada; owners sem login e sem memberships cruzados.

Todas as functions usam `SECURITY DEFINER`, owner migrator, objetos qualificados,
`search_path=pg_catalog` e grants nominais por assinatura.

O binder recebe ticket one-shot com audience/tenant/request nonce e canal mTLS,
sem cookies gerais. Em JavaScript a string não é zerável; preferir processo em
Go/Rust/bytes para o boundary. CSP e proxy devem allowlistar apenas esse destino.

## Crash e compensação

O binder mantém journal/outbox durável no próprio vault antes de mutar. Em
timeout/commit ambíguo, repete finalize e usa probe no primário; nunca libera por
suposição. Só compensa após `pos_manual_abandon_open_v1` provar terminalmente que
não há case/proof/binding. Crash após commit converge por replay e crash após
bind converge pelo journal/refcount do vault.

## Testes bloqueantes

- happy path com todo o grafo no mesmo txid e sentinel raw ausente do tenant;
- ACL por role, PUBLIC/rogue/default privileges/search-path/temp shadowing;
- 20 prepare/finalize iguais resultando em um request/case/proof/grafo;
- dois idems na mesma blind index resultando em um caso e erro opaco;
- corridas com expiry/consume/revision/claim/close/handoff/revoke/grant/gate;
- failpoints antes/depois de journal, bind, envio, inserts e commit ambíguo;
- negativos deferred para cada metade ausente/divergente;
- proof/adapter/key/retention/tempo/PAN malformados e zero vazamento;
- proxy provando que raw não chega ao Next/log/APM e nenhum token sai do binder;
- refcount, orphan release, deferred retry e rotação de chave no vault.

O gate continua hard-disabled até existirem binder real, journal/probe/abandon,
worker sem token no tenant e toda a matriz acima em homologação.
