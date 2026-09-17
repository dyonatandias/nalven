#!/usr/bin/env bash
set -euo pipefail

[[ ${EUID:-$(id -u)} -eq 0 ]] || { echo "Execute como root." >&2; exit 1; }
readonly migrator_config=${1:?Informe o arquivo migrator do tenant}
readonly grants_runner=/usr/local/libexec/nalven/reconcile-tenant-runtime-grants.sh
readonly admin_dir=/etc/nalven/tenant-manual-profile-admin-issuers
readonly accounting_dir=/etc/nalven/tenant-manual-profile-accounting-issuers
readonly fiscal_dir=/etc/nalven/tenant-manual-profile-fiscal-issuers

[[ $(readlink -f -- "$0") == /usr/local/libexec/nalven/cutover-tenant-manual-profile-issuers.sh ]] || { echo "Cutover recusado fora do artefato instalado." >&2; exit 1; }
[[ $(dirname "$(readlink -f -- "$migrator_config")") == /etc/nalven/tenant-migrators ]] || { echo "Migrator config fora do diretório permitido." >&2; exit 1; }
[[ -f "$migrator_config" && ! -L "$migrator_config" && $(stat -c '%U:%G:%a' "$migrator_config") == root:root:600 ]] || { echo "Migrator config inseguro." >&2; exit 1; }
for artifact in "$grants_runner" /usr/local/libexec/nalven/reconcile-tenant-runtime-grants.sql; do
  mode=$(stat -c '%a' "$artifact" 2>/dev/null || true); mode=${mode:-0000}
  [[ -f "$artifact" && ! -L "$artifact" && $(stat -c '%u:%g' "$artifact") == 0:0 && $((8#$mode & 022)) -eq 0 ]] || { echo "Artefato root-only inseguro: $artifact" >&2; exit 1; }
done

allowed='TENANT_MIGRATOR_DATABASE_URL|TENANT_DATABASE_NAME|TENANT_RUNTIME_ROLE|TENANT_MIGRATOR_ROLE|TENANT_MANUAL_WORKER_ROLE|TENANT_MANUAL_CALLBACK_ROLE|TENANT_STEPUP_ISSUER_ROLE|TENANT_MANUAL_HOMOLOGATOR_ROLE|TENANT_MANUAL_VAULT_BINDER_ROLE|TENANT_MANUAL_PROFILE_ADMIN_ISSUER_ROLE|TENANT_MANUAL_PROFILE_ACCOUNTING_ISSUER_ROLE|TENANT_MANUAL_PROFILE_FISCAL_ISSUER_ROLE|TENANT_MANUAL_SWEEPER_ROLE'
validate_migrator_config() {
  grep -Ev "^(${allowed})=[^[:space:]]+$" "$migrator_config" | grep -q . && return 1
  local line_count declared_count key
  line_count=$(wc -l < "$migrator_config")
  [[ "$line_count" -eq 9 || "$line_count" -eq 12 || "$line_count" -eq 13 ]] || return 1
  for key in TENANT_MIGRATOR_DATABASE_URL TENANT_DATABASE_NAME TENANT_RUNTIME_ROLE TENANT_MIGRATOR_ROLE TENANT_MANUAL_WORKER_ROLE TENANT_MANUAL_CALLBACK_ROLE TENANT_STEPUP_ISSUER_ROLE TENANT_MANUAL_HOMOLOGATOR_ROLE TENANT_MANUAL_VAULT_BINDER_ROLE; do
    [[ $(grep -c "^${key}=" "$migrator_config") -eq 1 ]] || return 1
  done
  declared_count=$(grep -Ec '^TENANT_MANUAL_PROFILE_(ADMIN|ACCOUNTING|FISCAL)_ISSUER_ROLE=' "$migrator_config" || true)
  [[ "$declared_count" -eq 0 || "$declared_count" -eq 3 ]] || return 1
}
validate_migrator_config || { echo "Migrator config deve estar no formato pré ou pós-cutover exato." >&2; exit 1; }

database=$(sed -n 's/^TENANT_DATABASE_NAME=//p' "$migrator_config")
migrator=$(sed -n 's/^TENANT_MIGRATOR_ROLE=//p' "$migrator_config")
[[ "$database" =~ ^[a-z][a-z0-9_]{0,59}$ && "$migrator" == "${database}_migrator" ]] || { echo "Banco/migrator fora do padrão." >&2; exit 1; }
slug=$(basename "$migrator_config" .env); [[ "$slug" =~ ^[a-z0-9-]{1,45}$ ]] || { echo "Chave do tenant inválida." >&2; exit 1; }

readonly lock_dir=/run/lock/nalven
if [[ ! -e "$lock_dir" ]]; then (umask 077; mkdir -- "$lock_dir") || [[ -d "$lock_dir" ]]; fi
[[ -d "$lock_dir" && ! -L "$lock_dir" && $(stat -c '%u:%g:%a' "$lock_dir") == 0:0:700 ]] || { echo "Diretório de lock inseguro." >&2; exit 1; }
lock_file="$lock_dir/manual-profile-issuers-${slug}-${database}.lock"
if [[ ! -e "$lock_file" ]]; then (umask 077; set -o noclobber; : > "$lock_file") 2>/dev/null || true; fi
[[ -f "$lock_file" && ! -L "$lock_file" && $(stat -c '%u:%g:%a' "$lock_file") == 0:0:600 ]] || { echo "Arquivo de lock inseguro." >&2; exit 1; }
exec {cutover_lock_fd}>>"$lock_file"
flock -x "$cutover_lock_fd"
partial=""
migrator_partial=""
cleanup() { rm -f -- "${partial:-}" "${migrator_partial:-}"; }
trap cleanup EXIT
trap 'exit 1' HUP INT TERM

[[ -f "$migrator_config" && ! -L "$migrator_config" && $(stat -c '%U:%G:%a' "$migrator_config") == root:root:600 ]] || { echo "Migrator config mudou durante o lock." >&2; exit 1; }
validate_migrator_config || { echo "Migrator config mudou durante o cutover." >&2; exit 1; }
[[ $(sed -n 's/^TENANT_DATABASE_NAME=//p' "$migrator_config") == "$database" && $(sed -n 's/^TENANT_MIGRATOR_ROLE=//p' "$migrator_config") == "$migrator" ]] || { echo "Identidade do tenant mudou durante o cutover." >&2; exit 1; }

roles=("${database}_mpi" "${database}_mpa" "${database}_mpf")
dirs=("$admin_dir" "$accounting_dir" "$fiscal_dir")
groups=(nalven-pos-profile-admin nalven-pos-profile-accounting nalven-pos-profile-fiscal)
role_variables=(TENANT_MANUAL_PROFILE_ADMIN_ISSUER_ROLE TENANT_MANUAL_PROFILE_ACCOUNTING_ISSUER_ROLE TENANT_MANUAL_PROFILE_FISCAL_ISSUER_ROLE)
url_variables=(TENANT_MANUAL_PROFILE_ADMIN_ISSUER_DATABASE_URL TENANT_MANUAL_PROFILE_ACCOUNTING_ISSUER_DATABASE_URL TENANT_MANUAL_PROFILE_FISCAL_ISSUER_DATABASE_URL)
passwords=()
for index in 0 1 2; do
  declared=$(sed -n "s/^${role_variables[$index]}=//p" "$migrator_config")
  [[ -z "$declared" || "$declared" == "${roles[$index]}" ]] || { echo "Role profile issuer declarada diverge." >&2; exit 1; }
  install -d -o root -g "${groups[$index]}" -m 0750 "${dirs[$index]}"
  config="${dirs[$index]}/$slug.env"
  if [[ -e "$config" ]]; then
    [[ -f "$config" && ! -L "$config" && $(stat -c '%U:%G:%a' "$config") == "root:${groups[$index]}:640" ]] || { echo "Credencial profile issuer parcial/insegura: $config" >&2; exit 1; }
    [[ $(grep -Ec "^${url_variables[$index]}=postgresql://[^[:space:]]+$" "$config") -eq 1 && $(wc -l < "$config") -eq 1 ]] || { echo "Credencial profile issuer inválida: $config" >&2; exit 1; }
    issuer_url=$(sed -n "s/^${url_variables[$index]}=//p" "$config")
    [[ "$issuer_url" =~ ^postgresql://([a-z][a-z0-9_]{0,62}):([0-9a-f]{64})@127\.0\.0\.1:5432/([a-z][a-z0-9_]{0,62})$ ]] || { echo "Credencial profile issuer fora do formato." >&2; exit 1; }
    [[ ${BASH_REMATCH[1]} == "${roles[$index]}" && ${BASH_REMATCH[3]} == "$database" ]] || { echo "Credencial profile issuer diverge do tenant." >&2; exit 1; }
    passwords[$index]=${BASH_REMATCH[2]}
  else
    passwords[$index]=$(openssl rand -hex 32)
  fi
done

for index in 0 1 2; do
  role=${roles[$index]}; password=${passwords[$index]}; escaped_password=${password//\'/\'\'}
  runuser -u postgres -- psql --no-psqlrc -v ON_ERROR_STOP=1 -d postgres <<SQL
DO \$cutover\$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_auth_members m JOIN pg_roles member ON member.oid=m.member JOIN pg_roles parent ON parent.oid=m.roleid WHERE member.rolname='${role}' OR parent.rolname='${role}') THEN
    RAISE EXCEPTION 'manual profile issuer role has forbidden memberships';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='${role}') THEN
    ALTER ROLE "${role}" LOGIN PASSWORD '${escaped_password}' NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS;
  ELSE
    CREATE ROLE "${role}" LOGIN PASSWORD '${escaped_password}' NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS;
  END IF;
END \$cutover\$;
GRANT CONNECT ON DATABASE "${database}" TO "${role}";
SQL
  identity=$(PGPASSWORD="$password" psql --no-psqlrc --no-password -h 127.0.0.1 -p 5432 -U "$role" -d "$database" -Atc "SELECT current_user || E'\t' || current_database()")
  [[ "$identity" == "$role"$'\t'"$database" ]] || { echo "Profile issuer não autenticou na identidade esperada." >&2; exit 1; }
done

for index in 0 1 2; do
  config="${dirs[$index]}/$slug.env"
  if [[ ! -e "$config" ]]; then
    partial=$(mktemp "${dirs[$index]}/.${slug}.issuer.XXXXXX")
    printf '%s=postgresql://%s:%s@127.0.0.1:5432/%s\n' "${url_variables[$index]}" "${roles[$index]}" "${passwords[$index]}" "$database" > "$partial"
    chown "root:${groups[$index]}" "$partial"; chmod 0640 "$partial"; mv -- "$partial" "$config"
  fi
done

if [[ $(grep -Ec '^TENANT_MANUAL_PROFILE_(ADMIN|ACCOUNTING|FISCAL)_ISSUER_ROLE=' "$migrator_config" || true) -eq 0 ]]; then
  migrator_partial=$(mktemp "$(dirname "$migrator_config")/.${slug}.migrator.XXXXXX")
  awk -v admin="${roles[0]}" -v accounting="${roles[1]}" -v fiscal="${roles[2]}" \
    '{ print } END { print "TENANT_MANUAL_PROFILE_ADMIN_ISSUER_ROLE=" admin; print "TENANT_MANUAL_PROFILE_ACCOUNTING_ISSUER_ROLE=" accounting; print "TENANT_MANUAL_PROFILE_FISCAL_ISSUER_ROLE=" fiscal }' \
    "$migrator_config" > "$migrator_partial"
  chown root:root "$migrator_partial"; chmod 0600 "$migrator_partial"; mv -- "$migrator_partial" "$migrator_config"
fi
if grep -q '^TENANT_MANUAL_SWEEPER_ROLE=' "$migrator_config"; then
  bash "$grants_runner" "$migrator_config"
fi
trap - EXIT HUP INT TERM
unset passwords password escaped_password issuer_url identity
echo "Cutover das roles de profile issuer concluído para $database. ACLs nominais reconciliadas; gate manual permanece hard-off."
