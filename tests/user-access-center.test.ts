import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { accessState, csvCell, deviceLabel, isStaleLogin, maskIp, needsAccessReview } from "../lib/erp/user-access-control";
import { inviteInput, memberInput, roleInput, UserAccessInputError } from "../lib/erp/user-access-input";

test("calcula bloqueio, expiração, inatividade e revisão sem depender da interface", () => {
  const now = new Date("2026-09-03T12:00:00Z");
  assert.equal(accessState(null, "disabled", now), "disabled");
  assert.equal(accessState({ status: "active", accessExpiresAt: "2026-09-02T12:00:00Z" }, "active", now), "expired");
  assert.equal(accessState({ status: "active", accessExpiresAt: "2026-09-04T12:00:00Z" }, "active", now), "active");
  assert.equal(isStaleLogin("2026-07-01T12:00:00Z", "2026-01-01T12:00:00Z", now), true);
  assert.equal(needsAccessReview({ status: "active", lastAccessReviewAt: "2026-05-01T12:00:00Z" }, "2026-01-01T12:00:00Z", now), true);
});

test("valida perfis, validade de convites e escopos de filial", () => {
  assert.deepEqual(inviteInput({ email: " Pessoa@Empresa.COM ", roleKey: "sales", expiresInDays: 15 }), { email: "pessoa@empresa.com", name: null, roleKey: "sales", expiresInDays: 15 });
  assert.throws(() => inviteInput({ email: "a@b.com", roleKey: "sales", expiresInDays: 31 }), UserAccessInputError);
  const role = roleInput({ name: "Operação", permissions: ["stock.read", "stock.write"], active: false });
  assert.equal(role.key, "operacao"); assert.equal(role.active, false);
  const member = memberInput({ membershipId: "member-123", roleKey: "stock", status: "active", phone: "+55 (49) 99999-0000", branchAccesses: [{ branchId: 1, primary: true, canManageStock: true }] });
  assert.equal(member.branchAccesses?.[0].canManageStock, true);
  for (const status of [undefined, null, "", "suspended", true, 1, ["active"], {}]) {
    assert.throws(() => memberInput({ membershipId: "member-123", roleKey: "stock", status }), UserAccessInputError);
  }
  assert.throws(() => memberInput({ membershipId: "member-123", roleKey: "stock", status: "active", branchAccesses: [{ branchId: 1, primary: true }, { branchId: 2, primary: true }] }), UserAccessInputError);
});

test("protege IP e identifica dispositivo nas respostas administrativas", () => {
  assert.equal(maskIp("177.52.18.91"), "177.52.x.x");
  assert.equal(maskIp("2001:db8:85a3::8a2e:370:7334"), "2001:db8:85a3:…");
  assert.equal(deviceLabel("Mozilla/5.0 (Windows NT 10.0) Chrome/140.0"), "Chrome · Windows");
  assert.equal(csvCell('Ana "A"'), '"Ana ""A"""');
});

test("API aplica autorização, auditoria, sessões, lote e leitura sem efeitos colaterais", async () => {
  const wrapper = await readFile(new URL("../app/api/erp/users/route.ts", import.meta.url), "utf8");
  const source = await readFile(new URL("../lib/erp/user-access-handlers.ts", import.meta.url), "utf8");
  const readHandler = source.slice(source.indexOf("export async function getOrganizationUsers"), source.indexOf("export async function postOrganizationUsers"));
  assert.match(wrapper, /assertTenantPermission\(organization\.id, "users\.read"\)/);
  assert.match(wrapper, /assertTenantPermission\(organization\.id, "users\.write"\)/);
  assert.match(readHandler, /await resolveScope\(\)/);
  assert.doesNotMatch(readHandler, /\.createMany\(|\.updateMany\(|\.upsert\(/);
  assert.match(source, /member\.sessions_revoke/);
  assert.match(source, /member\.bulk_update/);
  assert.match(source, /membership\.access_reviewed/);
  assert.match(source, /branchUserAccess\.deleteMany/);
  assert.match(source, /content-disposition.*usuarios-acessos\.csv/);
});

test("expiração é imposta pelo autorizador central e a UI cobre desktop e mobile", async () => {
  const [permissions, component, css, schema, migration, seed] = await Promise.all([
    readFile(new URL("../lib/erp/permissions.ts", import.meta.url), "utf8"),
    readFile(new URL("../components/erp/user-access-center.tsx", import.meta.url), "utf8"),
    readFile(new URL("../components/erp/user-access-center.module.css", import.meta.url), "utf8"),
    readFile(new URL("../prisma/tenant/schema.prisma", import.meta.url), "utf8"),
    readFile(new URL("../prisma/tenant/migrations/20260903180000_user_access_control_center/migration.sql", import.meta.url), "utf8"),
    readFile(new URL("../scripts/seed-demo-users.ts", import.meta.url), "utf8"),
  ]);
  assert.match(permissions, /profile\.accessExpiresAt && profile\.accessExpiresAt <= new Date\(\)/);
  assert.match(component, /Filiais e operações/); assert.match(component, /Segurança e sessões/); assert.match(component, /role="tablist"/);
  assert.match(css, /@media\(max-width:680px\)/); assert.doesNotMatch(css, /font-size:[0-9](?:\.|)px/);
  for (const field of ["jobTitle", "department", "accessExpiresAt", "lastAccessReviewAt"]) assert.match(schema, new RegExp(field));
  assert.match(migration, /tenant_user_profiles_status_access_expires_at_idx/);
  assert.match(seed, /NALVEN_ALLOW_DEMO_USER_SEED/); assert.match(seed, /nalven_t_demo_runtime/); assert.match(seed, /randomBytes\(48\)/);
});
