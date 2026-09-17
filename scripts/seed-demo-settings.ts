import { PrismaPg } from "@prisma/adapter-pg";
import { Prisma, PrismaClient } from "../generated/tenant/client";
import { settingsSnapshot } from "../lib/erp/settings-input";

const databaseUrl = process.env.TENANT_DATABASE_URL;
if (!databaseUrl) throw new Error("TENANT_DATABASE_URL não foi definida");
const db = new PrismaClient({
  adapter: new PrismaPg({ connectionString: databaseUrl }),
});
const DAY = 86_400_000;

async function main() {
  const actors = await db.tenantUserProfile.findMany({
    where: { status: "active" },
    orderBy: { id: "asc" },
    take: 4,
    select: { userId: true, displayName: true },
  });
  const actor = actors[0] || {
    userId: "settings-demo-system",
    displayName: "Administração demonstrativa",
  };
  const current = await db.tenantSettings.findUnique({ where: { id: 1 } });
  if (!current) throw new Error("Configurações do tenant não foram inicializadas");
  const settings = await db.tenantSettings.update({
    where: { id: 1 },
    data: {
      tradeName: "Auto Mais Peças",
      operationalEmail: "operacoes@automais.demo",
      operationalPhone: "(49) 3333-0100",
      timezone: "America/Sao_Paulo",
      accentColor: "#168151",
      interfaceDensity: "comfortable",
      defaultSidebarMode: "expanded",
      defaultPaymentMethod: "Pix",
      defaultCustomerName: "Consumidor final",
      requireCustomer: false,
      lowStockAlerts: true,
      autoGenerateSku: true,
      allowNegativeStock: false,
      quoteValidityDays: 10,
      maxDiscountPercent: 12.5,
      posCloseToleranceCents: 500,
      dailySummary: true,
      dailySummaryTime: "18:00",
      notifyLowStock: true,
      notifyOverdueTitles: true,
      notifyNewSales: false,
      quoteFooter:
        "Proposta válida pelo período indicado. Valores e disponibilidade sujeitos à confirmação.",
      receiptFooter:
        "Obrigado pela preferência. Guarde este comprovante para trocas e garantias.",
      termsAndConditions:
        "A aprovação confirma os itens, quantidades e condições de pagamento desta proposta. A separação começa após a confirmação financeira. Garantias seguem a política do fabricante e a legislação aplicável.",
      dataProtectionEmail: current.dataProtectionEmail || "privacidade@automais.demo",
      auditRetentionDays: 1825,
      version: Math.max(current.version, 9),
      updatedBy: actor.userId,
    },
  });

  const baseline: Record<string, unknown> = {
    ...settingsSnapshot(settings as unknown as Record<string, unknown>),
    tradeName: null,
    operationalEmail: null,
    operationalPhone: null,
    accentColor: "#235a75",
    interfaceDensity: "compact",
    defaultSidebarMode: "compact",
    quoteValidityDays: 15,
    maxDiscountPercent: 20,
    lowStockAlerts: false,
    autoGenerateSku: false,
    dailySummary: false,
    notifyLowStock: false,
    notifyOverdueTitles: false,
    quoteFooter: null,
    receiptFooter: null,
    termsAndConditions: null,
    auditRetentionDays: 1095,
    dataProtectionEmail: null,
    version: 1,
  };
  const revisions = [
    { organizationName: "Auto Mais Peças", tradeName: "Auto Mais Peças" },
    { operationalEmail: "operacoes@automais.demo", operationalPhone: "(49) 3333-0100" },
    { accentColor: "#168151", interfaceDensity: "comfortable", defaultSidebarMode: "expanded" },
    { quoteValidityDays: 10, maxDiscountPercent: 12.5, defaultPaymentMethod: "Pix" },
    { lowStockAlerts: true, autoGenerateSku: true, allowNegativeStock: false },
    { dailySummary: true, dailySummaryTime: "18:00", notifyLowStock: true, notifyOverdueTitles: true },
    { quoteFooter: settings.quoteFooter, receiptFooter: settings.receiptFooter, termsAndConditions: settings.termsAndConditions },
    { auditRetentionDays: 1825, dataProtectionEmail: settings.dataProtectionEmail },
  ];
  let snapshot: Record<string, unknown> = { ...baseline };
  for (const [index, change] of revisions.entries()) {
    const version = index + 2;
    const before = { ...snapshot };
    snapshot = { ...snapshot, ...change, version };
    const correlationId = `settings-demo-history-${String(index + 1).padStart(2, "0")}`;
    if (
      !(await db.tenantAuditEvent.findFirst({
        where: { correlationId },
        select: { id: true },
      }))
    ) {
      const selectedActor = actors[index % Math.max(actors.length, 1)] || actor;
      await db.tenantAuditEvent.create({
        data: {
          actorId: selectedActor.userId,
          action: "tenant_settings.updated",
          entityType: "tenant_settings",
          entityId: "1",
          correlationId,
          category: "governance",
          beforeData: json(before),
          afterData: json(snapshot),
          createdAt: new Date(Date.now() - (18 - index * 2) * DAY),
        },
      });
    }
  }
  const refreshCorrelation = "settings-demo-dataset-refreshed";
  if (
    !(await db.tenantAuditEvent.findFirst({
      where: { correlationId: refreshCorrelation },
      select: { id: true },
    }))
  )
    await db.tenantAuditEvent.create({
      data: {
        actorId: actor.userId,
        action: "settings.demo_dataset.refreshed",
        entityType: "settings_demo",
        entityId: "1",
        correlationId: refreshCorrelation,
        category: "governance",
        afterData: {
          revisions: revisions.length,
          configurationVersion: settings.version,
          secretValues: false,
        },
      },
    });
  console.log(
    JSON.stringify({
      settingsVersion: settings.version,
      history: await db.tenantAuditEvent.count({
        where: {
          entityType: "tenant_settings",
          entityId: "1",
          action: "tenant_settings.updated",
        },
      }),
      demoRevisions: revisions.length,
    }),
  );
}

main().finally(async () => db.$disconnect());

function json(value: unknown) {
  return JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;
}
