#!/usr/bin/env bash
set -euo pipefail

[[ ${EUID:-$(id -u)} -eq 0 ]] || { echo "Execute como root." >&2; exit 1; }
organization_id=${1:?Informe o ID da organização}
slug=${2:?Informe o slug da organização}
[[ "$organization_id" =~ ^[a-z0-9-]+$ ]] || { echo "ID inválido." >&2; exit 1; }
[[ "$slug" =~ ^[a-z0-9-]{1,45}$ ]] || { echo "Slug inválido ou longo demais (máximo: 45)." >&2; exit 1; }

readonly migration_runner=/usr/local/libexec/nalven/run-tenant-migration-bundle.sh
readonly db_suffix=${slug//-/_}
readonly database_name="nalven_t_${db_suffix}"
readonly runtime_role="nalven_t_${db_suffix}_runtime"
readonly migrator_role="nalven_t_${db_suffix}_migrator"
readonly manual_worker_role="${database_name}_mw"
readonly manual_callback_role="${database_name}_mc"
readonly stepup_issuer_role="${database_name}_si"
readonly manual_homologator_role="${database_name}_mh"
readonly manual_vault_binder_role="${database_name}_mb"
readonly manual_profile_admin_issuer_role="${database_name}_mpi"
readonly manual_profile_accounting_issuer_role="${database_name}_mpa"
readonly manual_profile_fiscal_issuer_role="${database_name}_mpf"
readonly manual_sweeper_role="${database_name}_ms"
readonly runtime_config_dir=/etc/nalven/tenants
readonly migrator_config_dir=/etc/nalven/tenant-migrators
readonly manual_worker_config_dir=/etc/nalven/tenant-manual-workers
readonly manual_callback_config_dir=/etc/nalven/tenant-manual-callbacks
readonly stepup_issuer_config_dir=/etc/nalven/tenant-stepup-issuers
readonly manual_homologator_config_dir=/etc/nalven/tenant-manual-homologators
readonly manual_vault_binder_config_dir=/etc/nalven/tenant-manual-vault-binders
readonly manual_profile_admin_issuer_config_dir=/etc/nalven/tenant-manual-profile-admin-issuers
readonly manual_profile_accounting_issuer_config_dir=/etc/nalven/tenant-manual-profile-accounting-issuers
readonly manual_profile_fiscal_issuer_config_dir=/etc/nalven/tenant-manual-profile-fiscal-issuers
readonly manual_sweeper_config_dir=/etc/nalven/tenant-manual-sweepers
readonly runtime_config="$runtime_config_dir/$slug.env"
readonly migrator_config="$migrator_config_dir/$slug.env"
readonly manual_worker_config="$manual_worker_config_dir/$slug.env"
readonly manual_callback_config="$manual_callback_config_dir/$slug.env"
readonly stepup_issuer_config="$stepup_issuer_config_dir/$slug.env"
readonly manual_homologator_config="$manual_homologator_config_dir/$slug.env"
readonly manual_vault_binder_config="$manual_vault_binder_config_dir/$slug.env"
readonly manual_profile_admin_issuer_config="$manual_profile_admin_issuer_config_dir/$slug.env"
readonly manual_profile_accounting_issuer_config="$manual_profile_accounting_issuer_config_dir/$slug.env"
readonly manual_profile_fiscal_issuer_config="$manual_profile_fiscal_issuer_config_dir/$slug.env"
readonly manual_sweeper_config="$manual_sweeper_config_dir/$slug.env"
readonly grants_script=/usr/local/libexec/nalven/reconcile-tenant-runtime-grants.sh

[[ $(readlink -f -- "$0") == /usr/local/libexec/nalven/provision-tenant.sh ]] || {
  echo "Provisionamento recusado fora do artefato root-owned instalado." >&2
  exit 1
}
for trusted_artifact in "$grants_script" /usr/local/libexec/nalven/reconcile-tenant-runtime-grants.sql "$migration_runner"; do
  artifact_mode=$(stat -c '%a' "$trusted_artifact" 2>/dev/null || true)
  artifact_mode=${artifact_mode:-0000}
  [[ -f "$trusted_artifact" && ! -L "$trusted_artifact" && $(stat -c '%u:%g' "$trusted_artifact") == 0:0 \
      && "$artifact_mode" =~ ^[0-7]{3,4}$ && $((8#$artifact_mode & 022)) -eq 0 ]] || {
    echo "Artefato de grants ausente, não regular ou gravável fora de root: $trusted_artifact" >&2
    exit 1
  }
done

for required_authority_group in nalven-pos-worker nalven-pos-callback nalven-pos-stepup nalven-pos-homologator nalven-pos-vault-binder nalven-pos-profile-admin nalven-pos-profile-accounting nalven-pos-profile-fiscal nalven-pos-manual-sweeper; do
  if ! getent group "$required_authority_group" >/dev/null || ! id "$required_authority_group" >/dev/null 2>&1; then
    echo "Grupo de autoridade manual ausente: $required_authority_group. Execute primeiro o bootstrap seguro do host." >&2
    exit 1
  fi
  authority_uid=$(id -u "$required_authority_group")
  authority_gid=$(id -g "$required_authority_group")
  authority_explicit_members=$(getent group "$required_authority_group" | cut -d: -f4)
  if (( authority_uid == 0 || authority_uid >= 1000 || authority_gid == 0 || authority_gid >= 1000 )) \
      || [[ $(id -gn "$required_authority_group") != "$required_authority_group" \
        || $(id -Gn "$required_authority_group") != "$required_authority_group" \
        || -n "$authority_explicit_members" \
        || $(getent passwd "$required_authority_group" | cut -d: -f7) != /usr/sbin/nologin ]]; then
    echo "Principal Unix de autoridade manual inseguro ou com memberships cruzados: $required_authority_group." >&2
    exit 1
  fi
done

install -d -o root -g nalven-app -m 0750 "$runtime_config_dir"
install -d -o root -g root -m 0700 "$migrator_config_dir"
install -d -o root -g nalven-pos-worker -m 0750 "$manual_worker_config_dir"
install -d -o root -g nalven-pos-callback -m 0750 "$manual_callback_config_dir"
install -d -o root -g nalven-pos-stepup -m 0750 "$stepup_issuer_config_dir"
install -d -o root -g nalven-pos-homologator -m 0750 "$manual_homologator_config_dir"
install -d -o root -g nalven-pos-vault-binder -m 0750 "$manual_vault_binder_config_dir"
install -d -o root -g nalven-pos-profile-admin -m 0750 "$manual_profile_admin_issuer_config_dir"
install -d -o root -g nalven-pos-profile-accounting -m 0750 "$manual_profile_accounting_issuer_config_dir"
install -d -o root -g nalven-pos-profile-fiscal -m 0750 "$manual_profile_fiscal_issuer_config_dir"
install -d -o root -g nalven-pos-manual-sweeper -m 0750 "$manual_sweeper_config_dir"

exec 8>/run/lock/nalven-production-maintenance.lock
flock -s 8
exec 9>"/run/lock/nalven-provision-${slug}.lock"
flock 9

authority_configs=(
  "$runtime_config"
  "$migrator_config"
  "$manual_worker_config"
  "$manual_callback_config"
  "$stepup_issuer_config"
  "$manual_homologator_config"
  "$manual_vault_binder_config"
  "$manual_profile_admin_issuer_config"
  "$manual_profile_accounting_issuer_config"
  "$manual_profile_fiscal_issuer_config"
  "$manual_sweeper_config"
)
present_authority_configs=0
for authority_config in "${authority_configs[@]}"; do
  [[ -e "$authority_config" ]] && present_authority_configs=$((present_authority_configs + 1))
done
if (( present_authority_configs > 0 && present_authority_configs < ${#authority_configs[@]} )); then
  echo "Tenant com credenciais de autoridade parciais: $slug. Faça o cutover manual; fallback ou compartilhamento de principal é proibido." >&2
  exit 1
fi

if [[ ! -e "$runtime_config" ]]; then
  if runuser -u postgres -- psql -tAc "SELECT 1 FROM pg_roles WHERE rolname IN ('$runtime_role','$migrator_role','$manual_worker_role','$manual_callback_role','$stepup_issuer_role','$manual_homologator_role','$manual_vault_binder_role','$manual_profile_admin_issuer_role','$manual_profile_accounting_issuer_role','$manual_profile_fiscal_issuer_role','$manual_sweeper_role')" | grep -q 1 \
    || runuser -u postgres -- psql -tAc "SELECT 1 FROM pg_database WHERE datname='$database_name'" | grep -q 1; then
    echo "Banco ou role preexistente sem arquivos de credencial para $slug; intervenção manual obrigatória." >&2
    exit 1
  fi

  runtime_password=$(openssl rand -hex 32)
  migrator_password=$(openssl rand -hex 32)
  manual_worker_password=$(openssl rand -hex 32)
  manual_callback_password=$(openssl rand -hex 32)
  stepup_issuer_password=$(openssl rand -hex 32)
  manual_homologator_password=$(openssl rand -hex 32)
  manual_vault_binder_password=$(openssl rand -hex 32)
  manual_profile_admin_issuer_password=$(openssl rand -hex 32)
  manual_profile_accounting_issuer_password=$(openssl rand -hex 32)
  manual_profile_fiscal_issuer_password=$(openssl rand -hex 32)
  manual_sweeper_password=$(openssl rand -hex 32)
  escaped_migrator_password=${migrator_password//\'/\'\'}
  escaped_runtime_password=${runtime_password//\'/\'\'}
  runuser -u postgres -- psql --no-psqlrc -v ON_ERROR_STOP=1 -d postgres <<SQL
CREATE ROLE "$migrator_role" LOGIN PASSWORD '$escaped_migrator_password'
  NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS;
CREATE ROLE "$runtime_role" LOGIN PASSWORD '$escaped_runtime_password'
  NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS;
SQL
  unset escaped_migrator_password escaped_runtime_password
  for role_and_password in \
    "$manual_worker_role:$manual_worker_password" \
    "$manual_callback_role:$manual_callback_password" \
    "$stepup_issuer_role:$stepup_issuer_password" \
    "$manual_homologator_role:$manual_homologator_password" \
    "$manual_vault_binder_role:$manual_vault_binder_password" \
    "$manual_profile_admin_issuer_role:$manual_profile_admin_issuer_password" \
    "$manual_profile_accounting_issuer_role:$manual_profile_accounting_issuer_password" \
    "$manual_profile_fiscal_issuer_role:$manual_profile_fiscal_issuer_password" \
    "$manual_sweeper_role:$manual_sweeper_password"; do
    authority_role=${role_and_password%%:*}
    authority_password=${role_and_password#*:}
    escaped_authority_password=${authority_password//\'/\'\'}
    runuser -u postgres -- psql --no-psqlrc -v ON_ERROR_STOP=1 -d postgres <<SQL
CREATE ROLE "$authority_role" LOGIN PASSWORD '$escaped_authority_password'
  NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS;
SQL
    unset escaped_authority_password authority_password
  done
  runuser -u postgres -- createdb --owner="$migrator_role" "$database_name"
  runuser -u postgres -- psql --no-psqlrc -v ON_ERROR_STOP=1 \
    -c "ALTER ROLE \"$manual_sweeper_role\" IN DATABASE \"$database_name\" SET default_transaction_isolation TO 'serializable';"

  runtime_partial=$(mktemp "$runtime_config_dir/.${slug}.runtime.XXXXXX")
  migrator_partial=$(mktemp "$migrator_config_dir/.${slug}.migrator.XXXXXX")
  manual_worker_partial=$(mktemp "$manual_worker_config_dir/.${slug}.worker.XXXXXX")
  manual_callback_partial=$(mktemp "$manual_callback_config_dir/.${slug}.callback.XXXXXX")
  stepup_issuer_partial=$(mktemp "$stepup_issuer_config_dir/.${slug}.issuer.XXXXXX")
  manual_homologator_partial=$(mktemp "$manual_homologator_config_dir/.${slug}.homologator.XXXXXX")
  manual_vault_binder_partial=$(mktemp "$manual_vault_binder_config_dir/.${slug}.binder.XXXXXX")
  manual_profile_admin_issuer_partial=$(mktemp "$manual_profile_admin_issuer_config_dir/.${slug}.admin-issuer.XXXXXX")
  manual_profile_accounting_issuer_partial=$(mktemp "$manual_profile_accounting_issuer_config_dir/.${slug}.accounting-issuer.XXXXXX")
  manual_profile_fiscal_issuer_partial=$(mktemp "$manual_profile_fiscal_issuer_config_dir/.${slug}.fiscal-issuer.XXXXXX")
  manual_sweeper_partial=$(mktemp "$manual_sweeper_config_dir/.${slug}.sweeper.XXXXXX")
  trap 'rm -f -- "${runtime_partial:-}" "${migrator_partial:-}" "${manual_worker_partial:-}" "${manual_callback_partial:-}" "${stepup_issuer_partial:-}" "${manual_homologator_partial:-}" "${manual_vault_binder_partial:-}" "${manual_profile_admin_issuer_partial:-}" "${manual_profile_accounting_issuer_partial:-}" "${manual_profile_fiscal_issuer_partial:-}" "${manual_sweeper_partial:-}"' EXIT
  trap 'exit 1' HUP INT TERM
  printf 'TENANT_DATABASE_URL=postgresql://%s:%s@127.0.0.1:5432/%s\n' \
    "$runtime_role" "$runtime_password" "$database_name" > "$runtime_partial"
  printf 'TENANT_MIGRATOR_DATABASE_URL=postgresql://%s:%s@127.0.0.1:5432/%s\nTENANT_DATABASE_NAME=%s\nTENANT_RUNTIME_ROLE=%s\nTENANT_MIGRATOR_ROLE=%s\nTENANT_MANUAL_WORKER_ROLE=%s\nTENANT_MANUAL_CALLBACK_ROLE=%s\nTENANT_STEPUP_ISSUER_ROLE=%s\nTENANT_MANUAL_HOMOLOGATOR_ROLE=%s\nTENANT_MANUAL_VAULT_BINDER_ROLE=%s\nTENANT_MANUAL_PROFILE_ADMIN_ISSUER_ROLE=%s\nTENANT_MANUAL_PROFILE_ACCOUNTING_ISSUER_ROLE=%s\nTENANT_MANUAL_PROFILE_FISCAL_ISSUER_ROLE=%s\nTENANT_MANUAL_SWEEPER_ROLE=%s\n' \
    "$migrator_role" "$migrator_password" "$database_name" "$database_name" "$runtime_role" "$migrator_role" "$manual_worker_role" "$manual_callback_role" "$stepup_issuer_role" "$manual_homologator_role" "$manual_vault_binder_role" "$manual_profile_admin_issuer_role" "$manual_profile_accounting_issuer_role" "$manual_profile_fiscal_issuer_role" "$manual_sweeper_role" > "$migrator_partial"
  printf 'TENANT_MANUAL_WORKER_DATABASE_URL=postgresql://%s:%s@127.0.0.1:5432/%s\n' \
    "$manual_worker_role" "$manual_worker_password" "$database_name" > "$manual_worker_partial"
  printf 'TENANT_MANUAL_CALLBACK_DATABASE_URL=postgresql://%s:%s@127.0.0.1:5432/%s\n' \
    "$manual_callback_role" "$manual_callback_password" "$database_name" > "$manual_callback_partial"
  printf 'TENANT_STEPUP_ISSUER_DATABASE_URL=postgresql://%s:%s@127.0.0.1:5432/%s\n' \
    "$stepup_issuer_role" "$stepup_issuer_password" "$database_name" > "$stepup_issuer_partial"
  printf 'TENANT_MANUAL_HOMOLOGATOR_DATABASE_URL=postgresql://%s:%s@127.0.0.1:5432/%s\n' \
    "$manual_homologator_role" "$manual_homologator_password" "$database_name" > "$manual_homologator_partial"
  printf 'TENANT_MANUAL_VAULT_BINDER_DATABASE_URL=postgresql://%s:%s@127.0.0.1:5432/%s\n' \
    "$manual_vault_binder_role" "$manual_vault_binder_password" "$database_name" > "$manual_vault_binder_partial"
  printf 'TENANT_MANUAL_PROFILE_ADMIN_ISSUER_DATABASE_URL=postgresql://%s:%s@127.0.0.1:5432/%s\n' \
    "$manual_profile_admin_issuer_role" "$manual_profile_admin_issuer_password" "$database_name" > "$manual_profile_admin_issuer_partial"
  printf 'TENANT_MANUAL_PROFILE_ACCOUNTING_ISSUER_DATABASE_URL=postgresql://%s:%s@127.0.0.1:5432/%s\n' \
    "$manual_profile_accounting_issuer_role" "$manual_profile_accounting_issuer_password" "$database_name" > "$manual_profile_accounting_issuer_partial"
  printf 'TENANT_MANUAL_PROFILE_FISCAL_ISSUER_DATABASE_URL=postgresql://%s:%s@127.0.0.1:5432/%s\n' \
    "$manual_profile_fiscal_issuer_role" "$manual_profile_fiscal_issuer_password" "$database_name" > "$manual_profile_fiscal_issuer_partial"
  printf 'TENANT_MANUAL_SWEEPER_DATABASE_URL=postgresql://%s:%s@127.0.0.1:5432/%s\n' \
    "$manual_sweeper_role" "$manual_sweeper_password" "$database_name" > "$manual_sweeper_partial"
  chown root:nalven-app "$runtime_partial"
  chmod 0640 "$runtime_partial"
  chown root:root "$migrator_partial"
  chmod 0600 "$migrator_partial"
  chown root:nalven-pos-worker "$manual_worker_partial"
  chmod 0640 "$manual_worker_partial"
  chown root:nalven-pos-callback "$manual_callback_partial"
  chmod 0640 "$manual_callback_partial"
  chown root:nalven-pos-stepup "$stepup_issuer_partial"
  chmod 0640 "$stepup_issuer_partial"
  chown root:nalven-pos-homologator "$manual_homologator_partial"
  chmod 0640 "$manual_homologator_partial"
  chown root:nalven-pos-vault-binder "$manual_vault_binder_partial"
  chmod 0640 "$manual_vault_binder_partial"
  chown root:nalven-pos-profile-admin "$manual_profile_admin_issuer_partial"
  chmod 0640 "$manual_profile_admin_issuer_partial"
  chown root:nalven-pos-profile-accounting "$manual_profile_accounting_issuer_partial"
  chmod 0640 "$manual_profile_accounting_issuer_partial"
  chown root:nalven-pos-profile-fiscal "$manual_profile_fiscal_issuer_partial"
  chmod 0640 "$manual_profile_fiscal_issuer_partial"
  chown root:nalven-pos-manual-sweeper "$manual_sweeper_partial"
  chmod 0640 "$manual_sweeper_partial"
  mv -- "$runtime_partial" "$runtime_config"
  mv -- "$migrator_partial" "$migrator_config"
  mv -- "$manual_worker_partial" "$manual_worker_config"
  mv -- "$manual_callback_partial" "$manual_callback_config"
  mv -- "$stepup_issuer_partial" "$stepup_issuer_config"
  mv -- "$manual_homologator_partial" "$manual_homologator_config"
  mv -- "$manual_vault_binder_partial" "$manual_vault_binder_config"
  mv -- "$manual_profile_admin_issuer_partial" "$manual_profile_admin_issuer_config"
  mv -- "$manual_profile_accounting_issuer_partial" "$manual_profile_accounting_issuer_config"
  mv -- "$manual_profile_fiscal_issuer_partial" "$manual_profile_fiscal_issuer_config"
  mv -- "$manual_sweeper_partial" "$manual_sweeper_config"
  trap - EXIT HUP INT TERM
fi

runtime_owner=$(stat -c '%u' "$runtime_config")
runtime_group=$(stat -c '%G' "$runtime_config")
runtime_mode=$(stat -c '%a' "$runtime_config")
if [[ "$runtime_owner" != 0 || "$runtime_group" != nalven-app || "$runtime_mode" != 640 ]]; then
  echo "A credencial runtime deve pertencer a root:nalven-app e usar modo 0640: $runtime_config" >&2
  exit 1
fi
migrator_owner=$(stat -c '%u' "$migrator_config")
migrator_mode=$(stat -c '%a' "$migrator_config")
if [[ "$migrator_owner" != 0 || "$migrator_mode" != 600 ]]; then
  echo "A credencial migrator deve pertencer a root e usar modo 0600: $migrator_config" >&2
  exit 1
fi
for authority_spec in \
  "$manual_worker_config:nalven-pos-worker:640" \
  "$manual_callback_config:nalven-pos-callback:640" \
  "$stepup_issuer_config:nalven-pos-stepup:640" \
  "$manual_homologator_config:nalven-pos-homologator:640" \
  "$manual_vault_binder_config:nalven-pos-vault-binder:640" \
  "$manual_profile_admin_issuer_config:nalven-pos-profile-admin:640" \
  "$manual_profile_accounting_issuer_config:nalven-pos-profile-accounting:640" \
  "$manual_profile_fiscal_issuer_config:nalven-pos-profile-fiscal:640" \
  "$manual_sweeper_config:nalven-pos-manual-sweeper:640"; do
  authority_config=${authority_spec%%:*}
  authority_remainder=${authority_spec#*:}
  authority_group=${authority_remainder%%:*}
  authority_mode=${authority_remainder#*:}
  if [[ $(stat -c '%u:%G:%a' "$authority_config") != "0:$authority_group:$authority_mode" ]]; then
    echo "Credencial de autoridade manual insegura: $authority_config" >&2
    exit 1
  fi
done
runtime_database_url=$(sed -n 's/^TENANT_DATABASE_URL=//p' "$runtime_config")
if [[ ! "$runtime_database_url" =~ ^postgres(ql)?://([a-z][a-z0-9_]{0,62}):([0-9a-f]{64})@127\.0\.0\.1:5432/([a-z][a-z0-9_]{0,62})$ ]]; then
  echo "TENANT_DATABASE_URL inválida em $runtime_config." >&2
  exit 1
fi
runtime_url_role=${BASH_REMATCH[2]}
runtime_url_password=${BASH_REMATCH[3]}
runtime_url_database=${BASH_REMATCH[4]}
[[ "$runtime_url_role" == "$runtime_role" && "$runtime_url_database" == "$database_name" ]] || { echo "A URL runtime diverge da role/banco esperados." >&2; exit 1; }

authenticate_database_url() {
  local database_url="$1" expected_role="$2" expected_database="$3" label="$4"
  local password pgpass_file identity
  if [[ ! "$database_url" =~ ^postgres(ql)?://([a-z][a-z0-9_]{0,62}):([0-9a-f]{64})@127\.0\.0\.1:5432/([a-z][a-z0-9_]{0,62})$ \
      || ${BASH_REMATCH[2]} != "$expected_role" || ${BASH_REMATCH[4]} != "$expected_database" ]]; then
    echo "$label diverge da role/banco esperados." >&2
    return 1
  fi
  password=${BASH_REMATCH[3]}
  pgpass_file=$(mktemp /run/nalven-authority-pgpass.XXXXXX)
  chmod 0600 "$pgpass_file"
  printf '127.0.0.1:5432:%s:%s:%s\n' "$expected_database" "$expected_role" "$password" > "$pgpass_file"
  if ! identity=$(PGPASSFILE="$pgpass_file" PGHOST=127.0.0.1 PGPORT=5432 PGUSER="$expected_role" PGDATABASE="$expected_database" \
      psql --no-psqlrc --no-password -Atc "SELECT current_user || E'\\t' || current_database()"); then
    rm -f -- "$pgpass_file"
    echo "$label não autentica." >&2
    return 1
  fi
  rm -f -- "$pgpass_file"
  [[ "$identity" == "$expected_role"$'\t'"$expected_database" ]] || {
    echo "$label autenticou em identidade divergente." >&2
    return 1
  }
}

authenticate_database_url "$runtime_database_url" "$runtime_role" "$database_name" TENANT_DATABASE_URL

for authority_url_spec in \
  "$manual_worker_config:TENANT_MANUAL_WORKER_DATABASE_URL:$manual_worker_role" \
  "$manual_callback_config:TENANT_MANUAL_CALLBACK_DATABASE_URL:$manual_callback_role" \
  "$stepup_issuer_config:TENANT_STEPUP_ISSUER_DATABASE_URL:$stepup_issuer_role" \
  "$manual_homologator_config:TENANT_MANUAL_HOMOLOGATOR_DATABASE_URL:$manual_homologator_role" \
  "$manual_vault_binder_config:TENANT_MANUAL_VAULT_BINDER_DATABASE_URL:$manual_vault_binder_role" \
  "$manual_profile_admin_issuer_config:TENANT_MANUAL_PROFILE_ADMIN_ISSUER_DATABASE_URL:$manual_profile_admin_issuer_role" \
  "$manual_profile_accounting_issuer_config:TENANT_MANUAL_PROFILE_ACCOUNTING_ISSUER_DATABASE_URL:$manual_profile_accounting_issuer_role" \
  "$manual_profile_fiscal_issuer_config:TENANT_MANUAL_PROFILE_FISCAL_ISSUER_DATABASE_URL:$manual_profile_fiscal_issuer_role" \
  "$manual_sweeper_config:TENANT_MANUAL_SWEEPER_DATABASE_URL:$manual_sweeper_role"; do
  authority_config=${authority_url_spec%%:*}
  authority_remainder=${authority_url_spec#*:}
  authority_variable=${authority_remainder%%:*}
  authority_role=${authority_remainder#*:}
  authority_database_url=$(sed -n "s/^${authority_variable}=//p" "$authority_config")
  if [[ ! "$authority_database_url" =~ ^postgres(ql)?://([a-z][a-z0-9_]{0,62}):([0-9a-f]{64})@127\.0\.0\.1:5432/([a-z][a-z0-9_]{0,62})$ ]]; then
    echo "$authority_variable inválida em $authority_config." >&2
    exit 1
  fi
  [[ ${BASH_REMATCH[2]} == "$authority_role" && ${BASH_REMATCH[4]} == "$database_name" ]] || {
    echo "$authority_variable diverge da role/banco esperados." >&2
    exit 1
  }
  authenticate_database_url "$authority_database_url" "$authority_role" "$database_name" "$authority_variable"
done

readonly provisioner_config=/etc/nalven/tenant-provisioner.env
[[ -f "$provisioner_config" && ! -L "$provisioner_config" && $(stat -c '%U:%G:%a' "$provisioner_config") == root:root:600 ]] || { echo "Configuração do provisionador ausente ou insegura." >&2; exit 1; }
[[ $(grep -Ec '^CONTROL_DATABASE_URL=postgres(ql)?://[^[:space:]]+$' "$provisioner_config") -eq 1 && $(wc -l < "$provisioner_config") -eq 1 ]] || { echo "Configuração do provisionador contém conteúdo inesperado." >&2; exit 1; }
CONTROL_DATABASE_URL=$(sed -n 's/^CONTROL_DATABASE_URL=//p' "$provisioner_config")
[[ "$CONTROL_DATABASE_URL" =~ ^postgres(ql)?://nalven_app:([^@[:space:]]+)@127\.0\.0\.1:5432/nalven$ ]] || { echo "CONTROL_DATABASE_URL deve apontar para nalven_app@127.0.0.1:5432/nalven." >&2; exit 1; }
control_password=${BASH_REMATCH[2]}
control_psql() { PGPASSWORD="$control_password" PGHOST=127.0.0.1 PGPORT=5432 PGUSER=nalven_app PGDATABASE=nalven psql --no-psqlrc --no-password "$@"; }
control_identity=$(control_psql -Atc "SELECT current_user || E'\\t' || current_database()")
[[ "$control_identity" == nalven_app$'\t'nalven ]] || { echo "CONTROL_DATABASE_URL não autenticou como nalven_app no banco nalven." >&2; exit 1; }
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
[[ ${TENANT_DATABASE_NAME:-} == "$database_name" ]] || { echo "Banco divergente na credencial de migração." >&2; exit 1; }
[[ ${TENANT_RUNTIME_ROLE:-} == "$runtime_role" ]] || { echo "Role runtime divergente na credencial de migração." >&2; exit 1; }
[[ ${TENANT_MIGRATOR_ROLE:-} == "$migrator_role" ]] || { echo "Role migrator divergente na credencial de migração." >&2; exit 1; }
[[ ${TENANT_MANUAL_WORKER_ROLE:-} == "$manual_worker_role" ]] || { echo "Role worker divergente na credencial de migração." >&2; exit 1; }
[[ ${TENANT_MANUAL_CALLBACK_ROLE:-} == "$manual_callback_role" ]] || { echo "Role callback divergente na credencial de migração." >&2; exit 1; }
[[ ${TENANT_STEPUP_ISSUER_ROLE:-} == "$stepup_issuer_role" ]] || { echo "Role issuer divergente na credencial de migração." >&2; exit 1; }
[[ ${TENANT_MANUAL_HOMOLOGATOR_ROLE:-} == "$manual_homologator_role" ]] || { echo "Role homologator divergente na credencial de migração." >&2; exit 1; }
[[ ${TENANT_MANUAL_VAULT_BINDER_ROLE:-} == "$manual_vault_binder_role" ]] || { echo "Role vault binder divergente na credencial de migração." >&2; exit 1; }
[[ ${TENANT_MANUAL_PROFILE_ADMIN_ISSUER_ROLE:-} == "$manual_profile_admin_issuer_role" ]] || { echo "Role profile admin issuer divergente na credencial de migração." >&2; exit 1; }
[[ ${TENANT_MANUAL_PROFILE_ACCOUNTING_ISSUER_ROLE:-} == "$manual_profile_accounting_issuer_role" ]] || { echo "Role profile accounting issuer divergente na credencial de migração." >&2; exit 1; }
[[ ${TENANT_MANUAL_PROFILE_FISCAL_ISSUER_ROLE:-} == "$manual_profile_fiscal_issuer_role" ]] || { echo "Role profile fiscal issuer divergente na credencial de migração." >&2; exit 1; }
[[ ${TENANT_MANUAL_SWEEPER_ROLE:-} == "$manual_sweeper_role" ]] || { echo "Role manual sweeper divergente na credencial de migração." >&2; exit 1; }
[[ ${TENANT_MIGRATOR_DATABASE_URL:-} =~ ^postgres(ql)?://[^[:space:]]+$ ]] || { echo "TENANT_MIGRATOR_DATABASE_URL inválida." >&2; exit 1; }
authenticate_database_url "$TENANT_MIGRATOR_DATABASE_URL" "$migrator_role" "$database_name" TENANT_MIGRATOR_DATABASE_URL

bash "$grants_script" "$migrator_config"
TENANT_DATABASE_URL="$TENANT_MIGRATOR_DATABASE_URL" "$migration_runner" tenant-migrate
bash "$grants_script" "$migrator_config"
TENANT_DATABASE_URL="$TENANT_MIGRATOR_DATABASE_URL" "$migration_runner" tenant-seed

latest_tenant_schema=$("$migration_runner" latest-tenant-schema)
control_psql -v ON_ERROR_STOP=1 \
  -v organization_id="$organization_id" -v database_name="$database_name" \
  -v config_key="$slug" -v schema_version="$latest_tenant_schema" \
  -v record_id="db_${slug}_$(date +%s)" <<'SQL'
INSERT INTO tenant_databases (
  id, organization_id, database_name, config_key, schema_version, status,
  created_at, updated_at
) VALUES (
  :'record_id', :'organization_id', :'database_name', :'config_key',
  :'schema_version', 'active', NOW(), NOW()
)
ON CONFLICT (organization_id) DO UPDATE SET
  database_name = EXCLUDED.database_name,
  config_key = EXCLUDED.config_key,
  schema_version = EXCLUDED.schema_version,
  status = 'active',
  updated_at = NOW();
SQL
unset TENANT_MIGRATOR_DATABASE_URL runtime_database_url runtime_identity runtime_url_password
echo "Tenant $organization_id provisionado em $database_name com roles migrator/runtime segregadas."
