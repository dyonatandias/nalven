import { currentOrganization, tenantDb } from "@/db";
import { assertTenantPermission } from "@/lib/erp/permissions";
import { ReportInputError } from "@/lib/erp/report-domain";
import { AuthError } from "@/lib/auth";
import { LicenseDeniedError } from "@/lib/billing/license";
import { IntegrationError, persistentRateLimit } from "@/lib/integrations/core";
import type { PrismaClient } from "@/generated/tenant/client";
import { HttpSecurityError, httpSecurityErrorResponse } from "@/lib/http-security";


export async function reportContext(permission = "reports.read") {
  const organization = await currentOrganization();
  const access = await assertTenantPermission(organization.id, permission);
  const db = await tenantDb(organization.id);
  const profile = await db.tenantUserProfile.findUnique({ where: { userId: access.user.id }, select: { id: true, activeBranchId: true } });
  if (!profile?.activeBranchId) throw new ReportInputError("Selecione uma filial ativa.", 409);
  const branch = await db.branch.findFirst({ where: { id: profile.activeBranchId, status: "active", userAccesses: { some: { userProfileId: profile.id } } }, select: { id: true, timezone: true } });
  if (!branch) throw new ReportInputError("Você não possui acesso à filial ativa.", 403);
  return { organization, access, db, branchId: branch.id, timezone: branch.timezone };
}

export async function guardReportExport(db: PrismaClient, key: string) {
  try {
    await persistentRateLimit(db, `report-export:${key}`, 5, 60);
  } catch (error) {
    if (error instanceof IntegrationError)
      throw new ReportInputError("Limite de 5 exportações completas por minuto atingido.", 429);
    throw error;
  }
}

export function reportFailure(error: unknown) {
  if (error instanceof HttpSecurityError) return httpSecurityErrorResponse(error);
  if (error instanceof ReportInputError || error instanceof LicenseDeniedError || error instanceof AuthError)
    return Response.json({ error: error.message }, { status: error.status, headers: { "cache-control": "private, no-store" } });
  console.error("report_error", { error: error instanceof Error ? error.name : typeof error });
  return Response.json({ error: "Não foi possível gerar o relatório." }, { status: 500, headers: { "cache-control": "private, no-store" } });
}

export function csvResponse(content: string, filename: string) {
  return new Response(content, { headers: { "content-type": "text/csv; charset=utf-8", "content-disposition": `attachment; filename="${filename}"`, "cache-control": "private, no-store" } });
}

export function privateJson(value: unknown) {
  return Response.json(value, { headers: { "cache-control": "private, no-store, max-age=0", "x-content-type-options": "nosniff" } });
}
