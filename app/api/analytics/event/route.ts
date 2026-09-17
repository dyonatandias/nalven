import { createHash } from "node:crypto";
import { cookies, headers } from "next/headers";
import { controlDb } from "@/db/control";
import { currentUser } from "@/lib/auth";
import { classifyPage, localDate, normalizeDevice, normalizePath, referrerSource, shouldTrackPath } from "@/lib/analytics/core";
import { analyticsSettings, incrementFunnelStep } from "@/lib/analytics/service";
import { assertTrustedMutation, clientAddress, enforceControlRateLimit, HttpSecurityError, httpSecurityErrorResponse, privateJson, readJsonObject, unexpectedErrorResponse } from "@/lib/http-security";

type EventBody = {
  session_hash?: unknown;
  visitor_hash?: unknown;
  page_path?: unknown;
  referrer?: unknown;
  device_type?: unknown;
  is_heartbeat?: unknown;
  action?: unknown;
};

const BOT_PATTERN = /bot|crawl|spider|slurp|bingpreview|facebookexternalhit|headless|lighthouse|uptime|monitor/i;
const ACTIONS = new Set(["signup_cta"]);

export async function GET() {
  try {
    const settings = await analyticsSettings();
    return privateJson({ enabled: settings.enabled, heartbeatIntervalSeconds: settings.heartbeatIntervalSeconds });
  } catch (error) { return unexpectedErrorResponse("analytics.configuration", error); }
}

export async function POST(request: Request) {
  try {
    assertTrustedMutation(request, { maximumBytes: 16_384 });
    await enforceControlRateLimit(controlDb, `analytics:ip:${clientAddress(request)}`, 240, 60);
    const settings = await analyticsSettings();
    if (!settings.enabled) return privateJson({ ok: true, skipped: "disabled" });
    const requestHeaders = await headers();
    const userAgent = requestHeaders.get("user-agent");
    if (!userAgent || BOT_PATTERN.test(userAgent)) return privateJson({ ok: true, skipped: "bot" });
    if (!settings.trackAdmins && (await cookies()).has("nalven_session")) {
      const user = await currentUser();
      if (user?.role === "superadmin") return privateJson({ ok: true, skipped: "admin" });
    }
    const body = await readJsonObject(request, 16_384) as EventBody;
    const sessionHash = cleanIdentifier(body.session_hash);
    if (!sessionHash) return privateJson({ error: "Identificador de sessão inválido." }, { status: 400 });
    const path = normalizePath(String(body.page_path || "/"));
    if (!shouldTrackPath(path)) return privateJson({ ok: true, skipped: "private_route" });
    const pageType = classifyPage(path);
    const deviceType = normalizeDevice(body.device_type);
    const heartbeat = body.is_heartbeat === true;
    const action = ACTIONS.has(String(body.action || "")) ? String(body.action) : null;
    const ip = clientIp(requestHeaders);
    const ipHash = createHash("sha256").update(`${ip}:${analyticsSalt()}`).digest("hex");
    const sentVisitor = cleanIdentifier(body.visitor_hash);
    const visitorHash = sentVisitor || createHash("sha256").update(`${ipHash}:${localDate(new Date(), settings.timezone)}`).digest("hex");
    if (!heartbeat) {
      const recent = await controlDb.analyticsEvent.count({ where: { ipHash, createdAt: { gte: new Date(Date.now() - 3600_000) } } });
      if (recent >= 120) return privateJson({ ok: true, skipped: "rate_limited" }, { status: action ? 200 : 429 });
    }
    const now = new Date();
    await controlDb.$transaction(async (tx) => {
      await tx.analyticsSession.upsert({
        where: { sessionHash },
        update: { visitorHash, ipHash, pageType, pagePath: path, deviceType, lastSeenAt: now },
        create: { sessionHash, visitorHash, ipHash, pageType, pagePath: path, deviceType, sessionStartedAt: now, lastSeenAt: now },
      });
      if (!heartbeat) {
        await tx.analyticsEvent.create({ data: {
          sessionHash, visitorHash, ipHash, eventKind: action ? "action" : "page_view", action,
          pageType, pagePath: path, referrerSource: referrerSource(body.referrer, requestHeaders.get("host")), deviceType, createdAt: now,
        } });
        const step = action === "signup_cta" ? "signup_cta" : pageType === "home" ? "landing_view" : pageType === "signup" ? "signup_started" : null;
        if (step) await incrementFunnelStep(step, now, tx, settings.timezone);
      }
    });
    return privateJson({ ok: true, heartbeatIntervalSeconds: settings.heartbeatIntervalSeconds });
  } catch (error) {
    if (error instanceof HttpSecurityError) return httpSecurityErrorResponse(error);
    console.error("analytics-event", { error: error instanceof Error ? error.name : typeof error });
    return privateJson({ error: "Evento inválido." }, { status: 400 });
  }
}

function cleanIdentifier(value: unknown) {
  if (typeof value !== "string") return null;
  const normalized = value.trim();
  return normalized && normalized.length <= 64 && /^[a-zA-Z0-9_-]+$/.test(normalized) ? normalized : null;
}
function clientIp(value: Awaited<ReturnType<typeof headers>>) {
  return value.get("x-real-ip") || value.get("x-forwarded-for")?.split(",")[0]?.trim() || "unknown";
}
function analyticsSalt() {
  const salt = process.env.ANALYTICS_IP_SALT;
  if (salt) return salt;
  if (process.env.NODE_ENV === "production") throw new Error("ANALYTICS_IP_SALT não foi configurado.");
  return "nalven-local-analytics-salt";
}
