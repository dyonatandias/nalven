import { randomUUID } from "node:crypto";
import { currentOrganization, tenantDb } from "@/db";
import { Prisma } from "@/generated/tenant/client";
import { AuthError, authErrorResponse } from "@/lib/auth";
import { assertSameOrigin } from "@/lib/erp/customer-input";
import { assertTenantPermission, matches } from "@/lib/erp/permissions";
import {
  analyzeTransactionalTemplate,
  EMAIL_STATUS_META,
  isPermanentDeliveryError,
  parseTransactionalEmailQuery,
  publicDeliveryError,
  renderTransactionalTemplate,
  transactionalDeliveryCsv,
} from "@/lib/erp/transactional-email-center";
import { assertTenantWriteAccess } from "@/lib/tenant-access";
import {
  activeCredentialFilter,
  decryptSecrets,
  encryptSecrets,
  IntegrationError,
  maskRecipient,
  objectValue,
  persistentRateLimit,
} from "@/lib/integrations/core";
import { sendWithProvider } from "@/lib/integrations/providers";
import {
  defaultEmailContent,
  TRANSACTIONAL_EMAIL_CATALOG,
} from "@/lib/integrations/transactional-email-catalog";
import { HttpSecurityError, readJsonObject } from "@/lib/http-security";
import { BRAZIL_TIME_ZONE, dateTimeFormatter } from "@/lib/timezone";

const NO_STORE = { "cache-control": "private, no-store, max-age=0" };
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

async function access(write = false) {
  const organization = await currentOrganization();
  const actor = await assertTenantPermission(
    organization.id,
    write ? "transactional-email.write" : "transactional-email.read",
  );
  if (write) await assertTenantWriteAccess(organization.id);
  return { organization, actor, db: await tenantDb(organization.id) };
}

export async function GET(request: Request) {
  try {
    const ctx = await access();
    const query = parseTransactionalEmailQuery(new URL(request.url).searchParams);
    const since = new Date(Date.now() - query.days * 86_400_000);
    const definitions = await ctx.db.transactionalEmailDefinition.findMany({
      include: {
        versions: {
          orderBy: { version: "desc" },
          take: 20,
          include: { _count: { select: { deliveries: true } } },
        },
      },
      orderBy: [{ category: "asc" }, { label: "asc" }],
    });
    const definitionMap = new Map(
      definitions.map((definition) => [definition.eventKey, definition]),
    );
    const categoryKeys = query.category
      ? definitions
          .filter((definition) => definition.category === query.category)
          .map((definition) => definition.eventKey)
      : null;
    const where: Prisma.TransactionalEmailDeliveryWhereInput = {
      createdAt: { gte: since },
      ...(query.status ? { status: query.status } : {}),
      ...(query.eventKey
        ? { eventKey: query.eventKey }
        : categoryKeys
          ? { eventKey: { in: categoryKeys } }
          : {}),
      ...(query.search
        ? {
            OR: [
              { eventId: { contains: query.search, mode: "insensitive" } },
              { eventKey: { contains: query.search, mode: "insensitive" } },
              { recipientMasked: { contains: query.search, mode: "insensitive" } },
              { remoteMessageId: { contains: query.search, mode: "insensitive" } },
            ],
          }
        : {}),
    };
    if (query.csv) {
      const rows = await ctx.db.transactionalEmailDelivery.findMany({
        where,
        select: deliverySelect,
        orderBy: { createdAt: "desc" },
        take: 10_000,
      });
      return new Response(transactionalDeliveryCsv(rows.map(deliveryDto)), {
        headers: {
          ...NO_STORE,
          "content-type": "text/csv; charset=utf-8",
          "content-disposition": `attachment; filename="entregas-email-${new Date().toISOString().slice(0, 10)}.csv"`,
        },
      });
    }
    const periodWhere = { createdAt: { gte: since } };
    const [
      total,
      deliveryRows,
      statusGroups,
      eventGroups,
      dailyRows,
      smtpRows,
      oldestBacklog,
    ] = await Promise.all([
      ctx.db.transactionalEmailDelivery.count({ where }),
      ctx.db.transactionalEmailDelivery.findMany({
        where,
        select: deliverySelect,
        orderBy: { createdAt: "desc" },
        skip: (query.page - 1) * query.limit,
        take: query.limit,
      }),
      ctx.db.transactionalEmailDelivery.groupBy({
        by: ["status"],
        where: periodWhere,
        _count: { _all: true },
        _sum: { attempts: true },
      }),
      ctx.db.transactionalEmailDelivery.groupBy({
        by: ["eventKey"],
        where: periodWhere,
        _count: { _all: true },
        orderBy: { _count: { eventKey: "desc" } },
        take: 12,
      }),
      ctx.db.$queryRaw<Array<{ day: Date; status: string; total: number }>>(
        Prisma.sql`
          SELECT date_trunc('day', created_at) AS day,
                 status,
                 COUNT(*)::int AS total
            FROM transactional_email_deliveries
           WHERE created_at >= ${since}
           GROUP BY 1, 2
           ORDER BY 1 ASC
        `,
      ),
      ctx.db.integrationCredential.findMany({
        where: { providerId: "smtp", revokedAt: null },
        select: {
          id: true,
          label: true,
          enabled: true,
          revision: true,
          ownerLabel: true,
          expiresAt: true,
          lastRotatedAt: true,
          config: true,
          secretsCipherText: true,
          sandbox: true,
          isDefault: true,
          lastTestAt: true,
          lastTestOk: true,
          lastTestMessage: true,
          createdAt: true,
        },
        orderBy: [{ isDefault: "desc" }, { createdAt: "asc" }],
      }),
      ctx.db.transactionalEmailDelivery.findFirst({
        where: { status: { in: ["pending", "processing", "failed", "dead"] } },
        select: { createdAt: true },
        orderBy: { createdAt: "asc" },
      }),
    ]);
    const statusCounts = Object.fromEntries(
      statusGroups.map((row) => [row.status, row._count._all]),
    );
    const sent = statusCounts.sent || 0;
    const terminalFailures = (statusCounts.failed || 0) + (statusCounts.dead || 0);
    const attempted = sent + terminalFailures;
    const now = new Date();
    const activeSmtp = smtpRows.filter(
      (account) =>
        account.enabled &&
        (!account.expiresAt || account.expiresAt.getTime() > now.getTime()),
    );
    const healthySmtp = activeSmtp.filter(
      (account) =>
        account.lastTestOk === true &&
        account.lastTestAt &&
        now.getTime() - account.lastTestAt.getTime() <= 86_400_000,
    );
    const insecureSmtp = activeSmtp.filter(
      (account) => !["tls", "ssl"].includes(String(objectValue(account.config).encryption)),
    );
    const unpublished = definitions.filter(
      (definition) =>
        !definition.versions.some((version) => version.status === "published"),
    );
    const criticalUnpublished = unpublished.filter((definition) => definition.critical);
    const blockers = [
      ...(activeSmtp.length ? [] : ["Nenhuma conta SMTP ativa e válida"]),
      ...(activeSmtp.length && !healthySmtp.length
        ? ["Nenhuma conta SMTP foi validada com sucesso nas últimas 24 horas"]
        : []),
      ...(insecureSmtp.length
        ? [`${insecureSmtp.length} conta(s) permitem transporte sem TLS`]
        : []),
      ...(criticalUnpublished.length
        ? [`${criticalUnpublished.length} evento(s) crítico(s) sem versão publicada`]
        : []),
      ...((statusCounts.dead || 0)
        ? [`${statusCounts.dead} entrega(s) exigem intervenção`]
        : []),
    ];
    const categories = [...new Set(definitions.map((item) => item.category))];
    const categoryTotals = Object.fromEntries(categories.map((item) => [item, 0]));
    for (const row of eventGroups) {
      const category = definitionMap.get(row.eventKey)?.category || "Outros";
      categoryTotals[category] = (categoryTotals[category] || 0) + row._count._all;
    }
    const periodTotal = statusGroups.reduce((sum, row) => sum + row._count._all, 0);
    return Response.json(
      {
        generatedAt: now,
        filters: query,
        permissions: {
          canWrite: matches(ctx.actor.permissions, "transactional-email.write"),
          canManageSmtp: matches(ctx.actor.permissions, "integrations.write"),
        },
        summary: {
          total: periodTotal,
          sent,
          pending: (statusCounts.pending || 0) + (statusCounts.processing || 0),
          failed: terminalFailures,
          dead: statusCounts.dead || 0,
          deliveryRate: attempted ? Math.round((sent / attempted) * 10_000) / 100 : null,
          averageAttempts: periodTotal
            ? Math.round(
                (statusGroups.reduce((sum, row) => sum + (row._sum.attempts || 0), 0) /
                  periodTotal) *
                  100,
              ) / 100
            : 0,
          published: definitions.length - unpublished.length,
          catalog: definitions.length,
        },
        readiness: {
          state: activeSmtp.length ? (blockers.length ? "attention" : "ready") : "blocked",
          blockers,
          activeSmtp: activeSmtp.length,
          healthySmtp: healthySmtp.length,
          secureSmtp: activeSmtp.length - insecureSmtp.length,
          unpublished: unpublished.length,
          criticalUnpublished: criticalUnpublished.length,
        },
        breakdown: {
          statuses: Object.keys(EMAIL_STATUS_META).map((status) => ({
            status,
            ...EMAIL_STATUS_META[status],
            count: statusCounts[status] || 0,
          })),
          daily: dailySeries(query.days, dailyRows),
          events: eventGroups.map((row) => ({
            eventKey: row.eventKey,
            label: definitionMap.get(row.eventKey)?.label || row.eventKey,
            category: definitionMap.get(row.eventKey)?.category || "Outros",
            count: row._count._all,
          })),
          categories: Object.entries(categoryTotals)
            .map(([category, count]) => ({ category, count }))
            .sort((left, right) => right.count - left.count),
        },
        operations: {
          oldestBacklogMinutes: oldestBacklog
            ? Math.max(0, Math.floor((now.getTime() - oldestBacklog.createdAt.getTime()) / 60_000))
            : 0,
          retryable: (statusCounts.failed || 0) + (statusCounts.dead || 0),
        },
        definitions: definitions.map((definition) => ({
          id: definition.id,
          eventKey: definition.eventKey,
          label: definition.label,
          category: definition.category,
          description: definition.description,
          variables: stringArray(definition.variables),
          critical: definition.critical,
          enabled: definition.enabled,
          versions: definition.versions.map((version) => ({
            id: version.id,
            version: version.version,
            status: version.status,
            subject: version.subject,
            htmlBody: version.htmlBody,
            textBody: version.textBody,
            publishedAt: version.publishedAt,
            createdAt: version.createdAt,
            deliveryCount: version._count.deliveries,
          })),
        })),
        deliveries: deliveryRows.map(deliveryDto),
        pagination: {
          page: query.page,
          limit: query.limit,
          total,
          pages: Math.max(1, Math.ceil(total / query.limit)),
        },
        smtp: smtpRows.map(smtpDto),
        catalogSize: TRANSACTIONAL_EMAIL_CATALOG.length,
      },
      { headers: NO_STORE },
    );
  } catch (error) {
    return failure(error);
  }
}

export async function POST(request: Request) {
  try {
    assertSameOrigin(request);
    const ctx = await access(true);
    const body = objectValue(await readJsonObject(request, 262_144));
    const action = String(body.action || "");
    await persistentRateLimit(
      ctx.db,
      `${ctx.actor.user.id}:transactional-email:${action}`,
      action === "test" ? 5 : action === "retry-all" ? 3 : 30,
      60,
    );
    if (action === "save") return await saveVersion(ctx, body);
    if (action === "publish") return await publishVersion(ctx, body);
    if (action === "archive") return await archiveVersion(ctx, body);
    if (action === "toggle") return await toggleDefinition(ctx, body);
    if (action === "test") return await testVersion(ctx, body);
    if (action === "retry") return await retryDelivery(ctx, body);
    if (action === "retry-all") return await retryAll(ctx);
    throw new IntegrationError("Ação de e-mail transacional inválida.");
  } catch (error) {
    return failure(error);
  }
}

type Context = Awaited<ReturnType<typeof access>>;

async function saveVersion(ctx: Context, body: Record<string, unknown>) {
  const eventKey = required(body.eventKey, "Evento obrigatório.");
  const definition = await ctx.db.transactionalEmailDefinition.findUnique({
    where: { eventKey },
  });
  if (!definition)
    throw new IntegrationError("Evento transacional inexistente.", 404);
  const content = templateContent(body, stringArray(definition.variables));
  let version;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      version = await ctx.db.$transaction(
        async (tx) => {
          const latest = await tx.transactionalEmailVersion.findFirst({
            where: { definitionId: definition.id },
            orderBy: { version: "desc" },
            select: { version: true },
          });
          return tx.transactionalEmailVersion.create({
            data: {
              definitionId: definition.id,
              version: (latest?.version || 0) + 1,
              ...content,
              createdBy: ctx.actor.user.id,
            },
          });
        },
        { isolationLevel: "Serializable", maxWait: 10_000, timeout: 30_000 },
      );
      break;
    } catch (error) {
      if (!retryableConflict(error) || attempt === 2) throw error;
    }
  }
  if (!version)
    throw new IntegrationError("Não foi possível criar a versão.", 409);
  await audit(ctx, "email.version.create", version.id, {
    eventKey,
    version: version.version,
  });
  return Response.json({ version }, { status: 201, headers: NO_STORE });
}

async function publishVersion(ctx: Context, body: Record<string, unknown>) {
  const versionId = required(body.versionId, "Versão obrigatória.");
  const version = await ctx.db.transactionalEmailVersion.findUnique({
    where: { id: versionId },
    include: { definition: true },
  });
  if (!version) throw new IntegrationError("Versão inexistente.", 404);
  templateContent(version, stringArray(version.definition.variables));
  const updated = await ctx.db.$transaction(
    async (tx) => {
      await tx.transactionalEmailVersion.updateMany({
        where: {
          definitionId: version.definitionId,
          status: "published",
          id: { not: version.id },
        },
        data: { status: "archived" },
      });
      return tx.transactionalEmailVersion.update({
        where: { id: version.id },
        data: { status: "published", publishedAt: new Date() },
      });
    },
    { isolationLevel: "Serializable", maxWait: 10_000, timeout: 30_000 },
  );
  await audit(ctx, "email.version.publish", updated.id, {
    eventKey: version.definition.eventKey,
    version: version.version,
  });
  return Response.json({ version: updated }, { headers: NO_STORE });
}

async function archiveVersion(ctx: Context, body: Record<string, unknown>) {
  const versionId = required(body.versionId, "Versão obrigatória.");
  const version = await ctx.db.transactionalEmailVersion.findUnique({
    where: { id: versionId },
    include: { definition: true },
  });
  if (!version) throw new IntegrationError("Versão inexistente.", 404);
  if (version.status === "published")
    throw new IntegrationError(
      "Publique outra versão antes de arquivar a versão ativa.",
      422,
    );
  const updated = await ctx.db.transactionalEmailVersion.update({
    where: { id: version.id },
    data: { status: "archived" },
  });
  await audit(ctx, "email.version.archive", updated.id, {
    eventKey: version.definition.eventKey,
    version: version.version,
  });
  return Response.json({ version: updated }, { headers: NO_STORE });
}

async function toggleDefinition(ctx: Context, body: Record<string, unknown>) {
  const eventKey = required(body.eventKey, "Evento obrigatório.");
  const before = await ctx.db.transactionalEmailDefinition.findUnique({
    where: { eventKey },
  });
  if (!before) throw new IntegrationError("Evento inexistente.", 404);
  if (before.critical && body.enabled === false)
    throw new IntegrationError(
      "Eventos críticos de segurança e conformidade não podem ser desativados.",
      422,
    );
  const definition = await ctx.db.transactionalEmailDefinition.update({
    where: { eventKey },
    data: { enabled: body.enabled !== false },
  });
  await audit(ctx, "email.definition.toggle", definition.id, {
    eventKey,
    enabled: definition.enabled,
  });
  return Response.json({ definition }, { headers: NO_STORE });
}

async function testVersion(ctx: Context, body: Record<string, unknown>) {
  const eventKey = required(body.eventKey, "Evento obrigatório.");
  const recipient = required(body.recipient, "Destinatário obrigatório.")
    .trim()
    .toLowerCase();
  if (!EMAIL_PATTERN.test(recipient) || recipient.length > 320)
    throw new IntegrationError("Informe um e-mail válido.");
  const definition = await ctx.db.transactionalEmailDefinition.findUnique({
    where: { eventKey },
    include: {
      versions: {
        where: { status: "published" },
        orderBy: { version: "desc" },
        take: 1,
      },
    },
  });
  if (!definition) throw new IntegrationError("Evento inexistente.", 404);
  const requestedVersionId = optional(body.versionId, 120);
  const requestedVersion = requestedVersionId
    ? await ctx.db.transactionalEmailVersion.findFirst({
        where: { id: requestedVersionId, definitionId: definition.id },
      })
    : null;
  if (requestedVersionId && !requestedVersion)
    throw new IntegrationError("A versão não pertence ao evento selecionado.", 422);
  const catalogItem = TRANSACTIONAL_EMAIL_CATALOG.find(
    (item) => item.eventKey === eventKey,
  );
  if (!catalogItem)
    throw new IntegrationError("Evento ausente do catálogo da aplicação.", 422);
  const fallback = defaultEmailContent(catalogItem);
  const version = requestedVersion || definition.versions[0];
  const content = {
    subject: version?.subject || fallback.subject,
    textBody: version?.textBody || fallback.textBody,
    htmlBody: version?.htmlBody || fallback.htmlBody,
  };
  templateContent(content, stringArray(definition.variables));
  const credentialId = optional(body.credentialId, 120);
  const credential = await ctx.db.integrationCredential.findFirst({
    where: credentialId
      ? { id: credentialId, providerId: "smtp", ...activeCredentialFilter() }
      : { providerId: "smtp", ...activeCredentialFilter() },
    orderBy: credentialId
      ? undefined
      : [{ isDefault: "desc" }, { createdAt: "asc" }],
  });
  if (!credential)
    throw new IntegrationError(
      credentialId
        ? "A conta SMTP selecionada não está ativa ou válida."
        : "Configure e ative uma conta SMTP antes do teste.",
      422,
    );
  const settings = await ctx.db.tenantSettings.findUnique({
    where: { id: 1 },
    select: { timezone: true },
  });
  const values = {
    "organization.name": ctx.organization.name,
    "recipient.name": "Cliente de teste",
    "action.url": "https://nalven.com.br/erp",
    "event.date": dateTimeFormatter(settings?.timezone || BRAZIL_TIME_ZONE).format(new Date()),
  };
  const recipientCipher = encryptSecrets({ recipient });
  const variablesCipher = encryptSecrets({ variables: JSON.stringify(values) });
  if (!recipientCipher || !variablesCipher)
    throw new IntegrationError("Não foi possível proteger os dados do teste.", 500);
  const eventId = randomUUID();
  const delivery = await ctx.db.transactionalEmailDelivery.create({
    data: {
      eventId,
      eventKey,
      versionId: version?.id,
      credentialId: credential.id,
      recipientMasked: maskRecipient(recipient),
      recipientCipher,
      variablesCipher,
      payload: { test: true, variableKeys: Object.keys(values).sort() },
      status: "processing",
    },
  });
  const result = await sendWithProvider(
    {
      providerId: "smtp",
      credentialId: credential.id,
      config: objectValue(credential.config),
      secrets: decryptSecrets(credential.secretsCipherText),
    },
    recipient,
    renderTransactionalTemplate(content.textBody, values),
    {
      subject: renderTransactionalTemplate(content.subject, values),
      html: renderTransactionalTemplate(content.htmlBody, values, true),
    },
  );
  await ctx.db.transactionalEmailDelivery.update({
    where: { id: delivery.id },
    data: result.success
      ? {
          status: "sent",
          attempts: 1,
          sentAt: new Date(),
          remoteMessageId: result.message_id || null,
        }
      : {
          status: result.failureType === "business" ? "dead" : "failed",
          attempts: 1,
          lastError: result.message.slice(0, 1000),
          nextAttemptAt: new Date(Date.now() + 30_000),
        },
  });
  await audit(ctx, "email.test", delivery.id, {
    eventKey,
    version: version?.version || "fallback",
    recipient: maskRecipient(recipient),
    credentialId: credential.id,
    success: result.success,
  });
  if (!result.success)
    throw new IntegrationError(
      "O SMTP não aceitou o teste. Consulte o diagnóstico seguro na fila.",
      502,
    );
  return Response.json({ success: true, eventId }, { headers: NO_STORE });
}

async function retryDelivery(ctx: Context, body: Record<string, unknown>) {
  const id = required(body.deliveryId, "Entrega obrigatória.");
  const delivery = await ctx.db.transactionalEmailDelivery.findUnique({
    where: { id },
  });
  if (!delivery) throw new IntegrationError("Entrega inexistente.", 404);
  if (!["failed", "dead"].includes(delivery.status))
    throw new IntegrationError(
      "Somente entregas com falha podem ser reenfileiradas.",
      422,
    );
  if (isPermanentDeliveryError(delivery.lastError))
    throw new IntegrationError(
      "A falha é permanente e precisa ser corrigida na origem antes de um novo envio.",
      422,
    );
  await ctx.db.transactionalEmailDelivery.update({
    where: { id: delivery.id },
    data: {
      status: "pending",
      attempts: 0,
      credentialId: null,
      lastError: null,
      nextAttemptAt: new Date(),
      remoteMessageId: null,
      sentAt: null,
    },
  });
  await audit(ctx, "email.delivery.retry", delivery.id, {
    eventKey: delivery.eventKey,
  });
  return Response.json({ success: true }, { headers: NO_STORE });
}

async function retryAll(ctx: Context) {
  const candidates = await ctx.db.transactionalEmailDelivery.findMany({
    where: { status: { in: ["failed", "dead"] } },
    select: { id: true, lastError: true },
    orderBy: { createdAt: "asc" },
    take: 100,
  });
  const ids = candidates
    .filter((item) => !isPermanentDeliveryError(item.lastError))
    .map((item) => item.id);
  if (ids.length)
    await ctx.db.transactionalEmailDelivery.updateMany({
      where: { id: { in: ids }, status: { in: ["failed", "dead"] } },
      data: {
        status: "pending",
        attempts: 0,
        credentialId: null,
        lastError: null,
        nextAttemptAt: new Date(),
        remoteMessageId: null,
        sentAt: null,
      },
    });
  await audit(ctx, "email.delivery.retry_batch", randomUUID(), {
    queued: ids.length,
    skippedPermanent: candidates.length - ids.length,
  });
  return Response.json(
    { success: true, queued: ids.length, skipped: candidates.length - ids.length },
    { headers: NO_STORE },
  );
}

async function audit(
  ctx: Context,
  action: string,
  targetId: string,
  afterData: Record<string, unknown>,
) {
  await ctx.db.integrationAuditLog.create({
    data: {
      userId: ctx.actor.user.id,
      action,
      targetType: "transactional_email",
      targetId,
      afterData: afterData as Prisma.InputJsonObject,
    },
  });
}

const deliverySelect = {
  id: true,
  eventId: true,
  eventKey: true,
  recipientMasked: true,
  status: true,
  attempts: true,
  maxAttempts: true,
  remoteMessageId: true,
  lastError: true,
  nextAttemptAt: true,
  sentAt: true,
  createdAt: true,
  updatedAt: true,
  version: { select: { version: true } },
} satisfies Prisma.TransactionalEmailDeliverySelect;

type DeliveryRow = Prisma.TransactionalEmailDeliveryGetPayload<{
  select: typeof deliverySelect;
}>;

function deliveryDto(row: DeliveryRow) {
  return {
    id: row.id,
    eventId: row.eventId,
    eventKey: row.eventKey,
    recipientMasked: row.recipientMasked,
    status: row.status,
    attempts: row.attempts,
    maxAttempts: row.maxAttempts,
    version: row.version?.version || null,
    remoteMessageId: row.remoteMessageId,
    error: publicDeliveryError(row.lastError),
    retryable:
      ["failed", "dead"].includes(row.status) &&
      !isPermanentDeliveryError(row.lastError),
    nextAttemptAt: row.nextAttemptAt,
    sentAt: row.sentAt,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function smtpDto(row: {
  id: string;
  label: string;
  enabled: boolean;
  revision: number;
  ownerLabel: string | null;
  expiresAt: Date | null;
  lastRotatedAt: Date | null;
  config: Prisma.JsonValue;
  secretsCipherText: string | null;
  sandbox: boolean;
  isDefault: boolean;
  lastTestAt: Date | null;
  lastTestOk: boolean | null;
  lastTestMessage: string | null;
  createdAt: Date;
}) {
  const config = objectValue(row.config);
  return {
    id: row.id,
    label: row.label,
    enabled: row.enabled,
    revision: row.revision,
    ownerLabel: row.ownerLabel,
    expiresAt: row.expiresAt,
    lastRotatedAt: row.lastRotatedAt,
    sandbox: row.sandbox,
    isDefault: row.isDefault,
    lastTestAt: row.lastTestAt,
    lastTestOk: row.lastTestOk,
    lastTestMessage: row.lastTestMessage
      ? row.lastTestOk
        ? "Conexão SMTP validada."
        : "O teste SMTP falhou; revise servidor, TLS e autenticação."
      : null,
    passwordConfigured: Boolean(row.secretsCipherText),
    config: {
      host: String(config.host || ""),
      port: Number(config.port || 587),
      encryption: String(config.encryption || "tls"),
      username: String(config.username || ""),
      from_email: String(config.from_email || ""),
      from_name: String(config.from_name || "NALVEN"),
      timeout_sec: Number(config.timeout_sec || 15),
    },
  };
}

function dailySeries(
  days: number,
  rows: Array<{ day: Date; status: string; total: number }>,
) {
  const byDay = new Map<string, Record<string, number>>();
  for (const row of rows) {
    const key = row.day.toISOString().slice(0, 10);
    byDay.set(key, {
      ...(byDay.get(key) || {}),
      [row.status]: Number(row.total),
    });
  }
  return Array.from({ length: days }, (_, index) => {
    const date = new Date();
    date.setUTCHours(0, 0, 0, 0);
    date.setUTCDate(date.getUTCDate() - (days - index - 1));
    const key = date.toISOString().slice(0, 10);
    const statuses = byDay.get(key) || {};
    return {
      date: key,
      sent: statuses.sent || 0,
      failed: (statuses.failed || 0) + (statuses.dead || 0),
      pending: (statuses.pending || 0) + (statuses.processing || 0),
      total: Object.values(statuses).reduce((sum, value) => sum + value, 0),
    };
  });
}

function templateContent(
  body: Record<string, unknown>,
  allowedVariables: string[],
) {
  const subject = limited(body.subject, "Assunto", 240);
  const htmlBody = limited(body.htmlBody, "HTML", 200_000);
  const textBody = limited(body.textBody, "Texto", 100_000);
  const issues = analyzeTransactionalTemplate({
    subject,
    htmlBody,
    textBody,
    allowedVariables,
  });
  const error = issues.find((issue) => issue.level === "error");
  if (error) throw new IntegrationError(error.message, 422);
  return { subject, htmlBody, textBody };
}

function required(value: unknown, message: string) {
  const result = String(value || "").trim();
  if (!result) throw new IntegrationError(message);
  return result;
}
function optional(value: unknown, max: number) {
  return String(value || "").trim().slice(0, max);
}
function limited(value: unknown, label: string, max: number) {
  const result = required(value, `${label} obrigatório.`);
  if (result.length > max)
    throw new IntegrationError(`${label} excede o limite permitido.`);
  return result;
}
function stringArray(value: Prisma.JsonValue) {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}
function retryableConflict(error: unknown) {
  return (
    error instanceof Prisma.PrismaClientKnownRequestError &&
    ["P2002", "P2034"].includes(error.code)
  );
}
function failure(error: unknown) {
  if (error instanceof HttpSecurityError) return authErrorResponse(error);
  if (error instanceof IntegrationError)
    return Response.json(
      { error: error.message },
      { status: error.status, headers: NO_STORE },
    );
  if (error instanceof AuthError) return authErrorResponse(error);
  console.error("Transactional email error", {
    error: error instanceof Error ? error.name : typeof error,
  });
  return Response.json(
    { error: "Não foi possível processar o e-mail transacional." },
    { status: 500, headers: NO_STORE },
  );
}
