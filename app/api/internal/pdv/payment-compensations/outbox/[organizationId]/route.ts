import { tenantDb } from "@/db/tenant";
import {
  claimPosPaymentCompensationOutbox,
  completePosPaymentCompensationOutbox,
  parsePosPaymentCompensationOutboxCompletion,
} from "@/lib/erp/pos-payment-compensation-persistence";
import { PosPaymentCompensationError } from "@/lib/erp/pos-payment-compensations";
import { parsePosPaymentCompensationOutboxClaim, PosPaymentCompensationHttpError } from "@/lib/erp/pos-payment-compensation-http";
import { assertPosPaymentJobAuthorization, PosPaymentHttpError } from "@/lib/erp/pos-payment-http";
import { assertPosMutationRequest, enforcePosRateLimit, PosHttpError, readPosJson } from "@/lib/erp/pos-http";

type RouteContext = { params: Promise<{ organizationId: string }> };
const noStoreHeaders = { "cache-control": "no-store, max-age=0", expires: "0", pragma: "no-cache" };

export async function POST(request: Request, route: RouteContext) {
  try {
    assertPosPaymentJobAuthorization(request);
    assertPosMutationRequest(request);
    const { organizationId: rawOrganizationId } = await route.params;
    const organizationId = identifier(rawOrganizationId, "Organização");
    const body = await readPosJson(request, 32_768);
    const db = await tenantDb(organizationId);
    if (body.action === "compensation.outbox.claim") {
      const input = parsePosPaymentCompensationOutboxClaim(body);
      await enforcePosRateLimit(db, input.workerId, "payment.compensation.outbox.claim");
      return Response.json(await claimPosPaymentCompensationOutbox(db, input), { headers: noStoreHeaders });
    }
    if (body.action === "compensation.outbox.complete") {
      const input = parsePosPaymentCompensationOutboxCompletion(body);
      await enforcePosRateLimit(db, "system:pos-payment-compensation-worker", "payment.compensation.outbox.complete");
      return Response.json(await completePosPaymentCompensationOutbox(db, input), { headers: noStoreHeaders });
    }
    throw new PosPaymentCompensationHttpError("Ação do worker compensatório inválida.", 400);
  } catch (error) { return failure(error); }
}

function identifier(value: string, label: string) { const result = decodeURIComponent(value).normalize("NFKC").trim(); if (!result || result.length > 160 || !/^[A-Za-z0-9._:-]+$/.test(result)) throw new PosPaymentCompensationHttpError(`${label} inválida.`, 400); return result; }
function failure(error: unknown) {
  if (error instanceof PosPaymentCompensationHttpError || error instanceof PosPaymentCompensationError || error instanceof PosPaymentHttpError || error instanceof PosHttpError) return Response.json({ error: error.message }, { status: error.status, headers: noStoreHeaders });
  return Response.json({ error: "Não foi possível processar o outbox compensatório." }, { status: 500, headers: noStoreHeaders });
}
