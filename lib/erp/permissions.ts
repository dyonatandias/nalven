import { restrictedFeature } from "./plan-features";
import { currentUser, AuthError } from "@/lib/auth";
import { tenantDb } from "@/db/tenant";
export { PERMISSION_RESOURCES } from "./permission-resources";

export async function assertTenantPermission(
  organizationId: string,
  permission: string,
) {
  const user = await currentUser();
  if (!user) throw new AuthError(401);
  const membership = user.memberships.find(
    (item) =>
      item.organizationId === organizationId && item.status === "active",
  );
  if (!membership) throw new AuthError(403);
  if (restrictedFeature(membership.organization.modules, permission)) throw new AuthError(403);
  if (membership.role === "owner")
    return { user, membership, permissions: ["*"], profile: null };
  const db = await tenantDb(organizationId);
  const [role, profile] = await Promise.all([
    db.tenantRole.findFirst({ where: { key: membership.role, active: true } }),
    db.tenantUserProfile.findUnique({ where: { userId: user.id }, select: { id: true, status: true, accessExpiresAt: true } }),
  ]);
  if (profile && (profile.status !== "active" || (profile.accessExpiresAt && profile.accessExpiresAt <= new Date()))) throw new AuthError(403);
  const permissions = Array.isArray(role?.permissions)
    ? role.permissions.filter(
        (item): item is string => typeof item === "string",
      )
    : [];
  if (!matches(permissions, permission)) throw new AuthError(403);
  return { user, membership, permissions, profile };
}

export function matches(permissions: string[], requested: string) {
  const [resource, action] = requested.split(".");
  return (
    permissions.includes("*") ||
    permissions.includes(requested) ||
    permissions.includes(`${resource}.*`) ||
    permissions.includes(`*.${action}`) ||
    (action === "read" && permissions.includes(`${resource}.write`))
  );
}
