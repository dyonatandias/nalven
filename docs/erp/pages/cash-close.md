# Fechamento de caixa

## Identificação

- Rota: `/erp/cash-close`
- API implementada: `/api/erp/cash-close`
- Grupo: FINANCEIRO
- Estado atual: **Parcial — fechamento local; tesouraria pendente**
- SQL de referência: [cash-close.sql](../sql/cash-close.sql)

## Objetivo

Registrar abertura, suprimento, sangria, conferência e fechamento.

## Modelo de dados

- `cash_register_sessions`
- `cash_register_events`
- `sales`

Todas as tabelas pertencem ao banco exclusivo da organização e não possuem `tenant_id`. Referências de usuário usam o identificador do plano de controle apenas como ator/auditoria, sem relação SQL entre bancos.

## API e interface

- `GET /api/erp/cash-close`: entrega catálogo, histórico e resumo derivados do tenant atual.
- `POST /api/erp/cash-close` legado está bloqueado (`410`); mutações usam o domínio `/api/erp/pdv`. A fundação append-only de malote/custódia e divergência existe, mas ainda não foi integrada ao ciclo operacional: bridge/backfill/cutover, reconciliação, reabertura supervisionada e piloto de tesouraria permanecem pendentes.
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
- Auditoria, correlação e invariantes transacionais verificados.
