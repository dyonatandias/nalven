import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const script = readFileSync("deploy/backup-databases.sh", "utf8");
const service = readFileSync("deploy/nalven-backup.service", "utf8");
const release = readFileSync("deploy/deploy-release.sh", "utf8");

test("backup usa archive parcial, valida restore e só então publica dump e manifesto", () => {
  assert.match(script, /\.dump\.partial/);
  assert.match(script, /pg_restore --list/);
  assert.match(script, /sha256sum "\$partial_dump"/);
  assert.match(script, /manifest-\$timestamp\.sha256/);
  assert.match(script, /sha256sum --check --strict/);
  assert.match(script, /mv -- "\$partial_dump" "\$final_dump"/);
  assert.match(script, /mv -- "\$manifest_partial" "\$manifest"/);
  assert.match(script, /flock -n 9/);
  assert.match(script, /\/run\/nalven-backup\/backup\.lock/);
  assert.match(script, /created_dumps\+=\("\$final_dump"\)/);
  assert.match(script, /if \[\[ "\$published" != true \]\]/);
  assert.match(script, /\[\[ -e "\$final_dump" \|\| -e "\$final_dump\.partial" \]\]/);
  assert.match(script, /trap cleanup EXIT/);
  assert.match(script, /trap 'exit 1' HUP INT TERM/);
  assert.doesNotMatch(script, /trap cleanup EXIT HUP INT TERM/);
});

test("backup usa catálogo e peer local, sem ler ou passar credencial tenant", () => {
  assert.match(script, /export PGDATABASE="\$database"/);
  assert.match(script, /pg_dump --format=custom --no-password/);
  assert.match(script, /SELECT config_key, database_name FROM tenant_databases/);
  assert.doesNotMatch(script, /tenant_databases WHERE status/);
  assert.match(script, /dump_database "tenant-\$tenant_config_key" "\$tenant_database_name"/);
  assert.doesNotMatch(script, /\/etc\/nalven\/tenants/);
  assert.doesNotMatch(script, /TENANT_(MIGRATOR_)?DATABASE_URL/);
  assert.doesNotMatch(script, /pg_dump[^\n]*(--dbname|-d)[= ]/);
});

test("retenção é limitada e remove apenas nomes exatos de um manifesto validado", () => {
  assert.match(script, /retention_days < 7 \|\| retention_days > 365/);
  assert.match(script, /backup_name.*control\|tenant-/);
  assert.match(script, /rm -f -- "\$backup_root\/\$backup_name"/);
  assert.doesNotMatch(script, /find[^\n]*'\*\.dump'[^\n]*-delete/);
});

test("serviço restringe escrita ao diretório de backup", () => {
  assert.match(service, /ProtectSystem=strict/);
  assert.match(service, /PrivateTmp=true/);
  assert.match(service, /RuntimeDirectory=nalven-backup/);
  assert.match(service, /RuntimeDirectoryMode=0700/);
  assert.match(service, /ReadWritePaths=\/var\/backups\/nalven/);
  assert.match(service, /TimeoutStartSec=6h/);
  assert.match(release, /backup-databases\.sh/);
  assert.match(release, /nalven-backup\.service/);
  assert.match(release, /enable --now[^\n]*nalven-backup\.timer/);
});
