# Auditoria de roles — reconciliação manual 320000

Data: 2026-08-31  
Status: **PARTIAL / FAIL-CLOSED — fundação de roles entregue; feature gate permanece desligado**

## Resultado

Novos tenants passam a ter principals PostgreSQL distintos para HTTP, worker manual, callback manual, emissor de step-up e homologator. A matriz de grants revoga todo acesso direto a tabelas e sequences cujo nome começa por `pos_manual_payment_` (exceto o legado singular selado `pos_manual_payment_references`) e não concede nenhuma função da 320000. Isso impede que o runtime fabrique assertion, callback, delivery, observation, operation ou state event por SQL direto.

Esta é uma fundação deliberadamente não operacional. As procedures estreitas `SECURITY DEFINER` ainda não existem; por isso worker, callback, issuer e homologator conseguem conectar e usar o schema, mas não conseguem ler, escrever, chamar função de capacidade nem avançar o agregado. Não existe executor manual habilitado: os quatro principals Unix estão isolados, as credenciais não são compartilhadas e nenhum serviço recebe `EXECUTE` até as procedures completas. O executor genérico de pedidos/integrações também retorna bloqueio honesto enquanto não houver bundle JS root-owned homologado.

## Matriz obrigatória

| Capacidade/objeto | HTTP runtime | Worker | Callback | Step-up issuer | Homologator/migrator |
|---|---:|---:|---:|---:|---:|
| gate persistido | leitura sanitizada | leitura | — | — | habilitar/desabilitar |
| cases/reviews/applications | funções HTTP estreitas | leitura necessária | — | — | ALL |
| vault binding | nenhum acesso base | envelope mínimo pela função de claim | — | — | ALL |
| assertion one-shot | consumir somente dentro da função review | — | — | emitir | ALL |
| attempts/outbox/delivery | — | funções claim/complete | — | — | ALL |
| callbacks | leitura sanitizada | — | função record | — | ALL |
| observations/incidentes | leitura sanitizada | criação causal via funções | criação causal via função | — | ALL |
| operations/state events | leitura sanitizada | sem DML direto | sem DML direto | — | ALL |
| sequences 320000 | nenhum | nenhum | nenhum | nenhum | ALL |

Todas as tabelas 320000 devem ter `ALL` revogado do runtime/worker genérico. Escritas devem ocorrer somente por funções `SECURITY DEFINER` owner-owned, schema-qualified, com `SET search_path = pg_catalog, public`, `PUBLIC` revogado e `EXECUTE` concedido por capacidade.

Funções mínimas previstas:

- HTTP: `open_case`, `review_case`, `reserve_application`, `apply_application`;
- worker: `claim_outbox`, `complete_delivery`, `expire_cases`;
- callback: `record_callback`;
- issuer: `issue_step_up`;
- homologator: `set_gate`.

## Gate e revisões

O gate nasce desligado e deve congelar `connectorId`, `connectorRevision`, `credentialRef`, `credentialRevision`, adapter de vault, versão do adapter do provider, digest de configuração, ator e tempo de homologação. Runtime, worker e callback não podem alterá-lo. Mudança relevante no connector/credential exige desabilitar ou invalidar o gate antes da alteração.

Habilitar deve falhar se roles/credenciais segregadas, vault, adapter ou grants negativos não estiverem comprovados. Uma flag de ambiente ou `connector.settings` não substitui esse registro.

## Fundação entregue

- `provision-tenant.sh` cria as roles `*_runtime`, `*_mw`, `*_mc`, `*_si` e `*_mh`, todas `LOGIN`, `NOINHERIT`, `NOSUPERUSER`, `NOCREATEDB`, `NOCREATEROLE`, `NOREPLICATION` e `NOBYPASSRLS`;
- cada autoridade recebe senha própria e arquivo próprio; worker, callback, issuer e homologator têm usuários/grupos Unix exclusivos (`nalven-pos-worker`, `nalven-pos-callback`, `nalven-pos-stepup`, `nalven-pos-homologator`);
- o serviço web declara todos os diretórios privilegiados em `InaccessiblePaths` e não consegue abrir as credenciais especializadas;
- `db/tenant.ts` possui factories/cache separados por autoridade, valida host local, banco e sufixo exato da role e não faz fallback para `TENANT_DATABASE_URL`;
- a reconciliação valida atributos, memberships nos dois sentidos, ownership, distinção das cinco roles operacionais e ACLs de banco/schema/objetos/defaults; `PUBLIC` (OID 0) e qualquer principal fora da allowlist fazem a transação falhar;
- todos os objetos 320000 atuais e qualquer objeto futuro com o prefixo protegido ficam sem `SELECT`, DML, sequence ou `EXECUTE` direto; default ACLs também são negativas;
- bootstrap, release e provisioning rejeitam inventário parcial, owner/group/mode divergente ou tenant sem o cutover das quatro credenciais.
- scripts privilegiados são instalados como arquivos regulares `root:root`, sem escrita de grupo/outros, em `/usr/local/libexec/nalven`; provisioning e reconciliação recusam execução a partir do checkout gravável;
- Prisma Migrate e os seeds rodam como `nalven-migrator` (`nologin`, grupo primário exclusivo, sem memberships) sobre um bundle versionado root-owned, com symlinks confinados e `MANIFEST.sha256` verificado; nenhuma URL migrator é entregue a `nalven`, ao checkout ou a `node_modules` gravável;
- `/etc/nalven/app.env` nunca é executado como shell por bootstrap/release: somente chaves estritas são extraídas como dados, e o provisionador root lê exclusivamente `/etc/nalven/tenant-provisioner.env` (`root:root`, `0600`);
- teste, lint e build usam ambiente limpo (`env -i`) como builder, sem `CONTROL_DATABASE_URL`, `NALVEN_INTERNAL_JOB_TOKEN` ou qualquer `TENANT_*`;
- todas as URLs são autenticadas e comparadas com `current_user/current_database`; a credencial runtime deve ser exatamente `${databaseName}_runtime`.

O nome curto das roles (`_mw`, `_mc`, `_si`, `_mh`) mantém identificadores abaixo do limite de 63 bytes mesmo com o maior slug aceito. O significado completo fica congelado nas variáveis `TENANT_MANUAL_WORKER_ROLE`, `TENANT_MANUAL_CALLBACK_ROLE`, `TENANT_STEPUP_ISSUER_ROLE` e `TENANT_MANUAL_HOMOLOGATOR_ROLE`.

## Testes de aceitação

- runtime recebe `42501` em mutação direta de qualquer tabela 320000;
- runtime não lê token de vault, assertion ativa nem claim token;
- runtime não executa funções worker/callback/issuer;
- worker não habilita gate, abre/revisa case ou aplica venda;
- callback role não reivindica outbox nem aplica venda;
- nenhuma role operacional usa `nextval/currval/setval` das sequences 320000;
- issuer emite assertion vinculada; review consome uma vez; replay falha;
- runtime não fabrica assertion → observation → transition em transação direta;
- mudança de connector/credential bloqueia ou invalida gate habilitado;
- reconciliar grants antes/depois da migration produz a mesma matriz;
- novo objeto 320000 não allowlisted nasce inacessível.

Executado em PostgreSQL real por `tests/tenant-database-role-postgres.integration.test.ts`: runtime e as quatro roles especializadas recebem `42501` para `SELECT`, `INSERT`, funções e `nextval` dos objetos 320000; objeto futuro com o prefixo protegido continua inacessível antes e depois da reconciliação. O teste também injeta membership nos dois sentidos, `CONNECT/CREATE/TEMPORARY` de banco, `CREATE/USAGE` de schema, ACL de tabela, default ACL e owner intrusos e comprova falha fechada. Os testes de contrato verificam arquivos separados, ausência de fallback, atributos seguros, artefatos imutáveis e isolamento systemd. Ainda não são testáveis os cenários de `EXECUTE` positivo e one-shot porque concedê-los antes das procedures completas criaria uma autoridade falsa.

## Arquivos afetados no plano de implementação

- `deploy/reconcile-tenant-runtime-grants.sql`: revogações e auditoria negativa completa; nenhum `EXECUTE` positivo;
- `deploy/provision-tenant.sh`: roles worker/callback/issuer/homologator;
- `db/tenant.ts`: clientes separados e sem fallback para a credencial HTTP;
- `deploy/process-tenant-provisioning.sh` e unit/timer próprios: único caminho root para provisionamento, usando artefatos instalados;
- `deploy/process-tenant-jobs.sh` e unit/timer próprios: executor não-root bloqueado até existir bundle runtime homologado;
- `deploy/install-tenant-migration-bundle.sh` e `deploy/run-tenant-migration-bundle.sh`: bundle de migration/seed com digest e executor Unix exclusivo;
- migration 320000: gate/revisões e procedures estreitas;
- testes PostgreSQL com owner, runtime, worker, callback e issuer reais.

Até as procedures completas, adapters reais, cutover de tenants existentes e toda a matriz positiva/negativa passarem, a persistência local comprova apenas a fundação estrutural. Ela não autoriza consulta externa nem aplicação de dinheiro.
