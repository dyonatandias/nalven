import { expect, test, type Page } from "@playwright/test";

const product = {
  id: 1, name: "Componente de reposição para equipamento industrial", sku: "REP-001", unit: "un", cost: 12, stock: 10,
};
const warehouses = [
  { id: 1, code: "MATRIZ", name: "Depósito principal", active: true, primary: true, balances: [{ id: 1, productId: 1, quantity: 10, reservedQuantity: 1, product }] },
  { id: 2, code: "APOIO", name: "Depósito de apoio", active: true, primary: false, balances: [] },
];
const catalog = {
  products: [product], warehouses,
  positions: [{ ...product, physical: 10, reserved: 1, available: 9, value: 120, belowMinimum: false, minStock: 1, warehouses: [{ id: 1, code: "MATRIZ", name: "Depósito principal", quantity: 10, reservedQuantity: 1, available: 9 }] }],
  counts: [
    { id: 1, number: "INV-ABERTA", status: "draft", blind: true, createdAt: "2026-09-07T12:00:00Z", warehouse: warehouses[0], items: [{ id: 1, productId: 1, systemQuantity: 10, product }] },
    { id: 2, number: "INV-CANCELADA", status: "cancelled", blind: true, createdAt: "2026-09-06T12:00:00Z", warehouse: warehouses[1], items: [] },
  ],
  transfers: [{ id: 1, number: "TRF-001", status: "completed", transferredBy: "Operador", createdAt: "2026-09-07T12:00:00Z", fromWarehouse: warehouses[0], toWarehouse: warehouses[1], items: [{ id: 1, quantity: 1, product }] }],
  ledger: Array.from({ length: 55 }, (_, index) => ({ id: String(index + 1), type: "purchase_receipt", quantity: 1, balanceBefore: index, balanceAfter: index + 1, createdAt: "2026-09-07T12:00:00Z", warehouse: warehouses[0], product })),
  pagination: { counts: { total: 120, shown: 2 }, transfers: { total: 110, shown: 1 }, ledger: { page: 1, limit: 50, total: 55, pages: 2 } },
  summary: { warehouses: 2, products: 1, stockValue: 120, physical: 10, reserved: 1, available: 9, reservedProducts: 1, lowStock: 0, negative: 0, openCounts: 1, divergences: 0 },
};

async function inventoryFixture(page: Page, ledgerEntries = catalog.ledger) {
  const ledgerQueries: URLSearchParams[] = [];
  await page.route("**/api/erp/inventory**", async route => {
    if (route.request().method() !== "GET") {
      await route.fulfill({ status: 409, contentType: "application/json", body: JSON.stringify({ error: "O depósito foi alterado. Revise os dados antes de tentar novamente." }) });
      return;
    }
    const params = new URL(route.request().url()).searchParams;
    ledgerQueries.push(params);
    const currentPage = Number(params.get("ledgerPage") || 1);
    const term = (params.get("ledgerSearch") || "").toLowerCase();
    // Mirrors server-side raw event-code search; the client must not filter the
    // response a second time using translated event labels.
    const entries = ledgerEntries.filter(entry => !term || `${entry.type} ${entry.product.name} ${entry.product.sku} ${entry.warehouse.name}`.toLowerCase().includes(term));
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({
      ...catalog, ledger: entries.slice((currentPage - 1) * 50, currentPage * 50),
      pagination: { ...catalog.pagination, ledger: { page: currentPage, limit: 50, total: entries.length, pages: Math.max(1, Math.ceil(entries.length / 50)) } },
    }) });
  });
  await page.goto("/__shell");
  await page.locator(".tenant-shell > aside").getByRole("link", { name: "Inventário e depósitos", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Posição consolidada por produto", exact: true })).toBeVisible();
  return ledgerQueries;
}

test("inventário usa abas pelo teclado e preserva resultados/paginação do razão", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const queries = await inventoryFixture(page);
  const tabs = page.getByRole("tablist", { name: "Visualização do inventário", exact: true });
  await tabs.getByRole("tab", { name: /^Posição/ }).focus();
  await page.keyboard.press("ArrowRight");
  await expect(tabs.getByRole("tab", { name: /^Depósitos/ })).toBeFocused();
  await expect(tabs.getByRole("tab", { selected: true })).toHaveText(/Depósitos/);
  await page.keyboard.press("End");
  await expect(tabs.getByRole("tab", { name: /^Razão/ })).toBeFocused();
  const panel = page.getByRole("tabpanel");
  await expect(panel.getByRole("row")).toHaveCount(51);
  await panel.getByRole("button", { name: "Próxima", exact: true }).click();
  await expect(panel.getByText("Página 2 de 2", { exact: false })).toBeVisible();
  await expect(panel.getByRole("row")).toHaveCount(6);
  await page.getByRole("search").getByLabel("Buscar", { exact: true }).fill("purchase_receipt");
  await expect.poll(() => queries.at(-1)?.get("ledgerSearch")).toBe("purchase_receipt");
  await expect(panel.getByText("Página 1 de 2", { exact: false })).toBeVisible();
  await expect(panel.getByRole("row")).toHaveCount(51);
  await tabs.getByRole("tab", { name: /^Contagens/ }).click();
  await expect(page.getByText("A busca e o status filtram apenas os registros carregados.", { exact: false })).toBeVisible();
  await expect(page.getByText("Sem alteração de saldo", { exact: true })).toBeVisible();
});

test("erro de inventário fica dentro do diálogo e uma operação pendente não é descartada", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await inventoryFixture(page);
  let writes = 0;
  let release = () => {};
  const pending = new Promise<void>(resolve => { release = resolve; });
  await page.route("**/api/erp/inventory", async route => {
    if (route.request().method() !== "POST") { await route.fallback(); return; }
    writes += 1;
    await pending;
    await route.fulfill({ status: 409, contentType: "application/json", body: JSON.stringify({ error: "Já existe um depósito com este código." }) });
  });
  const opener = page.getByRole("button", { name: "Novo depósito", exact: true });
  await opener.click();
  const dialog = page.getByRole("dialog", { name: "Novo depósito", exact: true });
  await dialog.getByLabel("Nome", { exact: true }).fill("Depósito revisão");
  await dialog.getByLabel("Código", { exact: true }).fill("MATRIZ");
  await dialog.getByRole("button", { name: "Criar depósito", exact: true }).focus();
  await page.keyboard.press("Tab");
  expect(await dialog.evaluate(element => element.contains(document.activeElement))).toBe(true);
  await dialog.getByRole("button", { name: "Criar depósito", exact: true }).click();
  await expect.poll(() => writes).toBe(1);
  await page.keyboard.press("Escape");
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole("button", { name: "Cancelar", exact: true })).toBeDisabled();
  release();
  await expect(dialog.getByRole("alert")).toHaveText("Já existe um depósito com este código.");
  await expect(dialog.getByLabel("Nome", { exact: true })).toHaveValue("Depósito revisão");
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
  await expect(opener).toBeFocused();
  await opener.click();
  await expect(page.getByRole("dialog").getByRole("alert")).toHaveCount(0);
  expect(writes).toBe(1);
});

test("inventário móvel contém formulários e não aceita contagens negativas ocultas por busca", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  await page.setViewportSize({ width: 1440, height: 900 });
  await inventoryFixture(page);
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.locator(".inventory-position-cards")).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.getByLabel("Visualização", { exact: true }).selectOption("counts");
  await page.getByRole("button", { name: "Preencher", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Informar contagem física", exact: true });
  const quantity = dialog.getByLabel(`Quantidade contada de ${product.name}`, { exact: true });
  await expect(dialog.getByText("Saldo do sistema oculto até o fechamento", { exact: true })).toBeVisible();
  await quantity.fill("-1");
  await dialog.getByLabel("Localizar produto", { exact: true }).fill("não corresponde");
  await expect(dialog.getByRole("progressbar")).toHaveAttribute("aria-valuenow", "0");
  await expect(dialog.getByRole("button", { name: "Finalizar contagem", exact: true })).toBeDisabled();
  await dialog.getByLabel("Localizar produto", { exact: true }).fill("");
  await quantity.fill("0");
  await expect(dialog.getByRole("progressbar")).toHaveAttribute("aria-valuenow", "1");
  await expect(dialog.getByRole("button", { name: "Finalizar contagem", exact: true })).toBeEnabled();
  expect(await dialog.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: "outputs/production-browser/mobile-inventory-count.png" });
  await page.keyboard.press("Escape");
  await page.getByRole("button", { name: "Nova transferência", exact: true }).click();
  const transfer = page.getByRole("dialog", { name: "Nova transferência", exact: true });
  await transfer.getByRole("combobox", { name: "Origem", exact: true }).selectOption("1");
  await transfer.getByRole("combobox", { name: "Destino", exact: true }).selectOption("2");
  await transfer.getByLabel("Produto da linha 1", { exact: true }).selectOption("1");
  await transfer.getByLabel("Quantidade da linha 1", { exact: true }).fill("11");
  await expect(transfer.getByRole("button", { name: "Concluir transferência", exact: true })).toBeDisabled();
  await transfer.getByLabel("Quantidade da linha 1", { exact: true }).fill("1");
  await expect(transfer.getByRole("button", { name: "Concluir transferência", exact: true })).toBeEnabled();
  expect(await transfer.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
  await page.screenshot({ path: "outputs/production-browser/mobile-inventory-transfer.png" });
  expect(errors).toEqual([]);
});

test("razão móvel contém dados longos após fechar diálogo e redimensionar a tela", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const ledger = catalog.ledger.map((entry, index) => ({
    ...entry,
    type: `importacao_estoque_${"evento_legado_".repeat(8)}`,
    quantity: 999999999.9999,
    balanceBefore: 999999999.9999,
    balanceAfter: 999999999.9999,
    product: { ...entry.product, name: `${product.name} — Série ${index + 1}`, sku: `LEGADO-${"0123456789ABCDEF".repeat(8)}` },
    warehouse: { ...entry.warehouse, name: `Depósito-${"ORIGEMINTEGRACAO".repeat(6)}` },
  }));
  await inventoryFixture(page, ledger);
  const opener = page.getByRole("button", { name: "Novo depósito", exact: true });
  await opener.click();
  await page.getByRole("dialog", { name: "Novo depósito", exact: true }).getByRole("button", { name: "Cancelar", exact: true }).click();
  await expect(opener).toBeFocused();
  await page.getByRole("tab", { name: /^Razão/ }).click();
  await expect(page.getByRole("tabpanel").getByRole("row")).toHaveCount(51);
  await page.setViewportSize({ width: 390, height: 844 });
  const cards = page.locator(".inventory-ledger-cards");
  await expect(cards).toBeVisible();
  await expect(cards.locator("article")).toHaveCount(50);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  expect(await page.locator(".erp-inventory").evaluate(element => element.getBoundingClientRect().right <= innerWidth)).toBe(true);
  expect(await cards.locator("article").first().evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
  await expect(cards.getByText(ledger[0].product.sku, { exact: false }).first()).toBeVisible();
  const pager = page.locator(".inventory-ledger-panel > .supply-pager");
  await pager.scrollIntoViewIfNeeded();
  await expect(pager.getByRole("button", { name: "Próxima", exact: true })).toBeVisible();
  expect(await pager.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
  await page.screenshot({ path: "outputs/production-browser/mobile-inventory-ledger.png" });
});
