import { controlDb } from "@/db/control";
import { authErrorResponse, requireUser } from "@/lib/auth";
import { isSiteContentValue } from "@/lib/admin-site-content";
import { enforceControlRateLimit, HttpSecurityError, privateJson, readJsonObject } from "@/lib/http-security";
import type { Prisma } from "@/generated/control/client";

export async function GET() {
  try {
    await requireUser("superadmin");
    const content = await controlDb.siteContent.findMany({ select: { key: true, group: true, label: true, type: true, value: true, public: true, updatedAt: true }, orderBy: [{ group: "asc" }, { sortOrder: "asc" }, { key: "asc" }] });
    return privateJson({ content });
  } catch (error) { return authErrorResponse(error); }
}

export async function POST(request: Request) {
  try {
    const actor = await requireUser("superadmin");
    await enforceControlRateLimit(controlDb, `admin:${actor.id}:site`, 30, 60);
    const body = await readJsonObject(request, 128 * 1024);
    if (typeof body.key !== "string" || body.key.length > 160 || typeof body.public !== "boolean" || typeof body.updatedAt !== "string" || !Number.isFinite(Date.parse(body.updatedAt))) throw new HttpSecurityError("Conteúdo inválido.");
    const item = await controlDb.siteContent.findUnique({ where: { key: body.key }, select: { key: true, type: true } });
    if (!item) throw new HttpSecurityError("Conteúdo não encontrado.", 404);
    if (!isSiteContentValue(item.key, item.type, body.value)) throw new HttpSecurityError("Revise os campos e os limites do conteúdo.");
    await controlDb.$transaction(async tx => {
      const saved = await tx.siteContent.updateMany({ where: { key: item.key, type: item.type, updatedAt: new Date(body.updatedAt as string) }, data: { value: body.value as Prisma.InputJsonValue, public: body.public as boolean } });
      if (saved.count !== 1) throw new HttpSecurityError("Este conteúdo mudou. Recarregue antes de salvar novamente.", 409);
      await tx.auditLog.create({ data: { userId: actor.id, action: "content.save", entityType: "content", entityId: item.key, metadata: { source: "site-manager" } } });
    });
    return privateJson({ ok: true });
  } catch (error) { return authErrorResponse(error); }
}
