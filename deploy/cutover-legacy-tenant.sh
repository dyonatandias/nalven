#!/usr/bin/env bash
set -euo pipefail

[[ ${EUID:-$(id -u)} -eq 0 ]] || { echo "Execute como root." >&2; exit 1; }

tenant_key=${1:?Informe a chave do tenant}
[[ "$tenant_key" =~ ^[a-z0-9-]{1,45}$ ]] || { echo "Chave de tenant inválida." >&2; exit 1; }

db_suffix=${tenant_key//-/_}
database_name="nalven_t_${db_suffix}"
migrator_role="${database_name}_migrator"
runtime_role="${database_name}_runtime"
manual_worker_role="${database_name}_mw"
manual_callback_role="${database_name}_mc"
stepup_issuer_role="${database_name}_si"
manual_homologator_role="${database_name}_mh"
manual_vault_binder_role="${database_name}_mb"
profile_admin_role="${database_name}_mpi"
profile_accounting_role="${database_name}_mpa"
profile_fiscal_role="${database_name}_mpf"
manual_sweeper_role="${database_name}_ms"

runtime_config="/etc/nalven/tenants/${tenant_key}.env"
migrator_config="/etc/nalven/tenant-migrators/${tenant_key}.env"
[[ -f "$runtime_config" && ! -L "$runtime_config" ]] || { echo "Credencial runtime legada ausente." >&2; exit 1; }
[[ $(stat -c '%u:%G:%a' "$runtime_config") == 0:nalven-app:640 ]] || { echo "Credencial runtime legada insegura." >&2; exit 1; }

legacy_url=$(sed -n 's/^TENANT_DATABASE_URL=//p' "$runtime_config")
[[ "$legacy_url" =~ ^postgres(ql)?://([a-z][a-z0-9_]{0,62}):([^@[:space:]]+)@127\.0\.0\.1:5432/([a-z][a-z0-9_]{0,62})$ ]] \
  || { echo "URL runtime legada inválida ou não local." >&2; exit 1; }
legacy_role=${BASH_REMATCH[2]}
[[ ${BASH_REMATCH[4]} == "$database_name" ]] || { echo "Banco da URL legada diverge do tenant." >&2; exit 1; }
[[ "$legacy_role" != "$runtime_role" && "$legacy_role" != "$migrator_role" ]] || { echo "Tenant já convertido ou em estado parcial." >&2; exit 1; }

declare -a file_specs=(
  "$migrator_config:root:TENANT_MIGRATOR_DATABASE_URL:$migrator_role"
  "/etc/nalven/tenant-manual-workers/${tenant_key}.env:nalven-pos-worker:TENANT_MANUAL_WORKER_DATABASE_URL:$manual_worker_role"
  "/etc/nalven/tenant-manual-callbacks/${tenant_key}.env:nalven-pos-callback:TENANT_MANUAL_CALLBACK_DATABASE_URL:$manual_callback_role"
  "/etc/nalven/tenant-stepup-issuers/${tenant_key}.env:nalven-pos-stepup:TENANT_STEPUP_ISSUER_DATABASE_URL:$stepup_issuer_role"
  "/etc/nalven/tenant-manual-homologators/${tenant_key}.env:nalven-pos-homologator:TENANT_MANUAL_HOMOLOGATOR_DATABASE_URL:$manual_homologator_role"
  "/etc/nalven/tenant-manual-vault-binders/${tenant_key}.env:nalven-pos-vault-binder:TENANT_MANUAL_VAULT_BINDER_DATABASE_URL:$manual_vault_binder_role"
  "/etc/nalven/tenant-manual-profile-admin-issuers/${tenant_key}.env:nalven-pos-profile-admin:TENANT_MANUAL_PROFILE_ADMIN_ISSUER_DATABASE_URL:$profile_admin_role"
  "/etc/nalven/tenant-manual-profile-accounting-issuers/${tenant_key}.env:nalven-pos-profile-accounting:TENANT_MANUAL_PROFILE_ACCOUNTING_ISSUER_DATABASE_URL:$profile_accounting_role"
  "/etc/nalven/tenant-manual-profile-fiscal-issuers/${tenant_key}.env:nalven-pos-profile-fiscal:TENANT_MANUAL_PROFILE_FISCAL_ISSUER_DATABASE_URL:$profile_fiscal_role"
  "/etc/nalven/tenant-manual-sweepers/${tenant_key}.env:nalven-pos-manual-sweeper:TENANT_MANUAL_SWEEPER_DATABASE_URL:$manual_sweeper_role"
)
for spec in "${file_specs[@]}"; do
  path=${spec%%:*}
  [[ ! -e "$path" ]] || { echo "Cutover recusado: credencial parcial já existe em $path." >&2; exit 1; }
done

for role in "$migrator_role" "$runtime_role" "$manual_worker_role" "$manual_callback_role" "$stepup_issuer_role" \
  "$manual_homologator_role" "$manual_vault_binder_role" "$profile_admin_role" "$profile_accounting_role" \
  "$profile_fiscal_role" "$manual_sweeper_role"; do
  if runuser -u postgres -- psql --no-psqlrc -X -At -d postgres -v role="$role" <<'SQL' | grep -q 1
SELECT 1 FROM pg_roles WHERE rolname=:'role';
SQL
  then
    echo "Cutover recusado: role parcial já existe: $role." >&2
    exit 1
  fi
done

runtime_password=$(openssl rand -hex 32)
migrator_password=$(openssl rand -hex 32)
manual_worker_password=$(openssl rand -hex 32)
manual_callback_password=$(openssl rand -hex 32)
stepup_issuer_password=$(openssl rand -hex 32)
manual_homologator_password=$(openssl rand -hex 32)
manual_vault_binder_password=$(openssl rand -hex 32)
profile_admin_password=$(openssl rand -hex 32)
profile_accounting_password=$(openssl rand -hex 32)
profile_fiscal_password=$(openssl rand -hex 32)
manual_sweeper_password=$(openssl rand -hex 32)

runuser -u postgres -- psql --no-psqlrc -X -v ON_ERROR_STOP=1 -d "$database_name" \
  -v legacy_role="$legacy_role" -v database_name="$database_name" \
  -v migrator_role="$migrator_role" -v migrator_password="$migrator_password" \
  -v runtime_role="$runtime_role" -v runtime_password="$runtime_password" \
  -v mw_role="$manual_worker_role" -v mw_password="$manual_worker_password" \
  -v mc_role="$manual_callback_role" -v mc_password="$manual_callback_password" \
  -v si_role="$stepup_issuer_role" -v si_password="$stepup_issuer_password" \
  -v mh_role="$manual_homologator_role" -v mh_password="$manual_homologator_password" \
  -v mb_role="$manual_vault_binder_role" -v mb_password="$manual_vault_binder_password" \
  -v mpi_role="$profile_admin_role" -v mpi_password="$profile_admin_password" \
  -v mpa_role="$profile_accounting_role" -v mpa_password="$profile_accounting_password" \
  -v mpf_role="$profile_fiscal_role" -v mpf_password="$profile_fiscal_password" \
  -v ms_role="$manual_sweeper_role" -v ms_password="$manual_sweeper_password" <<'SQL'
BEGIN;
CREATE ROLE :"migrator_role" LOGIN PASSWORD :'migrator_password' NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS;
CREATE ROLE :"runtime_role" LOGIN PASSWORD :'runtime_password' NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS;
CREATE ROLE :"mw_role" LOGIN PASSWORD :'mw_password' NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS;
CREATE ROLE :"mc_role" LOGIN PASSWORD :'mc_password' NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS;
CREATE ROLE :"si_role" LOGIN PASSWORD :'si_password' NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS;
CREATE ROLE :"mh_role" LOGIN PASSWORD :'mh_password' NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS;
CREATE ROLE :"mb_role" LOGIN PASSWORD :'mb_password' NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS;
CREATE ROLE :"mpi_role" LOGIN PASSWORD :'mpi_password' NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS;
CREATE ROLE :"mpa_role" LOGIN PASSWORD :'mpa_password' NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS;
CREATE ROLE :"mpf_role" LOGIN PASSWORD :'mpf_password' NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS;
CREATE ROLE :"ms_role" LOGIN PASSWORD :'ms_password' NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS;
REASSIGN OWNED BY :"legacy_role" TO :"migrator_role";
ALTER DATABASE :"database_name" OWNER TO :"migrator_role";
ALTER SCHEMA public OWNER TO :"migrator_role";
ALTER ROLE :"ms_role" IN DATABASE :"database_name" SET default_transaction_isolation TO 'serializable';
COMMIT;
SQL

write_credential() {
  local path=$1 group=$2 variable=$3 role=$4 password=$5 partial
  install -d -o root -g "$group" -m 0750 "$(dirname "$path")"
  [[ "$group" == root ]] && chmod 0700 "$(dirname "$path")"
  partial=$(mktemp "$(dirname "$path")/.${tenant_key}.XXXXXX")
  printf '%s=postgresql://%s:%s@127.0.0.1:5432/%s\n' "$variable" "$role" "$password" "$database_name" > "$partial"
  chown root:"$group" "$partial"
  [[ "$group" == root ]] && chmod 0600 "$partial" || chmod 0640 "$partial"
  mv -- "$partial" "$path"
}

runtime_partial=$(mktemp "/etc/nalven/tenants/.${tenant_key}.XXXXXX")
printf 'TENANT_DATABASE_URL=postgresql://%s:%s@127.0.0.1:5432/%s\n' "$runtime_role" "$runtime_password" "$database_name" > "$runtime_partial"
chown root:nalven-app "$runtime_partial"
chmod 0640 "$runtime_partial"

write_credential "$migrator_config" root TENANT_MIGRATOR_DATABASE_URL "$migrator_role" "$migrator_password"
cat >> "$migrator_config" <<EOF
TENANT_DATABASE_NAME=$database_name
TENANT_RUNTIME_ROLE=$runtime_role
TENANT_MIGRATOR_ROLE=$migrator_role
TENANT_MANUAL_WORKER_ROLE=$manual_worker_role
TENANT_MANUAL_CALLBACK_ROLE=$manual_callback_role
TENANT_STEPUP_ISSUER_ROLE=$stepup_issuer_role
TENANT_MANUAL_HOMOLOGATOR_ROLE=$manual_homologator_role
TENANT_MANUAL_VAULT_BINDER_ROLE=$manual_vault_binder_role
TENANT_MANUAL_PROFILE_ADMIN_ISSUER_ROLE=$profile_admin_role
TENANT_MANUAL_PROFILE_ACCOUNTING_ISSUER_ROLE=$profile_accounting_role
TENANT_MANUAL_PROFILE_FISCAL_ISSUER_ROLE=$profile_fiscal_role
TENANT_MANUAL_SWEEPER_ROLE=$manual_sweeper_role
EOF
chmod 0600 "$migrator_config"
write_credential "/etc/nalven/tenant-manual-workers/${tenant_key}.env" nalven-pos-worker TENANT_MANUAL_WORKER_DATABASE_URL "$manual_worker_role" "$manual_worker_password"
write_credential "/etc/nalven/tenant-manual-callbacks/${tenant_key}.env" nalven-pos-callback TENANT_MANUAL_CALLBACK_DATABASE_URL "$manual_callback_role" "$manual_callback_password"
write_credential "/etc/nalven/tenant-stepup-issuers/${tenant_key}.env" nalven-pos-stepup TENANT_STEPUP_ISSUER_DATABASE_URL "$stepup_issuer_role" "$stepup_issuer_password"
write_credential "/etc/nalven/tenant-manual-homologators/${tenant_key}.env" nalven-pos-homologator TENANT_MANUAL_HOMOLOGATOR_DATABASE_URL "$manual_homologator_role" "$manual_homologator_password"
write_credential "/etc/nalven/tenant-manual-vault-binders/${tenant_key}.env" nalven-pos-vault-binder TENANT_MANUAL_VAULT_BINDER_DATABASE_URL "$manual_vault_binder_role" "$manual_vault_binder_password"
write_credential "/etc/nalven/tenant-manual-profile-admin-issuers/${tenant_key}.env" nalven-pos-profile-admin TENANT_MANUAL_PROFILE_ADMIN_ISSUER_DATABASE_URL "$profile_admin_role" "$profile_admin_password"
write_credential "/etc/nalven/tenant-manual-profile-accounting-issuers/${tenant_key}.env" nalven-pos-profile-accounting TENANT_MANUAL_PROFILE_ACCOUNTING_ISSUER_DATABASE_URL "$profile_accounting_role" "$profile_accounting_password"
write_credential "/etc/nalven/tenant-manual-profile-fiscal-issuers/${tenant_key}.env" nalven-pos-profile-fiscal TENANT_MANUAL_PROFILE_FISCAL_ISSUER_DATABASE_URL "$profile_fiscal_role" "$profile_fiscal_password"
write_credential "/etc/nalven/tenant-manual-sweepers/${tenant_key}.env" nalven-pos-manual-sweeper TENANT_MANUAL_SWEEPER_DATABASE_URL "$manual_sweeper_role" "$manual_sweeper_password"
mv -- "$runtime_partial" "$runtime_config"

unset legacy_url runtime_password migrator_password manual_worker_password manual_callback_password stepup_issuer_password
unset manual_homologator_password manual_vault_binder_password profile_admin_password profile_accounting_password profile_fiscal_password manual_sweeper_password
echo "Cutover seguro concluído para $tenant_key."
