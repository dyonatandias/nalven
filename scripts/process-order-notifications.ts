import { controlDb, tenantDb } from "../db/index";
import type { Prisma } from "../generated/tenant/client";
import {
  activeCredentialFilter,
  contactHash,
  decryptSecrets,
  isConfigured,
} from "../lib/integrations/core";
import { sendWithProvider } from "../lib/integrations/providers";

const BACKOFF = [30, 120, 600, 3600, 21600, 86400];

async function main() {
  const organizations = await controlDb.organization.findMany({
    where: {
      status: { in: ["active", "trial"] },
      database: { status: "active" },
    },
    select: { id: true, name: true, slug: true },
  });
  let processed = 0,
    sent = 0,
    skipped = 0,
    failed = 0;
  for (const organization of organizations) {
    const result = await processOrganization(
      organization.id,
      organization.name,
      organization.slug,
    );
    processed += result.processed;
    sent += result.sent;
    skipped += result.skipped;
    failed += result.failed;
  }
  console.log(JSON.stringify({ processed, sent, skipped, failed }));
}

async function processOrganization(
  organizationId: string,
  storeName: string,
  storeSlug: string,
) {
  const db = await tenantDb(organizationId),
    now = new Date(),
    settingsRow = await db.orderNotificationSettings.findUnique({
      where: { id: 1 },
    });
  const settings = object(settingsRow?.settings);
  await maintainLogs(db, settings);
  if (settingsRow?.enabled)
    await sendDailySummary(
      db,
      organizationId,
      storeName,
      settingsRow,
      settings,
    );
  const rows = await db.orderNotificationQueue.findMany({
    where: { state: "pending", nextAttemptAt: { lte: now } },
    orderBy: { createdAt: "asc" },
    take: 50,
  });
  let sent = 0,
    skipped = 0,
    failed = 0;
  for (const row of rows) {
    const claimed = await db.orderNotificationQueue.updateMany({
      where: { id: row.id, state: "pending" },
      data: { state: "processing", claimedAt: now },
    });
    if (!claimed.count) continue;
    if (row.channel !== "email") {
      await skip(
        db,
        row.id,
        row.salesOrderId,
        row.statusTrigger,
        row.channel,
        row.recipientType,
        "Canal direto removido; publique o evento por webhook externo",
      );
      skipped++;
      continue;
    }
    const order = await db.salesOrder.findUnique({
      where: { id: row.salesOrderId },
      include: {
        items: true,
        tracking: true,
        reviewRequests: {
          where: { state: "pending", expiresAt: { gt: new Date() } },
          include: {
            orderItem: { include: { product: { select: { name: true } } } },
          },
        },
      },
    });
    if (!order) {
      await db.orderNotificationQueue.update({
        where: { id: row.id },
        data: { state: "cancelled", lastError: "Pedido removido" },
      });
      skipped++;
      continue;
    }
    const prior = await db.orderNotificationLog.findFirst({
      where: {
        salesOrderId: order.id,
        statusTrigger: row.statusTrigger,
        channel: row.channel,
        recipientType: row.recipientType,
        success: true,
      },
    });
    if (prior && !row.force) {
      await skip(
        db,
        row.id,
        order.id,
        row.statusTrigger,
        row.channel,
        row.recipientType,
        "Envio já realizado",
      );
      skipped++;
      continue;
    }
    const channelSettings =
      row.recipientType === "admin"
        ? object(settings.email)
        : object(settings.emailCustomer);
    if (!settingsRow?.enabled || channelSettings.enabled !== true) {
      await skip(
        db,
        row.id,
        order.id,
        row.statusTrigger,
        row.channel,
        row.recipientType,
        "Canal desativado nas configurações",
      );
      skipped++;
      continue;
    }
    const recipient =
      row.recipientType === "customer"
        ? order.customerEmail
        : first(array(channelSettings.recipients));
    if (!recipient) {
      await skip(
        db,
        row.id,
        order.id,
        row.statusTrigger,
        row.channel,
        row.recipientType,
        "Destinatário ausente",
      );
      skipped++;
      continue;
    }
    if (
      row.recipientType === "customer" &&
      (await db.integrationOptOut.findUnique({
        where: {
          contactHash_channel: {
            contactHash: contactHash(recipient),
            channel: row.channel,
          },
        },
      }))
    ) {
      await skip(
        db,
        row.id,
        order.id,
        row.statusTrigger,
        `${row.channel}_skip`,
        row.recipientType,
        "Cliente optou por não receber (LGPD)",
      );
      skipped++;
      continue;
    }
    const recentFailures = await db.orderNotificationLog.count({
      where: {
        channel: row.channel,
        success: false,
        skipped: false,
        createdAt: { gte: new Date(Date.now() - 300000) },
      },
    });
    if (recentFailures > 10) {
      await db.orderNotificationQueue.update({
        where: { id: row.id },
        data: {
          state: "pending",
          claimedAt: null,
          nextAttemptAt: new Date(Date.now() + 900000),
          lastError: "Circuit breaker ativo por 15 minutos",
        },
      });
      continue;
    }
    const deferredUntil = await policyDeferral(
      db,
      settings,
      row.statusTrigger,
      row.channel,
      row.recipientType,
    );
    if (deferredUntil) {
      await db.orderNotificationQueue.update({
        where: { id: row.id },
        data: {
          state: "pending",
          claimedAt: null,
          nextAttemptAt: deferredUntil,
          lastError: "Envio adiado pela política de comunicação",
        },
      });
      continue;
    }
    try {
      const manual =
        row.statusTrigger === "manual" && !row.payload
          ? await db.orderMeta.findUnique({
              where: {
                salesOrderId_key: {
                  salesOrderId: order.id,
                  key: `manual-message-${row.id}`,
                },
              },
            })
          : null;
      const manualValue = Object.keys(object(row.payload)).length
          ? object(row.payload)
          : object(manual?.value),
        statusDefinition = await db.orderStatusDefinition.findUnique({
          where: { key: order.status },
        });
      const message =
        typeof manualValue.message === "string"
          ? manualValue.message
          : renderMessage(
              order,
              storeName,
              storeSlug,
              statusDefinition?.emailTemplate,
              channelSettings,
            );
      await sendConfigured(
        db,
        row.channel,
        recipient,
        message,
        renderSubject(order.number, storeName, channelSettings),
      );
      await db.$transaction([
        db.orderNotificationQueue.update({
          where: { id: row.id },
          data: { state: "sent", claimedAt: null, lastError: null },
        }),
        db.orderNotificationLog.create({
          data: {
            salesOrderId: order.id,
            statusTrigger: row.statusTrigger,
            channel: row.channel,
            recipientType: row.recipientType,
            recipientMasked: mask(recipient),
            success: true,
            consentBasis:
              row.recipientType === "customer"
                ? "mensagem transacional"
                : "configuração administrativa",
            sentAt: new Date(),
          },
        }),
      ]);
      sent++;
      if (
        row.recipientType === "customer" &&
        ["delivered", "completed"].includes(row.statusTrigger || "")
      )
        await db.orderReviewRequest.updateMany({
          where: { salesOrderId: order.id, state: "pending" },
          data: { sendCount: { increment: 1 }, lastSentAt: new Date() },
        });
    } catch (error) {
      const attempts = row.attempts + 1,
        exhausted = attempts >= BACKOFF.length,
        message =
          error instanceof Error
            ? error.message.slice(0, 500)
            : "Falha no provedor";
      await db.$transaction([
        db.orderNotificationQueue.update({
          where: { id: row.id },
          data: {
            state: exhausted ? "dead" : "pending",
            attempts,
            claimedAt: null,
            lastError: message,
            nextAttemptAt: new Date(
              Date.now() +
                BACKOFF[Math.min(attempts - 1, BACKOFF.length - 1)] * 1000,
            ),
          },
        }),
        db.orderNotificationLog.create({
          data: {
            salesOrderId: order.id,
            statusTrigger: row.statusTrigger,
            channel: row.channel,
            recipientType: row.recipientType,
            recipientMasked: mask(recipient),
            error: message,
          },
        }),
      ]);
      failed++;
    }
  }
  const result = { processed: rows.length, sent, skipped, failed };
  await db.$disconnect();
  return result;
}

async function skip(
  db: Awaited<ReturnType<typeof tenantDb>>,
  queueId: number,
  orderId: number,
  trigger: string | null,
  channel: string,
  recipientType: string,
  reason: string,
) {
  await db.$transaction([
    db.orderNotificationQueue.update({
      where: { id: queueId },
      data: { state: "cancelled", claimedAt: null, lastError: reason },
    }),
    db.orderNotificationLog.create({
      data: {
        salesOrderId: orderId,
        statusTrigger: trigger,
        channel,
        recipientType,
        skipped: true,
        skipReason: reason,
      },
    }),
  ]);
}
async function sendConfigured(
  db: Awaited<ReturnType<typeof tenantDb>>,
  channel: string,
  recipient: string,
  message: string,
  subject: string,
) {
  if (channel !== "email")
    throw new Error("Canal direto removido; use webhook externo");
  const credentials = await db.integrationCredential.findMany({
    where: { providerId: "smtp", ...activeCredentialFilter() },
    include: { provider: true },
    orderBy: [{ isDefault: "desc" }, { provider: { priority: "asc" } }],
  });
  const credential = credentials.find((item) =>
    isConfigured(
      item.providerId,
      object(item.config),
      decryptSecrets(item.secretsCipherText),
    ),
  );
  if (credential) {
    const result = await sendWithProvider(
      {
        providerId: credential.providerId,
        credentialId: credential.id,
        config: object(credential.config),
        secrets: decryptSecrets(credential.secretsCipherText),
      },
      recipient,
      message,
      { subject },
    );
    if (!result.success) throw new Error(result.message);
    return;
  }
  throw new Error("SMTP transacional não configurado");
}

async function maintainLogs(
  db: Awaited<ReturnType<typeof tenantDb>>,
  settings: Record<string, unknown>,
) {
  const days = bounded(settings.logRetentionDays, 7, 3650, 90),
    before = new Date(Date.now() - days * 86_400_000);
  if (settings.anonymizeOnCleanup === true)
    await db.orderNotificationLog.updateMany({
      where: { createdAt: { lt: before }, recipientMasked: { not: null } },
      data: { recipientMasked: null, error: null },
    });
  else
    await db.orderNotificationLog.deleteMany({
      where: { createdAt: { lt: before } },
    });
  await db.orderNotificationQueue.deleteMany({
    where: { updatedAt: { lt: before }, state: { in: ["sent", "cancelled"] } },
  });
  const piiDays = bounded(settings.piiRetentionDays, 30, 3650, 365),
    piiBefore = new Date(Date.now() - piiDays * 86_400_000);
  await db.salesOrder.updateMany({
    where: {
      createdAt: { lt: piiBefore },
      OR: [{ ipAddress: { not: null } }, { userAgent: { not: null } }],
    },
    data: { ipAddress: null, userAgent: null },
  });
}

async function sendDailySummary(
  db: Awaited<ReturnType<typeof tenantDb>>,
  organizationId: string,
  storeName: string,
  settingsRow: { id: number; settings: Prisma.JsonValue },
  settings: Record<string, unknown>,
) {
  const daily = object(settings.dailySummary),
    recipients = array(daily.recipients),
    timezone = validTimezone(String(daily.timezone || "America/Sao_Paulo"));
  if (daily.enabled !== true || !recipients.length) return;
  const parts = localParts(new Date(), timezone),
    targetHour = bounded(daily.hour, 0, 23, 18);
  if (parts.hour < targetHour || daily.lastSentDate === parts.date) return;
  const orders = await db.salesOrder.findMany({
    where: {
      createdAt: { gte: new Date(Date.now() - 86_400_000) },
      deletedAt: null,
    },
    include: { items: true },
  });
  const confirmed = orders.filter((order) =>
    [
      "processing",
      "preparing",
      "shipped",
      "out-delivery",
      "delivered",
      "completed",
      "refunded",
    ].includes(order.status),
  );
  const revenue = confirmed.reduce((sum, order) => sum + order.total, 0),
    ticket = confirmed.length ? revenue / confirmed.length : 0,
    statuses = new Map<string, number>(),
    products = new Map<string, number>();
  for (const order of orders) {
    statuses.set(order.status, (statuses.get(order.status) || 0) + 1);
    for (const item of order.items)
      products.set(
        item.nameSnapshot,
        (products.get(item.nameSnapshot) || 0) + item.quantity,
      );
  }
  const top = [...products].sort((a, b) => b[1] - a[1]).slice(0, 5),
    message = [
      `Resumo diário — ${storeName}`,
      `Período móvel: últimas 24 horas`,
      `Pedidos: ${orders.length}`,
      `Receita confirmada: ${revenue.toLocaleString("pt-BR", { style: "currency", currency: "BRL" })}`,
      `Ticket médio: ${ticket.toLocaleString("pt-BR", { style: "currency", currency: "BRL" })}`,
      "",
      "Por status:",
      ...[...statuses].map(([status, total]) => `• ${status}: ${total}`),
      "",
      "Produtos mais vendidos:",
      ...(top.length
        ? top.map(([name, quantity]) => `• ${name}: ${quantity}`)
        : ["• Nenhuma venda no período"]),
    ].join("\n");
  for (const recipient of recipients)
    await sendConfigured(
      db,
      "email",
      recipient,
      message,
      `Resumo diário de pedidos — ${storeName}`,
    );
  daily.lastSentDate = parts.date;
  daily.lastSentAt = new Date().toISOString();
  settings.dailySummary = daily;
  await db.orderNotificationSettings.update({
    where: { id: settingsRow.id },
    data: {
      settings: settings as Prisma.InputJsonValue,
      updatedBy: "worker:daily-summary",
    },
  });
}

async function policyDeferral(
  db: Awaited<ReturnType<typeof tenantDb>>,
  settings: Record<string, unknown>,
  status: string | null,
  channel: string,
  recipientType: string,
) {
  if (!status || status === "manual") return null;
  const channelKey = `${recipientType}_${channel}`,
    policies = object(settings.policies),
    statusPolicy = object(policies[status]),
    scoped = object(statusPolicy[channelKey]),
    policy = Object.keys(scoped).length ? scoped : statusPolicy;
  const throttle = bounded(
    policy.throttle_per_minute ?? policy.throttlePerMinute,
    0,
    10000,
    0,
  );
  if (throttle > 0) {
    const count = await db.orderNotificationLog.count({
      where: {
        statusTrigger: status,
        channel,
        recipientType,
        success: true,
        createdAt: { gte: new Date(Date.now() - 60_000) },
      },
    });
    if (count >= throttle) return new Date(Date.now() + 60_000);
  }
  const quiet = object(policy.quiet_hours ?? policy.quietHours),
    start = bounded(quiet.start, 0, 23, -1),
    end = bounded(quiet.end, 0, 23, -1);
  if (start < 0 || end < 0 || start === end) return null;
  const timezone = validTimezone(
      String(
        policy.timezone ||
          object(settings.dailySummary).timezone ||
          "America/Sao_Paulo",
      ),
    ),
    parts = localParts(new Date(), timezone),
    inside =
      start < end
        ? parts.hour >= start && parts.hour < end
        : parts.hour >= start || parts.hour < end;
  if (!inside) return null;
  let minutes = ((end - parts.hour + 24) % 24) * 60 - parts.minute;
  if (minutes <= 0) minutes += 1440;
  return new Date(Date.now() + minutes * 60_000);
}
function renderSubject(
  number: string,
  store: string,
  settings: Record<string, unknown>,
) {
  return String(
    settings.subjectTemplate || `Atualização do pedido #${number} — ${store}`,
  )
    .replaceAll("{order_id}", number)
    .replaceAll("{order_number}", number)
    .replaceAll("{store_name}", store);
}
function renderMessage(
  order: {
    number: string;
    customerName: string;
    status: string;
    total: number;
    paymentTitle: string | null;
    notes: string | null;
    origin: string;
    items: Array<{ nameSnapshot: string; quantity: number }>;
    tracking: { trackingNumber: string; trackingUrl: string | null } | null;
    reviewRequests: Array<{
      token: string;
      orderItem: { product: { name: string } };
    }>;
  },
  store: string,
  storeSlug: string,
  statusTemplate: unknown,
  channelSettings: Record<string, unknown>,
) {
  const items =
      order.items
        .slice(0, 20)
        .map((item) => `• ${item.nameSnapshot} x${item.quantity}`)
        .join("\n") +
      (order.items.length > 20 ? `\n… + ${order.items.length - 20} itens` : ""),
    reviewLinks = order.reviewRequests
      .slice(0, 10)
      .map(
        (item) =>
          `• ${item.orderItem.product.name}: https://nalven.com.br/avaliar/${item.token}?loja=${encodeURIComponent(storeSlug)}`,
      )
      .join("\n"),
    templateValue =
      localeTemplate(statusTemplate) ||
      localeTemplate(channelSettings.bodyTemplate),
    fallback = `Olá, {customer_name}.\n\nO pedido #{order_number} está em {status}.\nTotal: {total}\n{items_list}\nRastreio: {tracking_code}\n{tracking_url}\n{review_links}\n\n{store_name}`,
    tokens: Record<string, string> = {
      order_id: order.number,
      order_number: order.number,
      customer_name: order.customerName,
      total: order.total.toLocaleString("pt-BR", {
        style: "currency",
        currency: "BRL",
      }),
      status: order.status,
      payment_method: order.paymentTitle || "",
      items_list: items,
      order_notes: order.notes || "",
      tracking_code: order.tracking?.trackingNumber || "",
      tracking_number: order.tracking?.trackingNumber || "",
      tracking_url: order.tracking?.trackingUrl || "",
      review_links: reviewLinks,
      review_url: order.reviewRequests[0]
        ? `https://nalven.com.br/avaliar/${order.reviewRequests[0].token}?loja=${encodeURIComponent(storeSlug)}`
        : "",
      origem: order.origin,
      store_name: store,
    };
  return fillTemplate(templateValue || fallback, tokens);
}
function localeTemplate(value: unknown) {
  if (typeof value === "string") return value;
  const map = object(value);
  return typeof map.pt_BR === "string"
    ? map.pt_BR
    : typeof map.pt === "string"
      ? map.pt
      : typeof map.en === "string"
        ? map.en
        : "";
}
function fillTemplate(template: string, tokens: Record<string, string>) {
  let result = template.replace(/R\$\s*\{total\}/g, "{total}");
  for (const [key, value] of Object.entries(tokens)) {
    if (!value)
      result = result.replace(
        new RegExp(`^.*\\{${key}\\}.*(?:\\r?\\n|$)`, "gm"),
        "",
      );
    result = result.replaceAll(`{${key}}`, value);
  }
  return result
    .replace(/\{[a-z0-9_]+\}/gi, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}
function object(value: unknown) {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}
function array(value: unknown) {
  return Array.isArray(value) ? value.map(String).filter(Boolean) : [];
}
function first(value: string[]) {
  return value[0] || null;
}
function bounded(value: unknown, min: number, max: number, fallback: number) {
  const number = Number(value);
  return Number.isFinite(number) && number >= min && number <= max
    ? number
    : fallback;
}
function validTimezone(value: string) {
  try {
    new Intl.DateTimeFormat("pt-BR", { timeZone: value }).format();
    return value;
  } catch {
    return "America/Sao_Paulo";
  }
}
function localParts(date: Date, timezone: string) {
  const parts = new Intl.DateTimeFormat("en-CA", {
      timeZone: timezone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    }).formatToParts(date),
    get = (type: Intl.DateTimeFormatPartTypes) =>
      parts.find((item) => item.type === type)?.value || "0";
  return {
    date: `${get("year")}-${get("month")}-${get("day")}`,
    hour: Number(get("hour")),
    minute: Number(get("minute")),
  };
}
function mask(value: string) {
  if (value.includes("@")) {
    const [name, domain] = value.split("@");
    return `${name.slice(0, 2)}***@${domain}`;
  }
  const digits = value.replace(/\D/g, "");
  return `${"*".repeat(Math.max(0, digits.length - 4))}${digits.slice(-4)}`;
}
main().finally(async () => {
  await controlDb.$disconnect();
});
