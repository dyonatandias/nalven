import { randomBytes } from "node:crypto";
import { enqueueWebhook } from "@/lib/integrations/webhooks";
import type { Prisma, PrismaClient } from "@/generated/tenant/client";

export class OrderDomainError extends Error {
  constructor(
    message: string,
    public readonly status = 400,
    public readonly retryAfter?: number,
  ) {
    super(message);
  }
}

export const ORDER_TRANSITIONS: Record<string, readonly string[]> = {
  draft: ["approved", "pending", "processing", "on-hold", "cancelled"],
  approved: ["pending", "processing", "preparing", "completed", "cancelled"],
  pending: [
    "processing",
    "on-hold",
    "failed",
    "cancelled",
    "awaiting-shipping",
  ],
  processing: [
    "on-hold",
    "preparing",
    "shipped",
    "completed",
    "cancelled",
    "refunded",
  ],
  "on-hold": ["pending", "processing", "preparing", "cancelled"],
  preparing: ["processing", "on-hold", "shipped", "cancelled"],
  shipped: ["preparing", "out-delivery", "delivered", "completed"],
  "out-delivery": ["shipped", "delivered", "completed"],
  delivered: ["completed", "refunded"],
  completed: ["refunded"],
  "awaiting-shipping": ["pending", "processing", "cancelled"],
  failed: ["pending", "cancelled"],
  cancelled: [],
  refunded: [],
};

export const ORDER_INCLUDE = {
  customer: {
    select: {
      id: true,
      name: true,
      tradeName: true,
      email: true,
      phone: true,
      document: true,
    },
  },
  branch: { select: { id: true, code: true, name: true } },
  items: {
    include: {
      product: {
        select: {
          id: true,
          name: true,
          sku: true,
          unit: true,
          stock: true,
          type: true,
        },
      },
      variation: { select: { id: true, sku: true, attributes: true } },
      metadata: true,
    },
  },
  history: { orderBy: { createdAt: "desc" as const } },
  addresses: true,
  notesTimeline: { orderBy: { createdAt: "desc" as const } },
  refunds: {
    include: { items: true },
    orderBy: { createdAt: "desc" as const },
  },
  tracking: {
    include: { events: { orderBy: { occurredAt: "desc" as const } } },
  },
  notificationLogs: { orderBy: { createdAt: "desc" as const }, take: 100 },
  payments: { orderBy: { createdAt: "desc" as const } },
  returns: {
    include: { items: true },
    orderBy: { requestedAt: "desc" as const },
  },
  documents: { orderBy: { createdAt: "desc" as const } },
  shippingLabels: { orderBy: { createdAt: "desc" as const } },
  reviewRequests: { orderBy: { createdAt: "desc" as const } },
  channelOrder: {
    include: { channel: { select: { name: true, provider: true } } },
  },
} satisfies Prisma.SalesOrderInclude;

export type TenantTransaction = Omit<
  PrismaClient,
  "$connect" | "$disconnect" | "$on" | "$transaction" | "$extends"
>;

export function safeId(value: unknown, label = "Pedido") {
  const id = Number(value);
  if (!Number.isSafeInteger(id) || id < 1)
    throw new OrderDomainError(`${label} inválido.`);
  return id;
}

export function cleanText(value: unknown, max: number, required = false) {
  const text = String(value ?? "").trim();
  if (required && !text)
    throw new OrderDomainError("Preencha todos os campos obrigatórios.");
  if (text.length > max)
    throw new OrderDomainError(
      `Um campo excede o limite de ${max} caracteres.`,
    );
  return text;
}

export function safeAmount(value: unknown, label: string, allowZero = false) {
  const amount = Number(value);
  if (!Number.isFinite(amount) || amount < (allowZero ? 0 : 0.01))
    throw new OrderDomainError(`${label} inválido.`);
  return Math.round(amount * 100) / 100;
}

export function safeUrl(value: unknown) {
  const raw = cleanText(value, 2048);
  if (!raw) return null;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new OrderDomainError("URL externa inválida.");
  }
  if (!new Set(["http:", "https:"]).has(url.protocol))
    throw new OrderDomainError("A URL precisa usar HTTP ou HTTPS.");
  return url.toString();
}

export async function validStatus(db: TenantTransaction, status: unknown) {
  const key = cleanText(status, 60, true).toLowerCase();
  if (!/^[a-z0-9-]+$/.test(key)) throw new OrderDomainError("Status inválido.");
  if (!(await db.orderStatusDefinition.findUnique({ where: { key } })))
    throw new OrderDomainError("Status não cadastrado.");
  return key;
}

export async function transitionOrder(
  db: TenantTransaction,
  orderId: number,
  destination: string,
  actor: { id: string; name: string },
  reason?: string,
  allowRegression = false,
) {
  const order = await db.salesOrder.findUnique({
    where: { id: orderId },
    select: { id: true, number: true, status: true, deletedAt: true },
  });
  if (!order || order.deletedAt)
    throw new OrderDomainError("Pedido não encontrado.", 404);
  if (order.status === destination)
    return db.salesOrder.findUnique({
      where: { id: order.id },
      include: ORDER_INCLUDE,
    });
  const custom = !Object.hasOwn(ORDER_TRANSITIONS, destination);
  const allowed =
    custom || ORDER_TRANSITIONS[order.status]?.includes(destination);
  if (!allowed && !allowRegression)
    throw new OrderDomainError(
      `Transição inválida: ${order.status} → ${destination}.`,
      422,
    );
  const now = new Date();
  const updated = await db.salesOrder.update({
    where: { id: order.id },
    data: {
      status: destination,
      paidAt: destination === "processing" ? now : undefined,
      completedAt: new Set(["completed", "delivered"]).has(destination)
        ? now
        : undefined,
      needsProcessing: false,
      history: {
        create: {
          fromStatus: order.status,
          toStatus: destination,
          actor: actor.name,
          actorId: actor.id,
          actorType: "user",
          reason: cleanText(reason, 500) || null,
        },
      },
    },
    include: ORDER_INCLUDE,
  });
  if (destination === "delivered" || destination === "completed")
    await ensureReviewRequests(db, order.id);
  await enqueueStatusNotifications(db, order.id, destination);
  await enqueueWebhook(db as Prisma.TransactionClient, "order.status_changed", {
    orderId: order.id,
    orderNumber: order.number,
    fromStatus: order.status,
    toStatus: destination,
    changedAt: now.toISOString(),
  });
  return updated;
}

async function ensureReviewRequests(
  db: TenantTransaction,
  salesOrderId: number,
) {
  const items = await db.salesOrderItem.findMany({
    where: { salesOrderId, product: { reviewsAllowed: true } },
    select: { id: true },
  });
  for (const item of items)
    await db.orderReviewRequest.upsert({
      where: {
        salesOrderId_orderItemId: { salesOrderId, orderItemId: item.id },
      },
      update: {},
      create: {
        salesOrderId,
        orderItemId: item.id,
        token: randomBytes(32).toString("base64url"),
        expiresAt: new Date(Date.now() + 90 * 86_400_000),
      },
    });
}

export async function enqueueStatusNotifications(
  db: TenantTransaction,
  salesOrderId: number,
  status: string,
) {
  const row = await db.orderNotificationSettings.findUnique({
    where: { id: 1 },
  });
  if (!row?.enabled) return;
  const settings = jsonObject(row.settings),
    matrix = jsonObject(settings.matrix),
    statusMatrix = jsonObject(matrix[status]);
  const candidates = [
    {
      key: "admin_email",
      channel: "email",
      recipientType: "admin",
      config: jsonObject(settings.email),
    },
    {
      key: "customer_email",
      channel: "email",
      recipientType: "customer",
      config: jsonObject(settings.emailCustomer),
    },
  ];
  for (const candidate of candidates) {
    if (candidate.config.enabled !== true) continue;
    const override = statusMatrix[candidate.key],
      defaults = Array.isArray(candidate.config.triggerStatuses)
        ? candidate.config.triggerStatuses.map(String)
        : [];
    if (override === false || (override !== true && !defaults.includes(status)))
      continue;
    const alreadySent = await db.orderNotificationLog.findFirst({
      where: {
        salesOrderId,
        statusTrigger: status,
        channel: candidate.channel,
        recipientType: candidate.recipientType,
        success: true,
      },
      select: { id: true },
    });
    const alreadyQueued = await db.orderNotificationQueue.findFirst({
      where: {
        salesOrderId,
        statusTrigger: status,
        channel: candidate.channel,
        recipientType: candidate.recipientType,
        state: { in: ["pending", "processing", "sent"] },
      },
      select: { id: true },
    });
    if (alreadySent || alreadyQueued) continue;
    const dedupKey = `order:${salesOrderId}:status:${status}:${candidate.channel}:${candidate.recipientType}`;
    await db.orderNotificationQueue.upsert({
      where: { dedupKey },
      update: {},
      create: {
        salesOrderId,
        statusTrigger: status,
        channel: candidate.channel,
        recipientType: candidate.recipientType,
        dedupKey,
        nextAttemptAt: policyDate(settings, status, candidate.key),
      },
    });
  }
}

function policyDate(
  settings: Record<string, unknown>,
  status: string,
  channelKey: string,
) {
  const policies = jsonObject(settings.policies),
    statusPolicy = jsonObject(policies[status]),
    policy = Object.keys(jsonObject(statusPolicy[channelKey])).length
      ? jsonObject(statusPolicy[channelKey])
      : statusPolicy;
  const delayMinutes = boundedNumber(
      policy.delay_minutes ?? policy.delayMinutes,
      0,
      10080,
      0,
    ),
    target = new Date(Date.now() + delayMinutes * 60_000),
    quiet = jsonObject(policy.quiet_hours ?? policy.quietHours);
  const start = boundedNumber(quiet.start, 0, 23, -1),
    end = boundedNumber(quiet.end, 0, 23, -1),
    parts = timezoneParts(
      target,
      String(
        policy.timezone ||
          jsonObject(settings.dailySummary).timezone ||
          "America/Sao_Paulo",
      ),
    ),
    hour = parts.hour;
  if (start < 0 || end < 0 || start === end) return target;
  const inside =
    start < end ? hour >= start && hour < end : hour >= start || hour < end;
  if (!inside) return target;
  let minutes = ((end - hour + 24) % 24) * 60 - parts.minute;
  if (minutes <= 0) minutes += 1440;
  return new Date(target.getTime() + minutes * 60_000);
}

function boundedNumber(
  value: unknown,
  min: number,
  max: number,
  fallback: number,
) {
  const number = Number(value);
  return Number.isFinite(number) && number >= min && number <= max
    ? number
    : fallback;
}
function jsonObject(value: unknown) {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}
function timezoneParts(date: Date, requested: string) {
  let timeZone = requested;
  try {
    new Intl.DateTimeFormat("pt-BR", { timeZone }).format();
  } catch {
    timeZone = "America/Sao_Paulo";
  }
  const parts = new Intl.DateTimeFormat("en-CA", {
      timeZone,
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    }).formatToParts(date),
    get = (type: Intl.DateTimeFormatPartTypes) =>
      Number(parts.find((part) => part.type === type)?.value || 0);
  return { hour: get("hour"), minute: get("minute") };
}

export function resolveCarrier(
  carriers: Array<{
    key: string;
    label: string;
    urlTemplate: string | null;
    keywords: string[];
    patterns: string[];
  }>,
  carrierName: string,
  code: string,
) {
  const normalized = carrierName.toLocaleLowerCase("pt-BR");
  const foundByName = carriers.find(
    (carrier) =>
      carrier.key === normalized ||
      carrier.keywords.some((keyword) =>
        normalized.includes(keyword.toLocaleLowerCase("pt-BR")),
      ),
  );
  if (foundByName) return foundByName;
  return (
    carriers.find((carrier) =>
      carrier.patterns.some((pattern) => {
        try {
          return new RegExp(pattern, "i").test(code);
        } catch {
          return false;
        }
      }),
    ) || null
  );
}

export function csvCell(value: unknown) {
  let text = String(value ?? "");
  if (/^\s*[=+@-]/.test(text)) text = `'${text}`;
  return /[,"\n\r]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

export function maskRecipient(value: string) {
  if (value.includes("@")) {
    const [name, domain] = value.split("@");
    return `${name.slice(0, 2)}***@${domain}`;
  }
  const digits = value.replace(/\D/g, "");
  return digits.length > 4
    ? `${"*".repeat(digits.length - 4)}${digits.slice(-4)}`
    : "****";
}
