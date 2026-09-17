import { controlDb } from "@/db/control";
import { requireUser, authErrorResponse } from "@/lib/auth";
import { privateJson } from "@/lib/http-security";

export async function GET() {
  try {
    await requireUser("superadmin");
    const [plans, organizations] = await Promise.all([
      controlDb.plan.findMany({ orderBy: [{ active: "desc" }, { monthlyPrice: "asc" }], include: { _count: { select: { organizations: true } } } }),
      controlDb.organization.findMany({ select: { id: true, name: true }, orderBy: { name: "asc" } }),
    ]);
    return privateJson({ plans, organizations });
  } catch (error) { return authErrorResponse(error); }
}
