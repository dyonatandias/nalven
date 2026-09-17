import { controlDb } from "@/db/control";
import { authErrorResponse, requireUser } from "@/lib/auth";
import { canAssignPlan, publicPlanWhere } from "@/lib/admin-plan-policy";
import { enforceControlRateLimit, HttpSecurityError, privateJson, readJsonObject } from "@/lib/http-security";
import type { Prisma } from "@/generated/control/client";

type Context = { params: Promise<{ id: string }> };
export async function GET(_request: Request, context: Context) {
  try {
    await requireUser("superadmin");
    const { id } = await context.params;
    const organization = await controlDb.organization.findUnique({ where: { id }, select: { id: true, planId: true, updatedAt: true, _count: { select: { memberships: { where: { status: "active" } } } } } });
    if (!organization) throw new HttpSecurityError("Organização não encontrada.", 404);
    const plans = await controlDb.plan.findMany({ where: { OR: [publicPlanWhere, { active: true, visibility: "private", ownerOrganizationId: id }] }, select: { id: true, name: true, seats: true, visibility: true }, orderBy: [{ name: "asc" }, { id: "asc" }] });
    return privateJson({ organization: { id: organization.id, planId: organization.planId, updatedAt: organization.updatedAt, activeUsers: organization._count.memberships }, plans });
  } catch (error) { return authErrorResponse(error); }
}

export async function POST(request: Request, context: Context) {
  try {
    const actor = await requireUser("superadmin");
    await enforceControlRateLimit(controlDb, `admin:${actor.id}:organization-plan`, 20, 60);
    const { id } = await context.params;
    const body = await readJsonObject(request, 4096);
    if (!id || id.length > 150 || typeof body.planId !== "string" || !body.planId || body.planId.length > 150 || typeof body.updatedAt !== "string" || !Number.isFinite(Date.parse(body.updatedAt)) || body.confirm !== true) throw new HttpSecurityError("Selecione o plano e confirme a alteração de recursos.");
    if (Object.keys(body).some(key => !["planId", "updatedAt", "confirm"].includes(key))) throw new HttpSecurityError("A atribuição não altera situação financeira, preços ou módulos avulsos.");
    await controlDb.$transaction(async tx => {
      // Use the catalogue lock so changes to plan policy cannot race this assignment.
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(73890122)`;
      const plan = await tx.plan.findUnique({ where: { id: body.planId as string } });
      if (!plan || !canAssignPlan(plan, id)) throw new HttpSecurityError("Plano indisponível para esta organização.", 409);
      const before = await tx.organization.findUnique({ where: { id }, select: { planId: true } });
      if (!before) throw new HttpSecurityError("Organização não encontrada.", 404);
      const saved = await tx.organization.updateMany({ where: { id, updatedAt: new Date(body.updatedAt as string) }, data: { planId: plan.id, modules: plan.modules as Prisma.InputJsonValue } });
      if (saved.count !== 1) throw new HttpSecurityError("A organização mudou. Recarregue os planos antes de confirmar.", 409);
      await tx.auditLog.create({ data: { userId: actor.id, action: "organization.plan_changed", entityType: "organization", entityId: id, metadata: { previousPlanId: before.planId, planId: plan.id, source: "organization-plan", externalBillingChanged: false } } });
    });
    return privateJson({ ok: true });
  } catch (error) { return authErrorResponse(error); }
}
