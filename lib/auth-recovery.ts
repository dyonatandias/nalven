import { createHash, randomBytes } from "node:crypto";
import { controlDb } from "@/db/control";
import { getVaultSecret, VAULT_KEYS } from "@/lib/vault";
import { sendWithProvider } from "@/lib/integrations/providers";

export const RESET_TTL_MINUTES = 30;
export const resetTokenHash = (token: string) =>
  createHash("sha256").update(token).digest("hex");

export async function createPasswordReset(
  user: { id: string; name: string; email: string },
  requestedIp: string | null,
) {
  const token = randomBytes(32).toString("base64url");
  const expiresAt = new Date(Date.now() + RESET_TTL_MINUTES * 60_000);
  const resetUrl = `https://nalven.com.br/redefinir-senha/${token}`;
  await controlDb.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`password-reset:${user.id}`}))`;
    await tx.passwordResetToken.updateMany({
      where: { userId: user.id, usedAt: null },
      data: { usedAt: new Date() },
    });
    await tx.passwordResetToken.create({
      data: {
        userId: user.id,
        tokenHash: resetTokenHash(token),
        expiresAt,
        requestedIp,
      },
    });
    await tx.emailOutbox.create({
      data: {
        recipient: user.email,
        template: "password_reset",
        subject: "Redefina sua senha da NALVEN",
        textBody: `Olá, ${user.name}. Use este link para redefinir sua senha: ${resetUrl}. Ele expira em ${RESET_TTL_MINUTES} minutos. Se você não solicitou, ignore esta mensagem.`,
        htmlBody: `<p>Olá, ${escapeHtml(user.name)}.</p><p>Recebemos uma solicitação para redefinir sua senha da NALVEN.</p><p><a href="${resetUrl}">Redefinir minha senha</a></p><p>O link expira em ${RESET_TTL_MINUTES} minutos. Se você não solicitou, ignore esta mensagem.</p>`,
      },
    });
  });
  // The billing worker delivers the outbox without exposing SMTP latency here.
}

export async function deliverEmailOutbox(id: string) {
  const message = await controlDb.emailOutbox.findUnique({ where: { id } });
  if (!message || message.status === "sent") return message;
  if (
    message.template === "password_reset" &&
    message.createdAt < new Date(Date.now() - RESET_TTL_MINUTES * 60_000)
  )
    return controlDb.emailOutbox.update({
      where: { id },
      data: {
        status: "expired",
        lastError: "O link de recuperação expirou antes do envio.",
      },
    });
  const smtp = await platformSmtp();
  if (!smtp) return message;
  try {
    const result = await sendWithProvider(
      smtp,
      message.recipient,
      message.textBody,
      { subject: message.subject, html: message.htmlBody },
    );
    if (!result.success) throw new Error(result.message);
    return await controlDb.emailOutbox.update({
      where: { id: message.id },
      data: {
        status: "sent",
        attempts: { increment: 1 },
        sentAt: new Date(),
        lastError: null,
      },
    });
  } catch (error) {
    return await controlDb.emailOutbox.update({
      where: { id: message.id },
      data: {
        status: message.attempts + 1 >= 10 ? "failed" : "pending",
        attempts: { increment: 1 },
        lastError:
          error instanceof Error
            ? error.message.slice(0, 500)
            : "Falha no provedor",
        nextAttemptAt: new Date(Date.now() + 15 * 60_000),
      },
    });
  }
}

async function platformSmtp() {
  const [host, port, encryption, username, password, from] = await Promise.all([
    getVaultSecret(VAULT_KEYS.emailHost),
    getVaultSecret(VAULT_KEYS.emailPort),
    getVaultSecret(VAULT_KEYS.emailEncryption),
    getVaultSecret(VAULT_KEYS.emailUsername),
    getVaultSecret(VAULT_KEYS.emailPassword),
    getVaultSecret(VAULT_KEYS.emailFrom),
  ]);
  if (!host || !port || !encryption || !from) return null;
  return {
    providerId: "smtp",
    credentialId: "platform",
    config: {
      host,
      port: Number(port),
      encryption,
      username: username || "",
      from_email: from,
      from_name: "NALVEN",
      auth: Boolean(username),
    },
    secrets: { password: password || "" },
  };
}

export async function processEmailOutbox(limit = 25) {
  const pending = await controlDb.emailOutbox.findMany({
    where: {
      status: "pending",
      nextAttemptAt: { lte: new Date() },
      attempts: { lt: 10 },
    },
    select: { id: true },
    orderBy: { createdAt: "asc" },
    take: limit,
  });
  let sent = 0;
  for (const item of pending)
    if ((await deliverEmailOutbox(item.id))?.status === "sent") sent++;
  return { processed: pending.length, sent, pending: pending.length - sent };
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
