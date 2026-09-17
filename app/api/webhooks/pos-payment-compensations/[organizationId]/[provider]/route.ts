import { tenantDb } from "@/db/tenant";
import { acceptPosPaymentCompensationCallback } from "@/lib/erp/pos-payment-compensation-persistence";
import { PosPaymentCompensationError } from "@/lib/erp/pos-payment-compensations";
import { PosPaymentCompensationHttpError, verifyAndParsePosPaymentCompensationCallback } from "@/lib/erp/pos-payment-compensation-http";
import { contactHash, decryptSecrets, IntegrationError, objectValue, persistentRateLimit } from "@/lib/integrations/core";

type RouteContext = { params: Promise<{ organizationId: string; provider: string }> };
const noStoreHeaders = { "cache-control": "no-store, max-age=0", expires: "0", pragma: "no-cache" };

export async function POST(request: Request, route: RouteContext) {
  try {
    const { organizationId, provider: rawProvider } = await route.params;
    const provider = providerKey(rawProvider);
    const db = await tenantDb(organizationId);
    const ip = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || "unknown";
    await persistentRateLimit(db, `pos-payment-compensation-callback:${provider}:${contactHash(ip)}`, 120, 60);
    const [connectors, unresolved] = await Promise.all([
      db.posConnector.findMany({ where: { provider, status: "active", type: { startsWith: "payment" }, credentialRef: { not: null } }, select: { credentialRef: true } }),
      db.posPaymentCompensation.findMany({ where: { provider, status: { in: ["requested", "processing", "unknown", "provider_succeeded", "application_pending", "manual_review"] } }, select: { credentialRef: true }, distinct: ["credentialRef"], take: 100 }),
    ]);
    const credentialIds = [...new Set([...connectors.map((item) => item.credentialRef), ...unresolved.map((item) => item.credentialRef)].filter((item): item is string => Boolean(item)))];
    if (!credentialIds.length) throw new PosPaymentCompensationHttpError("Provider compensatório não autorizado.", 404);
    const credentials = await db.integrationCredential.findMany({ where: { id: { in: credentialIds }, providerId: provider, provider: { family: "payment" } }, select: { id: true, enabled: true, config: true, secretsCipherText: true } });
    const now = new Date();
    const candidates = credentials.flatMap((credential) => {
      const config = objectValue(credential.config);
      const secrets = decryptSecrets(credential.secretsCipherText);
      const graceUntil = typeof config.payment_callback_grace_until === "string" ? new Date(config.payment_callback_grace_until) : null;
      if (!credential.enabled && (!graceUntil || !Number.isFinite(graceUntil.valueOf()) || graceUntil <= now)) return [];
      const secret = secrets.payment_compensation_callback_secret || "";
      const keyId = typeof config.webhook_key_id === "string" && config.webhook_key_id ? config.webhook_key_id : credential.id;
      return secret ? [{ keyId, secret }] : [];
    });
    if (!candidates.length) throw new PosPaymentCompensationHttpError("Segredo de callback compensatório não configurado.", 401);
    const verified = await verifyAndParsePosPaymentCompensationCallback(request, provider, candidates);
    const result = await acceptPosPaymentCompensationCallback(db, provider, verified.eventId, verified.keyId, verified.payloadHash, verified.input);
    return Response.json(result, { status: 202, headers: noStoreHeaders });
  } catch (error) {
    if (error instanceof PosPaymentCompensationHttpError || error instanceof PosPaymentCompensationError) return Response.json({ error: error.message }, { status: error.status, headers: noStoreHeaders });
    if (error instanceof IntegrationError) return Response.json({ error: error.message }, { status: error.status, headers: noStoreHeaders });
    console.error("POS payment compensation callback failed", safeErrorCode(error));
    return Response.json({ error: "Não foi possível aceitar o callback compensatório." }, { status: 500, headers: noStoreHeaders });
  }
}

function providerKey(value: string) { const provider = decodeURIComponent(value).normalize("NFKC").trim().toLowerCase(); if (provider.length < 2 || provider.length > 80 || !/^[a-z0-9][a-z0-9._-]*$/.test(provider)) throw new PosPaymentCompensationHttpError("Provider inválido.", 404); return provider; }
function safeErrorCode(error: unknown) { return error && typeof error === "object" && "code" in error ? String((error as { code?: unknown }).code || "DATABASE_ERROR") : "CALLBACK_FAILED"; }
