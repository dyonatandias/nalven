/** Published support smoke: provider GETs only; no ticket, reply, upload or email is sent.
 * The only writes are random short-lived test identities/roles, invalid local commands
 * and their cleanup. Passwords, cookies, upstream tokens and conversation text are never logged.
 */
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { readFile, mkdir } from "node:fs/promises";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient as ControlClient } from "../generated/control/client";
import { PrismaClient as TenantClient } from "../generated/tenant/client";
import { chromium, expect, type Browser, type BrowserContext } from "@playwright/test";
import { hashPassword } from "../lib/password";
import type { SupportDetailData, SupportListData } from "../lib/billing/support-data";

const base = "https://nalven.com.br";
const output = "/var/lib/nalven/production-validation";
const control = new ControlClient({ adapter: new PrismaPg({ connectionString: process.env.CONTROL_DATABASE_URL }) });
const userIds: string[] = [], profileIds: number[] = [], roleIds: number[] = [];
const contexts: BrowserContext[] = [];
let tenant: TenantClient | undefined, browser: Browser | undefined;

async function main() {
  const record = await control.tenantDatabase.findUniqueOrThrow({ where: { configKey: "demo" } });
  assert.equal(record.status, "active"); assert.equal(record.databaseName, "nalven_t_demo");
  const content = await readFile("/etc/nalven/tenants/demo.env", "utf8");
  const lines = content.split("\n").filter(line => line.startsWith("TENANT_DATABASE_URL="));
  assert.equal(lines.length, 1);
  const connectionString = lines[0].slice("TENANT_DATABASE_URL=".length), connection = new URL(connectionString);
  assert.equal(connection.hostname, "127.0.0.1"); assert.equal(connection.pathname, "/nalven_t_demo"); assert.equal(connection.username, "nalven_t_demo_runtime");
  tenant = new TenantClient({ adapter: new PrismaPg({ connectionString }) });
  browser = await chromium.launch({ headless: true });
  async function account(write: boolean) {
    const key = `support-check-${randomUUID()}`;
    const role = await tenant!.tenantRole.create({ data: { key, name: "Validação temporária do suporte", permissions: write ? ["billing.read", "billing.write"] : ["billing.read"] } });
    roleIds.push(role.id);
    const password = randomBytes(32).toString("base64url"), email = `support-validation-${randomUUID()}@example.invalid`;
    const user = await control.user.create({ data: { name: "Validação temporária do suporte", email, passwordHash: await hashPassword(password), emailVerifiedAt: new Date(), memberships: { create: { organizationId: record.organizationId, role: key, status: "active" } } } });
    userIds.push(user.id);
    const profile = await tenant!.tenantUserProfile.create({ data: { userId: user.id, roleId: role.id, displayName: user.name, email } });
    profileIds.push(profile.id);
    const context = await browser!.newContext({ baseURL: base, viewport: { width: 1440, height: 1000 }, serviceWorkers: "block" }); contexts.push(context);
    const response = await context.request.post("/api/auth/login", { headers: { origin: base }, data: { email, password } });
    assert.equal(response.status(), 200, "Login sintético real deve funcionar");
    return { context, profile, role };
  }

  const anonymous = await browser.newContext({ baseURL: base }); contexts.push(anonymous);
  assert.equal((await anonymous.request.get("/api/portal/support")).status(), 401);
  const writer = await account(true), reader = await account(false);
  const headers = { "x-organization-id": record.organizationId };
  const response = await writer.context.request.get("/api/portal/support", { headers });
  assert.equal(response.status(), 200, "Lista real de suporte deve estar disponível");
  assert.match(response.headers()["cache-control"] || "", /private.*no-store/);
  const list = await response.json() as SupportListData;
  assert.ok(Array.isArray(list.tickets)); assert.equal(list.capabilities.canWrite, true);
  const first = list.tickets[0];
  if (first) {
    const detailResponse = await writer.context.request.get(`/api/portal/support?resource=detail&token=${encodeURIComponent(first.token)}`, { headers });
    assert.equal(detailResponse.status(), 200, "Histórico real deve passar pela projeção segura");
    const detail = await detailResponse.json() as SupportDetailData;
    assert.ok(detail.ticket.token === first.token); assert.ok(Array.isArray(detail.ticket.messages));
    assert.ok(detail.ticket.messages.every(message => ["client", "support", "system"].includes(message.authorType)));
    assert.ok(detail.ticket.messages.every(message => message.attachments.every(attachment => attachment.downloadUrl.startsWith("/api/portal/billing/files?"))));
  }
  const readOnly = await reader.context.request.get("/api/portal/support", { headers });
  assert.equal(readOnly.status(), 200); assert.equal((await readOnly.json()).capabilities.canWrite, false);
  const invalid = { action: "validation.invalid", commandId: randomUUID() };
  assert.equal((await writer.context.request.post("/api/portal/support", { headers: { ...headers, origin: base }, data: invalid })).status(), 400);
  assert.equal((await reader.context.request.post("/api/portal/support", { headers: { ...headers, origin: base }, data: invalid })).status(), 403);
  assert.equal((await writer.context.request.post("/api/portal/support", { headers: { ...headers, origin: "https://external.invalid" }, data: invalid })).status(), 403);
  assert.equal((await writer.context.request.get("/api/portal/support", { headers: { "x-organization-id": "stale-test-organization" } })).status(), 409);

  await mkdir(output, { recursive: true });
  const page = await writer.context.newPage(), errors: string[] = [];
  let financeReads = 0, supportWrites = 0;
  // Block mutations BEFORE a UI regression could touch the real provider.
  // The APIRequestContext checks above only use invalid local commands.
  for (const context of [writer.context, reader.context]) await context.route("**/api/portal/**", async route => {
    if (["GET", "HEAD"].includes(route.request().method())) await route.continue();
    else { supportWrites++; await route.abort("blockedbyclient"); }
  });
  page.on("pageerror", error => errors.push(error.name));
  page.on("request", request => {
    const path = new URL(request.url()).pathname;
    if (path === "/api/portal/billing" && request.method() === "GET") financeReads++;
  });
  const documentResponse = await page.goto("/portal?area=suporte");
  assert.ok(documentResponse); assert.equal(documentResponse.headers()["referrer-policy"], "no-referrer");
  assert.match(documentResponse.headers()["cache-control"] || "", /no-store/);
  await expect(page.locator("aside nav a[aria-current='page']")).toContainText("Suporte");
  await expect(page.getByRole("button", { name: "Novo chamado", exact: true })).toBeEnabled();
  await page.getByRole("button", { name: "Novo chamado", exact: true }).click();
  await expect(page.getByRole("dialog", { name: "Novo chamado", exact: true })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("button", { name: "Novo chamado", exact: true })).toBeFocused();
  // The real title is used only inside the browser selector, never in output.
  if (first) {
    await page.getByRole("button").filter({ has: page.getByText(first.title, { exact: true }) }).first().click();
    const conversation = page.getByRole("region", { name: "Conversa do chamado", exact: true });
    await expect(conversation.getByRole("heading", { name: first.title, exact: true })).toBeVisible();
    await expect(conversation.getByRole("alert")).toHaveCount(0);
  }
  await page.screenshot({ path: `${output}/support-desktop.png`, fullPage: true });
  for (const width of [320, 390]) {
    await page.setViewportSize({ width, height: 844 });
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `Sem overflow em ${width}px`);
    await page.screenshot({ path: `${output}/support-mobile-${width}.png`, fullPage: true });
  }
  assert.equal(financeReads, 0, "Suporte não pode depender do snapshot financeiro");
  assert.equal(supportWrites, 0, "Navegação não pode enviar mensagens ou arquivos");
  assert.deepEqual(errors, [], "Sem erros JavaScript");
  const readerPage = await reader.context.newPage();
  await readerPage.goto("/portal?area=suporte");
  await expect(readerPage.getByText("Seu perfil permite consultar os chamados.", { exact: false })).toBeVisible();
  await expect(readerPage.getByRole("button", { name: "Novo chamado", exact: true })).toBeDisabled();
  assert.equal(supportWrites, 0, "Também o leitor não deve tentar mutações");
  // Permission and profile revocations are checked even when list data is cached.
  await tenant.tenantRole.update({ where: { id: reader.role.id }, data: { permissions: [] } });
  assert.equal((await reader.context.request.get("/api/portal/support", { headers })).status(), 403);
  await tenant.tenantUserProfile.update({ where: { id: writer.profile.id }, data: { status: "suspended" } });
  assert.equal((await writer.context.request.get("/api/portal/support", { headers })).status(), 403);
  console.log("SUPPORT_PUBLISHED_OK: real read-only provider contract; desktop/320/390; permissions, CSRF, tenant context, private headers; zero provider writes");
}

main().catch(error => {
  console.error("Support published verification failed:", error instanceof assert.AssertionError ? error.message : error instanceof Error ? error.name : "unknown");
  process.exitCode = 1;
}).finally(async () => {
  const failures: string[] = [];
  async function cleanupStep(name: string, step: () => Promise<unknown>) {
    try { await step(); } catch { failures.push(name); process.exitCode = 1; }
  }
  await Promise.all(contexts.map(context => cleanupStep("browser_context", () => context.close())));
  await cleanupStep("browser", async () => browser?.close());
  try {
    // Independent cleanup stages: even if a tenant deletion fails, synthetic
    // sessions are revoked and control identities are still removed.
    if (userIds.length) await cleanupStep("sessions", () => control.session.deleteMany({ where: { userId: { in: userIds } } }));
    if (tenant && profileIds.length) await cleanupStep("profiles", () => tenant!.tenantUserProfile.deleteMany({ where: { id: { in: profileIds }, userId: { in: userIds } } }));
    if (userIds.length) await cleanupStep("users", () => control.user.deleteMany({ where: { id: { in: userIds }, email: { startsWith: "support-validation-", endsWith: "@example.invalid" } } }));
    if (tenant && roleIds.length) await cleanupStep("roles", () => tenant!.tenantRole.deleteMany({ where: { id: { in: roleIds }, key: { startsWith: "support-check-" }, profiles: { none: {} } } }));
    await cleanupStep("remaining_identities", async () => {
      const remaining = await Promise.all([
        control.user.count({ where: { id: { in: userIds } } }),
        control.session.count({ where: { userId: { in: userIds } } }),
        tenant ? tenant.tenantUserProfile.count({ where: { id: { in: profileIds } } }) : 0,
        tenant ? tenant.tenantRole.count({ where: { id: { in: roleIds } } }) : 0,
      ]);
      assert.ok(remaining.every(count => count === 0));
    });
    if (failures.length) console.error(`SUPPORT_CLEANUP_REQUIRES_REVIEW ${failures.join(",")}`);
    else console.log(`SUPPORT_TEST_IDENTITIES_REMOVED ${userIds.length}; TEST_ROLES_REMOVED ${roleIds.length}; login audit retained`);
  } finally { await Promise.allSettled([tenant?.$disconnect(), control.$disconnect()]); }
});
