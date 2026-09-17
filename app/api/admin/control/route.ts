import { controlDb } from "@/db/control";
import { authErrorResponse, requireUser } from "@/lib/auth";
import { enforceControlRateLimit, HttpSecurityError, privateJson, readJsonObject } from "@/lib/http-security";

export async function GET(request: Request) {
  try {
    await requireUser("superadmin");
    const section = new URL(request.url).searchParams.get("section");
    if (section === "templates") return privateJson({ templates: await controlDb.emailTemplate.findMany({ select: { id: true, name: true, subject: true, body: true, active: true }, orderBy: { name: "asc" } }) });
    if (section === "announcements") return privateJson({ announcements: await controlDb.announcement.findMany({ select: { id: true, title: true, message: true, audience: true, level: true, active: true }, orderBy: { createdAt: "desc" }, take: 100 }) });
    if (section) throw new HttpSecurityError("Seção administrativa inválida.");
    throw new HttpSecurityError("Use uma seção administrativa específica.", 410);
  } catch (error) { return authErrorResponse(error); }
}

export async function POST(request: Request) {
  try {
    const actor = await requireUser("superadmin");
    await enforceControlRateLimit(controlDb, `admin:${actor.id}:control`, 90, 60);
    const body = await readJsonObject(request, 1_048_576);
    const action = String(body.action || "");
    const entityType = action.split(".")[0] || "platform";
    let entityId: string | undefined;
    if (action === "content.save") {
      throw new HttpSecurityError("Use a página Site público para editar conteúdo com controle de versão.", 410);
    } else if (action === "plan.save") {
      throw new HttpSecurityError("Use a página Planos para configurar visibilidade e recursos.", 410);
    } else if (action === "organization.save") {
      throw new HttpSecurityError("Use a página individual da organização para gerenciar cadastro e plano.", 410);
    } else if (action === "user.save") {
      throw new HttpSecurityError("Use a gestão de usuários da plataforma ou a página da organização.", 410);
    } else if (action === "integration.save") {
      throw new HttpSecurityError("Use as páginas específicas de integração financeira e SMTP.", 410);
    } else if (action === "template.save") {
      entityId = required(body.id);
      await controlDb.emailTemplate.update({ where: { id: entityId }, data: { name: limited(body.name, 160), subject: limited(body.subject, 500), body: limited(body.body, 50000), active: body.active === true } });
    } else if (action === "announcement.create") {
      const audience = String(body.audience || "all"), level = String(body.level || "info");
      if (audience !== "all" || !["info", "warning", "error"].includes(level)) throw new HttpSecurityError("Público ou tipo de comunicado inválido.");
      const created = await controlDb.announcement.create({ data: { title: limited(body.title, 160), message: limited(body.message, 5000), audience, level } }); entityId = created.id;
    } else if (action === "announcement.toggle") {
      entityId = required(body.id); await controlDb.announcement.update({ where: { id: entityId }, data: { active: body.active === true } });
    } else if (action === "webhook.create") {
      throw new HttpSecurityError("Webhooks centrais de saída não possuem serviço de entrega. Consulte a página Webhooks.", 410);
    } else if (action === "webhook.toggle") {
      throw new HttpSecurityError("Webhooks centrais de saída não possuem serviço de entrega. Consulte a página Webhooks.", 410);
    } else if (action === "domain.create") {
      const organizationId = required(body.organizationId); const hostname = required(body.hostname).toLowerCase();
      if (!/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,}$/.test(hostname)) throw new Error("Domínio inválido.");
      const created = await controlDb.organizationDomain.create({ data: { organizationId, hostname, primary: body.primary === true } }); entityId = created.id;
    } else if (action === "settings.save") {
      throw new HttpSecurityError("Use as páginas específicas de configuração.", 410);
    } else throw new Error("Ação administrativa desconhecida.");
    await controlDb.auditLog.create({ data: { userId: actor.id, action, entityType, entityId, metadata: { source: "admin-control" } } });
    return privateJson({ ok: true });
  } catch (error) { return authErrorResponse(error); }
}

function required(value: unknown) { const text = String(value || "").trim(); if (!text) throw new Error("Campo obrigatório ausente."); return text; }
function limited(value: unknown, maximum: number) { const text = required(value); if (text.length > maximum || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(text)) throw new Error("Campo inválido."); return text; }
