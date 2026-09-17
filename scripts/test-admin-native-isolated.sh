#!/usr/bin/env bash
# Invoke with sudo unshare --net --mount --fork bash scripts/test-admin-native-isolated.sh.
# Root only prepares isolation; migrations, application and browser run as nalven.
set -euo pipefail
[[ $EUID == 0 && $# == 0 ]]
[[ $(readlink /proc/self/ns/net) != $(readlink /proc/1/ns/net) ]]
[[ $(readlink /proc/self/ns/mnt) != $(readlink /proc/1/ns/mnt) ]]
cd /home/nalven/nalven
export PATH=/opt/node-v24.19.0/bin:/usr/lib/postgresql/18/bin:/usr/sbin:/usr/bin:/sbin:/bin
mount --make-rprivate /
ip link set lo up
audit_dir=$(mktemp -d /tmp/nalven-native.XXXXXX)
readonly audit_dir
mkdir "$audit_dir/etc" "$audit_dir/etc/tenants"
touch "$audit_dir/empty"
cp tests/fixtures/admin-native-tenant.conf "$audit_dir/etc/tenants/native-demo.env"
chown -R nalven:nalven "$audit_dir"
mount --bind "$audit_dir/etc" /etc/nalven
mount -o remount,bind,ro /etc/nalven
for source_env in .env .env.local .env.production .env.production.local .next/standalone/.env .next/standalone/.env.local .next/standalone/.env.production .next/standalone/.env.production.local; do
  if [[ -f $source_env ]]; then mount --bind "$audit_dir/empty" "$PWD/$source_env"; fi
done
server_pid=""
cleanup() {
  if [[ -n $server_pid ]]; then kill -- "-$server_pid" 2>/dev/null || true; fi
  runuser -u nalven -- pg_ctl -D "$audit_dir/data" -m fast -w stop >/dev/null 2>&1 || true
  runuser -u nalven -- pg_ctl -D "$audit_dir/tenant-data" -m fast -w stop >/dev/null 2>&1 || true
}
trap cleanup EXIT
for cluster in data tenant-data; do
  runuser -u nalven -- initdb -D "$audit_dir/$cluster" --auth-local=trust --auth-host=trust >/dev/null
done
runuser -u nalven -- pg_ctl -D "$audit_dir/data" -l "$audit_dir/control.log" -o "-h 127.0.0.1 -k $audit_dir -p 55439" -w start >/dev/null
runuser -u nalven -- pg_ctl -D "$audit_dir/tenant-data" -l "$audit_dir/tenant.log" -o "-h 127.0.0.1 -k $audit_dir -p 5432" -w start >/dev/null
runuser -u nalven -- createdb -h 127.0.0.1 -p 5432 nalven_native_demo
run_test() {
  runuser -u nalven -- env -i PATH="$PATH" CONTROL_DATABASE_URL=postgresql://nalven@127.0.0.1:55439/postgres TENANT_DATABASE_URL=postgresql://nalven@127.0.0.1:5432/nalven_native_demo PRISMA_HIDE_UPDATE_MESSAGE=1 NEXT_TELEMETRY_DISABLED=1 "$@"
}
run_test npx prisma migrate deploy --config prisma.control.config.ts
run_test npx prisma migrate deploy --config prisma.tenant.config.ts
run_test psql -X -h 127.0.0.1 -p 55439 -d postgres -v ON_ERROR_STOP=1 -f tests/fixtures/admin-build-settings.sql
run_test psql -X -h 127.0.0.1 -p 55439 -d postgres -v ON_ERROR_STOP=1 -f tests/fixtures/admin-native-control.sql
run_test psql -X -h 127.0.0.1 -p 5432 -d nalven_native_demo -v ON_ERROR_STOP=1 -f tests/fixtures/admin-native-tenant.sql
run_test cp -a public .next/standalone/
run_test cp -a .next/static .next/standalone/.next/
setsid runuser -u nalven -- env -i PATH="$PATH" NODE_ENV=production PORT=4185 HOSTNAME=127.0.0.1 CONTROL_DATABASE_URL=postgresql://nalven@127.0.0.1:55439/postgres NEXT_TELEMETRY_DISABLED=1 node .next/standalone/server.js >"$audit_dir/server.log" 2>&1 &
server_pid=$!
for attempt in {1..60}; do
  if curl --silent --fail http://127.0.0.1:4185/login >/dev/null; then break; fi
  kill -0 "$server_pid"
  sleep 1
done
run_test npx tsx scripts/admin-native-audit.ts
echo "Native audit passed; isolated evidence retained at $audit_dir. Test processes are stopped on exit."
