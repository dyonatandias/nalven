import { currentMembership, currentUser, AuthError, authErrorResponse } from "@/lib/auth";
import { controlDb } from "@/db/control";
import { assertTenantPermission } from "@/lib/erp/permissions";
import { ERP_MODULES } from "@/lib/erp/modules";
import { planAllows } from "@/lib/erp/plan-features";
import { HttpSecurityError, httpSecurityErrorResponse, privateJson } from "@/lib/http-security";
import { billingClient, BillingError } from "./client";
import { PortalLicenseDataError, portalLicensePayload, type PortalLicenseData } from "./portal-license-data";

export type PortalLicenseContext = { organizationId: string; userId: string; externalId: string };
type Projection = ReturnType<typeof portalLicensePayload> & { checkedAt: string };
type CacheEntry = { data?: Projection; storedAt?: number; pending?: Promise<Projection> };
const cache = new Map<string, CacheEntry>();
const CACHE_TTL = 15_000;

export async function portalLicenseContext(request: Request): Promise<PortalLicenseContext> {
  const user = await currentUser(); if (!user) throw new AuthError(401);
  const membership = await currentMembership(user); if (!membership) throw new AuthError(403);
  const expected = request.headers.get("x-organization-id");
  if (expected !== null && expected !== membership.organizationId) throw new HttpSecurityError("A organização ativa mudou. Atualize a página antes de continuar.", 409);
  await assertTenantPermission(membership.organizationId, "billing.read");
  const account = await controlDb.billingAccount.findUnique({ where: { organizationId: membership.organizationId }, select: { externalId: true } });
  return { organizationId: membership.organizationId, userId: user.id, externalId: account?.externalId || membership.organizationId };
}

export async function readPortalLicense(context: PortalLicenseContext, query: URLSearchParams): Promise<PortalLicenseData> {
  const refresh = query.get("refresh");
  if (query.getAll("refresh").length > 1 || (refresh !== null && refresh !== "0" && refresh !== "1")) throw new HttpSecurityError("Parâmetro de atualização inválido.", 400);
  // Local plan configuration is deliberately never part of the remote cache.
  const [organization, remote] = await Promise.all([
    controlDb.organization.findUniqueOrThrow({ where: { id: context.organizationId }, select: { modules: true, plan: { select: { id: true, name: true, code: true } } } }),
    loadLicense(context, refresh === "1"),
  ]);
  const expectedRemoteCode = organization.plan.code ? organization.plan.code.toLowerCase() : null;
  const services = planAllows(organization.modules, "service-orders");
  const applicationPlan = { id: organization.plan.id, name: organization.plan.name, expectedRemoteCode, modules: ERP_MODULES.map(module => ({ id: module.id, name: module.id === "products" && !services ? "Produtos" : module.label, enabled: planAllows(organization.modules, module.id) })) };
  const comparison = { plan: expectedRemoteCode && remote.data.license.plan.code ? expectedRemoteCode === remote.data.license.plan.code ? "match" as const : "different" as const : "unknown" as const };
  const warnings = [...remote.data.warnings];
  if (comparison.plan === "different") warnings.push("O plano informado pelo Billing difere do vínculo configurado no sistema. Solicite revisão; nenhuma permissão foi alterada por esta consulta.");
  if (comparison.plan === "unknown") warnings.push("Não há informações suficientes para confirmar a correspondência entre o plano local e o remoto.");
  return { license: remote.data.license, applicationPlan, comparison, source: { name: "billing_headless", checkedAt: remote.data.checkedAt, cached: remote.cached }, warnings, capabilities: { canRefresh: true, canExportDiagnostic: true, canRotate: false }, generatedAt: new Date().toISOString() };
}

async function loadLicense(context: PortalLicenseContext, refresh: boolean): Promise<{ data: Projection; cached: boolean }> {
  const key = JSON.stringify([context.organizationId, context.externalId]);
  let entry = cache.get(key);
  if (!entry) { while (cache.size >= 60) cache.delete(cache.keys().next().value!); entry = {}; cache.set(key, entry); }
  else { cache.delete(key); cache.set(key, entry); }
  if (!refresh && entry.data && Date.now() - (entry.storedAt || 0) < CACHE_TTL) return { data: entry.data, cached: true };
  if (entry.pending) return { data: await entry.pending, cached: false };
  const current = entry;
  // A failed explicit refresh must not silently restore an old active license.
  current.data = undefined; current.storedAt = undefined;
  const pending = billingClient.license(context.externalId).then(value => {
    const data = { ...portalLicensePayload(value), checkedAt: new Date().toISOString() };
    if (cache.get(key) === current) { current.data = data; current.storedAt = Date.now(); }
    return data;
  }).finally(() => { if (current.pending === pending) current.pending = undefined; });
  current.pending = pending;
  return { data: await pending, cached: false };
}

export function portalLicenseFailure(error: unknown) {
  if (error instanceof HttpSecurityError) return httpSecurityErrorResponse(error);
  if (error instanceof PortalLicenseDataError) return privateJson({ error: "O serviço de licença retornou dados que não puderam ser validados. Tente atualizar novamente.", retryable: true }, { status: 502 });
  if (error instanceof BillingError) {
    const status = error.status === 401 || error.status === 403 ? 502 : error.status;
    const message = error.status === 404 ? "A licença não foi encontrada para esta organização. Solicite a revisão do provisionamento." : error.status === 429 ? "Muitas consultas de licença. Aguarde antes de atualizar novamente." : "Não foi possível consultar a licença com segurança. Tente novamente mais tarde.";
    return privateJson({ error: message, retryable: status === 429 || status >= 500, requestId: typeof error.requestId === "string" && /^[A-Za-z0-9_-]{1,100}$/.test(error.requestId) ? error.requestId : undefined }, { status, headers: Number.isSafeInteger(error.retryAfter) && error.retryAfter! > 0 ? { "retry-after": String(Math.min(error.retryAfter!, 86_400)) } : undefined });
  }
  return authErrorResponse(error);
}
