import { controlDb } from "@/db/control";
import { authErrorResponse, requireUser } from "@/lib/auth";
import { enforceControlRateLimit, privateJson } from "@/lib/http-security";
import { billingClient } from "@/lib/billing/client";
import { organizationInvoices, organizationPayment } from "@/lib/admin-organization-billing";

export async function GET(_request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const actor = await requireUser("superadmin");
    await enforceControlRateLimit(controlDb, `admin:${actor.id}:organization-billing`, 30, 60);
    const { id } = await context.params;
    if (!id || id.length > 160) return privateJson({ error: "Organização inválida." }, { status: 400 });
    const organization = await controlDb.organization.findUnique({ where: { id }, select: { id: true, billingAccount: { select: { externalId: true } } } });
    if (!organization) return privateJson({ error: "Organização não encontrada." }, { status: 404 });
    if (!organization.billingAccount) return privateJson({ linked: false });
    const externalId = organization.billingAccount.externalId;
    const [payment, invoices] = await Promise.allSettled([
      billingClient.portal(externalId).then(organizationPayment),
      billingClient.invoices(externalId).then(organizationInvoices),
    ]);
    return privateJson({
      linked: true, checkedAt: new Date().toISOString(),
      payment: payment.status === "fulfilled" ? payment.value : null,
      invoices: invoices.status === "fulfilled" ? invoices.value : null,
      errors: { payment: payment.status === "rejected" ? "Não foi possível consultar a assinatura externa." : null, invoices: invoices.status === "rejected" ? "Não foi possível consultar as faturas externas." : null },
    });
  } catch (error) { return authErrorResponse(error); }
}
