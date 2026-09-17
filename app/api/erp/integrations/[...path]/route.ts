import { planAllows } from "@/lib/erp/plan-features";
import { readIntegrationJson } from "@/lib/integrations/http";
import { createHash, randomBytes } from "node:crypto";
import { headers } from "next/headers";
import { currentOrganization, tenantDb } from "@/db";
import { controlDb } from "@/db/control";
import { Prisma, type PrismaClient } from "@/generated/tenant/client";
import { AuthError, authErrorResponse } from "@/lib/auth";
import { LicenseDeniedError } from "@/lib/billing/license";
import { assertSameOrigin } from "@/lib/erp/customer-input";
import { assertTenantPermission } from "@/lib/erp/permissions";
import { assertTenantWriteAccess } from "@/lib/tenant-access";
import { normalizeAiPolicy } from "@/lib/erp/ai-control-center";
import {
  DEFAULT_SETTINGS,
  OTP_CONTEXTS,
  PROVIDER_MAP,
  ROUTING_CONTEXTS,
} from "@/lib/integrations/catalog";
import {
  constantTimeEqual,
  contactHash,
  decryptSecrets,
  encryptSecrets,
  ensureIntegrationSeed,
  generateOtp,
  IntegrationError,
  isConfigured,
  maskRecipient,
  objectValue,
  persistentRateLimit,
  redact,
  serializeCredential,
  settingsSection,
  splitCredential,
} from "@/lib/integrations/core";
import { sendWithProvider, testProvider } from "@/lib/integrations/providers";
import { refreshOAuthToken } from "@/lib/integrations/oauth";
import {
  safeRequest,
  validatePublicHttpsUrl,
} from "@/lib/integrations/security";
import { unexpectedErrorResponse } from "@/lib/http-security";

type RouteContext = { params: Promise<{ path: string[] }> };
type Access = Awaited<ReturnType<typeof access>>;
const HEALTH_CACHE_MS = 30 * 60 * 1000;
const REMOVED_PROVIDER_IDS = [
  "email",
  "webhook",
  "whatsapp_api",
  "whatsapp_official",
  "payment_gateway",
  "ai",
];

type IntegrationPermission =
  | "integrations.read"
  | "integrations.write"
  | "ai-integrations.read"
  | "ai-integrations.write";

async function access(permission: IntegrationPermission) {
  const organization = await currentOrganization();
  const actor = await assertTenantPermission(organization.id, permission);
  if (permission === "integrations.write")
    await assertTenantWriteAccess(organization.id);
  if (permission === "ai-integrations.write")
    await assertTenantWriteAccess(organization.id);
  const db = await tenantDb(organization.id);
  if (permission === "integrations.write") await ensureIntegrationSeed(db);
  if (permission === "ai-integrations.write") await ensureIntegrationSeed(db);
  return { organization, actor, db };
}

async function assertIntegrationPlan(ctx: Access, path: string[], body: Record<string, unknown> = {}) {
  if (planAllows(ctx.organization.modules, "marketplaces")) return;
  if ([...path, body.provider, body.provider_id, body.providerId].includes("marketplace"))
    throw new IntegrationError("Marketplaces não estão habilitados neste plano.", 403);
  const ids = [path[0] === "credentials" ? path[1] : undefined, body.credential_id, body.credentialId, body.id].filter((id): id is string => typeof id === "string");
  if (ids.length && await ctx.db.integrationCredential.findFirst({where: {id: {in: ids}, providerId: "marketplace"}}))
    throw new IntegrationError("Marketplaces não estão habilitados neste plano.", 403);
}

function routePermission(path: string[], write: boolean): IntegrationPermission {
  const aiScoped =
    (path[0] === "credentials" && path[1] === "openai") ||
    (path[0] === "settings" && path[1] === "ai") ||
    (path[0] === "health" && path[1] === "openai");
  if (aiScoped) return write ? "ai-integrations.write" : "ai-integrations.read";
  return write ? "integrations.write" : "integrations.read";
}

export async function GET(request: Request, context: RouteContext) {
  try {
    const path = await segments(context);
    if (path[1] === "callback") return await oauthCallback(request, path[0]);
    const ctx = await access(routePermission(path, false));
    const { db, organization } = ctx;
    await assertIntegrationPlan(ctx, path);
    if (path[0] === "overview") return await overview(db);
    if (path[0] === "providers")
      return Response.json({
        providers: await db.integrationProvider.findMany({
          where: { id: { notIn: [...REMOVED_PROVIDER_IDS, ...(!planAllows(organization.modules, "marketplaces") ? ["marketplace"] : [])] } },
          orderBy: [{ family: "asc" }, { priority: "asc" }],
        }),
      });
    if (path[0] === "credentials") return await credentialsGet(db, path[1], planAllows(organization.modules, "marketplaces"));
    if (path[0] === "routing") return await routingGet(db, path[1]);
    if (path[0] === "settings") return await settingsGet(db, path[1]);
    if (path[0] === "health" && path[1] === "all")
      return await healthLast(db);
    if (path[0] === "health" && path[1] === "last")
      return await healthLast(db);
    if (path[0] === "health" && path[1] === "history")
      return await healthHistory(db, request);
    if (path[0] === "monitor" && path[1] === "status")
      return await monitorStatus(db);
    if (path[0] === "monitor" && path[1] === "settings")
      return await settingsGet(db, "monitor");
    if (path[0] === "metrics") return await metrics(db, request);
    if (path[0] === "otp" && path[1] === "metrics")
      return await otpMetrics(db, request);
    if (path[0] === "queue") return await queueGet(db, request);
    if (path[0] === "opt-outs") return await optOutsGet(db, request);
    if (path[0] === "audit") return await auditGet(db, request);
    if (path[0] === "storage" && path[1] === "migration")
      return Response.json({
        migrations: await db.integrationMediaMigration.findMany({
          orderBy: { createdAt: "desc" },
          take: 20,
        }),
      });
    if (path[0] === "inbound")
      return Response.json({
        events: (
          await db.integrationInboundEvent.findMany({
            orderBy: { receivedAt: "desc" },
            take: 100,
          })
        ).map((event) => ({ ...event, payload: redact(event.payload) })),
      });
    return Response.json(
      { error: "Rota de integração não encontrada." },
      { status: 404 },
    );
  } catch (error) {
    return failure(error);
  }
}

export async function POST(request: Request, context: RouteContext) {
  try {
    assertSameOrigin(request);
    const path = await segments(context),
      ctx = await access(routePermission(path, true)),
      body = await jsonBody(request);
    await assertIntegrationPlan(ctx, path, body);
    const limit =
      path[0] === "health" && path[1] === "all"
        ? 2
        : ["test-send", "test-otp", "test-smtp"].includes(path[0])
          ? 5
          : path[0] === "validate-url"
            ? 20
            : path[0] === "health"
              ? 10
              : 30;
    await persistentRateLimit(
      ctx.db,
      `${ctx.actor.user.id}:${path.join("/")}`,
      limit,
      60,
    );
    if (path[0] === "credentials" && path[1])
      return await credentialSave(ctx, path[1], body);
    if (path[0] === "routing" && path[1])
      return await routingSave(ctx, path[1], body);
    if (path[0] === "settings" && path[1])
      return await settingsSave(ctx, path[1], body);
    if (path[0] === "health" && path[1] === "all")
      return await healthAll(ctx.db, "manual", true);
    if (path[0] === "health" && path[1])
      return await healthOne(
        ctx.db,
        path[1],
        "manual",
        text(body.credential_id, 100),
      );
    if (path[0] === "monitor" && path[1] === "settings")
      return await settingsSave(ctx, "monitor", body);
    if (path[0] === "monitor" && path[1] === "run")
      return await healthAll(ctx.db, "cron", false);
    if (path[0] === "monitor" && path[1] === "test-alert")
      return await testAlert(ctx);
    if (path[0] === "test-send") return await testSend(ctx, body);
    if (path[0] === "test-otp") return await testOtp(ctx, body);
    if (path[0] === "test-smtp") return await testSmtp(ctx, body);
    if (path[0] === "validate-url") return await validateUrl(body);
    if (path[0] === "queue" && path[2] === "retry")
      return await queueRetry(ctx, path[1]);
    if (path[0] === "queue" && path[1] === "batch")
      return await queueBatch(ctx, body);
    if (path[0] === "opt-outs") return await optOutSave(ctx, body);
    if (path[0] === "ai" && path[1] === "usage")
      return await aiUsage(ctx, body);
    if (path[0] === "storage" && path[1] === "migration")
      return await storageMigration(ctx, body);
    if (path[0] === "shipping" && path[1] === "quote")
      return await shippingQuote(ctx, body);
    if (path[0] === "otp" && path[1] === "send")
      return await otpSend(ctx, body);
    if (path[0] === "otp" && path[1] === "verify")
      return await otpVerify(ctx, body);
    if (path[1] === "auth")
      return await oauthStart(request, ctx, path[0], body);
    if (path[1] === "disconnect")
      return await oauthDisconnect(ctx, path[0], body);
    return Response.json(
      { error: "Rota de integração não encontrada." },
      { status: 404 },
    );
  } catch (error) {
    return failure(error);
  }
}

export async function PATCH(request: Request, context: RouteContext) {
  try {
    assertSameOrigin(request);
    const path = await segments(context),
      ctx = await access("integrations.write"),
      body = await jsonBody(request);
    await assertIntegrationPlan(ctx, path, body);
    if (path[0] === "credentials" && path[1] && path[2] === "default") {
      const before = await ctx.db.integrationCredential.findUnique({
        where: { id: path[1] },
      });
      if (!before)
        throw new IntegrationError("Credencial não encontrada.", 404);
      const expectedRevision = nonNegative(body.revision, "Versão da credencial");
      if (expectedRevision !== before.revision)
        throw new IntegrationError(
          "A credencial mudou em outra sessão. Atualize a página antes de continuar.",
          409,
        );
      await ctx.db.$transaction(async (tx) => {
        const selected = await tx.integrationCredential.updateMany({
          where: { id: before.id, revision: expectedRevision, revokedAt: null },
          data: {
            isDefault: true,
            revision: { increment: 1 },
            updatedBy: ctx.actor.user.id,
          },
        });
        if (!selected.count)
          throw new IntegrationError(
            "A credencial mudou em outra sessão. Atualize a página antes de continuar.",
            409,
          );
        await tx.integrationCredential.updateMany({
          where: { providerId: before.providerId },
          data: { isDefault: false },
        });
        await tx.integrationCredential.update({
          where: { id: before.id },
          data: { isDefault: true },
        });
      }, { isolationLevel: "Serializable", maxWait: 10_000, timeout: 30_000 });
      await audit(
        ctx,
        "update",
        "credential",
        before.id,
        { isDefault: before.isDefault },
        { isDefault: true },
      );
      return Response.json({ ok: true });
    }
    return Response.json(
      { error: "Rota de integração não encontrada." },
      { status: 404 },
    );
  } catch (error) {
    return failure(error);
  }
}

export async function DELETE(request: Request, context: RouteContext) {
  try {
    assertSameOrigin(request);
    const path = await segments(context),
      ctx = await access("integrations.write");
    await assertIntegrationPlan(ctx, path);
    if (path[0] === "credentials" && path[1]) {
      const before = await ctx.db.integrationCredential.findUnique({
        where: { id: path[1] },
      });
      if (!before)
        throw new IntegrationError("Credencial não encontrada.", 404);
      const siblingCount = await ctx.db.integrationCredential.count({
        where: { providerId: before.providerId, id: { not: before.id } },
      });
      const routed =
        before.isDefault || siblingCount === 0
          ? await ctx.db.integrationRouting.count({
              where: {
                OR: [
                  { providerId: before.providerId },
                  { fallbackProviderId: before.providerId },
                ],
              },
            })
          : 0;
      const inUse =
        routed +
        (await ctx.db.marketplaceChannel.count({
          where: { credentialId: before.id },
        }));
      if (inUse)
        throw new IntegrationError(
          "A credencial está vinculada ao roteamento. Migre os contextos antes de excluir.",
          422,
        );
      await ctx.db.integrationCredential.update({
        where: { id: before.id },
        data: {
          enabled: false,
          isDefault: false,
          revokedAt: new Date(),
          revision: { increment: 1 },
          updatedBy: ctx.actor.user.id,
        },
      });
      await audit(
        ctx,
        "delete",
        "credential",
        before.id,
        serializeCredential(before),
        null,
      );
      return Response.json({ ok: true });
    }
    if (path[0] === "queue" && path[1]) {
      const item = await ctx.db.integrationQueueItem.findUnique({
        where: { id: path[1] },
      });
      if (!item)
        throw new IntegrationError("Item da fila não encontrado.", 404);
      if (["success", "cancelled"].includes(item.state))
        throw new IntegrationError("Este item não pode ser cancelado.", 422);
      await ctx.db.integrationQueueItem.update({
        where: { id: item.id },
        data: { state: "cancelled", finishedAt: new Date() },
      });
      await audit(
        ctx,
        "cancel",
        "queue_item",
        item.id,
        { state: item.state },
        { state: "cancelled" },
      );
      return Response.json({ ok: true });
    }
    return Response.json(
      { error: "Rota de integração não encontrada." },
      { status: 404 },
    );
  } catch (error) {
    return failure(error);
  }
}

async function overview(db: PrismaClient) {
  const since = new Date(Date.now() - 24 * 60 * 60 * 1000);
  const [
    providerCount,
    credentials,
    routes,
    health,
    queueGroups,
    oldestBacklog,
    webhooks,
    deliveries,
    inboundGroups,
    settings,
  ] = await Promise.all([
    db.integrationProvider.count({ where: { id: { notIn: REMOVED_PROVIDER_IDS } } }),
    db.integrationCredential.findMany({
      where: { revokedAt: null, providerId: { notIn: REMOVED_PROVIDER_IDS } },
      select: {
        id: true,
        providerId: true,
        enabled: true,
        expiresAt: true,
        lastTestAt: true,
        lastTestOk: true,
      },
    }),
    db.integrationRouting.findMany({
      where: { context: { in: [...ROUTING_CONTEXTS] } },
      select: { enabled: true, providerId: true, fallbackProviderId: true },
    }),
    db.integrationHealthState.findMany(),
    db.integrationQueueItem.groupBy({
      by: ["state"],
      where: { createdAt: { gte: since } },
      _count: { _all: true },
    }),
    db.integrationQueueItem.findFirst({
      where: { state: { in: ["pending", "processing", "failed", "dead"] } },
      orderBy: { createdAt: "asc" },
      select: { createdAt: true },
    }),
    db.integrationWebhookEndpoint.findMany({
      where: { supersededAt: null },
      select: { status: true, failureCount: true },
    }),
    db.integrationWebhookDelivery.groupBy({
      by: ["state"],
      where: { createdAt: { gte: since } },
      _count: { _all: true },
    }),
    db.integrationInboundEvent.groupBy({
      by: ["status"],
      where: { receivedAt: { gte: since } },
      _count: { _all: true },
    }),
    db.integrationSettings.findUnique({ where: { id: 1 }, select: { monitor: true } }),
  ]);
  const queue = Object.fromEntries(queueGroups.map((row) => [row.state, row._count._all])),
    webhookDelivery = Object.fromEntries(
      deliveries.map((row) => [row.state, row._count._all]),
    ),
    inbound = Object.fromEntries(
      inboundGroups.map((row) => [row.status, row._count._all]),
    ),
    enabledCredentials = credentials.filter((item) => item.enabled),
    expiringCredentials = enabledCredentials.filter(
      (item) => item.expiresAt && item.expiresAt.getTime() <= Date.now() + 30 * 86400000,
    ),
    configuredRoutes = routes.filter(
      (item) => item.enabled && item.providerId && item.providerId !== "auto",
    ),
    degraded = health.filter((item) => ["down", "degraded"].includes(item.status)),
    stale = health.filter(
      (item) => Date.now() - item.lastCheckAt.getTime() > 24 * 60 * 60 * 1000,
    ),
    monitor = settings ? settingsSection(settings.monitor, "monitor") : DEFAULT_SETTINGS.monitor,
    blockers = [
      ...(enabledCredentials.length ? [] : ["Nenhuma credencial ativa"]),
      ...(routes.length && configuredRoutes.length === 0 ? ["Rotas ainda estão em modo automático"] : []),
      ...(degraded.length ? [`${degraded.length} provider(s) degradado(s)`] : []),
      ...((queue.dead || 0) ? [`${queue.dead} item(ns) na fila morta`] : []),
      ...(expiringCredentials.length ? [`${expiringCredentials.length} credencial(is) vencida(s) ou a vencer`] : []),
    ];
  return Response.json({
    overview: {
      generatedAt: new Date(),
      readiness: blockers.length ? "attention" : "ready",
      blockers,
      providers: {
        catalog: providerCount,
        configured: new Set(credentials.map((item) => item.providerId)).size,
        activeCredentials: enabledCredentials.length,
        expiringCredentials: expiringCredentials.length,
      },
      routing: { total: routes.length, configured: configuredRoutes.length },
      health: { monitored: health.length, degraded: degraded.length, stale: stale.length },
      queue: {
        ...queue,
        oldestBacklogMinutes: oldestBacklog
          ? Math.max(0, Math.floor((Date.now() - oldestBacklog.createdAt.getTime()) / 60000))
          : 0,
      },
      webhooks: {
        total: webhooks.length,
        active: webhooks.filter((item) => item.status === "active").length,
        paused: webhooks.filter((item) => item.status !== "active").length,
        unhealthy: webhooks.filter((item) => item.failureCount > 0).length,
        deliveries: webhookDelivery,
      },
      inbound,
      monitorEnabled:
        monitor.enabled === null ? enabledCredentials.length > 0 : monitor.enabled === true,
    },
  });
}

async function credentialsGet(db: PrismaClient, providerId?: string, marketplaces = true) {
  if (providerId && !PROVIDER_MAP.has(providerId))
    throw new IntegrationError("Provider inexistente.", 404);
  const credentials = await db.integrationCredential.findMany({
    where: providerId
      ? { providerId, revokedAt: null }
      : { providerId: { notIn: [...REMOVED_PROVIDER_IDS, ...(!marketplaces ? ["marketplace"] : [])] }, revokedAt: null },
    include: { provider: true },
    orderBy: [
      { providerId: "asc" },
      { isDefault: "desc" },
      { createdAt: "asc" },
    ],
  });
  return Response.json({ credentials: credentials.map(serializeCredential) });
}

async function credentialSave(
  ctx: Access,
  providerId: string,
  body: Record<string, unknown>,
) {
  if (!PROVIDER_MAP.has(providerId))
    throw new IntegrationError("Provider inexistente.", 404);
  const id = text(body.id, 100),
    before = id
      ? await ctx.db.integrationCredential.findFirst({
          where: { id, providerId, revokedAt: null },
        })
      : null;
  const split = splitCredential(
      providerId,
      body.fields,
      before?.secretsCipherText,
    ),
    label = text(body.label, 120),
    enabled = body.enabled === true,
    sandbox = body.sandbox === true,
    ownerLabel = text(body.owner_label, 120) || null,
    expiresAt = optionalDate(body.expires_at, "Validade da credencial inválida."),
    secretsRotated = (PROVIDER_MAP.get(providerId)?.fields || []).some(
      (field) =>
        field.secret &&
        typeof objectValue(body.fields)[field.key] === "string" &&
        String(objectValue(body.fields)[field.key]).trim().length > 0,
    );
  if (enabled && !isConfigured(providerId, split.config, split.secrets))
    throw new IntegrationError(
      "Preencha todos os campos obrigatórios antes de ativar o provider.",
      422,
    );
  if (
    enabled &&
    providerId === "smtp" &&
    split.config.username &&
    !split.secrets.password
  )
    throw new IntegrationError(
      "Informe a senha SMTP antes de ativar a autenticação.",
      422,
    );
  for (const field of PROVIDER_MAP.get(providerId)?.fields.filter(
    (item) => item.type === "url",
  ) || []) {
    const value = split.config[field.key];
    if (value) await validatePublicHttpsUrl(String(value));
  }
  const credential = await ctx.db.$transaction(async (tx) => {
    if (body.isDefault === true)
      await tx.integrationCredential.updateMany({
        where: { providerId },
        data: { isDefault: false },
      });
    if (before) {
      const expectedRevision = nonNegative(body.revision, "Versão da credencial");
      const changed = await tx.integrationCredential.updateMany({
        where: {
          id: before.id,
          providerId,
          revision: expectedRevision,
          revokedAt: null,
        },
        data: {
          label,
          enabled,
          sandbox,
          isDefault: body.isDefault === true || before.isDefault,
          config: split.config as Prisma.InputJsonValue,
          secretsCipherText: split.secretsCipherText,
          ownerLabel,
          expiresAt,
          lastRotatedAt: secretsRotated ? new Date() : before.lastRotatedAt,
          updatedBy: ctx.actor.user.id,
          revision: { increment: 1 },
        },
      });
      if (!changed.count)
        throw new IntegrationError(
          "A credencial mudou em outra sessão. Recarregue os dados e tente novamente.",
          409,
        );
      return tx.integrationCredential.findUniqueOrThrow({
        where: { id: before.id },
      });
    }
    return tx.integrationCredential.create({
      data: {
        providerId,
        label,
        enabled,
        sandbox,
        isDefault:
          body.isDefault === true ||
          !(await tx.integrationCredential.count({ where: { providerId } })),
        config: split.config as Prisma.InputJsonValue,
        secretsCipherText: split.secretsCipherText,
        ownerLabel,
        expiresAt,
        lastRotatedAt: secretsRotated ? new Date() : null,
        createdBy: ctx.actor.user.id,
        updatedBy: ctx.actor.user.id,
      },
    });
  });
  await audit(
    ctx,
    before ? "update" : "create",
    "credential",
    credential.id,
    before ? serializeCredential(before) : null,
    serializeCredential(credential),
  );
  return Response.json(
    { credential: serializeCredential(credential) },
    { status: before ? 200 : 201 },
  );
}

async function routingGet(db: PrismaClient, context?: string) {
  if (context && !(ROUTING_CONTEXTS as readonly string[]).includes(context))
    throw new IntegrationError("Contexto inválido.", 404);
  return Response.json({
    routing: context
      ? await db.integrationRouting.findUnique({ where: { context } })
      : await db.integrationRouting.findMany({
          where: { context: { in: [...ROUTING_CONTEXTS] } },
          orderBy: { context: "asc" },
        }),
  });
}

async function routingSave(
  ctx: Access,
  context: string,
  body: Record<string, unknown>,
) {
  if (!(ROUTING_CONTEXTS as readonly string[]).includes(context))
    throw new IntegrationError("Contexto inválido.", 404);
  const providerId = text(body.provider_id ?? body.provider, 80) || "auto",
    fallbackProviderId = text(
      body.fallback_provider_id ?? body.fallback_provider,
      80,
    );
  if (providerId !== "auto" && !PROVIDER_MAP.has(providerId))
    throw new IntegrationError("Provider primário inválido.");
  if (
    fallbackProviderId &&
    fallbackProviderId !== "_none" &&
    !PROVIDER_MAP.has(fallbackProviderId)
  )
    throw new IntegrationError("Provider fallback inválido.");
  if (providerId === fallbackProviderId)
    throw new IntegrationError(
      "O fallback precisa ser diferente do provider primário.",
    );
  const config = objectValue(body.config) as Prisma.InputJsonValue,
    before = await ctx.db.integrationRouting.findUnique({ where: { context } }),
    expectedRevision = nonNegative(body.revision, "Versão da rota"),
    route = await ctx.db.$transaction(async (tx) => {
      if (before) {
        const changed = await tx.integrationRouting.updateMany({
          where: { context, revision: expectedRevision },
          data: {
            providerId,
            fallbackProviderId,
            enabled: body.enabled !== false,
            config,
            revision: { increment: 1 },
            updatedBy: ctx.actor.user.id,
          },
        });
        if (!changed.count)
          throw new IntegrationError(
            "A rota mudou em outra sessão. Recarregue os dados e tente novamente.",
            409,
          );
        return tx.integrationRouting.findUniqueOrThrow({ where: { context } });
      }
      return tx.integrationRouting.create({
        data: {
          context,
          providerId,
          fallbackProviderId,
          enabled: body.enabled !== false,
          config,
          updatedBy: ctx.actor.user.id,
        },
      });
    });
  await audit(ctx, "update", "routing", context, before, route);
  return Response.json({ routing: route });
}

async function settingsGet(db: PrismaClient, section?: string) {
  const settings = await db.integrationSettings.findUniqueOrThrow({
    where: { id: 1 },
  });
  if (section) {
    if (!(section in DEFAULT_SETTINGS))
      throw new IntegrationError("Seção inválida.", 404);
    return Response.json({
      section,
      revision: settings.revision,
      settings: settingsSection(
        settings[section as keyof typeof DEFAULT_SETTINGS],
        section as keyof typeof DEFAULT_SETTINGS,
      ),
    });
  }
  return Response.json({
    settings: {
      ...settings,
      ...Object.fromEntries(
        Object.keys(DEFAULT_SETTINGS).map((key) => [
          key,
          settingsSection(
            settings[key as keyof typeof DEFAULT_SETTINGS],
            key as keyof typeof DEFAULT_SETTINGS,
          ),
        ]),
      ),
    },
  });
}

async function settingsSave(
  ctx: Access,
  section: string,
  body: Record<string, unknown>,
) {
  if (!(section in DEFAULT_SETTINGS))
    throw new IntegrationError("Seção inválida.", 404);
  const key = section as keyof typeof DEFAULT_SETTINGS,
    before = await ctx.db.integrationSettings.findUniqueOrThrow({
      where: { id: 1 },
    });
  const value = validateSettings(key, body.settings ?? body),
    expectedRevision = nonNegative(body.revision, "Versão das configurações");
  if (key === "storage" && value.delete_local_after_upload === true) {
    const credential = await ctx.db.integrationCredential.findFirst({
      where: { providerId: "storage_s3", enabled: true, lastTestOk: true },
      orderBy: { lastTestAt: "desc" },
    });
    if (
      !credential?.lastTestAt ||
      Date.now() - credential.lastTestAt.getTime() > 86400000
    )
      throw new IntegrationError(
        "Teste o armazenamento com sucesso nas últimas 24 horas antes de remover cópias locais.",
        422,
      );
  }
  const changed = await ctx.db.integrationSettings.updateMany({
    where: { id: 1, revision: expectedRevision },
    data: {
      [key]: value,
      updatedBy: ctx.actor.user.id,
      revision: { increment: 1 },
    },
  });
  if (!changed.count)
    throw new IntegrationError(
      "As configurações mudaram em outra sessão. Recarregue os dados e tente novamente.",
      409,
    );
  const updated = await ctx.db.integrationSettings.findUniqueOrThrow({
    where: { id: 1 },
  });
  await audit(ctx, "update", "settings", section, before[key], updated[key]);
  return Response.json({ section, settings: updated[key], revision: updated.revision });
}

function validateSettings(
  section: keyof typeof DEFAULT_SETTINGS,
  value: unknown,
): Record<string, unknown> {
  const merged = {
    ...objectValue(DEFAULT_SETTINGS[section]),
    ...objectValue(value),
  };
  if (section === "monitor") {
    if (![null, true, false].includes(merged.enabled as never))
      throw new IntegrationError(
        "O monitor aceita automático, ligado ou desligado.",
      );
    for (const key of [
      "interval_min",
      "realert_interval_min",
      "failure_threshold",
      "max_daily_alerts",
      "events_window",
    ])
      merged[key] = positive(merged[key], key);
  }
  if (section === "ai") {
    try {
      return { ...normalizeAiPolicy(value, objectValue(DEFAULT_SETTINGS.ai)) };
    } catch (error) {
      throw new IntegrationError(
        error instanceof Error ? error.message : "Política de IA inválida.",
      );
    }
  }
  if (
    section === "storage" &&
    merged.delete_local_after_upload === true &&
    Number(merged.keep_local_copy_days) < 1
  )
    throw new IntegrationError(
      "Mantenha uma cópia local por pelo menos um dia.",
    );
  return merged;
}

async function healthOne(
  db: PrismaClient,
  providerId: string,
  triggeredBy: "manual" | "cron" | "startup",
  credentialId?: string,
) {
  if (!PROVIDER_MAP.has(providerId))
    throw new IntegrationError("Provider inexistente.", 404);
  const credential = await db.integrationCredential.findFirst({
    where: {
      providerId,
      enabled: true,
      revokedAt: null,
      OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }],
      ...(credentialId ? { id: credentialId } : {}),
    },
    orderBy: [{ isDefault: "desc" }, { createdAt: "asc" }],
  });
  if (!credential)
    return Response.json({
      provider_id: providerId,
      status: "not_configured",
      success: false,
      message: "Integração não configurada.",
      latency_ms: 0,
      details: {},
    });
  const result = await testProvider(
    providerId,
    credential.config,
    await activeSecrets(db, credential),
  );
  await recordCredentialHealth(
    db,
    providerId,
    credential.id,
    result,
    triggeredBy,
  );
  await recordHealthState(db, providerId, result);
  return Response.json({
    provider_id: providerId,
    credential_id: credential.id,
    status: result.success ? "ok" : "error",
    ...result,
  });
}

async function healthAll(
  db: PrismaClient,
  triggeredBy: "manual" | "cron" | "startup",
  force: boolean,
) {
  if (!force) {
    const latest = await db.integrationHealthLog.findFirst({
      orderBy: { createdAt: "desc" },
    });
    if (
      latest &&
      Date.now() - latest.createdAt.getTime() < HEALTH_CACHE_MS &&
      triggeredBy === "manual"
    )
      return healthLast(db);
  }
  const credentials = await db.integrationCredential.findMany({
    where: {
      enabled: true,
      revokedAt: null,
      OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }],
    },
    orderBy: [{ providerId: "asc" }, { isDefault: "desc" }],
  });
  const results = await Promise.all(
    credentials.map(async (credential) => {
      const health = await testProvider(
        credential.providerId,
        credential.config,
        await activeSecrets(db, credential),
      );
      await recordCredentialHealth(
        db,
        credential.providerId,
        credential.id,
        health,
        triggeredBy,
      );
      return {
        provider_id: credential.providerId,
        credential_id: credential.id,
        status: health.success ? "ok" : "error",
        ...health,
      };
    }),
  );
  for (const [providerId, accountsValue] of Object.entries(
    Object.groupBy(results, (item) => item.provider_id),
  )) {
    const accounts = accountsValue || [],
      success = accounts.every((item) => item.success);
    await recordHealthState(db, providerId, {
      success,
      latency_ms: Math.max(0, ...accounts.map((item) => item.latency_ms)),
      message: success
        ? `${accounts.length} conta(s) operacional(is).`
        : `${accounts.filter((item) => !item.success).length} de ${accounts.length} conta(s) com falha.`,
      details: {
        accounts: accounts.map((item) => ({
          credential_id: item.credential_id,
          success: item.success,
          message: item.message,
        })),
      },
    });
  }
  return Response.json({ tested_at: new Date(), results });
}

async function healthLast(db: PrismaClient) {
  const states = await db.integrationHealthState.findMany({
    orderBy: { providerId: "asc" },
  });
  return Response.json({
    results: states.map((state) => ({
      ...state,
      status:
        Date.now() - state.lastCheckAt.getTime() > 86400000
          ? "stale"
          : state.status === "up"
            ? "ok"
            : state.status === "unknown"
              ? "not_configured"
              : "error",
    })),
  });
}

async function healthHistory(db: PrismaClient, request: Request) {
  const query = new URL(request.url).searchParams,
    providerId = query.get("provider") || undefined,
    limit = Math.min(200, positive(query.get("limit") || 50, "limit"));
  return Response.json({
    history: await db.integrationHealthLog.findMany({
      where: providerId ? { providerId } : {},
      orderBy: { createdAt: "desc" },
      take: limit,
    }),
  });
}

async function recordCredentialHealth(
  db: PrismaClient,
  providerId: string,
  credentialId: string,
  result: Awaited<ReturnType<typeof testProvider>>,
  triggeredBy: string,
) {
  const now = new Date();
  await db.$transaction([
    db.integrationHealthLog.create({
      data: {
        providerId,
        credentialId,
        success: result.success,
        latencyMs: result.latency_ms,
        message: result.message,
        details: result.details as Prisma.InputJsonValue,
        triggeredBy,
      },
    }),
    db.integrationCredential.update({
      where: { id: credentialId },
      data: {
        lastTestAt: now,
        lastTestOk: result.success,
        lastTestMessage: result.message,
      },
    }),
  ]);
}

async function recordHealthState(
  db: PrismaClient,
  providerId: string,
  result: Awaited<ReturnType<typeof testProvider>>,
) {
  const previous = await db.integrationHealthState.findUnique({
      where: { providerId },
    }),
    settings = await db.integrationSettings.findUniqueOrThrow({
      where: { id: 1 },
    }),
    monitor = settingsSection(settings.monitor, "monitor");
  const failures = result.success
      ? 0
      : (previous?.consecutiveFailures || 0) + 1,
    threshold = Number(monitor.failure_threshold || 2),
    status = result.success
      ? "up"
      : failures >= threshold
        ? "down"
        : "degraded",
    now = new Date();
  const previousEvents = Array.isArray(previous?.events) ? previous.events : [],
    changed = previous?.status !== status;
  const events = [
    ...previousEvents,
    {
      at: now.toISOString(),
      status,
      message: result.message,
      alert:
        changed &&
        (status === "down" || (previous?.status === "down" && status === "up")),
    },
  ].slice(-Number(monitor.events_window || 20));
  await db.integrationHealthState.upsert({
    where: { providerId },
    update: {
      status,
      since: changed ? now : previous?.since || now,
      lastCheckAt: now,
      consecutiveFailures: failures,
      events,
    },
    create: {
      providerId,
      status,
      since: now,
      lastCheckAt: now,
      consecutiveFailures: failures,
      events,
    },
  });
}

async function monitorStatus(db: PrismaClient) {
  const settings = await db.integrationSettings.findUniqueOrThrow({
      where: { id: 1 },
    }),
    credentials = await db.integrationCredential.count({
      where: { enabled: true },
    }),
    monitor = settingsSection(settings.monitor, "monitor");
  return Response.json({
    settings: monitor,
    revision: settings.revision,
    effective_enabled:
      monitor.enabled === null ? credentials > 0 : monitor.enabled,
    states: await db.integrationHealthState.findMany({
      orderBy: { providerId: "asc" },
    }),
  });
}

async function testAlert(ctx: Access) {
  await controlDb.emailOutbox.create({
    data: {
      recipient: ctx.organization.email,
      template: "integration_health_alert",
      subject: "Teste de alerta de integrações NALVEN",
      textBody: `O canal independente de alertas está configurado para ${ctx.organization.name}.`,
      htmlBody: `<p>O canal independente de alertas está configurado para <strong>${escapeHtml(ctx.organization.name)}</strong>.</p>`,
    },
  });
  await audit(ctx, "test", "monitor", "alert", null, {
    channel: "email_outbox",
    recipient: maskRecipient(ctx.organization.email),
    queued: true,
  });
  return Response.json({
    success: true,
    message:
      "Alerta enfileirado no canal de e-mail independente da integração monitorada.",
  });
}

async function testSend(ctx: Access, body: Record<string, unknown>) {
  const providerId = text(body.provider, 80),
    recipient = required(body.recipient, "Destinatário obrigatório."),
    message = required(body.message, "Mensagem obrigatória.");
  const credential = await ctx.db.integrationCredential.findFirst({
    where: {
      providerId,
      enabled: true,
      revokedAt: null,
      OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }],
    },
    orderBy: [{ isDefault: "desc" }, { createdAt: "asc" }],
  });
  if (!credential) throw new IntegrationError("Provider não configurado.", 422);
  const result = await sendWithProvider(
    {
      providerId,
      credentialId: credential.id,
      config: objectValue(credential.config),
      secrets: decryptSecrets(credential.secretsCipherText),
    },
    recipient,
    message,
  );
  await audit(ctx, "test", "provider", providerId, null, {
    success: result.success,
    recipient: maskRecipient(recipient),
  });
  return Response.json(result);
}

async function testOtp(ctx: Access, body: Record<string, unknown>) {
  const context = text(body.context, 80),
    recipient = required(body.recipient, "Destinatário obrigatório.");
  if (!OTP_CONTEXTS.has(context))
    throw new IntegrationError("Contexto OTP inválido.");
  const settings = await ctx.db.integrationSettings.findUniqueOrThrow({
      where: { id: 1 },
    }),
    general = settingsSection(settings.general, "general"),
    otp = objectValue(objectValue(settings.otp)[context]);
  const code = generateOtp(
      Number(otp.code_length || general.code_length),
      general.alphanumeric === true,
      general.allow_leading_zero !== false,
    ),
    message = String(otp.template || "Seu código é {code}.")
      .replaceAll("{code}", code)
      .replaceAll(
        "{expiry}",
        String(otp.code_expiry_sec || general.code_expiry_sec),
      );
  if (!/^\S+@\S+\.\S+$/.test(recipient))
    throw new IntegrationError("OTP aceita somente endereço de e-mail válido.");
  const credential = await ctx.db.integrationCredential.findFirst({
    where: {
      providerId: "smtp",
      enabled: true,
      revokedAt: null,
      OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }],
    },
    orderBy: [{ isDefault: "desc" }, { createdAt: "asc" }],
  });
  const resolved = credential
    ? {
        providerId: "smtp",
        credentialId: credential.id,
        config: objectValue(credential.config),
        secrets: decryptSecrets(credential.secretsCipherText),
      }
    : null;
  const result = resolved
    ? await sendWithProvider(resolved, recipient, message, {
        code,
        context,
        expiry: otp.code_expiry_sec || general.code_expiry_sec,
        subject: "Seu código de acesso",
      })
    : {
        success: false as const,
        message: "SMTP não configurado.",
        failureType: "transport" as const,
      };
  await ctx.db.integrationQueueItem.create({
    data: {
      eventType: "otp.test",
      context,
      providerId: "smtp",
      credentialId: credential?.id || null,
      channel: "smtp",
      recipientMasked: maskRecipient(recipient),
      payload: { test: true, context },
      state: result.success ? "success" : "failed",
      attempts: 1,
      lastError: result.success ? null : result.message,
      failureType: result.success ? null : result.failureType,
      finishedAt: new Date(),
    },
  });
  return Response.json({ ...result, provider_id: "smtp" });
}

async function testSmtp(ctx: Access, body: Record<string, unknown>) {
  return testSend(ctx, {
    provider: "smtp",
    recipient: body.recipient,
    message: "Teste de SMTP NALVEN",
  });
}

async function validateUrl(body: Record<string, unknown>) {
  const checked = await validatePublicHttpsUrl(
    required(body.url, "URL obrigatória."),
  );
  return Response.json({
    valid: true,
    host: checked.url.hostname,
    address: checked.address,
  });
}

async function queueGet(db: PrismaClient, request: Request) {
  const query = new URL(request.url).searchParams,
    state = query.get("state") || undefined,
    channel = query.get("channel") || undefined,
    context = query.get("context") || undefined,
    take = Math.min(100, positive(query.get("per_page") || 30, "per_page")),
    page = positive(query.get("page") || 1, "page");
  const where = {
    ...(state ? { state } : {}),
    ...(channel ? { channel } : {}),
    ...(context ? { context } : {}),
  };
  const [rows, total] = await db.$transaction([
    db.integrationQueueItem.findMany({
      where,
      orderBy: { createdAt: "desc" },
      take,
      skip: (page - 1) * take,
    }),
    db.integrationQueueItem.count({ where }),
  ]);
  return Response.json({
    queue: rows.map((item) => ({
      ...item,
      recipient: undefined,
      payload: redact(item.payload),
    })),
    pagination: { page, per_page: take, total, pages: Math.ceil(total / take) },
  });
}

async function queueRetry(ctx: Access, id?: string) {
  if (!id) throw new IntegrationError("Item da fila obrigatório.");
  const item = await ctx.db.integrationQueueItem.findUnique({ where: { id } });
  if (!item) throw new IntegrationError("Item da fila não encontrado.", 404);
  if (!["failed", "dead"].includes(item.state))
    throw new IntegrationError(
      "Somente itens falhos podem ser reenfileirados.",
      422,
    );
  const updated = await ctx.db.integrationQueueItem.update({
      where: { id },
      data: {
        state: "pending",
        attempts: 0,
        lastError: null,
        nextAttemptAt: new Date(),
        finishedAt: null,
      },
    });
  await audit(
    ctx,
    "retry",
    "queue_item",
    id,
    { state: item.state, attempts: item.attempts },
    { state: updated.state, attempts: updated.attempts },
  );
  return Response.json({ item: { ...updated, payload: redact(updated.payload) } });
}

async function queueBatch(ctx: Access, body: Record<string, unknown>) {
  const action = text(body.action, 20);
  if (!["retry", "cancel"].includes(action))
    throw new IntegrationError("Ação em lote inválida.");
  if (!Array.isArray(body.ids) || body.ids.length < 1 || body.ids.length > 100)
    throw new IntegrationError("Selecione entre 1 e 100 itens.");
  const ids = [...new Set(body.ids.map((item) => text(item, 100)).filter(Boolean))];
  if (!ids.length) throw new IntegrationError("Seleção da fila inválida.");
  const allowedStates = action === "retry" ? ["failed", "dead"] : ["pending", "processing", "failed", "dead"],
    before = await ctx.db.integrationQueueItem.findMany({
      where: { id: { in: ids }, state: { in: allowedStates } },
      select: { id: true, state: true },
    });
  if (!before.length)
    throw new IntegrationError("Nenhum item selecionado aceita esta operação.", 422);
  const result = await ctx.db.integrationQueueItem.updateMany({
    where: { id: { in: before.map((item) => item.id) }, state: { in: allowedStates } },
    data:
      action === "retry"
        ? {
            state: "pending",
            attempts: 0,
            lastError: null,
            nextAttemptAt: new Date(),
            finishedAt: null,
          }
        : { state: "cancelled", finishedAt: new Date() },
  });
  await audit(
    ctx,
    action === "retry" ? "batch_retry" : "batch_cancel",
    "queue_item",
    before.map((item) => item.id).join(","),
    { items: before },
    { count: result.count, state: action === "retry" ? "pending" : "cancelled" },
  );
  return Response.json({ ok: true, count: result.count });
}

async function metrics(db: PrismaClient, request: Request) {
  const range = new URL(request.url).searchParams.get("range") || "24h",
    days = range === "30d" ? 30 : range === "7d" ? 7 : 1,
    since = new Date(Date.now() - days * 86400000),
    rows = await db.integrationQueueItem.findMany({
      where: { createdAt: { gte: since } },
      select: {
        state: true,
        channel: true,
        lastError: true,
        createdAt: true,
        finishedAt: true,
      },
    }),
    healthRows = await db.integrationHealthLog.findMany({
      where: { createdAt: { gte: since } },
      select: { latencyMs: true },
    });
  const success = rows.filter((row) => row.state === "success").length,
    failed = rows.filter((row) =>
      ["failed", "dead"].includes(row.state),
    ).length,
    pending = rows.filter((row) => ["pending", "processing"].includes(row.state)).length,
    dead = rows.filter((row) => row.state === "dead").length,
    durations = rows
      .filter((row) => row.finishedAt)
      .map((row) => Math.max(0, row.finishedAt!.getTime() - row.createdAt.getTime()))
      .sort((left, right) => left - right),
    healthLatencies = healthRows.map((row) => row.latencyMs).sort((left, right) => left - right);
  const channels = new Map<
      string,
      { channel: string; total: number; succeeded: number }
    >(),
    errors = new Map<string, number>(),
    hours = new Map<
      string,
      { hour: string; total: number; succeeded: number }
    >();
  for (const row of rows) {
    const channel = channels.get(row.channel) || {
      channel: row.channel,
      total: 0,
      succeeded: 0,
    };
    channel.total++;
    if (row.state === "success") channel.succeeded++;
    channels.set(row.channel, channel);
    if (row.lastError)
      errors.set(row.lastError, (errors.get(row.lastError) || 0) + 1);
    const hourKey = row.createdAt.toISOString().slice(0, 13) + ":00:00Z",
      hour = hours.get(hourKey) || { hour: hourKey, total: 0, succeeded: 0 };
    hour.total++;
    if (row.state === "success") hour.succeeded++;
    hours.set(hourKey, hour);
  }
  return Response.json({
    range,
    total: rows.length,
    success,
    failed,
    pending,
    dead,
    delivery_rate: rows.length ? success / rows.length : 0,
    processing_p95_ms: percentile(durations, 0.95),
    provider_p95_ms: percentile(healthLatencies, 0.95),
    by_channel: [...channels.values()],
    top_errors: [...errors]
      .map(([error, count]) => ({ error, count }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 10),
    by_hour: [...hours.values()].sort((a, b) => a.hour.localeCompare(b.hour)),
  });
}

async function otpMetrics(db: PrismaClient, request: Request) {
  const range = new URL(request.url).searchParams.get("range") || "24h",
    days = range === "30d" ? 30 : range === "7d" ? 7 : 1,
    since = new Date(Date.now() - days * 86400000),
    rows = await db.integrationOtpChallenge.findMany({
      where: { createdAt: { gte: since } },
      select: { context: true, verifiedAt: true, fraudScore: true },
    }),
    verified = rows.filter((row) => row.verifiedAt).length;
  return Response.json({
    range,
    sent: rows.length,
    verified,
    conversion_rate: rows.length ? verified / rows.length : 0,
    suspected_fraud: rows.filter((row) => row.fraudScore >= 50).length,
    by_context: Object.entries(Object.groupBy(rows, (row) => row.context)).map(
      ([context, items]) => ({
        context,
        sent: items?.length || 0,
        verified: items?.filter((item) => item.verifiedAt).length || 0,
      }),
    ),
  });
}

async function optOutsGet(db: PrismaClient, request: Request) {
  const query = new URL(request.url).searchParams,
    rows = await db.integrationOptOut.findMany({
      where: query.get("channel") ? { channel: query.get("channel")! } : {},
      orderBy: { createdAt: "desc" },
      take: 500,
    });
  if (query.get("format") === "csv") {
    const csv = [
      "contato,canal,origem,data",
      ...rows.map((row) =>
        [
          row.contactMasked,
          row.channel,
          row.source,
          row.createdAt.toISOString(),
        ]
          .map(csvCell)
          .join(","),
      ),
    ].join("\n");
    return new Response(csv, {
      headers: {
        "content-type": "text/csv; charset=utf-8",
        "content-disposition": "attachment; filename=opt-outs.csv",
      },
    });
  }
  return Response.json({ opt_outs: rows });
}
async function optOutSave(ctx: Access, body: Record<string, unknown>) {
  const contact = required(body.contact, "Contato obrigatório."),
    channel = required(body.channel, "Canal obrigatório."),
    source = text(body.source, 120) || "panel";
  const item = await ctx.db.integrationOptOut.upsert({
    where: {
      contactHash_channel: { contactHash: contactHash(contact), channel },
    },
    update: { source },
    create: {
      contactHash: contactHash(contact),
      contactMasked: maskRecipient(contact),
      channel,
      source,
    },
  });
  return Response.json({ opt_out: item }, { status: 201 });
}
async function auditGet(db: PrismaClient, request: Request) {
  const query = new URL(request.url).searchParams,
    limit = Math.min(500, positive(query.get("limit") || 100, "limit")),
    from = query.get("from"),
    to = query.get("to");
  return Response.json({
    audit: await db.integrationAuditLog.findMany({
      where: {
        ...(query.get("action") ? { action: query.get("action")! } : {}),
        ...(query.get("target_type")
          ? { targetType: query.get("target_type")! }
          : {}),
        ...(from || to
          ? {
              createdAt: {
                ...(from ? { gte: new Date(from) } : {}),
                ...(to ? { lte: new Date(to) } : {}),
              },
            }
          : {}),
      },
      orderBy: { createdAt: "desc" },
      take: limit,
    }),
  });
}

async function aiUsage(ctx: Access, body: Record<string, unknown>) {
  const cost = Number(body.cost || 0),
    feature = required(body.feature, "Funcionalidade obrigatória."),
    model = required(body.model, "Modelo obrigatório."),
    units = positive(body.units || 1, "units");
  if (cost < 0 || !Number.isFinite(cost))
    throw new IntegrationError("Custo inválido.");
  const result = await ctx.db.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext('integration_ai_budget'))`;
    const settings = await tx.integrationSettings.findUniqueOrThrow({
        where: { id: 1 },
      }),
      ai = settingsSection(settings.ai, "ai"),
      start = new Date(
        Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth(), 1),
      ),
      [costs, featureUnits] = await Promise.all([
        tx.integrationAiUsage.aggregate({
          where: { createdAt: { gte: start } },
          _sum: { cost: true },
        }),
        tx.integrationAiUsage.aggregate({
          where: { createdAt: { gte: start }, feature },
          _sum: { units: true },
        }),
      ]),
      current = Number(costs._sum.cost || 0),
      budget = Number(ai.monthly_budget || 0),
      featureLimit = Number(objectValue(ai.per_feature_limits)[feature] || 0);
    if (budget > 0 && current + cost > budget)
      throw new IntegrationError(
        "Orçamento mensal de IA atingido. A chamada foi bloqueada.",
        402,
      );
    if (
      featureLimit > 0 &&
      Number(featureUnits._sum.units || 0) + units > featureLimit
    )
      throw new IntegrationError(
        "Limite mensal desta funcionalidade de IA atingido.",
        402,
      );
    const usage = await tx.integrationAiUsage.create({
      data: { feature, model, units, cost },
    });
    return {
      usage,
      current_month: current + cost,
      budget,
      feature_limit: featureLimit || null,
    };
  });
  return Response.json(result, { status: 201 });
}
async function storageMigration(ctx: Access, body: Record<string, unknown>) {
  const action = text(body.action, 30);
  if (action === "start") {
    const total = await ctx.db.tenantMediaAsset.count({
        where: { deletedAt: null },
      }),
      migration = await ctx.db.integrationMediaMigration.create({
        data: {
          status: "running",
          total,
          details: { reversible: true },
          startedAt: new Date(),
        },
      });
    await audit(ctx, "start", "storage_migration", migration.id, null, {
      status: migration.status,
      total: migration.total,
    });
    return Response.json({ migration }, { status: 201 });
  }
  const id = required(body.id, "Migração obrigatória."),
    before = await ctx.db.integrationMediaMigration.findUnique({
      where: { id },
    });
  if (!before) throw new IntegrationError("Migração não encontrada.", 404);
  if (action === "pause") {
    const migration = await ctx.db.integrationMediaMigration.update({
        where: { id },
        data: { status: "paused" },
      });
    await audit(ctx, "pause", "storage_migration", id, { status: before.status }, { status: migration.status });
    return Response.json({ migration });
  }
  if (action === "resume") {
    const migration = await ctx.db.integrationMediaMigration.update({
        where: { id },
        data: { status: "running" },
      });
    await audit(ctx, "resume", "storage_migration", id, { status: before.status }, { status: migration.status });
    return Response.json({ migration });
  }
  throw new IntegrationError("Ação de migração inválida.");
}

async function shippingQuote(ctx: Access, body: Record<string, unknown>) {
  const credential = await ctx.db.integrationCredential.findFirst({
      where: {
        providerId: "shipping",
        enabled: true,
        revokedAt: null,
        OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }],
      },
      orderBy: [{ isDefault: "desc" }, { createdAt: "asc" }],
    }),
    settingsRow = await ctx.db.integrationSettings.findUniqueOrThrow({
      where: { id: 1 },
    }),
    settings = settingsSection(settingsRow.shipping, "shipping"),
    fallback = Number(
      settings.fallback_flat_rate ||
        (credential && objectValue(credential.config).fallback_flat_rate) ||
        0,
    );
  if (!credential)
    return shippingFallback(ctx, fallback, "Provider de frete não configurado.");
  
  const config = objectValue(credential.config),
    secrets = decryptSecrets(credential.secretsCipherText),
    url = `${String(config.base_url).replace(/\/$/, "")}/quotes`,
    payload = JSON.stringify({
      origin_postcode: config.origin_postcode,
      destination_postcode: required(
        body.destination_postcode,
        "CEP de destino obrigatório.",
      ),
      items: Array.isArray(body.items) ? body.items : [],
      services: settings.services || [],
      markup_pct: settings.markup_pct || 0,
      markup_fixed: settings.markup_fixed || 0,
    });
  try {
    const response = await safeRequest(url, {
      method: "POST",
      body: payload,
      timeoutMs: 10000,
      headers: {
        authorization: `Bearer ${secrets.token}`,
        "content-type": "application/json",
      },
    });
    if (response.status >= 200 && response.status < 300)
      return Response.json({
        success: true,
        fallback: false,
        quote: JSON.parse(response.body),
      });
  } catch {
    /* continuidade de receita pelo fallback */
  }
  return shippingFallback(ctx, fallback, "API de frete indisponível.");
}

async function shippingFallback(ctx: Access, amount: number, reason: string) {
  await audit(ctx, "fallback", "shipping", "quote", null, {
    reason,
    amount,
    currency: "BRL",
  });
  return Response.json({
    success: true,
    fallback: true,
    amount,
    message: `${reason} Tarifa plana aplicada e ocorrência registrada.`,
  });
}

async function otpSend(ctx: Access, body: Record<string, unknown>) {
  const context = text(body.context, 80),
    recipient = required(body.recipient, "E-mail destinatário obrigatório.");
  if (!OTP_CONTEXTS.has(context))
    throw new IntegrationError("Contexto OTP inválido.");
  if (!/^\S+@\S+\.\S+$/.test(recipient))
    throw new IntegrationError("OTP aceita somente endereço de e-mail válido.");
  const requestHeaders = await headers(),
    ip =
      requestHeaders.get("x-forwarded-for")?.split(",")[0]?.trim() || "unknown",
    recipientHash = contactHash(recipient),
    ipHash = contactHash(ip),
    settingsRow = await ctx.db.integrationSettings.findUniqueOrThrow({
      where: { id: 1 },
    }),
    general = settingsSection(settingsRow.general, "general"),
    otpSettings = objectValue(objectValue(settingsRow.otp)[context]),
    windowStart = new Date(
      Date.now() - Number(general.send_window_sec || 3600) * 1000,
    );
  await persistentRateLimit(
    ctx.db,
    `otp:${context}:recipient:${recipientHash}`,
    Number(general.max_sends_per_window || 3),
    Number(general.send_window_sec || 3600),
  );
  await persistentRateLimit(
    ctx.db,
    `otp:${context}:ip:${ipHash}`,
    Number(general.max_sends_per_window || 3) * 5,
    Number(general.send_window_sec || 3600),
  );
  await persistentRateLimit(
    ctx.db,
    `otp:${context}:cooldown:${recipientHash}`,
    1,
    Number(general.cooldown_between_sends_sec || 60),
  );
  const cooldownStart = new Date(
      Date.now() - Number(general.cooldown_between_sends_sec || 60) * 1000,
    ),
    [recipientCount, ipCount, differentRecipients, recent] = await Promise.all([
      ctx.db.integrationOtpChallenge.count({
        where: { recipientHash, context, createdAt: { gte: windowStart } },
      }),
      ctx.db.integrationOtpChallenge.count({
        where: { ipHash, context, createdAt: { gte: windowStart } },
      }),
      ctx.db.integrationOtpChallenge.findMany({
        where: { ipHash, context, createdAt: { gte: windowStart } },
        distinct: ["recipientHash"],
        select: { recipientHash: true },
      }),
      ctx.db.integrationOtpChallenge.findFirst({
        where: { recipientHash, context, createdAt: { gte: cooldownStart } },
        select: { createdAt: true },
      }),
    ]);
  if (recent)
    throw new IntegrationError("Aguarde antes de solicitar outro código.", 429);
  if (
    recipientCount >= Number(general.max_sends_per_window || 3) ||
    ipCount >= Number(general.max_sends_per_window || 3) * 5
  )
    throw new IntegrationError("Limite de envios OTP atingido.", 429);
  const fraud = objectValue(general.fraud),
    fraudScore = Math.min(
      100,
      differentRecipients.length >= 10
        ? 80
        : differentRecipients.length >= 5
          ? 55
          : ipCount >= 8
            ? 45
            : 0,
    );
  if (
    fraud.enabled !== false &&
    fraudScore >= Number(fraud.block_threshold || 80)
  )
    throw new IntegrationError(
      "Solicitação bloqueada pela política antifraude.",
      403,
    );
  const length = Number(otpSettings.code_length || general.code_length || 6),
    expiry = Number(
      otpSettings.code_expiry_sec || general.code_expiry_sec || 600,
    ),
    code = generateOtp(
      length,
      general.alphanumeric === true,
      general.allow_leading_zero !== false,
    ),
    salt = randomBytes(16).toString("hex"),
    codeHash = `${salt}:${createHash("sha256").update(`${salt}:${code}`).digest("hex")}`,
    template = String(otpSettings.template || "Seu código é {code}.")
      .replaceAll("{code}", code)
      .replaceAll("{expiry}", String(expiry));
  const smtpCredential = await ctx.db.integrationCredential.findFirst({
    where: {
      providerId: "smtp",
      enabled: true,
      revokedAt: null,
      OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }],
    },
    orderBy: [{ isDefault: "desc" }, { createdAt: "asc" }],
  });
  const used = smtpCredential
    ? {
        providerId: "smtp",
        credentialId: smtpCredential.id,
        config: objectValue(smtpCredential.config),
        secrets: decryptSecrets(smtpCredential.secretsCipherText),
      }
    : null;
  const result = used
    ? await sendWithProvider(used, recipient, template, {
        code,
        context,
        expiry,
        subject: "Seu código de acesso",
      })
    : {
        success: false as const,
        message: "SMTP não configurado.",
        failureType: "transport" as const,
      };
  if (!result.success)
    throw new IntegrationError(
      result.message,
      result.failureType === "transport" ? 502 : 422,
    );
  const challenge = await ctx.db.integrationOtpChallenge.create({
    data: {
      context,
      recipientHash,
      recipientMasked: maskRecipient(recipient),
      ipHash,
      codeHash,
      fraudScore,
      maxAttempts: Number(general.max_verifies_per_window || 5),
      expiresAt: new Date(Date.now() + expiry * 1000),
    },
  });
  await ctx.db.integrationQueueItem.create({
    data: {
      eventType: "otp.sent",
      context,
      providerId: used?.providerId,
      credentialId: used?.credentialId,
      channel: used?.providerId || "none",
      recipientMasked: maskRecipient(recipient),
      payload: { challenge_id: challenge.id, fraud_score: fraudScore },
      remoteMessageId: result.message_id,
      state: "success",
      attempts: 1,
      finishedAt: new Date(),
    },
  });
  return Response.json(
    {
      challenge_id: challenge.id,
      expires_in: expiry,
      provider_id: used?.providerId,
      fraud:
        fraudScore >= Number(fraud.suspect_threshold || 50)
          ? "suspect"
          : "clear",
    },
    { status: 201 },
  );
}

async function otpVerify(ctx: Access, body: Record<string, unknown>) {
  const id = required(body.challenge_id, "Desafio obrigatório."),
    code = required(body.code, "Código obrigatório."),
    requestHeaders = await headers(),
    ip =
      requestHeaders.get("x-forwarded-for")?.split(",")[0]?.trim() || "unknown";
  await persistentRateLimit(
    ctx.db,
    `otp:verify:${id}:${contactHash(ip)}`,
    10,
    900,
  );
  const result = await ctx.db.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`otp_verify:${id}`}))`;
    const challenge = await tx.integrationOtpChallenge.findUnique({
      where: { id },
    });
    if (!challenge)
      throw new IntegrationError("Código inválido ou expirado.", 422);
    if (challenge.verifiedAt) return { verified: true, already_verified: true };
    if (
      challenge.expiresAt <= new Date() ||
      challenge.attempts >= challenge.maxAttempts
    )
      throw new IntegrationError("Código inválido ou expirado.", 422);
    const [salt, stored] = challenge.codeHash.split(":"),
      candidate = createHash("sha256").update(`${salt}:${code}`).digest("hex"),
      valid = constantTimeEqual(stored, candidate);
    await tx.integrationOtpChallenge.update({
      where: { id },
      data: {
        attempts: { increment: 1 },
        verifiedAt: valid ? new Date() : null,
      },
    });
    if (!valid) throw new IntegrationError("Código inválido ou expirado.", 422);
    return { verified: true };
  });
  return Response.json(result);
}

async function oauthStart(
  request: Request,
  ctx: Access,
  platform: string,
  body: Record<string, unknown>,
) {
  const credential = body.credential_id
    ? await ctx.db.integrationCredential.findFirst({
        where: {
          id: text(body.credential_id, 100),
          providerId: "marketplace",
          revokedAt: null,
          OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }],
        },
      })
    : await ctx.db.integrationCredential.findFirst({
        where: {
          providerId: "marketplace",
          enabled: true,
          revokedAt: null,
          OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }],
        },
        orderBy: [{ isDefault: "desc" }, { createdAt: "asc" }],
      });
  if (!credential)
    throw new IntegrationError(
      "Configure uma credencial de marketplace antes de conectar.",
      422,
    );
  const config = objectValue(credential.config),
    secrets = decryptSecrets(credential.secretsCipherText),
    authorizationUrl = required(
      config.authorization_url,
      "URL de autorização não configurada.",
    ),
    tokenUrl = required(config.token_url, "URL de token não configurada."),
    clientId = required(config.client_id, "Client ID não configurado.");
  if (!secrets.client_secret)
    throw new IntegrationError("Client secret não configurado.");
  await validatePublicHttpsUrl(authorizationUrl);
  await validatePublicHttpsUrl(tokenUrl);
  const state = randomBytes(32).toString("base64url"),
    codeVerifier = randomBytes(48).toString("base64url"),
    codeChallenge = createHash("sha256")
      .update(codeVerifier)
      .digest("base64url"),
    redirectUri = `${new URL(request.url).origin}/api/erp/integrations/${encodeURIComponent(platform)}/callback`;
  await controlDb.integrationOAuthState.create({
    data: {
      state,
      organizationId: ctx.organization.id,
      userId: ctx.actor.user.id,
      platform,
      credentialId: credential.id,
      redirectUri,
      tokenUrl,
      codeVerifier,
      expiresAt: new Date(Date.now() + 10 * 60000),
    },
  });
  const url = new URL(authorizationUrl);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", clientId);
  url.searchParams.set("redirect_uri", redirectUri);
  url.searchParams.set("state", state);
  url.searchParams.set("code_challenge", codeChallenge);
  url.searchParams.set("code_challenge_method", "S256");
  return Response.json({
    authorization_url: url.toString(),
    expires_at: new Date(Date.now() + 10 * 60000),
  });
}

async function oauthCallback(request: Request, platform: string) {
  const url = new URL(request.url),
    stateValue = url.searchParams.get("state") || "",
    code = url.searchParams.get("code") || "",
    providerError = text(url.searchParams.get("error"), 120);
  if (providerError)
    throw new IntegrationError(
      `O provedor recusou a autorização OAuth (${providerError}).`,
      409,
    );
  if (!stateValue || !code)
    throw new IntegrationError("Callback OAuth incompleto.", 409);
  const state = await controlDb.integrationOAuthState.findUnique({
    where: { state: stateValue },
  });
  if (
    !state ||
    state.platform !== platform ||
    state.usedAt ||
    state.expiresAt <= new Date()
  )
    throw new IntegrationError("State OAuth inválido ou expirado.", 409);
  const organization = await controlDb.organization.findUniqueOrThrow({where:{id:state.organizationId}});
  if (!planAllows(organization.modules,"marketplaces")) throw new IntegrationError("Marketplaces não estão habilitados neste plano.",403);
  const claimed = await controlDb.integrationOAuthState.updateMany({
    where: {
      state: stateValue,
      platform,
      usedAt: null,
      expiresAt: { gt: new Date() },
    },
    data: { usedAt: new Date() },
  });
  if (!claimed.count)
    throw new IntegrationError("State OAuth já utilizado.", 409);
  const db = await tenantDb(state.organizationId),
    credential = state.credentialId
      ? await db.integrationCredential.findUnique({
          where: { id: state.credentialId },
        })
      : null;
  if (
    !credential ||
    credential.revokedAt ||
    (credential.expiresAt && credential.expiresAt <= new Date())
  )
    throw new IntegrationError("Credencial OAuth não encontrada.", 404);
  const config = objectValue(credential.config),
    secrets = decryptSecrets(credential.secretsCipherText),
    body = new URLSearchParams({
      grant_type: "authorization_code",
      code,
      redirect_uri: state.redirectUri,
      client_id: String(config.client_id || ""),
      client_secret: secrets.client_secret || "",
      ...(state.codeVerifier ? { code_verifier: state.codeVerifier } : {}),
    }).toString();
  const response = await safeRequest(state.tokenUrl, {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      accept: "application/json",
    },
    body,
    timeoutMs: 10000,
  });
  if (response.status < 200 || response.status >= 300)
    throw new IntegrationError(
      "O provedor recusou a troca do código OAuth.",
      502,
    );
  const token = objectValue(JSON.parse(response.body)),
    updatedSecrets = {
      ...secrets,
      access_token: String(token.access_token || ""),
      refresh_token: String(token.refresh_token || secrets.refresh_token || ""),
    };
  if (!updatedSecrets.access_token)
    throw new IntegrationError("Resposta OAuth sem access token.", 502);
  await db.$transaction([
    db.integrationCredential.update({
      where: { id: credential.id },
      data: {
        enabled: true,
        revision: { increment: 1 },
        lastRotatedAt: new Date(),
        config: {
          ...config,
          connection_status: "connected",
          token_expires_at: token.expires_in
            ? new Date(
                Date.now() + Number(token.expires_in) * 1000,
              ).toISOString()
            : null,
        },
        secretsCipherText: encryptSecrets(updatedSecrets),
      },
    }),
    db.integrationAuditLog.create({
      data: {
        userId: state.userId,
        action: "connect",
        targetType: "credential",
        targetId: credential.id,
        afterData: { platform, connected: true },
      },
    }),
  ]);
  return Response.redirect(
    `${url.origin}/erp/integracoes?tab=conexoes&oauth=connected`,
    303,
  );
}

async function oauthDisconnect(
  ctx: Access,
  platform: string,
  body: Record<string, unknown>,
) {
  const id = required(body.credential_id, "Credencial obrigatória."),
    credential = await ctx.db.integrationCredential.findFirst({
      where: { id, providerId: "marketplace", revokedAt: null },
    });
  if (!credential) throw new IntegrationError("Conexão não encontrada.", 404);
  const current = decryptSecrets(credential.secretsCipherText);
  delete current.access_token;
  delete current.refresh_token;
  await ctx.db.integrationCredential.update({
    where: { id },
    data: {
      enabled: false,
      revision: { increment: 1 },
      updatedBy: ctx.actor.user.id,
      secretsCipherText: encryptSecrets(current),
      config: {
        ...objectValue(credential.config),
        connection_status: "disconnected",
        platform,
      },
    },
  });
  await audit(
    ctx,
    "disconnect",
    "credential",
    id,
    { connected: true },
    { connected: false },
  );
  return Response.json({ ok: true });
}

async function audit(
  ctx: Access,
  action: string,
  targetType: string,
  targetId: string,
  beforeData: unknown,
  afterData: unknown,
) {
  const requestHeaders = await headers();
  await ctx.db.integrationAuditLog.create({
    data: {
      userId: ctx.actor.user.id,
      action,
      targetType,
      targetId,
      beforeData:
        beforeData == null ? undefined : (redact(beforeData) as never),
      afterData: afterData == null ? undefined : (redact(afterData) as never),
      ip:
        requestHeaders
          .get("x-forwarded-for")
          ?.split(",")[0]
          ?.trim()
          .slice(0, 45) || null,
    },
  });
}
async function segments(context: RouteContext) {
  return (await context.params).path || [];
}
async function jsonBody(request: Request) {
  return readIntegrationJson(request);
}

function text(value: unknown, max: number) {
  return String(value ?? "")
    .trim()
    .slice(0, max);
}
function required(value: unknown, message: string) {
  const result = text(value, 10000);
  if (!result) throw new IntegrationError(message);
  return result;
}
function positive(value: unknown, label: string) {
  const number = Number(value);
  if (!Number.isInteger(number) || number < 1)
    throw new IntegrationError(`${label} inválido.`);
  return number;
}
function nonNegative(value: unknown, label: string) {
  const number = Number(value);
  if (!Number.isInteger(number) || number < 0)
    throw new IntegrationError(`${label} inválida.`);
  return number;
}
function optionalDate(value: unknown, message: string) {
  if (value == null || String(value).trim() === "") return null;
  const date = new Date(String(value));
  if (Number.isNaN(date.getTime())) throw new IntegrationError(message);
  return date;
}
function percentile(values: number[], quantile: number) {
  if (!values.length) return 0;
  return values[Math.min(values.length - 1, Math.ceil(values.length * quantile) - 1)];
}
function csvCell(value: unknown) {
  const text = String(value ?? "");
  return /[",\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}
function escapeHtml(value: string) {
  return value.replace(
    /[&<>"']/g,
    (character) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        character
      ]!,
  );
}
async function activeSecrets(
  db: PrismaClient,
  credential: {
    id: string;
    providerId: string;
    config: unknown;
    secretsCipherText: string | null;
  },
) {
  const secrets = decryptSecrets(credential.secretsCipherText),
    config = objectValue(credential.config),
    expiry = new Date(String(config.token_expires_at || 0));
  if (
    credential.providerId === "marketplace" &&
    secrets.refresh_token &&
    expiry.getTime() <= Date.now() + 60000
  )
    return {
      ...secrets,
      access_token: await refreshOAuthToken(db, credential.id),
    };
  return secrets;
}
function failure(error: unknown) {
  if (error instanceof IntegrationError)
    return Response.json(
      { error: error.message },
      {
        status: error.status,
        headers: error.status === 429 ? { "Retry-After": "60" } : undefined,
      },
    );
  if (error instanceof LicenseDeniedError)
    return Response.json({ error: error.message }, { status: error.status });
  if (error instanceof AuthError) return authErrorResponse(error);
  return unexpectedErrorResponse("erp.integrations", error);
}
