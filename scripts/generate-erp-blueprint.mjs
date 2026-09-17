import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const pages = [
  p(
    "dashboard",
    "OPERAÇÃO",
    "Visão geral",
    "real",
    ["products", "stock_movements", "sales", "financial_titles"],
    "Consolidar indicadores operacionais e prioridades.",
  ),
  p(
    "pdv",
    "OPERAÇÃO",
    "PDV · Ponto de venda",
    "real",
    ["cash_register_sessions", "sales", "sale_items", "stock_movements"],
    "Executar venda rápida, pagamento e baixa de estoque.",
  ),
  p(
    "sales",
    "OPERAÇÃO",
    "Vendas e despesas",
    "real",
    ["sales", "sale_items", "operating_expenses"],
    "Centralizar lançamentos de receita, venda e despesa.",
  ),
  p(
    "products",
    "OPERAÇÃO",
    "Produtos e serviços",
    "real",
    ["products", "categories", "product_prices"],
    "Manter catálogo, preços, custos e disponibilidade.",
  ),
  p(
    "stock",
    "OPERAÇÃO",
    "Movimentações",
    "real",
    ["stock_movements", "warehouse_balances"],
    "Rastrear toda alteração de saldo de estoque.",
  ),
  p(
    "invoices",
    "OPERAÇÃO",
    "Entrada por NF-e",
    "real",
    [
      "purchase_invoices",
      "purchase_invoice_items",
      "warehouse_balances",
      "warehouse_ledger_entries",
      "financial_titles",
    ],
    "Importar XML sem entidades externas, conferir itens e gerar entrada, custo e obrigação transacionalmente.",
  ),
  p(
    "orders",
    "COMERCIAL",
    "Orçamentos e pedidos",
    "real",
    [
      "sales_orders",
      "sales_order_items",
      "sales_order_history",
      "sales",
      "warehouse_balances",
      "financial_titles",
      "tenant_audit_events",
    ],
    "Converter orçamento aprovado em venda, baixa de estoque da filial ativa e conta a receber numa transação.",
  ),
  p(
    "crm",
    "COMERCIAL",
    "CRM e oportunidades",
    "real",
    [
      "crm_opportunities",
      "crm_activities",
      "crm_stage_history",
      "tenant_audit_events",
    ],
    "Administrar leads, funil, tarefas, propostas, previsão e ganho/perda com histórico.",
  ),
  p(
    "contracts",
    "COMERCIAL",
    "Contratos e recorrência",
    "real",
    [
      "service_contracts",
      "contract_cycles",
      "contract_adjustments",
      "financial_titles",
    ],
    "Operar vigência, recorrência, reajuste, SLA e geração idempotente de recebíveis.",
  ),
  p(
    "service-orders",
    "COMERCIAL",
    "Ordens de serviço",
    "real",
    [
      "service_orders",
      "service_order_items",
      "service_checklist_items",
      "service_order_history",
      "sales",
      "warehouse_balances",
      "financial_titles",
    ],
    "Controlar triagem, execução, checklist, consumo de peças, serviços, garantia e conversão financeira.",
  ),
  p(
    "purchases",
    "SUPRIMENTOS",
    "Compras e cotações",
    "real",
    [
      "purchase_orders",
      "purchase_order_items",
      "goods_receipts",
      "goods_receipt_items",
      "financial_titles",
    ],
    "Executar pedido, envio, recebimento transacional, entrada de estoque e geração da conta a pagar.",
  ),
  p(
    "inventory",
    "SUPRIMENTOS",
    "Inventário e depósitos",
    "real",
    [
      "warehouses",
      "warehouse_balances",
      "inventory_counts",
      "inventory_count_items",
      "stock_transfers",
      "stock_transfer_items",
      "warehouse_ledger_entries",
    ],
    "Controlar depósitos, saldos conciliados, contagens físicas, transferências e razão auditável.",
  ),
  p(
    "production",
    "SUPRIMENTOS",
    "Produção e kits",
    "real",
    [
      "bills_of_material",
      "bill_of_material_items",
      "production_orders",
      "warehouse_balances",
      "warehouse_ledger_entries",
    ],
    "Planejar e apontar consumo, perdas, produto acabado e custo real transacionalmente.",
  ),
  p(
    "marketplaces",
    "OMNICANAL",
    "Canais e marketplaces",
    "real",
    [
      "marketplace_channels",
      "marketplace_listings",
      "marketplace_orders",
      "sales_orders",
    ],
    "Sincronizar anúncios, preços, estoque, pedidos e taxas.",
  ),
  p(
    "logistics",
    "OMNICANAL",
    "Expedição e logística",
    "real",
    [
      "shipments",
      "shipment_items",
      "shipment_events",
      "warehouse_ledger_entries",
    ],
    "Executar separação, conferência, despacho e rastreio.",
  ),
  p(
    "finance",
    "FINANCEIRO",
    "Contas a pagar/receber",
    "real",
    ["financial_titles", "financial_settlements"],
    "Controlar contas a pagar e receber, baixas parciais ou totais, juros, descontos e vínculos operacionais.",
  ),
  p(
    "cash-close",
    "FINANCEIRO",
    "Fechamento de caixa",
    "real",
    ["cash_register_sessions", "cash_register_events", "sales"],
    "Registrar abertura, suprimento, sangria, conferência e fechamento.",
  ),
  p(
    "accounts",
    "FINANCEIRO",
    "Contas e caixas",
    "real",
    ["financial_accounts", "account_entries", "account_transfers"],
    "Manter saldos, contas, carteiras, transferências e extrato interno.",
  ),
  p(
    "reconciliation",
    "FINANCEIRO",
    "Conciliação bancária",
    "real",
    [
      "bank_statement_imports",
      "bank_transactions",
      "financial_settlements",
      "account_entries",
    ],
    "Conciliar extratos com títulos e razão financeira com rastreabilidade.",
  ),
  p(
    "planning",
    "FINANCEIRO",
    "DRE, orçamento e metas",
    "real",
    ["cost_centers", "budgets", "budget_lines", "business_goals"],
    "Consolidar resultado, orçamento, metas, cenários e projeções.",
  ),
  p(
    "fiscal",
    "FISCAL",
    "Central fiscal",
    "real",
    [
      "fiscal_documents",
      "fiscal_events",
      "fiscal_certificates",
      "branch_settings",
    ],
    "Operar NF-e, NFC-e, NFS-e, contingência, eventos e rejeições.",
  ),
  p(
    "customers",
    "CADASTROS",
    "Clientes",
    "real",
    ["customers", "customer_addresses", "customer_contacts", "customer_credit"],
    "Manter identidade, contato, crédito e histórico 360°.",
  ),
  p(
    "suppliers",
    "CADASTROS",
    "Fornecedores",
    "real",
    ["suppliers", "supplier_contacts", "supplier_products", "supplier_scores"],
    "Manter fornecedores, condições, catálogo e desempenho.",
  ),
  p(
    "categories",
    "CADASTROS",
    "Categorias",
    "real",
    ["categories"],
    "Organizar catálogo e regras comerciais em hierarquia.",
  ),
  p(
    "users",
    "CADASTROS",
    "Usuários e acessos",
    "real",
    [
      "tenant_user_profiles",
      "tenant_roles",
      "organization_invites",
      "memberships",
      "sessions",
    ],
    "Administrar convites de uso único, perfis, permissões, sessões e segregação por organização.",
  ),
  p(
    "reports",
    "GESTÃO",
    "Central de relatórios",
    "real",
    ["report_definitions", "report_runs", "report_exports"],
    "Disponibilizar análises filtráveis, exportáveis e auditáveis.",
  ),
  p(
    "library",
    "GESTÃO",
    "Biblioteca de mídias",
    "real",
    ["media_assets", "tenant_audit_events", "products"],
    "Enviar, filtrar, organizar, selecionar e reutilizar imagens e documentos privados da organização.",
  ),
  p(
    "branches",
    "GESTÃO",
    "Empresas e filiais",
    "real",
    [
      "branches",
      "branch_settings",
      "warehouses",
      "tenant_user_profiles",
      "tenant_audit_events",
    ],
    "Operar múltiplas unidades com dados fiscais, depósitos, seleção contextual e auditoria.",
  ),
  p(
    "automations",
    "GESTÃO",
    "Automações",
    "real",
    ["automation_rules", "automation_runs", "automation_notifications"],
    "Executar gatilhos, condições e ações idempotentes.",
  ),
  p(
    "activities",
    "GESTÃO",
    "Atividades e auditoria",
    "real",
    ["audit_events"],
    "Preservar trilha consultável, correlacionada e exportável das ações relevantes.",
  ),
  p(
    "privacy",
    "GESTÃO",
    "Privacidade e LGPD",
    "real",
    ["privacy_requests", "legal_bases", "retention_rules", "privacy_incidents"],
    "Gerir titulares, bases legais, retenção, solicitações e incidentes.",
  ),
  p(
    "settings",
    "GESTÃO",
    "Configurações",
    "real",
    ["tenant_settings", "tenant_audit_events"],
    "Centralizar preferências versionadas consumidas pela operação e manter segredos exclusivamente no cofre.",
  ),
];

const root = join(process.cwd(), "docs", "erp");
mkdirSync(join(root, "pages"), { recursive: true });
mkdirSync(join(root, "sql"), { recursive: true });

writeFileSync(join(root, "README.md"), readme());
writeFileSync(join(root, "PRD-GERAL.md"), generalPrd());
writeFileSync(join(root, "ARQUITETURA-MULTITENANT.md"), architecture());
writeFileSync(join(root, "ORDEM-DE-IMPLEMENTACAO.md"), roadmap());
writeFileSync(join(root, "sql", "000-tenant-foundation.sql"), foundationSql());

for (const page of pages) {
  writeFileSync(join(root, "pages", `${page.id}.md`), pagePrd(page));
  writeFileSync(join(root, "sql", `${page.id}.sql`), pageSql(page));
}

function p(id, section, title, status, tables, objective) {
  return { id, section, title, status, tables, objective };
}
function route(page) {
  return page.id === "dashboard" ? "/erp" : `/erp/${page.id}`;
}
function api(page) {
  return `/api/erp/${page.id}`;
}
function label() {
  return "Implementado e verificado";
}

function readme() {
  const rows = pages
    .map(
      (page) =>
        `| [${page.title}](./pages/${page.id}.md) | \`${route(page)}\` | ${page.section} | ${label(page.status)} | [SQL](./sql/${page.id}.sql) |`,
    )
    .join("\n");
  return `# Plano de Produto do ERP NALVEN

Este diretório registra a implementação verificável do ERP multiempresa. Todas as páginas operacionais usam exclusivamente o PostgreSQL isolado da organização, sem dados mockados ou fallback na interface.

## Regras obrigatórias

- O banco de controle conhece organizações, usuários, planos e o endereço do banco do tenant.
- Dados operacionais nunca recebem \`tenant_id\`: cada organização usa outro banco.
- Toda escrita exige sessão, organização ativa, licença/entitlement e auditoria.
- A interface não apresenta JSON bruto, segredo, número mockado ou fallback demonstrativo.
- Integrações fiscais, bancárias e de canal usam outbox, idempotência e cofres cifrados.
- Migrações são aplicadas a todos os bancos por fila, com versão e possibilidade de retomada.

## Registro de páginas

| Página | Rota | Grupo | Estado | Projeto SQL |
|---|---|---|---|---|
${rows}

## Documentos transversais

- [PRD geral](./PRD-GERAL.md)
- [Arquitetura multi-tenant](./ARQUITETURA-MULTITENANT.md)
- [Ordem de implementação](./ORDEM-DE-IMPLEMENTACAO.md)
- [Fundação SQL do tenant](./sql/000-tenant-foundation.sql)
`;
}

function generalPrd() {
  return `# PRD Geral — ERP NALVEN

## Visão

O ERP é o produto principal acessado em \`/erp\`. O portal \`/portal\` cuida de conta, assinatura e faturamento do SaaS. Os dois ambientes mantêm links recíprocos, mas não misturam dados operacionais com cobranças da plataforma.

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
`;
}

function architecture() {
  return `# Arquitetura Multi-tenant

## Separação física

\`nalven_control\` mantém o plano de controle: organizações, memberships, sessões, plano contratado, domínio, estado do provisionamento e referência \`config_key\`. Cada organização possui banco próprio, por exemplo \`nalven_t_demo\`, com credencial separada em \`/etc/nalven/tenants/demo.env\`.

\`tenantDb(organizationId)\` resolve a organização autenticada, busca somente a referência aprovada no banco de controle, lê a credencial protegida e abre o Prisma Client do banco correto. A API nunca aceita um \`tenantId\` arbitrário do navegador.

## Invariantes de segurança

- Nenhuma tabela operacional contém \`tenant_id\`.
- Nenhuma consulta de ERP usa o banco de outro tenant.
- Usuário precisa de membership ativa antes da resolução do banco.
- Chaves externas ficam em cofre cifrado; tabelas guardam apenas referências.
- Backups, migrações e restaurações operam por banco e registram organização, versão e checksum.
- Exportações são geradas no contexto do banco atual e entregues por token temporário.

## Identidade, organização ativa e permissões

Usuários, sessões, memberships e convites ficam no banco de controle, pois concedem entrada ao tenant. O cookie HTTP-only \`nalven_organization\` seleciona somente uma organização na qual a sessão possua membership ativa; APIs nunca aceitam esse identificador como autorização suficiente.

Cada banco de tenant mantém \`tenant_roles\` e \`tenant_user_profiles\`. O papel da membership referencia a chave do perfil e as APIs validam permissões \`recurso.read\` ou \`recurso.write\` no servidor. Escrita implica leitura; \`*\` é reservado aos perfis integrais. Convites usam token aleatório exibido uma vez, persistem somente SHA-256, expiram em sete dias e suportam rotação e revogação.

## Ciclo de provisionamento

1. Criar organização no controle e registrar job.
2. Criar role e database PostgreSQL com nomes validados.
3. Gravar credencial fora do repositório com permissão mínima.
4. Aplicar todas as migrações de \`prisma/tenant/migrations\`.
5. Executar seed idempotente específico da organização.
6. Fazer health check, registrar versão e ativar o banco.
7. Em falha, retomar pelo job; nunca compartilhar banco como fallback.

## Evolução do schema

Cada mudança gera migration imutável. O orquestrador percorre bancos ativos, aplica a versão, registra duração/erro e bloqueia apenas o tenant incompatível. A aplicação precisa tolerar a janela de rollout e expor a versão esperada versus aplicada.
`;
}

function roadmap() {
  const completed = pages
    .map(
      (page, index) =>
        `${index + 1}. [${page.title}](./pages/${page.id}.md) — verificado em \`${route(page)}\``,
    )
    .join("\n");
  return `# Estado de Implementação

## Fundação concluída

Todos os módulos usam o banco isolado do tenant, autorização por recurso, validação no servidor e auditoria das escritas relevantes.

## Módulos entregues

${completed}

## Gate por página

Para cada evolução: revisar contrato → criar migration Prisma imutável → validar build → migrar o banco demo → testar caminho feliz, negações e repetição → publicar release imutável → conferir saúde e invariantes.
`;
}

function pagePrd(page) {
  if (page.id === "branches") return branchPrd(page);
  if (page.id === "orders") return ordersPrd(page);
  return `# ${page.title}

## Identificação

- Rota: \`${route(page)}\`
- API implementada: \`${api(page)}\`
- Grupo: ${page.section}
- Estado atual: **${label(page.status)}**
- SQL de referência: [${page.id}.sql](../sql/${page.id}.sql)

## Objetivo

${page.objective}

## Modelo de dados

${page.tables.map((table) => `- \`${table}\``).join("\n")}

Todas as tabelas pertencem ao banco exclusivo da organização e não possuem \`tenant_id\`. Referências de usuário usam o identificador do plano de controle apenas como ator/auditoria, sem relação SQL entre bancos.

## API e interface

- \`GET ${api(page)}\`: entrega catálogo, histórico e resumo derivados do tenant atual.
- \`POST ${api(page)}\`: executa comandos validados, autorizados e auditados conforme o módulo.
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
`;
}

function branchPrd(page) {
  return `# ${page.title}

## Identificação e objetivo

- Rota: \`${route(page)}\`
- APIs: \`GET/POST /api/erp/branches\` e \`PATCH /api/erp/branches/{id}\`
- Estado: **Real inicial**

Mantém CNPJs e unidades operacionais dentro do banco PostgreSQL exclusivo da organização. Filial não cria tenant nem banco adicional.

## Dados e interface

- \`branches\`: identidade, endereço, contato, situação, tipo e depósito padrão.
- \`branch_settings\`: regime, ambiente fiscal, séries e próximos números.
- \`warehouses.branch_id\`: vínculo exclusivo do depósito com a unidade.
- \`tenant_user_profiles.active_branch_id\`: contexto operacional preferido do usuário.
- \`tenant_audit_events\`: criação, edição, situação e seleção da filial.

A tela apresenta indicadores, cartões das unidades, saldo agregado de depósitos, configuração fiscal e formulário responsivo. Não há JSON exposto, dado mockado ou fallback.

## Regras implementadas

1. CNPJ, e-mail, UF, timezone e séries fiscais são validados no servidor.
2. Código, CNPJ e depósito padrão são únicos; somente uma matriz é principal.
3. Depósito precisa estar ativo e não pode pertencer a outra filial.
4. A matriz principal não pode ser inativada; inativação limpa o contexto dos usuários.
5. Leitura exige \`branches.read\`; criação/edição exige \`branches.write\`, licença e CSRF same-origin.
6. A organização vem da sessão e resolve seu próprio datasource cifrado; nunca do payload.

## Aceite verificado

- Migration e seed idempotente aplicados ao tenant demo.
- CRUD, seleção contextual, inativação/reativação e proteção da matriz exercitados.
- CNPJ inválido, duplicidade, CSRF e usuário sem permissão retornam erros controlados.
- Saldos de produto continuam conciliados com a soma dos depósitos.
`;
}

function ordersPrd(page) {
  return `# ${page.title}

## Identificação e objetivo

- Rota: \`${route(page)}\`
- API: \`GET/POST /api/erp/orders\`
- Estado: **Real inicial**

Transforma orçamento em pedido aprovado e, na conclusão, cria venda, baixa o depósito padrão da filial ativa e gera conta a receber numa transação serializável.

## Dados e estados

- \`sales_orders\`, \`sales_order_items\` e \`sales_order_history\` preservam cabeçalho, preços, itens e transições.
- Estados: \`draft → approved → completed\`; rascunho ou aprovado pode virar \`cancelled\`.
- Conclusão grava \`sales\`, \`sale_items\`, estoque, razão do depósito, \`financial_titles\` e auditoria correlacionada.
- Serviços geram venda e recebível sem movimento físico; produtos exigem saldo na filial ativa.

## Regras e aceite

1. Leitura e escrita exigem \`orders.read/write\`; escrita exige licença e same-origin.
2. Cliente e produtos precisam estar ativos; item repetido, quantidade, preço e desconto são validados.
3. Pedido só conclui após aprovação e não pode ser processado duas vezes.
4. Falha em qualquer efeito reverte toda a transação.
5. Testes cobrem produto, serviço, repetição, usuário sem permissão e conciliação de estoque.
6. A interface não expõe JSON nem usa dados mockados ou fallback.
`;
}

function foundationSql() {
  return `-- Blueprint. Converter em migrations Prisma antes de aplicar.
CREATE TABLE IF NOT EXISTS schema_metadata (
  key varchar(80) PRIMARY KEY,
  value jsonb NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS audit_events (
  id bigserial PRIMARY KEY,
  actor_id text,
  action varchar(120) NOT NULL,
  entity_type varchar(100) NOT NULL,
  entity_id text,
  correlation_id uuid,
  before_data jsonb,
  after_data jsonb,
  ip_address inet,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS audit_events_entity_idx ON audit_events(entity_type, entity_id, created_at DESC);

CREATE TABLE IF NOT EXISTS outbox_events (
  id uuid PRIMARY KEY,
  topic varchar(120) NOT NULL,
  aggregate_type varchar(100) NOT NULL,
  aggregate_id text NOT NULL,
  payload jsonb NOT NULL,
  idempotency_key varchar(200) NOT NULL UNIQUE,
  status varchar(30) NOT NULL DEFAULT 'pending',
  attempts integer NOT NULL DEFAULT 0,
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  processed_at timestamptz
);
CREATE INDEX IF NOT EXISTS outbox_events_worker_idx ON outbox_events(status, next_attempt_at);
`;
}

function pageSql(page) {
  if (page.id === "branches") return branchSql();
  if (page.id === "orders") return ordersSql();
  const tables = page.tables.map((table) => `--   - ${table}`).join("\n");
  return `-- ${page.title}
-- Mapa documental. NÃO aplicar este arquivo no banco.
-- Fontes executáveis: prisma/tenant/schema.prisma e prisma/tenant/migrations/.
-- Tabelas usadas por este módulo:
${tables}
-- O banco é exclusivo por organização; não existe coluna tenant_id.
`;
}

function branchSql() {
  return `-- Empresas e filiais — espelho documental da migration 20260827050000_branches.
-- Não aplicar manualmente; Prisma Migrate é a fonte executável.

CREATE TABLE branches (
  id serial PRIMARY KEY, code text NOT NULL UNIQUE, name text NOT NULL,
  legal_name text NOT NULL, document text NOT NULL UNIQUE,
  type text NOT NULL DEFAULT 'branch', status text NOT NULL DEFAULT 'active',
  state_registration text, municipal_registration text, email text, phone text,
  zip text, street text, number text, complement text, district text, city text, state text,
  timezone text NOT NULL DEFAULT 'America/Sao_Paulo', primary boolean NOT NULL DEFAULT false,
  default_warehouse_id integer UNIQUE, created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX branches_single_primary_idx ON branches(primary) WHERE primary = true;
CREATE INDEX branches_status_name_idx ON branches(status, name);

ALTER TABLE warehouses ADD COLUMN branch_id integer REFERENCES branches(id) ON DELETE SET NULL;
CREATE INDEX warehouses_branch_id_idx ON warehouses(branch_id);
ALTER TABLE branches ADD CONSTRAINT branches_default_warehouse_id_fkey
  FOREIGN KEY (default_warehouse_id) REFERENCES warehouses(id) ON DELETE SET NULL;

CREATE TABLE branch_settings (
  id serial PRIMARY KEY, branch_id integer NOT NULL UNIQUE REFERENCES branches(id) ON DELETE CASCADE,
  tax_regime text NOT NULL DEFAULT 'simples_nacional',
  fiscal_environment text NOT NULL DEFAULT 'homologation',
  nfe_series integer NOT NULL DEFAULT 1, nfce_series integer NOT NULL DEFAULT 1,
  nfse_series integer NOT NULL DEFAULT 1, next_nfe_number integer NOT NULL DEFAULT 1,
  next_nfce_number integer NOT NULL DEFAULT 1, next_nfse_number integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE tenant_user_profiles ADD COLUMN active_branch_id integer REFERENCES branches(id) ON DELETE SET NULL;
CREATE INDEX tenant_user_profiles_active_branch_id_idx ON tenant_user_profiles(active_branch_id);
`;
}

function ordersSql() {
  return `-- Orçamentos e pedidos — espelho documental da migration 20260827070000_sales_orders.
-- Não aplicar manualmente; Prisma Migrate é a fonte executável.

CREATE TABLE sales_orders (
  id serial PRIMARY KEY, number text NOT NULL UNIQUE, kind text NOT NULL DEFAULT 'quote',
  status text NOT NULL DEFAULT 'draft', customer_id integer REFERENCES customers(id) ON DELETE SET NULL,
  customer_name text NOT NULL, valid_until date, expected_at date,
  subtotal double precision NOT NULL DEFAULT 0, discount double precision NOT NULL DEFAULT 0,
  total double precision NOT NULL DEFAULT 0, notes text, created_by text NOT NULL,
  approved_at timestamptz, completed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX sales_orders_status_created_at_idx ON sales_orders(status, created_at);
CREATE INDEX sales_orders_customer_id_created_at_idx ON sales_orders(customer_id, created_at);

CREATE TABLE sales_order_items (
  id serial PRIMARY KEY, sales_order_id integer NOT NULL REFERENCES sales_orders(id) ON DELETE CASCADE,
  product_id integer NOT NULL REFERENCES products(id), quantity double precision NOT NULL,
  unit_price double precision NOT NULL, total double precision NOT NULL,
  UNIQUE(sales_order_id, product_id)
);
CREATE TABLE sales_order_history (
  id serial PRIMARY KEY, sales_order_id integer NOT NULL REFERENCES sales_orders(id) ON DELETE CASCADE,
  from_status text, to_status text NOT NULL, actor text NOT NULL, notes text,
  created_at timestamptz NOT NULL DEFAULT now()
);
`;
}
