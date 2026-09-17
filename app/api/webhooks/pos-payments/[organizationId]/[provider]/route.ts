import { tenantDb } from "@/db/tenant";
import { acceptPosPaymentCallback, PosPaymentPersistenceError } from "@/lib/erp/pos-payment-persistence";
import { PosPaymentHttpError, verifyAndParsePosPaymentCallback } from "@/lib/erp/pos-payment-http";
import { contactHash, decryptSecrets, IntegrationError, objectValue, persistentRateLimit } from "@/lib/integrations/core";

type RouteContext = { params: Promise<{ organizationId: string; provider: string }> };
const noStoreHeaders = { "cache-control": "no-store, max-age=0", expires: "0", pragma: "no-cache" };

export async function POST(request: Request, route: RouteContext) {
  try {
    const { organizationId, provider: rawProvider } = await route.params;
    const provider = providerKey(rawProvider), db = await tenantDb(organizationId);
    const ip = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || "unknown";
    await persistentRateLimit(db, `pos-payment-callback:${provider}:${contactHash(ip)}`, 120, 60);
    const [connectors, unresolvedIntents] = await Promise.all([
      db.posConnector.findMany({ where: { provider, status: "active", type: { startsWith: "payment" }, credentialRef: { not: null } }, select: { credentialRef: true } }),
      db.posPaymentIntent.findMany({ where: { provider, consumedAt: null, status: { in: ["created", "processing", "authorized", "captured", "unknown", "manual_review"] } }, select: { credentialRef: true }, distinct: ["credentialRef"], take: 100 }),
    ]);
    const credentialIds = [...new Set([...connectors.map(item => item.credentialRef), ...unresolvedIntents.map(item => item.credentialRef)].filter((item): item is string => Boolean(item)))];
    if (!credentialIds.length) throw new PosPaymentHttpError("Provider de pagamento não autorizado.", 404);
    const credentials = await db.integrationCredential.findMany({ where: { id: { in: credentialIds }, providerId: provider, provider: { family: "payment" } }, select: { id: true, enabled: true, config: true, secretsCipherText: true } });
    const now = new Date();
    const candidates = credentials.flatMap(credential => {
      const config = objectValue(credential.config), secrets = decryptSecrets(credential.secretsCipherText);
      const graceUntil = typeof config.payment_callback_grace_until === "string" ? new Date(config.payment_callback_grace_until) : null;
      if (!credential.enabled && (!graceUntil || !Number.isFinite(graceUntil.valueOf()) || graceUntil <= now)) return [];
      const secret = secrets.payment_callback_secret || secrets.webhook_secret || "";
      const keyId = typeof config.webhook_key_id === "string" && config.webhook_key_id ? config.webhook_key_id : credential.id;
      return secret ? [{ keyId, secret }] : [];
    });
    if (!candidates.length) throw new PosPaymentHttpError("Segredo de callback não configurado.", 401);
    const verified = await verifyAndParsePosPaymentCallback(request, provider, candidates);
    const result = await acceptPosPaymentCallback(db, provider, verified.eventId, verified.keyId, verified.payloadHash, verified.input);
    return Response.json(result, { status: 202, headers: noStoreHeaders });
  } catch (error) {
    if (error instanceof PosPaymentHttpError || error instanceof PosPaymentPersistenceError) return Response.json({ error: error.message }, { status: error.status, headers: noStoreHeaders });
    if (error instanceof IntegrationError) return Response.json({ error: error.message }, { status: error.status, headers: noStoreHeaders });
    console.error("POS payment callback failed", safeErrorCode(error));
    return Response.json({ error: "Não foi possível aceitar o callback de pagamento." }, { status: 500, headers: noStoreHeaders });
  }
}

function providerKey(value: string) {
  const provider = decodeURIComponent(value).trim().toLowerCase();
  if (provider.length < 2 || provider.length > 80 || !/^[a-z0-9][a-z0-9._:-]*$/.test(provider)) throw new PosPaymentHttpError("Provider inválido.", 404);
  return provider;
}

function safeErrorCode(error: unknown) { return error && typeof error === "object" && "code" in error ? String((error as { code?: unknown }).code || "DATABASE_ERROR") : "CALLBACK_FAILED"; }
