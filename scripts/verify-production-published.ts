/** Authenticated, non-business-mutating verification of the published ERP.
 * Creates short-lived test identities, logs in through the real HTTP endpoint,
 * and removes only those identities in finally. Never logs passwords or cookies.
 */
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { readFile, mkdir } from "node:fs/promises";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient as ControlClient } from "../generated/control/client";
import { PrismaClient as TenantClient } from "../generated/tenant/client";
import { chromium, expect, type BrowserContext } from "@playwright/test";
import { hashPassword } from "../lib/password";

const base = "https://nalven.com.br";
const output = "/var/lib/nalven/production-validation";
const control = new ControlClient({ adapter: new PrismaPg({ connectionString: process.env.CONTROL_DATABASE_URL }) });
const userIds: string[] = [], profileIds: number[] = [];
let tenant: TenantClient | undefined;
async function main() {
  const record = await control.tenantDatabase.findUniqueOrThrow({ where: { configKey: "demo" } });
  assert.equal(record.status,"active"); assert.equal(record.databaseName,"nalven_t_demo");
  const content = await readFile("/etc/nalven/tenants/demo.env","utf8");
  const lines = content.split("\n").filter(line => line.startsWith("TENANT_DATABASE_URL="));
  assert.equal(lines.length,1);
  const connectionString = lines[0].slice("TENANT_DATABASE_URL=".length), connection = new URL(connectionString);
  assert.equal(connection.hostname,"127.0.0.1"); assert.equal(connection.pathname,"/nalven_t_demo"); assert.equal(connection.username,"nalven_t_demo_runtime");
  tenant = new TenantClient({ adapter: new PrismaPg({ connectionString }) });
  const branch = await tenant.branch.findFirstOrThrow({ where: { status: "active" }, orderBy: { id: "asc" } });
  const browser = await chromium.launch({ headless: true });
  const contexts: BrowserContext[] = [];
  try {
    async function account(roleKey: string) {
      const password = randomBytes(32).toString("base64url"), email = `erp-validation-${randomUUID()}@example.invalid`;
      const user = await control.user.create({ data: { name: "Homologação ERP temporária", email, passwordHash: await hashPassword(password), emailVerifiedAt: new Date(), memberships: { create: { organizationId: record.organizationId, role: roleKey, status: "active" } } } });
      userIds.push(user.id);
      const role = await tenant!.tenantRole.findUniqueOrThrow({ where: { key: roleKey } });
      const profile = await tenant!.tenantUserProfile.create({ data: { userId: user.id, roleId: role.id, displayName: user.name, email, activeBranchId: branch.id, branchAccesses: { create: { branchId: branch.id, primary: true, canManageStock: roleKey === "stock", canSell: false, canIssueFiscal: false } } } });
      profileIds.push(profile.id);
      const context = await browser.newContext({ baseURL: base, viewport: { width: 1440, height: 900 } }); contexts.push(context);
      const login = await context.request.post("/api/auth/login", { headers: { origin: base }, data: { email, password } });
      assert.equal(login.status(),200,`Login real do perfil ${roleKey}`);
      const previousSession = (await context.cookies()).find(cookie => cookie.name === "nalven_session");
      assert.ok(previousSession?.httpOnly && previousSession.secure && previousSession.sameSite === "Lax");
      const repeatedLogin = await context.request.post("/api/auth/login", { headers: { origin: base }, data: { email, password } });
      assert.equal(repeatedLogin.status(),200,`Reautenticação real do perfil ${roleKey}`);
      const currentSession = (await context.cookies()).find(cookie => cookie.name === "nalven_session");
      assert.ok(currentSession && currentSession.value !== previousSession.value, "Sessão deve ser rotacionada sem registrar tokens");
      const revoked = await context.request.get("/api/auth/me", { headers: { cookie: `nalven_session=${previousSession.value}` } });
      assert.equal(revoked.status(),401,"Sessão anterior não autentica após reautenticação");
      assert.equal((await context.request.get("/api/auth/me")).status(),200,"Sessão nova permanece válida");
      return { context, profile };
    }
    const stock = await account("stock");
    for (const path of ["/api/erp/production/operations?resource=summary", "/api/erp/production/operations?resource=boms", "/api/erp/inventory", "/api/erp/logistics", "/api/erp/purchases"]) {
      const response = await stock.context.request.get(path);
      assert.equal(response.status(),200,`Leitura autorizada: ${path}`);
      assert.match(response.headers()["cache-control"] || "",/no-store/);
      console.log(`AUTH_READ_OK ${path}`);
    }
    const permitted = await stock.context.request.post("/api/erp/production/operations", { headers: { origin: base }, data: { action: "validation.invalid", idempotencyKey: randomUUID() } });
    assert.equal(permitted.status(),400,"Operador passa a autorização/licença e encontra validação de comando, sem mutação");
    const page = await stock.context.newPage(), errors: string[] = [];
    page.on("pageerror", error => errors.push(error.name));
    await mkdir(output,{ recursive: true });
    await page.goto("/erp/producao-kits");
    const active = page.locator(".tenant-shell > aside a[aria-current='page']");
    await expect(active).toHaveText("Produção e kits");
    await expect(page.getByRole("heading",{ level: 1 })).toHaveCount(1);
    await page.getByRole("button",{ name:"Nova ordem", exact:true }).click();
    await expect(page.getByRole("dialog")).toBeVisible(); await page.keyboard.press("Escape");
    await page.screenshot({ path:`${output}/production-desktop.png` });
    for (const [path,label] of [["/erp/inventario-depositos","Inventário e depósitos"],["/erp/expedicao-logistica","Expedição e logística"]]) {
      await page.locator(`.tenant-shell > aside a[href='${path}']`).click();
      await expect(page).toHaveURL(`${base}${path}`); await expect(active).toHaveText(label);
      if (path.endsWith("inventario-depositos")) {
        await expect(page.getByRole("heading", { name: "Posição consolidada por produto", exact: true })).toBeVisible();
        const opener = page.getByRole("button", { name: "Novo depósito", exact: true });
        await opener.click();
        await expect(page.getByRole("dialog", { name: "Novo depósito", exact: true })).toBeVisible();
        await page.keyboard.press("Escape"); await expect(opener).toBeFocused();
        await page.getByRole("tab", { name: /^Razão/ }).click();
        await expect(page.getByRole("tabpanel")).toBeVisible();
      } else {
        await expect(page.getByRole("heading", { name: "Central de execução logística", exact: true })).toBeVisible();
        await page.getByLabel("Visualização da expedição", { exact: true }).selectOption("board");
      }
      await page.setViewportSize({ width: 390, height: 844 });
      await page.screenshot({ path:`${output}/${path.split("/").at(-1)}-mobile.png` });
      const overflow = await page.evaluate(() => ({
        width: innerWidth, scrollWidth: document.documentElement.scrollWidth,
        inventory: [...document.querySelectorAll(".erp-inventory, .erp-inventory > *, .inventory-ledger-panel > *")].map(element => ({ tag: element.tagName, className: element.className, width: element.getBoundingClientRect().width, display: getComputedStyle(element).display, minWidth: getComputedStyle(element).minWidth, columns: getComputedStyle(element).gridTemplateColumns })),
        elements: [...document.querySelectorAll("main *")].filter(element => {
          const rect = element.getBoundingClientRect();
          return rect.width && rect.right > innerWidth + 1;
        }).slice(0, 12).map(element => ({ tag: element.tagName, className: element.className, width: Math.round(element.getBoundingClientRect().width) })),
      }));
      assert.ok(overflow.scrollWidth <= overflow.width, `${path}: ${JSON.stringify(overflow)}`);
      await page.setViewportSize({ width: 1440, height: 900 });
      await page.screenshot({ path:`${output}/${path.split("/").at(-1)}.png` });
    }
    await page.goBack(); await expect(active).toHaveText("Inventário e depósitos");
    await page.goForward(); await expect(active).toHaveText("Expedição e logística");
    await page.setViewportSize({ width:390,height:844 });
    await page.getByRole("button",{ name:"Abrir menu",exact:true }).click();
    await expect(page.locator(".tenant-shell > aside")).toHaveAttribute("aria-modal","true");
    await expect(active).toBeFocused();
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    await page.screenshot({ path:`${output}/sidebar-mobile.png` });
    await page.keyboard.press("Escape");
    assert.deepEqual(errors,[]);
    const reader = await account("viewer");
    assert.equal((await reader.context.request.get("/api/erp/production/operations?resource=summary")).status(),200);
    assert.equal((await reader.context.request.post("/api/erp/production/operations",{ headers:{origin:base},data:{action:"order.create",idempotencyKey:randomUUID()} })).status(),403);
    await tenant.tenantUserProfile.update({ where:{id:stock.profile.id},data:{status:"suspended"} });
    assert.equal((await stock.context.request.get("/api/erp/production/operations?resource=summary")).status(),403);
    await page.goto("/erp/producao-kits"); await expect(page).toHaveURL(`${base}/portal`);
    console.log("AUTH_ROLES_AND_BROWSER_OK; synthetic identities will now be removed");
  } finally { await Promise.all(contexts.map(context => context.close())); await browser.close(); }
}
main().catch(error => { console.error("Published verification failed:", error instanceof assert.AssertionError ? error.message : error instanceof Error ? error.name : "unknown"); process.exitCode=1; }).finally(async () => {
  try {
    if (tenant && profileIds.length) await tenant.tenantUserProfile.deleteMany({ where:{id:{in:profileIds},userId:{in:userIds}} });
    if (userIds.length) await control.user.deleteMany({ where:{id:{in:userIds},email:{startsWith:"erp-validation-",endsWith:"@example.invalid"}} });
    console.log(`TEST_IDENTITIES_REMOVED ${userIds.length}; login audit evidence retained`);
  } finally { await tenant?.$disconnect(); await control.$disconnect(); }
});
