import { controlDb } from "@/db/control";
import { tenantDb } from "@/db/tenant";
import { authErrorResponse, requireUser } from "@/lib/auth";
import { HttpSecurityError, privateJson } from "@/lib/http-security";

export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    await requireUser("superadmin");
    const { id } = await context.params;
    if (!id || id.length > 150) throw new HttpSecurityError("Organização inválida.");
    const organization = await controlDb.organization.findUnique({ where: { id }, select: { id: true } });
    if (!organization) throw new HttpSecurityError("Organização não encontrada.", 404);
    const page = Math.min(10000, Math.max(1, Number.parseInt(new URL(request.url).searchParams.get("page") || "1", 10) || 1));
    const db = await tenantDb(organization.id);
    const [branches, total] = await db.$transaction([
      db.branch.findMany({ select: { id: true, name: true, legalName: true, document: true, stateRegistration: true, stateRegistrationExempt: true, municipalRegistration: true, activityCode: true, zip: true, street: true, number: true, complement: true, district: true, city: true, state: true, primary: true, status: true }, orderBy: [{ primary: "desc" }, { id: "asc" }], take: 25, skip: (page - 1) * 25 }),
      db.branch.count(),
    ]);
    return privateJson({ branches, total, page, pageSize: 25 });
  } catch (error) { return authErrorResponse(error); }
}
