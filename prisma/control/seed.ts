import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../../generated/control/client";
import { hashPassword } from "../../lib/password";
import { deriveRbacModules } from "../../lib/billing/module-map";

const url = process.env.CONTROL_DATABASE_URL;
if (!url) throw new Error("CONTROL_DATABASE_URL não foi definida");
const controlDb = new PrismaClient({ adapter: new PrismaPg({ connectionString: url }) });

// Dev/test fixture mirroring Billing's real catalog (see vendor/billing-integration/docs/integracao-nalven/catalogo-e-entitlements.md).
// Local dev has no live Billing credential, so this seeds a representative snapshot instead of running the real sync — run
// "Sincronizar catálogo" in /admin/planos against a real Billing credential to refresh it for good.
const essencialModules = ["gestao_base", "catalogo_estoque", "pdv_vendas", "financeiro_base"];
const profissionalModules = [...essencialModules, "vendas_pedidos", "compras_fiscal", "crm", "servicos_recorrencia", "operacao_avancada", "governanca_analytics"];
const omnichannelModules = [...profissionalModules, "multiempresa_producao", "omnichannel"];
const seedCredentialRotationKey = "security.seed-credentials.v1";

async function main() {
  await Promise.all([
    controlDb.plan.upsert({ where: { id: "essencial" }, update: {}, create: { id: "essencial", code: "essencial", name: "Essencial", monthlyPrice: 149, cardMonthlyPrice: 169, annualPrice: 1490, seats: 3, billingModules: essencialModules, modules: deriveRbacModules(essencialModules), lastSyncedAt: new Date() } }),
    controlDb.plan.upsert({ where: { id: "profissional" }, update: {}, create: { id: "profissional", code: "profissional", name: "Profissional", monthlyPrice: 349, cardMonthlyPrice: 369, annualPrice: 3490, seats: 8, billingModules: profissionalModules, modules: deriveRbacModules(profissionalModules), lastSyncedAt: new Date() } }),
    controlDb.plan.upsert({ where: { id: "omnichannel" }, update: {}, create: { id: "omnichannel", code: "omnichannel", name: "Omnichannel", monthlyPrice: 697, cardMonthlyPrice: 717, annualPrice: 6970, seats: 15, billingModules: omnichannelModules, modules: deriveRbacModules(omnichannelModules), lastSyncedAt: new Date() } }),
  ]);
  const adminEmail = (process.env.SUPERADMIN_EMAIL || "admin@nalven.com.br").toLowerCase();
  const adminPassword = requiredSeedSecret("SUPERADMIN_PASSWORD");
  const demoPassword = requiredSeedSecret("DEMO_USER_PASSWORD");
  const [existingAdmin, credentialRotation] = await Promise.all([
    controlDb.user.findUnique({ where: { email: adminEmail } }),
    controlDb.systemSetting.findUnique({ where: { key: seedCredentialRotationKey } }),
  ]);
  const [adminPasswordHash, demoPasswordHash] = await Promise.all([
    hashPassword(adminPassword),
    hashPassword(demoPassword),
  ]);
  const admin = existingAdmin || await controlDb.user.create({ data: { name: "Administrador NALVEN", email: adminEmail, passwordHash: adminPasswordHash, role: "superadmin", emailVerifiedAt: new Date() } });
  await controlDb.organization.upsert({
    where: { id: "org-demo" }, update: {},
    create: { id: "org-demo", slug: "demo", name: "Auto Mais Peças", document: "98.765.432/0001-98", ownerName: "Dyonatan Dias", email: "dyonatan@automais.com.br", planId: "profissional", status: "active", seatsUsed: 7, modules: deriveRbacModules(profissionalModules), usageScore: 92 }
  });
  await controlDb.tenantDatabase.upsert({
    where: { organizationId: "org-demo" }, update: {},
    create: { organizationId: "org-demo", databaseName: "nalven_t_demo", configKey: "demo", schemaVersion: "20260826140500" }
  });
  await Promise.all([
    controlDb.organizationDomain.upsert({ where: { hostname: "nalven.com.br" }, update: {}, create: { organizationId: "org-demo", hostname: "nalven.com.br", primary: true } }),
    controlDb.organizationDomain.upsert({ where: { hostname: "www.nalven.com.br" }, update: {}, create: { organizationId: "org-demo", hostname: "www.nalven.com.br" } })
  ]);
  const owner = await controlDb.user.upsert({ where: { email: "demo@nalven.com.br" }, update: { status: "active" }, create: { name: "Dyonatan Dias", email: "demo@nalven.com.br", passwordHash: demoPasswordHash, role: "user", emailVerifiedAt: new Date() } });
  if (!credentialRotation) {
    const completedAt = new Date();
    await controlDb.$transaction(async (tx) => {
      await tx.user.update({ where: { id: admin.id }, data: { passwordHash: adminPasswordHash } });
      await tx.user.update({ where: { id: owner.id }, data: { passwordHash: demoPasswordHash } });
      await tx.session.deleteMany({ where: { userId: { in: [admin.id, owner.id] } } });
      await tx.systemSetting.create({
        data: {
          key: seedCredentialRotationKey,
          value: { completedAt: completedAt.toISOString(), reason: "known-seed-credential-remediation" },
        },
      });
      await tx.auditLog.create({
        data: {
          userId: admin.id,
          action: "security.seed_credentials.rotated",
          entityType: "security_control",
          entityId: seedCredentialRotationKey,
          metadata: { completedAt: completedAt.toISOString(), sessionsRevoked: true },
        },
      });
    });
  }
  await controlDb.membership.upsert({ where: { userId_organizationId: { userId: owner.id, organizationId: "org-demo" } }, update: {}, create: { userId: owner.id, organizationId: "org-demo", role: "owner" } });
  await Promise.all([
    controlDb.systemSetting.upsert({ where: { key: "saas" }, update: {}, create: { key: "saas", value: { name: "NALVEN", domain: "nalven.com.br", trialDays: 14, tenantIsolation: "database-per-tenant" } } })
  ]);
  for (const integration of [{ provider: "smtp", name: "E-mail transacional" }, { provider: "payments", name: "Gateway de pagamentos" }]) {
    const found = await controlDb.integration.findFirst({ where: { organizationId: null, provider: integration.provider } });
    if (!found) await controlDb.integration.create({ data: { ...integration, status: "pending_configuration" } });
  }
  const content = [
    ["brand.name", "brand", "Nome da marca", "text", "NALVEN", 0],
    ["brand.description", "brand", "Descrição SEO", "textarea", "Gestão empresarial modular, segura e conectada.", 1],
    ["hero.eyebrow", "hero", "Chamada superior", "text", "GESTÃO MODULAR PARA EMPRESAS REAIS", 0],
    ["hero.title", "hero", "Título principal", "textarea", "Um ERP completo que cresce junto com sua empresa.", 1],
    ["hero.description", "hero", "Descrição", "textarea", "Vendas, estoque, financeiro, fiscal e relacionamento em uma plataforma segura, com dados isolados por organização.", 2],
    ["hero.primaryCta", "hero", "Botão principal", "text", "Testar por 14 dias", 3],
    ["hero.secondaryCta", "hero", "Botão secundário", "text", "Ver planos", 4],
    ["features.items", "features", "Recursos", "json", [{ title: "Operação conectada", description: "Centralize vendas, compras, estoque e serviços." }, { title: "Financeiro claro", description: "Contas, fluxo de caixa e relatórios em tempo real." }, { title: "Segurança por tenant", description: "Cada organização opera em um banco PostgreSQL separado." }], 0],
    ["plans.eyebrow", "plans", "Chamada dos planos", "text", "PLANOS", 0],
    ["plans.title", "plans", "Título dos planos", "text", "Escolha o ponto de partida", 1],
    ["footer.text", "footer", "Rodapé", "text", "© 2026 NALVEN · nalven.com.br", 0]
  ] as const;
  for (const [key, group, label, type, value, sortOrder] of content) await controlDb.siteContent.upsert({ where: { key }, update: {}, create: { key, group, label, type, value, sortOrder } });
  for (const template of [
    { id: "welcome", name: "Boas-vindas", subject: "Bem-vindo à NALVEN", body: "Olá {{name}}, sua organização {{organization}} foi criada." },
    { id: "password-reset", name: "Redefinição de senha", subject: "Redefina sua senha", body: "Use o link {{resetUrl}} para criar uma nova senha." },
    { id: "invoice-due", name: "Fatura próxima do vencimento", subject: "Sua fatura NALVEN vence em breve", body: "A fatura {{invoice}} vence em {{dueAt}}." }
  ]) await controlDb.emailTemplate.upsert({ where: { id: template.id }, update: {}, create: template });
  await controlDb.seoEntry.upsert({ where: { path: "/" }, update: {}, create: { path: "/", title: "NALVEN — Gestão empresarial conectada", description: "ERP modular para vendas, estoque, financeiro, fiscal e operação.", canonical: "https://nalven.com.br" } });
  await controlDb.blogPost.upsert({ where: { slug: "gestao-integrada-na-pratica" }, update: {}, create: { slug: "gestao-integrada-na-pratica", title: "Gestão integrada na prática", excerpt: "Entenda por que dados conectados reduzem retrabalho e melhoram decisões.", content: "Uma gestão integrada conecta as áreas da empresa em uma única fonte de informação.\n\nQuando vendas, estoque e financeiro compartilham dados, a equipe reduz digitação duplicada e ganha previsibilidade.", status: "published", authorName: "Equipe NALVEN", seoTitle: "Gestão integrada na prática | NALVEN", seoDescription: "Conheça os benefícios de integrar vendas, estoque e financeiro.", publishedAt: new Date() } });
  await controlDb.glossaryTerm.upsert({ where: { slug: "erp" }, update: {}, create: { slug: "erp", term: "ERP", definition: "Sistema integrado que centraliza processos e informações de diferentes áreas de uma empresa.", related: ["gestão", "estoque", "financeiro"], status: "published" } });
  await controlDb.billingAccount.upsert({where:{organizationId:"org-demo"},update:{},create:{organizationId:"org-demo",externalId:"demo",planCode:"profissional",paymentMethod:"pix",modules:[]}});
  const demoBillingJob=await controlDb.billingProvisionJob.findFirst({where:{organizationId:"org-demo",status:{in:["pending","retry","processing","completed"]}}});
  if(!demoBillingJob)await controlDb.billingProvisionJob.create({data:{organizationId:"org-demo",payload:{external_id:"demo",razao_social:"Auto Mais Peças Ltda",nome_fantasia:"Auto Mais Peças",tipo_pessoa:"PJ",documento:"98.765.432/0001-98",responsavel:{nome:"Dyonatan Dias",email:"demo@nalven.com.br",telefone:"49999999999",cpf:"529.982.247-25"},endereco:{cep:"89800-000",logradouro:"Avenida Getúlio Vargas",numero:"100",bairro:"Centro",cidade:"Chapecó",estado:"SC"},plano_codigo:"profissional",forma_pagamento:"pix",modulos:[],dia_vencimento:10,tenant:{nome:"Auto Mais Peças — NALVEN",url:"https://demo.nalven.com.br",ambiente:"producao",versao:"0.9.0",metadata:{seed:true,demo:true,synthetic_document:true}}}}});
}
function requiredSeedSecret(name: "SUPERADMIN_PASSWORD" | "DEMO_USER_PASSWORD") { const value = process.env[name] || ""; if (value.length < 20 || value.length > 512 || /[\r\n\0]/.test(value)) throw new Error(`${name} deve ser fornecida fora do repositório e possuir de 20 a 512 caracteres.`); return value; }
main().finally(() => controlDb.$disconnect());
