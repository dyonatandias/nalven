import { controlDb } from "@/db/control";
import { authErrorResponse, requireUser } from "@/lib/auth";
import { deliverEmailOutbox } from "@/lib/auth-recovery";
import { assertSameOrigin } from "@/lib/erp/customer-input";
import { setVaultSecret, vaultMetadata, VAULT_KEYS } from "@/lib/vault";
import { enforceControlRateLimit, privateJson, readJsonObject } from "@/lib/http-security";

export async function GET() {
  try {
    await requireUser("superadmin");
    const [vault, recent, pending] = await Promise.all([
      vaultMetadata("email"),
      controlDb.emailOutbox.findMany({
        select: {
          id: true,
          recipient: true,
          template: true,
          status: true,
          attempts: true,
          lastError: true,
          sentAt: true,
          createdAt: true,
        },
        orderBy: { createdAt: "desc" },
        take: 20,
      }),
      controlDb.emailOutbox.count({ where: { status: "pending" } }),
    ]);
    const keys = new Set(vault.map((item) => item.key));
    return privateJson({
      configured: [
        VAULT_KEYS.emailHost,
        VAULT_KEYS.emailPort,
        VAULT_KEYS.emailEncryption,
        VAULT_KEYS.emailFrom,
      ].every((key) => keys.has(key)),
      vault,
      recent,
      summary: { pending },
    });
  } catch (error) {
    return authErrorResponse(error);
  }
}
export async function POST(request: Request) {
  try {
    assertSameOrigin(request);
    const actor = await requireUser("superadmin");
    await enforceControlRateLimit(controlDb, `admin:${actor.id}:email`, 20, 60);
    const body = await readJsonObject(request, 32_768);
    if (body.action === "save") {
      if (["host", "encryption", "from"].some(key => typeof body[key] !== "string") ||
          ["username", "password"].some(key => body[key] !== undefined && typeof body[key] !== "string") ||
          !(typeof body.port === "number" || (typeof body.port === "string" && /^\d{1,5}$/.test(body.port)))) {
        return privateJson({ error: "Informe os campos SMTP nos formatos esperados." }, { status: 400 });
      }
      const host = (body.host as string).trim(),
        port = Number(body.port),
        encryption = (body.encryption as string).trim(),
        username = ((body.username as string | undefined) || "").trim(),
        password = (body.password as string | undefined) || "",
        from = (body.from as string).trim();
      if (username.length > 320 || password.length > 4096 || from.length > 254 || /[\r\n\0]/.test(username + password + from)) {
        return privateJson({ error: "Credenciais ou remetente SMTP inválidos." }, { status: 400 });
      }
      if (!/^[a-z0-9.-]+$/i.test(host) || host.length > 253)
        return privateJson(
          { error: "Informe um host SMTP válido." },
          { status: 400 },
        );
      if (!Number.isInteger(port) || port < 1 || port > 65535)
        return privateJson(
          { error: "Informe uma porta SMTP válida." },
          { status: 400 },
        );
      if (!["tls", "ssl", "none"].includes(encryption))
        return privateJson(
          { error: "Selecione a criptografia SMTP." },
          { status: 400 },
        );
      if (!/^\S+@\S+\.\S+$/.test(from))
        return privateJson(
          { error: "Informe um e-mail remetente válido." },
          { status: 400 },
        );
      await controlDb.$transaction(async tx => {
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(73890127)`;
        for (const [key, value] of [
          [VAULT_KEYS.emailHost, host],
          [VAULT_KEYS.emailPort, String(port)],
          [VAULT_KEYS.emailEncryption, encryption],
          [VAULT_KEYS.emailFrom, from],
          ...(username ? [[VAULT_KEYS.emailUsername, username]] : []),
          ...(password ? [[VAULT_KEYS.emailPassword, password]] : []),
        ]) await setVaultSecret(key, value, "email", actor.id, tx);
        await tx.auditLog.create({
          data: {
            userId: actor.id,
            action: "email.smtp_configured",
            entityType: "vault",
            metadata: {
              provider: "smtp",
              passwordChanged: Boolean(password),
              usernameChanged: Boolean(username),
            },
          },
        });
      });
      return privateJson({ ok: true });
    }
    if (body.action === "test") {
      const message = await controlDb.emailOutbox.create({
        data: {
          recipient: actor.email,
          template: "provider_test",
          subject: "Teste de e-mail NALVEN",
          textBody: "O SMTP transacional da NALVEN está funcionando.",
          htmlBody:
            "<p>O SMTP transacional da <strong>NALVEN</strong> está funcionando.</p>",
        },
      });
      const delivered = await deliverEmailOutbox(message.id);
      if (delivered?.status !== "sent")
        return privateJson(
          { error: delivered?.lastError || "Configure o SMTP antes do teste." },
          { status: 422 },
        );
      return privateJson({ ok: true });
    }
    if (body.action === "retry") {
      const pending = await controlDb.emailOutbox.findMany({
        where: { status: "pending", nextAttemptAt: { lte: new Date() } },
        select: { id: true },
        take: 25,
      });
      let sent = 0;
      for (const item of pending)
        if ((await deliverEmailOutbox(item.id))?.status === "sent") sent++;
      return privateJson({ ok: true, processed: pending.length, sent });
    }
    return privateJson({ error: "Ação inválida." }, { status: 400 });
  } catch (error) {
    return authErrorResponse(error);
  }
}
