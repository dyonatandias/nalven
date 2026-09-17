import { expect, test, type Page } from "@playwright/test";
import { portalLicensePayload, type PortalLicenseData } from "../../lib/billing/portal-license-data";

const stamp = "2026-09-08T10:00:00Z";
const payload: PortalLicenseData = {
  ...portalLicensePayload({ license: { status: "ativa", valida_de: "2026-01-10", valida_ate: null, max_instalacoes: 3, plano_codigo: "test-plan", plano_nome: "Plano de homologação", recursos: [
    { codigo: "catalogo", nome: "Catálogo de produtos", habilitado: true, limite: null },
    { codigo: "cota_zero", nome: "Recurso com cota zero", habilitado: true, limite: 0 },
    { codigo: "filiais", nome: "Filiais contratadas", habilitado: true, limite: 4 },
  ] } }),
  applicationPlan: { id: "test-plan", name: "Plano de teste local", expectedRemoteCode: "test-plan", modules: [{ id: "products", name: "Produtos", enabled: true }] },
  comparison: { plan: "match" }, source: { name: "billing_headless", checkedAt: stamp, cached: false },
  capabilities: { canRefresh: true, canExportDiagnostic: true, canRotate: false }, generatedAt: stamp,
};

async function mockPortal(page: Page) {
  const calls = { finance: 0, license: 0, support: 0, writes: 0 };
  await page.route("**/api/portal/**", async route => {
    if (route.request().method() !== "GET") { calls.writes++; await route.abort("blockedbyclient"); return; }
    const path = new URL(route.request().url()).pathname;
    if (path === "/api/portal/license") { calls.license++; await route.fulfill({ json: payload }); }
    else if (path === "/api/portal/support") {
      calls.support++;
      await route.fulfill({ json: { tickets: [], pagination: { page: 1, pageSize: 20, total: 0, pages: 1, hasMore: false, partial: false }, summary: { loaded: 0, totalKnown: 0, byStatus: {} }, facets: { statuses: [], categories: [], priorities: [] }, capabilities: { canWrite: false }, warning: null, generatedAt: stamp } });
    } else { calls.finance++; await route.fulfill({ json: { capabilities: { canWrite: false }, section_errors: { portal: "Consulta financeira indisponível durante o teste." } } }); }
  });
  return calls;
}

test("licença e suporte são independentes das finanças e preservam área/filtros no histórico", async ({ page }) => {
  const calls = await mockPortal(page);
  await page.goto("/__license-shell?area=licenca");
  await expect(page.getByRole("heading", { name: "Licença e recursos", level: 1 })).toBeVisible();
  await expect(page.locator("aside nav a[aria-current=page]")).toContainText("Licença e recursos");
  await page.getByLabel("Buscar recurso", { exact: true }).fill("zero");
  await expect(page.getByText("Recurso com cota zero", { exact: true })).toBeVisible();
  expect(calls.license).toBe(1); expect(calls.finance).toBe(0); expect(calls.support).toBe(0);
  await page.locator("aside nav a[href='/portal?area=suporte']").click();
  await expect(page.getByRole("heading", { name: "Suporte", exact: true, level: 1 })).toBeVisible();
  await expect(page.getByText("Nenhum chamado encontrado", { exact: true })).toBeVisible();
  await page.goBack();
  await expect(page.getByLabel("Buscar recurso", { exact: true })).toHaveValue("zero");
  await expect(page.locator("aside nav a[aria-current=page]")).toContainText("Licença e recursos");
  expect(calls.license).toBe(1); expect(calls.finance).toBe(0);
  await page.goForward(); await expect(page.locator("aside nav a[aria-current=page]")).toContainText("Suporte");
  await page.locator("aside nav a[href='/portal?area=faturas']").click();
  await expect(page.getByText("Consulta financeira indisponível", { exact: true })).toBeVisible();
  await page.locator("aside nav a[href='/portal?area=licenca']").click();
  await expect(page.getByLabel("Buscar recurso", { exact: true })).toHaveValue("zero");
  await expect(page.getByText("Consulta financeira indisponível", { exact: true })).toHaveCount(0);
  expect(calls.finance).toBe(1); expect(calls.writes).toBe(0);
});

test("shell da licença é legível em 320/390px, com uma navegação e acesso por teclado", async ({ page }) => {
  const errors: string[] = []; page.on("pageerror", error => errors.push(error.name));
  const calls = await mockPortal(page);
  await page.setViewportSize({ width: 320, height: 900 });
  await page.goto("/__license-shell?area=licenca");
  await expect(page.getByLabel("Buscar recurso", { exact: true })).toBeVisible();
  await page.keyboard.press("Tab");
  await expect(page.getByRole("link", { name: "Pular para o conteúdo" })).toBeFocused();
  await page.keyboard.press("Enter"); await expect(page.locator("#portal-content")).toBeFocused();
  await expect(page.locator("aside nav")).toBeHidden();
  await expect(page.getByLabel("Navegar no portal", { exact: true })).toHaveValue("licenca");
  for (const width of [320, 390]) {
    await page.setViewportSize({ width, height: 900 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    expect(await page.getByLabel("Buscar recurso", { exact: true }).evaluate(element => getComputedStyle(element).fontSize)).toBe("16px");
  }
  await page.screenshot({ path: "outputs/license-browser/license-shell-mobile.png", fullPage: true });
  await page.getByLabel("Navegar no portal", { exact: true }).selectOption("suporte");
  await expect(page.getByRole("heading", { name: "Suporte", exact: true, level: 1 })).toBeVisible();
  await page.getByLabel("Navegar no portal", { exact: true }).selectOption("licenca");
  await expect(page.getByRole("heading", { name: "Licença e recursos", level: 1 })).toBeVisible();
  expect(calls.finance).toBe(0); expect(calls.writes).toBe(0); expect(errors).toEqual([]);
});
