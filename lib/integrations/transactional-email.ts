import type { PrismaClient } from "@/generated/tenant/client";
import {
  activeCredentialFilter,
  contactHash,
  decryptSecrets,
  encryptSecrets,
  IntegrationError,
  maskRecipient,
  objectValue,
} from "@/lib/integrations/core";
import { sendWithProvider } from "@/lib/integrations/providers";
import {
  defaultEmailContent,
  TRANSACTIONAL_EMAIL_CATALOG,
} from "@/lib/integrations/transactional-email-catalog";
import { BRAZIL_TIME_ZONE, dateTimeFormatter } from "@/lib/timezone";

const BACKOFF_SECONDS = [30, 120, 600, 3600, 21600, 86400];
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export type TransactionalEmailVariables = Record<
  string,
  string | number | boolean | null
>;

export async function enqueueTransactionalEmail(
  db: PrismaClient,
  input: {
    eventId: string;
    eventKey: string;
    recipient: string;
    variables?: TransactionalEmailVariables;
  },
) {
  const item = TRANSACTIONAL_EMAIL_CATALOG.find(
    (candidate) => candidate.eventKey === input.eventKey,
  );
  if (!item)
    throw new IntegrationError("Evento transacional inexistente.", 404);
  const recipient = input.recipient.trim().toLowerCase();
  if (!EMAIL_PATTERN.test(recipient) || recipient.length > 320)
    throw new IntegrationError("Destinatário de e-mail inválido.");
  if (!input.eventId.trim() || input.eventId.length > 200)
    throw new IntegrationError("Identificador idempotente do evento inválido.");

  const variables = normalizeVariables(input.variables || {});
  for (const key of Object.keys(variables))
    if (!item.variables.includes(key))
      throw new IntegrationError(`A variável ${key} não pertence ao evento.`);
  if (Object.hasOwn(variables, "organization.name"))
    throw new IntegrationError(
      "O nome da organização é preenchido pelo servidor.",
    );
  if (variables["action.url"]) {
    let actionUrl: URL;
    try {
      actionUrl = new URL(String(variables["action.url"]));
    } catch {
      throw new IntegrationError("A URL de ação do evento é inválida.");
    }
    if (actionUrl.protocol !== "https:" || String(variables["action.url"]).length > 2048)
      throw new IntegrationError("A URL de ação precisa usar HTTPS.");
  }
  const definition = await db.transactionalEmailDefinition.upsert({
      where: { eventKey: item.eventKey },
      update: {},
      create: {
        eventKey: item.eventKey,
        label: item.label,
        category: item.category,
        description: item.description,
        variables: item.variables,
        critical: item.critical === true,
      },
      include: {
        versions: {
          where: { status: "published" },
          orderBy: { version: "desc" },
          take: 1,
        },
      },
    });
  if (!definition.enabled)
    throw new IntegrationError(
      "Este evento transacional está desativado.",
      422,
    );

  const credential = await db.integrationCredential.findFirst({
    where: { providerId: "smtp", ...activeCredentialFilter() },
    orderBy: [{ isDefault: "desc" }, { createdAt: "asc" }],
    select: { id: true },
  });
  const recipientCipher = encryptSecrets({ recipient }),
    variablesCipher = encryptSecrets({ variables: JSON.stringify(variables) });
  if (!recipientCipher || !variablesCipher)
    throw new IntegrationError(
      "Não foi possível proteger os dados do envio.",
      500,
    );

  return db.transactionalEmailDelivery.upsert({
    where: { eventId: input.eventId },
    update: {},
    create: {
      eventId: input.eventId,
      eventKey: input.eventKey,
      versionId: definition.versions[0]?.id,
      credentialId: credential?.id,
      recipientMasked: maskRecipient(recipient),
      recipientCipher,
      variablesCipher,
      payload: {
        variableKeys: Object.keys(variables).sort(),
        critical: definition.critical,
      },
    },
  });
}

export async function processTransactionalEmailQueue(
  db: PrismaClient,
  organizationName: string,
  limit = 50,
) {
  const now = new Date();
  const settings = await db.tenantSettings.findUnique({
    where: { id: 1 },
    select: { timezone: true },
  });
  const timeZone = settings?.timezone || BRAZIL_TIME_ZONE;
  await db.transactionalEmailDelivery.updateMany({
    where: {
      status: "processing",
      updatedAt: { lt: new Date(now.getTime() - 15 * 60_000) },
    },
    data: { status: "pending", nextAttemptAt: now },
  });
  const rows = await db.transactionalEmailDelivery.findMany({
    where: {
      status: { in: ["pending", "failed"] },
      nextAttemptAt: { lte: now },
      attempts: { lt: 20 },
    },
    orderBy: { createdAt: "asc" },
    take: Math.min(Math.max(limit, 1), 100),
  });
  let sent = 0,
    failed = 0;
  for (const row of rows) {
    const claimed = await db.transactionalEmailDelivery.updateMany({
      where: {
        id: row.id,
        status: { in: ["pending", "failed"] },
        attempts: row.attempts,
      },
      data: { status: "processing" },
    });
    if (!claimed.count) continue;
    const result = await deliverTransactionalEmail(
      db,
      row.id,
      organizationName,
      timeZone,
    );
    if (result === "sent") sent++;
    else failed++;
  }
  return { processed: rows.length, sent, failed };
}

async function deliverTransactionalEmail(
  db: PrismaClient,
  deliveryId: string,
  organizationName: string,
  timeZone: string,
) {
  const delivery = await db.transactionalEmailDelivery.findUnique({
    where: { id: deliveryId },
    include: { version: true },
  });
  if (!delivery || delivery.status !== "processing") return "ignored";
  const definition = await db.transactionalEmailDefinition.findUnique({
      where: { eventKey: delivery.eventKey },
    }),
    catalogItem = TRANSACTIONAL_EMAIL_CATALOG.find(
      (item) => item.eventKey === delivery.eventKey,
    );
  if (!definition || !catalogItem || !definition.enabled)
    return failDelivery(
      db,
      delivery,
      "Evento inexistente ou desativado.",
      true,
    );

  const recipient = decryptSecrets(delivery.recipientCipher).recipient || "",
    variablesSecret =
      decryptSecrets(delivery.variablesCipher).variables || "{}";
  let variables: TransactionalEmailVariables;
  try {
    variables = normalizeVariables(objectValue(JSON.parse(variablesSecret)));
  } catch {
    return failDelivery(db, delivery, "Variáveis protegidas inválidas.", true);
  }
  if (!EMAIL_PATTERN.test(recipient))
    return failDelivery(db, delivery, "Destinatário protegido inválido.", true);

  if (!definition.critical) {
    const optedOut = await db.integrationOptOut.findUnique({
      where: {
        contactHash_channel: {
          contactHash: contactHash(recipient),
          channel: "email",
        },
      },
    });
    if (optedOut)
      return failDelivery(db, delivery, "Envio bloqueado por opt-out.", true);
  }

  let credential = delivery.credentialId
    ? await db.integrationCredential.findFirst({
        where: {
          id: delivery.credentialId,
          providerId: "smtp",
          ...activeCredentialFilter(),
        },
      })
    : null;
  if (!credential)
    credential = await db.integrationCredential.findFirst({
      where: { providerId: "smtp", ...activeCredentialFilter() },
      orderBy: [{ isDefault: "desc" }, { createdAt: "asc" }],
    });
  const template = delivery.version || defaultEmailContent(catalogItem);
  if (!credential)
    return failDelivery(db, delivery, "Conta SMTP ativa não configurada.");
  const values: TransactionalEmailVariables = {
      "organization.name": organizationName,
      "recipient.name": "Cliente",
      "action.url": "https://app.nalven.com.br",
      "event.date": dateTimeFormatter(timeZone).format(new Date()),
      ...variables,
    },
    result = await sendWithProvider(
      {
        providerId: "smtp",
        credentialId: credential.id,
        config: objectValue(credential.config),
        secrets: decryptSecrets(credential.secretsCipherText),
      },
      recipient,
      renderTemplate(template.textBody, values),
      {
        subject: renderTemplate(template.subject, values),
        html: renderTemplate(template.htmlBody, values, true),
      },
    );
  if (!result.success)
    return failDelivery(
      db,
      delivery,
      result.message,
      result.failureType === "business",
    );
  await db.transactionalEmailDelivery.update({
    where: { id: delivery.id },
    data: {
      status: "sent",
      attempts: { increment: 1 },
      credentialId: credential.id,
      remoteMessageId: result.message_id || null,
      lastError: null,
      sentAt: new Date(),
    },
  });
  return "sent";
}

async function failDelivery(
  db: PrismaClient,
  delivery: { id: string; attempts: number; maxAttempts: number },
  message: string,
  permanent = false,
) {
  const attempts = delivery.attempts + 1,
    dead = permanent || attempts >= delivery.maxAttempts,
    delay = BACKOFF_SECONDS[Math.min(attempts - 1, BACKOFF_SECONDS.length - 1)];
  await db.transactionalEmailDelivery.update({
    where: { id: delivery.id },
    data: {
      status: dead ? "dead" : "failed",
      attempts,
      lastError: message.slice(0, 1000),
      nextAttemptAt: new Date(Date.now() + delay * 1000),
    },
  });
  return dead ? "dead" : "failed";
}

function normalizeVariables(value: Record<string, unknown>) {
  const entries = Object.entries(value);
  if (entries.length > 50)
    throw new IntegrationError("O evento excede o limite de variáveis.");
  return Object.fromEntries(
    entries.map(([key, raw]) => {
      if (!/^[a-z][a-z0-9_.-]{0,79}$/i.test(key))
        throw new IntegrationError(`Variável inválida: ${key}.`);
      if (!["string", "number", "boolean"].includes(typeof raw) && raw !== null)
        throw new IntegrationError(`Valor inválido para a variável ${key}.`);
      const rendered = raw === null ? "" : String(raw);
      if (rendered.length > 10_000)
        throw new IntegrationError(
          `A variável ${key} excede o limite permitido.`,
        );
      return [key, rendered];
    }),
  );
}

function renderTemplate(
  template: string,
  variables: TransactionalEmailVariables,
  html = false,
) {
  return template.replace(
    /{{\s*([a-z0-9_.-]+)\s*}}/gi,
    (_match, key: string) => {
      const value = String(variables[key] ?? "");
      return html ? escapeHtml(value) : value;
    },
  );
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
