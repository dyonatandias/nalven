import { test, expect, type Page } from "@playwright/test";

async function unavailableModules(page: Page) {
  for (const modulePath of ["inventory", "logistics"]) {
    await page.route(`**/api/erp/${modulePath}**`, route => route.fulfill({
      status: 503,
      contentType: "application/json",
      body: JSON.stringify({ error: "Módulo indisponível neste teste do menu" }),
    }));
  }
}

test("resposta atrasada de produtos não mostra erro sobre a página de produção", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  let release!: () => void;
  let started!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  const requested = new Promise<void>(resolve => { started = resolve; });
  const staleError = "Falha tardia exclusiva do catálogo anterior";
  let requests = 0;
  await page.route("**/api/erp?scope=products", async route => {
    requests++;
    started();
    await held;
    await route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ error: staleError }) });
  });
  try {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto("/__shell");
    const aside = page.locator(".tenant-shell > aside");
    const active = aside.locator("a[aria-current='page']");
    await aside.getByRole("link", { name: "Produtos e serviços", exact: true }).click();
    await requested;
    await expect(active).toHaveText("Produtos e serviços");
    await aside.getByRole("link", { name: "Produção e kits", exact: true }).click();
    await expect(active).toHaveText("Produção e kits");
    const response = page.waitForResponse(response => response.url().endsWith("/api/erp?scope=products") && response.status() === 503);
    release();
    await (await response).finished();
    // Allow the completed fetch and React render to settle before asserting absence.
    await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
    await expect(page.locator(".tenant-error")).toHaveCount(0);
    await expect(page.getByText(staleError, { exact: true })).toHaveCount(0);
    await expect(page.getByRole("heading", { name: "Produção e kits", exact: true })).toBeVisible();
    await expect(active).toHaveCount(1);
    expect(requests).toBe(1);
    expect(errors).toEqual([]);
  } finally {
    release();
  }
});

for (const blockedReads of [true, false]) {
  test(`menu continua utilizável com ${blockedReads ? "storage bloqueado" : "quota de storage esgotada"}`, async ({ page }) => {
    const errors: string[] = [];
    page.on("pageerror", error => errors.push(error.message));
    await page.addInitScript(({ blockedReads }) => {
      if (blockedReads) {
        Storage.prototype.getItem = function () {
          throw new DOMException("Storage indisponível", "SecurityError");
        };
      }
      Storage.prototype.setItem = function () {
        throw new DOMException("Preferência não pode ser gravada", blockedReads ? "SecurityError" : "QuotaExceededError");
      };
    }, { blockedReads });
    await unavailableModules(page);
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto("/__shell");
    const shell = page.locator(".tenant-shell");
    const aside = shell.locator(":scope > aside");
    const active = aside.locator("a[aria-current='page']");
    await expect(shell).toBeVisible();
    for (const label of ["Inventário e depósitos", "Expedição e logística", "Produção e kits"]) {
      await aside.getByRole("link", { name: label, exact: true }).click();
      await expect(active).toHaveText(label);
      await expect(active).toHaveCount(1);
    }
    await aside.getByRole("button", { name: "Recolher menu", exact: true }).click();
    await expect(shell).toHaveClass(/sidebar-compact/);
    await page.getByRole("button", { name: "Fechar menu lateral", exact: true }).click();
    await expect(aside).toHaveAttribute("inert", "");
    await page.getByRole("button", { name: "Abrir menu lateral", exact: true }).click();
    await expect(aside).not.toHaveAttribute("inert", "");
    await expect(active).toHaveText("Produção e kits");
    expect(errors).toEqual([]);
  });
}

for (const failure of ["network", "http"] as const) {
  test(`falha ${failure === "network" ? "de rede" : "HTTP"} no logout mantém a página e permite tentar novamente`, async ({ page }) => {
    const errors: string[] = [];
    page.on("pageerror", error => errors.push(error.message));
    let attempts = 0;
    await page.route("**/api/auth/logout", async route => {
      attempts++;
      expect(route.request().method()).toBe("POST");
      if (failure === "network") await route.abort("failed");
      else await route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ error: "Logout indisponível" }) });
    });
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto("/__shell");
    const button = page.locator(".tenant-shell > aside").getByRole("button", { name: "Sair da conta", exact: true });
    for (let attempt = 1; attempt <= 2; attempt++) {
      await button.click();
      await expect(page.locator(".tenant-error")).toContainText("Não foi possível sair da conta");
      await expect.poll(() => attempts).toBe(attempt);
      await expect(page).toHaveURL(/\/__shell$/);
      await expect(button).toBeEnabled();
      await expect(page.locator(".tenant-shell > aside a[aria-current='page']")).toHaveText("Produção e kits");
    }
    expect(errors).toEqual([]);
  });
}
