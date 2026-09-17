import { currentMembership, currentUser, setActiveOrganization, AuthError, authErrorResponse } from "@/lib/auth";
import { assertTrustedMutation, privateJson, readJsonObject } from "@/lib/http-security";

export async function GET() {
  try {
    const user = await currentUser();
    if (!user) throw new AuthError(401);
    const current = await currentMembership(user);
    return privateJson({ currentOrganizationId: current?.organizationId || null, organizations: user.memberships.filter(item => item.status === "active").map(item => ({ id: item.organizationId, name: item.organization.name, slug: item.organization.slug, role: item.role, status: item.organization.status })) });
  } catch (error) { return authErrorResponse(error); }
}

export async function POST(request: Request) {
  try {
    assertTrustedMutation(request, { maximumBytes: 4096 });
    const user = await currentUser();
    if (!user) throw new AuthError(401);
    const body = await readJsonObject(request, 4096);
    const organizationId = typeof body.organizationId === "string" ? body.organizationId : "";
    const membership = user.memberships.find(item => item.organizationId === organizationId && item.status === "active");
    if (!membership) throw new AuthError(403);
    await setActiveOrganization(organizationId);
    return privateJson({ ok: true, destination: "/erp", organization: { id: membership.organizationId, name: membership.organization.name } });
  } catch (error) { return authErrorResponse(error); }
}
