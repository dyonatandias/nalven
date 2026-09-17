import { currentOrganization, tenantDb } from "@/db";
import { AuthError, authErrorResponse } from "@/lib/auth";
import { assertSameOrigin } from "@/lib/erp/customer-input";
import { assertTenantPermission } from "@/lib/erp/permissions";
import { IntegrationError, persistentRateLimit } from "@/lib/integrations/core";
import { privateJson, readIntegrationJson } from "@/lib/integrations/http";
import { validatePublicHttpsUrl } from "@/lib/integrations/security";
import { unexpectedErrorResponse } from "@/lib/http-security";

export async function POST(request: Request) {
  try { assertSameOrigin(request); const organization = await currentOrganization(), access = await assertTenantPermission(organization.id, "integrations.write"), body = await readIntegrationJson(request); await persistentRateLimit(await tenantDb(organization.id),`${access.user.id}:webhook-url`, 20, 60); const checked = await validatePublicHttpsUrl(String(body.url || "")); return privateJson({ valid: true, host: checked.url.hostname, address: checked.address }); }
  catch (error) { if (error instanceof IntegrationError) return privateJson({ error: error.message }, { status: error.status }); if (error instanceof AuthError) return authErrorResponse(error); return unexpectedErrorResponse("erp.webhook-validate-url",error); }
}
