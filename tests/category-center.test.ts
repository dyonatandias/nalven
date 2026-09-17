import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { categoryCsv, categoryHealth, categoryTree, parseCategoryQuery } from "../lib/erp/category-control";
import { categoryAttributeInput, categoryInput, categoryMappingInput, categoryVersion, CategoryInputError } from "../lib/erp/category-input";

const migration = readFileSync("prisma/tenant/migrations/20260903170000_category_taxonomy_control_center/migration.sql", "utf8"), schema = readFileSync("prisma/tenant/schema.prisma", "utf8"), listRoute = readFileSync("app/api/erp/categories/route.ts", "utf8"), detailRoute = readFileSync("app/api/erp/categories/[id]/route.ts", "utf8"), metrics = readFileSync("lib/erp/category-metrics.ts", "utf8"), ui = readFileSync("components/erp/category-center.tsx", "utf8"), css = readFileSync("components/erp/category-center.module.css", "utf8"), shell = readFileSync("app/erp/erp-client.tsx", "utf8"), seed = readFileSync("scripts/seed-demo-categories.ts", "utf8");

test("normaliza e valida identidade, hierarquia, publicação e SEO", () => {
  const value = categoryInput({ name: "  Freios e Suspensão  ", code: "cat freios", type: "product", color: "#AABBCC", parentId: "2", visibility: "catalog", menuOrder: "30", seoTitle: "Freios seguros", seoDescription: "Linha completa" });
  assert.equal(value.name, "Freios e Suspensão"); assert.equal(value.slug, "freios-e-suspensao"); assert.equal(value.code, "CAT-FREIOS"); assert.equal(value.color, "#aabbcc"); assert.equal(value.parentId, 2);
  assert.throws(() => categoryInput({ name: "A", color: "red" }), CategoryInputError);
  assert.throws(() => categoryInput({ name: "Categoria", code: "inválido!" }), /Código/);
  assert.equal(categoryVersion("3"), 3); assert.throws(() => categoryVersion(0), /Versão/);
});

test("valida modelos de atributos e mapeamentos de canal", () => {
  const attribute = categoryAttributeInput({ name: "Viscosidade", type: "select", required: true, options: "5W30, 10W40", unit: "SAE" });
  assert.deepEqual(attribute.options, ["5W30", "10W40"]); assert.equal(attribute.required, true);
  assert.throws(() => categoryAttributeInput({ name: "Cor", type: "select" }), /opção/);
  assert.throws(() => categoryAttributeInput({ name: "Peso", type: "number", options: "A, B" }), /somente/);
  assert.equal(categoryMappingInput({ platform: "Mercado Livre", remoteCategoryId: "MLB123", status: "mapped" }).platform, "mercado-livre");
});

test("parâmetros de consulta são estritos e limitados", () => {
  const query = parseCategoryQuery(new URLSearchParams("status=active&type=product&attention=seo&sort=revenue&page=2&limit=50"));
  assert.equal(query.page, 2); assert.equal(query.sort, "revenue"); assert.equal(query.attention, "seo");
  assert.throws(() => parseCategoryQuery(new URLSearchParams("visibility=public")), /visibilidade/);
  assert.throws(() => parseCategoryQuery(new URLSearchParams("parent=-2")), /hierarquia/);
});

test("ordena árvore com caminho, profundidade e proteção de ciclo", () => {
  const rows = categoryTree([{ id: 2, name: "Filha", parentId: 1, menuOrder: 2 }, { id: 1, name: "Raiz", parentId: null, menuOrder: 1 }, { id: 3, name: "Neta", parentId: 2, menuOrder: 1 }]);
  assert.deepEqual(rows.map((item) => item.path), ["Raiz", "Raiz / Filha", "Raiz / Filha / Neta"]); assert.equal(rows[2].depth, 2);
  const cyclic = categoryTree([{ id: 1, name: "A", parentId: 2, menuOrder: 0 }, { id: 2, name: "B", parentId: 1, menuOrder: 0 }]);
  assert.equal(cyclic.length, 0);
});

test("saúde é acionável e exportação CSV bloqueia fórmulas", () => {
  const health = categoryHealth({ active: true, description: null, seoTitle: null, seoDescription: null, seoNoindex: false, visibility: "visible", type: "product", attributeCount: 0, mappingCount: 0, metrics: { products: 0, lowStock: 0, outOfStock: 0 } });
  assert.ok(health.score < 40); assert.ok(health.issues.includes("Sem itens vinculados"));
  const csv = categoryCsv([{ name: "=HYPERLINK('x')", code: null, slug: "teste", path: "Teste", type: "product", active: true, visibility: "visible", menuOrder: 0, health: { score: 90 }, metrics: { products: 1, activeProducts: 1, revenue90d: 10, units90d: 1, stockValue: 5, potentialRevenue: 10, lowStock: 0, outOfStock: 0, marginPercent: 50 } }]);
  assert.match(csv, /'=HYPERLINK/); assert.ok(csv.startsWith("\uFEFF"));
});

test("APIs têm segurança, BI, paginação, concorrência e ações completas", () => {
  for (const source of [listRoute, detailRoute]) { assert.match(source, /assertTenantPermission/); assert.match(source, /assertPosMutationRequest/); assert.match(source, /readPosJson/); assert.match(source, /enforcePosRateLimit/); assert.match(source, /NO_STORE/); assert.match(source, /console\.error/); }
  assert.match(listRoute, /categoryCsv/); assert.match(listRoute, /batch\.status/); assert.match(listRoute, /batch\.visibility/); assert.match(listRoute, /batch\.parent/); assert.match(listRoute, /mergeCategories/); assert.match(listRoute, /10_000/);
  for (const action of ["status", "attribute.save", "mapping.save", "pricing.save", "product.assign", "product.remove"]) assert.ok(detailRoute.includes(action), action);
  assert.match(detailRoute, /FOR UPDATE/); assert.match(detailRoute, /Serializable/); assert.match(detailRoute, /categorySlugRedirect/); assert.match(metrics, /UNION/); assert.match(metrics, /DISTINCT|assignment/);
});

test("persistência reforça taxonomia, integridade, SEO e canais", () => {
  for (const table of ["category_attribute_templates", "category_marketplace_mappings", "category_slug_redirects"]) assert.ok(migration.includes(`\"${table}\"`), table);
  assert.match(migration, /prevent_category_cycle/); assert.match(migration, /categories_visibility_check/); assert.match(migration, /categories_color_check/); assert.match(migration, /select_options_check/);
  for (const model of ["CategoryAttributeTemplate", "CategoryMarketplaceMapping", "CategorySlugRedirect"]) assert.match(schema, new RegExp(`model ${model}`));
});

test("interface substitui legado e cobre BI, 360°, responsividade e acessibilidade", () => {
  assert.match(shell, /<CategoryCenter \/>/); assert.match(ui, /Central de categorias/); assert.match(ui, /Visão executiva/); assert.match(ui, /Taxonomia/); assert.match(ui, /Governança/); assert.match(ui, /Exportar CSV/); assert.match(ui, /Mesclar/); assert.match(ui, /Produtos \(/); assert.match(ui, /Atributos \(/); assert.match(ui, /Canais \(/); assert.match(ui, /role="tablist"/); assert.match(ui, /aria-label/); assert.match(ui, /ErpModal/); assert.match(css, /@media\(max-width:650px\)/); assert.doesNotMatch(css, /font-size:(?:[0-9]|10)px/);
});

test("seed demonstrativo é protegido, idempotente e cobre os principais cenários", () => {
  assert.match(seed, /NALVEN_ALLOW_DEMO_CATEGORY_SEED/); assert.match(seed, /nalven_t_demo_runtime/); assert.match(seed, /upsert/); assert.match(seed, /categoryAttributeTemplate/); assert.match(seed, /categoryMarketplaceMapping/); assert.match(seed, /categoryPricingOverride/); assert.match(seed, /productCategoryLink/); assert.match(seed, /categoria vazia/);
});
