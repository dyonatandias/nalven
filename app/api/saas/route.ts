import { randomUUID } from "node:crypto";
import { canAssignPlan } from "@/lib/admin-plan-policy";
import { isValidTaxDocument } from "@/lib/erp/customer-input";
import { signupConfiguration } from "@/lib/site/signup";
import { controlDb } from "@/db";
import type { Prisma } from "@/generated/control/client";
import { authErrorResponse, requireUser } from "@/lib/auth";
import { redact } from "@/lib/integrations/core";
import { enforceControlRateLimit, privateJson, readJsonObject } from "@/lib/http-security";

async function snapshot() {
  const [plans, tenants, invoices, tickets, databases, integrations, backups, exports, jobs] = await Promise.all([
    controlDb.plan.findMany({ orderBy: { monthlyPrice: "asc" } }),
    controlDb.organization.findMany({ orderBy: { createdAt: "desc" } }),
    controlDb.invoice.findMany({ orderBy: { dueAt: "desc" } }),
    controlDb.ticket.findMany({ orderBy: { createdAt: "desc" } }),
    controlDb.tenantDatabase.findMany({ orderBy: { createdAt: "desc" } }),
    controlDb.integration.findMany({ orderBy: { createdAt: "desc" } }),
    controlDb.backupRun.findMany({ orderBy: { startedAt: "desc" }, take: 50 }),
    controlDb.exportJob.findMany({ orderBy: { createdAt: "desc" }, take: 50 }),
    controlDb.provisioningJob.findMany({ orderBy: { createdAt: "desc" }, take: 50 })
  ]);
  return { plans, tenants, invoices, tickets, databases, integrations: integrations.map(item => ({ ...item, config: redact(item.config) })), backups: backups.map(b => ({...b, sizeBytes: b.sizeBytes?.toString()})), exports, jobs };
}

export async function GET() {
  try { await requireUser("superadmin"); return privateJson(await snapshot()); }
  catch (error) { return authErrorResponse(error); }
}

export async function POST(request: Request) {
  try {
    const actor = await requireUser("superadmin");
    await enforceControlRateLimit(controlDb, `admin:${actor.id}:saas`, 60, 60);
    const body = await readJsonObject(request, 32_768);
    if (body.action === "create_tenant") {
      const name = String(body.name || "").trim();
      const email = String(body.email || "").trim();
      const planId = String(body.planId || "");
      const document=String(body.document || "").replace(/\D/g, "");
      const ownerName=String(body.ownerName || "").trim();
      if (!name || !/^\S+@\S+\.\S+$/.test(email) || !ownerName || !isValidTaxDocument(document)) return bad("Informe empresa, responsável, e-mail e CPF/CNPJ válidos.");
      const plan = await controlDb.plan.findUnique({ where: { id: planId } });
      if (!plan || !canAssignPlan(plan)) return bad("Plano público ativo não encontrado.", 404);
      const stamp = randomUUID();
      const configuration = await signupConfiguration();
      const organization = await controlDb.organization.create({ data: { id: `org-${stamp}`, slug: `org-${stamp}`, name, document, ownerName, email, planId, status: "provisioning", modules: plan.modules as Prisma.InputJsonValue, usageScore: 0, trialEndsAt: new Date(Date.now() + configuration.trialDays * 86400000).toISOString().slice(0, 10) } });
      await controlDb.provisioningJob.create({ data: { organizationId: organization.id } });
      await controlDb.auditLog.create({ data: { userId: actor.id, action: "organization.create", entityType: "organization", metadata: { name, email } } });
      return privateJson(await snapshot());
    }
    if (body.action === "set_tenant_status") {
      const status = String(body.status || "active");
      if (!["trial", "active", "past_due", "suspended"].includes(status)) return bad("Status inválido.");
      await controlDb.organization.update({ where: { id: String(body.id) }, data: { status } });
      return privateJson(await snapshot());
    }
    if (body.action === "change_plan") {
      return bad("Use a página individual da organização para atribuir o plano com controle de versão.", 410);
    }
    if (body.action === "resolve_ticket") {
      await controlDb.ticket.update({ where: { id: String(body.id) }, data: { status: "resolved" } });
      return privateJson(await snapshot());
    }
    return bad("Ação não reconhecida.");
  } catch (error) { return authErrorResponse(error); }
}

function bad(error: string, status = 400) { return privateJson({ error }, { status }); }
