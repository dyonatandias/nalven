import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  BRAZIL_TIME_ZONES,
  BRAZIL_TIME_ZONE,
  BRAZIL_TIME_ZONE_LABEL,
  formatBrazilDateTime,
  normalizeBrazilTimeZone,
} from "../lib/timezone";
import {
  setTenantTimeZone,
  tenantDateTimeFormatter,
} from "../lib/client-timezone";

const services = [
  "nalven.service",
  "nalven-analytics.service",
  "nalven-billing-jobs.service",
  "nalven-dfe-sync.service",
  "nalven-pos-maintenance.service",
  "nalven-pos-manual-sweep.service",
  "nalven-pos-profile-accounting-issuer@.service",
  "nalven-pos-profile-admin-issuer@.service",
  "nalven-pos-profile-fiscal-issuer@.service",
  "nalven-pos-vault-binder@.service",
  "nalven-tenant-jobs.service",
  "nalven-tenant-provisioning.service",
  "nalven-backup.service",
  "nalven-recovery-backup.service",
];

test("horário civil padrão é America/Sao_Paulo", () => {
  assert.equal(BRAZIL_TIME_ZONE, "America/Sao_Paulo");
  assert.equal(BRAZIL_TIME_ZONE_LABEL, "horário de Brasília");
  assert.equal(
    formatBrazilDateTime("2026-09-15T14:44:08.000Z"),
    "15/09/2026, 11:44",
  );
});

test("cada organização pode selecionar um fuso brasileiro", () => {
  assert.ok(BRAZIL_TIME_ZONES.some(([value]) => value === "America/Manaus"));
  assert.equal(normalizeBrazilTimeZone("America/Manaus"), "America/Manaus");
  assert.equal(normalizeBrazilTimeZone("UTC"), BRAZIL_TIME_ZONE);
  const formatter = tenantDateTimeFormatter({
    dateStyle: "short",
    timeStyle: "short",
  });
  setTenantTimeZone("America/Manaus");
  assert.equal(formatter.format(new Date("2026-09-15T14:44:08.000Z")), "15/09/2026, 10:44");
  setTenantTimeZone(BRAZIL_TIME_ZONE);
  assert.equal(formatter.format(new Date("2026-09-15T14:44:08.000Z")), "15/09/2026, 11:44");
});

test("serviço web e workers declaram o mesmo fuso", () => {
  for (const service of services) {
    const source = readFileSync(`deploy/${service}`, "utf8");
    assert.match(source, /^Environment=TZ=America\/Sao_Paulo$/m, service);
  }
});

test("agendamentos diários usam horário de São Paulo", () => {
  const backup = readFileSync("deploy/nalven-backup.timer", "utf8");
  const recovery = readFileSync("deploy/nalven-recovery-backup.timer", "utf8");
  assert.match(backup, /^OnCalendar=\*-\*-\* 03:15:00 America\/Sao_Paulo$/m);
  assert.match(recovery, /^OnCalendar=\*-\*-\* 03:45:00 America\/Sao_Paulo$/m);
});

test("cadastros operacionais usam São Paulo como padrão", () => {
  const schema = readFileSync("prisma/tenant/schema.prisma", "utf8");
  const settings = readFileSync("lib/erp/settings-input.ts", "utf8");
  const branches = readFileSync("lib/erp/branch-input.ts", "utf8");
  assert.match(schema, /timezone\s+String\s+@default\("America\/Sao_Paulo"\)/);
  assert.match(settings, /input\.timezone \|\| "America\/Sao_Paulo"/);
  assert.match(branches, /value \|\| "America\/Sao_Paulo"/);
});

test("telas fiscais convertem instantes para o fuso da organização", () => {
  for (const file of [
    "components/erp/dfe-inbox.tsx",
    "components/erp/fiscal-center.tsx",
    "components/erp/nfe-input-workspace.tsx",
  ]) {
    const source = readFileSync(file, "utf8");
    assert.match(source, /tenantDateTimeFormatter/);
    assert.doesNotMatch(source, /timeZone: "America\/Sao_Paulo"/);
  }
});

test("shell entrega o fuso da filial ativa para toda a interface", () => {
  const shell = readFileSync("app/erp/erp-shell.tsx", "utf8");
  const client = readFileSync("app/erp/erp-client.tsx", "utf8");
  assert.match(shell, /activeBranch: \{ select: \{[^}]*timezone: true/);
  assert.match(shell, /timezone: preferences\?\.timezone \|\| "America\/Sao_Paulo"/);
  assert.match(client, /setTenantTimeZone\(organization\.activeBranch\?\.timezone \|\| organization\.timezone\)/);
});
