/** Read-only smoke check of the public deployment. No credentials, signup,
 * recovery email, review or customer lookup is submitted to real handlers.
 * Browser analytics is suppressed to avoid polluting business measurements.
 */
import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { chromium, expect } from "@playwright/test";

const base = "https://nalven.com.br";
const output = "/var/lib/nalven/production-validation/public-auth";
const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({ baseURL: base, viewport: { width: 1440, height: 960 } });
const errors: string[] = [];
try {
  await mkdir(output, { recursive: true });
  await context.route("**/api/analytics/event", route => route.fulfill({ json: { ok: true, enabled: false } }));
  const page = await context.newPage();
  page.on("pageerror", error => errors.push(error.name));
  const sensitive = ["/login", "/cadastro", "/esqueci-senha", "/redefinir-senha/invalid", "/convite/invalid", "/avaliar/invalid", "/rastrear-pedido"];
  for (const path of sensitive) {
    const response = await page.goto(path, { waitUntil: "networkidle" });
    assert.equal(response?.status(), 200, path);
    const headers = response!.headers();
    assert.equal(headers["referrer-policy"], "no-referrer", path);
    assert.match(headers["cache-control"] || "", /no-store/, path);
    assert.match(headers["x-robots-tag"] || "", /noindex/, path);
    assert.equal(headers["x-content-type-options"], "nosniff", path);
    assert.match(headers["content-security-policy"] || "", /frame-ancestors 'none'/, path);
    await expect(page.getByRole("heading", { level: 1 })).toHaveCount(1);
    for (const width of [1440, 390, 320]) {
      await page.setViewportSize({ width, height: 960 });
      const dimensions = await page.evaluate(() => ({ screen: innerWidth, content: document.documentElement.scrollWidth }));
      assert.ok(dimensions.content <= dimensions.screen, `${path} width=${width} content=${dimensions.content}`);
      if (width !== 320) await page.screenshot({ path: `${output}/${path.split("/")[1]}-${width}.png`, fullPage: true });
    }
    console.log(`PUBLIC_UI_OK ${path}`);
  }
  for (const path of ["/", "/blog", "/glossario"]) {
    const response = await context.request.get(path);
    assert.equal(response.status(), 200, path);
    assert.match(response.headers()["content-security-policy"] || "", /script-src 'self' 'nonce-/);
    console.log(`PUBLIC_DOCUMENT_OK ${path}`);
  }
  for (const path of ["/entrar", "/erp/login", "/admin/login"]) {
    const response = await context.request.get(path, { maxRedirects: 0 });
    assert.equal(response.status(), 308); assert.equal(new URL(response.headers().location, base).pathname, "/login");
  }
  for (const path of ["/api/auth/login", "/api/auth/signup", "/api/auth/forgot-password", "/api/auth/reset-password", "/api/auth/invite", "/api/public/pedidos/rastreio"]) {
    // The global origin guard must reject before rate-limit/account writes.
    const response = await context.request.post(path, { headers: { origin: "https://external.invalid" }, data: {} });
    assert.equal(response.status(), 403, path);
    assert.match(response.headers()["cache-control"] || "", /no-store/);
    console.log(`PUBLIC_CSRF_DENIED ${path}`);
  }
  for (const [path,status] of [["/api/auth/me",401], ["/api/erp",401], ["/api/saas",403], ["/api/public/plans",200], ["/api/public/site",200]] as const) {
    assert.equal((await context.request.get(path)).status(), status, path);
  }
  assert.deepEqual(errors, [], "Páginas públicas não devem gerar erros JavaScript");
  console.log("PUBLIC_PUBLISHED_OK; no account, email or business mutation performed");
} finally {
  await context.close();
  await browser.close();
}
