import { expect, test } from "@playwright/test";

const product = { id: 1, name: "Café", sku: "CAFE", type: "simple", unit: "un", priceCents: 1000, stock: 3, soldIndividually: false };
const access = { active: true, canOpen: true, canClose: true, canSell: true, canSupply: true, canWithdraw: true, canCancel: true, canRefund: true, canReprint: true, canManualPayment: false, canTransferHeld: true, maxDiscountBasisPoints: 10000 };
const register = { id: 1, code: "CX1", name: "Caixa 1", access, terminals: [{ id: "terminal-1", code: "T1", name: "Terminal", status: "active", devices: [] }] };
const data = {
  branch: { id: 1, code: "M", name: "Matriz" }, operator: { id: 1, name: "Operador" }, registers: [register],
  session: { id: 1, number: "CX-1", registerId: 1, terminalId: "terminal-1", status: "open", version: 1, openedAt: new Date().toISOString(), openingAmountCents: 0, register, events: [] },
  products: [product, { ...product, id: 2, name: "Esgotado", sku: "ESG", stock: 0 },
    { ...product, id: 3, name: "Camiseta", sku: "CAM", stock: 0, variations: [{ id: 31, sku: "CAM-P", stock: 2, priceCents: 2500, attributes: { tamanho: "P" } }, { id: 32, sku: "CAM-M", stock: 5, priceCents: 3000, attributes: { tamanho: "M" } }] },
    { ...product, id: 4, name: "Serviço", sku: "SERV", type: "service", stock: null }], customers: [],
  settings: { defaultPaymentMethod: "cash", defaultCustomerName: "Consumidor final", requireCustomer: false, maxDiscountPercent: 100, currency: "BRL", locale: "pt-BR" },
  heldSales: [], recentSales: [], connectors: [], closingTenders: [],
};

test.beforeEach(async ({ page }) => {
  let paymentPlan: Record<string, unknown> = {};
  await page.route("**/api/**", async route => {
    const url = new URL(route.request().url());
    const payload = route.request().method() === "POST" ? route.request().postDataJSON() : null;
    let body: unknown = {};
    if (url.pathname.endsWith("session-lifecycle")) body = { session: null, incoming: [], targets: [] };
    else if (url.pathname.endsWith("payment-intents")) body = { recovery: { mode: "none" }, drafts: [], intents: [], manualReferences: [], paymentPlans: [] };
    else if (url.pathname.endsWith("offline-credentials")) body = { credentialExpiresAt: new Date(Date.now() + 3600000).toISOString() };
    else if (payload?.action === "cart.draft.save") body = { draft: { id: payload.saleDraftId, revision: 1 } };
    else if (payload?.action === "promotion.quote") {
      const total = payload.items.reduce((sum: number, item: { productId: number; quantity: number }) => sum + data.products.find(product => product.id === item.productId)!.priceCents * item.quantity, 0);
      const now = new Date().toISOString();
      paymentPlan = { id: "plan-1", saleDraftId: payload.saleDraftId, draftRevision: 1, quoteHash: "a".repeat(64), totalCents: total, currency: "BRL", state: "quoted", version: 0, evaluatedAt: now, expiresAt: new Date(Date.now() + 3600000).toISOString(), slots: [] };
      body = { quote: { quoteHash: paymentPlan.quoteHash, subtotalCents: total, totalCents: total, manualDiscountCents: 0, manualDiscountBasisPoints: 0, promotionDiscountCents: 0, surchargeCents: 0, evaluatedAt: now }, paymentPlan };
    }
    else if (payload?.action === "plan.activate") { paymentPlan = { ...paymentPlan, state: "active", version: 1, slots: payload.slots }; body = { paymentPlan }; }
    else if (payload?.action === "sale.commit") body = { sale: { id: 99, saleNumber: "VEN-99", customer: "Consumidor final", status: "completed", totalCents: paymentPlan.totalCents, changeCents: 0, createdAt: new Date().toISOString(), items: [], payments: [] } };
    else if (url.searchParams.get("resource") === "products") body = { items: data.products.filter(product => product.name.toLowerCase().includes((url.searchParams.get("q") || "").toLowerCase())), page: { hasMore: false } };
    else if (url.searchParams.get("resource") === "customers") body = { items: [], page: { hasMore: false } };
    else if (url.searchParams.get("resource") === "sales") body = { items: url.searchParams.get("q") === "VEN-ANTIGA" ? [{ id: 21, saleNumber: "VEN-ANTIGA", customer: "Maria", status: "completed", totalCents: 1000, changeCents: 0, createdAt: new Date().toISOString(), payments: [], items: [] }] : [], page: { hasMore: false } };
    else if (route.request().method() === "GET" && url.pathname === "/api/erp/pdv") body = data;
    else { await route.fulfill({ status: 503, json: { error: "Operação indisponível no teste" } }); return; }
    await route.fulfill({ json: body });
  });
});

for (const width of [1440, 390]) {
  test(`adiciona e altera carrinho com clique real em ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    const errors: string[] = [];
    page.on("pageerror", error => errors.push(error.message));
    await page.goto("/");
    const coffee = page.locator("#pos-catalog-grid > button").filter({ hasText: "Café" });
    await coffee.click();
    await coffee.click();
    if (width < 980) await page.locator(".pos-mobile-cart-trigger").click();
    await expect(page.locator(".pos-lines article")).toHaveCount(1);
    await expect(page.getByLabel("Quantidade 2", { exact: true })).toBeVisible();
    await page.getByRole("button", { name: "Ações de Café" }).click();
    await page.getByRole("button", { name: "Aumentar Café" }).click();
    await expect(page.getByLabel("Quantidade de Café", { exact: true })).toHaveValue("3");
    await page.getByRole("button", { name: "Aumentar Café" }).click();
    await expect(page.getByLabel("Quantidade de Café", { exact: true })).toHaveValue("3");
    expect(errors).toEqual([]);
    await page.screenshot({ path: `outputs/pdv-browser/pdv-${width}.png`, fullPage: true });
  });
}

test("serviços e variações entram no carrinho; saldo zero explica o bloqueio", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: "Adicionar Esgotado ao carrinho" }).click();
  await expect(page.getByText("Estoque disponível esgotado para Esgotado.", { exact: true })).toBeVisible();
  await expect(page.locator(".pos-lines article")).toHaveCount(0);
  await page.getByRole("button", { name: "Adicionar Serviço ao carrinho" }).click();
  await page.getByRole("button", { name: "Adicionar Camiseta ao carrinho" }).click();
  await page.getByRole("button", { name: /CAM-P/ }).click();
  await page.getByRole("button", { name: "Adicionar Camiseta ao carrinho" }).click();
  await page.getByRole("button", { name: /CAM-M/ }).click();
  await expect(page.locator(".pos-lines article")).toHaveCount(3);
  await expect(page.locator(".pos-lines")).toContainText("Camiseta · CAM-P");
  await expect(page.locator(".pos-lines")).toContainText("Camiseta · CAM-M");
});

test("atalhos abrem as buscas corretas e vendas consultam o servidor", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: /Buscar por Cliente/ }).click();
  await expect(page.getByLabel("Buscar cliente", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: /Buscar por Produtos/ }).click();
  await page.locator("#pos-catalog-search").fill("Serviço");
  await expect(page.locator("#pos-catalog-grid > button")).toHaveCount(1);
  await page.getByRole("button", { name: /Buscar por Venda/ }).click();
  await page.getByLabel("Buscar por Venda", { exact: true }).fill("VEN-ANTIGA");
  await expect(page.locator(".pos-recent-sale")).toContainText("VEN-ANTIGA");
  await page.getByLabel("Buscar por Venda", { exact: true }).fill("inexistente");
  await expect(page.getByText("Nenhuma venda deste turno corresponde à busca.")).toBeVisible();
});

test("conclui pagamento em dinheiro e limpa carrinho apenas após confirmação", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: "Adicionar Café ao carrinho" }).click();
  await page.locator(".pos-finish").click();
  await page.getByRole("button", { name: "Ativar divisões autoritativas" }).click();
  const commit = page.waitForRequest(request => request.method() === "POST" && request.postDataJSON()?.action === "sale.commit");
  await page.locator(".pos-finish").click();
  expect((await commit).postDataJSON().items).toEqual([{ productId: 1, quantity: 1, discountCents: 0 }]);
  await expect(page.getByRole("dialog")).toContainText("VEN-99");
  await expect(page.locator(".pos-lines article")).toHaveCount(0);
});

test("falha na conclusão preserva carrinho e repete a mesma chave da venda", async ({ page }) => {
  const attempts: string[] = [];
  await page.route("**/api/erp/pdv", async route => {
    if (route.request().method() === "POST" && route.request().postDataJSON()?.action === "sale.commit") {
      attempts.push(route.request().postDataJSON().idempotencyKey);
      if (attempts.length === 1) { await route.fulfill({ status: 503, json: { error: "Falha temporária ao confirmar venda." } }); return; }
    }
    await route.fallback();
  });
  await page.goto("/");
  await page.getByRole("button", { name: "Adicionar Café ao carrinho" }).click();
  await page.locator(".pos-finish").click();
  await page.getByRole("button", { name: "Ativar divisões autoritativas" }).click();
  await page.locator(".pos-finish").click();
  await expect(page.getByText("Falha temporária ao confirmar venda.", { exact: true })).toBeVisible();
  await expect(page.locator(".pos-lines article")).toHaveCount(1);
  await page.locator(".pos-finish").click();
  await expect(page.getByRole("dialog")).toContainText("VEN-99");
  expect(attempts).toHaveLength(2);
  expect(attempts[1]).toBe(attempts[0]);
});

test("recuperação ambígua bloqueia inclusão e não substitui um carrinho pendente", async ({ page }) => {
  await page.route("**/api/erp/pdv/payment-intents?**", route => route.fulfill({ json: { recovery: { mode: "blocked", issues: [] }, drafts: [], intents: [], manualReferences: [], paymentPlans: [] } }));
  await page.goto("/");
  await page.getByRole("button", { name: "Adicionar Café ao carrinho" }).click();
  await expect(page.getByText("Confirme a recuperação da venda antes de adicionar itens ao carrinho.", { exact: true })).toBeVisible();
  await expect(page.locator(".pos-lines article")).toHaveCount(0);
  await expect(page.locator(".pos-finish")).toBeDisabled();
});

test("consulta de vendas permite repetir falha e carregar a próxima página", async ({ page }) => {
  let calls = 0;
  await page.route("**/api/erp/pdv?resource=sales&**", async route => {
    calls += 1;
    if (calls === 1) { await route.fulfill({ status: 503, json: { error: "Busca temporariamente indisponível." } }); return; }
    const more = new URL(route.request().url()).searchParams.has("cursor");
    await route.fulfill({ json: { items: [{ id: more ? 31 : 30, saleNumber: more ? "VEN-31" : "VEN-30", customer: "Maria", status: "completed", totalCents: 1000, changeCents: 0, createdAt: new Date().toISOString(), payments: [], items: [] }], page: { hasMore: !more, nextCursor: more ? null : "test-cursor" } } });
  });
  await page.goto("/");
  await page.getByRole("button", { name: /Buscar por Venda/ }).click();
  await page.getByRole("button", { name: "Tentar novamente", exact: true }).click();
  await expect(page.locator(".pos-recent-sale")).toHaveCount(1);
  await page.getByRole("button", { name: "Carregar mais vendas" }).click();
  await expect(page.locator(".pos-recent-sale")).toHaveCount(2);
});
