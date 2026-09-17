import { controlDb } from "@/db/control";
import { requireUser, authErrorResponse } from "@/lib/auth";
import { verifyPassword } from "@/lib/password";
import { enforceControlRateLimit, HttpSecurityError, privateJson, readJsonObject } from "@/lib/http-security";
import type { Prisma } from "@/generated/control/client";

function record(value: unknown): Record<string, unknown> { return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {}; }
export async function GET() {
  try {
    await requireUser("superadmin");
    const [rows, plans] = await Promise.all([
      controlDb.systemSetting.findMany({ where: { key: { in: ["saas", "signup"] } }, select: { key: true, value: true, updatedAt: true } }),
      controlDb.plan.findMany({ select: { id: true, name: true, visibility: true, active: true }, orderBy: { name: "asc" } }),
    ]);
    const saas = rows.find(row => row.key === "saas"), signup = rows.find(row => row.key === "signup");
    const platform = record(saas?.value), commercial = record(signup?.value), codes = record(commercial.billingPlanCodes);
    return privateJson({ name: typeof platform.name === "string" ? platform.name : "", domain: typeof platform.domain === "string" ? platform.domain : "", trialDays: typeof platform.trialDays === "number" ? platform.trialDays : 0, dueDay: typeof commercial.dueDay === "number" ? commercial.dueDay : 10, paymentMethods: Array.isArray(commercial.paymentMethods) ? commercial.paymentMethods.filter(value => value === "pix" || value === "boleto") : [], plans: plans.map(plan => ({ ...plan, billingCode: typeof codes[plan.id] === "string" ? codes[plan.id] : "" })), versions: { saas: saas?.updatedAt.toISOString() || null, signup: signup?.updatedAt.toISOString() || null } });
  } catch (error) { return authErrorResponse(error); }
}
export async function POST(request: Request) {
  try {
    const actor = await requireUser("superadmin");
    await enforceControlRateLimit(controlDb, `admin:${actor.id}:platform-settings`, 10, 60);
    const body = await readJsonObject(request, 32768);
    if (typeof body.currentPassword !== "string" || !await verifyPassword(body.currentPassword, actor.passwordHash)) throw new HttpSecurityError("Confirme sua senha administrativa.", 403);
    const name = typeof body.name === "string" ? body.name.trim() : "", domain = typeof body.domain === "string" ? body.domain.trim().toLowerCase() : "";
    if (!name || name.length > 160 || domain.length > 253 || !/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/.test(domain)) throw new HttpSecurityError("Informe nome e domínio válidos, sem protocolo ou caminho.");
    if (typeof body.trialDays !== "number" || !Number.isInteger(body.trialDays) || body.trialDays < 0 || body.trialDays > 90 || typeof body.dueDay !== "number" || !Number.isInteger(body.dueDay) || body.dueDay < 1 || body.dueDay > 28) throw new HttpSecurityError("Revise o período de teste (0 a 90 dias) e vencimento (1 a 28).");
    if (!Array.isArray(body.paymentMethods) || !body.paymentMethods.length || body.paymentMethods.some(value => value !== "pix" && value !== "boleto")) throw new HttpSecurityError("Escolha Pix ou boleto para a contratação externa.");
    const codes = record(body.billingPlanCodes), versions = record(body.versions);
    for (const value of Object.values(codes)) if (typeof value !== "string" || value.length > 100 || /[\r\n\0]/.test(value)) throw new HttpSecurityError("Código de plano externo inválido.");
    await controlDb.$transaction(async tx => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(73890122)`;
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(73890125)`;
      const plans = await tx.plan.findMany({ select: { id: true, active: true, visibility: true } });
      if (Object.keys(codes).some(id => !plans.some(plan => plan.id === id))) throw new HttpSecurityError("Um plano não existe mais. Recarregue a configuração.", 409);
      if (plans.some(plan => plan.active && plan.visibility === "public" && !String(codes[plan.id] || "").trim())) throw new HttpSecurityError("Informe o código do Billing para cada plano público ativo.");
      const rows = await tx.systemSetting.findMany({ where: { key: { in: ["saas", "signup"] } } });
      for (const key of ["saas", "signup"]) if (versions[key] !== (rows.find(row => row.key === key)?.updatedAt.toISOString() || null)) throw new HttpSecurityError("A configuração mudou. Recarregue antes de salvar.", 409);
      const saas = { ...record(rows.find(row => row.key === "saas")?.value), name, domain, trialDays: body.trialDays };
      const signup = { ...record(rows.find(row => row.key === "signup")?.value), paymentMethods: [...new Set(body.paymentMethods as string[])], dueDay: body.dueDay, billingPlanCodes: Object.fromEntries(Object.entries(codes).map(([key, value]) => [key, (value as string).trim()])) };
      for (const [key, value] of [["saas", saas], ["signup", signup]] as const) await tx.systemSetting.upsert({ where: { key }, create: { key, value: value as Prisma.InputJsonValue }, update: { value: value as Prisma.InputJsonValue } });
      await tx.auditLog.create({ data: { userId: actor.id, action: "platform.configuration_saved", entityType: "platform", metadata: { fields: ["name", "domain", "trialDays", "dueDay", "paymentMethods", "billingPlanCodes"] } } });
    });
    return privateJson({ ok: true });
  } catch (error) { return authErrorResponse(error); }
}
