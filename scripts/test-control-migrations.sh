#!/usr/bin/env bash
# Disposable socket-only cluster. Never reads production credentials or data.
set -euo pipefail
cd "$(dirname "$0")/.."
export PATH=/opt/node-v24.19.0/bin:/usr/lib/postgresql/18/bin:$PATH
audit_dir=$(mktemp -d /tmp/nalven-control-audit.XXXXXX)
readonly audit_dir
stop_cluster() { pg_ctl -D "$audit_dir/data" -m fast -w stop >/dev/null 2>&1 || true; }
trap stop_cluster EXIT
initdb -D "$audit_dir/data" --auth-local=trust --auth-host=reject >/dev/null
pg_ctl -D "$audit_dir/data" -l "$audit_dir/server.log" -o "-k $audit_dir -p 55442 -c listen_addresses=''" -w start >/dev/null
createdb -h "$audit_dir" -p 55442 control_migration_audit
createdb -h "$audit_dir" -p 55442 control_upgrade_audit
export CONTROL_DATABASE_URL="postgresql://$(id -un)@localhost:55442/control_migration_audit?host=$audit_dir"
export CONTROL_AUDIT_SOCKET="$audit_dir"
npx prisma migrate deploy --config prisma.control.config.ts
# A second deployment must not execute migrations again.
npx prisma migrate deploy --config prisma.control.config.ts
npx tsx --test --test-concurrency=1 tests/control-migrations.integration.ts tests/control-upgrade.integration.ts tests/vault-transaction.integration.ts
echo "Migration audit completed; stopped cluster evidence retained at $audit_dir"
