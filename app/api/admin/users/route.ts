import { controlDb } from "@/db/control";
import { authErrorResponse, requireUser } from "@/lib/auth";
import { hashPassword, verifyPassword } from "@/lib/password";
import { isValidNewPassword, PASSWORD_POLICY_MESSAGE } from "@/lib/password-policy";
import { enforceControlRateLimit, HttpSecurityError, privateJson, readJsonObject } from "@/lib/http-security";

const projection = { id: true, name: true, email: true, status: true, lastLoginAt: true, createdAt: true, updatedAt: true } as const;

export async function GET(request: Request) {
  try {
    const actor = await requireUser("superadmin");
    const params = new URL(request.url).searchParams;
    const query = (params.get("q") || "").trim().slice(0, 160);
    const page = Math.min(10000, Math.max(1, Number.parseInt(params.get("page") || "1", 10) || 1));
    const where = { role: "superadmin", ...(query ? { OR: [{ name: { contains: query, mode: "insensitive" as const } }, { email: { contains: query, mode: "insensitive" as const } }] } : {}) };
    const [users, total] = await controlDb.$transaction([
      controlDb.user.findMany({ where, select: projection, orderBy: [{ name: "asc" }, { id: "asc" }], take: 50, skip: (page - 1) * 50 }),
      controlDb.user.count({ where }),
    ]);
    return privateJson({ users, total, page, pageSize: 50, actorId: actor.id });
  } catch (error) { return authErrorResponse(error); }
}

export async function POST(request: Request) {
  try {
    const actor = await requireUser("superadmin");
    await enforceControlRateLimit(controlDb, `admin:${actor.id}:users`, 10, 60);
    const body = await readJsonObject(request, 16_384);
    const action = body.action;
    if (!["create", "update", "revoke_sessions"].includes(String(action))) throw new HttpSecurityError("Operação inválida.");
    if (body.role !== undefined || body.organizationId !== undefined) throw new HttpSecurityError("Vínculos de clientes não são administrados nesta página.");
    if (typeof body.currentPassword !== "string" || !await verifyPassword(body.currentPassword, actor.passwordHash)) throw new HttpSecurityError("Confirme sua senha administrativa.", 403);
    const name = typeof body.name === "string" ? body.name.trim() : "";
    const email = typeof body.email === "string" ? body.email.trim().toLowerCase() : "";
    if (action !== "revoke_sessions" && (!name || name.length > 160)) throw new HttpSecurityError("Informe um nome com até 160 caracteres.");
    if (action === "create" && (email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))) throw new HttpSecurityError("E-mail inválido.");
    if (action === "create" && (typeof body.password !== "string" || !isValidNewPassword(body.password))) throw new HttpSecurityError(PASSWORD_POLICY_MESSAGE);
    if (action === "update" && body.status !== "active" && body.status !== "disabled") throw new HttpSecurityError("Situação inválida.");
    const passwordHash = action === "create" ? await hashPassword(body.password as string) : undefined;
    await controlDb.$transaction(async tx => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(73890123)`;
      const currentActor = await tx.user.findUnique({ where: { id: actor.id }, select: { role: true, status: true, passwordHash: true } });
      if (!currentActor || currentActor.role !== "superadmin" || currentActor.status !== "active" || currentActor.passwordHash !== actor.passwordHash) throw new HttpSecurityError("Seu acesso mudou. Entre novamente.", 403);
      let targetId: string;
      if (action === "create") {
        if (await tx.user.findUnique({ where: { email }, select: { id: true } })) throw new HttpSecurityError("Este e-mail já possui uma conta. Contas de clientes não são convertidas em administradores por esta operação.", 409);
        const target = await tx.user.create({ data: { name, email, passwordHash: passwordHash!, role: "superadmin", status: "active" }, select: { id: true } });
        targetId = target.id;
      } else {
        if (typeof body.id !== "string" || !body.id || body.id.length > 150) throw new HttpSecurityError("Usuário inválido.");
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`password-reset:${body.id}`}))`;
        const target = await tx.user.findUnique({ where: { id: body.id }, select: { id: true, role: true, status: true, updatedAt: true } });
        if (!target || target.role !== "superadmin") throw new HttpSecurityError("Administrador não encontrado.", 404);
        targetId = target.id;
        if (action === "update") {
          if (body.updatedAt !== target.updatedAt.toISOString()) throw new HttpSecurityError("O usuário foi alterado. Atualize antes de salvar.", 409);
          if (target.id === actor.id && body.status !== "active") throw new HttpSecurityError("Você não pode bloquear seu próprio acesso.");
          await tx.user.update({ where: { id: target.id }, data: { name, status: body.status as string } });
        }
        if (action === "revoke_sessions" || body.status === "disabled") await tx.session.deleteMany({ where: { userId: target.id } });
      }
      await tx.auditLog.create({ data: { userId: actor.id, action: `user.${action}`, entityType: "user", entityId: targetId, metadata: { source: "platform-users" } } });
    });
    return privateJson({ ok: true });
  } catch (error) { return authErrorResponse(error); }
}
