import { isPlanCapacityError, PLAN_CAPACITY_MESSAGE } from "@/lib/plan-capacity-error";
import { createHash, randomBytes } from "node:crypto";
import { cookies, headers } from "next/headers";
import { controlDb } from "@/db/control";
import {
  HttpSecurityError,
  httpSecurityErrorResponse,
  privateJson,
  unexpectedErrorResponse,
} from "@/lib/http-security";

const COOKIE_NAME = "nalven_session";
const ORGANIZATION_COOKIE = "nalven_organization";
const SESSION_HOURS = 12;
const REMEMBER_DAYS = 30;

export async function createSession(userId: string, organizationId?: string, remember = false, expectedPasswordHash?: string) {
  const token = randomBytes(32).toString("base64url");
  const requestHeaders = await headers();
  const jar = await cookies();
  const previousToken = jar.get(COOKIE_NAME)?.value;
  const expiresAt = new Date(Date.now() + (remember ? REMEMBER_DAYS * 86400000 : SESSION_HOURS * 3600000));
  await controlDb.$transaction(async tx => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`password-reset:${userId}`}))`;
    const user = await tx.user.findUnique({ where: { id: userId }, select: { status: true, passwordHash: true } });
    if (!user || user.status !== "active" || (expectedPasswordHash && user.passwordHash !== expectedPasswordHash))
      throw new HttpSecurityError("Credenciais inválidas", 401);
    // Rotate the session held by this browser, not sessions on other devices.
    // Keep revocation and creation atomic, including failed reauthentication.
    if (previousToken && /^[A-Za-z0-9_-]{43}$/.test(previousToken))
      await tx.session.deleteMany({ where: { tokenHash: tokenHash(previousToken) } });
    await tx.session.create({ data: {
    userId, tokenHash: tokenHash(token), expiresAt,
    ipAddress: (requestHeaders.get("x-real-ip") || requestHeaders.get("x-forwarded-for")?.split(",")[0]?.trim())?.slice(0, 128) ?? null,
    userAgent: requestHeaders.get("user-agent")?.slice(0, 500) ?? null
    } });
  });
  const options = { httpOnly: true, sameSite: "lax" as const, secure: secureCookies(requestHeaders), priority: "high" as const, path: "/", ...(remember ? { expires: expiresAt } : {}) };
  jar.set(COOKIE_NAME, token, options);
  if (organizationId) jar.set(ORGANIZATION_COOKIE, organizationId, options);
  else jar.set(ORGANIZATION_COOKIE, "", { ...options, expires: new Date(0) });
}

export async function destroySession() {
  const jar = await cookies();
  const requestHeaders = await headers();
  const token = jar.get(COOKIE_NAME)?.value;
  if (token) await controlDb.session.deleteMany({ where: { tokenHash: tokenHash(token) } });
  jar.set(COOKIE_NAME, "", { httpOnly: true, sameSite: "lax", secure: secureCookies(requestHeaders), priority: "high", path: "/", expires: new Date(0) });
  jar.set(ORGANIZATION_COOKIE, "", { httpOnly: true, sameSite: "lax", secure: secureCookies(requestHeaders), priority: "high", path: "/", expires: new Date(0) });
}

export async function currentUser() {
  const token = (await cookies()).get(COOKIE_NAME)?.value;
  if (!token || !/^[A-Za-z0-9_-]{43}$/.test(token)) return null;
  const session = await controlDb.session.findUnique({
    where: { tokenHash: tokenHash(token) },
    include: { user: { include: { memberships: { include: { organization: true } } } } }
  });
  if (!session || session.expiresAt <= new Date() || session.user.status !== "active") return null;
  return session.user;
}

export async function currentMembership(userValue?: NonNullable<Awaited<ReturnType<typeof currentUser>>>) {
  const user = userValue || await currentUser();
  if (!user) return null;
  const selected = (await cookies()).get(ORGANIZATION_COOKIE)?.value;
  return user.memberships.find(item => item.status === "active" && item.organizationId === selected) || user.memberships.find(item => item.status === "active") || null;
}

export async function setActiveOrganization(organizationId: string) {
  const requestHeaders = await headers();
  const jar = await cookies();
  jar.set(ORGANIZATION_COOKIE, organizationId, { httpOnly: true, sameSite: "lax", secure: secureCookies(requestHeaders), priority: "high", path: "/" });
}

export async function requireUser(role?: "superadmin") {
  const user = await currentUser();
  if (!user || (role && user.role !== role)) throw new AuthError(role ? 403 : 401);
  return user;
}

export class AuthError extends Error {
  constructor(public status: 401 | 403) { super(status === 401 ? "Não autenticado" : "Acesso negado"); }
}

export function authErrorResponse(error: unknown) {
  if (isPlanCapacityError(error)) return privateJson({ error: PLAN_CAPACITY_MESSAGE }, { status: 409 });
  if (error instanceof AuthError) return privateJson({ error: error.message }, { status: error.status });
  if (error instanceof HttpSecurityError) return httpSecurityErrorResponse(error);
  return unexpectedErrorResponse("authenticated-api", error);
}

function tokenHash(token: string) { return createHash("sha256").update(token).digest("hex"); }
function secureCookies(requestHeaders: Headers) { return process.env.NODE_ENV === "production" || requestHeaders.get("x-forwarded-proto") === "https"; }
