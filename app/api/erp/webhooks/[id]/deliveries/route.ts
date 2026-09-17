import { currentOrganization, tenantDb } from "@/db";
import { AuthError, authErrorResponse } from "@/lib/auth";
import { assertTenantPermission } from "@/lib/erp/permissions";
import { privateJson } from "@/lib/integrations/http";
import { serializeDelivery } from "@/lib/integrations/webhooks";
import { unexpectedErrorResponse } from "@/lib/http-security";
type Context = { params: Promise<{ id: string }> };
export async function GET(_request: Request, route: Context) { try { const organization = await currentOrganization(); await assertTenantPermission(organization.id, "integrations.read"); const { id } = await route.params, db = await tenantDb(organization.id), deliveries = await db.integrationWebhookDelivery.findMany({ where: { endpointId: id }, orderBy: { createdAt: "desc" }, take: 200 }); return privateJson({ deliveries: deliveries.map(serializeDelivery) }); } catch (error) { if (error instanceof AuthError) return authErrorResponse(error); return unexpectedErrorResponse("erp.webhook-deliveries",error); } }
