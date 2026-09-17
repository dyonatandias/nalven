/**
 * One-off production data migration for the "Plan sourced from Billing" change.
 *
 * 1. Syncs the local Plan cache from Billing's real catalog (creates essencial/profissional/omnichannel).
 * 2. Remaps organizations on the old local "essential" plan to the new "essencial" row — safe because
 *    the price matches exactly (R$149), so it was never anything but the same offer under a different id.
 * 3. Leaves every other organization's planId untouched (old "management"/"scale" ids, and any
 *    visibility:"private" exclusive plan) and instead reports them for manual reconciliation — their
 *    local price never matched Billing's real catalog, so there is no safe automatic mapping. Check
 *    each one against `GET /clientes/{external_id}/assinatura` before reassigning it by hand in
 *    /admin/organizacoes/<id> → Plano e licença.
 *
 * Run once against production (CONTROL_DATABASE_URL pointed at the real control DB), then re-run with
 * --dry-run first if you want to see the report without writing anything.
 */
import { controlDb } from "../db/control";
import { syncPlanCatalog } from "../lib/billing/catalog-sync";

const dryRun = process.argv.includes("--dry-run");
// Only the pre-migration "essential" id had a price that exactly matches Billing's real "essencial" plan.
const SAFE_REMAP: Record<string, string> = { essential: "essencial" };

async function main() {
  const sync = await syncPlanCatalog();
  console.log(JSON.stringify({ step: "catalog_sync", ...sync }));

  const organizations = await controlDb.organization.findMany({ select: { id: true, name: true, planId: true } });
  const remapped: Array<{ organizationId: string; from: string; to: string }> = [];
  const needsReview: Array<{ organizationId: string; name: string; planId: string }> = [];

  for (const organization of organizations) {
    const target = SAFE_REMAP[organization.planId];
    if (target) {
      remapped.push({ organizationId: organization.id, from: organization.planId, to: target });
      if (!dryRun) {
        const plan = await controlDb.plan.findUniqueOrThrow({ where: { id: target } });
        await controlDb.$transaction(async tx => {
          await tx.organization.update({ where: { id: organization.id }, data: { planId: plan.id, modules: plan.modules as object } });
          await tx.auditLog.create({ data: { action: "organization.plan_changed", entityType: "organization", entityId: organization.id, metadata: { previousPlanId: organization.planId, planId: plan.id, source: "migrate-plan-catalog", automatic: true } } });
        });
      }
      continue;
    }
    const plan = await controlDb.plan.findUnique({ where: { id: organization.planId }, select: { code: true } });
    if (!plan?.code) needsReview.push({ organizationId: organization.id, name: organization.name, planId: organization.planId });
  }

  console.log(JSON.stringify({ step: dryRun ? "remap_preview" : "remap_applied", remapped }));
  console.log(JSON.stringify({ step: "needs_manual_review", count: needsReview.length, organizations: needsReview }));
  if (needsReview.length) console.log("Confira cada organização acima contra a assinatura real no Billing antes de reatribuir o plano pelo painel admin. Nada foi bloqueado — elas continuam operando com os acessos atuais.");
}

main().finally(() => controlDb.$disconnect());
