# Privacidade e LGPD

## Identificação

- Rota: `/erp/privacy`
- API implementada: `/api/erp/privacy`
- Grupo: GESTÃO
- Estado atual: **Parcial — cadastro de governança; execução LGPD pendente**
- SQL de referência: [privacy.sql](../sql/privacy.sql)

## Objetivo

Gerir titulares, bases legais, retenção, solicitações e incidentes.

## Modelo de dados

- `privacy_requests`
- `legal_bases`
- `retention_rules`
- `privacy_incidents`

Todas as tabelas pertencem ao banco exclusivo da organização e não possuem `tenant_id`. Referências de usuário usam o identificador do plano de controle apenas como ator/auditoria, sem relação SQL entre bancos.

## API e interface

- `GET /api/erp/privacy`: entrega catálogo, histórico e resumo derivados do tenant atual.
- `POST /api/erp/privacy`: executa comandos validados, autorizados e auditados conforme o módulo.
- Regras/solicitações podem ser registradas, mas DSAR, exportação/correção/anonimização, legal hold e executor de retenção ainda não produzem efeitos completos sobre todos os domínios.
- A interface possui estado vazio, carregamento, erro e feedback sem expor respostas brutas.
- Valores exibidos vêm exclusivamente da API e do banco da organização.

## Regras e segurança

1. Resolver organização pela sessão, nunca por parâmetro confiado do cliente.
2. Validar entitlement e permissão de ação antes de abrir transação.
3. Validar payload no servidor e limitar paginação/exportação.
4. Registrar auditoria e correlation ID em toda escrita.
5. Usar outbox e chave idempotente quando houver efeito em outro módulo ou serviço.
6. Impedir exclusão física de registros com vínculo; usar cancelamento/inativação.

## Critérios de aceite

- Migration aplicada no banco demo com Prisma Migrate.
- Fluxos e transições exercitados com testes positivos, negativos e de repetição.
- Permissão de leitura negada para o perfil restrito em cada rota.
- Interface responsiva, sem JSON bruto e sem números de fallback.
- Evidência E2E de acesso, portabilidade, correção, revogação, retenção e anonimização é obrigatória antes de declarar conformidade.
