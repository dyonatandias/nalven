import { requireUser, authErrorResponse } from "@/lib/auth";
import { loadAnalyticsDashboard, loadAnalyticsRealtime, saveAnalyticsSettings } from "@/lib/analytics/service";
import { controlDb } from "@/db/control";
import { enforceControlRateLimit, privateJson, readJsonObject } from "@/lib/http-security";

export async function GET(request: Request) {
  try {
    await requireUser("superadmin");
    const search = new URL(request.url).searchParams;
    if (search.get("view") === "realtime") return privateJson({ realtime: await loadAnalyticsRealtime(), generatedAt: new Date().toISOString() });
    return privateJson(await loadAnalyticsDashboard(search.get("period")));
  } catch (error) { return authErrorResponse(error); }
}

export async function PUT(request: Request) {
  try {
    const user = await requireUser("superadmin");
    await enforceControlRateLimit(controlDb, `admin:${user.id}:analytics`, 30, 60);
    const body = await readJsonObject(request, 16_384);
    const settings = await saveAnalyticsSettings({
      enabled: body.enabled === true,
      trackAdmins: body.trackAdmins === true,
      rawRetentionDays: Number(body.rawRetentionDays),
      dailyRetentionDays: Number(body.dailyRetentionDays),
      heartbeatIntervalSeconds: Number(body.heartbeatIntervalSeconds),
      timezone: String(body.timezone || ""),
    });
    await controlDb.auditLog.create({ data: { userId: user.id, action: "analytics.settings.update", entityType: "analytics_settings", entityId: "1", metadata: settings } });
    return privateJson({ settings });
  } catch (error) { return authErrorResponse(error); }
}
