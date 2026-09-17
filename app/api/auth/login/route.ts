import { controlDb } from "@/db/control";
import { createHash } from "node:crypto";
import { createSession } from "@/lib/auth";
import { DUMMY_PASSWORD_HASH, verifyPassword } from "@/lib/password";
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
    assertTrustedMutation(request, { maximumBytes: 16_384 });
    const ip = clientAddress(request);
    await enforceControlRateLimit(controlDb, `login:ip:${ip}`, 30, 900);
    const body = await readJsonObject(request, 16_384);
    const email = typeof body.email === "string" ? body.email.trim().toLowerCase() : "";
    const password = typeof body.password === "string" ? body.password : "";
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 254 || !password || password.length > 256)
      return privateJson({ error: "Informe e-mail e senha" }, { status: 400 });
    await enforceControlRateLimit(controlDb, `login:account:${ip}:${email}`, 8, 900);
    await enforceControlRateLimit(controlDb, `login:account-global:${email}`, 50, 900);
    const user = await controlDb.user.findUnique({ where: { email }, include: { memberships: { where: { status: "active" }, orderBy: { createdAt: "asc" }, take: 1 } } });
    const passwordValid = await verifyPassword(password, user?.passwordHash || DUMMY_PASSWORD_HASH);
    if (!user || user.status !== "active" || !passwordValid) {
      await controlDb.auditLog.create({ data: { action: "auth.login_failed", entityType: "user", entityId: user?.id, ipAddress: ip, metadata: { emailHash: accountHash(email) } } });
      return privateJson({ error: "Credenciais inválidas" }, { status: 401 });
    }
    await createSession(user.id, user.memberships[0]?.organizationId, body.remember === true, user.passwordHash);
    await controlDb.$transaction([
      controlDb.user.update({ where: { id: user.id }, data: { lastLoginAt: new Date() } }),
      controlDb.auditLog.create({ data: { userId: user.id, action: "auth.login", entityType: "user", entityId: user.id, ipAddress: ip } })
    ]);
    return privateJson({ user: { id: user.id, name: user.name, email: user.email, role: user.role } });
  } catch (error) {
    if (error instanceof HttpSecurityError) return httpSecurityErrorResponse(error);
    return unexpectedErrorResponse("auth.login", error);
  }
}

function accountHash(value: string) {
  return createHash("sha256").update(value).digest("hex");
}
