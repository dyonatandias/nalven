import { createHash, randomInt, timingSafeEqual } from "node:crypto";
import type { Prisma, PrismaClient } from "@/generated/tenant/client";
import { decryptSecret, encryptSecret } from "@/lib/secrets";
import {
  DEFAULT_SETTINGS,
  OTP_CONTEXTS,
  PROVIDER_MAP,
  ROUTING_CONTEXTS,
} from "./catalog";

export class IntegrationError extends Error {
  constructor(
    message: string,
    public status = 400,
  ) {
    super(message);
  }
}

export type HealthResult = {
  success: boolean;
  message: string;
  latency_ms: number;
  details: Record<string, unknown>;
};
export type ResolvedProvider = {
  providerId: string;
  credentialId: string;
  config: Record<string, unknown>;
  secrets: Record<string, string>;
};

export function activeCredentialFilter(
  now = new Date(),
): Prisma.IntegrationCredentialWhereInput {
  return {
    enabled: true,
    revokedAt: null,
    OR: [{ expiresAt: null }, { expiresAt: { gt: now } }],
  };
}

export function objectValue(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

export function encryptSecrets(value: Record<string, string>) {
  return Object.keys(value).length
    ? encryptSecret(JSON.stringify(value))
    : null;
}

export function decryptSecrets(
  value: string | null | undefined,
): Record<string, string> {
  if (!value) return {};
  try {
    const parsed = JSON.parse(decryptSecret(value));
    return Object.fromEntries(
      Object.entries(objectValue(parsed)).filter(
        (entry): entry is [string, string] => typeof entry[1] === "string",
      ),
    );
  } catch {
    return {};
  }
}

export function secretFields(providerId: string) {
  return (PROVIDER_MAP.get(providerId)?.fields || [])
    .filter((field) => field.secret)
    .map((field) => field.key);
}

export function splitCredential(
  providerId: string,
  input: unknown,
  currentCipher?: string | null,
) {
  const provider = PROVIDER_MAP.get(providerId);
  if (!provider) throw new IntegrationError("Provider inexistente.", 404);
  const source = objectValue(input),
    allowed = new Set(provider.fields.map((field) => field.key));
  const unknown = Object.keys(source).filter((key) => !allowed.has(key));
  if (unknown.length)
    throw new IntegrationError(`Campos não permitidos: ${unknown.join(", ")}.`);
  const current = decryptSecrets(currentCipher),
    secrets: Record<string, string> = { ...current },
    config: Record<string, unknown> = {};
  for (const field of provider.fields) {
    const raw = source[field.key];
    if (field.secret) {
      const candidate = typeof raw === "string" ? raw.trim() : "";
      if (candidate && !isSecretSentinel(candidate, current[field.key]))
        secrets[field.key] = candidate;
      continue;
    }
    if (raw !== undefined)
      config[field.key] = normalizeField(field.type, raw, field.options);
  }
  if (
    provider.id === "smtp" &&
    source.enabled === true &&
    (!config.host || !config.from_email)
  )
    throw new IntegrationError(
      "SMTP exige servidor e e-mail remetente antes de ser ativado.",
    );
  return { config, secrets, secretsCipherText: encryptSecrets(secrets) };
}

function normalizeField(type: string, value: unknown, options?: string[]) {
  if (type === "boolean") return value === true;
  if (type === "number") {
    const number = Number(value);
    if (!Number.isFinite(number))
      throw new IntegrationError("Informe um número válido.");
    return number;
  }
  const text = String(value ?? "").trim();
  if (type === "url" && text && !safeHttpsSyntax(text))
    throw new IntegrationError("Informe uma URL HTTPS válida.");
  if (type === "email" && text && !/^\S+@\S+\.\S+$/.test(text))
    throw new IntegrationError("Informe um e-mail válido.");
  if (type === "select" && options && text && !options.includes(text))
    throw new IntegrationError("Opção inválida.");
  return text.slice(0, type === "text" ? 4000 : 1000);
}

function isSecretSentinel(value: string, current?: string) {
  return (
    value === "***" ||
    value === "••••••••" ||
    value === maskSecret(current || "") ||
    (value.startsWith("***") && current?.endsWith(value.slice(-4)))
  );
}

export function serializeCredential<
  T extends { providerId: string; secretsCipherText?: string | null },
>(credential: T) {
  const secrets = decryptSecrets(credential.secretsCipherText),
    metadata: Record<string, unknown> = {};
  for (const key of secretFields(credential.providerId)) {
    metadata[key] = "";
    metadata[`has_${key}`] = Boolean(secrets[key]);
    metadata[`${key}_preview`] = maskSecret(secrets[key] || "");
  }
  const { secretsCipherText: _secret, ...safe } = credential;
  void _secret;
  return { ...safe, secretMetadata: metadata };
}

export function maskSecret(value: string) {
  return value ? `***${value.slice(-4)}` : "";
}
export function maskRecipient(value: string) {
  return value.length < 5 ? "***" : `${value.slice(0, 2)}***${value.slice(-3)}`;
}
export function contactHash(value: string) {
  return createHash("sha256").update(value.trim().toLowerCase()).digest("hex");
}

const REDACTED_PARTS = [
  "password",
  "secret",
  "token",
  "api_key",
  "authorization",
  "private_key",
  "partner_key",
];
export function redact(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redact);
  if (!value || typeof value !== "object") {
    if (
      typeof value === "string" &&
      (/\bBearer\s+\S+/i.test(value) || /\bsk-[\w-]{8,}/i.test(value))
    )
      return "[REDIGIDO]";
    return value;
  }
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).map(([key, item]) => [
      key,
      REDACTED_PARTS.some((part) => key.toLowerCase().includes(part))
        ? "[REDIGIDO]"
        : redact(item),
    ]),
  );
}

export async function ensureIntegrationSeed(db: PrismaClient) {
  const { PROVIDERS } = await import("./catalog");
  const removedProviders = [
    "email",
    "webhook",
    "whatsapp_api",
    "whatsapp_official",
    "payment_gateway",
    "ai",
  ];
  await db.$transaction(
    PROVIDERS.map((provider) =>
      db.integrationProvider.upsert({
        where: { id: provider.id },
        update: {
          family: provider.family,
          label: provider.label,
          description: provider.description,
          recipientType: provider.recipientType,
          authType: provider.authType,
          capabilities: provider.capabilities,
          credentialSchema: provider.fields,
          supportsTest: provider.supportsTest,
          docsUrl: provider.docsUrl || null,
          priority: provider.priority,
        },
        create: {
          id: provider.id,
          family: provider.family,
          label: provider.label,
          description: provider.description,
          recipientType: provider.recipientType,
          authType: provider.authType,
          capabilities: provider.capabilities,
          credentialSchema: provider.fields,
          supportsTest: provider.supportsTest,
          docsUrl: provider.docsUrl || null,
          priority: provider.priority,
        },
      }),
    ),
  );
  await db.integrationCredential.updateMany({
    where: { providerId: { in: removedProviders }, enabled: true },
    data: { enabled: false, isDefault: false },
  });
  await db.integrationRouting.updateMany({
    where: { context: { notIn: [...ROUTING_CONTEXTS] } },
    data: { enabled: false },
  });
  await db.$transaction(
    ROUTING_CONTEXTS.map((context) =>
      db.integrationRouting.upsert({
        where: { context },
        update: {},
        create: {
          context,
          providerId: "auto",
          fallbackProviderId: "",
          config: {},
        },
      }),
    ),
  );
  await db.integrationSettings.upsert({
    where: { id: 1 },
    update: {},
    create: { id: 1, ...DEFAULT_SETTINGS },
  });
}

export async function resolveProvider(
  db: PrismaClient,
  context: string,
  fallback = false,
  excluded?: string,
): Promise<ResolvedProvider | null> {
  if (!(ROUTING_CONTEXTS as readonly string[]).includes(context))
    throw new IntegrationError("Contexto inválido.");
  const route = await db.integrationRouting.findUnique({ where: { context } });
  if (route && !route.enabled) return null;
  let requested = fallback ? route?.fallbackProviderId : route?.providerId;
  if (
    requested &&
    requested !== "auto" &&
    requested !== "_none" &&
    !PROVIDER_MAP.has(requested)
  )
    requested = "smtp";
  if (requested === "_none") return null;
  if (!requested || requested === "auto" || requested === excluded) {
    const family = OTP_CONTEXTS.has(context) ? "messaging" : "messaging";
    const candidates = await db.integrationCredential.findMany({
      where: {
        ...activeCredentialFilter(),
        provider: { family },
        ...(excluded ? { providerId: { not: excluded } } : {}),
      },
      include: { provider: true },
      orderBy: [{ isDefault: "desc" }, { provider: { priority: "asc" } }],
    });
    const item = candidates.find((credential) =>
      isConfigured(
        credential.providerId,
        objectValue(credential.config),
        decryptSecrets(credential.secretsCipherText),
      ),
    );
    return item ? resolved(item) : null;
  }
  const item = await db.integrationCredential.findFirst({
    where: {
      providerId: requested,
      ...activeCredentialFilter(),
    },
    orderBy: [{ isDefault: "desc" }, { createdAt: "asc" }],
  });
  return item &&
    isConfigured(
      item.providerId,
      objectValue(item.config),
      decryptSecrets(item.secretsCipherText),
    )
    ? resolved(item)
    : null;
}

function resolved(item: {
  id: string;
  providerId: string;
  config: unknown;
  secretsCipherText: string | null;
}): ResolvedProvider {
  return {
    providerId: item.providerId,
    credentialId: item.id,
    config: objectValue(item.config),
    secrets: decryptSecrets(item.secretsCipherText),
  };
}

export function isConfigured(
  providerId: string,
  config: Record<string, unknown>,
  secrets: Record<string, string>,
) {
  const provider = PROVIDER_MAP.get(providerId);
  if (!provider) return false;
  return provider.fields
    .filter((field) => field.required)
    .every((field) =>
      field.secret ? Boolean(secrets[field.key]) : Boolean(config[field.key]),
    );
}

export function generateOtp(
  length = 6,
  alphanumeric = false,
  allowLeadingZero = true,
) {
  const size = Math.min(10, Math.max(4, Math.floor(length)));
  const alphabet = alphanumeric
    ? "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"
    : "0123456789";
  let code = Array.from(
    { length: size },
    () => alphabet[randomInt(alphabet.length)],
  ).join("");
  if (!allowLeadingZero && code.startsWith("0"))
    code = String(randomInt(1, 10)) + code.slice(1);
  return code;
}

export function constantTimeEqual(left: string, right: string) {
  const a = Buffer.from(left),
    b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}

export function safeHttpsSyntax(value: string) {
  try {
    const url = new URL(value);
    return (
      url.protocol === "https:" &&
      Boolean(url.hostname) &&
      !url.username &&
      !url.password
    );
  } catch {
    return false;
  }
}

export async function persistentRateLimit(
  db: PrismaClient,
  key: string,
  limit: number,
  seconds: number,
) {
  const id = contactHash(key),
    now = new Date(),
    expiresAt = new Date(now.getTime() + seconds * 1000);
  await db.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`integration_rate:${id}`}))`;
    const current = await tx.integrationRateLimit.findUnique({ where: { id } });
    if (!current || current.expiresAt <= now) {
      await tx.integrationRateLimit.upsert({
        where: { id },
        update: { count: 1, windowStart: now, expiresAt },
        create: { id, count: 1, windowStart: now, expiresAt },
      });
      return;
    }
    if (current.count >= limit)
      throw new IntegrationError(
        `Limite atingido. Tente novamente em ${Math.max(1, Math.ceil((current.expiresAt.getTime() - now.getTime()) / 1000))} segundos.`,
        429,
      );
    await tx.integrationRateLimit.update({
      where: { id },
      data: { count: { increment: 1 } },
    });
  });
}

export function settingsSection(
  value: unknown,
  section: keyof typeof DEFAULT_SETTINGS,
) {
  return { ...objectValue(DEFAULT_SETTINGS[section]), ...objectValue(value) };
}
