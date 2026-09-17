import type { Prisma } from "@/generated/tenant/client";
import { currentOrganization, tenantDb } from "@/db";
import { AuthError, authErrorResponse } from "@/lib/auth";
import { LicenseDeniedError } from "@/lib/billing/license";
import { assertSameOrigin, CustomerInputError } from "@/lib/erp/customer-input";
import { assertPosMutationRequest, enforcePosRateLimit, PosHttpError, readPosJson } from "@/lib/erp/pos-http";
import { assertTenantPermission } from "@/lib/erp/permissions";
import { resolvePosGiftCard, PosValueError } from "@/lib/erp/pos-value-accounts";
import { PosValueSecretError } from "@/lib/erp/pos-value-secrets";
import { assertTenantWriteAccess } from "@/lib/tenant-access";

export async function POST(request: Request) {
  try {
    assertSameOrigin(request);
    assertPosMutationRequest(request);
    const organization = await currentOrganization();
    const actor = await assertTenantPermission(organization.id, "pdv.write");
    await assertTenantWriteAccess(organization.id);
    const db = await tenantDb(organization.id);
    await enforcePosRateLimit(db, actor.user.id, "gift.resolve");
    const input = parse(await readPosJson(request, 8_192));
    const account = await db.$transaction(async tx => {
      const resolved = await resolvePosGiftCard(tx, { branchId: input.branchId, code: input.code, pin: input.pin, expectedCustomerId: input.customerId, now: new Date() });
      await tx.tenantAuditEvent.create({ data: {
        actorId: actor.user.id, action: "pos.value.gift_card.resolved", entityType: "pos_value_account", entityId: resolved.id,
        afterData: jsonObject({ branchId: input.branchId, customerId: input.customerId, codeLastFour: resolved.codeLastFour }),
      } });
      return resolved;
    }, { isolationLevel: "Serializable", maxWait: 5_000, timeout: 10_000 });
    return Response.json({ account }, { headers: { "cache-control": "no-store", pragma: "no-cache" } });
  } catch (error) {
    return failure(error);
  }
}

function parse(body: Record<string, unknown>) {
  const extra = Object.keys(body).find(field => !["branchId", "customerId", "code", "pin"].includes(field));
  if (extra) throw new PosValueError(`Campo não permitido: ${extra}.`);
  return { branchId: id(body.branchId, "Filial"), customerId: body.customerId == null ? undefined : id(body.customerId, "Cliente"), code: text(body.code, "Código", 8, 64), pin: text(body.pin, "PIN", 6, 12) };
}
function id(value: unknown, label: string) { if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) throw new PosValueError(`${label} inválido.`); return value; }
function text(value: unknown, label: string, minimum: number, maximum: number) { if (typeof value !== "string" || value.length < minimum || value.length > maximum) throw new PosValueError(`${label} inválido.`); return value; }
function jsonObject(value: object) { return JSON.parse(JSON.stringify(value)) as Prisma.InputJsonObject; }
function failure(error: unknown) {
  if (error instanceof PosValueError || error instanceof PosValueSecretError || error instanceof PosHttpError) return Response.json({ error: error.message }, { status: error.status });
  if (error instanceof CustomerInputError) return Response.json({ error: error.message }, { status: error.message.includes("Origem") ? 403 : 422 });
  if (error instanceof LicenseDeniedError) return Response.json({ error: error.message }, { status: error.status });
  if (error instanceof AuthError) return authErrorResponse(error);
  console.error("POS gift card resolution failed", { error: error instanceof Error ? error.name : typeof error });
  return Response.json({ error: "Não foi possível validar o gift card." }, { status: 500 });
}
