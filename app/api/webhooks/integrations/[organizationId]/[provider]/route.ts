import { readBodyBytes, HttpSecurityError, httpSecurityErrorResponse } from "@/lib/http-security";
import { createHash, createHmac } from "node:crypto";
import { tenantDb } from "@/db";
import { Prisma } from "@/generated/tenant/client";
import { constantTimeEqual, contactHash, decryptSecrets, IntegrationError, objectValue, persistentRateLimit, redact } from "@/lib/integrations/core";

type Context = { params: Promise<{ organizationId: string; provider: string }> };

export async function POST(request: Request, route: Context) {
  try {
    const { organizationId, provider } = await route.params, db = await tenantDb(organizationId), ip = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || "unknown"; await persistentRateLimit(db, `inbound:${provider}:${contactHash(ip)}`, 300, 60); const raw = new TextDecoder("utf-8", { fatal: true }).decode(await readBodyBytes(request, 1024 * 1024)); const timestamp = request.headers.get("x-webhook-timestamp") || "", signature = request.headers.get("x-webhook-signature") || "", eventId = request.headers.get("x-webhook-event-id") || "", topic = request.headers.get("x-webhook-topic") || "event.received";
    if (!/^[A-Za-z0-9._:-]{1,160}$/.test(eventId) || !/^\d{10}$/.test(timestamp) || !/^sha256=[0-9a-f]{64}$/.test(signature) || topic.length > 160) throw new IntegrationError("Cabeçalhos de assinatura incompletos.", 401);
    const age = Math.abs(Date.now() / 1000 - Number(timestamp)); if (!Number.isFinite(age) || age > 300) throw new IntegrationError("Webhook fora da janela anti-replay.", 401);
    const credentials = await db.integrationCredential.findMany({ where: { providerId: provider, enabled: true }, orderBy: [{ isDefault: "desc" }, { createdAt: "asc" }] }); if (!credentials.length) throw new IntegrationError("Provider não configurado.", 404);
    const secrets = credentials.map((credential) => decryptSecrets(credential.secretsCipherText)).map((item) => item.webhook_secret || item.secret || item.app_secret).filter(Boolean);
    if (!secrets.length) throw new IntegrationError("Segredo de webhook não configurado.", 401);
    const valid = secrets.some((secret) => constantTimeEqual(`sha256=${createHmac("sha256", secret).update(`${timestamp}.${raw}`).digest("hex")}`, signature));
    if (!valid) throw new IntegrationError("Assinatura de webhook inválida.", 401);
    let payload: Record<string, unknown>; try { payload = objectValue(JSON.parse(raw)); } catch { throw new IntegrationError("Payload JSON inválido."); }
    // Event ID and topic are not covered by this provider's signature.
    const signedId = createHash("sha256").update(`${timestamp}.${raw}`).digest("hex");
    const accepted = await db.$transaction(async tx => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`inbound:${provider}:${signedId}`}))`;
      const existing = await tx.integrationInboundEvent.findFirst({ where: { providerId: provider, eventId: { in: [signedId, eventId] } } });
      if (existing) return false;
      await tx.integrationInboundEvent.create({ data: { eventId: signedId, providerId: provider, topic, payload: redact(payload) as Prisma.InputJsonValue } });
      return true;
    });
    return Response.json({ accepted: true, duplicate: !accepted }, { status: 202, headers: { "cache-control": "private, no-store" } });
  } catch (error) { if (error instanceof HttpSecurityError) return httpSecurityErrorResponse(error); if (error instanceof IntegrationError) return Response.json({ error: error.message }, { status: error.status, headers: { "cache-control": "private, no-store" } }); console.error("integration-inbound-webhook", { error: error instanceof Error ? error.name : typeof error }); return Response.json({ error: "Não foi possível aceitar o webhook." }, { status: 500, headers: { "cache-control": "private, no-store" } }); }
}
