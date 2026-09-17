import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import test from "node:test";

test("manutenção privilegiada aceita somente operações explícitas sobre candidato selado", () => {
  const script = readFileSync("deploy/production-maintenance.sh", "utf8");
  const sudoers = readFileSync("deploy/production-maintenance.sudoers", "utf8");
  execFileSync("/bin/bash", ["-n", "deploy/production-maintenance.sh"]);
  const rule = sudoers.split("\n").find(line => line.startsWith("nalven ALL="))!;
  assert.equal(rule, "nalven ALL=(root) NOPASSWD: " + ["status", "migrate", "publish", "verify"].map(action => `/usr/local/libexec/nalven/production-maintenance.sh ${action}`).join(", "));
  assert.doesNotMatch(rule, /SETENV|\*|\/bin\/bash|\/home\//);
  assert.match(script, /\$# == 1/);
  assert.match(script, /0:0:750/);
  assert.match(script, /sha256sum --quiet -c RELEASE.sha256/);
  assert.match(script, /Checksum divergente/);
  assert.match(script, /Migration pendente não autorizada/);
  assert.match(script, /systemctl start nalven-backup.service/);
  assert.match(script, /trap rollback ERR/);
  assert.match(script, /http_verify/);
  assert.doesNotMatch(script, /tenant-seed|control-seed|chmod 777|NOPASSWD.*ALL|eval /);
});

test("shell recusa perfil suspenso/vencido e separa cache por identidade, filial e versão de acesso", () => {
  const shell = readFileSync("app/erp/erp-shell.tsx", "utf8"), client = readFileSync("app/erp/erp-client.tsx", "utf8");
  assert.match(shell, /profile\.status !== "active"/);
  assert.match(shell, /profile\.accessExpiresAt <= new Date\(\)/);
  assert.match(shell, /cacheVersion:.*role\?\.updatedAt/);
  assert.match(client, /\[organization\.id, user\.id \|\| user\.email, organization\.activeBranch\?\.id \|\| 0, user\.cacheVersion/);
  assert.match(client, /window\.location\.replace\("\/login"\)/);
  assert.match(client, /window\.location\.assign\("\/erp"\)/);
});

test("publicação instala pelo lockfile, regenera Prisma e não reutiliza dependências locais", () => {
  const script = readFileSync("deploy/publish-current.sh", "utf8");
  assert.match(script, /npm ci --ignore-scripts/);
  assert.match(script, /npm run db:generate/);
  assert.doesNotMatch(script.match(/items=\([^\n]+/)![0], /node_modules|generated/);
  assert.match(script, /exec 9>\/run\/lock\/nalven-production-maintenance.lock/);
  assert.match(readFileSync("deploy/provision-tenant.sh", "utf8"), /flock -s 8/);
  assert.match(script, /npm run test:unit/);
  assert.doesNotMatch(script, /CONTROL_DATABASE_URL="\$connection"/);
  assert.match(script, /IFS= read -r CONTROL_DATABASE_URL/);
  execFileSync("/bin/bash", ["-n", "deploy/publish-current.sh"]);
});

test("migração exige aprovação root por checksum e registra versão realmente aplicada", () => {
  const script = readFileSync("deploy/production-maintenance.sh", "utf8");
  assert.match(script, /migration-approvals.sha256/);
  assert.match(script, /grep -Fxq/);
  assert.match(script, /0:0:600/);
  assert.match(script, /SELECT max\(migration_name\)/);
  assert.match(script, /control-migrator.env/);
  assert.doesNotMatch(script, /readonly approved=/);
});

test("publicadores legados recusam execução antes de qualquer efeito", () => {
  for (const name of ["deploy-release", "publish-admin-reviewed", "publish-security-release", "publish-site-release", "publish-portal-release", "publish-fashion-demo-release"]) {
    const result = execFileSync("/bin/bash", ["-c", `bash deploy/${name}.sh; test $? -eq 1`], { encoding: "utf8", stdio: "pipe" });
    assert.equal(result, "");
    assert.match(readFileSync(`deploy/${name}.sh`, "utf8"), /^#![^\n]+\necho [^\n]+\nexit 1\n/);
  }
});
