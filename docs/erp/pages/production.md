# Produção e kits

## Identificação

- Rota: `/erp/producao-kits`
- API: `/api/erp/production/operations`; `/api/erp/production` delega ao mesmo handler.
- Grupo: SUPRIMENTOS
- Estado atual: ampliação publicada em 2026-09-07, incluindo compra/recebimento de variações e permissões de suprimentos. Testes transacionais, navegador, lint/build e aceite com login real passaram. Ver [evidências de conclusão](../production-completion.md) e [checklist de publicação](../production-release-checklist.md).
- SQL de referência: [production.sql](../sql/production.sql)

## Objetivo

Planejar e apontar consumo, perdas, produto acabado e custo real transacionalmente.

## Modelo de dados

- `bills_of_material`
- `bill_of_material_items`
- `production_orders`
- `production_bom_revisions`, `production_work_centers`, `production_dependencies`
- `production_material_reservations`, `production_reports`, `production_consumptions`
- `production_inspections`, `production_events`, `production_commands`, `production_procurements`
- `pos_inventory_lots`, `pos_inventory_lot_movements`, `warehouse_variation_balances`
- `warehouse_balances`
- `warehouse_ledger_entries`

Todas as tabelas pertencem ao banco exclusivo da organização e não possuem `tenant_id`. Referências de usuário usam o identificador do plano de controle apenas como ator/auditoria, sem relação SQL entre bancos.

## API e interface

- `GET`: recursos `orders`, `calendar`, `detail`, `summary`, `changes`, `boms`, `revisions`, `centers`, `products`, `warehouses`, `suppliers`, `reports` e `events`; coleções paginadas no servidor.
- `POST`: comandos explícitos `bom.*`, `center.save`, `order.*`, `report.inspect` e `mrp.*`; a chave UUID `idempotencyKey` acompanha todo comando.
- Kanban, lista e Gantt usam a mesma fila ordenada por posição, urgência e prazo antes da paginação. Arrastar/soltar tem alternativa por teclado.
- Formulários e estados pertencem a `components/erp/production-*`; não há navegação duplicada para outros módulos no conteúdo da página.
- Uma ficha tem revisão aprovada/vigente e cada ordem conserva sua composição. Apontamentos são parciais, com consumo real, refugo, retrabalho e custos.
- Produto acabado fica em quarentena até inspeção e certificado. A liberação direta pelo inventário não contorna a inspeção de produção.
- A interface possui estado vazio, carregamento, erro e feedback sem expor respostas brutas.
- Valores exibidos vêm exclusivamente da API e do banco da organização.

## Regras e segurança

1. Resolver organização pela sessão, nunca por parâmetro confiado do cliente.
2. Validar entitlement e permissão de ação antes de abrir transação.
3. Validar payload no servidor e limitar paginação/exportação.
4. Registrar auditoria e correlation ID em toda escrita.
5. Usar outbox e chave idempotente quando houver efeito em outro módulo ou serviço.
6. Impedir exclusão física de registros com vínculo; usar cancelamento/inativação.
7. Compras exigem também `purchases.write`; transferências exigem `inventory.write`.
8. Reservas e consumo usam o estoque compartilhado, variações e FEFO, sem uma contabilidade paralela de saldo.
9. O banco protege a base da ordem, a identidade das reservas, a vinculação dos consumos e a correspondência entre decisão e evidência de inspeção.

## Validação local

- `npm run test:production`: regras puras (também executadas antes de `test:unit`).
- `PRODUCTION_TEST_SOCKET=/tmp/nalven-production-pg.<isolado> npm run test:production:postgres`: testes transacionais em banco descartável; nunca apontar a testes para tenants reais.
- `PRODUCTION_TEST_SOCKET=/tmp/nalven-production-pg.<isolado> npm run test:production:browser`: interface e serviços reais em harness loopback; não substitui autorização autenticada do ambiente publicado.
- `npm test`: regressão geral, lint e build; o build requer banco central com configurações de metadados e contratação. O fixture de controle isolado está em `scripts/production-control-test-database.ts`.
- As migrations executáveis são `20260908090000_production_operations`, `20260908100000_production_evidence_guards`, `20260908110000_production_purchase_dimensions` e `20260908120000_purchase_receipt_evidence`. As adicionais preservam evidência histórica e vinculam recebimento à variação e ao depósito, sem recalcular saldos históricos.
- A quinta migration, `20260908130000_supply_operations_permissions`, estende somente o perfil de sistema de suprimentos, com auditoria e sem alterar perfis personalizados.

## Critérios de aceite

- Migration aplicada no banco demo com Prisma Migrate.
- Fluxos e transições exercitados com testes positivos, negativos e de repetição.
- Permissão de leitura negada para o perfil restrito em cada rota.
- Interface responsiva, sem JSON bruto e sem números de fallback.
- Auditoria, correlação e invariantes transacionais verificados.
