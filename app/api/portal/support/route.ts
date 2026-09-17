import { controlDb } from "@/db/control";
import { assertTrustedMutation, enforceControlRateLimit, privateJson, readJsonObject } from "@/lib/http-security";
import { executeSupportCommand, readSupportDetail, readSupportList, supportContext, supportFailure } from "@/lib/billing/support-service";
import { SupportInputError } from "@/lib/billing/support-data";

export async function GET(request: Request) {
  try {
    const context = await supportContext(request);
    await enforceControlRateLimit(controlDb, `portal:${context.organizationId}:${context.userId}:support-read`, 90, 60);
    const query = new URL(request.url).searchParams;
    const resource = query.get("resource") || "list";
    if (resource === "detail") return privateJson(await readSupportDetail(context, query.get("token")));
    if (resource !== "list") throw new SupportInputError("Recurso de suporte inválido.");
    return privateJson(await readSupportList(context, query));
  } catch (error) { return supportFailure(error); }
}

export async function POST(request: Request) {
  try {
    assertTrustedMutation(request, { maximumBytes: 64 * 1024 });
    const context = await supportContext(request, true);
    await enforceControlRateLimit(controlDb, `portal:${context.organizationId}:${context.userId}:support-write`, 30, 60);
    const body = await readJsonObject(request, 64 * 1024);
    const result = await executeSupportCommand(context, body);
    await controlDb.auditLog.create({ data: { userId: context.userId, action: `portal.billing.${body.action}`, entityType: "organization", entityId: context.organizationId } });
    return privateJson({ ok: true, result });
  } catch (error) { return supportFailure(error); }
}
