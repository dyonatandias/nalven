import { expect, test, type Page } from "@playwright/test";

const password = "SenhaDeTeste123!";
const token = "A".repeat(48);
const json = (data: unknown, status = 200) => ({ status, contentType: "application/json", body: JSON.stringify(data) });

async function expectFits(page: Page) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await expect(page.getByRole("heading", { level: 1 })).toHaveCount(1);
}

test("login móvel tem labels, retorno seguro, feedback focado e envio único", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  let calls = 0;
  let release = () => {};
  const pending = new Promise<void>(resolve => { release = resolve; });
  await page.route("**/api/auth/login", async route => {
    calls += 1;
    if (calls === 1) { await pending; await route.fulfill(json({ error: "Credenciais inválidas" }, 401)); }
    else await route.fulfill(json({ user: { role: "user" } }));
  });
  await page.goto("/?changed=1&returnTo=%2Fconvite%2F..%2F..%2Fadmin");
  await expect(page.getByRole("status")).toHaveText("Senha alterada. Entre com sua nova senha.");
  await expect(page.getByLabel("E-mail", { exact: true })).toHaveAttribute("autocomplete", "username");
  await expect(page.getByLabel("Senha", { exact: true })).toHaveAttribute("autocomplete", "current-password");
  await page.getByLabel("E-mail", { exact: true }).fill("teste@example.invalid");
  await page.getByLabel("Senha", { exact: true }).fill(password);
  await page.getByRole("button", { name: "Mostrar senha", exact: true }).click();
  await expect(page.getByLabel("Senha", { exact: true })).toHaveAttribute("type", "text");
  await page.getByRole("button", { name: "Ocultar senha", exact: true }).click();
  await page.getByRole("button", { name: "Entrar", exact: true }).click();
  await expect.poll(() => calls).toBe(1);
  await expect(page.getByRole("button", { name: "Entrando…", exact: true })).toBeDisabled();
  await page.locator("form").evaluate(form => form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })));
  expect(calls).toBe(1);
  release();
  await expect(page.getByRole("alert")).toHaveText("Credenciais inválidas");
  await expect(page.getByRole("alert")).toBeFocused();
  await expect(page.getByLabel("E-mail", { exact: true })).toHaveValue("teste@example.invalid");
  await expectFits(page);
  await page.screenshot({ path: "outputs/auth-browser/mobile-login.png" });
  await page.getByRole("button", { name: "Entrar", exact: true }).click();
  await expect(page).toHaveURL("/erp");
  expect(await page.evaluate(() => [localStorage.length, sessionStorage.length])).toEqual([0, 0]);
});

test("login aceita somente retorno canônico de convite e preserva navegação administrativa", async ({ page }) => {
  let role = "user";
  await page.route("**/api/auth/login", route => route.fulfill(json({ user: { role } })));
  await page.goto(`/?returnTo=${encodeURIComponent(`/convite/${token}`)}`);
  await page.getByLabel("E-mail", { exact: true }).fill("teste@example.invalid");
  await page.getByLabel("Senha", { exact: true }).fill(password);
  await page.getByRole("button", { name: "Entrar", exact: true }).click();
  await expect(page).toHaveURL(`/convite/${token}`);
  role = "superadmin";
  await page.goto(`/?returnTo=${encodeURIComponent(`/convite/${token}`)}`);
  await page.getByLabel("E-mail", { exact: true }).fill("teste@example.invalid");
  await page.getByLabel("Senha", { exact: true }).fill(password);
  await page.getByRole("button", { name: "Entrar", exact: true }).click();
  await expect(page).toHaveURL("/admin");
});

test("recuperação sai do erro de rede e limita tentativas sem revelar contas", async ({ page }) => {
  const errors: string[] = []; page.on("pageerror", error => errors.push(error.message));
  await page.setViewportSize({ width: 320, height: 780 });
  let calls = 0;
  await page.route("**/api/auth/forgot-password", async route => {
    calls += 1;
    if (calls === 1) await route.abort("failed");
    else if (calls === 2) await route.fulfill(json({ message: "Mensagem genérica" }, 429));
    else await route.fulfill(json({ message: "Não utilizar conteúdo dinâmico para confirmar conta." }));
  });
  await page.goto("/?view=forgot");
  await page.getByLabel("E-mail", { exact: true }).fill("nao-confirmar@example.invalid");
  await page.getByRole("button", { name: "Enviar instruções", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText("Falha de conexão");
  await page.getByRole("button", { name: "Enviar instruções", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText("Muitas tentativas");
  await page.getByRole("button", { name: "Enviar instruções", exact: true }).click();
  await expect(page.getByRole("status")).toHaveText("Se o e-mail estiver cadastrado, você receberá as instruções para redefinir a senha.");
  await expect(page.getByText("nao-confirmar@example.invalid", { exact: true })).toHaveCount(0);
  await expectFits(page);
  await page.screenshot({ path: "outputs/auth-browser/mobile-recovery.png" });
  await page.getByRole("button", { name: "Usar outro e-mail", exact: true }).click();
  await expect(page.getByLabel("E-mail", { exact: true })).toHaveValue("");
  expect(errors).toEqual([]);
});

test("redefinição valida confirmação, recupera resposta inválida e trata token inválido", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  let calls = 0;
  await page.route("**/api/auth/reset-password", async route => {
    calls += 1;
    if (calls === 1) await route.fulfill({ status: 502, contentType: "text/html", body: "<h1>Upstream indisponível</h1>" });
    else await route.fulfill(json({ ok: true }));
  });
  await page.goto("/?view=reset&token=invalido");
  await expect(page.getByRole("alert")).toHaveText("Este link de recuperação é inválido.");
  await expect(page.getByRole("button", { name: "Salvar nova senha", exact: true })).toHaveCount(0);
  await page.goto("/?view=reset");
  await page.getByLabel("Nova senha", { exact: true }).fill(password);
  await page.getByLabel("Confirmar senha", { exact: true }).fill("DiferenteTeste123!");
  await page.getByRole("button", { name: "Salvar nova senha", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText("não coincidem");
  expect(calls).toBe(0);
  await page.getByLabel("Confirmar senha", { exact: true }).fill(password);
  await page.getByRole("button", { name: "Salvar nova senha", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText("Não foi possível redefinir");
  await expect(page.getByRole("button", { name: "Salvar nova senha", exact: true })).toBeEnabled();
  await expectFits(page);
  await page.screenshot({ path: "outputs/auth-browser/mobile-reset.png" });
  await page.getByRole("button", { name: "Salvar nova senha", exact: true }).click();
  await expect(page).toHaveURL("/login?senha=alterada");
});

async function fillSignup(page: Page) {
  const values = { "Seu nome completo": "Pessoa de teste", "E-mail de acesso": "cadastro@example.invalid", "Empresa / razão social": "Empresa de teste", "CNPJ ou CPF da empresa": "00.000.000/0001-00", "CPF do responsável": "000.000.000-00", "Telefone com DDD": "(11) 99999-9999", "CEP": "00000-000", "Rua ou avenida": "Rua de teste", "Número": "S/N", "Cidade": "Cidade teste" };
  for (const [label, value] of Object.entries(values)) await page.getByLabel(label, { exact: true }).fill(value);
  await page.getByLabel("Senha", { exact: true }).fill(password);
  await page.getByLabel("Confirmar senha", { exact: true }).fill(password);
  await page.getByRole("combobox", { name: "Estado", exact: true }).selectOption("SP");
}

test("cadastro usa layout de uma coluna no celular e preserva dados ao receber erro", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  let payload: Record<string, unknown> | undefined;
  await page.route("**/api/auth/signup", route => { payload = route.request().postDataJSON(); return route.fulfill(json({ error: "Revise o documento informado." }, 400)); });
  await page.goto("/?view=signup");
  await expect(page.getByRole("combobox", { name: "Plano", exact: true })).toHaveValue("advanced");
  await fillSignup(page);
  await page.getByRole("combobox", { name: "Plano", exact: true }).selectOption("starter");
  await expect(page.getByLabel("Resumo do plano selecionado")).toContainText("Essencial");
  await page.getByRole("button", { name: "Criar organização", exact: true }).click();
  await expect(page.getByRole("alert")).toHaveText("Revise o documento informado.");
  await expect(page.getByRole("alert")).toBeFocused();
  await expect(page.getByLabel("Empresa / razão social", { exact: true })).toHaveValue("Empresa de teste");
  expect(payload?.confirmation).toBeUndefined();
  expect(payload?.planId).toBe("starter");
  await expectFits(page);
  await page.screenshot({ path: "outputs/auth-browser/mobile-signup.png", fullPage: true });
  expect(await page.evaluate(() => [localStorage.length, sessionStorage.length])).toEqual([0, 0]);
  await page.goto("/?view=signup&unavailable=1");
  await expect(page.getByRole("status")).toContainText("A contratação não está disponível");
  await expect(page.getByRole("button", { name: "Criar organização", exact: true })).toHaveCount(0);
});

test("convite recupera consulta offline, contém textos longos e ignora destino externo", async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 780 });
  let views = 0;
  const invite = { email: "convidado@example.invalid", name: "Pessoa convidada", roleKey: "stock", organization: "Organização-" + "NOMESEMESPACOS".repeat(8), expiresAt: "2090-01-01T00:00:00Z", existingAccount: true };
  await page.route("**/api/auth/invite**", async route => {
    if (route.request().method() === "POST") { await route.fulfill(json({ ok: true, destination: "https://invalid.example/escape" })); return; }
    views += 1;
    if (views === 1) await route.abort("failed"); else await route.fulfill(json({ invite }));
  });
  await page.goto("/?view=invite");
  await expect(page.getByRole("alert")).toContainText("Falha de conexão");
  await page.getByRole("button", { name: "Tentar novamente", exact: true }).click();
  await expect(page.getByRole("heading", { level: 1 })).toHaveText(invite.organization);
  await expect(page.getByRole("link", { name: "Entrar na conta convidada", exact: true })).toHaveAttribute("href", `/login?returnTo=${encodeURIComponent(`/convite/${token}`)}`);
  await expectFits(page);
  await page.screenshot({ path: "outputs/auth-browser/mobile-invite.png", fullPage: true });
  await page.getByRole("button", { name: "Já entrei · aceitar convite", exact: true }).click();
  await expect(page).toHaveURL("/erp");
});

test("convite novo usa política compartilhada e reporta falha de criação sem travar", async ({ page }) => {
  await page.route("**/api/auth/invite**", route => route.fulfill(route.request().method() === "GET"
    ? json({ invite: { email: "novo@example.invalid", name: "Pessoa nova", roleKey: "viewer", organization: "Organização de teste", expiresAt: "2090-01-01T00:00:00Z", existingAccount: false } })
    : json({ error: "O convite já foi utilizado." }, 400)));
  await page.goto("/?view=invite");
  await page.getByLabel("Nova senha", { exact: true }).fill(password);
  await page.getByLabel("Confirmar senha", { exact: true }).fill(password);
  await page.getByRole("button", { name: "Aceitar convite e entrar", exact: true }).click();
  await expect(page.getByRole("alert")).toHaveText("O convite já foi utilizado.");
  await expect(page.getByRole("button", { name: "Aceitar convite e entrar", exact: true })).toBeEnabled();
  await expect(page.getByLabel("Nova senha", { exact: true })).toHaveAttribute("autocomplete", "new-password");
});

test("tracker não observa rotas sensíveis e reduz referrer de login à origem", async ({ page }) => {
  const events: Record<string, unknown>[] = [];
  let analyticsRequests = 0;
  await page.route("**/api/analytics/event", route => {
    analyticsRequests += 1;
    if (route.request().method() === "POST") events.push(route.request().postDataJSON());
    return route.fulfill(json({ enabled: false }));
  });
  await page.route("**/api/auth/invite**", route => route.fulfill(json({ error: "Convite indisponível" }, 404)));
  await page.goto(`/redefinir-senha/${token}?view=reset&tracking=1`);
  await expect(page.getByRole("heading", { name: "Redefina sua senha", exact: true })).toBeVisible();
  await page.goto(`/convite/${token}?view=invite&tracking=1`);
  await expect(page.getByRole("alert")).toHaveText("Convite indisponível");
  expect(analyticsRequests).toBe(0);
  await page.addInitScript(() => {
    sessionStorage.setItem("nalven_analytics_referrer", "https://example.invalid/convite/SEGREDO?email=privado@example.invalid");
  });
  await page.goto("/login?tracking=1");
  await expect.poll(() => events.length).toBe(1);
  expect(events[0].referrer).toBe("https://example.invalid");
  expect(events[0].page_path).toBe("/login");
  expect(JSON.stringify(events[0])).not.toMatch(/SEGREDO|privado@/);
  expect(await page.evaluate(() => sessionStorage.getItem("nalven_analytics_referrer"))).toBe("https://example.invalid");
});

test("armazenamento bloqueado não interrompe tracker nem login", async ({ page }) => {
  const errors: string[] = []; page.on("pageerror", error => errors.push(error.message));
  await page.addInitScript(() => {
    for (const key of ["sessionStorage", "localStorage"]) Object.defineProperty(window, key, { configurable: true, get() { throw new DOMException("Storage blocked", "SecurityError"); } });
  });
  await page.route("**/api/analytics/event", route => route.fulfill(json({ enabled: false })));
  await page.route("**/api/auth/login", route => route.fulfill(json({ user: { role: "user" } })));
  await page.goto("/login?tracking=1");
  await page.getByLabel("E-mail", { exact: true }).fill("teste@example.invalid");
  await page.getByLabel("Senha", { exact: true }).fill(password);
  await page.getByRole("button", { name: "Entrar", exact: true }).click();
  await expect(page).toHaveURL("/erp");
  expect(errors).toEqual([]);
});
