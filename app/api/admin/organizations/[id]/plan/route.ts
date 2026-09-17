import { randomUUID } from "node:crypto";
import { controlDb } from "@/db/control";
import { authErrorResponse, requireUser } from "@/lib/auth";
import { canAssignPlan, publicPlanWhere } from "@/lib/admin-plan-policy";
import { enforceControlRateLimit, HttpSecurityError, privateJson, readJsonObject } from "@/lib/http-security";
import type { Prisma } from "@/generated/control/client";
import { billingClient, BillingError } from "@/lib/billing/client";

type Context = { params: Promise<{ id: string }> };
export async function GET(_request: Request, context: Context) {
  try {
    await requireUser("superadmin");
    const { id } = await context.params;
    const organization = await controlDb.organization.findUnique({ where: { id }, select: { id: true, planId: true, updatedAt: true, _count: { select: { memberships: { where: { status: "active" } } } } } });
    if (!organization) throw new HttpSecurityError("Organização não encontrada.", 404);
    const plans = await controlDb.plan.findMany({ where: publicPlanWhere, select: { id: true, name: true, seats: true, code: true }, orderBy: [{ name: "asc" }, { id: "asc" }] });
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
    const plan = await controlDb.plan.findUnique({ where: { id: body.planId as string } });
    if (!plan || !plan.code || !canAssignPlan(plan)) throw new HttpSecurityError("Plano indisponível para esta organização.", 409);
    const before = await controlDb.organization.findUnique({ where: { id }, select: { planId: true, updatedAt: true } });
    if (!before) throw new HttpSecurityError("Organização não encontrada.", 404);
    if (before.updatedAt.toISOString() !== body.updatedAt) throw new HttpSecurityError("A organização mudou. Recarregue os planos antes de confirmar.", 409);
    // Confirm the change with Billing before touching local state — NALVEN and Billing must never disagree silently about which plan is active.
    const account = await controlDb.billingAccount.findUnique({ where: { organizationId: id }, select: { externalId: true, paymentMethod: true, modules: true } });
    if (!account) throw new HttpSecurityError("Esta organização ainda não possui vínculo com o Billing. Regularize o provisionamento antes de trocar o plano.", 409);
    try {
      await billingClient.updateSubscription(account.externalId, { plano_codigo: plan.code, forma_pagamento: account.paymentMethod || "pix", modulos: Array.isArray(account.modules) ? account.modules : [] }, randomUUID());
    } catch (error) {
      if (error instanceof BillingError && (error.status === 404 || error.status === 409)) throw new HttpSecurityError("O Billing recusou este plano para esta organização. Verifique o vínculo/plano no painel do Billing antes de tentar novamente.", error.status);
      throw error;
    }
    await controlDb.$transaction(async tx => {
      const saved = await tx.organization.updateMany({ where: { id, updatedAt: new Date(body.updatedAt as string) }, data: { planId: plan.id, modules: plan.modules as Prisma.InputJsonValue } });
      if (saved.count !== 1) throw new HttpSecurityError("A organização mudou. Recarregue os planos antes de confirmar.", 409);
      await tx.billingAccount.update({ where: { organizationId: id }, data: { planCode: plan.code!, lastSyncedAt: new Date() } });
      await tx.auditLog.create({ data: { userId: actor.id, action: "organization.plan_changed", entityType: "organization", entityId: id, metadata: { previousPlanId: before.planId, planId: plan.id, source: "organization-plan", externalBillingChanged: true } } });
    });
    return privateJson({ ok: true });
  } catch (error) {
    if (error instanceof BillingError) return privateJson({ error: error.message, requestId: error.requestId }, { status: error.status });
    return authErrorResponse(error);
  }
}
