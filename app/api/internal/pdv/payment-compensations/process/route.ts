import { controlDb } from "@/db/control";
import { tenantDb } from "@/db/tenant";
import { maintainPosPaymentCompensations } from "@/lib/erp/pos-payment-compensation-persistence";
import { parsePosPaymentCompensationMaintenanceInput, PosPaymentCompensationHttpError } from "@/lib/erp/pos-payment-compensation-http";
import { assertPosPaymentJobAuthorization, PosPaymentHttpError } from "@/lib/erp/pos-payment-http";
import { assertPosMutationRequest, enforcePosRateLimit, PosHttpError, readPosJson } from "@/lib/erp/pos-http";

const noStoreHeaders = { "cache-control": "no-store, max-age=0", expires: "0", pragma: "no-cache" };

export async function POST(request: Request) {
  try {
    assertPosPaymentJobAuthorization(request);
    assertPosMutationRequest(request);
    const input = parsePosPaymentCompensationMaintenanceInput(await readPosJson(request, 4_096));
    const organizations = await controlDb.organization.findMany({ where: { status: { in: ["active", "trial"] }, database: { status: "active" }, ...(input.afterOrganizationId ? { id: { gt: input.afterOrganizationId } } : {}) }, select: { id: true }, orderBy: { id: "asc" }, take: input.organizationLimit + 1 });
    const hasMoreOrganizations = organizations.length > input.organizationLimit;
    const selected = organizations.slice(0, input.organizationLimit);
    const results: Array<Record<string, unknown>> = [];
    let failed = false;
    for (const organization of selected) {
      try {
        const db = await tenantDb(organization.id);
        await enforcePosRateLimit(db, "system:pos-payment-compensation-maintenance", "payment.compensation.maintenance");
        results.push({ organizationId: organization.id, status: "completed", ...await maintainPosPaymentCompensations(db, { batchSize: input.itemLimit }) });
      } catch (error) {
        failed = true;
        results.push({ organizationId: organization.id, status: "failed", errorCode: safeErrorCode(error) });
      }
    }
    const nextCursor = !failed && hasMoreOrganizations && selected.length ? selected.at(-1)!.id : null;
    return Response.json({ ok: !failed, processedOrganizations: selected.length, hasMoreOrganizations, nextCursor, results }, { status: failed ? 503 : 200, headers: noStoreHeaders });
  } catch (error) {
    if (error instanceof PosPaymentCompensationHttpError || error instanceof PosPaymentHttpError || error instanceof PosHttpError) return Response.json({ error: error.message }, { status: error.status, headers: noStoreHeaders });
    return Response.json({ error: "Não foi possível executar a manutenção compensatória." }, { status: 500, headers: noStoreHeaders });
  }
}

function safeErrorCode(error: unknown) { const code = error && typeof error === "object" && "code" in error ? String((error as { code?: unknown }).code || "") : ""; if (["P2034", "40001", "40P01"].includes(code)) return "SERIALIZATION_CONFLICT"; return code.startsWith("P") ? "DATABASE_ERROR" : "TENANT_JOB_FAILED"; }
