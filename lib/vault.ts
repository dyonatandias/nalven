import { createHash, randomBytes } from "node:crypto";
import { controlDb } from "@/db/control";
import { decryptSecret, encryptSecret } from "@/lib/secrets";
import type { Prisma } from "@/generated/control/client";
export const VAULT_KEYS = {
  billingApi: "billing.product_api_key",
  billingWebhook: "billing.webhook_secret",
  emailHost: "email.smtp_host",
  emailPort: "email.smtp_port",
  emailEncryption: "email.smtp_encryption",
  emailUsername: "email.smtp_username",
  emailPassword: "email.smtp_password",
  emailFrom: "email.from_address",
} as const;
export async function setVaultSecret(
  key: string,
  value: string,
  category: string,
  updatedById?: string,
  db: Pick<Prisma.TransactionClient, "vaultSecret"> = controlDb,
) {
  const clean = value.trim();
  if (!clean) throw new Error("O segredo não pode ficar vazio.");
  const fingerprint = fingerprintSecret(clean),
    maskedValue = mask(clean);
  const cipherText = encryptSecret(clean);
  await db.vaultSecret.upsert({
    where: { key },
    update: {
      cipherText,
      maskedValue,
      fingerprint,
      category,
      updatedById,
    },
    create: {
      key,
      cipherText,
      maskedValue,
      fingerprint,
      category,
      updatedById,
    },
  });
  return { key, maskedValue, fingerprint };
}
export async function getVaultSecret(key: string) {
  const item = await controlDb.vaultSecret.findUnique({ where: { key } });
  return item ? decryptSecret(item.cipherText) : null;
}
export async function vaultMetadata(category?: string) {
  return controlDb.vaultSecret.findMany({
    where: category ? { category } : undefined,
    select: {
      key: true,
      maskedValue: true,
      fingerprint: true,
      category: true,
      updatedAt: true,
    },
    orderBy: { key: "asc" },
  });
}
export function generateWebhookSecret() {
  return randomBytes(32).toString("hex");
}
export function fingerprintSecret(value: string) {
  return createHash("sha256").update(value.trim()).digest("hex").slice(0, 16);
}
function mask(value: string) {
  if (value.length <= 10) return "••••••••";
  return `${value.slice(0, Math.min(12, value.indexOf("_") > 0 ? value.indexOf("_") + 1 : 6))}••••${value.slice(-4)}`;
}
