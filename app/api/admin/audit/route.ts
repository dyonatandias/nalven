import { controlDb } from "@/db/control";
import { authErrorResponse, requireUser } from "@/lib/auth";
import { privateJson } from "@/lib/http-security";
import type { Prisma } from "@/generated/control/client";

export async function GET(request: Request) {
  try {
    await requireUser("superadmin");
    const params = new URL(request.url).searchParams;
    const page = Math.min(10000, Math.max(1, Number.parseInt(params.get("page") || "1", 10) || 1));
    const query = (params.get("q") || "").trim().slice(0, 160);
    const entityType = (params.get("entityType") || "").trim().slice(0, 80);
    const organizationId = params.get("organizationId");
    if (organizationId !== null && (!organizationId.trim() || organizationId.length > 160)) return privateJson({ error: "Organização inválida." }, { status: 400 });
    const from = params.get("from") || "", to = params.get("to") || "";
    const validDate = (value: string) => /^\d{4}-\d{2}-\d{2}$/.test(value) && Number.isFinite(Date.parse(value)) && new Date(value).toISOString().slice(0, 10) === value;
    if ((from && !validDate(from)) || (to && !validDate(to)) || (from && to && from > to)) return privateJson({ error: "Informe um intervalo de datas válido." }, { status: 400 });
    if (organizationId && !await controlDb.organization.findUnique({ where: { id: organizationId }, select: { id: true } })) return privateJson({ error: "Organização não encontrada." }, { status: 404 });
    const where: Prisma.AuditLogWhereInput = {
      ...(organizationId ? { AND: [{ OR: [{ entityType: "organization", entityId: organizationId }, { entityType: "billing", metadata: { path: ["organizationId"], equals: organizationId } }] }] } : {}),
      ...(from || to ? { createdAt: { ...(from ? { gte: new Date(`${from}T00:00:00.000Z`) } : {}), ...(to ? { lt: new Date(Date.parse(`${to}T00:00:00.000Z`) + 86400000) } : {}) } } : {}),
      ...(entityType ? { entityType } : {}),
      ...(query ? { OR: [{ action: { contains: query, mode: "insensitive" } }, { entityId: { contains: query, mode: "insensitive" } }, { user: { name: { contains: query, mode: "insensitive" } } }] } : {}),
    };
    const [logs, total] = await controlDb.$transaction([
      controlDb.auditLog.findMany({ where, select: { id: true, action: true, entityType: true, entityId: true, createdAt: true, user: { select: { name: true } } }, orderBy: [{ createdAt: "desc" }, { id: "desc" }], take: 50, skip: (page - 1) * 50 }),
      controlDb.auditLog.count({ where }),
    ]);
    return privateJson({ logs, total, page, pageSize: 50 });
  } catch (error) { return authErrorResponse(error); }
}
