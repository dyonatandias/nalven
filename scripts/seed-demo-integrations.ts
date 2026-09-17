import { PrismaPg } from "@prisma/adapter-pg";
import { createHash } from "node:crypto";
import { PrismaClient } from "../generated/tenant/client";
import { writePosT2WebhookBoundary } from "../lib/erp/pos-t2-boundary";
import {
  encryptSecrets,
  ensureIntegrationSeed,
  maskRecipient,
} from "../lib/integrations/core";
import {
  defaultEmailContent,
  TRANSACTIONAL_EMAIL_CATALOG,
} from "../lib/integrations/transactional-email-catalog";
import { AI_FEATURE_CATALOG } from "../lib/erp/ai-control-center";
import { storeWebhookSecret } from "../lib/integrations/webhooks";

const connectionString = process.env.TENANT_DATABASE_URL;
if (!connectionString) throw new Error("TENANT_DATABASE_URL não foi definida");
const db = new PrismaClient({ adapter: new PrismaPg({ connectionString }) });
const HOUR = 60 * 60 * 1000;

async function main() {
  await ensureIntegrationSeed(db);
  const profile = await db.tenantUserProfile.findFirst({
    where: { status: "active", role: { key: { in: ["owner", "admin"] } } },
    select: { userId: true },
    orderBy: { id: "asc" },
  });
  if (!profile)
    throw new Error("O seed de integrações exige um perfil owner/admin ativo.");
  const now = new Date(), actor = profile.userId;
  const credentials = [
    {
      id: "demo-int-smtp",
      providerId: "smtp",
      label: "E-mail transacional · demonstração",
      ownerLabel: "Equipe de relacionamento",
      config: { host: "smtp.demo.invalid", port: 587, encryption: "tls", username: "demo", from_email: "noreply@example.invalid", from_name: "NALVEN Demo" },
      sandbox: true,
      lastTestAt: new Date(now.getTime() - 2 * HOUR),
      lastTestOk: true,
      lastTestMessage: "Diagnóstico simulado concluído no ambiente demonstrativo.",
      lastRotatedAt: new Date(now.getTime() - 18 * 24 * HOUR),
      expiresAt: new Date(now.getTime() + 75 * 24 * HOUR),
    },
    {
      id: "demo-int-shipping",
      providerId: "shipping",
      label: "Frete nacional · demonstração",
      ownerLabel: "Operações e logística",
      config: { base_url: "https://api.example.invalid", origin_postcode: "01310100", fallback_flat_rate: 24.9 },
      sandbox: true,
      lastTestAt: new Date(now.getTime() - 5 * HOUR),
      lastTestOk: false,
      lastTestMessage: "Endpoint demonstrativo indisponível; contingência por tarifa plana.",
      lastRotatedAt: new Date(now.getTime() - 42 * 24 * HOUR),
      expiresAt: new Date(now.getTime() + 12 * 24 * HOUR),
    },
    {
      id: "demo-int-marketplace",
      providerId: "marketplace",
      label: "Marketplace · homologação",
      ownerLabel: "Comércio digital",
      config: { platform: "demo", authorization_url: "https://auth.example.invalid/oauth", token_url: "https://auth.example.invalid/token", client_id: "demo-client", connection_status: "disconnected" },
      sandbox: true,
      lastTestAt: null,
      lastTestOk: null,
      lastTestMessage: "Aguardando autorização OAuth do cliente.",
      lastRotatedAt: null,
      expiresAt: null,
    },
    {
      id: "demo-int-openai",
      providerId: "openai",
      label: "OpenAI · demonstração",
      ownerLabel: "Governança de dados",
      config: {
        project_id: "proj_demo_nao_operacional",
        organization_id: "org_demo_nao_operacional",
      },
      sandbox: true,
      lastTestAt: new Date(now.getTime() - 26 * HOUR),
      lastTestOk: false,
      lastTestMessage:
        "Credencial demonstrativa sem segredo e indisponível para execução.",
      lastRotatedAt: new Date(now.getTime() - 46 * 24 * HOUR),
      expiresAt: new Date(now.getTime() + 44 * 24 * HOUR),
    },
  ];
  for (const item of credentials) {
    await db.integrationCredential.upsert({
      where: { id: item.id },
      update: { ...item, enabled: false, isDefault: false, revokedAt: null, updatedBy: actor },
      create: { ...item, enabled: false, isDefault: false, secretsCipherText: null, createdBy: actor, updatedBy: actor },
    });
  }

  const aiModels = ["gpt-5-mini", "gpt-5", "gpt-4.1-mini"];
  for (let index = 0; index < 72; index++) {
    const feature = AI_FEATURE_CATALOG[index % AI_FEATURE_CATALOG.length];
    const status = index % 19 === 18
      ? "failed"
      : index % 23 === 22
        ? "incomplete"
        : "completed";
    const createdAt = new Date(now.getTime() - (index + 1) * 13 * HOUR);
    const inputTokens = 420 + ((index * 173) % 4_900);
    const outputTokens = status === "failed" ? 0 : 110 + ((index * 97) % 1_200);
    await db.integrationAiUsage.upsert({
      where: { id: `demo-ai-usage-${String(index + 1).padStart(3, "0")}` },
      update: {
        requestId: `resp_demo_${String(index + 1).padStart(3, "0")}`,
        feature: feature.id,
        model: aiModels[index % aiModels.length],
        units: 1,
        inputTokens,
        outputTokens,
        latencyMs: 480 + ((index * 211) % 4_600),
        keySource: index % 4 === 0 ? "byok" : "platform",
        status,
        cost: Number((0.006 + (inputTokens + outputTokens) / 1_000_000 * 8.4).toFixed(4)),
        createdAt,
      },
      create: {
        id: `demo-ai-usage-${String(index + 1).padStart(3, "0")}`,
        requestId: `resp_demo_${String(index + 1).padStart(3, "0")}`,
        feature: feature.id,
        model: aiModels[index % aiModels.length],
        units: 1,
        inputTokens,
        outputTokens,
        latencyMs: 480 + ((index * 211) % 4_600),
        keySource: index % 4 === 0 ? "byok" : "platform",
        status,
        cost: Number((0.006 + (inputTokens + outputTokens) / 1_000_000 * 8.4).toFixed(4)),
        createdAt,
      },
    });
  }

  const demoEmailEvents = [
    "auth.password_changed",
    "customer.welcome",
    "quote.created",
    "order.confirmed",
    "payment.approved",
    "receivable.due_soon",
    "fiscal.nfe_authorized",
    "shipment.dispatched",
    "shipment.delivered",
    "report.ready",
  ];
  for (let index = 0; index < 48; index++) {
    const eventKey = demoEmailEvents[index % demoEmailEvents.length];
    const catalogItem = TRANSACTIONAL_EMAIL_CATALOG.find(
      (item) => item.eventKey === eventKey,
    )!;
    const definition = await db.transactionalEmailDefinition.upsert({
      where: { eventKey },
      update: {},
      create: {
        eventKey,
        label: catalogItem.label,
        category: catalogItem.category,
        description: catalogItem.description,
        variables: catalogItem.variables,
        critical: catalogItem.critical === true,
      },
    });
    let version = await db.transactionalEmailVersion.findFirst({
      where: { definitionId: definition.id, status: "published" },
      orderBy: { version: "desc" },
    });
    if (!version) {
      const content = defaultEmailContent(catalogItem);
      version = await db.transactionalEmailVersion.create({
        data: {
          definitionId: definition.id,
          version: 1,
          status: "published",
          ...content,
          createdBy: actor,
          publishedAt: now,
        },
      });
    }
    const recipient = `cliente${(index % 12) + 1}@example.invalid`;
    const variables = {
      "organization.name": "NALVEN Demonstração",
      "recipient.name": `Cliente ${(index % 12) + 1}`,
      "action.url": "https://nalven.com.br/erp",
      "event.date": now.toISOString(),
    };
    const recipientCipher = encryptSecrets({ recipient });
    const variablesCipher = encryptSecrets({ variables: JSON.stringify(variables) });
    if (!recipientCipher || !variablesCipher)
      throw new Error("Não foi possível cifrar o histórico demonstrativo.");
    const state = index % 16 === 14 ? "failed" : index % 16 === 15 ? "dead" : index % 11 === 10 ? "pending" : "sent";
    const createdAt = new Date(now.getTime() - (index + 1) * 17 * HOUR);
    const attempts = state === "sent" ? 1 + (index % 7 === 0 ? 1 : 0) : state === "pending" ? 0 : state === "failed" ? 3 : 8;
    await db.transactionalEmailDelivery.upsert({
      where: { eventId: `demo-email-event-${String(index + 1).padStart(3, "0")}` },
      update: {
        eventKey,
        versionId: version.id,
        recipientMasked: maskRecipient(recipient),
        recipientCipher,
        variablesCipher,
        payload: { demo: true, variableKeys: Object.keys(variables).sort() },
        status: state,
        attempts,
        lastError: ["failed", "dead"].includes(state)
          ? "Timeout demonstrativo no transporte SMTP."
          : null,
        nextAttemptAt: state === "failed" ? new Date(now.getTime() + HOUR) : createdAt,
        sentAt: state === "sent" ? new Date(createdAt.getTime() + 850 + index * 13) : null,
        createdAt,
      },
      create: {
        id: `demo-email-delivery-${String(index + 1).padStart(3, "0")}`,
        eventId: `demo-email-event-${String(index + 1).padStart(3, "0")}`,
        eventKey,
        versionId: version.id,
        credentialId: "demo-int-smtp",
        recipientMasked: maskRecipient(recipient),
        recipientCipher,
        variablesCipher,
        payload: { demo: true, variableKeys: Object.keys(variables).sort() },
        status: state,
        attempts,
        lastError: ["failed", "dead"].includes(state)
          ? "Timeout demonstrativo no transporte SMTP."
          : null,
        nextAttemptAt: state === "failed" ? new Date(now.getTime() + HOUR) : createdAt,
        sentAt: state === "sent" ? new Date(createdAt.getTime() + 850 + index * 13) : null,
        createdAt,
      },
    });
  }

  const healthStates = [
    { providerId: "smtp", status: "up", failures: 0, message: "Operação estável" },
    { providerId: "shipping", status: "degraded", failures: 1, message: "Contingência de frete acionada" },
    { providerId: "marketplace", status: "unknown", failures: 0, message: "Autorização pendente" },
  ];
  for (const [index, item] of healthStates.entries()) {
    const checkedAt = new Date(now.getTime() - (index + 1) * HOUR);
    await db.integrationHealthState.upsert({
      where: { providerId: item.providerId },
      update: { status: item.status, lastCheckAt: checkedAt, consecutiveFailures: item.failures, events: [{ at: checkedAt.toISOString(), status: item.status, message: item.message, alert: item.status === "degraded" }] },
      create: { providerId: item.providerId, status: item.status, since: checkedAt, lastCheckAt: checkedAt, consecutiveFailures: item.failures, events: [{ at: checkedAt.toISOString(), status: item.status, message: item.message, alert: item.status === "degraded" }] },
    });
    await db.integrationHealthLog.upsert({
      where: { id: `demo-int-health-${index + 1}` },
      update: {},
      create: { id: `demo-int-health-${index + 1}`, providerId: item.providerId, credentialId: credentials[index].id, success: item.status === "up", latencyMs: [182, 1480, 0][index], message: item.message, details: { demo: true, environment: "sandbox" }, triggeredBy: "demo", createdAt: checkedAt },
    });
  }

  const queueStates = ["success", "success", "success", "pending", "processing", "failed", "dead", "cancelled"];
  for (let index = 0; index < 32; index++) {
    const state = queueStates[index % queueStates.length], createdAt = new Date(now.getTime() - (index + 1) * 37 * 60000);
    await db.integrationQueueItem.upsert({
      where: { id: `demo-int-queue-${String(index + 1).padStart(2, "0")}` },
      update: {},
      create: {
        id: `demo-int-queue-${String(index + 1).padStart(2, "0")}`,
        eventType: ["order.confirmed", "shipment.updated", "customer.welcome", "payment.receipt"][index % 4],
        trigger: "demo_seed",
        context: ["notification", "automation", "checkout"][index % 3],
        providerId: index % 3 === 0 ? "shipping" : "smtp",
        credentialId: index % 3 === 0 ? "demo-int-shipping" : "demo-int-smtp",
        channel: index % 3 === 0 ? "shipping" : "smtp",
        recipientMasked: index % 3 === 0 ? "01***100" : "cl***com",
        payload: { demo: true, correlation_id: `DEMO-${1000 + index}`, document: `PED-${202600 + index}` },
        attempts: [1, 1, 1, 0, 1, 3, 6, 1][index % queueStates.length],
        state,
        failureType: ["failed", "dead"].includes(state) ? "transport" : null,
        lastError: ["failed", "dead"].includes(state) ? "Timeout demonstrativo ao contatar o endpoint." : null,
        nextAttemptAt: new Date(createdAt.getTime() + HOUR),
        finishedAt: ["success", "dead", "cancelled"].includes(state) ? new Date(createdAt.getTime() + (index % 5 + 1) * 400) : null,
        createdAt,
      },
    });
  }

  for (let index = 0; index < 8; index++) {
    const status = ["processed", "processed", "failed", "pending"][index % 4], receivedAt = new Date(now.getTime() - (index + 1) * 53 * 60000);
    await db.integrationInboundEvent.upsert({
      where: { providerId_eventId: { providerId: index % 2 ? "marketplace" : "shipping", eventId: `demo-inbound-${index + 1}` } },
      update: {},
      create: { id: `demo-int-inbound-${index + 1}`, eventId: `demo-inbound-${index + 1}`, providerId: index % 2 ? "marketplace" : "shipping", topic: index % 2 ? "order.updated" : "shipment.updated", payload: { demo: true, external_id: `EXT-${3000 + index}`, customer_email: "[REDIGIDO]" }, status, receivedAt, processedAt: status === "processed" ? new Date(receivedAt.getTime() + 900) : null, error: status === "failed" ? "Assinatura demonstrativa inválida." : null },
    });
  }

  const stored = storeWebhookSecret("demo-webhook-secret-not-for-production"),
    existingWebhook = await db.integrationWebhookEndpoint.findFirst({
      where: { name: "ERP parceiro · demonstração", supersededAt: null },
    }),
    webhook = existingWebhook || await db.$transaction(async (tx) => {
      const boundary = await writePosT2WebhookBoundary(tx, {
        action: "create",
        logicalId: null,
        expectedVersion: null,
        expectedConfigHash: null,
        projection: { apiVersion: "v1", deliveryUrl: "https://webhook.example.invalid/nalven", name: "ERP parceiro · demonstração", status: "paused", topic: "order.updated", ...stored },
        actorUserId: actor,
        idempotencyKey: createHash("sha256").update("demo-integration-webhook-v1").digest("hex"),
      });
      return tx.integrationWebhookEndpoint.findUniqueOrThrow({ where: { id: boundary.endpointId } });
    }, { isolationLevel: "Serializable", maxWait: 10_000, timeout: 30_000 });
  for (let index = 0; index < 6; index++) {
    const state = ["delivered", "delivered", "failed", "dead"][index % 4], createdAt = new Date(now.getTime() - (index + 1) * HOUR);
    await db.integrationWebhookDelivery.upsert({
      where: { endpointId_eventId: { endpointId: webhook.id, eventId: `demo-webhook-event-${index + 1}` } },
      update: {},
      create: { id: `demo-int-delivery-${index + 1}`, endpointId: webhook.id, eventId: `demo-webhook-event-${index + 1}`, topic: "order.updated", payload: { demo: true, order_id: 9000 + index }, attempts: state === "dead" ? 6 : state === "failed" ? 2 : 1, state, responseCode: state === "delivered" ? 202 : 503, responseBody: state === "delivered" ? "{\"accepted\":true}" : "Serviço demonstrativo indisponível", durationMs: 180 + index * 95, nextAttemptAt: state === "failed" ? new Date(now.getTime() + HOUR) : null, createdAt, deliveredAt: state === "delivered" ? new Date(createdAt.getTime() + 500) : null },
    });
  }

  const optOuts = [
    ["demo-int-optout-1", "ma***com", "smtp", "central_de_preferencias"],
    ["demo-int-optout-2", "55***321", "whatsapp", "atendimento"],
  ];
  for (const [id, contactMasked, channel, source] of optOuts)
    await db.integrationOptOut.upsert({ where: { contactHash_channel: { contactHash: id, channel } }, update: { source }, create: { id, contactHash: id, contactMasked, channel, source } });

  const auditRows = [
    ["demo-int-audit-1", "test", "provider", "shipping"],
    ["demo-int-audit-2", "batch_retry", "queue_item", "demo-batch"],
    ["demo-int-audit-3", "rotate_secret", "webhook", webhook.id],
    ["demo-int-audit-4", "update", "routing", "notification"],
  ];
  for (const [id, action, targetType, targetId] of auditRows)
    await db.integrationAuditLog.upsert({ where: { id }, update: {}, create: { id, userId: actor, action, targetType, targetId, correlationId: `corr-${id}`, beforeData: { demo: true }, afterData: { demo: true, status: "completed" }, source: "demo_seed", createdAt: new Date(now.getTime() - (Number(id.slice(-1)) || 1) * HOUR) } });

  console.log(JSON.stringify({
    credentials: await db.integrationCredential.count({ where: { id: { startsWith: "demo-int-" } } }),
    queue: await db.integrationQueueItem.count({ where: { id: { startsWith: "demo-int-" } } }),
    inbound: await db.integrationInboundEvent.count({ where: { id: { startsWith: "demo-int-" } } }),
    webhooks: await db.integrationWebhookEndpoint.count({ where: { name: "ERP parceiro · demonstração", supersededAt: null } }),
    transactionalEmails: await db.transactionalEmailDelivery.count({
      where: { id: { startsWith: "demo-email-delivery-" } },
    }),
    aiUsage: await db.integrationAiUsage.count({
      where: { id: { startsWith: "demo-ai-usage-" } },
    }),
  }));
}

main().finally(() => db.$disconnect());
