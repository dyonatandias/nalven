import { currentOrganization, tenantDb } from "@/db";
import { AuthError, authErrorResponse } from "@/lib/auth";
import { assertSameOrigin } from "@/lib/erp/customer-input";
import { assertTenantPermission } from "@/lib/erp/permissions";
import { assertTenantWriteAccess } from "@/lib/tenant-access";
import { IntegrationError } from "@/lib/integrations/core";
import { privateJson, readIntegrationJson } from "@/lib/integrations/http";
import { deliverWebhook, serializeDelivery } from "@/lib/integrations/webhooks";
import { unexpectedErrorResponse } from "@/lib/http-security";

type Context = { params: Promise<{ id: string }> };

export async function GET(_request: Request, route: Context) {
  try {
    const organization = await currentOrganization();
    await assertTenantPermission(organization.id, "integrations.read");
    const db = await tenantDb(organization.id), { id } = await route.params;
    const delivery = await db.integrationWebhookDelivery.findUnique({ where: { id }, include: { endpoint: { select: { id: true, name: true, topic: true, deliveryUrl: true, status: true } } } });
    if (!delivery) throw new IntegrationError("Entrega não encontrada.", 404);
    return privateJson({ delivery: serializeDelivery(delivery) });
  } catch (error) { return fail(error); }
}

export async function POST(request: Request, route: Context) {
  try {
    assertSameOrigin(request);
    const organization = await currentOrganization();
    await assertTenantPermission(organization.id, "integrations.write");
    await assertTenantWriteAccess(organization.id);
    const db = await tenantDb(organization.id), { id } = await route.params, body = await readIntegrationJson(request);
    if (body.action !== "retry") throw new IntegrationError("Ação inválida.");
    const delivery = await db.integrationWebhookDelivery.findUnique({ where: { id } });
    if (!delivery) throw new IntegrationError("Entrega não encontrada.", 404);
    if (delivery.state === "delivered") throw new IntegrationError("A entrega já foi concluída.", 422);
    await db.integrationWebhookDelivery.update({ where: { id }, data: { state: "pending", attempts: 0, nextAttemptAt: new Date(), responseCode: null, responseBody: null, deliveredAt: null } });
    return privateJson({ delivery: serializeDelivery(await deliverWebhook(db, id)) });
  } catch (error) { return fail(error); }
}

function fail(error: unknown) { if (error instanceof IntegrationError) return privateJson({ error: error.message }, { status: error.status }); if (error instanceof AuthError) return authErrorResponse(error); return unexpectedErrorResponse("erp.webhook-delivery",error); }
