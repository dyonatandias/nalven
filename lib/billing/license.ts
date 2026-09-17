import { createHash } from "node:crypto";
import { Prisma } from "@/generated/control/client";
import { controlDb } from "@/db/control";
import { decryptSecret } from "@/lib/secrets";
import { billingSettings } from "./client";
import { safeRequest } from "@/lib/integrations/security";

type License = {
  success: true;
  valida: boolean;
  recursos: Array<{ codigo: string; habilitado: boolean; limite: number | null }>;
  limites?: Array<{ codigo: string; valor: number | null }>;
};
type RuntimeCache = { source: "nalven-runtime-v1"; checkedAt: number; contextHash: string; payload: License };
const CACHE_SOURCE = "nalven-runtime-v1";
const MAX_ENTRIES = 5000;
const pending = new Map<string, Promise<License>>();
const deniedContexts = new Map<string, { checkedAt: number; expiresAt: number }>();
let bypassCacheThrough = 0;
let bypassCacheExpiresAt = 0;
const UNAVAILABLE = "Não foi possível validar a licença com segurança. Tente novamente mais tarde.";
const INVALID = "A licença não está válida para novas operações. Consulte a assinatura em Minha Conta.";

export class LicenseDeniedError extends Error {
  status = 403;
  constructor(message: string) { super(message); }
}

export async function tenantLicense(organizationId: string, { force = false }: { force?: boolean } = {}): Promise<License> {
  const account = await controlDb.billingAccount.findUnique({ where: { organizationId } });
  if (!account?.licenseSecret) throw new LicenseDeniedError("Licença financeira ainda não ativada. Acompanhe o provisionamento em Minha Conta.");
  const settings = await billingSettings();
  const baseUrl = settings.baseUrl.replace(/\/+$/, "");
  const contextHash = createHash("sha256").update(JSON.stringify([organizationId, account.externalId, baseUrl, settings.productCode, account.licenseSecret])).digest("hex");
  const seconds = typeof settings.licenseCacheSeconds === "number" && Number.isFinite(settings.licenseCacheSeconds) ? Math.min(3600, Math.max(30, Math.floor(settings.licenseCacheSeconds))) : 300;
  const cached = !force ? cachedLicense(account.entitlementCache, contextHash, seconds * 1000) : null;
  if (cached) return requireValid(cached);

  // A financial sync or key replacement changes updatedAt. Do not share a read
  // started before that account version, even when its context hash is equal.
  const requestKey = `${contextHash}:${account.updatedAt.getTime()}`;
  const existing = pending.get(requestKey);
  if (existing) return existing;
  if (pending.size >= 60) throw new LicenseDeniedError(UNAVAILABLE);

  const read = (async () => {
    let response: Awaited<ReturnType<typeof safeRequest>>;
    try {
      response = await safeRequest(`${baseUrl}/licencas/entitlements?${new URLSearchParams({ produto_codigo: settings.productCode, instalacao_id: account.externalId })}`, {
        method: "GET", headers: { Authorization: `License ${decryptSecret(account.licenseSecret!)}`, Accept: "application/json" }, timeoutMs: settings.licenseTimeoutMs,
      });
    } catch { throw new LicenseDeniedError(UNAVAILABLE); }
    if (response.status === 401 || response.status === 403) {
      // A forced recheck may revoke credentials before a previously valid TTL
      // ends. Remove that cached grant only if this is still the same account.
      rememberDenial(contextHash);
      try {
        await controlDb.billingAccount.updateMany({
          where: { id: account.id, externalId: account.externalId, licenseSecret: account.licenseSecret, updatedAt: account.updatedAt },
          data: { entitlementCache: Prisma.DbNull, licenseStatus: "invalid", lastError: null },
        });
      } catch { /* Deny even if invalidation cannot be persisted. */ }
      throw new LicenseDeniedError(UNAVAILABLE);
    }
    if (response.status < 200 || response.status >= 300) throw new LicenseDeniedError(UNAVAILABLE);
    let payload: License;
    try { payload = runtimeLicense(JSON.parse(response.body)); }
    catch { throw new LicenseDeniedError(UNAVAILABLE); }
    if (payload.valida === false) rememberDenial(contextHash);
    const wrapper: RuntimeCache = { source: CACHE_SOURCE, checkedAt: Date.now(), contextHash, payload };
    let written: { count: number };
    try {
      written = await controlDb.billingAccount.updateMany({
        where: { id: account.id, externalId: account.externalId, licenseSecret: account.licenseSecret, updatedAt: account.updatedAt },
        data: { entitlementCache: wrapper as unknown as Prisma.InputJsonValue, licenseStatus: payload.valida === true ? "valid" : "invalid", lastError: null },
      });
    } catch { throw new LicenseDeniedError(UNAVAILABLE); }
    // Never authorize using a response whose account changed while it was read.
    if (written.count !== 1) throw new LicenseDeniedError(UNAVAILABLE);
    return requireValid(payload);
  })();
  pending.set(requestKey, read);
  try { return await read; }
  finally { if (pending.get(requestKey) === read) pending.delete(requestKey); }
}

export async function assertTenantLicensed(organizationId: string, resource?: string) {
  const license = await tenantLicense(organizationId);
  if (resource) {
    const item = license.recursos.find(value => value.codigo === resource);
    if (item?.habilitado !== true || item.limite === 0) throw new LicenseDeniedError("Seu plano não habilita este recurso.");
  }
  return license;
}

function requireValid(license: License) {
  if (license.valida !== true) throw new LicenseDeniedError(INVALID);
  return license;
}

function cachedLicense(value: unknown, contextHash: string, ttl: number): License | null {
  const cache = object(value), now = Date.now();
  if (!cache || cache.source !== CACHE_SOURCE || cache.contextHash !== contextHash || typeof cache.checkedAt !== "number" || !Number.isSafeInteger(cache.checkedAt) || cache.checkedAt <= 0 || cache.checkedAt > now || now - cache.checkedAt >= ttl) return null;
  let payload: License;
  try { payload = runtimeLicense(cache.payload); } catch { return null; }
  if (payload.valida === false) return payload;
  const denied = deniedContexts.get(contextHash);
  if (denied && denied.expiresAt <= now) deniedContexts.delete(contextHash);
  if (denied && denied.expiresAt > now && cache.checkedAt <= denied.checkedAt || bypassCacheExpiresAt > now && cache.checkedAt <= bypassCacheThrough) return null;
  return payload;
}

function rememberDenial(contextHash: string) {
  const now = Date.now();
  for (const [key, value] of deniedContexts) if (value.expiresAt <= now) deniedContexts.delete(key);
  if (bypassCacheExpiresAt <= now) { bypassCacheThrough = 0; bypassCacheExpiresAt = 0; }
  deniedContexts.delete(contextHash);
  if (deniedContexts.size >= 256) {
    const oldest = deniedContexts.entries().next().value!;
    deniedContexts.delete(oldest[0]);
    // If persistence failed for many contexts, eviction must not reopen their
    // old grants. Only bypass old caches; a new GET can still authorize normally.
    bypassCacheThrough = Math.max(bypassCacheThrough, oldest[1].checkedAt);
    bypassCacheExpiresAt = Math.max(bypassCacheExpiresAt, oldest[1].expiresAt);
  }
  deniedContexts.set(contextHash, { checkedAt: now, expiresAt: now + 3600_000 });
}

function runtimeLicense(value: unknown): License {
  const payload = object(value);
  if (!payload || payload.success !== true || typeof payload.valida !== "boolean") throw new Error("InvalidRuntimeLicense");
  if (payload.valida === true && !Array.isArray(payload.recursos)) throw new Error("MissingRuntimeResources");
  const resources = payload.recursos === undefined && payload.valida === false ? [] : rows(payload.recursos);
  const seen = new Set<string>();
  const recursos = resources.map(value => {
    const item = object(value), codigo = resourceCode(item?.codigo, seen);
    if (!item || typeof item.habilitado !== "boolean" || !validLimit(item.limite)) throw new Error("InvalidRuntimeResource");
    return { codigo, habilitado: item.habilitado, limite: item.limite };
  });
  if (payload.limites === undefined) return { success: true, valida: payload.valida, recursos };
  const limitCodes = new Set<string>();
  const limites = rows(payload.limites).map(value => {
    const item = object(value), codigo = resourceCode(item?.codigo, limitCodes);
    if (!item || !validLimit(item.valor)) throw new Error("InvalidRuntimeLimit");
    return { codigo, valor: item.valor };
  });
  return { success: true, valida: payload.valida, recursos, limites };
}

function rows(value: unknown): unknown[] {
  if (!Array.isArray(value) || value.length > MAX_ENTRIES) throw new Error("InvalidRuntimeCollection");
  return value;
}

function resourceCode(value: unknown, seen: Set<string>) {
  if (typeof value !== "string" || !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,119}$/.test(value) || seen.has(value)) throw new Error("InvalidRuntimeCode");
  seen.add(value);
  return value;
}

function validLimit(value: unknown): value is number | null {
  return value === null || typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= Number.MAX_SAFE_INTEGER;
}

function object(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}
