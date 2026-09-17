import { test, expect, type Page, type Route } from "@playwright/test";

function logisticsFixture() {
  const shipment = (id: number, status: string) => ({
    id, number: `EXP-UX-${id}`, status, priority: "normal", carrier: null,
    service: null, trackingCode: null, freight: 0, deadlineAt: null,
    dispatchDeadlineAt: null, packageCount: 1, weightKg: null, lengthCm: null,
    widthCm: null, heightCm: null, version: 0, assignedTo: null, station: null,
    holdReason: status === "on_hold" ? "Aguardar conferência" : null,
    fiscalRequired: false, fiscalStatus: "not_required", quotedFreightCents: null,
    actualFreightCents: null, chargedFreightCents: null, packedBy: null,
    createdAt: "2026-09-01T12:00:00Z", dispatchedAt: null, deliveredAt: null,
    deliveryRecipient: null, deliveryDocument: null, deliveryNotes: null,
    proofUrl: null, exceptionStatus: "none", exceptionCategory: null,
    exceptionOwner: null, exceptionDueAt: null, exceptionResolvedAt: null,
    exceptionResolution: null, manifestNumber: null, manifestedAt: null,
    handoffAt: null, cancellationReason: null,
    warehouse: { id: 1, name: "Depósito central", branch: { id: 1, name: "Matriz" } },
    salesOrder: { id, number: `PED-UX-${id}`, customerName: `Cliente ${id}`,
      customerEmail: null, total: 100, deliveryCity: "São Paulo", deliveryState: "SP",
      deliveryZip: null, deliveryStreet: null, deliveryNumber: null,
      deliveryComplement: null, deliveryDistrict: null, shippingLabels: [], tracking: null, returns: [] },
    channelOrder: null,
    items: [{ id, quantity: 2, pickedQuantity: 0, shortQuantity: 0, location: null,
      salesOrderItem: { id, productId: id, variationId: null, variation: null,
        product: { id, name: `Produto ${id}`, sku: `SKU-${id}`, price: 50, cost: 20, stock: 10, type: "product" } },
      pickAllocations: [] }],
    packages: [], incidents: [], waveEntries: [], manifestEntries: [], events: [],
  });
  return {
    shipments: [shipment(1, "picking"), shipment(2, "picking"), shipment(3, "on_hold")],
    pagination: { page: 1, pageSize: 50, total: 3, pages: 1 }, availableOrders: [], availableOrderCount: 0,
    warehouses: [{ id: 1, name: "Depósito central" }], carriers: [], channels: [], manifests: [], waves: [],
    branch: { id: 1, name: "Matriz", timezone: "America/Sao_Paulo", crossBranch: false },
    summary: { pending: 2, dispatched: 0, late: 0, dueToday: 0, urgent: 0, onTimeRate: 100,
      shipOnTimeRate: 100, otifRate: 100, firstAttemptRate: 100, averageCycleHours: 0,
      averagePickingHours: 0, averageTransitHours: 0, freight: 0, costPerShipment: 0,
      incidents: 0, exceptionRate: 0, manifested: 0, packageCount: 0, labelCoverageRate: 100,
      openReturns: 0, bi: { statusDistribution: [], dailyThroughput: [], carrierScorecards: [], exceptionCauses: [] } },
  };
}

async function openLogistics(page: Page, intercept: (route: Route) => Promise<void>) {
  await page.route("**/api/erp/logistics**", intercept);
  await page.goto("/__shell");
  await page.locator(".tenant-shell > aside").getByRole("link", { name: "Expedição e logística", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Central de execução logística" })).toBeVisible();
}

test("expedição mostra espera no quadro, seleção parcial e layout sem transbordar no celular", async ({ page }) => {
  const errors: string[] = []; page.on("pageerror", error => errors.push(error.message));
  await page.setViewportSize({ width: 1440, height: 1000 });
  await openLogistics(page, route => route.fulfill({ json: logisticsFixture() }));
  const selectAll = page.getByRole("checkbox", { name: "Selecionar expedições elegíveis nesta página" });
  await page.getByRole("checkbox", { name: "Selecionar EXP-UX-1", exact: true }).check();
  expect(await selectAll.evaluate(element => (element as HTMLInputElement).indeterminate)).toBe(true);
  await page.getByRole("button", { name: "Selecionar nesta página (2)", exact: true }).click();
  await expect(selectAll).toBeChecked();
  await page.getByLabel("Visualização da expedição", { exact: true }).selectOption("board");
  const held = page.getByRole("region", { name: "Expedições: Em espera", exact: true });
  await expect(held).toContainText("EXP-UX-3");
  await expect(held).toContainText("Aguardando liberação");
  await held.focus(); await expect(held).toBeFocused();
  expect(await held.evaluate(element => element.clientHeight)).toBeLessThanOrEqual(720);
  await page.setViewportSize({ width: 360, height: 780 });
  await page.getByRole("button", { name: "Mais filtros", exact: true }).click();
  await expect(page.getByLabel("De", { exact: true })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: "outputs/production-browser/mobile-logistics-board.png", fullPage: true });
  expect(errors).toEqual([]);
});

test("formulário logístico preserva foco ao atualizar, retém janela durante envio e mostra falha local", async ({ page }) => {
  let reads = 0;
  let releasePost: (() => void) | undefined;
  await page.setViewportSize({ width: 1440, height: 1000 });
  await openLogistics(page, async route => {
    if (route.request().method() === "POST") {
      await new Promise<void>(resolve => { releasePost = resolve; });
      await route.fulfill({ status: 400, json: { error: "Confira o código lido antes de separar." } });
      return;
    }
    reads++; await route.fulfill({ json: logisticsFixture() });
  });
  await page.locator("summary[aria-label='Ações de EXP-UX-1']:visible").click();
  await page.getByRole("button", { name: "Conferir separação", exact: true }).first().click();
  const dialog = page.getByRole("dialog");
  const quantity = dialog.getByLabel("Quantidade separada de Produto 1", { exact: true });
  await quantity.fill("1");
  const previousReads = reads;
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  await expect.poll(() => reads).toBeGreaterThan(previousReads);
  await expect(quantity).toBeFocused(); await expect(quantity).toHaveValue("1");
  await dialog.getByRole("button", { name: "Salvar conferência", exact: true }).click();
  await expect.poll(() => Boolean(releasePost)).toBe(true);
  await expect(dialog.getByRole("button", { name: "Fechar", exact: true })).toBeDisabled();
  await page.keyboard.press("Escape"); await expect(dialog).toBeVisible();
  releasePost!();
  await expect(dialog.getByRole("alert")).toHaveText("Confira o código lido antes de separar.");
  await expect(quantity).toHaveValue("1");
  await page.setViewportSize({ width: 360, height: 780 });
  expect(await dialog.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
  await page.screenshot({ path: "outputs/production-browser/mobile-logistics-picking.png", fullPage: true });
  await page.keyboard.press("Escape"); await expect(dialog).toHaveCount(0);
});

test("retorno a filtro em cache limpa falha e comando confirmado invalida outras páginas", async ({ page }) => {
  let allReads = 0; let mutated = false; let failRefresh = false;
  await openLogistics(page, async route => {
    const request = route.request(), status = new URL(request.url()).searchParams.get("status");
    if (request.method() === "POST") {
      mutated = true; failRefresh = true;
      await route.fulfill({ json: { ok: true } }); return;
    }
    if (status === "cancelled" || (failRefresh && status === "open")) {
      await route.fulfill({ status: 503, json: { error: "Filtro temporariamente indisponível" } }); return;
    }
    if (status === "all") allReads++;
    const data = logisticsFixture();
    if (mutated) data.shipments[0].salesOrder.customerName = "Cliente atualizado";
    await route.fulfill({ json: data });
  });
  const status = page.getByLabel("Filtrar expedições", { exact: true });
  await status.selectOption("all"); await expect.poll(() => allReads).toBe(1);
  await status.selectOption("cancelled");
  await expect(page.getByRole("alert")).toContainText("Filtro temporariamente indisponível");
  await status.selectOption("all"); await expect(page.getByRole("alert")).toHaveCount(0);
  await status.selectOption("open");
  await page.locator("summary[aria-label='Ações de EXP-UX-1']:visible").click();
  await page.getByRole("button", { name: "Conferir separação", exact: true }).first().click();
  const dialog = page.getByRole("dialog");
  await dialog.getByLabel("Quantidade separada de Produto 1", { exact: true }).fill("1");
  await dialog.getByRole("button", { name: "Salvar conferência", exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await expect(page.getByRole("alert")).toContainText("A operação foi concluída");
  await status.selectOption("all"); await expect.poll(() => allReads).toBe(2);
  await expect(page.getByText("Cliente atualizado", { exact: true }).first()).toBeVisible();
});

test("expedição confirma resposta perdida com a mesma chave e ignora envio simultâneo", async ({ page }) => {
  const keys: string[] = [], committed = new Set<string>();
  await openLogistics(page, async route => {
    if (route.request().method() === "POST") {
      const key = route.request().headers()["idempotency-key"];
      expect(key).toBeTruthy(); keys.push(key); committed.add(key);
      if (keys.length === 1) await route.abort("failed");
      else await route.fulfill({ json: { ok: true } });
      return;
    }
    await route.fulfill({ json: logisticsFixture() });
  });
  await page.locator("summary[aria-label='Ações de EXP-UX-1']:visible").click();
  await page.getByRole("button", { name: "Conferir separação", exact: true }).first().click();
  const dialog = page.getByRole("dialog");
  await dialog.getByLabel("Quantidade separada de Produto 1", { exact: true }).fill("1");
  await dialog.locator("form").evaluate(form => {
    (form as HTMLFormElement).requestSubmit();
    (form as HTMLFormElement).requestSubmit();
  });
  await expect(dialog.getByRole("alert")).toContainText("Não foi possível confirmar o resultado");
  expect(keys).toHaveLength(1);
  await dialog.getByRole("button", { name: "Salvar conferência", exact: true }).click();
  await expect(dialog).toHaveCount(0);
  expect(keys).toHaveLength(2); expect(keys[0]).toBe(keys[1]);
  expect(committed.size).toBe(1);
});

for (const revokedStatus of [401, 403]) {
  test(`expedição remove dados e cache após revogação HTTP ${revokedStatus}`, async ({ page }) => {
    let revoked = false, readsAfterRevoke = 0;
    await openLogistics(page, async route => {
      if (revoked) {
        readsAfterRevoke++;
        await route.fulfill({ status: revokedStatus, json: { error: "Acesso revogado para esta operação." } });
      } else await route.fulfill({ json: logisticsFixture() });
    });
    await expect(page.getByText("Cliente 1", { exact: true }).first()).toBeVisible();
    revoked = true;
    await page.getByRole("button", { name: "Atualizar", exact: true }).click();
    await expect(page.getByRole("alert")).toContainText("Acesso revogado");
    await expect(page.getByRole("button", { name: "Exportar CSV", exact: true })).toHaveCount(0);
    await expect(page.getByText("Cliente 1", { exact: true })).toHaveCount(0);
    const aside = page.locator(".tenant-shell > aside");
    await aside.getByRole("link", { name: "Produção e kits", exact: true }).click();
    await aside.getByRole("link", { name: "Expedição e logística", exact: true }).click();
    await expect.poll(() => readsAfterRevoke).toBeGreaterThanOrEqual(2);
    await expect(page.getByRole("alert")).toContainText("Acesso revogado");
    await expect(page.getByText("Cliente 1", { exact: true })).toHaveCount(0);
  });
}
