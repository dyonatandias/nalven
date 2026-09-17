import { currentOrganization, tenantDb } from "@/db";
import { AuthError, authErrorResponse } from "@/lib/auth";
import { assertSameOrigin } from "@/lib/erp/customer-input";
import { assertTenantPermission } from "@/lib/erp/permissions";
import { assertTenantWriteAccess } from "@/lib/tenant-access";
import { deliverWebhook } from "@/lib/integrations/webhooks";
import { IntegrationError, persistentRateLimit } from "@/lib/integrations/core";
import { privateJson } from "@/lib/integrations/http";
import { unexpectedErrorResponse } from "@/lib/http-security";
type Context = { params: Promise<{ id: string }> };
export async function POST(request: Request, route: Context) { try { assertSameOrigin(request); const organization = await currentOrganization(); const access=await assertTenantPermission(organization.id, "integrations.write"); await assertTenantWriteAccess(organization.id); const { id } = await route.params,db=await tenantDb(organization.id);await persistentRateLimit(db,`${access.user.id}:webhook-retry`,30,60);return privateJson({ delivery: await deliverWebhook(db, id) }); } catch (error) { if(error instanceof IntegrationError)return privateJson({error:error.message},{status:error.status});if (error instanceof AuthError) return authErrorResponse(error); return unexpectedErrorResponse("erp.webhook-retry",error); } }
