import { authErrorResponse, currentUser } from "@/lib/auth";
import { privateJson } from "@/lib/http-security";

export async function GET() {
  try {
  const user = await currentUser();
  if (!user) return privateJson({ user: null }, { status: 401 });
  return privateJson({ user: { id: user.id, name: user.name, email: user.email, role: user.role, memberships: user.memberships.filter((membership) => membership.status === "active").map((membership) => ({ role: membership.role, organization: { id: membership.organization.id, name: membership.organization.name, slug: membership.organization.slug, status: membership.organization.status } })) } });
  } catch (error) { return authErrorResponse(error); }
}
