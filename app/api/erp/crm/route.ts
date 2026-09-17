import { randomUUID } from "node:crypto";
import { Prisma } from "@/generated/tenant/client";
import { currentOrganization, tenantDb } from "@/db";
import { AuthError, authErrorResponse } from "@/lib/auth";
import { LicenseDeniedError } from "@/lib/billing/license";
import { assertSameOrigin, CustomerInputError } from "@/lib/erp/customer-input";
import { activityInput, crmId, crmStage, CrmInputError, opportunityInput } from "@/lib/erp/crm-input";
import { assertTenantPermission } from "@/lib/erp/permissions";
import { readPosJson } from "@/lib/erp/pos-http";
import { assertTenantWriteAccess } from "@/lib/tenant-access";

export const dynamic = "force-dynamic";
const NO_STORE = { "cache-control": "no-store" };
const stages = ["lead", "qualified", "proposal", "negotiation", "won", "lost"];
const include = { customer: { select: { id: true, name: true, tradeName: true } }, activities: { orderBy: { createdAt: "desc" as const }, take: 30 }, history: { orderBy: { createdAt: "asc" as const }, take: 50 } };

export async function GET(request: Request) {
  try {
    const organization = await currentOrganization();
    await assertTenantPermission(organization.id, "crm.read");
    const db = await tenantDb(organization.id), parameters = new URL(request.url).searchParams;
    const page = positive(parameters.get("page"), 1, 10_000), limit = positive(parameters.get("limit"), 250, 250), search = (parameters.get("search") || "").trim().slice(0, 100);
    const stage = stages.includes(parameters.get("stage") || "") ? parameters.get("stage")! : "", status = ["open", "won", "lost"].includes(parameters.get("status") || "") ? parameters.get("status")! : "";
    const where: Prisma.CrmOpportunityWhereInput = { ...(stage ? { stage } : {}), ...(status ? { status } : {}), ...(search ? { OR: [{ title: { contains: search, mode: "insensitive" } }, { company: { contains: search, mode: "insensitive" } }, { contactName: { contains: search, mode: "insensitive" } }, { owner: { contains: search, mode: "insensitive" } }] } : {}) };
    const [items, total, customers, openValues, overdue, byStage, wonValue, lostCount] = await Promise.all([
      db.crmOpportunity.findMany({ where, include, orderBy: { updatedAt: "desc" }, skip: (page - 1) * limit, take: limit }), db.crmOpportunity.count({ where }),
      db.customer.findMany({ where: { status: "active" }, select: { id: true, name: true, tradeName: true }, orderBy: { name: "asc" }, take: 1000 }),
      db.crmOpportunity.findMany({ where: { status: "open" }, select: { value: true, probability: true } }),
      db.crmActivity.count({ where: { completedAt: null, dueAt: { lt: new Date() }, opportunity: { status: "open" } } }),
      db.crmOpportunity.groupBy({ by: ["stage"], _count: { _all: true }, _sum: { value: true } }),
      db.crmOpportunity.aggregate({ where: { status: "won" }, _sum: { value: true } }), db.crmOpportunity.count({ where: { status: "lost" } }),
    ]);
    return Response.json({ items, customers, stages, byStage, pagination: { page, limit, total, pages: Math.max(1, Math.ceil(total / limit)) }, summary: { open: openValues.length, pipeline: openValues.reduce((sum, item) => sum + item.value, 0), weighted: openValues.reduce((sum, item) => sum + item.value * item.probability / 100, 0), overdue, wonValue: wonValue._sum.value || 0, lost: lostCount } }, { headers: NO_STORE });
  } catch (error) { return failure(error); }
}

export async function POST(request: Request) {
  try {
    assertSameOrigin(request);
    const organization = await currentOrganization(), access = await assertTenantPermission(organization.id, "crm.write");
    await assertTenantWriteAccess(organization.id);
    const db = await tenantDb(organization.id), body = await readPosJson(request, 200_000) as Record<string, unknown>, correlationId = randomUUID();
    if (body.action === "create") {
      const input = opportunityInput(body);
      if (input.customerId && !await db.customer.findFirst({ where: { id: input.customerId, status: "active" }, select: { id: true } })) throw new CrmInputError("Cliente ativo não encontrado.");
      const opportunity = await db.$transaction(async (tx) => {
        const created = await tx.crmOpportunity.create({ data: { ...input, owner: access.user.name, history: { create: { toStage: "lead", actor: access.user.name } } }, include });
        await tx.tenantAuditEvent.create({ data: { actorId: access.user.id, action: "crm_opportunity.created", entityType: "crm_opportunity", entityId: String(created.id), correlationId, afterData: { title: created.title, value: created.value, stage: created.stage } } });
        return created;
      }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
      return Response.json({ opportunity, correlationId }, { status: 201, headers: NO_STORE });
    }
    const id = crmId(body.opportunityId), before = await db.crmOpportunity.findUnique({ where: { id }, include });
    if (!before) return Response.json({ error: "Oportunidade não encontrada." }, { status: 404, headers: NO_STORE });
    if (body.action === "move") {
      if (before.status !== "open") throw new CrmInputError("Oportunidade encerrada não pode mudar de etapa.");
      const stage = crmStage(body.stage), status = stage === "won" ? "won" : stage === "lost" ? "lost" : "open", lostReason = stage === "lost" ? String(body.lostReason || "Não informado").trim().slice(0, 500) : null;
      const opportunity = await db.$transaction(async (tx) => {
        await tx.$queryRaw`SELECT id FROM crm_opportunities WHERE id = ${id} FOR UPDATE`;
        const changed = await tx.crmOpportunity.updateMany({ where: { id, status: "open", stage: before.stage }, data: { stage, status, lostReason, probability: stage === "won" ? 100 : stage === "lost" ? 0 : before.probability } });
        if (changed.count !== 1) throw new CrmInputError("A oportunidade foi alterada por outro usuário. Atualize a página.");
        await tx.crmStageHistory.create({ data: { opportunityId: id, fromStage: before.stage, toStage: stage, actor: access.user.name } });
        await tx.tenantAuditEvent.create({ data: { actorId: access.user.id, action: `crm_opportunity.${stage}`, entityType: "crm_opportunity", entityId: String(id), correlationId, beforeData: { stage: before.stage, status: before.status }, afterData: { stage, status, lostReason } } });
        return tx.crmOpportunity.findUniqueOrThrow({ where: { id }, include });
      }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
      return Response.json({ opportunity, correlationId }, { headers: NO_STORE });
    }
    if (body.action === "activity") {
      if (before.status !== "open") throw new CrmInputError("Atividades só podem ser incluídas em oportunidades abertas.");
      const input = activityInput(body);
      const activity = await db.$transaction(async (tx) => { const created = await tx.crmActivity.create({ data: { ...input, opportunityId: id, createdBy: access.user.name } }); await tx.tenantAuditEvent.create({ data: { actorId: access.user.id, action: "crm_activity.created", entityType: "crm_activity", entityId: String(created.id), correlationId, afterData: { opportunityId: id, type: created.type, dueAt: created.dueAt } } }); return created; });
      return Response.json({ activity, correlationId }, { status: 201, headers: NO_STORE });
    }
    if (body.action === "activity.complete") {
      const activityId = crmId(body.activityId);
      const activity = await db.$transaction(async (tx) => {
        await tx.$queryRaw`SELECT id FROM crm_activities WHERE id = ${activityId} FOR UPDATE`;
        const current = await tx.crmActivity.findFirst({ where: { id: activityId, opportunityId: id } });
        if (!current) throw new CrmInputError("Atividade inválida.");
        const updated = await tx.crmActivity.update({ where: { id: activityId }, data: { completedAt: current.completedAt ? null : new Date() } });
        await tx.tenantAuditEvent.create({ data: { actorId: access.user.id, action: updated.completedAt ? "crm_activity.completed" : "crm_activity.reopened", entityType: "crm_activity", entityId: String(activityId), correlationId, afterData: { opportunityId: id, completedAt: updated.completedAt } } });
        return updated;
      }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
      return Response.json({ activity, correlationId }, { headers: NO_STORE });
    }
    throw new CrmInputError("Ação de CRM inválida.");
  } catch (error) { return failure(error); }
}

function positive(value: string | null, fallback: number, maximum: number) { const parsed = Number(value || fallback); return Number.isInteger(parsed) && parsed > 0 ? Math.min(parsed, maximum) : fallback; }
function failure(error: unknown) {
  if (error instanceof CrmInputError || error instanceof CustomerInputError) return Response.json({ error: error.message }, { status: error.message.includes("Origem") ? 403 : 400, headers: NO_STORE });
  if (error instanceof LicenseDeniedError) return Response.json({ error: error.message }, { status: error.status, headers: NO_STORE });
  if (error instanceof AuthError) return authErrorResponse(error);
  if (error && typeof error === "object" && "code" in error && error.code === "P2034") return Response.json({ error: "Conflito de concorrência. Atualize os dados e tente novamente." }, { status: 409, headers: NO_STORE });
  console.error("crm request failed", error instanceof Error ? error.name : "unknown");
  return Response.json({ error: "Não foi possível operar o CRM." }, { status: 500, headers: NO_STORE });
}
