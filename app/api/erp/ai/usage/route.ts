import { currentOrganization, tenantDb } from "@/db";
import { Prisma, type PrismaClient } from "@/generated/tenant/client";
import { AuthError, authErrorResponse } from "@/lib/auth";
import {
  AI_FEATURE_CATALOG,
  aiUsageCsv,
  featureLabel,
  normalizeAiPolicy,
  parseAiUsageQuery,
} from "@/lib/erp/ai-control-center";
import { assertSameOrigin } from "@/lib/erp/customer-input";
import { assertTenantPermission, matches } from "@/lib/erp/permissions";
import {
  IntegrationError,
  objectValue,
  persistentRateLimit,
  settingsSection,
} from "@/lib/integrations/core";
import { createOpenAiResponse } from "@/lib/integrations/openai";
import { assertTenantWriteAccess } from "@/lib/tenant-access";
import { HttpSecurityError, readJsonObject } from "@/lib/http-security";

const PRIVATE_HEADERS = {
  "Cache-Control": "private, no-store, max-age=0",
  Pragma: "no-cache",
};
const ANALYTICS_LIMIT = 20_000;

export async function GET(request: Request) {
  try {
    const organization = await currentOrganization();
    const actor = await assertTenantPermission(
      organization.id,
      "ai-integrations.read",
    );
    const db = await tenantDb(organization.id);
    const query = parseAiUsageQuery(new URL(request.url).searchParams);
    const settingsRow = await db.integrationSettings.findUniqueOrThrow({
      where: { id: 1 },
    });
    const policy = normalizeAiPolicy(
      settingsSection(settingsRow.ai, "ai"),
      settingsSection(settingsRow.ai, "ai"),
    );
    const start = new Date(Date.now() - query.days * 86_400_000);
    const monthStart = new Date(
      Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth(), 1),
    );
    const where = usageWhere(query, start);
    if (query.csv) {
      const rows = await db.integrationAiUsage.findMany({
        where,
        orderBy: { createdAt: "desc" },
        take: 10_000,
      });
      return new Response(aiUsageCsv(rows), {
        headers: {
          ...PRIVATE_HEADERS,
          "Content-Type": "text/csv; charset=utf-8",
          "Content-Disposition": `attachment; filename="uso-ia-${query.days}d.csv"`,
        },
      });
    }
    const [
      total,
      aggregate,
      statusGroups,
      featureGroups,
      modelGroups,
      keyGroups,
      recent,
      analyticsRows,
      monthAggregate,
      monthRequests,
      monthFeatures,
      credentials,
    ] = await Promise.all([
      db.integrationAiUsage.count({ where }),
      db.integrationAiUsage.aggregate({
        where,
        _sum: {
          units: true,
          inputTokens: true,
          outputTokens: true,
          cost: true,
        },
        _avg: { latencyMs: true },
      }),
      db.integrationAiUsage.groupBy({
        by: ["status"],
        where,
        _count: { _all: true },
      }),
      db.integrationAiUsage.groupBy({
        by: ["feature"],
        where,
        _count: { _all: true },
        _sum: { units: true, cost: true },
        orderBy: { _count: { feature: "desc" } },
        take: 12,
      }),
      db.integrationAiUsage.groupBy({
        by: ["model"],
        where,
        _count: { _all: true },
        _sum: { inputTokens: true, outputTokens: true, cost: true },
        orderBy: { _count: { model: "desc" } },
        take: 12,
      }),
      db.integrationAiUsage.groupBy({
        by: ["keySource"],
        where,
        _count: { _all: true },
      }),
      db.integrationAiUsage.findMany({
        where,
        orderBy: { createdAt: "desc" },
        skip: (query.page - 1) * query.limit,
        take: query.limit,
      }),
      db.integrationAiUsage.findMany({
        where,
        select: {
          createdAt: true,
          status: true,
          cost: true,
          inputTokens: true,
          outputTokens: true,
          latencyMs: true,
        },
        orderBy: { createdAt: "desc" },
        take: ANALYTICS_LIMIT,
      }),
      db.integrationAiUsage.aggregate({
        where: { createdAt: { gte: monthStart } },
        _sum: { cost: true, units: true, inputTokens: true, outputTokens: true },
      }),
      db.integrationAiUsage.count({ where: { createdAt: { gte: monthStart } } }),
      db.integrationAiUsage.groupBy({
        by: ["feature"],
        where: { createdAt: { gte: monthStart } },
        _sum: { units: true, cost: true },
        _count: { _all: true },
      }),
      db.integrationCredential.findMany({
        where: { providerId: "openai", revokedAt: null },
        select: {
          id: true,
          label: true,
          enabled: true,
          revision: true,
          ownerLabel: true,
          expiresAt: true,
          lastRotatedAt: true,
          sandbox: true,
          isDefault: true,
          lastTestAt: true,
          lastTestOk: true,
          lastTestMessage: true,
          config: true,
          secretsCipherText: true,
          createdAt: true,
        },
        orderBy: [{ isDefault: "desc" }, { createdAt: "asc" }],
      }),
    ]);
    const statusCounts = Object.fromEntries(
      statusGroups.map((item) => [item.status, item._count._all]),
    );
    const failed = Number(statusCounts.failed || 0);
    const completed = Number(statusCounts.completed || 0);
    const latencies = analyticsRows
      .map((item) => item.latencyMs)
      .filter((item) => item > 0)
      .sort((left, right) => left - right);
    const monthCost = Number(monthAggregate._sum.cost || 0);
    const daysElapsed = Math.max(1, new Date().getUTCDate());
    const daysInMonth = new Date(
      Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth() + 1, 0),
    ).getUTCDate();
    const projectedCost = (monthCost / daysElapsed) * daysInMonth;
    const activeByok = credentials.filter(
      (item) =>
        item.enabled &&
        (!item.expiresAt || item.expiresAt.getTime() > Date.now()),
    );
    const healthyByok = activeByok.filter(
      (item) =>
        item.lastTestOk === true &&
        item.lastTestAt &&
        Date.now() - item.lastTestAt.getTime() <= 24 * 60 * 60 * 1000,
    );
    const platformAvailable = Boolean(process.env.OPENAI_API_KEY);
    const blockers = [
      ...(policy.enabled ? [] : ["A execução de IA está desativada"]),
      ...(policy.routing_mode === "platform" && !platformAvailable
        ? ["A chave gerenciada da plataforma não está disponível"]
        : []),
      ...(policy.routing_mode === "byok" && !activeByok.length
        ? ["O modo BYOK exige uma chave própria ativa e válida"]
        : []),
      ...(policy.routing_mode === "hybrid" && !activeByok.length && !platformAvailable
        ? ["O modo híbrido não possui chave própria nem gerenciada disponível"]
        : []),
      ...(policy.monthly_budget > 0 && monthCost >= policy.monthly_budget
        ? ["O orçamento mensal contabilizado foi atingido"]
        : []),
      ...(policy.monthly_request_limit > 0 && monthRequests >= policy.monthly_request_limit
        ? ["O limite mensal de requisições foi atingido"]
        : []),
    ];
    const warnings = [
      ...(policy.redact_pii ? [] : ["A redação automática de dados pessoais está desativada"]),
      ...(activeByok.length && healthyByok.length < activeByok.length
        ? ["Há chave BYOK sem teste saudável nas últimas 24 horas"]
        : []),
      ...(policy.monthly_budget > 0 && projectedCost > policy.monthly_budget
        ? ["A projeção de custo supera o orçamento mensal"]
        : []),
      ...(total > ANALYTICS_LIMIT
        ? ["Os gráficos usam uma amostra das 20 mil execuções mais recentes"]
        : []),
    ];
    const monthFeatureMap = new Map(
      monthFeatures.map((item) => [item.feature, item]),
    );
    return Response.json(
      {
        generatedAt: new Date(),
        permissions: {
          canWrite: matches(actor.permissions, "ai-integrations.write"),
        },
        policy,
        revision: settingsRow.revision,
        readiness: {
          state: blockers.length ? "blocked" : warnings.length ? "attention" : "ready",
          blockers,
          warnings,
          platformAvailable,
          activeByok: activeByok.length,
          healthyByok: healthyByok.length,
        },
        summary: {
          requests: total,
          completed,
          failed,
          incomplete: Number(statusCounts.incomplete || 0),
          inProgress: Number(statusCounts.in_progress || 0),
          successRate: completed + failed ? (completed / (completed + failed)) * 100 : null,
          units: Number(aggregate._sum.units || 0),
          inputTokens: Number(aggregate._sum.inputTokens || 0),
          outputTokens: Number(aggregate._sum.outputTokens || 0),
          cost: Number(aggregate._sum.cost || 0),
          averageLatencyMs: Math.round(Number(aggregate._avg.latencyMs || 0)),
          p95LatencyMs: percentile(latencies, 0.95),
        },
        budget: {
          requests: monthRequests,
          requestLimit: policy.monthly_request_limit,
          cost: monthCost,
          limit: policy.monthly_budget,
          remaining:
            policy.monthly_budget > 0
              ? Math.max(0, policy.monthly_budget - monthCost)
              : null,
          usedPct:
            policy.monthly_budget > 0
              ? Math.min(100, (monthCost / policy.monthly_budget) * 100)
              : null,
          projectedCost,
          inputTokens: Number(monthAggregate._sum.inputTokens || 0),
          outputTokens: Number(monthAggregate._sum.outputTokens || 0),
        },
        breakdown: {
          daily: dailySeries(query.days, analyticsRows),
          statuses: statusGroups.map((item) => ({
            status: item.status,
            count: item._count._all,
          })),
          features: featureGroups.map((item) => ({
            feature: item.feature,
            label: featureLabel(item.feature),
            requests: item._count._all,
            units: Number(item._sum.units || 0),
            cost: Number(item._sum.cost || 0),
          })),
          models: modelGroups.map((item) => ({
            model: item.model,
            requests: item._count._all,
            inputTokens: Number(item._sum.inputTokens || 0),
            outputTokens: Number(item._sum.outputTokens || 0),
            cost: Number(item._sum.cost || 0),
          })),
          keySources: keyGroups.map((item) => ({
            keySource: item.keySource,
            count: item._count._all,
          })),
        },
        features: AI_FEATURE_CATALOG.map((feature) => {
          const usage = monthFeatureMap.get(feature.id);
          return {
            ...feature,
            enabled: policy.consumers[feature.id] !== false,
            limit: policy.per_feature_limits[feature.id] || 0,
            requests: usage?._count._all || 0,
            units: Number(usage?._sum.units || 0),
            cost: Number(usage?._sum.cost || 0),
          };
        }),
        credentials: credentials.map((item) => ({
          id: item.id,
          label: item.label,
          enabled: item.enabled,
          revision: item.revision,
          ownerLabel: item.ownerLabel,
          expiresAt: item.expiresAt,
          lastRotatedAt: item.lastRotatedAt,
          sandbox: item.sandbox,
          isDefault: item.isDefault,
          lastTestAt: item.lastTestAt,
          lastTestOk: item.lastTestOk,
          lastTestMessage: item.lastTestMessage
            ? item.lastTestOk
              ? "Credencial validada com a OpenAI."
              : "A validação falhou; revise chave, projeto e permissões."
            : null,
          apiKeyConfigured: Boolean(item.secretsCipherText),
          config: {
            project_id: String(objectValue(item.config).project_id || ""),
            organization_id: String(objectValue(item.config).organization_id || ""),
          },
          createdAt: item.createdAt,
        })),
        recent: recent.map(usageDto),
        pagination: {
          page: query.page,
          limit: query.limit,
          total,
          pages: Math.max(1, Math.ceil(total / query.limit)),
        },
        filterOptions: {
          features: [...new Set(monthFeatures.map((item) => item.feature))].sort(),
          models: [
            ...new Set([
              ...policy.allowed_models,
              ...modelGroups.map((item) => item.model),
            ]),
          ].sort(),
        },
      },
      { headers: PRIVATE_HEADERS },
    );
  } catch (error) {
    return failure(error);
  }
}

export async function POST(request: Request) {
  try {
    assertSameOrigin(request);
    const organization = await currentOrganization();
    const actor = await assertTenantPermission(
      organization.id,
      "ai-integrations.write",
    );
    await assertTenantWriteAccess(organization.id);
    const db = await tenantDb(organization.id);
    const body = await jsonBody(request);
    const action = String(body.action || "");
    await persistentRateLimit(
      db,
      `${actor.user.id}:ai-control:${action}`,
      action === "playground" ? 5 : 20,
      60,
    );
    if (action === "playground") {
      const prompt = required(body.prompt, "Informe um prompt para o teste.", 8_000);
      const instructions = optional(body.instructions, 4_000);
      const model = optional(body.model, 100);
      const maxOutputTokens = integer(body.maxOutputTokens, 1, 4_000, 600);
      const result = await createOpenAiResponse(db, {
        feature: "ai.playground",
        input: prompt,
        instructions: instructions || undefined,
        model: model || undefined,
        maxOutputTokens,
        safetyIdentifier: actor.user.id,
      });
      await audit(db, actor.user.id, "ai.playground.run", result.id || "response", {
        model: result.model,
        keySource: result.keySource,
        inputLength: prompt.length,
      });
      return Response.json({ result }, { headers: PRIVATE_HEADERS });
    }
    if (action === "credential.default")
      return await setDefaultCredential(db, actor.user.id, body);
    if (action === "credential.revoke")
      return await revokeCredential(db, actor.user.id, body);
    throw new IntegrationError("Ação de inteligência artificial inválida.");
  } catch (error) {
    return failure(error);
  }
}

function usageWhere(
  query: ReturnType<typeof parseAiUsageQuery>,
  start: Date,
): Prisma.IntegrationAiUsageWhereInput {
  return {
    createdAt: { gte: start },
    ...(query.feature ? { feature: query.feature } : {}),
    ...(query.model ? { model: query.model } : {}),
    ...(query.status ? { status: query.status } : {}),
    ...(query.keySource ? { keySource: query.keySource } : {}),
    ...(query.search
      ? {
          OR: [
            { feature: { contains: query.search, mode: "insensitive" } },
            { model: { contains: query.search, mode: "insensitive" } },
          ],
        }
      : {}),
  };
}

function usageDto(row: {
  id: string;
  feature: string;
  model: string;
  status: string;
  keySource: string;
  units: number;
  inputTokens: number;
  outputTokens: number;
  latencyMs: number;
  cost: number;
  createdAt: Date;
}) {
  return {
    id: row.id,
    feature: row.feature,
    featureLabel: featureLabel(row.feature),
    model: row.model,
    status: row.status,
    keySource: row.keySource,
    units: row.units,
    inputTokens: row.inputTokens,
    outputTokens: row.outputTokens,
    latencyMs: row.latencyMs,
    cost: row.cost,
    createdAt: row.createdAt,
  };
}

function dailySeries(
  days: number,
  rows: Array<{
    createdAt: Date;
    status: string;
    cost: number;
    inputTokens: number;
    outputTokens: number;
    latencyMs: number;
  }>,
) {
  const grouped = new Map<
    string,
    { requests: number; completed: number; failed: number; tokens: number; cost: number }
  >();
  for (const row of rows) {
    const key = row.createdAt.toISOString().slice(0, 10);
    const current = grouped.get(key) || {
      requests: 0,
      completed: 0,
      failed: 0,
      tokens: 0,
      cost: 0,
    };
    current.requests += 1;
    if (row.status === "completed") current.completed += 1;
    if (row.status === "failed") current.failed += 1;
    current.tokens += row.inputTokens + row.outputTokens;
    current.cost += row.cost;
    grouped.set(key, current);
  }
  return Array.from({ length: days }, (_, index) => {
    const date = new Date();
    date.setUTCHours(0, 0, 0, 0);
    date.setUTCDate(date.getUTCDate() - (days - index - 1));
    const key = date.toISOString().slice(0, 10);
    return {
      date: key,
      ...(grouped.get(key) || {
        requests: 0,
        completed: 0,
        failed: 0,
        tokens: 0,
        cost: 0,
      }),
    };
  });
}

async function setDefaultCredential(
  db: PrismaClient,
  userId: string,
  body: Record<string, unknown>,
) {
  const id = required(body.credentialId, "Credencial obrigatória.", 120);
  const revision = integer(body.revision, 0, Number.MAX_SAFE_INTEGER, 0);
  await db.$transaction(
    async (tx) => {
      const changed = await tx.integrationCredential.updateMany({
        where: { id, providerId: "openai", revision, revokedAt: null },
        data: { isDefault: true, updatedBy: userId, revision: { increment: 1 } },
      });
      if (!changed.count)
        throw new IntegrationError(
          "A credencial mudou em outra sessão. Atualize a página e tente novamente.",
          409,
        );
      await tx.integrationCredential.updateMany({
        where: { providerId: "openai", id: { not: id } },
        data: { isDefault: false },
      });
    },
    { isolationLevel: "Serializable", maxWait: 10_000, timeout: 30_000 },
  );
  await audit(db, userId, "ai.credential.default", id, { isDefault: true });
  return Response.json({ success: true }, { headers: PRIVATE_HEADERS });
}

async function revokeCredential(
  db: PrismaClient,
  userId: string,
  body: Record<string, unknown>,
) {
  const id = required(body.credentialId, "Credencial obrigatória.", 120);
  const revision = integer(body.revision, 0, Number.MAX_SAFE_INTEGER, 0);
  const changed = await db.integrationCredential.updateMany({
    where: { id, providerId: "openai", revision, revokedAt: null },
    data: {
      enabled: false,
      isDefault: false,
      revokedAt: new Date(),
      updatedBy: userId,
      revision: { increment: 1 },
    },
  });
  if (!changed.count)
    throw new IntegrationError(
      "A credencial mudou em outra sessão. Atualize a página e tente novamente.",
      409,
    );
  await audit(db, userId, "ai.credential.revoke", id, { revoked: true });
  return Response.json({ success: true }, { headers: PRIVATE_HEADERS });
}

async function audit(
  db: PrismaClient,
  userId: string,
  action: string,
  targetId: string,
  afterData: Record<string, unknown>,
) {
  await db.integrationAuditLog.create({
    data: {
      userId,
      action,
      targetType: "artificial_intelligence",
      targetId,
      afterData: afterData as Prisma.InputJsonObject,
    },
  });
}

async function jsonBody(request: Request) {
  return objectValue(await readJsonObject(request, 256 * 1024));
}

function required(value: unknown, message: string, max: number) {
  const result = String(value || "").trim();
  if (!result) throw new IntegrationError(message);
  if (result.length > max)
    throw new IntegrationError(
      `${message.replace(/\.$/, "")} excede o limite permitido.`,
    );
  return result;
}

function optional(value: unknown, max: number) {
  return String(value || "").trim().slice(0, max);
}

function integer(value: unknown, min: number, max: number, fallback: number) {
  const result = value == null || value === "" ? fallback : Number(value);
  if (!Number.isInteger(result) || result < min || result > max)
    throw new IntegrationError("Valor numérico inválido.");
  return result;
}

function percentile(values: number[], quantile: number) {
  if (!values.length) return 0;
  return values[Math.min(values.length - 1, Math.ceil(values.length * quantile) - 1)];
}

function failure(error: unknown) {
  if (error instanceof HttpSecurityError) return authErrorResponse(error);
  if (error instanceof IntegrationError)
    return Response.json(
      { error: error.message },
      {
        status: error.status,
        headers: {
          ...PRIVATE_HEADERS,
          ...(error.status === 429 ? { "Retry-After": "60" } : {}),
        },
      },
    );
  if (error instanceof AuthError) return authErrorResponse(error);
  console.error("AI control center error", {
    error: error instanceof Error ? error.name : typeof error,
  });
  return Response.json(
    { error: "Não foi possível processar a central de inteligência artificial." },
    { status: 500, headers: PRIVATE_HEADERS },
  );
}
