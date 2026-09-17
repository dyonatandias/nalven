import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { posAdminCapabilities } from "../lib/erp/pos-admin-capabilities";

test("painéis administrativos respeitam plano e perfil operacional sem ampliar acesso", () => {
  const base = { modules: ["@policy:v1", "pdv.read", "pdv.write"], role: "owner", permissions: ["*"], activeOperationalProfile: false };
  assert.deepEqual(posAdminCapabilities(base), { reconciliation: false, manualApplications: false });
  assert.deepEqual(posAdminCapabilities({ ...base, activeOperationalProfile: true }), { reconciliation: false, manualApplications: true });
  assert.deepEqual(posAdminCapabilities({ ...base, modules: [...base.modules, "reconciliation.read"], activeOperationalProfile: true }), { reconciliation: true, manualApplications: true });
  assert.deepEqual(posAdminCapabilities({ ...base, role: "operator", activeOperationalProfile: true }), { reconciliation: false, manualApplications: false });
  assert.deepEqual(posAdminCapabilities({ ...base, role: "admin", permissions: [], activeOperationalProfile: true }), { reconciliation: false, manualApplications: false });
});

test("painéis protegidos não são montados na abertura de outras etapas", () => {
  const admin = readFileSync("components/erp/pdv-admin-dialog.tsx", "utf8");
  assert.match(admin, /data\.capabilities\?\.reconciliation/);
  assert.match(admin, /data\.capabilities\?\.manualApplications/);
  assert.match(admin, /section === "payments" && <PdvReconciliationAdmin/);
  assert.match(admin, /section === "payments" && <PdvManualApplicationsAdmin/);
});
import { POS_SETTINGS_REQUIRED, requirePosSettings } from "../lib/erp/pos-settings";
import { GET as favicon } from "../app/favicon.ico/route";

test("PDV rejeita configurações ausentes sem inventar política financeira", () => {
  assert.throws(() => requirePosSettings(null), { message: POS_SETTINGS_REQUIRED });
  assert.throws(() => requirePosSettings(undefined), { message: POS_SETTINGS_REQUIRED });
  const settings = { defaultPaymentMethod: "Dinheiro", maxDiscountPercent: 0, requireCustomer: true };
  assert.equal(requirePosSettings(settings), settings);
});

test("PDV valida configurações antes de publicar o estado e executar efeitos", () => {
  assert.ok(workspace.indexOf("if (!payload.settings)") < workspace.indexOf("setData(nextData)"));
  assert.ok(route.includes("if (!settings) throw new PosDomainError(POS_SETTINGS_REQUIRED)"));
});

test("favicon legado aponta para o ícone existente", () => {
  const response = favicon();
  assert.equal(response.status, 307);
  assert.equal(response.headers.get("location"), "/favicon.svg");
  assert.match(readFileSync("public/favicon.svg", "utf8"), /<svg/);
});

const route = readFileSync("app/api/erp/pdv/route.ts", "utf8");
const workspace = readFileSync("components/erp/pdv-workspace.tsx", "utf8");

test("busca de vendas limita consulta e cursor ao turno do operador e aos caixas autorizados", () => {
  const sales = route.slice(route.indexOf('if (request.resource === "sales")'), route.indexOf('if (request.resource === "customers")'));
  assert.ok(sales.includes("context.registers.map(register => register.id)"));
  assert.ok(sales.includes("operatorProfileId: context.profile.id"));
  assert.ok(sales.includes("sessionId: session?.id ?? -1"));
  assert.ok(sales.includes("where: { ...where, id: request.cursorId }"));
  assert.ok(sales.includes("take: request.limit + 1"));
  assert.ok(sales.includes('"cache-control": "no-store"'));
});

test("consulta paginada preserva tenant, permissão e escopo da filial", () => {
  for (const evidence of [
    /assertTenantPermission\(\s*organization\.id,\s*"pdv\.read",?\s*\)/,
    /tenantDb\(organization\.id\)/,
    /posContext\(db, permission, organization\.id\)/,
    /branchId:\s*context\.branch\.id,\s*active:\s*true,\s*saleEnabled:\s*true/,
    /page\.items\.map\(publicPosCustomer\)/,
    /\{\s*document:\s*\{\s*endsWith:\s*documentQuery\s*\}\s*\}/,
    /headers:\s*\{\s*"cache-control":\s*"no-store"\s*\}/,
  ])
    assert.match(route, evidence);
});

test("produtos e clientes usam cursor estável e consultam uma linha sentinela", () => {
  assert.match(
    route,
    /if \(url\.searchParams\.has\("resource"\)\)\s*return await paginatedPosCatalog/,
  );
  assert.match(route, /take: request\.limit \+ 1/g);
  assert.match(route, /cursor: \{ id: request\.cursorId \}, skip: 1/g);
  assert.equal(
    route.match(
      /orderBy:\s*\[\s*\{\s*name:\s*"asc"\s*\},\s*\{\s*id:\s*"asc"\s*\}\s*\]/g,
    )?.length,
    2,
  );
});

test("workspace expõe busca, continuação e estados acessíveis sem depender do bootstrap", () => {
  for (const evidence of [
    'resource: "products"',
    'resource: "customers"',
    'aria-controls="pos-catalog-grid"',
    'id="pos-customer-search-status" role="status" aria-live="polite"',
    "Carregar mais produtos",
    "Carregar mais clientes",
    "Nenhum produto ativo corresponde à busca.",
    "Nenhum cliente ativo corresponde à busca.",
    "catalogRequest.current?.abort()",
    "customerRequest.current?.abort()",
    "digits.slice(-4)",
  ])
    assert.ok(workspace.includes(evidence), `evidência ausente: ${evidence}`);
});
