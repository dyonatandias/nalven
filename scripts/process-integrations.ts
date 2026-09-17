import { controlDb, tenantDb } from "../db/index";
import { createHash } from "node:crypto";
import { readFile, unlink } from "node:fs/promises";
import { Prisma } from "../generated/tenant/client";
import { mediaRoot } from "../lib/erp/media";
import {
  activeCredentialFilter,
  contactHash,
  decryptSecrets,
  ensureIntegrationSeed,
  objectValue,
  resolveProvider,
  settingsSection,
} from "../lib/integrations/core";
import {
  s3ObjectRequest,
  sendWithProvider,
  testProvider,
} from "../lib/integrations/providers";
import { deliverWebhook } from "../lib/integrations/webhooks";
import { refreshOAuthToken } from "../lib/integrations/oauth";
import { processTransactionalEmailQueue } from "../lib/integrations/transactional-email";

const BACKOFF = [30, 120, 600, 3600, 21600, 86400];

async function main() {
  const organizations = await controlDb.organization.findMany({
    where: {
      status: { in: ["active", "trial"] },
      database: { status: "active" },
    },
    select: { id: true, name: true, email: true },
  });
  const summary = {
    organizations: organizations.length,
    healthChecks: 0,
    messages: 0,
    transactionalEmails: 0,
    webhooks: 0,
    inbound: 0,
    media: 0,
    failed: 0,
  };
  for (const organization of organizations) {
    try {
      const db = await tenantDb(organization.id);
      await ensureIntegrationSeed(db);
      summary.healthChecks += await monitor(db, organization);
      const messages = await messagesQueue(db);
      summary.messages += messages.processed;
      summary.failed += messages.failed;
      const transactionalEmails = await processTransactionalEmailQueue(
        db,
        organization.name,
      );
      summary.transactionalEmails += transactionalEmails.processed;
      summary.failed += transactionalEmails.failed;
      const webhooks = await webhookQueue(db);
      summary.webhooks += webhooks.processed;
      summary.failed += webhooks.failed;
      const inbound = await inboundQueue(db);
      summary.inbound += inbound.processed;
      summary.failed += inbound.failed;
      const media = await mediaMigration(db, organization.id);
      summary.media += media.processed;
      summary.failed += media.failed;
      await db.integrationRateLimit.deleteMany({
        where: { expiresAt: { lt: new Date() } },
      });
    } catch (error) {
      summary.failed++;
      console.error(
        JSON.stringify({
          organizationId: organization.id,
          error: error instanceof Error ? error.message : "unknown",
        }),
      );
    }
  }
  await controlDb.integrationOAuthState.deleteMany({
    where: {
      OR: [
        { expiresAt: { lt: new Date() } },
        { usedAt: { lt: new Date(Date.now() - 86400000) } },
      ],
    },
  });
  console.log(JSON.stringify(summary));
}

async function monitor(
  db: Awaited<ReturnType<typeof tenantDb>>,
  organization: { id: string; name: string; email: string },
) {
  const settingsRow = await db.integrationSettings.findUniqueOrThrow({
      where: { id: 1 },
    }),
    settings = settingsSection(settingsRow.monitor, "monitor"),
    credentials = await db.integrationCredential.findMany({
      where: activeCredentialFilter(),
      orderBy: [{ providerId: "asc" }, { isDefault: "desc" }],
    }),
    enabled =
      settings.enabled === null
        ? credentials.length > 0
        : settings.enabled === true;
  if (!enabled) return 0;
  const groups = Object.groupBy(credentials, (item) => item.providerId),
    now = new Date();
  let checked = 0;
  for (const [providerId, accountsValue] of Object.entries(groups)) {
    const accounts = accountsValue || [],
      previous = await db.integrationHealthState.findUnique({
        where: { providerId },
      });
    if (
      previous &&
      now.getTime() - previous.lastCheckAt.getTime() <
        Number(settings.interval_min || 5) * 60000
    )
      continue;
    const accountHealth = await Promise.all(
        accounts.map(async (credential) => ({
          credential,
          health: await testProvider(
            providerId,
            credential.config,
            await activeSecrets(db, credential),
          ),
        })),
      ),
      success = accountHealth.every((item) => item.health.success),
      message = success
        ? `${accountHealth.length} conta(s) operacional(is).`
        : accountHealth
            .filter((item) => !item.health.success)
            .map(
              (item) =>
                `${item.credential.label || item.credential.id}: ${item.health.message}`,
            )
            .join("; "),
      failures = success ? 0 : (previous?.consecutiveFailures || 0) + 1,
      threshold = Number(settings.failure_threshold || 2),
      status = success ? "up" : failures >= threshold ? "down" : "degraded",
      changed = previous?.status !== status;
    const date = now.toISOString().slice(0, 10),
      alertsToday =
        previous?.alertsDate?.toISOString().slice(0, 10) === date
          ? previous.alertsToday
          : 0,
      canRealert =
        !previous?.lastAlertAt ||
        now.getTime() - previous.lastAlertAt.getTime() >=
          Number(settings.realert_interval_min || 60) * 60000,
      shouldAlert =
        ((status === "down" && failures >= threshold && canRealert) ||
          (previous?.status === "down" && status === "up")) &&
        alertsToday < Number(settings.max_daily_alerts || 12),
      previousEvents = Array.isArray(previous?.events) ? previous.events : [],
      events = [
        ...previousEvents,
        {
          at: now.toISOString(),
          status,
          message,
          alert: shouldAlert,
          channel: shouldAlert ? "email_outbox" : null,
        },
      ].slice(-Number(settings.events_window || 20));
    await db.$transaction([
      ...accountHealth.flatMap(({ credential, health }) => [
        db.integrationHealthLog.create({
          data: {
            providerId,
            credentialId: credential.id,
            success: health.success,
            latencyMs: health.latency_ms,
            message: health.message,
            details: health.details as Prisma.InputJsonValue,
            triggeredBy: "cron",
          },
        }),
        db.integrationCredential.update({
          where: { id: credential.id },
          data: {
            lastTestAt: now,
            lastTestOk: health.success,
            lastTestMessage: health.message,
          },
        }),
      ]),
      db.integrationHealthState.upsert({
        where: { providerId },
        update: {
          status,
          since: changed ? now : previous?.since || now,
          lastCheckAt: now,
          consecutiveFailures: failures,
          alertsToday: shouldAlert ? alertsToday + 1 : alertsToday,
          alertsDate: new Date(`${date}T00:00:00.000Z`),
          lastAlertAt: shouldAlert ? now : previous?.lastAlertAt,
          events,
        },
        create: {
          providerId,
          status,
          since: now,
          lastCheckAt: now,
          consecutiveFailures: failures,
          alertsToday: shouldAlert ? 1 : 0,
          alertsDate: new Date(`${date}T00:00:00.000Z`),
          lastAlertAt: shouldAlert ? now : null,
          events,
        },
      }),
    ]);
    if (shouldAlert) {
      const recovered = previous?.status === "down" && status === "up",
        subject = recovered
          ? `Integração recuperada: ${providerId}`
          : `Integração indisponível: ${providerId}`,
        alertMessage = `${organization.name}: ${providerId} está ${recovered ? "operacional novamente" : `indisponível após ${failures} falhas`}. ${message}`;
      await controlDb.emailOutbox.create({
        data: {
          recipient: organization.email,
          template: "integration_health_alert",
          subject,
          textBody: alertMessage,
          htmlBody: `<p>${escapeHtml(alertMessage)}</p><p>Organização: ${escapeHtml(organization.id)}</p>`,
        },
      });
    }
    checked += accounts.length;
  }
  return checked;
}

async function messagesQueue(db: Awaited<ReturnType<typeof tenantDb>>) {
  const rows = await db.integrationQueueItem.findMany({
    where: { state: "pending", nextAttemptAt: { lte: new Date() } },
    orderBy: { createdAt: "asc" },
    take: 100,
  });
  let failed = 0;
  for (const row of rows) {
    const claimed = await db.integrationQueueItem.updateMany({
      where: { id: row.id, state: "pending" },
      data: { state: "processing", claimedAt: new Date() },
    });
    if (!claimed.count) continue;
    const payload = objectValue(row.payload),
      recipient = row.recipient || String(payload.recipient || ""),
      message = String(payload.message || "");
    if (!["email", "smtp"].includes(row.channel)) {
      await db.integrationQueueItem.update({
        where: { id: row.id },
        data: {
          state: "dead",
          lastError:
            "Canal direto removido; publique o evento em um webhook externo.",
          failureType: "business",
          finishedAt: new Date(),
        },
      });
      failed++;
      continue;
    }
    if (!recipient || !message) {
      await db.integrationQueueItem.update({
        where: { id: row.id },
        data: {
          state: "dead",
          lastError: "Destinatário ou mensagem ausente",
          failureType: "business",
          finishedAt: new Date(),
        },
      });
      failed++;
      continue;
    }
    const optedOut = await db.integrationOptOut.findUnique({
      where: {
        contactHash_channel: {
          contactHash: contactHash(recipient),
          channel: "email",
        },
      },
    });
    if (optedOut && !row.eventType.startsWith("otp.")) {
      await db.integrationQueueItem.update({
        where: { id: row.id },
        data: {
          state: "cancelled",
          lastError: "Envio bloqueado por opt-out",
          failureType: "business",
          finishedAt: new Date(),
        },
      });
      continue;
    }
    const primary =
      row.providerId && row.credentialId
        ? await credentialProvider(db, row.providerId, row.credentialId)
        : await resolveProvider(db, row.context);
    let result = primary
        ? await sendWithProvider(
            primary,
            recipient,
            message,
            objectValue(payload.extras),
          )
        : {
            success: false as const,
            message: "Provider não configurado",
            failureType: "transport" as const,
          },
      used = primary;
    if (!result.success && result.failureType === "transport") {
      const fallback = await resolveProvider(
        db,
        row.context,
        true,
        primary?.providerId,
      );
      if (fallback) {
        result = await sendWithProvider(
          fallback,
          recipient,
          message,
          objectValue(payload.extras),
        );
        used = fallback;
      }
    }
    if (result.success)
      await db.integrationQueueItem.update({
        where: { id: row.id },
        data: {
          state: "success",
          providerId: used?.providerId,
          credentialId: used?.credentialId,
          remoteMessageId: result.message_id,
          attempts: row.attempts + 1,
          claimedAt: null,
          finishedAt: new Date(),
          lastError: null,
        },
      });
    else {
      const attempts = row.attempts + 1,
        dead = result.failureType === "business" || attempts >= row.maxAttempts;
      await db.integrationQueueItem.update({
        where: { id: row.id },
        data: {
          state: dead ? "dead" : "pending",
          attempts,
          claimedAt: null,
          failureType: result.failureType,
          lastError: result.message.slice(0, 1000),
          nextAttemptAt: new Date(
            Date.now() +
              BACKOFF[Math.min(attempts - 1, BACKOFF.length - 1)] * 1000,
          ),
          finishedAt: dead ? new Date() : null,
        },
      });
      failed++;
    }
  }
  return { processed: rows.length, failed };
}

async function webhookQueue(db: Awaited<ReturnType<typeof tenantDb>>) {
  const rows = await db.integrationWebhookDelivery.findMany({
    where: {
      state: { in: ["pending", "failed"] },
      nextAttemptAt: { lte: new Date() },
    },
    orderBy: { createdAt: "asc" },
    take: 100,
  });
  let failed = 0;
  for (const row of rows) {
    const result = await deliverWebhook(db, row.id);
    if (result.state !== "delivered") failed++;
  }
  return { processed: rows.length, failed };
}
async function inboundQueue(db: Awaited<ReturnType<typeof tenantDb>>) {
  const rows = await db.integrationInboundEvent.findMany({
    where: { status: "pending" },
    orderBy: { receivedAt: "asc" },
    take: 100,
  });
  let processed = 0,
    failed = 0;
  for (const row of rows) {
    const claimed = await db.integrationInboundEvent.updateMany({
      where: { id: row.id, status: "pending" },
      data: { status: "processing" },
    });
    if (!claimed.count) continue;
    try {
      const payload = objectValue(row.payload),
        transactionId = String(
          payload.transaction_id || payload.payment_id || payload.id || "",
        ),
        rawStatus = String(payload.status || "").toLowerCase(),
        allowed = new Set([
          "pending",
          "authorized",
          "paid",
          "failed",
          "refunded",
          "cancelled",
        ]);
      let matchedPayment: number | null = null;
      if (
        row.providerId === "payment_gateway" &&
        transactionId &&
        allowed.has(rawStatus)
      ) {
        const payment = await db.orderPayment.findFirst({
          where: { transactionId },
        });
        if (payment) {
          await db.orderPayment.update({
            where: { id: payment.id },
            data: {
              status: rawStatus,
              paidAt: rawStatus === "paid" ? new Date() : payment.paidAt,
            },
          });
          matchedPayment = payment.id;
        }
      }
      await db.$transaction([
        db.integrationInboundEvent.update({
          where: { id: row.id },
          data: { status: "processed", processedAt: new Date(), error: null },
        }),
        db.integrationAuditLog.create({
          data: {
            userId: "system",
            action: "process",
            targetType: "inbound_webhook",
            targetId: row.id,
            afterData: {
              provider: row.providerId,
              topic: row.topic,
              matched_payment_id: matchedPayment,
            },
          },
        }),
      ]);
      processed++;
    } catch (error) {
      await db.integrationInboundEvent.update({
        where: { id: row.id },
        data: {
          status: "failed",
          processedAt: new Date(),
          error:
            error instanceof Error
              ? error.message.slice(0, 1000)
              : "Falha no processamento",
        },
      });
      failed++;
    }
  }
  return { processed, failed };
}
async function mediaMigration(
  db: Awaited<ReturnType<typeof tenantDb>>,
  organizationId: string,
) {
  const settingsRow = await db.integrationSettings.findUnique({
      where: { id: 1 },
    }),
    settings = settingsSection(settingsRow?.storage, "storage"),
    credential = await db.integrationCredential.findFirst({
      where: { providerId: "storage_s3", lastTestOk: true, ...activeCredentialFilter() },
      orderBy: [{ isDefault: "desc" }, { createdAt: "asc" }],
    });
  if (!credential) return { processed: 0, failed: 0 };
  const config = objectValue(credential.config),
    secrets = decryptSecrets(credential.secretsCipherText),
    endpoint = String(config.endpoint || "").replace(/\/$/, ""),
    bucket = encodeURIComponent(String(config.bucket || "")),
    prefix = String(settings.path_prefix || "media/").replace(/^\/+|\/+$/g, ""),
    migration = await db.integrationMediaMigration.findFirst({
      where: { status: "running" },
      orderBy: { createdAt: "asc" },
    });
  let processed = 0,
    failed = 0;
  if (migration) {
    const assets = await db.tenantMediaAsset.findMany({
      where: { deletedAt: null, offloadedAt: null },
      orderBy: { id: "asc" },
      take: 20,
    });
    for (const asset of assets) {
      try {
        const body = await readFile(
          `${mediaRoot(organizationId)}/${asset.storageKey}`,
        );
        if (createHash("sha256").update(body).digest("hex") !== asset.checksum)
          throw new Error("Checksum local divergente");
        const remoteKey = `${prefix}/${asset.storageKey}`,
          url = `${endpoint}/${bucket}/${remoteKey.split("/").map(encodeURIComponent).join("/")}`,
          put = await s3ObjectRequest("PUT", url, body, config, secrets);
        if (put.status < 200 || put.status >= 300)
          throw new Error(`Upload respondeu HTTP ${put.status}`);
        const head = await s3ObjectRequest("HEAD", url, "", config, secrets);
        if (head.status < 200 || head.status >= 300)
          throw new Error("Objeto remoto não confirmado");
        const publicBase = String(
            config.public_url_base || `${endpoint}/${bucket}`,
          ).replace(/\/$/, ""),
          localDeleteAfter =
            settings.delete_local_after_upload === true
              ? new Date(
                  Date.now() +
                    Number(settings.keep_local_copy_days || 30) * 86400000,
                )
              : null;
        await db.tenantMediaAsset.update({
          where: { id: asset.id },
          data: {
            remoteKey,
            remoteUrl: `${publicBase}/${remoteKey.split("/").map(encodeURIComponent).join("/")}`,
            offloadedAt: new Date(),
            localDeleteAfter,
          },
        });
        processed++;
      } catch (error) {
        failed++;
        await db.integrationMediaMigration.update({
          where: { id: migration.id },
          data: {
            failed: { increment: 1 },
            details: {
              last_error:
                error instanceof Error ? error.message : "Falha no offload",
              last_asset: asset.id,
            },
          },
        });
      }
      await db.integrationMediaMigration.update({
        where: { id: migration.id },
        data: { processed: { increment: 1 }, cursor: asset.id },
      });
    }
    if (
      !(await db.tenantMediaAsset.count({
        where: { deletedAt: null, offloadedAt: null },
      }))
    )
      await db.integrationMediaMigration.update({
        where: { id: migration.id },
        data: { status: "completed", finishedAt: new Date() },
      });
  }
  if (settings.delete_local_after_upload === true) {
    const due = await db.tenantMediaAsset.findMany({
      where: {
        localAvailable: true,
        remoteKey: { not: null },
        localDeleteAfter: { lte: new Date() },
      },
      take: 20,
    });
    for (const asset of due) {
      try {
        const url = `${endpoint}/${bucket}/${asset.remoteKey!.split("/").map(encodeURIComponent).join("/")}`,
          head = await s3ObjectRequest("HEAD", url, "", config, secrets);
        if (head.status < 200 || head.status >= 300) continue;
        await unlink(`${mediaRoot(organizationId)}/${asset.storageKey}`).catch(
          (error: NodeJS.ErrnoException) => {
            if (error.code !== "ENOENT") throw error;
          },
        );
        await db.tenantMediaAsset.update({
          where: { id: asset.id },
          data: { localAvailable: false },
        });
      } catch {
        failed++;
      }
    }
  }
  return { processed, failed };
}
async function credentialProvider(
  db: Awaited<ReturnType<typeof tenantDb>>,
  providerId: string,
  credentialId: string,
) {
  const item = await db.integrationCredential.findFirst({
    where: { id: credentialId, providerId, ...activeCredentialFilter() },
  });
  return item
    ? {
        providerId,
        credentialId,
        config: objectValue(item.config),
        secrets: decryptSecrets(item.secretsCipherText),
      }
    : null;
}
async function activeSecrets(
  db: Awaited<ReturnType<typeof tenantDb>>,
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
function escapeHtml(value: string) {
  return value.replace(
    /[&<>"']/g,
    (character) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        character
      ]!,
  );
}

main().finally(async () => controlDb.$disconnect());
