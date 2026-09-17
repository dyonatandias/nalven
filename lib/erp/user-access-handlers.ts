import { isPlanCapacityError, PLAN_CAPACITY_MESSAGE } from "@/lib/plan-capacity-error";
type UserAccessScope = { organization: { id: string }; access: { user: { id: string }; permissions: string[] } };
import { randomBytes, randomUUID } from "node:crypto";
import { controlDb, tenantDb } from "@/db";
import { AuthError, authErrorResponse } from "@/lib/auth";
import { assertSameOrigin, CustomerInputError } from "@/lib/erp/customer-input";
import { accessState, csvCell, deviceLabel, isStaleLogin, maskIp, needsAccessReview } from "@/lib/erp/user-access-control";
import { matches, PERMISSION_RESOURCES } from "@/lib/erp/permissions";
import { identifier, inviteHash, inviteInput, memberIds, memberInput, roleId, roleInput, UserAccessInputError } from "@/lib/erp/user-access-input";
import { HttpSecurityError, privateJson, readJsonObject } from "@/lib/http-security";

const auditActions = [
  "organization_invite.created", "organization_invite.rotated", "organization_invite.revoked", "organization_invite.accepted",
  "tenant_role.created", "tenant_role.updated", "tenant_role.status_changed", "membership.updated", "membership.bulk_updated",
  "membership.access_reviewed", "membership.sessions_revoked",
];

export async function getOrganizationUsers(request: Request, resolveScope: () => Promise<UserAccessScope>) {
  try {
    const { organization, access } = await resolveScope();
    const db = await tenantDb(organization.id);
    const now = new Date();
    const [memberships, roles, invites, branches, activity] = await Promise.all([
      controlDb.membership.findMany({
        where: { organizationId: organization.id },
        include: { user: { select: { id: true, name: true, email: true, status: true, emailVerifiedAt: true, lastLoginAt: true, createdAt: true, sessions: { where: { expiresAt: { gt: now } }, select: { id: true, expiresAt: true, createdAt: true, ipAddress: true, userAgent: true }, orderBy: { createdAt: "desc" }, take: 5 } } } },
        orderBy: { createdAt: "asc" },
      }),
      db.tenantRole.findMany({ orderBy: [{ system: "desc" }, { name: "asc" }] }),
      controlDb.organizationInvite.findMany({ where: { organizationId: organization.id }, select: { id: true, email: true, name: true, roleKey: true, status: true, expiresAt: true, acceptedAt: true, revokedAt: true, createdAt: true, invitedBy: { select: { name: true, email: true } } }, orderBy: { createdAt: "desc" }, take: 100 }),
      db.branch.findMany({ where: { status: "active" }, select: { id: true, code: true, name: true, primary: true }, orderBy: [{ primary: "desc" }, { name: "asc" }] }),
      db.tenantAuditEvent.findMany({ where: { action: { in: auditActions } }, select: { id: true, actorId: true, action: true, entityType: true, entityId: true, correlationId: true, afterData: true, createdAt: true }, orderBy: { createdAt: "desc" }, take: 40 }),
    ]);
    const userIds = memberships.map(item => item.userId);
    const profiles = userIds.length ? await db.tenantUserProfile.findMany({
      where: { userId: { in: userIds } },
      select: { id: true, userId: true, displayName: true, email: true, jobTitle: true, department: true, phone: true, status: true, accessExpiresAt: true, lastAccessReviewAt: true, accessReviewedBy: true, activeBranchId: true, lastSyncedAt: true, branchAccesses: { select: { branchId: true, canSell: true, canManageStock: true, canIssueFiscal: true, primary: true }, orderBy: { branchId: "asc" } } },
    }) : [];
    const profileByUser = new Map(profiles.map(profile => [profile.userId, profile]));
    const roleByKey = new Map(roles.map(role => [role.key, role]));
    const actorById = new Map(memberships.map(item => [item.userId, { name: item.user.name, email: item.user.email }]));
    const members = memberships.map(item => {
      const profile = profileByUser.get(item.userId), state = accessState(profile, item.status, now);
      const stale = isStaleLogin(item.user.lastLoginAt, item.createdAt, now), reviewDue = item.role !== "owner" && needsAccessReview(profile, item.createdAt, now);
      const issues = [
        ...(!item.user.emailVerifiedAt ? ["E-mail ainda não verificado"] : []),
        ...(stale && state === "active" ? [item.user.lastLoginAt ? "Sem acesso há mais de 45 dias" : "Nunca realizou acesso"] : []),
        ...(reviewDue && state === "active" ? ["Revisão de acesso vencida"] : []),
        ...(!profile && item.role !== "owner" ? ["Perfil operacional não sincronizado"] : []),
        ...(profile && !profile.branchAccesses.length && item.role !== "owner" && state === "active" ? ["Sem filial autorizada"] : []),
      ];
      return {
        id: item.id, roleKey: item.role, roleName: roleByKey.get(item.role)?.name || item.role, status: item.status, accessState: state, createdAt: item.createdAt,
        profile: profile ? { ...profile, branchAccesses: profile.branchAccesses } : null,
        user: { id: item.user.id, name: item.user.name, email: item.user.email, status: item.user.status, emailVerifiedAt: item.user.emailVerifiedAt, lastLoginAt: item.user.lastLoginAt, createdAt: item.user.createdAt, activeSessions: item.user.sessions.length, sessions: item.user.sessions.map(session => ({ id: session.id, createdAt: session.createdAt, expiresAt: session.expiresAt, device: deviceLabel(session.userAgent), ip: maskIp(session.ipAddress) })) },
        security: { stale, reviewDue, issues, score: Math.max(0, 100 - issues.length * 20) },
      };
    });
    const normalizedInvites = invites.map(item => ({ ...item, status: item.status === "pending" && item.expiresAt <= now ? "expired" : item.status }));
    const data = {
      members,
      roles: roles.map(role => ({ ...role, permissions: stringArray(role.permissions), _count: { members: memberships.filter(item => item.role === role.key).length } })),
      invites: normalizedInvites,
      branches,
      activity: activity.map(event => ({ ...event, id: String(event.id), actor: event.actorId ? actorById.get(event.actorId) || null : null })),
      permissionResources: PERMISSION_RESOURCES.map(([key, label]) => ({ key, label })),
      capabilities: { canWrite: matches(access.permissions, "users.write") },
      generatedAt: now.toISOString(),
      summary: {
        active: members.filter(item => item.accessState === "active").length,
        disabled: members.filter(item => item.accessState === "disabled").length,
        expired: members.filter(item => item.accessState === "expired").length,
        pending: normalizedInvites.filter(item => item.status === "pending").length,
        roles: roles.filter(item => item.active).length,
        sessions: members.reduce((sum, item) => sum + item.user.activeSessions, 0),
        stale: members.filter(item => item.security.stale && item.accessState === "active").length,
        reviewDue: members.filter(item => item.security.reviewDue && item.accessState === "active").length,
        branchCoverage: members.filter(item => item.roleKey === "owner" || (item.profile?.branchAccesses.length || 0) > 0).length,
      },
    };
    if (new URL(request.url).searchParams.get("format") === "csv") return csvResponse(members);
    return Response.json(data);
  } catch (error) { return failure(error); }
}

export async function postOrganizationUsers(request: Request, resolveScope: () => Promise<UserAccessScope>) {
  try {
    assertSameOrigin(request);
    const { organization, access } = await resolveScope();
    const db = await tenantDb(organization.id);
    const body = await readJsonObject(request, 1_048_576);
    const correlationId = randomUUID();

    if (body.action === "role.create") {
      const input = roleInput(body);
      const role = await db.$transaction(async tx => {
        const created = await tx.tenantRole.create({ data: input });
        await tx.tenantAuditEvent.create({ data: { actorId: access.user.id, action: "tenant_role.created", entityType: "tenant_role", entityId: String(created.id), correlationId, afterData: { key: created.key, name: created.name, permissions: input.permissions, active: input.active } } });
        return created;
      });
      return Response.json({ role, correlationId }, { status: 201 });
    }

    if (body.action === "role.update") {
      const id = roleId(body.roleId), before = await db.tenantRole.findUnique({ where: { id } });
      if (!before) return Response.json({ error: "Perfil não encontrado." }, { status: 404 });
      if (before.key === "owner") throw new UserAccessInputError("O perfil de proprietário é protegido.");
      const input = roleInput({ ...body, key: before.key });
      if (!input.active && await controlDb.membership.count({ where: { organizationId: organization.id, role: before.key, status: "active" } })) throw new UserAccessInputError("Transfira os usuários ativos antes de inativar este perfil.");
      const role = await db.$transaction(async tx => {
        const updated = await tx.tenantRole.update({ where: { id }, data: { name: input.name, description: input.description, permissions: input.permissions, active: input.active } });
        await tx.tenantAuditEvent.create({ data: { actorId: access.user.id, action: before.active === updated.active ? "tenant_role.updated" : "tenant_role.status_changed", entityType: "tenant_role", entityId: String(id), correlationId, beforeData: { name: before.name, permissions: before.permissions, active: before.active }, afterData: { name: updated.name, permissions: input.permissions, active: updated.active } } });
        return updated;
      });
      return Response.json({ role, correlationId });
    }

    if (body.action === "invite.create") {
      const input = inviteInput(body);
      const role = await db.tenantRole.findFirst({ where: { key: input.roleKey, active: true } });
      if (!role || role.key === "owner") throw new UserAccessInputError("Perfil indisponível para convite.");
      const existing = await controlDb.user.findUnique({ where: { email: input.email }, include: { memberships: { where: { organizationId: organization.id } } } });
      if (existing?.memberships.length) throw new UserAccessInputError("Este usuário já pertence à organização.");
      const token = randomBytes(32).toString("base64url"), expiresAt = new Date(Date.now() + input.expiresInDays * 86_400_000);
      const [, invite] = await controlDb.$transaction([
        controlDb.organizationInvite.updateMany({ where: { organizationId: organization.id, email: input.email, status: "pending" }, data: { status: "revoked", revokedAt: new Date() } }),
        controlDb.organizationInvite.create({ data: { organizationId: organization.id, email: input.email, name: input.name, roleKey: role.key, tokenHash: inviteHash(token), invitedById: access.user.id, expiresAt } }),
      ]);
      await db.tenantAuditEvent.create({ data: { actorId: access.user.id, action: "organization_invite.created", entityType: "organization_invite", entityId: invite.id, correlationId, afterData: { email: invite.email, roleKey: invite.roleKey, expiresAt: invite.expiresAt } } });
      return Response.json({ invite: { id: invite.id, email: invite.email, roleKey: invite.roleKey, expiresAt: invite.expiresAt }, acceptanceUrl: `${new URL(request.url).origin}/convite/${token}`, correlationId }, { status: 201 });
    }

    if (body.action === "invite.rotate") {
      const inviteId = identifier(body.inviteId, "Convite inválido.");
      const before = await controlDb.organizationInvite.findFirst({ where: { id: inviteId, organizationId: organization.id, status: "pending" } });
      if (!before) return Response.json({ error: "Convite pendente não encontrado." }, { status: 404 });
      const token = randomBytes(32).toString("base64url"), expiresAt = new Date(Date.now() + 7 * 86_400_000);
      await controlDb.organizationInvite.update({ where: { id: inviteId }, data: { tokenHash: inviteHash(token), expiresAt } });
      await db.tenantAuditEvent.create({ data: { actorId: access.user.id, action: "organization_invite.rotated", entityType: "organization_invite", entityId: inviteId, correlationId, afterData: { email: before.email, expiresAt } } });
      return Response.json({ acceptanceUrl: `${new URL(request.url).origin}/convite/${token}`, expiresAt, correlationId });
    }

    if (body.action === "invite.revoke" || body.action === "invite.bulk_revoke") {
      const ids = body.action === "invite.revoke" ? [identifier(body.inviteId, "Convite inválido.")] : inviteIds(body.inviteIds);
      const changed = await controlDb.organizationInvite.updateMany({ where: { id: { in: ids }, organizationId: organization.id, status: "pending" }, data: { status: "revoked", revokedAt: new Date() } });
      if (!changed.count) return Response.json({ error: "Nenhum convite pendente foi encontrado." }, { status: 404 });
      await db.tenantAuditEvent.create({ data: { actorId: access.user.id, action: "organization_invite.revoked", entityType: "organization_invite", correlationId, afterData: { inviteIds: ids, count: changed.count } } });
      return Response.json({ ok: true, count: changed.count, correlationId });
    }

    if (body.action === "member.update") return await updateMember(body, organization.id, access.user.id, correlationId, db);

    if (body.action === "member.sessions_revoke") {
      const membershipId = identifier(body.membershipId, "Usuário inválido.");
      const membership = await memberForAction(membershipId, organization.id);
      if (membership.role === "owner") throw new UserAccessInputError("As sessões do proprietário não podem ser encerradas por esta operação.");
      const deleted = await controlDb.session.deleteMany({ where: { userId: membership.userId, expiresAt: { gt: new Date() } } });
      await db.tenantAuditEvent.create({ data: { actorId: access.user.id, action: "membership.sessions_revoked", entityType: "membership", entityId: membership.id, correlationId, afterData: { userId: membership.userId, sessions: deleted.count } } });
      return Response.json({ ok: true, count: deleted.count, correlationId });
    }

    if (body.action === "member.review") {
      const membershipId = identifier(body.membershipId, "Usuário inválido."), membership = await memberForAction(membershipId, organization.id);
      if (membership.role === "owner") throw new UserAccessInputError("O acesso proprietário é permanente e protegido.");
      const reviewedAt = new Date();
      await db.$transaction(async tx => {
        await tx.tenantUserProfile.update({ where: { userId: membership.userId }, data: { lastAccessReviewAt: reviewedAt, accessReviewedBy: access.user.id } });
        await tx.tenantAuditEvent.create({ data: { actorId: access.user.id, action: "membership.access_reviewed", entityType: "membership", entityId: membership.id, correlationId, afterData: { reviewedAt, reviewedBy: access.user.id } } });
      });
      return Response.json({ ok: true, reviewedAt, correlationId });
    }

    if (body.action === "member.bulk_update") {
      const ids = memberIds(body), status = body.status === "disabled" ? "disabled" : body.status === "active" ? "active" : null;
      if (!status && body.revokeSessions !== true) throw new UserAccessInputError("Informe uma ação em lote válida.");
      return await controlDb.$transaction(async control => {
        await control.$executeRaw`SELECT pg_advisory_xact_lock(73890122)`;
        await control.$queryRaw`SELECT id FROM memberships WHERE organization_id = ${organization.id} ORDER BY id FOR UPDATE`;
        const memberships = await control.membership.findMany({ where: { id: { in: ids }, organizationId: organization.id }, select: { id: true, userId: true, role: true, status: true } });
        if (memberships.length !== ids.length) throw new UserAccessInputError("Um dos usuários não pertence à organização.");
        if (memberships.some(item => item.role === "owner")) throw new UserAccessInputError("O proprietário não pode ser alterado em lote.");
        if (status === "disabled" && memberships.some(item => item.userId === access.user.id)) throw new UserAccessInputError("Você não pode bloquear o próprio acesso.");
        if (status) await control.membership.updateMany({ where: { id: { in: ids }, organizationId: organization.id }, data: { status } });
        let sessions = 0;
        if (status === "disabled" || body.revokeSessions === true) sessions = (await control.session.deleteMany({ where: { userId: { in: memberships.map(item => item.userId) }, expiresAt: { gt: new Date() } } })).count;
        await control.auditLog.create({ data: { userId: access.user.id, action: "organization.memberships_updated", entityType: "organization", entityId: organization.id, metadata: { membershipIds: ids, status, sessionsRevoked: sessions, correlationId } } });
        await db.$transaction(async tx => {
          if (status) await tx.tenantUserProfile.updateMany({ where: { userId: { in: memberships.map(item => item.userId) } }, data: { status, lastSyncedAt: new Date() } });
          await tx.tenantAuditEvent.create({ data: { actorId: access.user.id, action: "membership.bulk_updated", entityType: "membership", correlationId, afterData: { membershipIds: ids, status, revokeSessions: body.revokeSessions === true } } });
        });
        return Response.json({ ok: true, count: memberships.length, sessions, correlationId });
      }, { timeout: 15_000 });
    }

    throw new UserAccessInputError("Ação de acesso inválida.");
  } catch (error) { return failure(error); }
}

async function updateMember(body: Record<string, unknown>, organizationId: string, actorId: string, correlationId: string, db: Awaited<ReturnType<typeof tenantDb>>) {
  const input = memberInput(body);
  return controlDb.$transaction(async control => {
    // Keep the grant uncommitted until tenant setup succeeds. Never restore an old
    // snapshot with an unconditional UPDATE after another request may have changed it.
    await control.$executeRaw`SELECT pg_advisory_xact_lock(73890122)`;
    await control.$queryRaw`SELECT id FROM memberships WHERE id = ${input.membershipId} AND organization_id = ${organizationId} FOR UPDATE`;
    const membership = await control.membership.findFirst({ where: { id: input.membershipId, organizationId }, include: { user: true } });
    if (!membership) return Response.json({ error: "Usuário não encontrado." }, { status: 404 });
    if (membership.role === "owner") throw new UserAccessInputError("A propriedade da organização não pode ser alterada nesta operação.");
    if (membership.userId === actorId && input.status !== "active") throw new UserAccessInputError("Você não pode bloquear o próprio acesso.");
    const role = await db.tenantRole.findFirst({ where: { key: input.roleKey, active: true } });
    if (!role || role.key === "owner") throw new UserAccessInputError("Perfil inválido.");
    if (input.branchAccesses) {
      const count = await db.branch.count({ where: { id: { in: input.branchAccesses.map(item => item.branchId) }, status: "active" } });
      if (count !== input.branchAccesses.length) throw new UserAccessInputError("Uma das filiais está inativa ou não existe.");
    }
    await control.membership.update({ where: { id: membership.id }, data: { role: role.key, status: input.status } });
    const revokedSessions = input.status === "disabled" ? (await control.session.deleteMany({ where: { userId: membership.userId, expiresAt: { gt: new Date() } } })).count : 0;
    await control.auditLog.create({ data: { userId: actorId, action: "organization.membership_updated", entityType: "organization", entityId: organizationId, metadata: { membershipId: membership.id, role: role.key, status: input.status, sessionsRevoked: revokedSessions, correlationId } } });
    await db.$transaction(async tx => {
      const current = await tx.tenantUserProfile.findUnique({ where: { userId: membership.userId }, include: { branchAccesses: true } });
      const profile = await tx.tenantUserProfile.upsert({
        where: { userId: membership.userId },
        update: { roleId: role.id, displayName: membership.user.name, email: membership.user.email, status: input.status, jobTitle: input.jobTitle, department: input.department, phone: input.phone, accessExpiresAt: input.accessExpiresAt, lastSyncedAt: new Date() },
        create: { userId: membership.userId, roleId: role.id, displayName: membership.user.name, email: membership.user.email, status: input.status, jobTitle: input.jobTitle, department: input.department, phone: input.phone, accessExpiresAt: input.accessExpiresAt },
      });
      if (input.branchAccesses) {
        await tx.branchUserAccess.deleteMany({ where: { userProfileId: profile.id } });
        if (input.branchAccesses.length) await tx.branchUserAccess.createMany({ data: input.branchAccesses.map(item => ({ ...item, userProfileId: profile.id })) });
        const activeBranchId = input.branchAccesses.find(item => item.primary)?.branchId || input.branchAccesses.find(item => item.branchId === current?.activeBranchId)?.branchId || input.branchAccesses[0]?.branchId || null;
        await tx.tenantUserProfile.update({ where: { id: profile.id }, data: { activeBranchId } });
      } else if (!current) {
        const primaryBranch = await tx.branch.findFirst({ where: { primary: true, status: "active" }, select: { id: true } });
        if (primaryBranch) {
          await tx.branchUserAccess.create({ data: { branchId: primaryBranch.id, userProfileId: profile.id, canSell: true, primary: true } });
          await tx.tenantUserProfile.update({ where: { id: profile.id }, data: { activeBranchId: primaryBranch.id } });
        }
      }
      await tx.tenantAuditEvent.create({ data: { actorId, action: "membership.updated", entityType: "membership", entityId: membership.id, correlationId, beforeData: { roleKey: membership.role, status: membership.status, profile: current ? profileSnapshot(current) : null }, afterData: { roleKey: role.key, status: input.status, profile: { jobTitle: input.jobTitle, department: input.department, phone: input.phone, accessExpiresAt: input.accessExpiresAt, branches: input.branchAccesses } } } });
    });
    return Response.json({ ok: true, revokedSessions, correlationId });
  }, { timeout: 15_000 });
}

async function memberForAction(id: string, organizationId: string) {
  const membership = await controlDb.membership.findFirst({ where: { id, organizationId }, select: { id: true, userId: true, role: true } });
  if (!membership) throw new UserAccessInputError("Usuário não encontrado.");
  return membership;
}

function inviteIds(value: unknown) {
  if (!Array.isArray(value) || !value.length || value.length > 100) throw new UserAccessInputError("Selecione entre 1 e 100 convites.");
  return [...new Set(value.map(item => identifier(item, "Convite inválido.")))];
}
function profileSnapshot(value: { jobTitle: string | null; department: string | null; phone: string | null; accessExpiresAt: Date | null; branchAccesses: Array<{ branchId: number; canSell: boolean; canManageStock: boolean; canIssueFiscal: boolean; primary: boolean }> }) { return { jobTitle: value.jobTitle, department: value.department, phone: value.phone, accessExpiresAt: value.accessExpiresAt, branches: value.branchAccesses }; }
function stringArray(value: unknown) { return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : []; }
function csvResponse(members: Array<{ user: { name: string; email: string; lastLoginAt: Date | null; activeSessions: number }; roleName: string; accessState: string; profile: { jobTitle: string | null; department: string | null; accessExpiresAt: Date | null; branchAccesses: unknown[] } | null; security: { score: number } }>) {
  const rows = [["Nome", "E-mail", "Perfil", "Status", "Cargo", "Departamento", "Filiais", "Último acesso", "Sessões", "Saúde"], ...members.map(item => [item.user.name, item.user.email, item.roleName, item.accessState, item.profile?.jobTitle || "", item.profile?.department || "", item.profile?.branchAccesses.length || 0, item.user.lastLoginAt?.toISOString() || "Nunca", item.user.activeSessions, `${item.security.score}%`])];
  return new Response(`\uFEFF${rows.map(row => row.map(csvCell).join(";")).join("\n")}`, { headers: { "content-type": "text/csv; charset=utf-8", "content-disposition": "attachment; filename=usuarios-acessos.csv", "cache-control": "no-store" } });
}
function failure(error: unknown) { if (isPlanCapacityError(error)) return privateJson({ error: PLAN_CAPACITY_MESSAGE }, { status: 409 }); if (error instanceof HttpSecurityError) return authErrorResponse(error); if (error instanceof UserAccessInputError || error instanceof CustomerInputError) return Response.json({ error: error.message }, { status: error.message.includes("Origem") ? 403 : 400 }); if (error && typeof error === "object" && "code" in error && error.code === "P2002") return Response.json({ error: "Já existe um perfil ou convite com estes dados." }, { status: 409 }); if (error instanceof AuthError) return authErrorResponse(error); console.error("erp-users",{error:error instanceof Error?error.name:typeof error});return Response.json({ error: "Não foi possível gerenciar os acessos." }, { status: 500 }); }
