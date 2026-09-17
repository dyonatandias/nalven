import { currentOrganization } from "@/db";
import { assertTenantPermission } from "@/lib/erp/permissions";
import { getOrganizationUsers, postOrganizationUsers } from "@/lib/erp/user-access-handlers";

export async function GET(request: Request) {
  return getOrganizationUsers(request, async () => {
    const organization = await currentOrganization();
    const access = await assertTenantPermission(organization.id, "users.read");
    return { organization, access };
  });
}

export async function POST(request: Request) {
  return postOrganizationUsers(request, async () => {
    const organization = await currentOrganization();
    const access = await assertTenantPermission(organization.id, "users.write");
    return { organization, access };
  });
}
