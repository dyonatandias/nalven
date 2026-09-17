import { controlDb } from "@/db/control";
import { authErrorResponse, requireUser } from "@/lib/auth";
import { enforceControlRateLimit, HttpSecurityError, privateJson, readJsonObject } from "@/lib/http-security";

export async function PATCH(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const actor = await requireUser("superadmin");
    await enforceControlRateLimit(controlDb, `admin:${actor.id}:organizations`, 30, 60);
    const { id } = await context.params;
    if (!id || id.length > 150) throw new HttpSecurityError("Organização inválida.");
    const body = await readJsonObject(request, 8192);
    if (Object.keys(body).some(key => !["name", "ownerName", "email", "updatedAt"].includes(key))) throw new HttpSecurityError("Este formulário altera somente os dados de contato e identificação cadastral.");
    const name = text(body.name, "Nome", 160);
    const ownerName = text(body.ownerName, "Responsável", 160);
    const email = text(body.email, "E-mail", 254).toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new HttpSecurityError("E-mail inválido.");
    if (typeof body.updatedAt !== "string" || !Number.isFinite(Date.parse(body.updatedAt))) throw new HttpSecurityError("Versão do cadastro inválida. Recarregue a página.");
    const updated = await controlDb.$transaction(async tx => {
      const saved = await tx.organization.updateMany({ where: { id, updatedAt: new Date(body.updatedAt as string) }, data: { name, ownerName, email } });
      if (saved.count !== 1) throw new HttpSecurityError("A organização não está disponível ou foi alterada. Recarregue antes de salvar.", 409);
      await tx.auditLog.create({ data: { userId: actor.id, action: "organization.save", entityType: "organization", entityId: id, metadata: { source: "organization-profile", fields: ["name", "ownerName", "email"] } } });
      return tx.organization.findUniqueOrThrow({ where: { id }, select: { updatedAt: true } });
    });
    return privateJson({ ok: true, updatedAt: updated.updatedAt });
  } catch (error) { return authErrorResponse(error); }
}

function text(value: unknown, label: string, max: number) {
  if (typeof value !== "string" || !value.trim() || value.trim().length > max) throw new HttpSecurityError(`${label}: informe até ${max} caracteres.`);
  return value.trim();
}
