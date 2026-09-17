import { test, expect, type Locator } from "@playwright/test";

test("menu lateral real mantém página ativa, rodapé compacto e foco acessível no celular", async ({ page }) => {
  const errors: string[] = []; page.on("pageerror", error => errors.push(error.message));
  // These reads deliberately fail: verify that navigation remains usable while a module is unavailable.
  await page.route("**/api/erp/inventory**", route => route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ error: "Inventário indisponível no teste de navegação" }) }));
  await page.route("**/api/erp/logistics**", route => route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ error: "Expedição indisponível no teste de navegação" }) }));
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/__shell");
  const aside = page.locator(".tenant-shell > aside"), active = aside.locator("a[aria-current='page']");
  await expect(active).toHaveText("Produção e kits");
  await expect(page.getByRole("heading", { level: 1 })).toHaveCount(1);
  expect(await aside.locator("footer").evaluate(element => element.getBoundingClientRect().height)).toBeLessThan(150);
  for (const name of ["Inventário e depósitos", "Expedição e logística", "Produção e kits"]) {
    await aside.getByRole("link", { name, exact: true }).click();
    await expect(active).toHaveText(name); await expect(active).toHaveCount(1);
  }
  await expect(page.getByRole("navigation", { name: "Módulos comerciais e de suprimentos" })).toHaveCount(0);
  const lane = page.getByRole("region", { name: "Ordens: Planejada", exact: true });
  await expect(lane).toBeVisible();
  expect(await lane.evaluate(element => element.getBoundingClientRect().top)).toBeLessThan(800);
  expect(await lane.evaluate(element => element.clientHeight)).toBeLessThanOrEqual(720);
  await page.screenshot({ path: "outputs/production-browser/desktop-sidebar.png" });
  await aside.getByRole("button", { name: "Recolher menu", exact: true }).click();
  await expect(page.locator(".tenant-shell")).toHaveClass(/sidebar-compact/);
  await page.getByRole("button", { name: "Fechar menu lateral", exact: true }).click();
  await expect(aside).toHaveAttribute("inert", "");
  await page.getByRole("button", { name: "Abrir menu lateral", exact: true }).click();
  await page.setViewportSize({ width: 390, height: 844 });
  const opener = page.getByRole("button", { name: "Abrir menu", exact: true });
  await expect(aside).toHaveAttribute("inert", ""); await opener.click();
  await expect(aside).toHaveAttribute("aria-modal", "true");
  await expect(active).toBeFocused();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.screenshot({ path: "outputs/production-browser/mobile-sidebar.png" });
  await aside.getByRole("button", { name: "Sair da conta", exact: true }).focus();
  await page.keyboard.press("Tab");
  expect(await aside.evaluate(element => element.contains(document.activeElement))).toBe(true);
  await page.keyboard.press("Escape"); await expect(opener).toBeFocused(); await expect(aside).toHaveAttribute("inert", "");
  expect(errors).toEqual([]);
});

test("recebimento parcial no celular confirma resposta perdida sem duplicar entrada", async ({ page, request }) => {
  const fixture = await (await request.get("/__fixture")).json();
  const call = async (data: Record<string, unknown>) => {
    const response = await request.post("/api/erp/production/operations", { data: { ...data, idempotencyKey: crypto.randomUUID() } });
    expect(response.ok(), await response.text()).toBe(true); return response.json();
  };
  const order = await call({ action: "order.create", bomId: fixture.bomId, warehouseId: fixture.warehouseId, plannedQuantity: 1000 });
  const purchase = await call({ action: "mrp.purchase", orderId: order.orderId, version: 0, productId: fixture.materialId, supplierId: fixture.supplierId, quantity: 2, unitCostCents: 1250 });
  const path = `/api/erp/purchases/${purchase.purchaseOrderId}`;
  expect((await request.patch(path, { data: { action: "submit" } })).ok()).toBe(true);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`/?receipt=${purchase.purchaseOrderId}`);
  const dialog = page.getByRole("dialog");
  await dialog.getByLabel("Quantidade recebida de Tecido algodão · cru", { exact: true }).fill("1");
  await dialog.getByText("Lote, séries e validade", { exact: true }).click();
  await dialog.getByLabel("Lote do fornecedor", { exact: true }).fill(`RECEIPT-${fixture.token}`);
  await dialog.getByLabel("Validade", { exact: true }).fill("2090-01-01");
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  expect(await dialog.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
  await page.screenshot({ path: "outputs/production-browser/mobile-receipt.png", fullPage: true });
  const keys: string[] = [];
  await page.route(`**${path}`, async route => {
    if (route.request().method() !== "PATCH") { await route.continue(); return; }
    keys.push(route.request().postDataJSON().idempotencyKey);
    if (keys.length === 1) { const committed = await route.fetch(); expect(committed.ok(), await committed.text()).toBe(true); await route.abort("failed"); }
    else await route.continue();
  });
  await dialog.getByRole("button", { name: "Confirmar recebimento", exact: true }).click();
  await expect(dialog.getByLabel("Depósito de destino", { exact: true })).toBeDisabled();
  await dialog.getByRole("button", { name: "Confirmar resultado do recebimento", exact: true }).click();
  await expect(page.getByRole("status")).toHaveText("Recebimento confirmado");
  expect(keys).toHaveLength(2); expect(keys[0]).toBe(keys[1]);
  const result = await (await request.get(path)).json();
  expect(result.order.status).toBe("partially_received");
  expect(result.order.items[0].receivedQuantity).toBe(1);
  expect(result.order.receipts).toHaveLength(1);
  expect(result.order.receipts[0].warehouseId).toBe(fixture.warehouseId);
});

test("Gantt mostra agendamentos, mantém dependências no formulário e cabe no celular", async ({ page, request }) => {
  const fixture = await (await request.get("/__fixture")).json();
  const token = `E2E-GANTT-${Date.now()}`;
  const call = async (data: Record<string, unknown>) => {
    const response = await request.post("/api/erp/production/operations", { data: { ...data, idempotencyKey: crypto.randomUUID() } });
    expect(response.ok()).toBe(true); return response.json();
  };
  const center = await call({ action: "center.save", name: token, timeZone: "UTC", shifts: Array.from({ length: 7 }, (_, day) => ({ day, start: "08:00", end: "18:00" })), wipLimit: 1 });
  const prior = await call({ action: "order.create", bomId: fixture.bomId, warehouseId: fixture.warehouseId, plannedQuantity: 1, assignedTo: `${token}-prior` });
  const next = await call({ action: "order.create", bomId: fixture.bomId, warehouseId: fixture.warehouseId, plannedQuantity: 1, assignedTo: `${token}-next` });
  await call({ action: "order.schedule", orderId: prior.orderId, version: 0, workCenterId: center.id, scheduledStart: "2090-01-02T08:00:00Z", scheduledEnd: "2090-01-02T09:00:00Z" });
  await call({ action: "order.schedule", orderId: next.orderId, version: 0, workCenterId: center.id, scheduledStart: "2090-01-02T10:00:00Z", scheduledEnd: "2090-01-02T11:00:00Z", predecessorIds: [prior.orderId] });
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto("/"); await page.getByLabel("Buscar", { exact: true }).fill(`${token}-next`);
  await page.getByLabel("Exibição", { exact: true }).selectOption("calendar");
  await page.getByLabel("De", { exact: true }).fill("2090-01-01");
  await page.getByLabel("Até", { exact: true }).fill("2090-01-07");
  const gantt = page.getByLabel("Calendário Gantt de produção", { exact: true });
  await expect(gantt).toBeVisible(); await expect(gantt.getByRole("button")).toHaveCount(2);
  await page.screenshot({ path: "outputs/production-browser/desktop-gantt.png", fullPage: true });
  await gantt.getByRole("button").first().click();
  await page.getByRole("dialog").getByRole("button", { name: "Agendar recurso", exact: true }).click();
  await expect(page.getByRole("dialog").getByLabel("Ordens predecessoras", { exact: true })).toHaveValue(String(prior.orderId));
  await page.keyboard.press("Escape");
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.screenshot({ path: "outputs/production-browser/mobile-gantt.png", fullPage: true });
});

async function choose(select: Locator, text: string) {
  const option = select.locator("option").filter({ hasText: text }).first();
  await expect(option).toBeAttached();
  await select.selectOption((await option.getAttribute("value"))!);
}

test("desktop exibe Kanban, filtros, paginação e diálogo com foco contido", async ({
  page,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto("/");
  await expect(
    page.getByRole("heading", { name: "Produção e kits", exact: true }),
  ).toBeVisible();
  await expect(page.getByLabel("Kanban de produção")).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Nova ordem", exact: true }),
  ).toBeVisible();
  await page.screenshot({
    path: "outputs/production-browser/desktop.png",
    fullPage: true,
  });
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
  await page.getByRole("button", { name: "Nova ordem", exact: true }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toBeVisible();
  await page.keyboard.press("Shift+Tab");
  expect(
    await dialog.evaluate((element) =>
      element.contains(document.activeElement),
    ),
  ).toBe(true);
  await page.keyboard.press("Escape");
  await expect(dialog).not.toBeVisible();
  expect(errors).toEqual([]);
});

test("operador cria ordem, inicia, aponta parcialmente e aprova a qualidade pelo navegador", async ({
  page,
  request,
}) => {
  const fixture = await (await request.get("/__fixture")).json();
  await page.setViewportSize({ width: 1366, height: 900 });
  await page.goto("/");
  await page.getByRole("button", { name: "Nova ordem", exact: true }).click();
  let dialog = page.getByRole("dialog");
  await dialog
    .getByLabel("Buscar ficha técnica", { exact: true })
    .fill(fixture.token);
  await choose(
    dialog.getByLabel("Ficha técnica", { exact: true }),
    `ESS-${fixture.token}`,
  );
  await dialog
    .getByLabel("Buscar depósito", { exact: true })
    .fill(fixture.token);
  await choose(
    dialog.getByLabel("Depósito", { exact: true }),
    `BROWSER-${fixture.token}`,
  );
  await dialog.getByLabel("Quantidade planejada", { exact: true }).fill("2");
  const assignee = `E2E-${Date.now()}`;
  await dialog.getByLabel("Responsável", { exact: true }).fill(assignee);
  await dialog
    .getByRole("button", { name: "Criar ordem", exact: true })
    .click();
  await expect(dialog).not.toBeVisible();
  await page.getByLabel("Buscar", { exact: true }).fill(assignee);
  await expect(
    page.getByRole("button", { name: "Abrir ordem", exact: true }),
  ).toHaveCount(1);
  await page.getByRole("button", { name: "Abrir ordem", exact: true }).click();
  dialog = page.getByRole("dialog");
  await dialog
    .getByRole("button", { name: "Iniciar produção", exact: true })
    .click();
  await expect(
    dialog.getByRole("button", { name: "Apontar produção", exact: true }),
  ).toBeVisible();
  await dialog
    .getByRole("button", { name: "Apontar produção", exact: true })
    .click();
  await dialog.getByLabel("Quantidade boa", { exact: true }).fill("1");
  await dialog.getByLabel("Mão de obra (minutos)", { exact: true }).fill("12");
  await dialog
    .getByRole("button", { name: "Registrar apontamento parcial", exact: true })
    .click();
  await expect(dialog).not.toBeVisible();
  await page.getByRole("button", { name: "Abrir ordem", exact: true }).click();
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "Inspecionar qualidade", exact: true })
    .click();
  dialog = page.getByRole("dialog");
  for (const label of [
    "Dimensões conferidas",
    "Costuras conferidas",
    "Embalagem íntegra",
  ])
    await dialog.getByLabel(label, { exact: true }).selectOption("pass");
  await dialog
    .getByLabel("Parecer do inspetor", { exact: true })
    .fill("Peça e embalagem conferidas no teste operacional.");
  await dialog
    .getByRole("button", {
      name: "Registrar decisão e certificado",
      exact: true,
    })
    .click();
  await expect(dialog).not.toBeVisible();
  await page.getByRole("button", { name: "Abrir ordem", exact: true }).click();
  dialog = page.getByRole("dialog");
  await expect(
    dialog.getByRole("button", { name: "Imprimir certificado", exact: true }),
  ).toBeVisible();
  await page.screenshot({
    path: "outputs/production-browser/order-quality.png",
    fullPage: true,
  });
  await dialog
    .getByRole("button", { name: "Concluir ordem", exact: true })
    .click();
  await page
    .getByRole("dialog")
    .getByLabel("Justificativa", { exact: true })
    .fill("Encerramento parcial autorizado com liberação do saldo restante.");
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "Confirmar", exact: true })
    .click();
  await expect(page.getByRole("dialog")).not.toBeVisible();
  await expect(
    page
      .getByLabel("Kanban de produção")
      .getByRole("article")
      .getByText("Concluída", { exact: true }),
  ).toBeVisible();
});

test("celular mantém controles visíveis, formulários utilizáveis e nenhuma rolagem horizontal da página", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/");
  await expect(page.getByLabel("Kanban de produção")).toBeVisible();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
  await page.screenshot({
    path: "outputs/production-browser/mobile.png",
    fullPage: true,
  });
  await page.getByRole("button", { name: "Nova ficha", exact: true }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toBeVisible();
  expect(
    await dialog.evaluate(
      (element) => element.scrollWidth <= element.clientWidth,
    ),
  ).toBe(true);
  await expect(dialog.getByLabel("Nome", { exact: true })).toBeVisible();
  await page.screenshot({
    path: "outputs/production-browser/mobile-bom.png",
    fullPage: true,
  });
  await dialog
    .getByRole("button", { name: "Fechar diálogo", exact: true })
    .click();
  await page.getByLabel("Recurso", { exact: true }).selectOption("centers");
  await page.getByRole("button", { name: "Novo recurso", exact: true }).click();
  await expect(
    page.getByRole("dialog").getByRole("heading", { name: "Turnos semanais" }),
  ).toBeVisible();
  expect(
    await page
      .getByRole("dialog")
      .evaluate((element) => element.scrollWidth <= element.clientWidth),
  ).toBe(true);
});

test("uma resposta perdida repete a mesma operação e não duplica a ordem", async ({
  page,
  request,
}) => {
  const fixture = await (await request.get("/__fixture")).json();
  const assignee = `E2E-RETRY-${Date.now()}`;
  await page.goto("/");
  await page.getByRole("button", { name: "Nova ordem", exact: true }).click();
  const dialog = page.getByRole("dialog");
  await dialog
    .getByLabel("Buscar ficha técnica", { exact: true })
    .fill(fixture.token);
  await choose(
    dialog.getByLabel("Ficha técnica", { exact: true }),
    `ESS-${fixture.token}`,
  );
  await dialog
    .getByLabel("Buscar depósito", { exact: true })
    .fill(fixture.token);
  await choose(
    dialog.getByLabel("Depósito", { exact: true }),
    `BROWSER-${fixture.token}`,
  );
  await dialog.getByLabel("Responsável", { exact: true }).fill(assignee);
  const keys: string[] = [];
  await page.route("**/api/erp/production/operations", async (route) => {
    if (route.request().method() !== "POST") {
      await route.continue();
      return;
    }
    keys.push(route.request().postDataJSON().idempotencyKey);
    if (keys.length === 1) {
      const committed = await route.fetch();
      expect(committed.ok()).toBe(true);
      await route.abort("failed");
    } else await route.continue();
  });
  await dialog
    .getByRole("button", { name: "Criar ordem", exact: true })
    .click();
  await dialog
    .getByRole("button", { name: "Tentar operação novamente", exact: true })
    .click();
  await expect(dialog).not.toBeVisible();
  expect(keys).toHaveLength(2);
  expect(keys[0]).toBe(keys[1]);
  const result = await (
    await request.get(
      `/api/erp/production/operations?resource=orders&search=${assignee}`,
    )
  ).json();
  expect(result.total).toBe(1);
});

test("Kanban aceita arrastar, alternativa por teclado e atualização em outra sessão", async ({
  page,
  context,
  request,
}) => {
  const fixture = await (await request.get("/__fixture")).json();
  const assignee = `E2E-KANBAN-${Date.now()}`;
  const createdResponse = await request.post("/api/erp/production/operations", {
    data: {
      action: "order.create",
      idempotencyKey: crypto.randomUUID(),
      bomId: fixture.bomId,
      warehouseId: fixture.warehouseId,
      plannedQuantity: 1,
      assignedTo: assignee,
    },
  });
  expect(createdResponse.ok()).toBe(true);
  await page.setViewportSize({ width: 1920, height: 1080 });
  await page.goto("/");
  await page.getByLabel("Buscar", { exact: true }).fill(assignee);
  const card = page.getByLabel("Kanban de produção").getByRole("article");
  await expect(card).toHaveCount(1);
  const observer = await context.newPage();
  await observer.goto("/");
  await observer.getByLabel("Buscar", { exact: true }).fill(assignee);
  await expect(
    observer.getByLabel("Kanban de produção").getByRole("article"),
  ).toHaveCount(1);
  await page.bringToFront();
  await card.dragTo(page.locator('[data-stage="in_progress"]'));
  await expect(
    page.locator('[data-stage="in_progress"]').getByRole("article"),
  ).toHaveCount(1);
  await observer.bringToFront();
  await expect(
    observer.locator('[data-stage="in_progress"]').getByRole("article"),
  ).toHaveCount(1, { timeout: 20000 });
  const select = observer.getByRole("combobox", { name: /^Mover OP-/ });
  await select.focus();
  await select.press("ArrowDown");
  await select.press("Enter");
  await expect(
    observer.locator('[data-stage="paused"]').getByRole("article"),
  ).toHaveCount(1);
  await observer.close();
});
