import type { Prisma } from "@/generated/control/client";
import { controlDb } from "@/db/control";
import { billingClient } from "./client";
import { deriveRbacModules } from "./module-map";

export type CatalogSyncResult = { synced: string[]; skipped: string[]; deactivated: string[] };

// Fallback used only if a plan entry omits a parseable seat quota. Mirrors the "Usuários
// nomeados" row in vendor/billing-integration/docs/integracao-nalven/catalogo-e-entitlements.md —
// update alongside that doc if Billing changes these values.
const FALLBACK_SEATS: Record<string, number> = { essencial: 3, profissional: 8, omnichannel: 15 };

/**
 * Mirrors Billing's GET /catalogo into the local `Plan` cache, keyed by `code`. Never touches
 * existing rows if the call fails or the response is unusable — the last-known-good catalog
 * keeps serving public pages/signup/admin assignment.
 */
export async function syncPlanCatalog(): Promise<CatalogSyncResult> {
  const data = await billingClient.catalog();
  const rawPlans = Array.isArray((data as Record<string, unknown>).plans) ? (data as { plans: unknown[] }).plans : [];
  const synced: string[] = [];
  const skipped: string[] = [];
  const now = new Date();
  for (const entry of rawPlans) {
    const parsed = parseCatalogPlan(entry);
    if (!parsed) { skipped.push(codeOf(entry)); continue; }
    const modules = deriveRbacModules(parsed.includedModules);
    const common = {
      name: parsed.name,
      monthlyPrice: parsed.monthlyPrice,
      cardMonthlyPrice: parsed.cardMonthlyPrice,
      annualPrice: parsed.annualPrice,
      seats: parsed.seats,
      modules: modules as Prisma.InputJsonValue,
      billingModules: parsed.includedModules as Prisma.InputJsonValue,
      active: true,
      lastSyncedAt: now,
      raw: entry as Prisma.InputJsonValue,
    };
    await controlDb.plan.upsert({
      where: { code: parsed.code },
      create: { id: parsed.code, code: parsed.code, visibility: "public", ...common },
      update: common,
    });
    synced.push(parsed.code);
  }
  let deactivated: string[] = [];
  if (synced.length) {
    const stale = await controlDb.plan.findMany({ where: { code: { not: null }, active: true, NOT: { code: { in: synced } } }, select: { code: true } });
    if (stale.length) {
      await controlDb.plan.updateMany({ where: { code: { in: stale.map(item => item.code!) } }, data: { active: false } });
      deactivated = stale.map(item => item.code!);
    }
  }
  return { synced, skipped, deactivated };
}

const SYNC_INTERVAL_MS = 60 * 60_000;

/** Same as syncPlanCatalog, but skips the Billing call entirely if the cache is still fresh — safe to call from a job that runs every minute. */
export async function syncPlanCatalogIfStale(maxAgeMs = SYNC_INTERVAL_MS): Promise<CatalogSyncResult | { skippedSync: true }> {
  const latest = await controlDb.plan.findFirst({ where: { code: { not: null } }, orderBy: { lastSyncedAt: "desc" }, select: { lastSyncedAt: true } });
  if (latest?.lastSyncedAt && Date.now() - latest.lastSyncedAt.getTime() < maxAgeMs) return { skippedSync: true };
  return syncPlanCatalog();
}

function codeOf(entry: unknown): string {
  const record = entry as Record<string, unknown> | null;
  return record && typeof record.code === "string" ? record.code : "?";
}

function parseCatalogPlan(entry: unknown) {
  const record = entry as Record<string, unknown> | null;
  if (!record || typeof record !== "object") return null;
  const code = typeof record.code === "string" && /^[a-z0-9][a-z0-9_-]{0,49}$/.test(record.code) ? record.code : null;
  const name = typeof record.name === "string" && record.name.trim() ? record.name.trim() : null;
  const prices = record.prices as Record<string, unknown> | undefined;
  const pix = prices?.pix as Record<string, unknown> | undefined;
  const boleto = prices?.boleto as Record<string, unknown> | undefined;
  const cartao = prices?.cartao as Record<string, unknown> | undefined;
  const monthlyPrice = positiveNumber(pix?.monthly) ?? positiveNumber(boleto?.monthly);
  const annualPrice = positiveNumber(pix?.annual) ?? positiveNumber(boleto?.annual);
  const cardMonthlyPrice = positiveNumber(cartao?.monthly);
  const includedModules = Array.isArray(record.included_modules) ? record.included_modules.filter((value): value is string => typeof value === "string") : [];
  const seats = positiveInteger(record.seats) ?? positiveInteger((record.quotas as Record<string, unknown> | undefined)?.nalven_usuarios_nomeados) ?? (code ? FALLBACK_SEATS[code] : undefined);
  if (!code || !name || monthlyPrice === undefined || annualPrice === undefined || seats === undefined) return null;
  return { code, name, monthlyPrice, annualPrice, cardMonthlyPrice, seats, includedModules };
}

function positiveNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}
function positiveInteger(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : undefined;
}
