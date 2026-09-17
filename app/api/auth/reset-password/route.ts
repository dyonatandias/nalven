import { controlDb } from "@/db/control";
import { resetTokenHash } from "@/lib/auth-recovery";
import { hashPassword } from "@/lib/password";
import { isValidNewPassword, PASSWORD_POLICY_MESSAGE } from "@/lib/password-policy";
import {
  assertTrustedMutation,
  clientAddress,
  enforceControlRateLimit,
  HttpSecurityError,
  httpSecurityErrorResponse,
  privateJson,
  readJsonObject,
  unexpectedErrorResponse,
} from "@/lib/http-security";

export async function POST(request: Request) {
  try {
    assertTrustedMutation(request, { maximumBytes: 8192 });
    const ip = clientAddress(request);
    await enforceControlRateLimit(controlDb, `password-reset:ip:${ip}`, 20, 3600);
    const body = await readJsonObject(request, 8192);
    const token = typeof body.token === "string" ? body.token : "", password = typeof body.password === "string" ? body.password : "";
    if (!/^[A-Za-z0-9_-]{32,256}$/.test(token)) return privateJson({ error: "Link inválido ou expirado." }, { status: 400 });
    await enforceControlRateLimit(controlDb, `password-reset:token:${token}`, 5, 900);
    if (!isValidNewPassword(password)) return privateJson({ error: PASSWORD_POLICY_MESSAGE }, { status: 400 });
    const record = await controlDb.passwordResetToken.findUnique({ where: { tokenHash: resetTokenHash(token) }, include: { user: { select: { email: true, status: true } } } });
    if (!record || record.user.status !== "active" || record.usedAt || record.expiresAt <= new Date()) return privateJson({ error: "Link inválido ou expirado." }, { status: 400 });
    const passwordHash = await hashPassword(password);
    await controlDb.$transaction(async (tx) => {
      // Serialize every recovery for this account, including different tokens.
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`password-reset:${record.userId}`}))`;
      const now = new Date();
      const consumed = await tx.passwordResetToken.updateMany({
        where: { id: record.id, usedAt: null, expiresAt: { gt: now }, user: { status: "active" } },
        data: { usedAt: now },
      });
      if (consumed.count !== 1) throw new HttpSecurityError("Link inválido ou expirado.", 400);
      await tx.user.update({ where: { id: record.userId }, data: { passwordHash } });
      await tx.passwordResetToken.updateMany({ where: { userId: record.userId, usedAt: null }, data: { usedAt: now } });
      await tx.session.deleteMany({ where: { userId: record.userId } });
      await tx.emailOutbox.updateMany({ where: { recipient: record.user.email, template: "password_reset", status: "pending" }, data: { status: "cancelled", lastError: "Senha redefinida; entrega pendente cancelada." } });
      await tx.auditLog.create({ data: { userId: record.userId, action: "auth.password_reset", entityType: "user", entityId: record.userId } });
    });
    return privateJson({ ok: true });
  } catch (error) {
    if (error instanceof HttpSecurityError) return httpSecurityErrorResponse(error);
    return unexpectedErrorResponse("auth.reset-password", error);
  }
}
