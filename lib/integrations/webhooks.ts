import { createHash, createHmac, randomBytes, randomUUID } from "node:crypto";
import type { Prisma, PrismaClient } from "@/generated/tenant/client";
import { decryptSecret, encryptSecret } from "@/lib/secrets";
import { WEBHOOK_TOPICS } from "./catalog";
import { IntegrationError, redact } from "./core";
import { safeRequest, validatePublicHttpsUrl } from "./security";
import { writePosT2WebhookBoundary } from "@/lib/erp/pos-t2-boundary";

export function webhookSecret() { return randomBytes(32).toString("base64url"); }
export function storeWebhookSecret(secret: string) { return { secretCipher: encryptSecret(secret), secretPreview: `***${secret.slice(-4)}` }; }
export function serializeEndpoint<T extends { secretCipher: string }>(endpoint: T) { const { secretCipher: _secret, ...safe } = endpoint; void _secret; return safe; }
export function serializeDelivery<T extends { payload: unknown; responseBody?: string | null }>(delivery: T) {
  return { ...delivery, payload: redact(delivery.payload), responseBody: delivery.responseBody ? String(redact(delivery.responseBody)) : delivery.responseBody };
}

export async function validateEndpointInput(input: Record<string, unknown>, editing = false) {
  const name = String(input.name || "").trim().slice(0, 160), deliveryUrl = String(input.delivery_url || input.deliveryUrl || "").trim(), topic = String(input.topic || "").trim();
  if (!name) throw new IntegrationError("Nome do webhook obrigatório.");
  if (!deliveryUrl) throw new IntegrationError("URL de entrega obrigatória.");
  await validatePublicHttpsUrl(deliveryUrl);
  if (!editing && !WEBHOOK_TOPICS.has(topic)) throw new IntegrationError("Tópico de webhook inválido.");
  if (editing && topic) throw new IntegrationError("O tópico é imutável. Crie outro endpoint para mudar de tópico.", 422);
  const status = String(input.status || "active"); if (!["active", "paused", "disabled"].includes(status)) throw new IntegrationError("Status inválido.");
  return { name, deliveryUrl, status, apiVersion: String(input.api_version || input.apiVersion || "v1").slice(0, 20), ...(!editing ? { topic } : {}) };
}

export async function enqueueWebhook(db: PrismaClient | Prisma.TransactionClient, topic: string, payload: Record<string, unknown>) {
  if (!WEBHOOK_TOPICS.has(topic)) throw new IntegrationError("Tópico de webhook inválido.");
  const endpoints = await db.integrationWebhookEndpoint.findMany({ where: { topic, status: "active", supersededAt: null } });
  const eventId = randomUUID();
  if (endpoints.length) await db.integrationWebhookDelivery.createMany({ data: endpoints.map((endpoint) => ({ endpointId: endpoint.id, eventId, topic, payload: redact(payload) as object })) });
  return { eventId, deliveries: endpoints.length };
}

export async function deliverWebhook(db: PrismaClient, id: string) {
  const delivery = await db.integrationWebhookDelivery.findUnique({ where: { id }, include: { endpoint: true } });
  if (!delivery) throw new IntegrationError("Entrega não encontrada.", 404);
  if (delivery.endpoint.status !== "active" || delivery.endpoint.failureCount >= 10) throw new IntegrationError("Endpoint pausado ou desativado.", 422);
  const timestamp = Math.floor(Date.now() / 1000).toString(), body = JSON.stringify(delivery.payload), secret = decryptSecret(delivery.endpoint.secretCipher), signature = createHmac("sha256", secret).update(`${timestamp}.${body}`).digest("hex"), started = Date.now();
  try {
    const response = await safeRequest(delivery.endpoint.deliveryUrl, { method: "POST", timeoutMs: 10000, body, headers: { "content-type": "application/json", "user-agent": "NALVEN-Webhooks/1.0", "x-webhook-signature": `sha256=${signature}`, "x-webhook-timestamp": timestamp, "x-webhook-event-id": delivery.eventId, "x-webhook-topic": delivery.topic } });
    const success = response.status >= 200 && response.status < 300, attempts = delivery.attempts + 1, dead = !success && attempts >= 6, next = success || dead ? null : new Date(Date.now() + backoff(attempts));
    const updated = await db.integrationWebhookDelivery.update({ where: { id }, data: { attempts, state: success ? "delivered" : dead ? "dead" : "failed", responseCode: response.status, responseBody: safeResponse(response.body), durationMs: Date.now() - started, nextAttemptAt: next, deliveredAt: success ? new Date() : null } });
    if (success) await db.integrationWebhookEndpoint.update({ where: { id: delivery.endpointId }, data: { failureCount: 0 } });
    else {
      const endpoint = await db.integrationWebhookEndpoint.update({ where: { id: delivery.endpointId }, data: { failureCount: { increment: 1 } } });
      if (endpoint.failureCount >= 10) await pauseWebhookAfterFailures(db, endpoint).catch(error => console.error("Webhook auto-pause boundary failed closed", { error: error instanceof Error ? error.name : typeof error }));
    }
    return updated;
  } catch (error) {
    const attempts = delivery.attempts + 1, dead = attempts >= 6;
    const updated = await db.integrationWebhookDelivery.update({ where: { id }, data: { attempts, state: dead ? "dead" : "failed", responseBody: transportFailure(error), durationMs: Date.now() - started, nextAttemptAt: dead ? null : new Date(Date.now() + backoff(attempts)) } });
    const endpoint = await db.integrationWebhookEndpoint.update({ where: { id: delivery.endpointId }, data: { failureCount: { increment: 1 } } });
    if (endpoint.failureCount >= 10) await pauseWebhookAfterFailures(db, endpoint).catch(error => console.error("Webhook auto-pause boundary failed closed", { error: error instanceof Error ? error.name : typeof error }));
    return updated;
  }
}

function backoff(attempt: number) { return [30000, 120000, 600000, 3600000, 21600000, 86400000][Math.min(attempt - 1, 5)]; }
function safeResponse(value: string) { try { return JSON.stringify(redact(JSON.parse(value))).slice(0, 10000); } catch { return String(redact(value)).slice(0, 10000); } }
function transportFailure(error: unknown) { return error instanceof IntegrationError ? error.message.slice(0, 500) : error instanceof Error && error.message === "timeout" ? "Tempo limite excedido." : "Falha de transporte segura."; }

async function pauseWebhookAfterFailures(db: PrismaClient, endpoint: Prisma.IntegrationWebhookEndpointGetPayload<object>) {
  if (endpoint.supersededAt) return;
  const idempotencyKey = createHash("sha256").update(`webhook-auto-pause\0${endpoint.logicalId}\0${endpoint.version}\0threshold=10`, "utf8").digest("hex");
  await db.$transaction(async tx => {
    const current = await tx.integrationWebhookEndpoint.findFirst({ where: { logicalId: endpoint.logicalId, supersededAt: null } });
    if (!current || current.version !== endpoint.version || current.configHash !== endpoint.configHash || current.status !== "active" || current.failureCount < 10) return;
    const configurator = await tx.integrationAuditLog.findFirst({ where: { targetType: "webhook", targetId: current.id }, select: { userId: true }, orderBy: [{ createdAt: "desc" }, { id: "desc" }] });
    if (!configurator) throw new IntegrationError("Endpoint sem ator configurador para auto-pause.", 409);
    await writePosT2WebhookBoundary(tx, {
      action: "update", logicalId: current.logicalId, expectedVersion: current.version, expectedConfigHash: current.configHash,
      projection: { apiVersion: current.apiVersion, deliveryUrl: current.deliveryUrl, name: current.name, secretCipher: current.secretCipher, secretPreview: current.secretPreview, status: "paused", topic: current.topic },
      actorUserId: configurator.userId, idempotencyKey,
    });
  }, { isolationLevel: "Serializable", maxWait: 10_000, timeout: 30_000 });
}
