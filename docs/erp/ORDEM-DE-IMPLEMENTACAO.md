# Estado de Implementação

## Fundação concluída

Todos os módulos usam o banco isolado do tenant, autorização por recurso, validação no servidor e auditoria das escritas relevantes.

## Módulos entregues

1. [Visão geral](./pages/dashboard.md) — verificado em `/erp`
2. [PDV · Ponto de venda](./pages/pdv.md) — reconstrução P0; produção bloqueada pelos gates do programa PDV
3. [Vendas e despesas](./pages/sales.md) — verificado em `/erp/sales`
4. [Produtos e serviços](./pages/products.md) — verificado em `/erp/products`
5. [Movimentações](./pages/stock.md) — verificado em `/erp/stock`
6. [Entrada por NF-e](./pages/invoices.md) — verificado em `/erp/invoices`
7. [Orçamentos e pedidos](./pages/orders.md) — verificado em `/erp/orders`
8. [CRM e oportunidades](./pages/crm.md) — verificado em `/erp/crm`
9. [Contratos e recorrência](./pages/contracts.md) — verificado em `/erp/contracts`
10. [Ordens de serviço](./pages/service-orders.md) — verificado em `/erp/service-orders`
11. [Compras e cotações](./pages/purchases.md) — verificado em `/erp/purchases`
12. [Inventário e depósitos](./pages/inventory.md) — verificado em `/erp/inventory`
13. [Produção e kits](./pages/production.md) — verificado em `/erp/production`
14. [Canais e marketplaces](./pages/marketplaces.md) — verificado em `/erp/marketplaces`
15. [Expedição e logística](./pages/logistics.md) — verificado em `/erp/logistics`
16. [Contas a pagar/receber](./pages/finance.md) — verificado em `/erp/finance`
17. [Fechamento de caixa](./pages/cash-close.md) — verificado em `/erp/cash-close`
18. [Contas e caixas](./pages/accounts.md) — verificado em `/erp/accounts`
19. [Conciliação bancária](./pages/reconciliation.md) — verificado em `/erp/reconciliation`
20. [DRE, orçamento e metas](./pages/planning.md) — verificado em `/erp/planning`
21. [Central fiscal](./pages/fiscal.md) — verificado em `/erp/fiscal`
22. [Clientes](./pages/customers.md) — verificado em `/erp/customers`
23. [Fornecedores](./pages/suppliers.md) — verificado em `/erp/suppliers`
24. [Categorias](./pages/categories.md) — verificado em `/erp/categories`
25. [Usuários e acessos](./pages/users.md) — verificado em `/erp/users`
26. [Central de relatórios](./pages/reports.md) — verificado em `/erp/reports`
27. [Biblioteca de mídias](./pages/library.md) — verificado em `/erp/library`
28. [Empresas e filiais](./pages/branches.md) — verificado em `/erp/branches`
29. [Automações](./pages/automations.md) — verificado em `/erp/automations`
30. [Atividades e auditoria](./pages/activities.md) — verificado em `/erp/activities`
31. [Privacidade e LGPD](./pages/privacy.md) — verificado em `/erp/privacy`
32. [Configurações](./pages/settings.md) — verificado em `/erp/settings`

## Gate por página

Para cada evolução: revisar contrato → criar migration Prisma imutável → validar build → migrar o banco demo → testar caminho feliz, negações e repetição → publicar release imutável → conferir saúde e invariantes.
