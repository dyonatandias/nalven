import { tenantDb } from "@/db/tenant";
import { claimPosFiscalOutbox, completePosFiscalOutbox } from "@/lib/erp/pos-fiscal-persistence";
import { assertPosFiscalJobAuthorization, fiscalHttpFailure, parsePosFiscalOutboxClaim, parsePosFiscalOutboxCompletion, PosFiscalHttpError } from "@/lib/erp/pos-fiscal-http";
import { assertPosMutationRequest, enforcePosRateLimit, readPosJson } from "@/lib/erp/pos-http";

type RouteContext = { params: Promise<{ organizationId: string }> };
const noStoreHeaders = { "cache-control": "no-store, max-age=0", expires: "0", pragma: "no-cache" };

export async function POST(request: Request, route: RouteContext) {
  try {
    assertPosFiscalJobAuthorization(request);
    assertPosMutationRequest(request);
    const { organizationId: rawOrganizationId } = await route.params;
    const organizationId = identifier(rawOrganizationId);
    const body = await readPosJson(request, 65_536);
    const db = await tenantDb(organizationId);
    if (body.action === "outbox.claim") {
      const input = parsePosFiscalOutboxClaim(body);
      await enforcePosRateLimit(db, input.workerId, "fiscal.outbox.claim");
      return Response.json(await claimPosFiscalOutbox(db, input), { headers: noStoreHeaders });
    }
    if (body.action === "outbox.complete") {
      const input = parsePosFiscalOutboxCompletion(body);
      await enforcePosRateLimit(db, "system:pos-fiscal-worker", "fiscal.outbox.complete");
      return Response.json(await completePosFiscalOutbox(db, input), { headers: noStoreHeaders });
    }
    throw new PosFiscalHttpError("Ação do worker fiscal inválida.", 400);
  } catch (error) {
    return fiscalHttpFailure(error);
  }
}

function identifier(value: string) {
  const result = decodeURIComponent(value).trim();
  if (!result || result.length > 160 || !/^[A-Za-z0-9._:-]+$/.test(result)) throw new PosFiscalHttpError("Organização inválida.", 400);
  return result;
}
