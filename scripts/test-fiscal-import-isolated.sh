#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
export PATH=/opt/node-v24.19.0/bin:/usr/lib/postgresql/18/bin:$PATH
audit_dir=$(mktemp -d /tmp/nalven-fiscal-import.XXXXXX)
readonly audit_dir
trap 'pg_ctl -D "$audit_dir/data" -m fast -w stop >/dev/null 2>&1 || true' EXIT
# Match production: the deployment catalog manifests are collation-sensitive.
initdb -D "$audit_dir/data" --locale=pt_PT.UTF-8 --encoding=UTF8 --auth-local=trust --auth-host=reject >/dev/null
pg_ctl -D "$audit_dir/data" -l "$audit_dir/server.log" -o "-k $audit_dir -p 55444 -c listen_addresses=''" -w start >/dev/null
createdb -h "$audit_dir" -p 55444 fiscal_import_test
export TENANT_DATABASE_URL="postgresql://$(id -un)@localhost:55444/fiscal_import_test?host=$audit_dir"
export CONTROL_DATABASE_URL="postgresql://test:test@127.0.0.1:1/unused"
export FISCAL_TEST_DATABASE_URL="$TENANT_DATABASE_URL"
export NALVEN_SECRETS_MASTER_KEY="isolated-test-key-not-for-production"
psql -X -h "$audit_dir" -p 55444 -d fiscal_import_test -v ON_ERROR_STOP=1 -f tests/fixtures/fiscal-test-roles.sql
export TENANT_DATABASE_URL="postgresql://fiscal_test_migrator@localhost:55444/fiscal_import_test?host=$audit_dir"
npx prisma migrate deploy --config prisma.tenant.config.ts
psql -X -U fiscal_test_migrator -h "$audit_dir" -p 55444 -d fiscal_import_test -v ON_ERROR_STOP=1 \
  -v runtime_role=fiscal_test_runtime -v migrator_role=fiscal_test_migrator -v database_name=fiscal_import_test \
  -v manual_worker_role=fiscal_test_mw -v manual_callback_role=fiscal_test_mc -v stepup_issuer_role=fiscal_test_si \
  -v manual_homologator_role=fiscal_test_mh -v manual_vault_binder_role=fiscal_test_mb \
  -v manual_profile_admin_issuer_role=fiscal_test_mpi -v manual_profile_accounting_issuer_role=fiscal_test_mpa \
  -v manual_profile_fiscal_issuer_role=fiscal_test_mpf -v manual_sweeper_role=fiscal_test_ms \
  -f deploy/reconcile-tenant-runtime-grants.sql
export FISCAL_TEST_DATABASE_URL="postgresql://fiscal_test_runtime@localhost:55444/fiscal_import_test?host=$audit_dir"
npx tsx --test tests/fiscal-import-postgres.integration.test.ts
echo "Fiscal integration passed in disposable database; stopped cluster: $audit_dir"
