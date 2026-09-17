import { currentOrganization, tenantDb } from "@/db";
import { AuthError, authErrorResponse } from "@/lib/auth";
import { LicenseDeniedError } from "@/lib/billing/license";
import { assertSameOrigin, CustomerInputError } from "@/lib/erp/customer-input";
import { activatePosPaymentPlan, parsePosPaymentPlanActivation, posPaymentPlanDto, PosPaymentPlanError, type PosPaymentPlanContext } from "@/lib/erp/pos-payment-plan";
import { assertPosMutationRequest, enforcePosRateLimit, PosHttpError, readPosJson } from "@/lib/erp/pos-http";
import { assertTenantPermission } from "@/lib/erp/permissions";
import { authorizePosOperationalAction, PosOperationalAccessError } from "@/lib/erp/pos-operational-access";
import { authenticatePosOperationalTerminal, posOperationalTerminalSelect, PosTerminalBoundaryError, readPosOperationalTerminalCredential } from "@/lib/erp/pos-terminal-boundary";
import { assertTenantWriteAccess } from "@/lib/tenant-access";

type Db = Awaited<ReturnType<typeof tenantDb>>;
type Permission = Awaited<ReturnType<typeof assertTenantPermission>>;
const noStoreHeaders = { "cache-control": "no-store, max-age=0", expires: "0", pragma: "no-cache" };

export async function POST(request: Request) {
  try {
    assertSameOrigin(request);
    assertPosMutationRequest(request);
    const organization = await currentOrganization();
    const permission = await assertTenantPermission(organization.id, "pdv.write");
    const db = await tenantDb(organization.id);
    const body = await readPosJson(request, 32_768);
    const input = parsePosPaymentPlanActivation(body);
    await enforcePosRateLimit(db, permission.user.id, "payment.plan.activate");
    const credential = readPosOperationalTerminalCredential(request.headers);
    const terminal = await db.posTerminal.findUnique({ where: { id: credential.terminalId }, select: posOperationalTerminalSelect });
    const terminalProof = authenticatePosOperationalTerminal(terminal, { organizationId: organization.id, ...credential });
    const operational = await operationalContext(db, permission, terminalProof.branchId);
    await assertExplicitSalePreparationAccess(db, permission.user.id, operational, terminalProof.registerId);
    const context: PosPaymentPlanContext = {
      branchId: operational.branchId,
      registerId: terminalProof.registerId,
      sessionId: input.sessionId,
      operatorProfileId: operational.operatorProfileId,
      terminalId: terminalProof.terminalId,
      actorUserId: permission.user.id,
    };
    await assertTenantWriteAccess(organization.id);
    const result = await activatePosPaymentPlan(db, context, input, terminalProof);
    return Response.json({ paymentPlan: posPaymentPlanDto(result.plan), replayed: result.replayed }, {
      status: result.replayed ? 200 : 201,
      headers: { ...noStoreHeaders, ...(result.replayed ? { "idempotency-replayed": "true" } : {}) },
    });
  } catch (error) {
    return failure(error);
  }
}

async function operationalContext(db: Db, permission: Permission, terminalBranchId: number) {
  const profile = await db.tenantUserProfile.findUnique({ where: { userId: permission.user.id }, select: { id: true, status: true, activeBranch: { select: { id: true, status: true } } } });
  if (!profile || profile.status !== "active") throw new PosPaymentPlanError("Perfil operacional ativo não configurado.", 403);
  const branch = await db.branch.findFirst({ where: { id: terminalBranchId, status: "active" }, select: { id: true, status: true } });
  if (!branch) throw new PosPaymentPlanError("Filial operacional ativa não encontrada.", 404);
  return { branchId: branch.id, operatorProfileId: profile.id, profileActive: profile.status === "active", branchActive: branch.status === "active" };
}

async function assertExplicitSalePreparationAccess(db: Db, actorUserId: string, operational: Awaited<ReturnType<typeof operationalContext>>, registerId: number) {
  const now = new Date();
  const [branchAccess, register, registerAccess] = await Promise.all([
    db.branchUserAccess.findUnique({ where: { branchId_userProfileId: { branchId: operational.branchId, userProfileId: operational.operatorProfileId } }, select: { canSell: true } }),
    db.posRegister.findUnique({ where: { id: registerId }, select: { branchId: true, status: true } }),
    db.posRegisterAccess.findUnique({ where: { registerId_userProfileId: { registerId, userProfileId: operational.operatorProfileId } } }),
  ]);
  authorizePosOperationalAction({
    action: "sale.prepare",
    actorUserId,
    actorProfileId: operational.operatorProfileId,
    actorProfileActive: operational.profileActive,
    branchId: operational.branchId,
    branchActive: operational.branchActive,
    registerId,
    registerActive: register?.branchId === operational.branchId && register.status === "active",
    branchCanSell: branchAccess?.canSell === true,
    registerAccess: registerAccess ? { ...registerAccess, branchId: operational.branchId } : null,
    now,
  });
}

function failure(error: unknown) {
  if (error instanceof PosPaymentPlanError || error instanceof PosTerminalBoundaryError || error instanceof PosOperationalAccessError || error instanceof PosHttpError) return Response.json({ error: error.message }, { status: error.status, headers: noStoreHeaders });
  if (error instanceof CustomerInputError) return Response.json({ error: error.message }, { status: error.message.includes("Origem") ? 403 : 422, headers: noStoreHeaders });
  if (error instanceof LicenseDeniedError) return Response.json({ error: error.message }, { status: error.status, headers: noStoreHeaders });
  if (error instanceof AuthError) return authErrorResponse(error);
  console.error("POS payment plan failed", { error: error instanceof Error ? error.name : typeof error });
  return Response.json({ error: "Não foi possível ativar o plano de pagamento." }, { status: 500, headers: noStoreHeaders });
}
