# Inventário e depósitos

## Identificação

- Rota: `/erp/inventory`
- API implementada: `/api/erp/inventory`
- Grupo: SUPRIMENTOS
- Estado atual: **Parcial — fluxo dimensional em reconstrução**
- SQL de referência: [inventory.sql](../sql/inventory.sql)

## Objetivo

Controlar depósitos, saldos, contagens físicas, transferências e razão auditável sem quebrar variação, lote, série, validade, bucket ou reserva.

## Modelo de dados

- `warehouses`
- `warehouse_balances`
- `inventory_counts`
- `inventory_count_items`
- `stock_transfers`
- `stock_transfer_items`
- movimentos/ledgers de estoque existentes; a modelagem dimensional de contagem/transferência ainda será substituída.

Todas as tabelas pertencem ao banco exclusivo da organização e não possuem `tenant_id`. Referências de usuário usam o identificador do plano de controle apenas como ator/auditoria, sem relação SQL entre bancos.

## API e interface

- `GET /api/erp/inventory`: entrega catálogo, histórico e resumo derivados do tenant atual.
- `POST /api/erp/inventory`: executa comandos validados, autorizados e auditados conforme o módulo.
- `finalize_count` e `transfer` legados falham antes de escrever se qualquer SKU for rastreado, dimensionado ou reservado; somente SKU simples permanece elegível.
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
- Contagem/transferência dimensional com snapshot, recontagem/aprovação, custódia e concorrência venda×inventário ainda é gate de aceite.
