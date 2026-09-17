# PRD Geral — ERP NALVEN

## Visão

O ERP é o produto principal acessado em `/erp`. O portal `/portal` cuida de conta, assinatura e faturamento do SaaS. Os dois ambientes mantêm links recíprocos, mas não misturam dados operacionais com cobranças da plataforma.

## Pessoas e papéis

- Proprietário: configuração, usuários, financeiro e decisões críticas.
- Administrador: operação ampla conforme alçada.
- Vendas/PDV: clientes, pedidos, caixa e vendas.
- Estoque/compras: catálogo, movimentações, inventário e suprimentos.
- Financeiro/fiscal: títulos, conciliação e documentos fiscais.
- Auditor: somente leitura e exportação autorizada.

## Requisitos sistêmicos

1. Navegação responsiva e rota estável para cada módulo.
2. Busca, filtros, paginação, estados vazios, erro e carregamento.
3. CRUD validado no servidor, concorrência otimista e transações atômicas.
4. Permissões por recurso e ação; negação por padrão.
5. Auditoria com ator, entidade, alteração, IP, horário e correlação.
6. Exportação assíncrona, retenção configurável e rastreabilidade.
7. Jobs externos com outbox, retry exponencial, DLQ e idempotência.
8. Métricas derivadas de registros reais; nenhum fallback demonstrativo após a conversão.

## Critério global de pronto

O estado implementado exige schema, migração, seed idempotente, API, permissões, auditoria, interface, testes e implantação multi-tenant comprovados. A simples existência visual não conclui o módulo.
