import { controlDb } from "@/db/control";
import { requireUser } from "@/lib/auth";
import { enforceControlRateLimit, HttpSecurityError } from "@/lib/http-security";
import { getOrganizationUsers, postOrganizationUsers } from "@/lib/erp/user-access-handlers";

type Context = { params: Promise<{ id: string }> };
async function scope(context: Context, write: boolean) {
  const actor = await requireUser("superadmin");
  if (write) await enforceControlRateLimit(controlDb, `admin:${actor.id}:organization-users`, 30, 60);
  const { id } = await context.params;
  if (!id || id.length > 150) throw new HttpSecurityError("Organização inválida.");
  const organization = await controlDb.organization.findUnique({ where: { id }, select: { id: true } });
  if (!organization) throw new HttpSecurityError("Organização não encontrada.", 404);
  return { organization, access: { user: { id: actor.id }, permissions: ["*"] } };
}
export async function GET(request: Request, context: Context) {
  const response = await getOrganizationUsers(request, () => scope(context, false));
  response.headers.set("cache-control", "private, no-store");
  return response;
}
export async function POST(request: Request, context: Context) {
  const response = await postOrganizationUsers(request, () => scope(context, true));
  response.headers.set("cache-control", "private, no-store");
  return response;
}
