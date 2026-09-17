import { randomUUID } from "node:crypto";
import { currentOrganization, tenantDb } from "@/db";
import { AuthError, authErrorResponse } from "@/lib/auth";
import { LicenseDeniedError } from "@/lib/billing/license";
import { assertSameOrigin, customerInput, CustomerInputError } from "@/lib/erp/customer-input";
import { assertPosMutationRequest, enforcePosRateLimit, PosHttpError, readPosJson } from "@/lib/erp/pos-http";
import { assertTenantPermission } from "@/lib/erp/permissions";
import { enqueueWebhook } from "@/lib/integrations/webhooks";
import { assertTenantWriteAccess } from "@/lib/tenant-access";
import { publicPosCustomer } from "@/lib/erp/pos-customer-privacy";

export async function POST(request: Request) {
  try {
    assertSameOrigin(request);
    assertPosMutationRequest(request);
    const organization = await currentOrganization();
    const permission = await assertTenantPermission(organization.id, "pdv.write");
    await assertTenantWriteAccess(organization.id);
    const db = await tenantDb(organization.id);
    await enforcePosRateLimit(db, permission.user.id, "customer.quick.create");
    const body = await readPosJson(request, 16_384);
    onlyKeys(body, ["sessionId", "name", "tradeName", "document", "email", "phone"]);
    const sessionId = positiveInt(body.sessionId);
    const profile = await db.tenantUserProfile.findUnique({ where: { userId: permission.user.id }, select: { id: true, status: true } });
    if (!profile || profile.status !== "active") throw new CustomerInputError("Perfil operacional ativo não configurado.");
    const session = await db.cashRegisterSession.findFirst({ where: { id: sessionId, operatorProfileId: profile.id, status: "open", register: { status: "active", branch: { status: "active" } } }, select: { id: true, registerId: true, register: { select: { branchId: true } } } });
    if (!session?.registerId || !session.register) throw new CustomerInputError("O cadastro rápido exige um turno aberto do próprio operador.");
    const privileged = ["owner", "admin"].includes(permission.membership.role);
    if (!privileged) {
      const now = new Date();
      const [branchAccess, registerAccess] = await Promise.all([
        db.branchUserAccess.findFirst({ where: { branchId: session.register.branchId, userProfileId: profile.id, canSell: true } }),
        db.posRegisterAccess.findFirst({ where: { registerId: session.registerId, userProfileId: profile.id, active: true, canSell: true, AND: [{ OR: [{ validFrom: null }, { validFrom: { lte: now } }] }, { OR: [{ validUntil: null }, { validUntil: { gte: now } }] }] } }),
      ]);
      if (!branchAccess || !registerAccess) throw new CustomerInputError("Seu acesso de venda neste caixa não está vigente.");
    }
    const input = customerInput({ ...body, creditLimit: 0 });
    const correlationId = randomUUID();
    try {
      const customer = await db.$transaction(async tx => {
        const created = await tx.customer.create({ data: { type: input.type, name: input.name, tradeName: input.tradeName, document: input.document, email: input.email, phone: input.phone, creditLimit: 0 } });
        await tx.tenantAuditEvent.create({ data: { actorId: permission.user.id, action: "pos.customer.quick_created", entityType: "customer", entityId: String(created.id), correlationId, afterData: { type: created.type, documentLastFour: created.document.slice(-4), sessionId } } });
        await enqueueWebhook(tx, "customer.created", { id: created.id, status: created.status, source: "pos_quick", occurred_at: new Date().toISOString(), correlation_id: correlationId });
        return publicPosCustomer(created);
      }, { isolationLevel: "Serializable" });
      return Response.json({ customer, correlationId, reused: false }, { status: 201 });
    } catch (error) {
      if (prismaCode(error) !== "P2002") throw error;
      const existing = await db.customer.findUnique({ where: { document: input.document } });
      if (!existing || existing.status !== "active") throw new CustomerInputError("Este CPF/CNPJ já pertence a um cliente indisponível; solicite a regularização no cadastro completo.");
      return Response.json({ customer: publicPosCustomer(existing), reused: true });
    }
  } catch (error) {
    return failure(error);
  }
}

function onlyKeys(value: Record<string, unknown>, allowed: readonly string[]) { const extra = Object.keys(value).find((key) => !allowed.includes(key)); if (extra) throw new CustomerInputError(`Campo não permitido: ${extra}.`); }
function positiveInt(value: unknown) { const result = Number(value); if (!Number.isSafeInteger(result) || result <= 0) throw new CustomerInputError("Turno inválido."); return result; }
function prismaCode(error: unknown) { return error && typeof error === "object" && "code" in error ? String(error.code) : ""; }
function failure(error: unknown) {
  if (error instanceof PosHttpError || error instanceof CustomerInputError) return Response.json({ error: error.message }, { status: error instanceof PosHttpError ? error.status : error.message.includes("acesso") || error.message.includes("turno") ? 403 : 422 });
  if (error instanceof LicenseDeniedError) return Response.json({ error: error.message }, { status: error.status });
  if (error instanceof AuthError) return authErrorResponse(error);
  console.error("POS quick customer failed", { error: error instanceof Error ? error.name : typeof error });
  return Response.json({ error: "Não foi possível cadastrar o cliente no PDV." }, { status: 500 });
}
