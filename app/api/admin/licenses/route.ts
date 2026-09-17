import { controlDb } from "@/db/control";
import { authErrorResponse, requireUser } from "@/lib/auth";
import { billingSettings } from "@/lib/billing/client";
import { licensePolicy } from "@/lib/billing/license-policy";
import { verifyPassword } from "@/lib/password";
import { LicenseDeniedError, tenantLicense } from "@/lib/billing/license";
import { enforceControlRateLimit, HttpSecurityError, privateJson, readJsonObject } from "@/lib/http-security";

export async function GET(request: Request) {
  try {
    await requireUser("superadmin");
    const params = new URL(request.url).searchParams;
    const q = (params.get("q") || "").trim().slice(0, 160);
    const page = Math.min(10000, Math.max(1, Number.parseInt(params.get("page") || "1", 10) || 1));
    const where = q ? { organization: { name: { contains: q, mode: "insensitive" as const } } } : {};
    const [accounts, total] = await controlDb.$transaction([
      controlDb.billingAccount.findMany({ where, select: { id: true, organizationId: true, licenseStatus: true, subscriptionStatus: true, lastSyncedAt: true, organization: { select: { name: true } } }, orderBy: [{ updatedAt: "desc" }, { id: "asc" }], take: 50, skip: (page - 1) * 50 }),
      controlDb.billingAccount.count({ where }),
    ]);
    const settings = await billingSettings();
    const policy = await controlDb.systemSetting.findUnique({ where: { key: "billing_license_policy" }, select: { updatedAt: true, value: true } });
    const effective = licensePolicy(policy?.value) || settings;
    return privateJson({ accounts, total, page, pageSize: 50, timeoutMs: effective.licenseTimeoutMs, cacheSeconds: effective.licenseCacheSeconds, policyVersion: policy?.updatedAt.toISOString() || null });
  } catch (error) { return authErrorResponse(error); }
}

export async function POST(request: Request) {
  try {
    const actor = await requireUser("superadmin");
    await enforceControlRateLimit(controlDb, `admin:${actor.id}:licenses`, 10, 60);
    const body = await readJsonObject(request, 4096);
    if (body.action === "policy.save") {
      const policy = licensePolicy(body);
      if (!policy) throw new HttpSecurityError("Informe timeout inteiro entre 1000 e 30000 ms e cache inteiro entre 30 e 3600 segundos.");
      if (typeof body.currentPassword !== "string" || !await verifyPassword(body.currentPassword, actor.passwordHash)) throw new HttpSecurityError("Confirme sua senha administrativa.", 403);
      await controlDb.$transaction(async tx => {
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(73890124)`;
        const current = await tx.systemSetting.findUnique({ where: { key: "billing_license_policy" }, select: { updatedAt: true } });
        if (body.policyVersion !== (current?.updatedAt.toISOString() || null)) throw new HttpSecurityError("A política mudou. Recarregue a página antes de salvar.", 409);
        await tx.systemSetting.upsert({ where: { key: "billing_license_policy" }, create: { key: "billing_license_policy", value: policy }, update: { value: policy } });
        await tx.auditLog.create({ data: { userId: actor.id, action: "license.policy_saved", entityType: "license_policy", entityId: "billing_license_policy" } });
      });
      return privateJson({ ok: true });
    }
    if (body.action !== "verify" || typeof body.organizationId !== "string" || !body.organizationId || body.organizationId.length > 150) throw new HttpSecurityError("Solicitação inválida.");
    let license;
    try { license = await tenantLicense(body.organizationId, { force: true }); }
    catch (error) {
      if (!(error instanceof LicenseDeniedError)) throw error;
      await controlDb.auditLog.create({ data: { userId: actor.id, action: "license.verify_denied", entityType: "organization", entityId: body.organizationId } });
      return privateJson({ error: error.message }, { status: 403 });
    }
    await controlDb.auditLog.create({ data: { userId: actor.id, action: "license.verify", entityType: "organization", entityId: body.organizationId } });
    return privateJson({ valid: license.valida, checkedAt: new Date().toISOString() });
  } catch (error) { return authErrorResponse(error); }
}
