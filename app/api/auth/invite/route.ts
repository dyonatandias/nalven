import { isPlanCapacityError, PLAN_CAPACITY_MESSAGE } from "@/lib/plan-capacity-error";
import { randomUUID } from "node:crypto";
import { controlDb, tenantDb } from "@/db";
import { createSession, currentUser, setActiveOrganization } from "@/lib/auth";
import { inviteHash, UserAccessInputError } from "@/lib/erp/user-access-input";
import { hashPassword } from "@/lib/password";
import { isValidNewPassword, PASSWORD_POLICY_MESSAGE } from "@/lib/password-policy";
import {
  assertTrustedMutation,
  clientAddress,
  enforceControlRateLimit,
  HttpSecurityError,
  httpSecurityErrorResponse,
  privateJson,
  readJsonObject,
  unexpectedErrorResponse,
} from "@/lib/http-security";

export async function GET(request: Request) {
  try {
    await enforceControlRateLimit(controlDb, `invite:view:ip:${clientAddress(request)}`, 60, 3600);
    const token = tokenValue(new URL(request.url).searchParams.get("token"));
    await enforceControlRateLimit(controlDb, `invite:view:${clientAddress(request)}:${token}`, 30, 3600);
    const invite = await controlDb.organizationInvite.findUnique({ where: { tokenHash: inviteHash(token) }, include: { organization: { select: { name: true, status: true } } } });
    if (!invite || invite.status !== "pending" || invite.expiresAt <= new Date()) return privateJson({ error: "Convite inválido, revogado ou expirado." }, { status: 404 });
    if (!["active", "trial"].includes(invite.organization.status)) throw new HttpSecurityError("A organização está indisponível para novos acessos. Consulte o administrador.", 403);
    const existing = await controlDb.user.findUnique({ where: { email: invite.email }, select: { id: true } });
    return privateJson({ invite: { email: invite.email, name: invite.name, roleKey: invite.roleKey, organization: invite.organization.name, expiresAt: invite.expiresAt, existingAccount: Boolean(existing) } });
  } catch (error) { return failure(error); }
}

export async function POST(request: Request) {
  try {
    assertTrustedMutation(request, { maximumBytes: 16_384 });
    await enforceControlRateLimit(controlDb, `invite:accept:ip:${clientAddress(request)}`, 20, 3600);
    const body = await readJsonObject(request, 16_384);
    const token = tokenValue(body.token);
    await enforceControlRateLimit(controlDb, `invite:accept:${clientAddress(request)}:${token}`, 10, 3600);
    const invite = await controlDb.organizationInvite.findUnique({ where: { tokenHash: inviteHash(token) }, include: { organization: { select: { id: true, name: true, status: true } } } });
    if (!invite || invite.status !== "pending" || invite.expiresAt <= new Date()) return privateJson({ error: "Convite inválido, revogado ou expirado." }, { status: 404 });
    if (!["active", "trial"].includes(invite.organization.status)) throw new HttpSecurityError("A organização está indisponível para novos acessos. Consulte o administrador.", 403);
    const db = await tenantDb(invite.organizationId);
    const role = await db.tenantRole.findFirst({ where: { key: invite.roleKey, active: true } });
    if (!role || role.key === "owner") throw new UserAccessInputError("O perfil deste convite não está mais disponível.");
    const existing = await controlDb.user.findUnique({ where: { email: invite.email } });
    const sessionUser = await currentUser();
    if (existing && sessionUser?.id !== existing.id) return privateJson({ error: "Esta conta já existe. Entre com o mesmo e-mail e abra o convite novamente.", code: "LOGIN_REQUIRED" }, { status: 409 });
    const name = (typeof body.name === "string" ? body.name : invite.name || "").trim();
    if (!existing && (name.length < 2 || name.length > 160)) throw new UserAccessInputError("Informe seu nome.");
    const password = typeof body.password === "string" ? body.password : "";
    if (!existing && !isValidNewPassword(password)) throw new UserAccessInputError(PASSWORD_POLICY_MESSAGE);
    const passwordHash = existing ? null : await hashPassword(password);
    const correlationId = randomUUID();
    const result = await controlDb.$transaction(async tx => {
      // Lock catalogue -> organization -> user -> invite. Administrative suspension
      // must not race a membership grant after the preliminary public lookup.
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(73890122)`;
      const organizations = await tx.$queryRaw<Array<{ status: string }>>`SELECT status FROM organizations WHERE id = ${invite.organizationId} FOR SHARE`;
      if (!organizations[0] || !["active", "trial"].includes(organizations[0].status)) throw new HttpSecurityError("A organização está indisponível para novos acessos. Consulte o administrador.", 403);
      if (existing) {
        const accounts = await tx.$queryRaw<Array<{ status: string; email: string }>>`SELECT status, email FROM users WHERE id = ${existing.id} FOR SHARE`;
        if (!accounts[0] || accounts[0].status !== "active" || accounts[0].email !== invite.email) throw new HttpSecurityError("A conta exige revisão antes de aceitar o convite.", 403);
      }
      // Rotation/revocation after the initial lookup must invalidate this request.
      const changed = await tx.organizationInvite.updateMany({ where: { id: invite.id, tokenHash: inviteHash(token), email: invite.email, roleKey: invite.roleKey, organizationId: invite.organizationId, status: "pending", expiresAt: { gt: new Date() } }, data: { status: "accepted", acceptedAt: new Date() } });
      if (!changed.count) throw new UserAccessInputError("O convite já foi utilizado, alterado ou revogado.");
      const user = existing || await tx.user.create({ data: { name, email: invite.email, passwordHash: passwordHash!, role: "user", status: "active", emailVerifiedAt: new Date() } });
      const previous = await tx.membership.findUnique({ where: { userId_organizationId: { userId: user.id, organizationId: invite.organizationId } } });
      if (previous) throw new HttpSecurityError("Você já possui um vínculo com esta organização. Solicite ao administrador a revisão do acesso.", 409);
      const membership = await tx.membership.create({ data: { userId: user.id, organizationId: invite.organizationId, role: role.key, status: "active" } });
      // Commit the control-plane grant last: failed tenant setup leaves the invite
      // pending and cannot create an active membership without its tenant profile.
      await db.$transaction(async tenantTx => {
        const currentRole = await tenantTx.tenantRole.findFirst({ where: { id: role.id, key: role.key, active: true } });
        if (!currentRole || currentRole.key === "owner") throw new UserAccessInputError("O perfil deste convite não está mais disponível.");
        const previousProfile = await tenantTx.tenantUserProfile.findUnique({ where: { userId: user.id }, include: { role: true, branchAccesses: true } });
        if (previousProfile && (previousProfile.status !== "active" || previousProfile.role.key === "owner" || previousProfile.roleId !== currentRole.id || (previousProfile.accessExpiresAt && previousProfile.accessExpiresAt <= new Date()))) throw new HttpSecurityError("O acesso existente exige revisão pelo administrador.", 403);
        const profile = await tenantTx.tenantUserProfile.upsert({ where: { userId: user.id }, update: { roleId: currentRole.id, displayName: user.name, email: user.email, lastSyncedAt: new Date() }, create: { userId: user.id, roleId: currentRole.id, displayName: user.name, email: user.email } });
        if (!previousProfile?.branchAccesses.length) {
          const primaryBranch = await tenantTx.branch.findFirst({ where: { primary: true, status: "active" }, select: { id: true } });
          if (primaryBranch) {
            await tenantTx.branchUserAccess.upsert({ where: { branchId_userProfileId: { branchId: primaryBranch.id, userProfileId: profile.id } }, update: {}, create: { branchId: primaryBranch.id, userProfileId: profile.id, canSell: true } });
            await tenantTx.tenantUserProfile.update({ where: { id: profile.id }, data: { activeBranchId: primaryBranch.id } });
          }
        }
        await tenantTx.tenantAuditEvent.create({ data: { actorId: user.id, action: "organization_invite.accepted", entityType: "membership", entityId: membership.id, correlationId, afterData: { email: user.email, roleKey: currentRole.key, inviteId: invite.id } } });
      });
      await tx.auditLog.create({ data: { userId: user.id, action: "organization_invite.accepted", entityType: "organization", entityId: invite.organizationId, metadata: { inviteId: invite.id, roleKey: role.key, correlationId } } });
      return { user, membership, newUser: !existing };
    }, { timeout: 15_000 });
    if (result.newUser) await createSession(result.user.id, invite.organizationId, false, result.user.passwordHash); else await setActiveOrganization(invite.organizationId);
    return privateJson({ ok: true, destination: "/erp", organization: invite.organization.name });
  } catch (error) { return failure(error); }
}

function tokenValue(value: unknown) { const token = typeof value === "string" ? value.trim() : ""; if (!/^[A-Za-z0-9_-]{40,100}$/.test(token)) throw new UserAccessInputError("Convite inválido."); return token; }
function failure(error: unknown) { if (isPlanCapacityError(error)) return privateJson({ error: PLAN_CAPACITY_MESSAGE }, { status: 409 }); if (error instanceof HttpSecurityError) return httpSecurityErrorResponse(error); if (error instanceof UserAccessInputError) return privateJson({ error: error.message }, { status: 400 }); if (error && typeof error === "object" && "code" in error && error.code === "P2002") return privateJson({ error: "O cadastro ou acesso foi atualizado. Entre na conta e abra o convite novamente.", code: "LOGIN_REQUIRED" }, { status: 409 }); return unexpectedErrorResponse("auth.invite", error); }
