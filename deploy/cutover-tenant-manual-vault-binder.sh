#!/usr/bin/env bash
set -euo pipefail

[[ ${EUID:-$(id -u)} -eq 0 ]] || { echo "Execute como root." >&2; exit 1; }
readonly migrator_config=${1:?Informe o arquivo migrator do tenant}
readonly grants_runner=/usr/local/libexec/nalven/reconcile-tenant-runtime-grants.sh
readonly binder_dir=/etc/nalven/tenant-manual-vault-binders

[[ $(readlink -f -- "$0") == /usr/local/libexec/nalven/cutover-tenant-manual-vault-binder.sh ]] || { echo "Cutover recusado fora do artefato instalado." >&2; exit 1; }
[[ $(dirname "$(readlink -f -- "$migrator_config")") == /etc/nalven/tenant-migrators ]] || { echo "Migrator config fora do diretório permitido." >&2; exit 1; }
[[ -f "$migrator_config" && ! -L "$migrator_config" && $(stat -c '%U:%G:%a' "$migrator_config") == root:root:600 ]] || { echo "Migrator config inseguro." >&2; exit 1; }
for artifact in "$grants_runner" /usr/local/libexec/nalven/reconcile-tenant-runtime-grants.sql; do
  mode=$(stat -c '%a' "$artifact" 2>/dev/null || true); mode=${mode:-0000}
  [[ -f "$artifact" && ! -L "$artifact" && $(stat -c '%u:%g' "$artifact") == 0:0 && $((8#$mode & 022)) -eq 0 ]] || { echo "Artefato root-only inseguro: $artifact" >&2; exit 1; }
done

allowed='TENANT_MIGRATOR_DATABASE_URL|TENANT_DATABASE_NAME|TENANT_RUNTIME_ROLE|TENANT_MIGRATOR_ROLE|TENANT_MANUAL_WORKER_ROLE|TENANT_MANUAL_CALLBACK_ROLE|TENANT_STEPUP_ISSUER_ROLE|TENANT_MANUAL_HOMOLOGATOR_ROLE|TENANT_MANUAL_VAULT_BINDER_ROLE|TENANT_MANUAL_PROFILE_ADMIN_ISSUER_ROLE|TENANT_MANUAL_PROFILE_ACCOUNTING_ISSUER_ROLE|TENANT_MANUAL_PROFILE_FISCAL_ISSUER_ROLE|TENANT_MANUAL_SWEEPER_ROLE'
if grep -Ev "^(${allowed})=[^[:space:]]+$" "$migrator_config" | grep -q .; then echo "Migrator config contém chave inesperada ou insegura." >&2; exit 1; fi
line_count=$(wc -l < "$migrator_config")
[[ "$line_count" -eq 8 || "$line_count" -eq 9 || "$line_count" -eq 11 || "$line_count" -eq 12 || "$line_count" -eq 13 ]] || { echo "Migrator config deve estar no formato antigo ou novo exato." >&2; exit 1; }
profile_role_count=$(grep -Ec '^TENANT_MANUAL_PROFILE_(ADMIN|ACCOUNTING|FISCAL)_ISSUER_ROLE=' "$migrator_config" || true)
[[ "$profile_role_count" -eq 0 || "$profile_role_count" -eq 3 ]] || { echo "Migrator config contém authorities de profile parciais." >&2; exit 1; }
for key in TENANT_MIGRATOR_DATABASE_URL TENANT_DATABASE_NAME TENANT_RUNTIME_ROLE TENANT_MIGRATOR_ROLE TENANT_MANUAL_WORKER_ROLE TENANT_MANUAL_CALLBACK_ROLE TENANT_STEPUP_ISSUER_ROLE TENANT_MANUAL_HOMOLOGATOR_ROLE; do
  [[ $(grep -c "^${key}=" "$migrator_config") -eq 1 ]] || { echo "Migrator config incompleto." >&2; exit 1; }
done

database=$(sed -n 's/^TENANT_DATABASE_NAME=//p' "$migrator_config")
migrator=$(sed -n 's/^TENANT_MIGRATOR_ROLE=//p' "$migrator_config")
[[ "$database" =~ ^[a-z][a-z0-9_]{0,59}$ && "$migrator" == "${database}_migrator" ]] || { echo "Banco/migrator fora do padrão." >&2; exit 1; }
binder_role="${database}_mb"
slug=$(basename "$migrator_config" .env); [[ "$slug" =~ ^[a-z0-9-]{1,45}$ ]] || { echo "Chave do tenant inválida." >&2; exit 1; }
readonly lock_dir=/run/lock/nalven
if [[ ! -e "$lock_dir" ]]; then
  (umask 077; mkdir -- "$lock_dir") || [[ -d "$lock_dir" ]]
fi
[[ -d "$lock_dir" && ! -L "$lock_dir" && $(stat -c '%u:%g:%a' "$lock_dir") == 0:0:700 ]] || { echo "Diretório de lock inseguro." >&2; exit 1; }
lock_file="$lock_dir/manual-vault-binder-${slug}-${database}.lock"
if [[ ! -e "$lock_file" ]]; then
  (umask 077; set -o noclobber; : > "$lock_file") 2>/dev/null || true
fi
[[ -f "$lock_file" && ! -L "$lock_file" && $(stat -c '%u:%g:%a' "$lock_file") == 0:0:600 ]] || { echo "Arquivo de lock inseguro." >&2; exit 1; }
exec {cutover_lock_fd}>>"$lock_file"
flock -x "$cutover_lock_fd"
# Mutable cutover state is read only under the tenant/database lock.
[[ -f "$migrator_config" && ! -L "$migrator_config" && $(stat -c '%U:%G:%a' "$migrator_config") == root:root:600 ]] || { echo "Migrator config mudou durante o lock." >&2; exit 1; }
if grep -Ev "^(${allowed})=[^[:space:]]+$" "$migrator_config" | grep -q .; then echo "Migrator config mudou para formato inseguro." >&2; exit 1; fi
line_count=$(wc -l < "$migrator_config")
[[ "$line_count" -eq 8 || "$line_count" -eq 9 || "$line_count" -eq 11 || "$line_count" -eq 12 || "$line_count" -eq 13 ]] || { echo "Migrator config mudou durante o cutover." >&2; exit 1; }
profile_role_count=$(grep -Ec '^TENANT_MANUAL_PROFILE_(ADMIN|ACCOUNTING|FISCAL)_ISSUER_ROLE=' "$migrator_config" || true)
[[ "$profile_role_count" -eq 0 || "$profile_role_count" -eq 3 ]] || { echo "Migrator config mudou para authorities de profile parciais." >&2; exit 1; }
for key in TENANT_MIGRATOR_DATABASE_URL TENANT_DATABASE_NAME TENANT_RUNTIME_ROLE TENANT_MIGRATOR_ROLE TENANT_MANUAL_WORKER_ROLE TENANT_MANUAL_CALLBACK_ROLE TENANT_STEPUP_ISSUER_ROLE TENANT_MANUAL_HOMOLOGATOR_ROLE; do
  [[ $(grep -c "^${key}=" "$migrator_config") -eq 1 ]] || { echo "Migrator config mudou durante o cutover." >&2; exit 1; }
done
[[ $(sed -n 's/^TENANT_DATABASE_NAME=//p' "$migrator_config") == "$database" && $(sed -n 's/^TENANT_MIGRATOR_ROLE=//p' "$migrator_config") == "$migrator" ]] || { echo "Identidade do tenant mudou durante o cutover." >&2; exit 1; }
declared_binder=$(sed -n 's/^TENANT_MANUAL_VAULT_BINDER_ROLE=//p' "$migrator_config")
[[ -z "$declared_binder" || "$declared_binder" == "$binder_role" ]] || { echo "Role binder declarada diverge." >&2; exit 1; }
binder_config="$binder_dir/$slug.env"
install -d -o root -g nalven-pos-vault-binder -m 0750 "$binder_dir"

binder_password=""
if [[ -e "$binder_config" ]]; then
  [[ -f "$binder_config" && ! -L "$binder_config" && $(stat -c '%U:%G:%a' "$binder_config") == root:nalven-pos-vault-binder:640 ]] || { echo "Credencial binder parcial/insegura." >&2; exit 1; }
  [[ $(grep -Ec '^TENANT_MANUAL_VAULT_BINDER_DATABASE_URL=postgresql://[^[:space:]]+$' "$binder_config") -eq 1 && $(wc -l < "$binder_config") -eq 1 ]] || { echo "Credencial binder inválida." >&2; exit 1; }
  binder_url=$(sed -n 's/^TENANT_MANUAL_VAULT_BINDER_DATABASE_URL=//p' "$binder_config")
  [[ "$binder_url" =~ ^postgresql://(${binder_role}):([0-9a-f]{64})@127\.0\.0\.1:5432/(${database})$ ]] || { echo "Credencial binder diverge do tenant." >&2; exit 1; }
  binder_password=${BASH_REMATCH[2]}
else
  binder_password=$(openssl rand -hex 32)
fi

escaped_password=${binder_password//\'/\'\'}
runuser -u postgres -- psql --no-psqlrc -v ON_ERROR_STOP=1 -d postgres <<SQL
DO \$cutover\$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_auth_members m JOIN pg_roles member ON member.oid=m.member JOIN pg_roles parent ON parent.oid=m.roleid WHERE member.rolname='${binder_role}' OR parent.rolname='${binder_role}') THEN
    RAISE EXCEPTION 'manual vault binder role has forbidden memberships';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='${binder_role}') THEN
    ALTER ROLE "${binder_role}" LOGIN PASSWORD '${escaped_password}' NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS;
  ELSE
    CREATE ROLE "${binder_role}" LOGIN PASSWORD '${escaped_password}' NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS;
  END IF;
END \$cutover\$;
GRANT CONNECT ON DATABASE "${database}" TO "${binder_role}";
SQL
identity=$(PGPASSWORD="$binder_password" psql --no-psqlrc --no-password -h 127.0.0.1 -p 5432 -U "$binder_role" -d "$database" -Atc "SELECT current_user || E'\\t' || current_database()")
[[ "$identity" == "$binder_role"$'\t'"$database" ]] || { echo "Binder não autenticou na identidade esperada." >&2; exit 1; }

if [[ ! -e "$binder_config" ]]; then
  partial=$(mktemp "$binder_dir/.${slug}.binder.XXXXXX"); trap 'rm -f -- "${partial:-}" "${migrator_partial:-}"' EXIT
  printf 'TENANT_MANUAL_VAULT_BINDER_DATABASE_URL=postgresql://%s:%s@127.0.0.1:5432/%s\n' "$binder_role" "$binder_password" "$database" > "$partial"
  chown root:nalven-pos-vault-binder "$partial"; chmod 0640 "$partial"; mv -- "$partial" "$binder_config"
fi
if [[ -z "$declared_binder" ]]; then
  migrator_partial=$(mktemp "$(dirname "$migrator_config")/.${slug}.migrator.XXXXXX")
  awk -v role="$binder_role" '{ print } END { print "TENANT_MANUAL_VAULT_BINDER_ROLE=" role }' "$migrator_config" > "$migrator_partial"
  chown root:root "$migrator_partial"; chmod 0600 "$migrator_partial"; mv -- "$migrator_partial" "$migrator_config"
fi
if grep -q '^TENANT_MANUAL_SWEEPER_ROLE=' "$migrator_config"; then
  bash "$grants_runner" "$migrator_config"
fi
trap - EXIT
unset binder_password binder_url escaped_password identity
echo "Cutover da role manual vault binder concluído para $database. Binder permanece desabilitado."
