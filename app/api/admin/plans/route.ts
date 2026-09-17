import { controlDb } from "@/db/control";
import { requireUser, authErrorResponse } from "@/lib/auth";
import { enforceControlRateLimit, HttpSecurityError, privateJson, readJsonObject } from "@/lib/http-security";
import { parsePlanInput } from "@/lib/admin-plan-input";

export async function GET() {
  try {
    await requireUser("superadmin");
    const [plans, organizations] = await Promise.all([
      controlDb.plan.findMany({ orderBy: [{ visibility: "asc" }, { monthlyPrice: "asc" }], include: { _count: { select: { organizations: true } } } }),
      controlDb.organization.findMany({ select: { id: true, name: true }, orderBy: { name: "asc" } }),
    ]);
    return privateJson({ plans, organizations });
  } catch (error) { return authErrorResponse(error); }
}

export async function POST(request: Request) {
  try {
    const actor = await requireUser("superadmin");
    await enforceControlRateLimit(controlDb, `admin:${actor.id}:plans`, 30, 60);
    const body = await readJsonObject(request, 32_768);
    const { id, ...data } = parsePlanInput(body);
    const plan = await controlDb.$transaction(async tx => {
      // Serialize catalogue changes and the public-plan limit across administrators.
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(73890122)`;
      const existing = await tx.plan.findUnique({ where: { id } });
      if (existing && body.updatedAt !== existing.updatedAt.toISOString()) throw new HttpSecurityError("O plano foi alterado por outro administrador. Atualize antes de salvar.", 409);
      if (!existing && body.updatedAt) throw new HttpSecurityError("Plano não encontrado.", 404);
      if (data.visibility === "public" && (!existing || existing.visibility !== "public") && await tx.plan.count({ where: { visibility: "public" } }) >= 3) throw new HttpSecurityError("O catálogo já possui três planos públicos. Crie um plano exclusivo para o cliente.");
      if (data.ownerOrganizationId && !await tx.organization.findUnique({ where: { id: data.ownerOrganizationId }, select: { id: true } })) throw new HttpSecurityError("Organização não encontrada.", 404);
      if (data.visibility === "private" && await tx.organization.count({ where: { planId: id, id: { not: data.ownerOrganizationId! } } })) throw new HttpSecurityError("Este plano já pertence a outros clientes. Crie um plano exclusivo separado.", 409);
      const saved = await tx.plan.upsert({ where: { id }, create: { id, ...data }, update: data });
      await tx.organization.updateMany({ where: { planId: id }, data: { modules: data.modules } });
      await tx.auditLog.create({ data: { userId: actor.id, action: existing ? "plan.save" : "plan.create", entityType: "plan", entityId: id, metadata: { visibility: data.visibility, ownerOrganizationId: data.ownerOrganizationId, source: "plan-manager" } } });
      return saved;
    });
    return privateJson({ ok: true, plan });
  } catch (error) { return authErrorResponse(error); }
}
