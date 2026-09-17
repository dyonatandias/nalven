import { controlDb } from "@/db/control";
import { createPasswordReset } from "@/lib/auth-recovery";
import {
  assertTrustedMutation,
  clientAddress,
  enforceControlRateLimit,
  HttpSecurityError,
  httpSecurityErrorResponse,
  privateJson,
  readJsonObject,
} from "@/lib/http-security";

const MESSAGE = "Se o e-mail estiver cadastrado, você receberá as instruções para redefinir a senha.";

export async function POST(request: Request) {
  try {
    assertTrustedMutation(request, { maximumBytes: 4096 });
    const ip = clientAddress(request);
    await enforceControlRateLimit(controlDb, `password-forgot:ip:${ip}`, 10, 3600);
    const body = await readJsonObject(request, 4096);
    const email = typeof body.email === "string" ? body.email.trim().toLowerCase() : "";
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 254) return privateJson({ message: MESSAGE });
    await enforceControlRateLimit(controlDb, `password-forgot:account:${email}`, 3, 900);
    const user = await controlDb.user.findUnique({ where: { email } });
    if (user?.status === "active") await createPasswordReset(user, ip);
    return privateJson({ message: MESSAGE });
  } catch (error) {
    if (error instanceof HttpSecurityError && error.status !== 429) return httpSecurityErrorResponse(error);
    return privateJson(
      { message: MESSAGE },
      error instanceof HttpSecurityError && error.status === 429
        ? { status: 429, headers: error.retryAfter ? { "retry-after": String(error.retryAfter) } : undefined }
        : undefined,
    );
  }
}
