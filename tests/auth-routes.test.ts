import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { build } from "esbuild";
import test from "node:test";
import { hashPassword } from "../lib/password";

// Execute actual routes, body/origin guards, rate limiting, password KDF and input
// policy. Only persistence, session cookies and external delivery are substituted.
test("fronteiras públicas de autenticação preservam validação, privacidade e atomicidade do convite", async t => {
  const mocks: Record<string, string> = {
    "test:auth-state": `export const state = {};
      export function reset() { Object.assign(state, {
        user: null, sessionUser: null, sessionError: false, sessions: [], selected: [], capacityFull: false,
        resetQueued: 0, resetLookup: 0, lookupEmails: [], rateLimited: false, duplicate: false,
        invite: null, consumedWhere: null, rotated: false, membership: null, profile: null,
        role: { id: 3, key: "stock", active: true }, tenantFailure: false, organizationStatus: "active", lockedUserStatus: "active",
        users: [], members: [], organizations: [], tenantProfiles: [], audit: [], events: [], inviteStatus: "pending",
      }); } reset();`,
    "@/db/control": `import { state } from "test:auth-state";
      export const controlDb = {
        $executeRaw: async () => 0,
        $queryRaw: async parts => parts.join("").includes("FROM organizations") ? [{ status: state.organizationStatus }] : [{ status: state.lockedUserStatus, email: state.user?.email }],
        apiRateLimit: {
          findUnique: async () => state.rateLimited ? { count: 1000, expiresAt: new Date(Date.now() + 60_000) } : null,
          upsert: async () => ({}), update: async () => ({}),
        },
        user: {
          findUnique: async args => { state.lookupEmails.push(args.where.email); return state.user; },
          create: async ({ data }) => { if (state.duplicate) throw Object.assign(new Error("private database constraint"), { code: "P2002" }); const user = { id: "new-user", ...data }; state.users.push(user); return user; },
          update: async ({ data }) => ({ ...state.user, ...data }),
        },
        membership: {
          findUnique: async () => state.membership,
          create: async ({ data }) => { if(state.capacityFull)throw new Error('NALVEN_PLAN_CAPACITY');const member = { id: "new-membership", ...data }; state.members.push(member); state.events.push("membership.create"); return member; },
        },
        organization: { create: async ({ data }) => { state.organizations.push(data); return data; } },
        plan: { findUnique: async () => ({ id: "basic", active: true, visibility: "public", ownerOrganizationId: null, modules: [] }) },
        provisioningJob: { create: async () => ({}) }, billingAccount: { create: async () => ({}) }, billingProvisionJob: { create: async () => ({}) },
        organizationInvite: {
          findUnique: async () => state.invite,
          updateMany: async ({ where }) => { state.consumedWhere = where; if (state.rotated && where.tokenHash) return { count: 0 }; state.inviteStatus = "accepted"; return { count: 1 }; },
        },
        passwordResetToken: { findUnique: async () => { state.resetLookup++; return null; } },
        auditLog: { create: async ({ data }) => { state.audit.push(data); return data; } },
        $transaction: async action => {
          if (Array.isArray(action)) return Promise.all(action);
          const saved = { users: [...state.users], members: [...state.members], organizations: [...state.organizations], audit: [...state.audit], inviteStatus: state.inviteStatus };
          try { const result = await action(controlDb); state.events.push("control.commit"); return result; }
          catch (error) { Object.assign(state, saved); state.events.push("control.rollback"); throw error; }
        },
      };`,
    "@/db": `export { controlDb } from "@/db/control";
      import { state } from "test:auth-state";
      const tenant = {
        tenantRole: { findFirst: async () => state.role },
        tenantUserProfile: {
          findUnique: async () => state.profile,
          upsert: async ({ create }) => { if (state.tenantFailure) throw new Error("private tenant unavailable"); const profile = { id: 8, ...create }; state.tenantProfiles.push(profile); return profile; },
          update: async () => ({}),
        },
        branch: { findFirst: async () => null }, branchUserAccess: { upsert: async () => ({}) },
        tenantAuditEvent: { create: async () => ({}) },
        $transaction: async action => { const saved = [...state.tenantProfiles]; try { const result = await action(tenant); state.events.push("tenant.commit"); return result; } catch (error) { state.tenantProfiles = saved; throw error; } },
      };
      export const tenantDb = async () => tenant;`,
    "@/lib/auth": `import { state } from "test:auth-state";
      import { HttpSecurityError, httpSecurityErrorResponse, privateJson, unexpectedErrorResponse } from "@/lib/http-security";
      export class AuthError extends Error { constructor(status) { super("Acesso negado"); this.status = status; } }
      export const currentUser = async () => { if (state.sessionError) throw new Error("private database connection details"); return state.sessionUser; };
      export const currentMembership = async user => user.memberships.find(item => item.status === "active") || null;
      export const setActiveOrganization = async id => { state.selected.push(id); };
      export const createSession = async (...args) => { state.sessions.push(args); };
      export const destroySession = async () => { state.sessions.length = 0; };
      export const authErrorResponse = error => error instanceof HttpSecurityError ? httpSecurityErrorResponse(error) : error instanceof AuthError ? privateJson({ error: error.message }, { status: error.status }) : unexpectedErrorResponse("auth.test", error);`,
    "@/lib/auth-recovery": `import { createHash } from "node:crypto"; import { state } from "test:auth-state";
      export const createPasswordReset = async () => { state.resetQueued++; };
      export const resetTokenHash = token => createHash("sha256").update(token).digest("hex");`,
    "@/lib/site/signup": `export const signupConfiguration = async () => ({ paymentMethods: ["pix"], billingPlanCodes: { basic: "basic" }, dueDay: 10, trialDays: 7, origin: "https://auth.example.test" });`,
    "@/lib/billing/client": `export const billingSettings = async () => ({ appVersion: "test" });`,
    "@/lib/analytics/service": `export const incrementFunnelStep = async () => {};`,
  };
  const names = ["login", "signup", "forgot-password", "reset-password", "invite", "logout", "organization", "me"];
  const bundled = await build({
    stdin: { contents: names.map((name, index) => `export * as route${index} from "./app/api/auth/${name}/route";`).join("\n") + '\nexport { state, reset } from "test:auth-state";', resolveDir: process.cwd(), loader: "ts" },
    bundle: true, write: false, platform: "node", format: "cjs", packages: "external",
    plugins: [{ name: "isolated-auth-dependencies", setup(plugin) {
      plugin.onResolve({ filter: /.*/ }, args => args.path in mocks ? { path: args.path, namespace: "fixture" } : undefined);
      plugin.onLoad({ filter: /.*/, namespace: "fixture" }, args => ({ contents: mocks[args.path], loader: "js", resolveDir: process.cwd() }));
    } }],
  });
  const routeModule = { exports: {} };
  new Function("require", "module", "exports", bundled.outputFiles[0].text)(createRequire(import.meta.url), routeModule, routeModule.exports);
  // The mutable mock graph intentionally mirrors different Prisma delegates.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { state, reset, ...routes } = routeModule.exports as Record<string, any>;
  const [login, signup, forgot, recovery, invite, logout, organization, me] = names.map((_, index) => routes[`route${index}`]);
  const origin = "https://auth.example.test";
  const request = (name: string, data: unknown, headers: Record<string, string> = {}) => new Request(`${origin}/api/auth/${name}`, { method: "POST", headers: { origin, "content-type": "application/json", ...headers }, body: JSON.stringify(data) });
  const password = "CurrentPassword123!", encoded = await hashPassword(password);
  const user = { id: "existing-user", name: "Operador", email: "operator@example.test", passwordHash: encoded, status: "active", role: "user", memberships: [{ organizationId: "org-a", status: "active", role: "stock", organization: { id: "org-a", name: "Empresa", slug: "empresa", status: "active" } }] };
  const signupBody = { name: "Operador", company: "Empresa de teste", email: user.email, password, document: "11222333000181", responsibleCpf: "52998224725", state: "SP", zip: "01001000", street: "Praça da Sé", number: "1", city: "São Paulo", phone: "11999999999", planId: "basic", paymentMethod: "pix", dueDay: 10 };
  const token = "t".repeat(43);
  const makeInvite = () => { state.invite = { id: "invite-a", email: user.email, name: user.name, roleKey: "stock", organizationId: "org-a", status: "pending", expiresAt: new Date(Date.now() + 60_000), organization: { id: "org-a", name: "Empresa", status: "active" } }; };
  const assertPrivate = (response: Response) => assert.match(response.headers.get("cache-control") || "", /private, no-store/);

  await t.test("origem externa é recusada nas sete mutações antes de consultar contas", async () => {
    for (const [name, route] of names.slice(0, 7).map((name, index) => [name, routes[`route${index}`]] as const)) {
      reset();
      const response = await route.POST(request(name, {}, { origin: "https://external.invalid" }));
      assert.equal(response.status, 403, name); assertPrivate(response); assert.equal(state.lookupEmails.length, 0); assert.equal(state.sessions.length, 0);
    }
  });
  await t.test("login não converte arrays em credenciais e normaliza somente e-mail", async () => {
    reset(); state.user = user;
    for (const data of [{ email: [user.email], password }, { email: user.email, password: [password] }, { email: "operator@@example.test", password }]) {
      assert.equal((await login.POST(request("login", data))).status, 400);
    }
    assert.equal(state.lookupEmails.length, 0);
    assert.equal((await login.POST(request("login", { email: " Operator@Example.Test ", password, remember: true }))).status, 200);
    assert.deepEqual(state.sessions[0], [user.id, "org-a", true, encoded]);
  });
  await t.test("conta desconhecida, suspensa e senha incorreta retornam a mesma resposta", async () => {
    const bodies: unknown[] = [];
    for (const found of [null, { ...user, status: "suspended" }, user]) {
      reset(); state.user = found;
      const response = await login.POST(request("login", { email: user.email, password: "WrongPassword123!" }));
      assert.equal(response.status, 401); assertPrivate(response); bodies.push(await response.json()); assert.equal(state.sessions.length, 0);
    }
    assert.deepEqual(bodies, Array(3).fill({ error: "Credenciais inválidas" }));
  });
  await t.test("recuperação não enumera contas, mas mantém 403, 413, 415 e JSON inválido", async () => {
    const bodies: unknown[] = [];
    for (const found of [null, { ...user, status: "suspended" }, user]) {
      reset(); state.user = found;
      const response = await forgot.POST(request("forgot-password", { email: user.email }));
      assert.equal(response.status, 200); assertPrivate(response); bodies.push(await response.json()); assert.equal(state.resetQueued, found?.status === "active" ? 1 : 0);
    }
    assert.deepEqual(bodies[0], bodies[1]); assert.deepEqual(bodies[1], bodies[2]);
    reset();
    assert.equal((await forgot.POST(request("forgot-password", {}, { origin: "https://external.invalid" }))).status, 403);
    assert.equal((await forgot.POST(request("forgot-password", { email: "x".repeat(4096) }))).status, 413);
    assert.equal((await forgot.POST(request("forgot-password", {}, { "content-type": "text/plain" }))).status, 415);
    assert.equal((await forgot.POST(new Request(`${origin}/api/auth/forgot-password`, { method: "POST", headers: { origin, "content-type": "application/json" }, body: "{" }))).status, 400);
    assert.equal(state.resetQueued, 0);
  });
  await t.test("limites retornam Retry-After sem detalhes de conta", async () => {
    for (const [name, route] of [["login", login], ["forgot-password", forgot]] as const) {
      reset(); state.rateLimited = true;
      const response = await route.POST(request(name, { email: user.email, password }));
      assert.equal(response.status, 429); assert.ok(Number(response.headers.get("retry-after")) > 0); assertPrivate(response); assert.equal(state.lookupEmails.length, 0);
    }
  });
  await t.test("cadastro recusa coerções e trata conflito sem detalhes internos", async () => {
    for (const change of [{ password: [password] }, { paymentMethod: ["pix"] }, { dueDay: true }, { planId: ["basic"] }]) {
      reset(); assert.equal((await signup.POST(request("signup", { ...signupBody, ...change }))).status, 400); assert.equal(state.users.length, 0);
    }
    reset(); state.duplicate = true;
    const response = await signup.POST(request("signup", signupBody));
    assert.equal(response.status, 409); assert.equal((await response.json()).code, "SIGNUP_CONFLICT"); assert.equal(state.organizations.length, 0); assert.equal(state.sessions.length, 0); assertPrivate(response);
    reset();
    assert.equal((await signup.POST(request("signup", signupBody))).status, 201);
    assert.equal(state.sessions[0][3], state.users[0].passwordHash);
  });
  await t.test("nome longo gera identificador aceito pelo provisionador de tenants", async () => {
    reset();
    const response = await signup.POST(request("signup", { ...signupBody, company: "Empresa internacional de tecnologia e operações integradas" }));
    assert.equal(response.status, 201);
    assert.match(state.organizations[0].slug, /^[a-z0-9-]{1,45}$/);
  });
  await t.test("cadastro, redefinição e convite aplicam a mesma política de nova senha", async () => {
    for (const weak of ["lowercaseonlypassword", "UPPERCASEONLY123", "WithoutDigitsLong", "Short12", "A1" + "x".repeat(255), [password]]) {
      reset(); makeInvite();
      for (const [name, route, body] of [["signup", signup, signupBody], ["reset-password", recovery, { token }], ["invite", invite, { token, name: user.name }]] as const) {
        assert.equal((await route.POST(request(name, { ...body, password: weak }))).status, 400, name);
      }
      assert.equal(state.users.length, 0); assert.equal(state.resetLookup, 0); assert.equal(state.inviteStatus, "pending");
    }
  });
  await t.test("token de convite rotacionado durante a requisição não é aceito", async () => {
    reset(); makeInvite(); state.rotated = true;
    assert.equal((await invite.POST(request("invite", { token, name: user.name, password }))).status, 400);
    assert.match(state.consumedWhere.tokenHash, /^[a-f0-9]{64}$/);
    assert.equal(state.consumedWhere.email, user.email); assert.equal(state.consumedWhere.roleKey, "stock");
    assert.equal(state.inviteStatus, "pending"); assert.equal(state.members.length, 0); assert.equal(state.sessions.length, 0);
  });
  await t.test("convite não sobrescreve proprietário ou vínculo existente desativado", async () => {
    for (const membership of [{ role: "owner", status: "active" }, { role: "stock", status: "disabled" }]) {
      reset(); makeInvite(); state.user = user; state.sessionUser = user; state.membership = membership;
      assert.equal((await invite.POST(request("invite", { token }))).status, 409);
      assert.deepEqual(state.membership, membership); assert.equal(state.members.length, 0); assert.equal(state.inviteStatus, "pending");
    }
  });
  await t.test("convite não concede acesso a empresa ou conta suspensa durante a requisição", async () => {
    for (const status of ["suspended", "past_due", "provisioning"]) {
      reset(); makeInvite(); state.invite.organization.status = status;
      assert.equal((await invite.GET(new Request(`${origin}/api/auth/invite?token=${token}`))).status, 403);
      assert.equal((await invite.POST(request("invite", { token, name: user.name, password }))).status, 403);
      assert.equal(state.inviteStatus, "pending"); assert.equal(state.users.length, 0);
    }
    reset(); makeInvite(); state.organizationStatus = "suspended";
    assert.equal((await invite.POST(request("invite", { token, name: user.name, password }))).status, 403);
    assert.equal(state.inviteStatus, "pending"); assert.equal(state.members.length, 0);
    reset(); makeInvite(); state.user = user; state.sessionUser = user; state.lockedUserStatus = "suspended";
    assert.equal((await invite.POST(request("invite", { token }))).status, 403);
    assert.equal(state.inviteStatus, "pending"); assert.equal(state.members.length, 0);
  });
  await t.test("convite não reativa perfil suspenso, vencido ou proprietário", async () => {
    for (const profile of [{ status: "suspended", roleId: 3, role: { key: "stock" } }, { status: "active", roleId: 3, role: { key: "stock" }, accessExpiresAt: new Date(0) }, { status: "active", roleId: 1, role: { key: "owner" } }, { status: "active", roleId: 10, role: { key: "custom-auditor" } }]) {
      reset(); makeInvite(); state.user = user; state.sessionUser = user; state.profile = profile;
      assert.equal((await invite.POST(request("invite", { token }))).status, 403);
      assert.equal(state.members.length, 0); assert.equal(state.tenantProfiles.length, 0); assert.equal(state.inviteStatus, "pending");
    }
  });
  await t.test("capacidade esgotada preserva convite pendente e não cria conta ou sessão", async () => {
    reset(); makeInvite(); state.capacityFull = true;
    const response = await invite.POST(request("invite", { token, name: user.name, password }));
    assert.equal(response.status, 409); assertPrivate(response);
    assert.match((await response.json()).error, /plano não comporta/);
    assert.equal(state.inviteStatus, "pending"); assert.equal(state.users.length, 0); assert.equal(state.members.length, 0); assert.equal(state.sessions.length, 0); assert.equal(state.tenantProfiles.length, 0);
  });
  await t.test("falha tenant desfaz convite e vínculo; a mesma solicitação pode ser repetida", async () => {
    reset(); makeInvite(); state.tenantFailure = true;
    const response = await invite.POST(request("invite", { token, name: user.name, password }));
    assert.equal(response.status, 500); assertPrivate(response); assert.doesNotMatch(await response.text(), /private tenant/);
    assert.equal(state.inviteStatus, "pending"); assert.equal(state.users.length, 0); assert.equal(state.members.length, 0); assert.equal(state.sessions.length, 0);
    state.tenantFailure = false; state.events = [];
    assert.equal((await invite.POST(request("invite", { token, name: user.name, password }))).status, 200);
    assert.equal(state.inviteStatus, "accepted"); assert.equal(state.members.length, 1); assert.equal(state.tenantProfiles.length, 1); assert.equal(state.sessions.length, 1);
    assert.ok(state.events.indexOf("tenant.commit") < state.events.lastIndexOf("control.commit"));
  });
  await t.test("organização e sessão usam erros privados e não expõem falha interna", async () => {
    reset();
    assert.equal((await me.GET()).status, 401);
    state.sessionUser = user;
    const forbidden = await organization.POST(request("organization", { organizationId: "org-b" }));
    assert.equal(forbidden.status, 403); assertPrivate(forbidden); assert.equal(state.selected.length, 0);
    assert.equal((await organization.POST(request("organization", { organizationId: ["org-a"] }))).status, 403);
    assert.equal((await organization.POST(request("organization", { organizationId: "org-a" }))).status, 200);
    assert.deepEqual(state.selected, ["org-a"]);
    state.sessionError = true;
    const failed = await me.GET(); assert.equal(failed.status, 500); assertPrivate(failed); assert.doesNotMatch(await failed.text(), /connection details/);
    assert.equal((await logout.POST(new Request(`${origin}/api/auth/logout`, { method: "POST", headers: { origin } }))).status, 200);
  });
});
