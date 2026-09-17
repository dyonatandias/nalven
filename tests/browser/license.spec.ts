import { expect, test, type Page, type Route } from "@playwright/test";
import { readFile } from "node:fs/promises";
import { licenseFixture } from "../fixtures/license-browser-data";
import type { PortalLicenseData } from "../../lib/billing/portal-license-data";

test.use({ timezoneId: "America/Sao_Paulo" });

async function mockLicense(page: Page, options: { data?: PortalLicenseData; intercept?: (route: Route) => Promise<boolean> } = {}) {
  const calls = { license: [] as { organization: string; refresh: string | null }[], finance: 0, writes: 0 };
  await page.route("**/api/portal/billing", async route => { calls.finance++; await route.fulfill({ status: 503, json: { error: "Finanças indisponíveis no teste." } }); });
  await page.route("**/api/portal/license**", async route => {
    const request = route.request();
    if (request.method() !== "GET") { calls.writes++; await route.fulfill({ status: 405, json: { error: "Este teste não autoriza mutações." } }); return; }
    calls.license.push({ organization: request.headers()["x-organization-id"] || "", refresh: new URL(request.url()).searchParams.get("refresh") });
    if (await options.intercept?.(route)) return;
    await route.fulfill({ json: options.data || licenseFixture() });
  });
  return calls;
}
async function ready(page: Page) { await expect(page.getByRole("button", { name: "Exportar diagnóstico", exact: true })).toBeVisible(); }
const resourceList = (page: Page) => page.getByRole("list", { name: "Lista de recursos", exact: true });

test("mantém zero, bloqueados, cota ausente e desconhecido com busca/filtros/paginação locais", async ({ page }) => {
  const calls = await mockLicense(page);
  await page.goto("/__license"); await ready(page);
  await expect(page.getByText("35 de 35 recurso(s) informado(s)")).toBeVisible();
  await expect(page.getByText("Página 1 de 3", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Próxima página", exact: true }).click(); await expect(page.getByText("Página 2 de 3", { exact: true })).toBeVisible();
  await page.getByLabel("Buscar recurso", { exact: true }).fill("cota zero");
  await expect(page.getByText("1 de 35 recurso(s) informado(s)")).toBeVisible();
  await expect(resourceList(page).getByRole("listitem")).toHaveCount(1);
  await expect(resourceList(page)).toContainText("Bloqueado na licença");
  await expect(resourceList(page).locator("dd").first()).toHaveText("0");
  await expect(resourceList(page)).toContainText("Este recurso tem cota zero");
  await page.getByRole("button", { name: "Limpar filtros", exact: true }).click();
  await page.getByLabel("Disponibilidade na licença", { exact: true }).selectOption("disabled");
  await expect(page.getByText("2 de 35 recurso(s) informado(s)")).toBeVisible();
  await expect(resourceList(page)).toContainText("Recurso desabilitado");
  await page.getByLabel("Disponibilidade na licença", { exact: true }).selectOption("unknown");
  await expect(page.getByText("1 de 35 recurso(s) informado(s)")).toBeVisible(); await expect(resourceList(page)).toContainText("Não informado");
  await page.getByRole("button", { name: "Limpar filtros", exact: true }).click(); await page.getByLabel("Buscar recurso", { exact: true }).fill("automacao");
  await expect(resourceList(page)).toContainText("Automação sem cota numérica"); await expect(resourceList(page)).toContainText("Sem cota numérica");
  await expect(page.getByRole("progressbar")).toHaveCount(0); await expect(page.getByText(/0 usados|100% disponível|Capacidade ilimitada/)).toHaveCount(0);
  expect(calls.license).toHaveLength(1); expect(calls.finance).toBe(0); expect(calls.writes).toBe(0);
});

test("datas preservam calendário/fuso e planos/módulos de origens diferentes não inventam autorização", async ({ page }) => {
  const data = licenseFixture(); data.license.validFrom = { kind: "date", value: "2026-09-01" }; data.license.validUntil = { kind: "date", value: "2026-10-02 17:30:00" }; data.license.graceUntil = { kind: "date", value: "2026-10-04T03:00:00-03:00" }; data.license.plan.code = "outro-plano"; data.comparison.plan = "different";
  await mockLicense(page, { data }); await page.goto("/__license"); await ready(page);
  await expect(page.getByText("01/09/2026", { exact: true })).toBeVisible();
  await expect(page.getByText("02/10/2026 17:30 (fuso não informado)", { exact: true })).toBeVisible();
  await expect(page.getByText("Códigos de plano divergem", { exact: true })).toBeVisible();
  await expect(page.getByText("Isso não prova um bloqueio", { exact: false })).toBeVisible();
  await expect(page.getByText("Resultado de validação não informado", { exact: true })).toBeVisible();
  await page.getByText("Módulos configurados no ambiente · 1 habilitados", { exact: true }).click();
  await expect(page.getByText("Não habilitado no ambiente", { exact: true })).toBeVisible();
  await page.getByText("Origem e atualização dos dados", { exact: true }).click();
  await expect(page.getByText("04/10/2026, 06:00 UTC · sem inferência de autorização", { exact: true })).toBeVisible();
  await expect(page.getByText("Consultado no serviço em", { exact: true }).locator("..").locator("dd")).toHaveText("08/09/2026, 12:00 UTC");
});

test("320/390px mantêm leitura, controles de 16px e conteúdo longo sem overflow", async ({ page }) => {
  const errors: string[] = []; page.on("pageerror", error => errors.push(error.message));
  const data = licenseFixture(); data.applicationPlan.name = "P".repeat(180); data.applicationPlan.expectedRemoteCode = "c".repeat(119); data.license.plan.name = "R".repeat(180); data.license.plan.code = "p".repeat(119); data.license.resources[0].name = "A".repeat(180); data.license.resources[0].code = "r".repeat(119);
  await mockLicense(page, { data }); await page.setViewportSize({ width: 320, height: 900 }); await page.goto("/__license"); await ready(page);
  for (const width of [320, 390]) {
    await page.setViewportSize({ width, height: 900 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await expect(page.getByLabel("Buscar recurso", { exact: true })).toHaveCSS("font-size", "16px");
    await expect(page.getByLabel("Disponibilidade na licença", { exact: true })).toHaveCSS("font-size", "16px");
  }
  await page.getByLabel("Buscar recurso", { exact: true }).fill("não existe"); await expect(page.getByRole("heading", { name: "Nenhum recurso corresponde aos filtros" })).toBeVisible();
  await page.getByRole("button", { name: "Limpar filtros", exact: true }).click();
  await page.screenshot({ path: "outputs/license-browser/workspace-mobile.png", fullPage: true });
  expect(errors).toEqual([]);
});

test("cache em memória preserva filtros e não prende loading ao abortar atualização e retornar", async ({ page }) => {
  await page.clock.install(); let pending: Route | undefined, requests = 0;
  const calls = await mockLicense(page, { intercept: async route => { requests++; if (requests === 2) { pending = route; return true; } return false; } });
  await page.goto("/__license"); await ready(page);
  await page.getByLabel("Buscar recurso", { exact: true }).fill("cota zero");
  await page.getByRole("button", { name: "Atualizar licença", exact: true }).click(); await expect.poll(() => Boolean(pending)).toBe(true);
  await page.getByRole("button", { name: "Alternar área de teste", exact: true }).click();
  await expect(page.getByText("Outra área de teste", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Alternar área de teste", exact: true }).click();
  await expect(page.getByRole("button", { name: "Atualizar licença", exact: true })).toBeEnabled();
  await expect(page.getByLabel("Buscar recurso", { exact: true })).toHaveValue("cota zero"); expect(calls.license).toHaveLength(2);
  const stale = licenseFixture(); stale.license.plan.name = "Resposta obsoleta que não deve aparecer"; await pending!.fulfill({ json: stale }).catch(() => undefined);
  await expect(page.getByText(stale.license.plan.name, { exact: true })).toHaveCount(0);
  await page.getByRole("button", { name: "Alternar área de teste", exact: true }).click();
  await page.clock.fastForward(16_000); expect(calls.license).toHaveLength(2);
  await page.getByRole("button", { name: "Alternar área de teste", exact: true }).click(); await expect.poll(() => calls.license.length).toBe(3);
  expect(calls.license.map(call => call.refresh)).toEqual([null, "1", null]);
  expect(await page.evaluate(() => [localStorage.length, sessionStorage.length])).toEqual([0, 0]);
});

test("troca de organização aborta consulta anterior e isola contexto e cache", async ({ page }) => {
  let previous: Route | undefined;
  const calls = await mockLicense(page, { intercept: async route => { if (route.request().headers()["x-organization-id"] === "license-org-a") { previous = route; return true; } return false; } });
  await page.goto("/__license"); await expect.poll(() => Boolean(previous)).toBe(true);
  await page.getByRole("button", { name: "Alternar organização de teste", exact: true }).click(); await ready(page);
  const stale = licenseFixture(); stale.license.plan.name = "Plano da organização anterior"; await previous!.fulfill({ json: stale }).catch(() => undefined);
  await expect(page.getByText(stale.license.plan.name, { exact: true })).toHaveCount(0);
  expect(calls.license.map(call => call.organization)).toEqual(["license-org-a", "license-org-b"]);
  await expect(page.getByRole("button", { name: "Atualizar licença", exact: true })).toBeEnabled();
});

test("falha e DTO parcial inválido preservam última consulta; 403 remove dados e exportação", async ({ page }) => {
  const errors: string[] = []; page.on("pageerror", error => errors.push(error.message)); let mode = "503";
  await mockLicense(page, { intercept: async route => {
    if (mode === "503" || mode === "403") { await route.fulfill({ status: Number(mode), json: { error: mode === "403" ? "Permissão de leitura removida." : "Licenciamento temporariamente indisponível." } }); return true; }
    if (mode === "malformed") { const data: unknown = { ...licenseFixture(), license: { ...licenseFixture().license, resources: [null] } }; await route.fulfill({ json: data }); return true; }
    if (["status-array", "availability-array", "invalid-date", "warning-object"].includes(mode)) {
      const data = licenseFixture();
      if (mode === "status-array") Object.assign(data.license, { status: ["active"] });
      if (mode === "availability-array") Object.assign(data.license.resources[0], { availability: ["enabled"] });
      if (mode === "invalid-date") data.license.validFrom = { kind: "date", value: "2026-99-99" };
      if (mode === "warning-object") Object.assign(data, { warnings: [{ message: "unexpected" }] });
      await route.fulfill({ json: data }); return true;
    }
    return false;
  } });
  await page.goto("/__license"); await expect(page.getByRole("heading", { name: "Consulta de licença indisponível" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Exportar diagnóstico", exact: true })).toHaveCount(0);
  mode = "ok"; await page.getByRole("button", { name: "Tentar novamente", exact: true }).click(); await ready(page);
  mode = "malformed"; await page.getByRole("button", { name: "Atualizar licença", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText("formato inesperado"); await expect(page.getByRole("alert")).toContainText("últimos dados recebidos");
  await expect(resourceList(page)).toBeVisible();
  for (const invalid of ["status-array", "availability-array", "invalid-date", "warning-object"]) {
    mode = invalid; await page.getByRole("button", { name: "Atualizar licença", exact: true }).click();
    await expect(page.getByRole("alert")).toContainText("formato inesperado"); await expect(resourceList(page)).toBeVisible();
    await expect(page.getByText("99/99/2026", { exact: true })).toHaveCount(0);
  }
  mode = "403"; await page.getByRole("button", { name: "Tentar novamente", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText("Permissão de leitura removida");
  await expect(resourceList(page)).toHaveCount(0); await expect(page.getByRole("button", { name: "Exportar diagnóstico", exact: true })).toHaveCount(0);
  expect(errors).toEqual([]);
});

test("429 respeita Retry-After sem martelar consulta", async ({ page }) => {
  let requests = 0;
  const calls = await mockLicense(page, { intercept: async route => { requests++; if (requests === 1) { await route.fulfill({ status: 429, headers: { "retry-after": "2" }, json: { error: "Aguarde antes de consultar novamente." } }); return true; } return false; } });
  await page.goto("/__license"); await expect(page.getByRole("alert")).toContainText("Aguarde antes de consultar");
  await expect(page.getByRole("alert").getByRole("button", { name: /Aguarde \d+s/ })).toBeDisabled(); expect(calls.license).toHaveLength(1);
  await expect(page.getByRole("button", { name: "Tentar novamente", exact: true })).toBeEnabled({ timeout: 5000 });
  await page.getByRole("button", { name: "Tentar novamente", exact: true }).click(); await ready(page); expect(calls.license).toHaveLength(2);
});

test("diagnóstico usa projeção explícita e exclui nomes, chaves, prefixos e metadados", async ({ page }) => {
  const data = licenseFixture();
  Object.assign(data, { organization: { id: "TENANT-PRIVATE", email: "private@example.invalid" }, metadata: { apiKey: "SECRET-TOP" } });
  Object.assign(data.license, { chave: "SECRET-LICENSE", chave_prefix: "SECRET-PREFIX" });
  Object.assign(data.license.resources[0].limit, { secret: "SECRET-LIMIT" });
  Object.assign(data.license.validFrom, { privateData: "SECRET-DATE" });
  const calls = await mockLicense(page, { data }); await page.goto("/__license"); await ready(page);
  const downloadPromise = page.waitForEvent("download"); await page.getByRole("button", { name: "Exportar diagnóstico", exact: true }).click(); const download = await downloadPromise;
  expect(download.suggestedFilename()).toMatch(/^nalven-diagnostico-licenca-\d{4}-\d{2}-\d{2}\.json$/);
  const contents = await readFile((await download.path())!, "utf8"), diagnostic = JSON.parse(contents);
  expect(contents).not.toMatch(/SECRET-|TENANT-PRIVATE|private@example|Gestão avançada|Cota zero do recurso/);
  expect(diagnostic.license.resources[0].limit).toEqual({ kind: "finite", value: 0 });
  expect(diagnostic.license.valid).toBeNull(); expect(diagnostic.license.resources).toHaveLength(35);
  await expect(page.getByText("Diagnóstico gerado sem chaves de licença", { exact: false })).toBeVisible();
  expect(calls.license).toHaveLength(1); expect(calls.writes).toBe(0);
  expect(await page.evaluate(() => [localStorage.length, sessionStorage.length])).toEqual([0, 0]);
});

test("status, validade e listas ausentes permanecem desconhecidos sem inventar licença ilimitada", async ({ page }) => {
  const data = licenseFixture(); data.license.status = "unknown"; data.license.statusCode = null; data.license.valid = false; data.license.validUntil = { kind: "unknown", value: null }; data.license.maxInstallations = { kind: "unknown", value: null }; data.license.resourcesKnown = false; data.license.resources = []; data.license.limitsKnown = false; data.license.limits = []; data.comparison.plan = "unknown";
  await mockLicense(page, { data }); await page.goto("/__license"); await ready(page);
  await expect(page.getByText("Status não confirmado", { exact: true })).toBeVisible(); await expect(page.getByText("Licença não validada", { exact: true })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Recursos não informados", exact: true })).toBeVisible(); await expect(page.getByRole("heading", { name: "Limites adicionais não informados", exact: true })).toBeVisible();
  await expect(page.getByText("Comparação não disponível", { exact: true })).toBeVisible(); await expect(page.getByText("Sem expiração", { exact: true })).toHaveCount(0);
  await expect(page.getByRole("button", { name: /Rotacionar|Renovar chave|Copiar chave/ })).toHaveCount(0);
});

test("consulta que não responde tem limite de espera e resposta tardia não substitui o erro", async ({ page }) => {
  await page.clock.install(); let delayed: Route | undefined;
  await mockLicense(page, { intercept: async route => { delayed = route; return true; } });
  await page.goto("/__license"); await expect.poll(() => Boolean(delayed)).toBe(true);
  await page.clock.fastForward(20_100);
  await expect(page.getByRole("alert")).toContainText("A consulta demorou mais que o esperado");
  await expect(page.getByRole("button", { name: "Atualizar licença", exact: true })).toBeEnabled();
  await delayed!.fulfill({ json: licenseFixture() }).catch(() => undefined);
  await expect(page.getByRole("button", { name: "Exportar diagnóstico", exact: true })).toHaveCount(0);
});

test("limite de espera inclui corpo JSON interrompido após os cabeçalhos", async ({ page }) => {
  await page.clock.install();
  await page.addInitScript(() => {
    const nativeFetch = window.fetch;
    window.fetch = async (input, init) => {
      const response = await nativeFetch(input, init);
      if (String(input).startsWith("/api/portal/license")) Object.defineProperty(response, "json", { value: () => new Promise((_resolve, reject) => { document.documentElement.dataset.jsonWaiting = "true"; init?.signal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")), { once: true }); }) });
      return response;
    };
  });
  await mockLicense(page); await page.goto("/__license");
  await expect(page.locator("html")).toHaveAttribute("data-json-waiting", "true");
  await page.clock.fastForward(20_100);
  await expect(page.getByRole("alert")).toContainText("A consulta demorou mais que o esperado");
  await expect(page.getByRole("button", { name: "Atualizar licença", exact: true })).toBeEnabled();
  await expect(page.getByRole("button", { name: "Exportar diagnóstico", exact: true })).toHaveCount(0);
});
