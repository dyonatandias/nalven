#!/usr/bin/env bash
set -euo pipefail

[[ ${EUID:-$(id -u)} -eq 0 ]] || { echo "Execute como root." >&2; exit 1; }

readonly migrator_config=${1:?Informe o arquivo root-only do migrator}
readonly script_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)
readonly grants_sql=/usr/local/libexec/nalven/reconcile-tenant-runtime-grants.sql

[[ "$script_dir" == /usr/local/libexec/nalven && $(readlink -f -- "${BASH_SOURCE[0]}") == /usr/local/libexec/nalven/reconcile-tenant-runtime-grants.sh ]] || {
  echo "Reconciliação recusada fora do artefato root-owned instalado." >&2
  exit 1
}

[[ -f "$migrator_config" ]] || { echo "Credencial de migração ausente: $migrator_config" >&2; exit 1; }
[[ -f "$grants_sql" ]] || { echo "Matriz de grants ausente: $grants_sql" >&2; exit 1; }
for trusted_artifact in "${BASH_SOURCE[0]}" "$grants_sql"; do
  artifact_mode=$(stat -c '%a' "$trusted_artifact" 2>/dev/null || true)
  artifact_mode=${artifact_mode:-0000}
  [[ -f "$trusted_artifact" && ! -L "$trusted_artifact" && $(stat -c '%u:%g' "$trusted_artifact") == 0:0 \
      && "$artifact_mode" =~ ^[0-7]{3,4}$ && $((8#$artifact_mode & 022)) -eq 0 ]] || {
    echo "Artefato de reconciliação não regular, sem ownership root ou gravável fora de root: $trusted_artifact" >&2
    exit 1
  }
done

config_owner=$(stat -c '%u' "$migrator_config")
config_mode=$(stat -c '%a' "$migrator_config")
if [[ "$config_owner" != 0 || "$config_mode" != 600 ]]; then
  echo "A credencial de migração deve pertencer a root e usar modo 0600: $migrator_config" >&2
  exit 1
fi

# O arquivo root-only é tratado como dados, nunca executado como shell.
if grep -Ev '^(TENANT_MIGRATOR_DATABASE_URL|TENANT_DATABASE_NAME|TENANT_RUNTIME_ROLE|TENANT_MIGRATOR_ROLE|TENANT_MANUAL_WORKER_ROLE|TENANT_MANUAL_CALLBACK_ROLE|TENANT_STEPUP_ISSUER_ROLE|TENANT_MANUAL_HOMOLOGATOR_ROLE|TENANT_MANUAL_VAULT_BINDER_ROLE|TENANT_MANUAL_PROFILE_ADMIN_ISSUER_ROLE|TENANT_MANUAL_PROFILE_ACCOUNTING_ISSUER_ROLE|TENANT_MANUAL_PROFILE_FISCAL_ISSUER_ROLE|TENANT_MANUAL_SWEEPER_ROLE)=[^[:space:]]+$' "$migrator_config" | grep -q . \
   || [[ $(grep -Ec '^(TENANT_MIGRATOR_DATABASE_URL|TENANT_DATABASE_NAME|TENANT_RUNTIME_ROLE|TENANT_MIGRATOR_ROLE|TENANT_MANUAL_WORKER_ROLE|TENANT_MANUAL_CALLBACK_ROLE|TENANT_STEPUP_ISSUER_ROLE|TENANT_MANUAL_HOMOLOGATOR_ROLE|TENANT_MANUAL_VAULT_BINDER_ROLE|TENANT_MANUAL_PROFILE_ADMIN_ISSUER_ROLE|TENANT_MANUAL_PROFILE_ACCOUNTING_ISSUER_ROLE|TENANT_MANUAL_PROFILE_FISCAL_ISSUER_ROLE|TENANT_MANUAL_SWEEPER_ROLE)=' "$migrator_config") -ne 13 ]]; then
  echo "Arquivo migrator contém chave duplicada, inesperada ou valor inseguro." >&2
  exit 1
fi
TENANT_MIGRATOR_DATABASE_URL=$(sed -n 's/^TENANT_MIGRATOR_DATABASE_URL=//p' "$migrator_config")
TENANT_DATABASE_NAME=$(sed -n 's/^TENANT_DATABASE_NAME=//p' "$migrator_config")
TENANT_RUNTIME_ROLE=$(sed -n 's/^TENANT_RUNTIME_ROLE=//p' "$migrator_config")
TENANT_MIGRATOR_ROLE=$(sed -n 's/^TENANT_MIGRATOR_ROLE=//p' "$migrator_config")
TENANT_MANUAL_WORKER_ROLE=$(sed -n 's/^TENANT_MANUAL_WORKER_ROLE=//p' "$migrator_config")
TENANT_MANUAL_CALLBACK_ROLE=$(sed -n 's/^TENANT_MANUAL_CALLBACK_ROLE=//p' "$migrator_config")
TENANT_STEPUP_ISSUER_ROLE=$(sed -n 's/^TENANT_STEPUP_ISSUER_ROLE=//p' "$migrator_config")
TENANT_MANUAL_HOMOLOGATOR_ROLE=$(sed -n 's/^TENANT_MANUAL_HOMOLOGATOR_ROLE=//p' "$migrator_config")
TENANT_MANUAL_VAULT_BINDER_ROLE=$(sed -n 's/^TENANT_MANUAL_VAULT_BINDER_ROLE=//p' "$migrator_config")
TENANT_MANUAL_PROFILE_ADMIN_ISSUER_ROLE=$(sed -n 's/^TENANT_MANUAL_PROFILE_ADMIN_ISSUER_ROLE=//p' "$migrator_config")
TENANT_MANUAL_PROFILE_ACCOUNTING_ISSUER_ROLE=$(sed -n 's/^TENANT_MANUAL_PROFILE_ACCOUNTING_ISSUER_ROLE=//p' "$migrator_config")
TENANT_MANUAL_PROFILE_FISCAL_ISSUER_ROLE=$(sed -n 's/^TENANT_MANUAL_PROFILE_FISCAL_ISSUER_ROLE=//p' "$migrator_config")
TENANT_MANUAL_SWEEPER_ROLE=$(sed -n 's/^TENANT_MANUAL_SWEEPER_ROLE=//p' "$migrator_config")

[[ ${TENANT_DATABASE_NAME:-} =~ ^[a-z][a-z0-9_]{0,62}$ ]] || { echo "TENANT_DATABASE_NAME inválido." >&2; exit 1; }
[[ ${TENANT_RUNTIME_ROLE:-} =~ ^[a-z][a-z0-9_]{0,62}$ ]] || { echo "TENANT_RUNTIME_ROLE inválido." >&2; exit 1; }
[[ ${TENANT_MIGRATOR_ROLE:-} =~ ^[a-z][a-z0-9_]{0,62}$ ]] || { echo "TENANT_MIGRATOR_ROLE inválido." >&2; exit 1; }
[[ ${TENANT_MANUAL_WORKER_ROLE:-} =~ ^[a-z][a-z0-9_]{0,62}$ ]] || { echo "TENANT_MANUAL_WORKER_ROLE inválido." >&2; exit 1; }
[[ ${TENANT_MANUAL_CALLBACK_ROLE:-} =~ ^[a-z][a-z0-9_]{0,62}$ ]] || { echo "TENANT_MANUAL_CALLBACK_ROLE inválido." >&2; exit 1; }
[[ ${TENANT_STEPUP_ISSUER_ROLE:-} =~ ^[a-z][a-z0-9_]{0,62}$ ]] || { echo "TENANT_STEPUP_ISSUER_ROLE inválido." >&2; exit 1; }
[[ ${TENANT_MANUAL_HOMOLOGATOR_ROLE:-} =~ ^[a-z][a-z0-9_]{0,62}$ ]] || { echo "TENANT_MANUAL_HOMOLOGATOR_ROLE inválido." >&2; exit 1; }
[[ ${TENANT_MANUAL_VAULT_BINDER_ROLE:-} =~ ^[a-z][a-z0-9_]{0,62}$ ]] || { echo "TENANT_MANUAL_VAULT_BINDER_ROLE inválido." >&2; exit 1; }
[[ ${TENANT_MANUAL_PROFILE_ADMIN_ISSUER_ROLE:-} =~ ^[a-z][a-z0-9_]{0,62}$ ]] || { echo "TENANT_MANUAL_PROFILE_ADMIN_ISSUER_ROLE inválido." >&2; exit 1; }
[[ ${TENANT_MANUAL_PROFILE_ACCOUNTING_ISSUER_ROLE:-} =~ ^[a-z][a-z0-9_]{0,62}$ ]] || { echo "TENANT_MANUAL_PROFILE_ACCOUNTING_ISSUER_ROLE inválido." >&2; exit 1; }
[[ ${TENANT_MANUAL_PROFILE_FISCAL_ISSUER_ROLE:-} =~ ^[a-z][a-z0-9_]{0,62}$ ]] || { echo "TENANT_MANUAL_PROFILE_FISCAL_ISSUER_ROLE inválido." >&2; exit 1; }
[[ ${TENANT_MANUAL_SWEEPER_ROLE:-} =~ ^[a-z][a-z0-9_]{0,62}$ ]] || { echo "TENANT_MANUAL_SWEEPER_ROLE inválido." >&2; exit 1; }
if [[ ! ${TENANT_MIGRATOR_DATABASE_URL:-} =~ ^postgres(ql)?://([a-z][a-z0-9_]{0,62}):([0-9a-f]{64})@127\.0\.0\.1:5432/([a-z][a-z0-9_]{0,62})$ ]]; then
  echo "TENANT_MIGRATOR_DATABASE_URL deve usar a role esperada, senha hexadecimal e PostgreSQL local." >&2
  exit 1
fi
url_role=${BASH_REMATCH[2]}
url_password=${BASH_REMATCH[3]}
url_database=${BASH_REMATCH[4]}
[[ "$url_role" == "$TENANT_MIGRATOR_ROLE" && "$url_database" == "$TENANT_DATABASE_NAME" ]] || {
  echo "TENANT_MIGRATOR_DATABASE_URL diverge da role ou banco declarados." >&2
  exit 1
}

pgpass_file=$(mktemp /run/nalven-migrator-pgpass.XXXXXX)
cleanup() {
  rm -f -- "$pgpass_file"
  unset PGPASSFILE PGHOST PGPORT PGUSER PGDATABASE TENANT_MIGRATOR_DATABASE_URL url_password
}
trap cleanup EXIT
trap 'exit 1' HUP INT TERM
printf '127.0.0.1:5432:%s:%s:%s\n' "$url_database" "$url_role" "$url_password" > "$pgpass_file"
chmod 0600 "$pgpass_file"
export PGPASSFILE="$pgpass_file" PGHOST=127.0.0.1 PGPORT=5432
export PGUSER="$url_role" PGDATABASE="$url_database"
psql --no-psqlrc --no-password -v ON_ERROR_STOP=1 \
  -v database_name="$TENANT_DATABASE_NAME" \
  -v runtime_role="$TENANT_RUNTIME_ROLE" \
  -v migrator_role="$TENANT_MIGRATOR_ROLE" \
  -v manual_worker_role="$TENANT_MANUAL_WORKER_ROLE" \
  -v manual_callback_role="$TENANT_MANUAL_CALLBACK_ROLE" \
  -v stepup_issuer_role="$TENANT_STEPUP_ISSUER_ROLE" \
  -v manual_homologator_role="$TENANT_MANUAL_HOMOLOGATOR_ROLE" \
  -v manual_vault_binder_role="$TENANT_MANUAL_VAULT_BINDER_ROLE" \
  -v manual_profile_admin_issuer_role="$TENANT_MANUAL_PROFILE_ADMIN_ISSUER_ROLE" \
  -v manual_profile_accounting_issuer_role="$TENANT_MANUAL_PROFILE_ACCOUNTING_ISSUER_ROLE" \
  -v manual_profile_fiscal_issuer_role="$TENANT_MANUAL_PROFILE_FISCAL_ISSUER_ROLE" \
  -v manual_sweeper_role="$TENANT_MANUAL_SWEEPER_ROLE" \
  -f "$grants_sql"
