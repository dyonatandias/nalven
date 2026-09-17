#!/usr/bin/env bash
set -euo pipefail

[[ ${EUID:-$(id -u)} -eq 0 ]] || { echo "Execute como root." >&2; exit 1; }
readonly migrator_config=${1:?Informe o arquivo migrator do tenant}
readonly grants_runner=/usr/local/libexec/nalven/reconcile-tenant-runtime-grants.sh
readonly sweeper_dir=/etc/nalven/tenant-manual-sweepers
readonly lock_dir=/run/lock/nalven

[[ $(readlink -f -- "$0") == /usr/local/libexec/nalven/cutover-tenant-manual-sweeper.sh ]] || {
  echo "Cutover sweeper recusado fora do artefato instalado." >&2
  exit 1
}
[[ $(dirname "$(readlink -f -- "$migrator_config")") == /etc/nalven/tenant-migrators \
    && -f "$migrator_config" && ! -L "$migrator_config" \
    && $(stat -c '%U:%G:%a' "$migrator_config") == root:root:600 ]] || {
  echo "Migrator config fora do diretório permitido ou inseguro." >&2
  exit 1
}
for artifact in "$grants_runner" /usr/local/libexec/nalven/reconcile-tenant-runtime-grants.sql; do
  mode=$(stat -c '%a' "$artifact" 2>/dev/null || true); mode=${mode:-0000}
  [[ -f "$artifact" && ! -L "$artifact" && $(stat -c '%u:%g' "$artifact") == 0:0 \
      && $((8#$mode & 022)) -eq 0 ]] || { echo "Artefato root-only inseguro: $artifact" >&2; exit 1; }
done

allowed='TENANT_MIGRATOR_DATABASE_URL|TENANT_DATABASE_NAME|TENANT_RUNTIME_ROLE|TENANT_MIGRATOR_ROLE|TENANT_MANUAL_WORKER_ROLE|TENANT_MANUAL_CALLBACK_ROLE|TENANT_STEPUP_ISSUER_ROLE|TENANT_MANUAL_HOMOLOGATOR_ROLE|TENANT_MANUAL_VAULT_BINDER_ROLE|TENANT_MANUAL_PROFILE_ADMIN_ISSUER_ROLE|TENANT_MANUAL_PROFILE_ACCOUNTING_ISSUER_ROLE|TENANT_MANUAL_PROFILE_FISCAL_ISSUER_ROLE|TENANT_MANUAL_SWEEPER_ROLE'
validate_migrator_config() {
  if grep -Ev "^(${allowed})=[^[:space:]]+$" "$migrator_config" | grep -q .; then return 1; fi
  local line_count key sweeper_count
  line_count=$(wc -l < "$migrator_config")
  [[ "$line_count" -eq 12 || "$line_count" -eq 13 ]] || return 1
  for key in TENANT_MIGRATOR_DATABASE_URL TENANT_DATABASE_NAME TENANT_RUNTIME_ROLE TENANT_MIGRATOR_ROLE \
    TENANT_MANUAL_WORKER_ROLE TENANT_MANUAL_CALLBACK_ROLE TENANT_STEPUP_ISSUER_ROLE \
    TENANT_MANUAL_HOMOLOGATOR_ROLE TENANT_MANUAL_VAULT_BINDER_ROLE \
    TENANT_MANUAL_PROFILE_ADMIN_ISSUER_ROLE TENANT_MANUAL_PROFILE_ACCOUNTING_ISSUER_ROLE \
    TENANT_MANUAL_PROFILE_FISCAL_ISSUER_ROLE; do
    [[ $(grep -c "^${key}=" "$migrator_config") -eq 1 ]] || return 1
  done
  sweeper_count=$(grep -c '^TENANT_MANUAL_SWEEPER_ROLE=' "$migrator_config" || true)
  [[ ( "$line_count" -eq 12 && "$sweeper_count" -eq 0 ) \
      || ( "$line_count" -eq 13 && "$sweeper_count" -eq 1 ) ]]
}
validate_migrator_config || {
  echo "Migrator config não possui inventário canônico pré ou pós-cutover." >&2
  exit 1
}

database=$(sed -n 's/^TENANT_DATABASE_NAME=//p' "$migrator_config")
migrator_role=$(sed -n 's/^TENANT_MIGRATOR_ROLE=//p' "$migrator_config")
migrator_url=$(sed -n 's/^TENANT_MIGRATOR_DATABASE_URL=//p' "$migrator_config")
slug=$(basename "$migrator_config" .env)
expected_role="${database}_ms"
[[ "$database" =~ ^[a-z][a-z0-9_]{0,62}$ && "$migrator_role" == "${database}_migrator" \
    && "$expected_role" =~ ^[a-z][a-z0-9_]{0,62}$ && "$slug" =~ ^[a-z0-9-]{1,45}$ ]] || {
  echo "Identidade do tenant inválida no migrator config." >&2
  exit 1
}
if [[ ! "$migrator_url" =~ ^postgres(ql)?://([a-z][a-z0-9_]{0,62}):([0-9a-f]{64})@127\.0\.0\.1:5432/([a-z][a-z0-9_]{0,62})$ \
    || ${BASH_REMATCH[2]} != "$migrator_role" || ${BASH_REMATCH[4]} != "$database" ]]; then
  echo "TENANT_MIGRATOR_DATABASE_URL inválida." >&2
  exit 1
fi
install -d -o root -g nalven-pos-manual-sweeper -m 0750 "$sweeper_dir"
install -d -o root -g root -m 0700 "$lock_dir"
lock_file="$lock_dir/manual-sweeper-${slug}-${database}.lock"
if [[ ! -e "$lock_file" ]]; then
  (umask 077; set -o noclobber; : > "$lock_file") 2>/dev/null || true
fi
[[ -d "$lock_dir" && ! -L "$lock_dir" && $(stat -c '%u:%g:%a' "$lock_dir") == 0:0:700 \
    && -f "$lock_file" && ! -L "$lock_file" && $(stat -c '%u:%g:%a' "$lock_file") == 0:0:600 ]] || {
  echo "Arquivo de lock inseguro." >&2
  exit 1
}
exec {cutover_lock_fd}>"$lock_file"
flock -x "$cutover_lock_fd"

validate_migrator_config || { echo "Migrator config mudou durante o cutover." >&2; exit 1; }
[[ $(sed -n 's/^TENANT_DATABASE_NAME=//p' "$migrator_config") == "$database" \
    && $(sed -n 's/^TENANT_MIGRATOR_ROLE=//p' "$migrator_config") == "$migrator_role" ]] || {
  echo "Identidade do tenant mudou durante o cutover." >&2
  exit 1
}

sweeper_config="$sweeper_dir/$slug.env"
declared_role=$(sed -n 's/^TENANT_MANUAL_SWEEPER_ROLE=//p' "$migrator_config")
if [[ -z "$declared_role" ]]; then
  [[ ! -e "$sweeper_config" ]] || { echo "Credencial sweeper órfã preexistente." >&2; exit 1; }
  if runuser -u postgres -- psql --no-psqlrc -Atc "SELECT 1 FROM pg_roles WHERE rolname='$expected_role'" | grep -qx 1; then
    echo "Role sweeper preexistente sem vínculo no inventário; intervenção manual obrigatória." >&2
    exit 1
  fi
  sweeper_password=$(openssl rand -hex 32)
  escaped_sweeper_password=${sweeper_password//\'/\'\'}
  runuser -u postgres -- psql --no-psqlrc -v ON_ERROR_STOP=1 -d postgres <<SQL
CREATE ROLE "$expected_role" LOGIN PASSWORD '$escaped_sweeper_password'
  NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS;
ALTER ROLE "$expected_role" IN DATABASE "$database"
  SET default_transaction_isolation TO 'serializable';
GRANT CONNECT ON DATABASE "$database" TO "$expected_role";
SQL
  sweeper_partial=$(mktemp "$sweeper_dir/.${slug}.sweeper.XXXXXX")
  migrator_partial=$(mktemp "$(dirname "$migrator_config")/.${slug}.sweeper-cutover.XXXXXX")
  trap 'rm -f -- "${sweeper_partial:-}" "${migrator_partial:-}"' EXIT
  trap 'exit 1' HUP INT TERM
  printf 'TENANT_MANUAL_SWEEPER_DATABASE_URL=postgresql://%s:%s@127.0.0.1:5432/%s\n' \
    "$expected_role" "$sweeper_password" "$database" > "$sweeper_partial"
  cp -- "$migrator_config" "$migrator_partial"
  printf 'TENANT_MANUAL_SWEEPER_ROLE=%s\n' "$expected_role" >> "$migrator_partial"
  chown root:nalven-pos-manual-sweeper "$sweeper_partial"
  chmod 0640 "$sweeper_partial"
  chown root:root "$migrator_partial"
  chmod 0600 "$migrator_partial"
  mv -- "$sweeper_partial" "$sweeper_config"
  mv -- "$migrator_partial" "$migrator_config"
  trap - EXIT HUP INT TERM
  unset escaped_sweeper_password sweeper_password
else
  [[ "$declared_role" == "$expected_role" ]] || { echo "Role sweeper declarada diverge do tenant." >&2; exit 1; }
fi

[[ -f "$sweeper_config" && ! -L "$sweeper_config" \
    && $(stat -c '%U:%G:%a' "$sweeper_config") == root:nalven-pos-manual-sweeper:640 \
    && $(wc -l < "$sweeper_config") -eq 1 ]] || { echo "Credencial sweeper ausente ou insegura." >&2; exit 1; }
sweeper_url=$(sed -n 's/^TENANT_MANUAL_SWEEPER_DATABASE_URL=//p' "$sweeper_config")
if [[ ! "$sweeper_url" =~ ^postgres(ql)?://([a-z][a-z0-9_]{0,62}):([0-9a-f]{64})@127\.0\.0\.1:5432/([a-z][a-z0-9_]{0,62})$ \
    || ${BASH_REMATCH[2]} != "$expected_role" || ${BASH_REMATCH[4]} != "$database" ]]; then
  echo "TENANT_MANUAL_SWEEPER_DATABASE_URL diverge do tenant." >&2
  exit 1
fi
sweeper_password=${BASH_REMATCH[3]}
role_shape=$(runuser -u postgres -- psql --no-psqlrc -Atc "SELECT concat_ws(':',rolcanlogin,NOT rolinherit,NOT rolsuper,NOT rolcreatedb,NOT rolcreaterole,NOT rolreplication,NOT rolbypassrls) FROM pg_roles WHERE rolname='$expected_role'")
[[ "$role_shape" == t:t:t:t:t:t:t ]] || { echo "Role sweeper ausente ou com atributos inseguros." >&2; exit 1; }
runuser -u postgres -- psql --no-psqlrc -v ON_ERROR_STOP=1 \
  -c "ALTER ROLE \"$expected_role\" IN DATABASE \"$database\" SET default_transaction_isolation TO 'serializable';" \
  -c "GRANT CONNECT ON DATABASE \"$database\" TO \"$expected_role\";"

pgpass_file=$(mktemp /run/nalven-manual-sweeper-pgpass.XXXXXX)
trap 'rm -f -- "${pgpass_file:-}"; unset sweeper_password sweeper_url migrator_url' EXIT
trap 'exit 1' HUP INT TERM
chmod 0600 "$pgpass_file"
printf '127.0.0.1:5432:%s:%s:%s\n' "$database" "$expected_role" "$sweeper_password" > "$pgpass_file"
identity=$(PGPASSFILE="$pgpass_file" PGHOST=127.0.0.1 PGPORT=5432 PGUSER="$expected_role" PGDATABASE="$database" \
  PGOPTIONS='-c default_transaction_isolation=serializable -c application_name=nalven-pos-manual-sweep-v1' \
  psql --no-psqlrc --no-password -Atc "SELECT current_user || E'\\t' || current_database() || E'\\t' || current_setting('transaction_isolation')")
[[ "$identity" == "$expected_role"$'\t'"$database"$'\t'serializable ]] || { echo "Credencial sweeper não autentica com isolamento SERIALIZABLE." >&2; exit 1; }
rm -f -- "$pgpass_file"
pgpass_file=""

bash "$grants_runner" "$migrator_config"
echo "Cutover da role manual_sweeper concluído para $database; gate manual permanece hard-off."
