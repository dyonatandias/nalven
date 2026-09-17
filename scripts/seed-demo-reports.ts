import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../generated/tenant/client";
import {
  nextScheduleRun,
  type ReportFrequency,
  type ReportKey,
} from "../lib/erp/report-workspace";

if (process.env.NALVEN_ALLOW_DEMO_REPORT_SEED !== "1")
  throw new Error(
    "Defina NALVEN_ALLOW_DEMO_REPORT_SEED=1 para confirmar o seed demonstrativo de relatórios.",
  );
const connectionString = process.env.TENANT_DATABASE_URL;
if (!connectionString) throw new Error("TENANT_DATABASE_URL não foi definida.");
const db = new PrismaClient({ adapter: new PrismaPg({ connectionString }) });
const actorName = "Equipe Demo NALVEN";

async function main() {
  const [identity] = await db.$queryRaw<
    Array<{ database: string; role: string }>
  >`SELECT current_database() AS database, current_user AS role`;
  if (
    !identity ||
    identity.database !== "nalven_t_demo" ||
    identity.role !== "nalven_t_demo_runtime"
  )
    throw new Error(
      "O seed só pode executar em nalven_t_demo com a credencial runtime.",
    );
  const profile = await db.tenantUserProfile.findFirst({
    where: { status: "active" },
    orderBy: { id: "asc" },
    select: {
      userId: true,
      displayName: true,
      activeBranch: { select: { timezone: true } },
    },
  });
  if (!profile) throw new Error("O seed exige um perfil ativo.");
  const ownerUserId = profile.userId,
    ownerName = profile.displayName || actorName,
    timezone = profile.activeBranch?.timezone || "America/Sao_Paulo";
  const definitions: Array<{
    name: string;
    description: string;
    reportKey: ReportKey;
    visibility: string;
    filters: Record<string, string>;
    favorite?: boolean;
  }> = [
    {
      name: "Margens críticas para revisão",
      description:
        "Produtos abaixo da margem mínima configurada, priorizados para a reunião de pricing.",
      reportKey: "margins",
      visibility: "team",
      filters: { health: "critical", order_by: "margin_percent", order: "ASC" },
      favorite: true,
    },
    {
      name: "Desempenho comercial mensal",
      description: "Receita líquida e comparação dos últimos 30 dias.",
      reportKey: "sales",
      visibility: "team",
      filters: { period: "30d" },
      favorite: true,
    },
    {
      name: "Pulso comercial semanal",
      description: "Leitura curta do ritmo de vendas e do ticket médio.",
      reportKey: "sales",
      visibility: "private",
      filters: { period: "7d" },
    },
    {
      name: "Produtos indisponíveis",
      description: "Catálogo ativo sem estoque para decisão de reposição.",
      reportKey: "products",
      visibility: "team",
      filters: { stock_status: "outofstock" },
      favorite: true,
    },
    {
      name: "Saneamento fiscal prioritário",
      description: "Cadastros ainda incompletos para emissão fiscal.",
      reportKey: "fiscal",
      visibility: "team",
      filters: { incomplete: "true" },
      favorite: true,
    },
    {
      name: "Catálogo de maior valor",
      description:
        "Produtos ordenados por preço para revisão de exposição e risco.",
      reportKey: "products",
      visibility: "private",
      filters: { order_by: "price", order: "DESC" },
    },
  ];
  const views = new Map<string, number>();
  for (const definition of definitions) {
    const { favorite, ...viewDefinition } = definition;
    const view = await db.savedReportView.upsert({
      where: { ownerUserId_name: { ownerUserId, name: definition.name } },
      update: {
        description: viewDefinition.description,
        reportKey: viewDefinition.reportKey,
        filters: viewDefinition.filters,
        visibility: viewDefinition.visibility,
      },
      create: { ...viewDefinition, ownerUserId, ownerName },
    });
    views.set(definition.name, view.id);
    if (favorite)
      await db.reportViewFavorite.upsert({
        where: {
          reportViewId_userId: { reportViewId: view.id, userId: ownerUserId },
        },
        update: {},
        create: { reportViewId: view.id, userId: ownerUserId },
      });
  }

  const routines: Array<{
    view: string;
    name: string;
    frequency: ReportFrequency;
    weekday: number | null;
    dayOfMonth: number | null;
    time: string;
  }> = [
    {
      view: "Pulso comercial semanal",
      name: "Pulso comercial de segunda-feira",
      frequency: "weekly",
      weekday: 1,
      dayOfMonth: null,
      time: "08:00",
    },
    {
      view: "Margens críticas para revisão",
      name: "Comitê semanal de pricing",
      frequency: "weekly",
      weekday: 3,
      dayOfMonth: null,
      time: "09:30",
    },
    {
      view: "Saneamento fiscal prioritário",
      name: "Revisão fiscal diária",
      frequency: "daily",
      weekday: null,
      dayOfMonth: null,
      time: "16:00",
    },
    {
      view: "Desempenho comercial mensal",
      name: "Fechamento executivo mensal",
      frequency: "monthly",
      weekday: null,
      dayOfMonth: 1,
      time: "08:30",
    },
  ];
  for (const routine of routines) {
    const definition = definitions.find((item) => item.name === routine.view)!;
    const schedule = {
      savedReportViewId: views.get(routine.view)!,
      name: routine.name,
      reportKey: definition.reportKey,
      filters: definition.filters,
      format: "csv",
      frequency: routine.frequency,
      weekday: routine.weekday,
      dayOfMonth: routine.dayOfMonth,
      time: routine.time,
      timezone,
      status: "active",
      nextRunAt: nextScheduleRun({
        frequency: routine.frequency,
        weekday: routine.weekday,
        dayOfMonth: routine.dayOfMonth,
        time: routine.time,
        timezone,
      }),
      createdBy: ownerUserId,
      createdByName: ownerName,
    };
    const current = await db.reportSchedule.findFirst({
      where: { createdBy: ownerUserId, name: routine.name },
    });
    if (current)
      await db.reportSchedule.update({
        where: { id: current.id },
        data: schedule,
      });
    else await db.reportSchedule.create({ data: schedule });
  }

  await db.reportExportEvent.deleteMany({
    where: { requestedBy: ownerUserId, scope: "demo" },
  });
  const now = Date.now();
  await db.reportExportEvent.createMany({
    data: Array.from({ length: 12 }, (_, index) => {
      const definition = definitions[index % definitions.length];
      return {
        reportKey: definition.reportKey,
        reportName: definition.name,
        format: "csv",
        scope: "demo",
        status: "completed",
        fileName: `demonstracao-${definition.reportKey}-${String(index + 1).padStart(2, "0")}.csv`,
        requestedBy: ownerUserId,
        requestedByName: ownerName,
        createdAt: new Date(now - index * 2 * 86_400_000),
      };
    }),
  });
  console.log(
    JSON.stringify({
      database: identity.database,
      views: definitions.length,
      routines: routines.length,
      exports: 12,
      timezone,
    }),
  );
}

main().finally(() => db.$disconnect());
