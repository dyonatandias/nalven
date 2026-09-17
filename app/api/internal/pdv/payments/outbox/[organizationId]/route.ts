import { tenantDb } from "@/db/tenant";
import { claimPosPaymentOutbox, completePosPaymentOutbox, parsePosPaymentOutboxCompletion, PosPaymentPersistenceError } from "@/lib/erp/pos-payment-persistence";
import { assertPosPaymentJobAuthorization, parsePosPaymentOutboxClaim, PosPaymentHttpError } from "@/lib/erp/pos-payment-http";
import { assertPosMutationRequest, enforcePosRateLimit, PosHttpError, readPosJson } from "@/lib/erp/pos-http";

type RouteContext = { params: Promise<{ organizationId: string }> };
const noStoreHeaders = { "cache-control": "no-store, max-age=0", expires: "0", pragma: "no-cache" };

export async function POST(request: Request, route: RouteContext) {
  try {
    assertPosPaymentJobAuthorization(request);
    assertPosMutationRequest(request);
    const { organizationId: rawOrganizationId } = await route.params, organizationId = identifier(rawOrganizationId, "Organização");
    const body = await readPosJson(request, 32_768), action = body.action;
    const db = await tenantDb(organizationId);
    if (action === "outbox.claim") {
      const input = parsePosPaymentOutboxClaim(body);
      await enforcePosRateLimit(db, input.workerId, "payment.outbox.claim");
      return Response.json(await claimPosPaymentOutbox(db, input), { headers: noStoreHeaders });
    }
    if (action === "outbox.complete") {
      const input = parsePosPaymentOutboxCompletion(body);
      await enforcePosRateLimit(db, "system:pos-payment-worker", "payment.outbox.complete");
      return Response.json(await completePosPaymentOutbox(db, input), { headers: noStoreHeaders });
    }
    throw new PosPaymentHttpError("Ação do worker inválida.", 400);
  } catch (error) { return failure(error); }
}

function identifier(value: string, label: string) { const result = decodeURIComponent(value).trim(); if (!result || result.length > 160 || !/^[A-Za-z0-9._:-]+$/.test(result)) throw new PosPaymentHttpError(`${label} inválida.`, 400); return result; }
function failure(error: unknown) {
  if (error instanceof PosPaymentHttpError || error instanceof PosPaymentPersistenceError || error instanceof PosHttpError) return Response.json({ error: error.message }, { status: error.status, headers: noStoreHeaders });
  return Response.json({ error: "Não foi possível processar o outbox de pagamentos." }, { status: 500, headers: noStoreHeaders });
}
