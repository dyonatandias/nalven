# Arquitetura Multi-tenant

## Separação física

`nalven_control` mantém o plano de controle: organizações, memberships, sessões, plano contratado, domínio, estado do provisionamento e referência `config_key`. Cada organização possui banco próprio, por exemplo `nalven_t_demo`, com credencial separada em `/etc/nalven/tenants/demo.env`.

`tenantDb(organizationId)` resolve a organização autenticada, busca somente a referência aprovada no banco de controle, lê a credencial protegida e abre o Prisma Client do banco correto. A API nunca aceita um `tenantId` arbitrário do navegador.

## Invariantes de segurança

- Nenhuma tabela operacional contém `tenant_id`.
- Nenhuma consulta de ERP usa o banco de outro tenant.
- Usuário precisa de membership ativa antes da resolução do banco.
- Chaves externas ficam em cofre cifrado; tabelas guardam apenas referências.
- Backups, migrações e restaurações operam por banco e registram organização, versão e checksum.
- Exportações são geradas no contexto do banco atual e entregues por token temporário.

## Identidade, organização ativa e permissões

Usuários, sessões, memberships e convites ficam no banco de controle, pois concedem entrada ao tenant. O cookie HTTP-only `nalven_organization` seleciona somente uma organização na qual a sessão possua membership ativa; APIs nunca aceitam esse identificador como autorização suficiente.

Cada banco de tenant mantém `tenant_roles` e `tenant_user_profiles`. O papel da membership referencia a chave do perfil e as APIs validam permissões `recurso.read` ou `recurso.write` no servidor. Escrita implica leitura; `*` é reservado aos perfis integrais. Convites usam token aleatório exibido uma vez, persistem somente SHA-256, expiram em sete dias e suportam rotação e revogação.

## Ciclo de provisionamento

1. Criar organização no controle e registrar job.
2. Criar role e database PostgreSQL com nomes validados.
3. Gravar credencial fora do repositório com permissão mínima.
4. Aplicar todas as migrações de `prisma/tenant/migrations`.
5. Executar seed idempotente específico da organização.
6. Fazer health check, registrar versão e ativar o banco.
7. Em falha, retomar pelo job; nunca compartilhar banco como fallback.

## Evolução do schema

Cada mudança gera migration imutável. O orquestrador percorre bancos ativos, aplica a versão, registra duração/erro e bloqueia apenas o tenant incompatível. A aplicação precisa tolerar a janela de rollout e expor a versão esperada versus aplicada.
