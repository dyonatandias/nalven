import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const schema = read("prisma/tenant/schema.prisma"), migration = read("prisma/tenant/migrations/20260829190000_pos_kit_bom/migration.sql");
const integrityMigration = read("prisma/tenant/migrations/20260829240000_pos_financial_kit_guards/migration.sql");
const route = read("app/api/erp/pdv/route.ts"), adminRoute = read("app/api/erp/pdv/kits/route.ts"), inventory = read("lib/erp/pos-inventory-operations.ts");
const ui = read("components/erp/pdv-kits-admin.tsx"), dialog = read("components/erp/pdv-admin-dialog.tsx");

test("schema persiste BOM versionada e snapshot operacional sem alterar o item financeiro", () => {
  for (const model of ["PosKitBom", "PosKitBomComponent", "PosKitSaleComponent"]) assert.match(schema, new RegExp(`model ${model} \\{`));
  assert.match(schema, /@@unique\(\[branchId, scopeKey, version\]\)/);
  assert.match(schema, /unitQuantityMicros\s+BigInt/);
  assert.match(schema, /returnedMicros\s+BigInt/);
  assert.match(schema, /model PosKitComponentReturnMovement \{/);
  assert.match(schema, /@relation\(fields: \[bomId, bomVersion\], references: \[id, version\]/);
  assert.doesNotMatch(schema.slice(schema.indexOf("model SaleItem"), schema.indexOf("model PosRegister")), /componentPrice|componentTotal/);
});

test("migration garante versão ativa única e torna histórico/snapshot imutáveis", () => {
  assert.match(migration, /pos_kit_boms_one_active_scope_key/);
  assert.match(migration, /WHERE "status" = 'active'/);
  assert.match(migration, /pos_kit_bom_guard_trigger/);
  assert.match(migration, /Only draft POS kit BOM components may change/);
  assert.match(migration, /POS kit BOM components cannot move between versions/);
  assert.match(migration, /POS kit sale snapshots cannot be deleted/);
  for (const action of ["kit.create", "kit.update", "kit.activate", "kit.retire"]) assert.match(migration, new RegExp(action.replace(".", "\\.")));
});

test("quote inclui BOM no hash e commit baixa componentes dentro da SERIALIZABLE", () => {
  const quote = block("authoritativePromotionQuote"), commit = block("commitSale");
  assert.match(quote, /resolvePosKitPlans\(tx/);
  assert.match(quote, /kits: posKitSnapshotForHash\(kitPlans\)/);
  assert.match(quote, /version: 3/);
  assert.match(commit, /tx\.posKitSaleComponent\.create/);
  assert.match(commit, /referenceType: "pos_kit_sale_component"/);
  assert.match(commit, /applyPosCommonStockChange\(tx/);
  assert.match(commit, /isolationLevel: "Serializable"/);
  assert.ok(commit.indexOf("tx.sale.create") < commit.indexOf("tx.posKitSaleComponent.create"));
  assert.match(read("lib/erp/pos-kits.ts"), /detail\.product\.type === "kit"/);
  assert.match(read("lib/erp/pos-kit-admin.ts"), /validateRetirementGraph\(tx, before\)/);
});

test("cancelamento e devolução restauram snapshot por componente com CAS e escopo de lote", () => {
  const cancel = block("cancelSale"), returns = block("createReturn"), restore = block("restorePosKitSaleItemComponents");
  assert.match(cancel, /restorePosKitSaleItemComponents\(tx/);
  assert.match(returns, /restorePosKitSaleItemComponents\(tx/);
  assert.match(restore, /FOR UPDATE/);
  assert.match(restore, /returnedMicros: component\.returnedMicros/);
  assert.match(restore, /returnedMicros: \{ increment: requestedMicros \}/);
  assert.match(restore, /tx\.posKitComponentReturnMovement\.create/);
  assert.match(restore, /trackedProductId: component\.productId/);
  assert.match(inventory, /lot: \{ productId: input\.trackedProductId, variationId: input\.trackedVariationId/);
});

test("banco vincula versão do BOM e exige ledger imutável para todo saldo devolvido", () => {
  assert.match(integrityMigration, /pos_kit_boms_id_version_key/);
  assert.match(integrityMigration, /FOREIGN KEY \("bom_id", "bom_version"\)/);
  assert.match(integrityMigration, /pos_kit_component_return_movements/);
  assert.match(integrityMigration, /DEFERRABLE INITIALLY DEFERRED/);
  assert.match(integrityMigration, /returned balance does not match immutable movement ledger/);
});

test("API/UI administrativa aplica RBAC, same-origin, licença, limites e idempotência", () => {
  for (const token of ["assertSameOrigin(request)", "assertPosMutationRequest(request)", '"owner", "admin"', "assertTenantWriteAccess", "enforcePosRateLimit", "readPosJson(request, 32_768)", '"cache-control": "no-store"', "pdvAdminMutation"]) assert.ok(adminRoute.includes(token), `${token} ausente`);
  assert.match(adminRoute, /take: 1_000/); assert.match(adminRoute, /take: 500/);
  assert.match(ui, /cache: "no-store"/); assert.match(ui, /crypto\.randomUUID/); assert.doesNotMatch(ui, /dangerouslySetInnerHTML/);
  assert.match(dialog, /import \{ PdvKitsAdmin \}/); assert.match(dialog, /<PdvKitsAdmin branchId=\{data\.branch\.id\}/);
});

test("ativação futura falha antes de retirar a versão vigente", () => {
  const admin = read("lib/erp/pos-kit-admin.ts"), futureGuard = admin.indexOf("before.effectiveFrom && before.effectiveFrom.valueOf() > now.valueOf()"), retire = admin.indexOf("tx.posKitBom.updateMany", futureGuard);
  assert.ok(futureGuard >= 0 && retire > futureGuard);
  assert.match(admin.slice(futureGuard, retire), /versão ativa atual foi preservada/);
});

function block(name: string) { const start = route.indexOf(`async function ${name}(`); assert.ok(start >= 0, `${name} ausente`); const end = route.indexOf("\nasync function ", start + 1); return route.slice(start, end < 0 ? undefined : end); }
function read(path: string) { return readFileSync(new URL(`../${path}`, import.meta.url), "utf8"); }
