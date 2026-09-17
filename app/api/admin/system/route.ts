import { freemem, loadavg, totalmem, uptime } from "node:os";
import { controlDb } from "@/db/control";
import { authErrorResponse, requireUser } from "@/lib/auth";
import { privateJson } from "@/lib/http-security";

export async function GET() {
  try {
    await requireUser("superadmin");
    const [organizations, users, sessions, databases, backups, jobs, integrations] = await Promise.all([
      controlDb.organization.groupBy({ by: ["status"], _count: true }),
      controlDb.user.count(), controlDb.session.count({ where: { expiresAt: { gt: new Date() } } }),
      controlDb.tenantDatabase.count({ where: { status: "active" } }),
      controlDb.backupRun.findMany({ orderBy: { startedAt: "desc" }, take: 20 }),
      controlDb.provisioningJob.groupBy({ by: ["status"], _count: true }),
      controlDb.integration.groupBy({ by: ["status"], _count: true })
    ]);
    return privateJson({ host: { uptimeSeconds: uptime(), totalMemory: totalmem(), freeMemory: freemem(), loadAverage: loadavg(), node: process.version }, organizations, users, sessions, databases, backups: backups.map((item) => ({ ...item, sizeBytes: item.sizeBytes?.toString() ?? null })), jobs, integrations });
  } catch (error) { return authErrorResponse(error); }
}
