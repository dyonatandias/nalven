#!/usr/bin/env bash
# Compile against a fresh control database, never the production schema.
set -euo pipefail
cd "$(dirname "$0")/.."
export PATH=/opt/node-v24.19.0/bin:/usr/lib/postgresql/18/bin:$PATH
audit_dir=$(mktemp -d /tmp/nalven-admin-build.XXXXXX)
readonly audit_dir
stop_cluster() { pg_ctl -D "$audit_dir/data" -m fast -w stop >/dev/null 2>&1 || true; }
trap stop_cluster EXIT
initdb -D "$audit_dir/data" --auth-local=trust --auth-host=reject >/dev/null
pg_ctl -D "$audit_dir/data" -l "$audit_dir/server.log" -o "-k $audit_dir -p 55443 -c listen_addresses=''" -w start >/dev/null
createdb -h "$audit_dir" -p 55443 admin_build_test
export CONTROL_DATABASE_URL="postgresql://$(id -un)@localhost:55443/admin_build_test?host=$audit_dir"
export TENANT_DATABASE_URL="postgresql://test:test@127.0.0.1:1/unused"
export PRISMA_HIDE_UPDATE_MESSAGE=1
npx prisma migrate deploy --config prisma.control.config.ts
psql -X -h "$audit_dir" -p 55443 -d admin_build_test -v ON_ERROR_STOP=1 -f tests/fixtures/admin-build-settings.sql
npm run build
echo "Build passed against isolated database; stopped cluster retained at $audit_dir"
