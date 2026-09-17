# Movimentações

## Identificação

- Rota: `/erp/stock`
- API implementada: `/api/erp/stock`
- Grupo: OPERAÇÃO
- Estado atual: **Parcial — venda dimensional protegida; administração completa pendente**
- SQL de referência: [stock.sql](../sql/stock.sql)

## Objetivo

Rastrear toda alteração de saldo de estoque.

## Modelo de dados

- `stock_movements`
- `warehouse_balances`

Todas as tabelas pertencem ao banco exclusivo da organização e não possuem `tenant_id`. Referências de usuário usam o identificador do plano de controle apenas como ator/auditoria, sem relação SQL entre bancos.

## API e interface

- `GET /api/erp/stock`: entrega catálogo, histórico e resumo derivados do tenant atual.
- `POST /api/erp/stock`: executa comandos validados, autorizados e auditados conforme o módulo.
- A interface possui estado vazio, carregamento, erro e feedback sem expor respostas brutas.
- Valores exibidos vêm exclusivamente da API e do banco da organização.
- Fluxos legados que não representam variação/lote/série/bucket/reserva falham fechado; ledger dimensional completo continua gate.

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
