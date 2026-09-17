/** Real-provider GETs only. Synthetic identities are removed independently on exit.
 * The invalid ERP command verifies the runtime guard but cannot create business data.
 * No key, password, cookie, organization ID or provider payload is logged.
 */
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { readFile, mkdir, chmod } from "node:fs/promises";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient as ControlClient } from "../generated/control/client";
import { PrismaClient as TenantClient } from "../generated/tenant/client";
import { chromium, expect, type Browser, type BrowserContext } from "@playwright/test";
import { hashPassword } from "../lib/password";
import type { PortalLicenseData } from "../lib/billing/portal-license-data";

const base = "https://nalven.com.br", output = "/var/lib/nalven/production-validation";
const control = new ControlClient({ adapter: new PrismaPg({ connectionString: process.env.CONTROL_DATABASE_URL }) });
const userIds: string[] = [], profileIds: number[] = [], roleIds: number[] = [], contexts: BrowserContext[] = [];
let tenant: TenantClient | undefined, browser: Browser | undefined;

function assertPublicKeys(value: unknown) {
  if (!value || typeof value !== "object") return;
  if (Array.isArray(value)) { for (const child of value) assertPublicKeys(child); return; }
  const allowed = new Set(["license", "applicationPlan", "comparison", "source", "warnings", "capabilities", "generatedAt", "version", "status", "statusCode", "valid", "validFrom", "validUntil", "graceUntil", "maxInstallations", "plan", "resources", "limits", "resourcesKnown", "limitsKnown", "code", "name", "enabled", "availability", "limit", "origin", "unit", "kind", "value", "id", "expectedRemoteCode", "modules", "checkedAt", "cached", "canRefresh", "canExportDiagnostic", "canRotate", "planCode"]);
  for (const [key, child] of Object.entries(value)) {
    assert.ok(allowed.has(key), "Projeção contém um campo fora da lista pública permitida");
    assertPublicKeys(child);
  }
}

async function main() {
  const record = await control.tenantDatabase.findUniqueOrThrow({ where: { configKey: "demo" } });
  assert.equal(record.status, "active"); assert.equal(record.databaseName, "nalven_t_demo");
  const content = await readFile("/etc/nalven/tenants/demo.env", "utf8");
  const lines = content.split("\n").filter(line => line.startsWith("TENANT_DATABASE_URL=")); assert.equal(lines.length, 1);
  const connectionString = lines[0].slice("TENANT_DATABASE_URL=".length), connection = new URL(connectionString);
  assert.equal(connection.hostname, "127.0.0.1"); assert.equal(connection.pathname, "/nalven_t_demo"); assert.equal(connection.username, "nalven_t_demo_runtime");
  tenant = new TenantClient({ adapter: new PrismaPg({ connectionString }) });
  browser = await chromium.launch({ headless: true });
  async function account(checkRuntime = false) {
    const key = `license-check-${randomUUID()}`;
    const role = await tenant!.tenantRole.create({ data: { key, name: "Validação temporária da licença", permissions: checkRuntime ? ["billing.read", "production.write"] : ["billing.read"] } }); roleIds.push(role.id);
    const password = randomBytes(32).toString("base64url"), email = `license-validation-${randomUUID()}@example.invalid`;
    const user = await control.user.create({ data: { name: "Validação temporária da licença", email, passwordHash: await hashPassword(password), emailVerifiedAt: new Date(), memberships: { create: { organizationId: record.organizationId, role: key, status: "active" } } } }); userIds.push(user.id);
    const profile = await tenant!.tenantUserProfile.create({ data: { userId: user.id, roleId: role.id, displayName: user.name, email } }); profileIds.push(profile.id);
    const context = await browser!.newContext({ baseURL: base, viewport: { width: 1440, height: 1000 }, serviceWorkers: "block" }); contexts.push(context);
    context.setDefaultTimeout(15_000); context.setDefaultNavigationTimeout(30_000);
    assert.equal((await context.request.post("/api/auth/login", { headers: { origin: base }, data: { email, password } })).status(), 200, "Login sintético real");
    return { context, profile, role };
  }
  const anonymous = await browser.newContext({ baseURL: base }); contexts.push(anonymous);
  assert.equal((await anonymous.request.get("/api/portal/license")).status(), 401);
  const reader = await account(true), second = await account(), headers = { "x-organization-id": record.organizationId };
  const response = await reader.context.request.get("/api/portal/license?refresh=1", { headers });
  assert.equal(response.status(), 200, "Consulta real da licença disponível");
  assert.match(response.headers()["cache-control"] || "", /private.*no-store/);
  const data = await response.json() as PortalLicenseData; assertPublicKeys(data);
  assert.equal(data.source.name, "billing_headless"); assert.ok(data.license.resources.length > 0); assert.equal(data.capabilities.canRotate, false);
  assert.ok(data.license.resources.every(resource => typeof resource.enabled === "boolean" || resource.enabled === null));
  const repeated = await reader.context.request.get("/api/portal/license", { headers }); assert.equal(repeated.status(), 200);
  const cached = await repeated.json() as PortalLicenseData; assert.equal(cached.source.checkedAt, data.source.checkedAt); assert.equal(cached.source.cached, true);
  assert.equal((await reader.context.request.get("/api/portal/license?refresh=invalid", { headers })).status(), 400);
  assert.equal((await reader.context.request.get("/api/portal/license", { headers: { "x-organization-id": "stale-test-organization" } })).status(), 409);
  assert.equal((await reader.context.request.post("/api/portal/license", { headers: { ...headers, origin: base }, data: {} })).status(), 405);
  assert.equal((await reader.context.request.post("/api/portal/license", { headers: { ...headers, origin: "https://external.invalid" }, data: {} })).status(), 403);
  // The route runs assertTenantWriteAccess first. Missing orderId then rejects
  // this unknown command before any production write; the transaction rolls back.
  const linked = await control.billingAccount.findFirst({ where: { organizationId: record.organizationId, AND: [{ licenseSecret: { not: null } }, { licenseSecret: { not: "" } }] }, select: { remoteStatus: true } });
  assert.equal(linked?.remoteStatus, "linked", "Licença vinculada: verificação não pode ser liberada pelo período de teste");
  const commandId = randomUUID();
  const invalidCommand = await reader.context.request.post("/api/erp/production/operations", { headers: { origin: base }, data: { action: "validation.invalid", idempotencyKey: commandId } });
  assert.equal(invalidCommand.status(), 400, "Licença runtime permite alcançar a validação local, que recusa o comando inválido");
  assert.equal(await tenant.productionCommand.count({ where: { key: commandId } }), 0);
  const accountCache = await control.billingAccount.findUniqueOrThrow({ where: { organizationId: record.organizationId }, select: { entitlementCache: true } });
  assert.equal((accountCache.entitlementCache as { source?: string } | null)?.source, "nalven-runtime-v1", "Cache de autorização separado do headless");

  await mkdir(output, { recursive: true, mode: 0o700 }); await chmod(output, 0o700);
  let financeReads = 0, writes = 0;
  // Guard all browser API mutations before any interaction, including non-portal APIs.
  await reader.context.route("**/api/**", async route => {
    if (["GET", "HEAD"].includes(route.request().method())) await route.continue();
    else { writes++; await route.abort("blockedbyclient"); }
  });
  const page = await reader.context.newPage(), errors: string[] = [];
  page.on("pageerror", error => errors.push(error.name));
  page.on("request", request => { if (new URL(request.url()).pathname === "/api/portal/billing" && request.method() === "GET") financeReads++; });
  const documentResponse = await page.goto("/portal?area=licenca"); assert.ok(documentResponse);
  assert.equal(documentResponse.headers()["referrer-policy"], "no-referrer"); assert.match(documentResponse.headers()["cache-control"] || "", /no-store/);
  await expect(page.locator("aside nav a[aria-current='page']")).toContainText("Licença e recursos");
  await expect(page.getByRole("button", { name: "Atualizar licença", exact: true })).toBeEnabled();
  await expect(page.getByLabel("Buscar recurso", { exact: true })).toBeVisible();
  await page.screenshot({ path: `${output}/license-desktop.png`, fullPage: true });
  const zero = data.license.resources.find(resource => resource.limit.kind === "finite" && resource.limit.value === 0);
  if (zero) {
    await page.getByLabel("Buscar recurso", { exact: true }).fill(zero.code);
    await page.getByLabel("Disponibilidade na licença", { exact: true }).selectOption("disabled");
    await expect(page.getByRole("list", { name: "Lista de recursos", exact: true }).getByRole("heading", { name: zero.name, exact: true })).toBeVisible();
    await expect(page.getByText("Este recurso tem cota zero na licença, mesmo se a habilitação recebida estiver marcada como “Sim”.", { exact: true })).toBeVisible();
  }
  const [download] = await Promise.all([page.waitForEvent("download", { timeout: 15_000 }), page.getByRole("button", { name: "Exportar diagnóstico", exact: true }).click()]);
  const stream = await download.createReadStream(); assert.ok(stream);
  const chunks: Buffer[] = []; for await (const chunk of stream) chunks.push(Buffer.from(chunk));
  const diagnostic = JSON.parse(Buffer.concat(chunks).toString("utf8")); assertPublicKeys(diagnostic);
  assert.equal(diagnostic.version, 1); assert.equal(diagnostic.license.resources.length, data.license.resources.length);
  assert.ok(!("name" in diagnostic.applicationPlan)); assert.ok(diagnostic.license.resources.every((resource: object) => !("name" in resource)));
  if (zero) await page.getByRole("button", { name: "Limpar filtros", exact: true }).click();
  await page.getByRole("button", { name: "Fechar aviso do diagnóstico", exact: true }).click();
  for (const width of [320, 390]) {
    await page.setViewportSize({ width, height: 844 });
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `Sem overflow em ${width}px`);
    assert.equal(await page.getByLabel("Buscar recurso", { exact: true }).evaluate(element => getComputedStyle(element).fontSize), "16px");
    await expect(page.getByLabel("Navegar no portal", { exact: true })).toHaveValue("licenca");
    await page.screenshot({ path: `${output}/license-mobile-${width}.png`, fullPage: true });
  }
  assert.equal(financeReads, 0, "Consulta da licença independente das finanças"); assert.equal(writes, 0); assert.deepEqual(errors, []);
  // Permissions must be checked before serving a cached projection.
  await tenant.tenantRole.update({ where: { id: second.role.id }, data: { permissions: [] } });
  assert.equal((await second.context.request.get("/api/portal/license", { headers })).status(), 403);
  await tenant.tenantUserProfile.update({ where: { id: reader.profile.id }, data: { status: "suspended" } });
  assert.equal((await reader.context.request.get("/api/portal/license", { headers })).status(), 403);
  console.log("LICENSE_PUBLISHED_OK: real GET contracts; runtime cache v1; desktop/320/390; private export, permissions, CSRF, tenant context; zero provider mutations");
}

main().catch(error => {
  console.error("License verification failed:", error instanceof assert.AssertionError ? error.message : error instanceof Error ? error.name : "unknown"); process.exitCode = 1;
}).finally(async () => {
  const failures: string[] = [];
  async function step(name: string, action: () => Promise<unknown>) { try { await action(); } catch { failures.push(name); process.exitCode = 1; } }
  await Promise.all(contexts.map(context => step("context", () => context.close()))); await step("browser", async () => browser?.close());
  try {
    if (userIds.length) await step("sessions", () => control.session.deleteMany({ where: { userId: { in: userIds } } }));
    if (tenant && profileIds.length) await step("profiles", () => tenant!.tenantUserProfile.deleteMany({ where: { id: { in: profileIds }, userId: { in: userIds } } }));
    if (userIds.length) await step("users", () => control.user.deleteMany({ where: { id: { in: userIds }, email: { startsWith: "license-validation-", endsWith: "@example.invalid" } } }));
    if (tenant && roleIds.length) await step("roles", () => tenant!.tenantRole.deleteMany({ where: { id: { in: roleIds }, key: { startsWith: "license-check-" }, profiles: { none: {} } } }));
    await step("remaining_identities", async () => {
      const remaining = await Promise.all([control.user.count({ where: { id: { in: userIds } } }), control.session.count({ where: { userId: { in: userIds } } }), tenant ? tenant.tenantUserProfile.count({ where: { id: { in: profileIds } } }) : 0, tenant ? tenant.tenantRole.count({ where: { id: { in: roleIds } } }) : 0]);
      assert.ok(remaining.every(count => count === 0));
    });
    if (failures.length) console.error(`LICENSE_CLEANUP_REQUIRES_REVIEW ${failures.join(",")}`);
    else console.log(`LICENSE_TEST_IDENTITIES_REMOVED ${userIds.length}; TEST_ROLES_REMOVED ${roleIds.length}; login audit retained`);
  } finally { await Promise.allSettled([tenant?.$disconnect(), control.$disconnect()]); }
});
