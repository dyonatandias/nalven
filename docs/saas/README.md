# Mapa do Plano de Controle SaaS

O painel `/admin` administra a plataforma; `/erp` nunca consulta dados operacionais de outra organização. O banco central armazena somente identidade, membership, plano, provisionamento e referências protegidas para infraestrutura.

## Superfícies administrativas

| Rota | Responsabilidade | Fonte de verdade |
|---|---|---|
| `/admin` | indicadores globais | banco de controle |
| `/admin/organizacoes` | ciclo de vida, plano e estado | controle + Billing |
| `/admin/usuarios` | identidades e memberships | banco de controle |
| `/admin/ambientes` | banco, versão e saúde por tenant | registro de ambientes |
| `/admin/integracoes` | Billing, credenciais e reconciliação | cofre + Billing |
| `/admin/backups` | execução, retenção e restauração | jobs por banco |
| `/admin/exportacoes` | arquivos assíncronos e expiração | jobs autorizados |
| `/admin/provisionamento` | criação e migração de bancos | fila idempotente |
| `/admin/sistema` | serviços, runtime e capacidade | probes reais |
| `/admin/auditoria` | ações administrativas | audit log central |
| `/admin/gestao` | site público e planos | conteúdo no PostgreSQL |
| `/admin/biblioteca` | mídia reutilizável | storage + metadados |
| `/admin/seo` | metadados, canonical e sitemap | banco de controle |
| `/admin/blog` | conteúdo editorial | banco de controle |
| `/admin/glossario` | termos públicos | banco de controle |
| `/admin/perfil` | conta e sessões do operador | identidade central |

## Isolamento obrigatório

Cada organização possui um registro `TenantDatabase` apontando para um banco PostgreSQL exclusivo e uma `configKey` validada. A credencial não fica no banco central nem no código. A resolução parte da sessão e da membership ativa; o navegador não escolhe o tenant por parâmetro. Não existe fallback para banco compartilhado.

## Gate para produção

Uma organização só fica operacional após criação da role/database, aplicação integral das migrations, seed idempotente, health check e registro da versão. Falhas ficam na fila para retry e não reutilizam o banco de outro cliente. Consulte também [Arquitetura Multi-tenant](../erp/ARQUITETURA-MULTITENANT.md) e [SaaS Control Plane](../SAAS-CONTROL-PLANE.md).
