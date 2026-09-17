# Plano de Produto do ERP NALVEN

Este diretório registra a implementação verificável do ERP multiempresa. Todas as páginas operacionais usam exclusivamente o PostgreSQL isolado da organização, sem dados mockados ou fallback na interface.

## Regras obrigatórias

- O banco de controle conhece organizações, usuários, planos e o endereço do banco do tenant.
- Dados operacionais nunca recebem `tenant_id`: cada organização usa outro banco.
- Toda escrita exige sessão, organização ativa, licença/entitlement e auditoria.
- A interface não apresenta JSON bruto, segredo, número mockado ou fallback demonstrativo.
- Integrações fiscais, bancárias e de canal usam outbox, idempotência e cofres cifrados.
- Migrações são aplicadas a todos os bancos por fila, com versão e possibilidade de retomada.

## Registro de páginas

| Página | Rota | Grupo | Estado | Projeto SQL |
|---|---|---|---|---|
| [Visão geral](./pages/dashboard.md) | `/erp` | OPERAÇÃO | Implementado e verificado | [SQL](./sql/dashboard.sql) |
| [PDV · Ponto de venda](./pages/pdv.md) | `/erp/pdv` | OPERAÇÃO | Em reconstrução · P0 em implementação | [Programa](./pdv/README.md) |
| [Vendas e despesas](./pages/sales.md) | `/erp/sales` | OPERAÇÃO | Implementado e verificado | [SQL](./sql/sales.sql) |
| [Produtos e serviços](./pages/products.md) | `/erp/products` | OPERAÇÃO | Implementado e verificado | [SQL](./sql/products.sql) |
| [Movimentações](./pages/stock.md) | `/erp/stock` | OPERAÇÃO | Implementado e verificado | [SQL](./sql/stock.sql) |
| [Entrada por NF-e](./pages/invoices.md) | `/erp/invoices` | OPERAÇÃO | Implementado e verificado | [SQL](./sql/invoices.sql) |
| [Orçamentos e pedidos](./pages/orders.md) | `/erp/orders` | COMERCIAL | Implementado e verificado | [SQL](./sql/orders.sql) |
| [CRM e oportunidades](./pages/crm.md) | `/erp/crm` | COMERCIAL | Implementado e verificado | [SQL](./sql/crm.sql) |
| [Contratos e recorrência](./pages/contracts.md) | `/erp/contracts` | COMERCIAL | Implementado e verificado | [SQL](./sql/contracts.sql) |
| [Ordens de serviço](./pages/service-orders.md) | `/erp/service-orders` | COMERCIAL | Implementado e verificado | [SQL](./sql/service-orders.sql) |
| [Compras e cotações](./pages/purchases.md) | `/erp/purchases` | SUPRIMENTOS | Implementado e verificado | [SQL](./sql/purchases.sql) |
| [Inventário e depósitos](./pages/inventory.md) | `/erp/inventory` | SUPRIMENTOS | Implementado e verificado | [SQL](./sql/inventory.sql) |
| [Produção e kits](./pages/production.md) | `/erp/production` | SUPRIMENTOS | Implementado e verificado | [SQL](./sql/production.sql) |
| [Canais e marketplaces](./pages/marketplaces.md) | `/erp/marketplaces` | OMNICANAL | Implementado e verificado | [SQL](./sql/marketplaces.sql) |
| [Expedição e logística](./pages/logistics.md) | `/erp/logistics` | OMNICANAL | Implementado e verificado | [SQL](./sql/logistics.sql) |
| [Contas a pagar/receber](./pages/finance.md) | `/erp/finance` | FINANCEIRO | Implementado e verificado | [SQL](./sql/finance.sql) |
| [Fechamento de caixa](./pages/cash-close.md) | `/erp/cash-close` | FINANCEIRO | Implementado e verificado | [SQL](./sql/cash-close.sql) |
| [Contas e caixas](./pages/accounts.md) | `/erp/accounts` | FINANCEIRO | Implementado e verificado | [SQL](./sql/accounts.sql) |
| [Conciliação bancária](./pages/reconciliation.md) | `/erp/reconciliation` | FINANCEIRO | Implementado e verificado | [SQL](./sql/reconciliation.sql) |
| [DRE, orçamento e metas](./pages/planning.md) | `/erp/planning` | FINANCEIRO | Implementado e verificado | [SQL](./sql/planning.sql) |
| [Central fiscal](./pages/fiscal.md) | `/erp/fiscal` | FISCAL | Implementado e verificado | [SQL](./sql/fiscal.sql) |
| [Clientes](./pages/customers.md) | `/erp/customers` | CADASTROS | Implementado e verificado | [SQL](./sql/customers.sql) |
| [Fornecedores](./pages/suppliers.md) | `/erp/suppliers` | CADASTROS | Implementado e verificado | [SQL](./sql/suppliers.sql) |
| [Categorias](./pages/categories.md) | `/erp/categories` | CADASTROS | Implementado e verificado | [SQL](./sql/categories.sql) |
| [Usuários e acessos](./pages/users.md) | `/erp/users` | CADASTROS | Implementado e verificado | [SQL](./sql/users.sql) |
| [Central de relatórios](./pages/reports.md) | `/erp/reports` | GESTÃO | Implementado e verificado | [SQL](./sql/reports.sql) |
| [Biblioteca de mídias](./pages/library.md) | `/erp/library` | GESTÃO | Implementado e verificado | [SQL](./sql/library.sql) |
| [Empresas e filiais](./pages/branches.md) | `/erp/branches` | GESTÃO | Implementado e verificado | [SQL](./sql/branches.sql) |
| [Automações](./pages/automations.md) | `/erp/automations` | GESTÃO | Implementado e verificado | [SQL](./sql/automations.sql) |
| [Atividades e auditoria](./pages/activities.md) | `/erp/activities` | GESTÃO | Implementado e verificado | [SQL](./sql/activities.sql) |
| [Privacidade e LGPD](./pages/privacy.md) | `/erp/privacy` | GESTÃO | Implementado e verificado | [SQL](./sql/privacy.sql) |
| [Configurações](./pages/settings.md) | `/erp/settings` | GESTÃO | Implementado e verificado | [SQL](./sql/settings.sql) |

## Documentos transversais

- [PRD geral](./PRD-GERAL.md)
- [Arquitetura multi-tenant](./ARQUITETURA-MULTITENANT.md)
- [Ordem de implementação](./ORDEM-DE-IMPLEMENTACAO.md)
- [Fundação SQL do tenant](./sql/000-tenant-foundation.sql)
