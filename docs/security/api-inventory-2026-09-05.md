# Inventário de APIs — 05/09/2026

130 arquivos de rotas inventariados após inclusão do job de analytics. A tabela descreve as barreiras identificadas no código; não representa um pentest autenticado de cada operação e perfil. Todos os caminhos `/api/:path*` passam agora pelo proxy, inclusive prefetch e biblioteca. Autorização continua nos handlers.

| Rota | Métodos declarados | Barreira identificada |
| --- | --- | --- |
| `/api/admin/analytics` | GET, PUT | Superadministrador |
| `/api/admin/audit` | GET | Superadministrador |
| `/api/admin/billing` | GET, POST | Superadministrador |
| `/api/admin/content` | GET, POST | Superadministrador |
| `/api/admin/control` | GET, POST | Superadministrador |
| `/api/admin/email` | GET, POST | Superadministrador |
| `/api/admin/media` | POST | Superadministrador |
| `/api/admin/system` | GET | Superadministrador |
| `/api/analytics/event` | GET, POST | Pública por finalidade; validação de entrada e escopo conforme endpoint |
| `/api/auth/forgot-password` | POST | Fluxo de autenticação; rate limit nos endpoints públicos; sessão quando aplicável |
| `/api/auth/invite` | GET, POST | Fluxo de autenticação; rate limit nos endpoints públicos; sessão quando aplicável |
| `/api/auth/login` | POST | Fluxo de autenticação; rate limit nos endpoints públicos; sessão quando aplicável |
| `/api/auth/logout` | POST | Fluxo de autenticação; rate limit nos endpoints públicos; sessão quando aplicável |
| `/api/auth/me` | GET | Fluxo de autenticação; rate limit nos endpoints públicos; sessão quando aplicável |
| `/api/auth/organization` | GET, POST | Fluxo de autenticação; rate limit nos endpoints públicos; sessão quando aplicável |
| `/api/auth/reset-password` | POST | Fluxo de autenticação; rate limit nos endpoints públicos; sessão quando aplicável |
| `/api/auth/signup` | POST | Fluxo de autenticação; rate limit nos endpoints públicos; sessão quando aplicável |
| `/api/erp/accounts` | GET, POST | Sessão, empresa e permissões ERP (inclui contexto delegado de relatórios) |
| `/api/erp/activities` | GET, POST | Sessão, empresa e permissões ERP (inclui contexto delegado de relatórios) |
| `/api/erp/ai/usage` | GET, POST | Sessão, empresa e permissões ERP (inclui contexto delegado de relatórios) |
| `/api/erp/automations` | GET, POST | Sessão, empresa e permissões ERP (inclui contexto delegado de relatórios) |
| `/api/erp/branches/[id]` | GET, PATCH | Sessão, empresa e permissões ERP (inclui contexto delegado de relatórios) |
| `/api/erp/branches` | GET, POST | Sessão, empresa e permissões ERP (inclui contexto delegado de relatórios) |
| `/api/erp/cash-close` | GET, POST | Sessão, empresa e permissões ERP (inclui contexto delegado de relatórios) |
| `/api/erp/categories/[id]` | GET, PATCH | Sessão, empresa e permissões ERP (inclui contexto delegado de relatórios) |
| `/api/erp/categories` | GET, POST | Sessão, empresa e permissões ERP (inclui contexto delegado de relatórios) |
| `/api/erp/contracts` | GET, POST | Sessão, empresa e permissões ERP (inclui contexto delegado de relatórios) |
| `/api/erp/crm` | GET, POST | Sessão, empresa e permissões ERP (inclui contexto delegado de relatórios) |
| `/api/erp/customers/[id]` | GET, PATCH | Sessão, empresa e permissões ERP (inclui contexto delegado de relatórios) |
| `/api/erp/customers` | GET, POST | Sessão, empresa e permissões ERP (inclui contexto delegado de relatórios) |
| `/api/erp/dashboard` | GET | Sessão, empresa e permissões ERP (inclui contexto delegado de relatórios) |
| `/api/erp/finance/[id]` | GET, PATCH | Sessão, empresa e permissões ERP (inclui contexto delegado de relatórios) |
| `/api/erp/finance/batch` | POST | Sessão, empresa e permissões ERP (inclui contexto delegado de relatórios) |
| `/api/erp/finance` | GET, POST | Sessão, empresa e permissões ERP (inclui contexto delegado de relatórios) |
| `/api/erp/fiscal` | GET, POST | Sessão, empresa e permissões ERP (inclui contexto delegado de relatórios) |
| `/api/erp/integrations/[...path]` | GET, POST, PATCH, DELETE | Sessão, empresa e permissões ERP (inclui contexto delegado de relatórios) |
| `/api/erp/inventory` | GET, POST | Sessão, empresa e permissões ERP (inclui contexto delegado de relatórios) |
| `/api/erp/invoices/dfe` | GET, POST | Sessão, empresa e permissões ERP (inclui contexto delegado de relatórios) |
| `/api/erp/invoices` | GET, POST | Sessão, empresa e permissões ERP (inclui contexto delegado de relatórios) |
| `/api/erp/library/[id]/file` | GET | Sessão, empresa e permissões ERP (inclui contexto delegado de relatórios) |
| `/api/erp/library/[id]` | GET | Sessão, empresa e permissões ERP (inclui contexto delegado de relatórios) |
| `/api/erp/library/[id]/versions/[versionId]/file` | GET | Sessão, empresa e permissões ERP (inclui contexto delegado de relatórios) |
| `/api/erp/library/[id]/versions` | POST | Sessão, empresa e permissões ERP (inclui contexto delegado de relatórios) |
| `/api/erp/library/folders` | POST, PATCH, DELETE | Sessão, empresa e permissões ERP (inclui contexto delegado de relatórios) |
| `/api/erp/library` | GET, POST, PATCH | Sessão, empresa e permissões ERP (inclui contexto delegado de relatórios) |
| `/api/erp/logistics/labels/[packageId]` | GET | Sessão, empresa e permissões ERP (inclui contexto delegado de relatórios) |
| `/api/erp/logistics` | GET, POST | Sessão, empresa e permissões ERP (inclui contexto delegado de relatórios) |
| `/api/erp/marketplaces` | GET, POST | Sessão, empresa e permissões ERP (inclui contexto delegado de relatórios) |
| `/api/erp/order-management` | GET, POST | Sessão, empresa e permissões ERP (inclui contexto delegado de relatórios) |
| `/api/erp/orders` | GET, POST | Sessão, empresa e permissões ERP (inclui contexto delegado de relatórios) |
| `/api/erp/payments` | GET | Sessão, empresa e permissões ERP (inclui contexto delegado de relatórios) |
| `/api/erp/pdv/admin` | GET, POST | Sessão, empresa e permissões ERP (inclui contexto delegado de relatórios) |
| `/api/erp/pdv/approvals` | GET, POST | Sessão, empresa e permissões ERP (inclui contexto delegado de relatórios) |
| `/api/erp/pdv/customers` | POST | Sessão, empresa e permissões ERP (inclui contexto delegado de relatórios) |
| `/api/erp/pdv/held-sales/transfer` | GET, POST | Sessão, empresa e permissões ERP (inclui contexto delegado de relatórios) |
| `/api/erp/pdv/internal-qrs` | GET, POST | Sessão, empresa e permissões ERP (inclui contexto delegado de relatórios) |
| `/api/erp/pdv/inventory` | GET, POST | Sessão, empresa e permissões ERP (inclui contexto delegado de relatórios) |
| `/api/erp/pdv/kits` | GET, POST | Sessão, empresa e permissões ERP (inclui contexto delegado de relatórios) |
| `/api/erp/pdv/manual-applications` | GET, POST | Sessão, empresa e permissões ERP (inclui contexto delegado de relatórios) |
| `/api/erp/pdv/manual-payments` | GET, POST | Sessão, empresa e permissões ERP (inclui contexto delegado de relatórios) |
| `/api/erp/pdv/observability` | GET | Sessão, empresa e permissões ERP (inclui contexto delegado de relatórios) |
| `/api/erp/pdv/offline-credentials` | GET, POST | Sessão, empresa e permissões ERP (inclui contexto delegado de relatórios) |
| `/api/erp/pdv/payment-intents` | GET, POST | Sessão, empresa e permissões ERP (inclui contexto delegado de relatórios) |
| `/api/erp/pdv/payment-plans` | POST | Sessão, empresa e permissões ERP (inclui contexto delegado de relatórios) |
| `/api/erp/pdv/print-jobs` | POST | Sessão, empresa e permissões ERP (inclui contexto delegado de relatórios) |
| `/api/erp/pdv/product-codes` | GET, POST | Sessão, empresa e permissões ERP (inclui contexto delegado de relatórios) |
| `/api/erp/pdv/promotions` | GET, POST | Sessão, empresa e permissões ERP (inclui contexto delegado de relatórios) |
| `/api/erp/pdv/reconciliation` | GET, POST | Sessão, empresa e permissões ERP (inclui contexto delegado de relatórios) |
| `/api/erp/pdv` | GET, POST | Sessão, empresa e permissões ERP (inclui contexto delegado de relatórios) |
| `/api/erp/pdv/session-lifecycle` | GET, POST | Sessão, empresa e permissões ERP (inclui contexto delegado de relatórios) |
| `/api/erp/pdv/terminals` | POST | Sessão, empresa e permissões ERP (inclui contexto delegado de relatórios) |
| `/api/erp/pdv/value-accounts/liability` | GET | Sessão, empresa e permissões ERP (inclui contexto delegado de relatórios) |
| `/api/erp/pdv/value-accounts/resolve` | POST | Sessão, empresa e permissões ERP (inclui contexto delegado de relatórios) |
| `/api/erp/pdv/value-accounts` | GET, POST | Sessão, empresa e permissões ERP (inclui contexto delegado de relatórios) |
| `/api/erp/planning` | GET, POST | Sessão, empresa e permissões ERP (inclui contexto delegado de relatórios) |
| `/api/erp/privacy` | GET, POST | Sessão, empresa e permissões ERP (inclui contexto delegado de relatórios) |
| `/api/erp/production` | GET, POST | Sessão, empresa e permissões ERP (inclui contexto delegado de relatórios) |
| `/api/erp/purchases/[id]` | PATCH | Sessão, empresa e permissões ERP (inclui contexto delegado de relatórios) |
| `/api/erp/purchases` | GET, POST | Sessão, empresa e permissões ERP (inclui contexto delegado de relatórios) |
| `/api/erp/reconciliation` | GET, POST | Sessão, empresa e permissões ERP (inclui contexto delegado de relatórios) |
| `/api/erp/reports/fiscal` | GET, PATCH | Sessão, empresa e permissões ERP (inclui contexto delegado de relatórios) |
| `/api/erp/reports/margins` | GET | Sessão, empresa e permissões ERP (inclui contexto delegado de relatórios) |
| `/api/erp/reports/products` | GET | Sessão, empresa e permissões ERP (inclui contexto delegado de relatórios) |
| `/api/erp/reports/sales` | GET | Sessão, empresa e permissões ERP (inclui contexto delegado de relatórios) |
| `/api/erp/reports/settings` | GET, PUT | Sessão, empresa e permissões ERP (inclui contexto delegado de relatórios) |
| `/api/erp/reports/top-sellers` | GET | Sessão, empresa e permissões ERP (inclui contexto delegado de relatórios) |
| `/api/erp/reports/totals` | GET | Sessão, empresa e permissões ERP (inclui contexto delegado de relatórios) |
| `/api/erp/reports/workspace` | GET, POST | Sessão, empresa e permissões ERP (inclui contexto delegado de relatórios) |
| `/api/erp` | GET, POST | Sessão, empresa e permissões ERP (inclui contexto delegado de relatórios) |
| `/api/erp/sales-expenses` | GET, POST | Sessão, empresa e permissões ERP (inclui contexto delegado de relatórios) |
| `/api/erp/service-orders` | GET, POST | Sessão, empresa e permissões ERP (inclui contexto delegado de relatórios) |
| `/api/erp/settings` | GET, PATCH, POST | Sessão, empresa e permissões ERP (inclui contexto delegado de relatórios) |
| `/api/erp/suppliers/[id]` | GET, PATCH | Sessão, empresa e permissões ERP (inclui contexto delegado de relatórios) |
| `/api/erp/suppliers` | GET, POST | Sessão, empresa e permissões ERP (inclui contexto delegado de relatórios) |
| `/api/erp/transactional-email` | GET, POST | Sessão, empresa e permissões ERP (inclui contexto delegado de relatórios) |
| `/api/erp/users` | GET, POST | Sessão, empresa e permissões ERP (inclui contexto delegado de relatórios) |
| `/api/erp/webhooks/[id]/deliveries` | GET | Sessão, empresa e permissões ERP (inclui contexto delegado de relatórios) |
| `/api/erp/webhooks/[id]` | PUT, DELETE, POST | Sessão, empresa e permissões ERP (inclui contexto delegado de relatórios) |
| `/api/erp/webhooks/deliveries/[id]/retry` | POST | Sessão, empresa e permissões ERP (inclui contexto delegado de relatórios) |
| `/api/erp/webhooks/deliveries/[id]` | GET, POST | Sessão, empresa e permissões ERP (inclui contexto delegado de relatórios) |
| `/api/erp/webhooks` | GET, POST | Sessão, empresa e permissões ERP (inclui contexto delegado de relatórios) |
| `/api/erp/webhooks/validate-url` | POST | Sessão, empresa e permissões ERP (inclui contexto delegado de relatórios) |
| `/api/health` | GET | Pública por finalidade; validação de entrada e escopo conforme endpoint |
| `/api/internal/billing/jobs` | POST | Token de serviço; escopo adicional nos workers PDV |
| `/api/internal/dfe/sync` | POST | Token de serviço; escopo adicional nos workers PDV |
| `/api/internal/pdv/fiscal/outbox/[organizationId]` | POST | Token de serviço; escopo adicional nos workers PDV |
| `/api/internal/pdv/fiscal/process` | POST | Token de serviço; escopo adicional nos workers PDV |
| `/api/internal/pdv/payment-compensations/outbox/[organizationId]` | POST | Token de serviço; escopo adicional nos workers PDV |
| `/api/internal/pdv/payment-compensations/process` | POST | Token de serviço; escopo adicional nos workers PDV |
| `/api/internal/pdv/payments/outbox/[organizationId]` | POST | Token de serviço; escopo adicional nos workers PDV |
| `/api/internal/pdv/payments/process` | POST | Token de serviço; escopo adicional nos workers PDV |
| `/api/internal/pdv/reconciliation/process` | POST | Token de serviço; escopo adicional nos workers PDV |
| `/api/internal/pdv/value-accounts/sweep` | POST | Token de serviço; escopo adicional nos workers PDV |
| `/api/media/[id]` | GET | Mídia pública explicitamente publicada; demais arquivos exigem superadministrador |
| `/api/portal/billing/files` | GET, POST | Sessão, vínculo ativo e billing.read / billing.write |
| `/api/portal/billing` | GET, POST | Sessão, vínculo ativo e billing.read / billing.write |
| `/api/pos-agent/[organizationId]/[terminalId]/pair` | POST | Pareamento / credencial do agente, empresa e terminal |
| `/api/pos-agent/[organizationId]/[terminalId]` | POST | Pareamento / credencial do agente, empresa e terminal |
| `/api/pos-agent/[organizationId]/[terminalId]/sync` | POST | Pareamento / credencial do agente, empresa e terminal |
| `/api/public/avaliacoes/[token]` | GET, POST | Pública por finalidade; validação de entrada e escopo conforme endpoint |
| `/api/public/pedidos/rastreio` | POST | Pública por finalidade; validação de entrada e escopo conforme endpoint |
| `/api/public/plans` | GET | Pública por finalidade; validação de entrada e escopo conforme endpoint |
| `/api/public/site` | GET | Pública por finalidade; validação de entrada e escopo conforme endpoint |
| `/api/saas` | GET, POST | Superadministrador |
| `/api/webhooks/billing` | POST | Assinatura e segredo do provedor; controle de repetição |
| `/api/webhooks/integrations/[organizationId]/[provider]` | POST | Assinatura e segredo do provedor; controle de repetição |
| `/api/webhooks/pos-fiscal/[organizationId]/[provider]` | POST | Assinatura e segredo do provedor; controle de repetição |
| `/api/webhooks/pos-payment-compensations/[organizationId]/[provider]` | POST | Assinatura e segredo do provedor; controle de repetição |
| `/api/webhooks/pos-payments/[organizationId]/[provider]` | POST | Assinatura e segredo do provedor; controle de repetição |
| `/api/internal/analytics/jobs` | POST | Bearer de serviço, comparação em tempo constante e destino restrito no agendador |
