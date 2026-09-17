# Segregação do banco e raiz de confiança das cotações

Status: **segregação runtime e fundação fail-closed 320000 implementadas para novos tenants / cutover legado, procedures e attestation ainda são gates de produção**.

## Estado entregue

Para tenants novos, `deploy/provision-tenant.sh` cria seis roles sem herança:

- `nalven_t_<slug>_migrator`, dona do banco e dos objetos, com URL em `/etc/nalven/tenant-migrators/<tenant>.env` (`root:root`, `0600`, diretório `0700`);
- `nalven_t_<slug>_runtime`, sem ownership, `SUPERUSER`, `CREATEDB`, `CREATEROLE`, `REPLICATION` ou `BYPASSRLS`, com URL em `/etc/nalven/tenants/<tenant>.env` (`root:nalven-app`, `0640`).
- `nalven_t_<slug>_mw`, worker da reconciliação manual, com credencial `root:nalven-pos-worker`;
- `nalven_t_<slug>_mc`, receptor de callback manual, com credencial `root:nalven-pos-callback`;
- `nalven_t_<slug>_si`, emissor de assertion de step-up, com credencial `root:nalven-pos-stepup`;
- `nalven_t_<slug>_mh`, homologator do gate, com credencial `root:nalven-pos-homologator`.

O Next lê somente `TENANT_DATABASE_URL` do segundo diretório. A unit do serviço declara `/etc/nalven/tenant-migrators` como `InaccessiblePaths`. Prisma Migrate e o seed recebem a URL migrator somente no processo `nalven-migrator`, com `nologin`, grupo exclusivo e ambiente limpo, executando um bundle versionado `root:root` cujo manifesto SHA-256 e ownership são verificados. O arquivo root-only nunca é carregado pelo serviço web, pelo builder `nalven` nem por código/node_modules do checkout.

Os quatro diretórios da 320000 também ficam em `InaccessiblePaths` no serviço web. Cada factory Prisma especializada lê somente a variável e o arquivo de sua autoridade, valida a role esperada e não recua para a credencial HTTP. Neste estágio elas não recebem DML nem funções: conexão separada não é autorização para movimentar dinheiro.

Antes e depois de cada migration, `deploy/reconcile-tenant-runtime-grants.sh` executa, como migrator, a matriz transacional em `deploy/reconcile-tenant-runtime-grants.sql`. A primeira passagem valida credencial/owner e instala os default ACLs antes de nascerem objetos; a segunda cobre todos os objetos da migration. A matriz:

- valida identidade, ownership, atributos e memberships das roles antes de alterar ACLs;
- remove `CREATE`/`TEMPORARY` no banco, `CREATE` no schema, ownership, DDL, `TRUNCATE`, alteração de triggers e capacidade de conceder roles do runtime;
- concede `CONNECT`, `USAGE`, DML sem `TRUNCATE` nas tabelas da aplicação e uso de sequências; ledgers/evidências declarados imutáveis recebem apenas `SELECT`/`INSERT`, sem `UPDATE`/`DELETE`;
- nega todo acesso runtime a `_prisma_migrations`;
- revoga `PUBLIC EXECUTE` das funções atuais e do default ACL global, sem qualquer `GRANT EXECUTE` positivo nesta fundação;
- define default privileges fail-closed: objetos novos nascem sem acesso runtime e só recebem a matriz DML na reconciliação posterior à migration.
- aplica uma exceção negativa por prefixo a `pos_manual_payment_*`: runtime e as quatro roles 320000 não recebem leitura, DML, sequences ou funções diretas; o padrão também protege tabelas futuras ainda não allowlisted.

O backup não usa nenhuma dessas credenciais. Executado como root/systemd, ele consulta `config_key` e `database_name` de todos os registros tenant no plano de controle (inclusive suspensos) e chama `pg_dump` como o usuário local `postgres` via peer, somente com o nome validado do banco.

Os scripts de bootstrap e release falham antes das migrations se encontrarem um tenant runtime sem arquivo migrator correspondente. Não existe fallback para a antiga URL owner.

Provisioning roda numa unit root dedicada e só aceita scripts/SQL regulares `root:root`, sem escrita por grupo/outros, instalados em `/usr/local/libexec/nalven`; `ProtectHome=true` impede acesso ao checkout. A configuração do plano de controle é lida como dado de `/etc/nalven/tenant-provisioner.env` (`0600`), nunca por `source` de `app.env`. Test/lint/build rodam como builder com `env -i`, sem segredos de controle ou tenant; migrations/seeds rodam apenas no executor `nalven-migrator` sobre o bundle instalado. A unit genérica de jobs roda como `nalven-jobs`, não enxerga nenhuma credencial tenant e permanece explicitamente bloqueada até um bundle runtime root-owned ser homologado. Os quatro executores manuais também permanecem sem serviço/`EXECUTE`; isso é um gate, não uma degradação silenciosa.

## Limite que permanece

Triggers, FKs, ledgers e quote-lines continuam úteis contra defeitos e caminhos incompletos da aplicação. Porém nenhum trigger pode oferecer uma raiz de confiança contra SQL arbitrário executado pela própria role owner: o owner pode criar registros auxiliares, trocar funções ou alterar privilégios. Um HMAC armazenado em tabela, função ou GUC legível pelo mesmo owner seria apenas uma aparência de attestation.

Essa limitação foi fechada para a role runtime dos tenants novos, mas continua aberta nos tenants legados ainda não convertidos. A assinatura/attestation real também continua pendente: nenhuma role `*_attestor`, chave externa, função `SECURITY DEFINER` ou integração KMS foi criada nesta entrega.

## Arquitetura alvo

Por tenant:

1. `*_migrator`: login restrito à operação de deploy, owner do banco/schema/objetos; credencial em arquivo root/build, nunca legível pelo serviço web.
2. `*_runtime`: login usado pelo Next/Prisma; sem `CREATE`, `ALTER`, `DROP`, `TRUNCATE`, ownership ou capacidade de conceder privilégios.
3. `*_attestor`: `NOLOGIN`, owner somente das funções/tabela de verificação; sem herança pelo runtime.
4. `*_backup`: login/read policy própria quando o backup não usar a conta local `postgres`.

O runtime recebe apenas `USAGE` no schema, DML mínimo por tabela, uso de sequências e `EXECUTE` nas funções aprovadas. Default privileges do migrator negam acesso runtime a objetos futuros; a passagem posterior à migration concede explicitamente a matriz aplicável. Assim não existe janela em que uma tabela nova — inclusive `_prisma_migrations` — nasça gravável pelo processo web.

## Attestation da cotação

Depois da segregação:

- a aplicação assina o payload canônico do quote com chave por tenant/versionada fora do banco runtime;
- o payload inclui organização implícita pelo banco, filial, caixa, turno, operador, terminal, draft/revisão/hash, claim/lease, quote-lines completas, promo/cupom, total, moeda, `evaluatedAt`, `expiresAt` e key-id;
- uma função `SECURITY DEFINER`, owned por `*_attestor`, valida a assinatura usando material que `*_runtime` não consegue ler nem alterar;
- `search_path` é fixado dentro da função; `PUBLIC` não recebe execute; todos os argumentos são tipos escalares/canônicos;
- rotação usa key-id, janela dual-read curta, revogação e evidência; nunca sobrescreve attestation histórica;
- plano, slots e consumo referenciam a attestation imutável exata.

Se a aplicação inteira for comprometida, uma chave disponível ao processo ainda pode ser usada. Esse risco exige KMS/assinatura remota ou política de chave de curta duração; a segregação descrita fecha a autoridade SQL do runtime, não substitui isolamento do host.

## Migração de tenants existentes (manual e fail-closed)

Os scripts não convertem um tenant legado automaticamente. Encontrar apenas `/etc/nalven/tenants/<tenant>.env` interrompe provisioning, bootstrap e deploy com instrução de cutover manual. Isso evita reatribuição de ownership ou rotação de senha em massa sem ensaio.

1. Inventariar owner, grants, extensions, funções definer, jobs e conexões ativas.
2. Restaurar o backup verificado num clone e executar nele todo o procedimento antes da produção.
3. Criar `*_migrator` e `*_runtime` com senhas hexadecimais aleatórias de 64 caracteres e atributos equivalentes aos do provisionador, sem alterar ainda a URL ativa.
4. Como superuser local, executar `REASSIGN OWNED BY <owner_antigo> TO <migrator>`, alterar o owner do banco/schema e auditar todos os objetos que não pertençam ao migrator. Extensões e funções definer exigem revisão individual.
5. Criar atomicamente o arquivo runtime `0640 root:nalven-app` e o arquivo migrator `0600 root:root`. O arquivo migrator contém `TENANT_MIGRATOR_DATABASE_URL`, `TENANT_DATABASE_NAME`, `TENANT_RUNTIME_ROLE` e `TENANT_MIGRATOR_ROLE`; os quatro valores precisam corresponder entre si.
6. Instalar/verificar o bundle root-owned e rodar a próxima migration/seed pelo executor `nalven-migrator`, com `TENANT_DATABASE_URL` limitado ao ambiente limpo desse processo; imediatamente depois, executar `nalven-reconcile-tenant-runtime-grants <arquivo-migrator>`.
7. Trocar o arquivo runtime atomicamente, reiniciar os pools e executar os smoke tests de todas as rotas. Confirmar DML funcional e falha de DDL, `TRUNCATE`, `GRANT`, leitura de `_prisma_migrations` e função não allowlisted.
8. Só depois dos testes, revogar a senha antiga e remover a role anterior quando `pg_shdepend`/`pg_depend` não mostrarem dependências.
9. Testar migration seguinte, rollback de release, backup/restore e rotação no clone e no tenant convertido.

O rollout deve ser tenant a tenant, com backup verificado e janela de reversão. Não se deve remover ownership em massa sem ensaio num clone representativo.

## Testes de aceite

- runtime consegue `INSERT`/`SELECT`/`UPDATE`/`DELETE` e sequências, mas não consegue DDL, `TEMP`, `TRUNCATE`, membership/grant, ler `_prisma_migrations` ou executar função não allowlisted;
- migration cria tabela/sequência nova inicialmente inacessível ao runtime; somente a reconciliação posterior concede o DML esperado, e função nova nasce sem `PUBLIC EXECUTE`;
- quote válida passa; mudança de um centavo, linha, contexto, TTL ou key-id falha;
- replay idêntico converge; attestation expirada/revogada bloqueia novo efeito mas não bloqueia callback tardio;
- restore preserva owners/grants/funções/segredos sem expor material em dump entregue ao runtime;
- scanner automático de privilégios não encontra `PUBLIC EXECUTE`, owner runtime, função definer com `search_path` aberto ou segredo em tabela legível.

`tests/tenant-database-role-postgres.integration.test.ts` cobre a fronteira PostgreSQL acima numa base e seis roles descartáveis; `tests/tenant-database-role-contract.test.ts` cobre o wiring fail-closed dos scripts. O teste de integração é opt-in por `TENANT_ROLE_TEST_ADMIN_DATABASE_URL` porque cria e remove banco e roles com nomes aleatórios.

Ainda faltam o rollout tenant a tenant, attestation/KMS, scanner completo de todas as funções definer e um restore drill que compare ACLs/owners. Esses pontos continuam bloqueando a declaração de produção completa.
