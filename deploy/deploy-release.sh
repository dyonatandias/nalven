#!/usr/bin/env bash
echo 'Fluxo legado desativado. Use: sudo -n /usr/local/libexec/nalven/publish-current.sh. Migrations exigem aprovação separada.' >&2
exit 1
set -euo pipefail

source_root=/home/nalven/nalven
project_root=/srv/nalven
service_user=nalven-app
builder_user=nalven
node_root=/opt/node-v24.19.0
app_env=/etc/nalven/app.env
seed_env=/etc/nalven/seed.env
tenant_env_dir=/etc/nalven/tenants
tenant_migrator_env_dir=/etc/nalven/tenant-migrators
tenant_manual_worker_env_dir=/etc/nalven/tenant-manual-workers
tenant_manual_callback_env_dir=/etc/nalven/tenant-manual-callbacks
tenant_stepup_issuer_env_dir=/etc/nalven/tenant-stepup-issuers
tenant_manual_homologator_env_dir=/etc/nalven/tenant-manual-homologators
tenant_manual_vault_binder_env_dir=/etc/nalven/tenant-manual-vault-binders
tenant_manual_profile_admin_issuer_env_dir=/etc/nalven/tenant-manual-profile-admin-issuers
tenant_manual_profile_accounting_issuer_env_dir=/etc/nalven/tenant-manual-profile-accounting-issuers
tenant_manual_profile_fiscal_issuer_env_dir=/etc/nalven/tenant-manual-profile-fiscal-issuers
tenant_manual_sweeper_env_dir=/etc/nalven/tenant-manual-sweepers

if [[ ${EUID:-$(id -u)} -ne 0 ]]; then
  echo "Execute este script como root (por exemplo: sudo $0)." >&2
  exit 1
fi

for required_path in \
  "$app_env" \
  "$seed_env" \
  "$node_root/bin/node" \
  "$node_root/bin/npm" \
  "$source_root/package.json" \
  "$source_root/prisma.control.config.ts" \
  "$source_root/prisma.tenant.config.ts"; do
  if [[ ! -e "$required_path" ]]; then
    echo "Dependência de deploy ausente: $required_path" >&2
    exit 1
  fi
done

for required_command in curl psql; do
  if ! command -v "$required_command" >/dev/null 2>&1; then
    echo "Dependência de deploy ausente no PATH: $required_command" >&2
    exit 1
  fi
done

export PATH="$node_root/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"
if [[ ! -f "$app_env" || -L "$app_env" || $(stat -c '%u:%G:%a' "$app_env") != 0:nalven-app:640 ]]; then
  echo "$app_env deve ser arquivo regular root:nalven-app:0640." >&2
  exit 1
fi
if [[ ! -f "$seed_env" || -L "$seed_env" || $(stat -c '%u:%G:%a' "$seed_env") != 0:root:600 \
  || $(grep -Ec '^SUPERADMIN_PASSWORD=[^[:space:]]{20,512}$' "$seed_env") -ne 1 \
  || $(grep -Ec '^DEMO_USER_PASSWORD=[^[:space:]]{20,512}$' "$seed_env") -ne 1 \
  || $(wc -l < "$seed_env") -ne 2 ]]; then
  echo "$seed_env deve ser root:root:0600 e conter somente as duas credenciais de seed." >&2
  exit 1
fi
if [[ $(grep -Ec '^CONTROL_DATABASE_URL=postgres(ql)?://[^[:space:]]+$' "$app_env") -ne 1 ]]; then
  echo "CONTROL_DATABASE_URL deve aparecer exatamente uma vez e sem sintaxe shell em $app_env." >&2
  exit 1
fi
if [[ $(grep -Ec '^NALVEN_INTERNAL_JOB_TOKEN=[^[:space:]]{32,512}$' "$app_env") -ne 1 ]]; then
  echo "NALVEN_INTERNAL_JOB_TOKEN deve aparecer exatamente uma vez e sem sintaxe shell em $app_env." >&2
  exit 1
fi
if [[ $(grep -Ec '^POS_AGENT_TOKEN_PEPPER=[^[:space:]]{32,512}$' "$app_env") -ne 1 ]]; then
  echo "POS_AGENT_TOKEN_PEPPER deve aparecer exatamente uma vez, ter ao menos 32 bytes e não conter espaços em $app_env." >&2
  exit 1
fi
CONTROL_DATABASE_URL=$(sed -n 's/^CONTROL_DATABASE_URL=//p' "$app_env")
NALVEN_INTERNAL_JOB_TOKEN=$(sed -n 's/^NALVEN_INTERNAL_JOB_TOKEN=//p' "$app_env")
SUPERADMIN_PASSWORD=$(sed -n 's/^SUPERADMIN_PASSWORD=//p' "$seed_env")
DEMO_USER_PASSWORD=$(sed -n 's/^DEMO_USER_PASSWORD=//p' "$seed_env")
[[ "$CONTROL_DATABASE_URL" =~ ^postgres(ql)?://nalven_app:([^@[:space:]]+)@127\.0\.0\.1:5432/nalven$ ]] || { echo "CONTROL_DATABASE_URL deve apontar para nalven_app@127.0.0.1:5432/nalven." >&2; exit 1; }
control_password=${BASH_REMATCH[2]}
control_psql() { PGPASSWORD="$control_password" PGHOST=127.0.0.1 PGPORT=5432 PGUSER=nalven_app PGDATABASE=nalven psql --no-psqlrc --no-password "$@"; }
control_identity=$(control_psql -Atc "SELECT current_user || E'\\t' || current_database()")
if [[ "$control_identity" != nalven_app$'\t'nalven ]]; then
  echo "CONTROL_DATABASE_URL não autenticou como nalven_app no banco nalven." >&2
  exit 1
fi
if [[ ! ${NALVEN_INTERNAL_JOB_TOKEN:-} =~ ^[^[:space:]]{32,512}$ ]]; then
  echo "NALVEN_INTERNAL_JOB_TOKEN ausente ou inválido em $app_env." >&2
  exit 1
fi
provisioner_config=/etc/nalven/tenant-provisioner.env
if [[ ! -e "$provisioner_config" ]]; then
  provisioner_partial=$(mktemp /etc/nalven/.tenant-provisioner.env.XXXXXX)
  trap 'rm -f -- "${provisioner_partial:-}"' EXIT
  printf 'CONTROL_DATABASE_URL=%s\n' "$CONTROL_DATABASE_URL" > "$provisioner_partial"
  chown root:root "$provisioner_partial"
  chmod 0600 "$provisioner_partial"
  mv -- "$provisioner_partial" "$provisioner_config"
  trap - EXIT
fi
if [[ ! -f "$provisioner_config" || -L "$provisioner_config" || $(stat -c '%U:%G:%a' "$provisioner_config") != root:root:600 \
    || $(grep -Ec '^CONTROL_DATABASE_URL=postgres(ql)?://[^[:space:]]+$' "$provisioner_config") -ne 1 \
    || $(wc -l < "$provisioner_config") -ne 1 \
    || $(sed -n 's/^CONTROL_DATABASE_URL=//p' "$provisioner_config") != "$CONTROL_DATABASE_URL" ]]; then
  echo "$provisioner_config deve ser root:root:0600, conter apenas a URL de controle e coincidir com $app_env." >&2
  exit 1
fi
nalven_config_mode=$(stat -c '%a' /etc/nalven 2>/dev/null || true)
if [[ ! -d /etc/nalven || -L /etc/nalven || $(stat -c '%u:%G' /etc/nalven) != 0:nalven-app \
    || ( "$nalven_config_mode" != 750 && "$nalven_config_mode" != 751 ) ]]; then
  echo "/etc/nalven deve ser root:nalven-app e usar modo legado 0750 ou isolado 0751." >&2
  exit 1
fi
chmod 0751 /etc/nalven
if [[ ! -d "$tenant_env_dir" || $(stat -c '%u:%G:%a' "$tenant_env_dir") != 0:nalven-app:750 ]]; then
  echo "$tenant_env_dir deve pertencer a root:nalven-app e usar modo 0750." >&2
  exit 1
fi
if [[ ! -e "$tenant_migrator_env_dir" ]]; then
  install -d -o root -g root -m 0700 "$tenant_migrator_env_dir"
fi
if [[ ! -d "$tenant_migrator_env_dir" || $(stat -c '%u:%a' "$tenant_migrator_env_dir") != 0:700 ]]; then
  echo "$tenant_migrator_env_dir deve pertencer a root e usar modo 0700." >&2
  exit 1
fi
for required_service_user in nalven-app nalven-jobs nalven-migrator nalven-pos-worker nalven-pos-callback nalven-pos-stepup nalven-pos-homologator nalven-pos-vault-binder nalven-pos-profile-admin nalven-pos-profile-accounting nalven-pos-profile-fiscal nalven-pos-manual-sweeper; do
  if ! id "$required_service_user" >/dev/null 2>&1; then
    useradd --system --home-dir "$project_root" --shell /usr/sbin/nologin --user-group "$required_service_user"
  fi
  if [[ $(id -u "$required_service_user") -eq 0 || $(id -u "$required_service_user") -ge 1000 ]] \
      || [[ $(id -g "$required_service_user") -eq 0 || $(id -g "$required_service_user") -ge 1000 ]] \
      || [[ $(id -gn "$required_service_user") != "$required_service_user" || $(id -Gn "$required_service_user") != "$required_service_user" ]] \
      || [[ -n $(getent group "$required_service_user" | cut -d: -f4) ]] \
      || [[ $(getent passwd "$required_service_user" | cut -d: -f7) != /usr/sbin/nologin ]]; then
    echo "Usuário de serviço ausente, inseguro ou com memberships cruzados: $required_service_user. Execute o bootstrap seguro." >&2
    exit 1
  fi
done
for authority_dir_spec in \
  "$tenant_manual_worker_env_dir:nalven-pos-worker:750" \
  "$tenant_manual_callback_env_dir:nalven-pos-callback:750" \
  "$tenant_stepup_issuer_env_dir:nalven-pos-stepup:750" \
  "$tenant_manual_homologator_env_dir:nalven-pos-homologator:750" \
  "$tenant_manual_vault_binder_env_dir:nalven-pos-vault-binder:750" \
  "$tenant_manual_profile_admin_issuer_env_dir:nalven-pos-profile-admin:750" \
  "$tenant_manual_profile_accounting_issuer_env_dir:nalven-pos-profile-accounting:750" \
  "$tenant_manual_profile_fiscal_issuer_env_dir:nalven-pos-profile-fiscal:750" \
  "$tenant_manual_sweeper_env_dir:nalven-pos-manual-sweeper:750"; do
  authority_dir=${authority_dir_spec%%:*}
  authority_remainder=${authority_dir_spec#*:}
  authority_group=${authority_remainder%%:*}
  authority_mode=${authority_remainder#*:}
  if [[ ! -e "$authority_dir" ]]; then
    install -d -o root -g "$authority_group" -m "0$authority_mode" "$authority_dir"
  fi
  if [[ ! -d "$authority_dir" || $(stat -c '%u:%G:%a' "$authority_dir") != "0:$authority_group:$authority_mode" ]]; then
    echo "Diretório de autoridade manual inseguro ou ausente: $authority_dir" >&2
    exit 1
  fi
done

run_as_builder() {
  runuser -u "$builder_user" -- env -i HOME=/home/nalven PATH="$PATH" "$@"
}

cd "$source_root"

if [[ ${NALVEN_SKIP_TESTS:-0} == 1 ]]; then
  echo "[1/6] Testes e lint ignorados por NALVEN_SKIP_TESTS=1"
else
  echo "[1/6] Validando testes unitários e qualidade do código"
  run_as_builder "$node_root/bin/npm" run test:unit
  run_as_builder "$node_root/bin/npm" run lint
fi

if [[ ${NALVEN_SKIP_BUILD:-0} == 1 ]]; then
  echo "[2/6] Reutilizando o build de produção já gerado"
else
  echo "[2/6] Gerando o build de produção"
  run_as_builder env \
    NODE_ENV=production \
    CONTROL_DATABASE_URL=postgresql://build:build@127.0.0.1:5432/build \
    TENANT_DATABASE_URL=postgresql://build:build@127.0.0.1:5432/build \
    "$node_root/bin/npm" run build
fi

if [[ ! -f .next/standalone/server.js || ! -d .next/static ]]; then
  echo "O build não produziu o artefato standalone esperado." >&2
  exit 1
fi

# Root nunca executa a matriz de grants diretamente do checkout gravável pelo
# builder. Os artefatos privilegiados são copiados e verificados primeiro.
install -d -o root -g root -m 0755 /usr/local/libexec/nalven
for trusted_script in provision-tenant.sh reconcile-tenant-runtime-grants.sh cutover-tenant-manual-profile-issuers.sh cutover-tenant-manual-sweeper.sh process-tenant-provisioning.sh install-tenant-migration-bundle.sh run-tenant-migration-bundle.sh; do
  install -o root -g root -m 0750 "$source_root/deploy/$trusted_script" "/usr/local/libexec/nalven/$trusted_script"
done
install -o root -g root -m 0755 "$source_root/deploy/process-tenant-jobs.sh" /usr/local/libexec/nalven/process-tenant-jobs.sh
install -o root -g root -m 0755 "$source_root/deploy/process-pos-manual-sweep.sh" /usr/local/libexec/nalven/process-pos-manual-sweep.sh
install -o root -g root -m 0640 "$source_root/deploy/reconcile-tenant-runtime-grants.sql" /usr/local/libexec/nalven/reconcile-tenant-runtime-grants.sql
/usr/local/libexec/nalven/install-tenant-migration-bundle.sh "$source_root"

echo "[3/6] Aplicando migrações do plano de controle"
CONTROL_DATABASE_URL="$CONTROL_DATABASE_URL" /usr/local/libexec/nalven/run-tenant-migration-bundle.sh control-migrate
CONTROL_DATABASE_URL="$CONTROL_DATABASE_URL" SUPERADMIN_PASSWORD="$SUPERADMIN_PASSWORD" DEMO_USER_PASSWORD="$DEMO_USER_PASSWORD" /usr/local/libexec/nalven/run-tenant-migration-bundle.sh control-seed
unset SUPERADMIN_PASSWORD DEMO_USER_PASSWORD

shopt -s nullglob
tenant_configs=("$tenant_env_dir"/*.env)
migrator_configs=("$tenant_migrator_env_dir"/*.env)
shopt -u nullglob
if (( ${#tenant_configs[@]} == 0 )); then
  echo "Nenhum tenant foi encontrado em $tenant_env_dir; deploy cancelado." >&2
  exit 1
fi
authenticate_release_url() {
  local config_file="$1" variable="$2" expected_role="$3" expected_database="$4"
  local database_url password pgpass_file identity
  database_url=$(sed -n "s/^${variable}=//p" "$config_file")
  if [[ ! "$database_url" =~ ^postgres(ql)?://([a-z][a-z0-9_]{0,62}):([0-9a-f]{64})@127\.0\.0\.1:5432/([a-z][a-z0-9_]{0,62})$ \
      || ${BASH_REMATCH[2]} != "$expected_role" || ${BASH_REMATCH[4]} != "$expected_database" ]]; then
    echo "$variable diverge da role/banco esperados em $config_file." >&2
    return 1
  fi
  password=${BASH_REMATCH[3]}
  pgpass_file=$(mktemp /run/nalven-release-pgpass.XXXXXX)
  chmod 0600 "$pgpass_file"
  printf '127.0.0.1:5432:%s:%s:%s\n' "$expected_database" "$expected_role" "$password" > "$pgpass_file"
  if ! identity=$(PGPASSFILE="$pgpass_file" PGHOST=127.0.0.1 PGPORT=5432 PGUSER="$expected_role" PGDATABASE="$expected_database" \
      psql --no-psqlrc --no-password -Atc "SELECT current_user || E'\\t' || current_database()"); then
    rm -f -- "$pgpass_file"
    echo "$variable não autentica em $config_file." >&2
    return 1
  fi
  rm -f -- "$pgpass_file"
  [[ "$identity" == "$expected_role"$'\t'"$expected_database" ]] || {
    echo "$variable autenticou em identidade divergente." >&2
    return 1
  }
}
install -o root -g root -m 0750 "$source_root/deploy/cutover-tenant-manual-vault-binder.sh" /usr/local/libexec/nalven/cutover-tenant-manual-vault-binder.sh
install -o root -g root -m 0750 "$source_root/deploy/cutover-tenant-manual-profile-issuers.sh" /usr/local/libexec/nalven/cutover-tenant-manual-profile-issuers.sh
install -o root -g root -m 0750 "$source_root/deploy/cutover-tenant-manual-sweeper.sh" /usr/local/libexec/nalven/cutover-tenant-manual-sweeper.sh
for migrator_config in "${migrator_configs[@]}"; do
  /usr/local/libexec/nalven/cutover-tenant-manual-vault-binder.sh "$migrator_config"
  /usr/local/libexec/nalven/cutover-tenant-manual-profile-issuers.sh "$migrator_config"
  /usr/local/libexec/nalven/cutover-tenant-manual-sweeper.sh "$migrator_config"
done
for tenant_config in "${tenant_configs[@]}"; do
  tenant_config_key=$(basename "$tenant_config" .env)
  tenant_db_suffix=${tenant_config_key//-/_}
  expected_database="nalven_t_${tenant_db_suffix}"
  if [[ $(stat -c '%u:%G:%a' "$tenant_config") != 0:nalven-app:640 ]]; then
    echo "Credencial runtime insegura para $tenant_config_key; esperado root:nalven-app:0640." >&2
    exit 1
  fi
  if [[ ! -f "$tenant_migrator_env_dir/$tenant_config_key.env" ]]; then
    echo "Tenant legado $tenant_config_key não possui credencial migrator root-only; deploy cancelado sem fallback para a URL runtime." >&2
    echo "Faça o cutover root-only de role/credencial descrito em docs/erp/pdv/SEGREGACAO-ROLE-BANCO-E-ATTESTATION.md e repita: sudo env NALVEN_SKIP_TESTS=1 NALVEN_SKIP_SMOKE=1 /bin/bash $source_root/deploy/deploy-release.sh" >&2
    exit 1
  fi
  authenticate_release_url "$tenant_config" TENANT_DATABASE_URL "${expected_database}_runtime" "$expected_database"
  authenticate_release_url "$tenant_migrator_env_dir/$tenant_config_key.env" TENANT_MIGRATOR_DATABASE_URL "${expected_database}_migrator" "$expected_database"
  for authority_file_spec in \
    "$tenant_manual_worker_env_dir/$tenant_config_key.env:nalven-pos-worker:640" \
    "$tenant_manual_callback_env_dir/$tenant_config_key.env:nalven-pos-callback:640" \
    "$tenant_stepup_issuer_env_dir/$tenant_config_key.env:nalven-pos-stepup:640" \
    "$tenant_manual_homologator_env_dir/$tenant_config_key.env:nalven-pos-homologator:640" \
    "$tenant_manual_vault_binder_env_dir/$tenant_config_key.env:nalven-pos-vault-binder:640" \
    "$tenant_manual_profile_admin_issuer_env_dir/$tenant_config_key.env:nalven-pos-profile-admin:640" \
    "$tenant_manual_profile_accounting_issuer_env_dir/$tenant_config_key.env:nalven-pos-profile-accounting:640" \
    "$tenant_manual_profile_fiscal_issuer_env_dir/$tenant_config_key.env:nalven-pos-profile-fiscal:640" \
    "$tenant_manual_sweeper_env_dir/$tenant_config_key.env:nalven-pos-manual-sweeper:640"; do
    authority_file=${authority_file_spec%%:*}
    authority_remainder=${authority_file_spec#*:}
    authority_group=${authority_remainder%%:*}
    authority_mode=${authority_remainder#*:}
    if [[ ! -f "$authority_file" || $(stat -c '%u:%G:%a' "$authority_file") != "0:$authority_group:$authority_mode" ]]; then
      echo "Credencial de autoridade manual ausente ou insegura para $tenant_config_key: $authority_file" >&2
      exit 1
    fi
  done
  authenticate_release_url "$tenant_manual_worker_env_dir/$tenant_config_key.env" TENANT_MANUAL_WORKER_DATABASE_URL "${expected_database}_mw" "$expected_database"
  authenticate_release_url "$tenant_manual_callback_env_dir/$tenant_config_key.env" TENANT_MANUAL_CALLBACK_DATABASE_URL "${expected_database}_mc" "$expected_database"
  authenticate_release_url "$tenant_stepup_issuer_env_dir/$tenant_config_key.env" TENANT_STEPUP_ISSUER_DATABASE_URL "${expected_database}_si" "$expected_database"
  authenticate_release_url "$tenant_manual_homologator_env_dir/$tenant_config_key.env" TENANT_MANUAL_HOMOLOGATOR_DATABASE_URL "${expected_database}_mh" "$expected_database"
  authenticate_release_url "$tenant_manual_vault_binder_env_dir/$tenant_config_key.env" TENANT_MANUAL_VAULT_BINDER_DATABASE_URL "${expected_database}_mb" "$expected_database"
  authenticate_release_url "$tenant_manual_profile_admin_issuer_env_dir/$tenant_config_key.env" TENANT_MANUAL_PROFILE_ADMIN_ISSUER_DATABASE_URL "${expected_database}_mpi" "$expected_database"
  authenticate_release_url "$tenant_manual_profile_accounting_issuer_env_dir/$tenant_config_key.env" TENANT_MANUAL_PROFILE_ACCOUNTING_ISSUER_DATABASE_URL "${expected_database}_mpa" "$expected_database"
  authenticate_release_url "$tenant_manual_profile_fiscal_issuer_env_dir/$tenant_config_key.env" TENANT_MANUAL_PROFILE_FISCAL_ISSUER_DATABASE_URL "${expected_database}_mpf" "$expected_database"
  authenticate_release_url "$tenant_manual_sweeper_env_dir/$tenant_config_key.env" TENANT_MANUAL_SWEEPER_DATABASE_URL "${expected_database}_ms" "$expected_database"
done
for migrator_config in "${migrator_configs[@]}"; do
  tenant_config_key=$(basename "$migrator_config" .env)
  if [[ ! -f "$tenant_env_dir/$tenant_config_key.env" ]]; then
    echo "Credencial runtime ausente para $tenant_config_key; deploy cancelado." >&2
    exit 1
  fi
  if [[ $(stat -c '%u:%a' "$migrator_config") != 0:600 ]]; then
    echo "Credencial migrator insegura para $tenant_config_key; esperado root:0600." >&2
    exit 1
  fi
done
if (( ${#migrator_configs[@]} != ${#tenant_configs[@]} )); then
  echo "Inventário runtime/migrator divergente; deploy cancelado." >&2
  exit 1
fi

echo "[4/6] Aplicando migrações em ${#tenant_configs[@]} tenant(s)"
latest_tenant_schema=$(/usr/local/libexec/nalven/run-tenant-migration-bundle.sh latest-tenant-schema)
for migrator_config in "${migrator_configs[@]}"; do
  migrator_database_url=$(sed -n 's/^TENANT_MIGRATOR_DATABASE_URL=//p' "$migrator_config")
  if [[ ! "$migrator_database_url" =~ ^postgres(ql)?://[^[:space:]]+$ ]]; then
    echo "TENANT_MIGRATOR_DATABASE_URL ausente ou inválida em $migrator_config." >&2
    exit 1
  fi
  bash /usr/local/libexec/nalven/reconcile-tenant-runtime-grants.sh "$migrator_config"
  TENANT_DATABASE_URL="$migrator_database_url" /usr/local/libexec/nalven/run-tenant-migration-bundle.sh tenant-migrate
  bash /usr/local/libexec/nalven/reconcile-tenant-runtime-grants.sh "$migrator_config"
  TENANT_DATABASE_URL="$migrator_database_url" /usr/local/libexec/nalven/run-tenant-migration-bundle.sh tenant-seed
  tenant_config_key=$(basename "$migrator_config" .env)
  control_psql -v ON_ERROR_STOP=1 \
    -v config_key="$tenant_config_key" -v schema_version="$latest_tenant_schema" <<'SQL'
UPDATE tenant_databases
   SET schema_version = :'schema_version', updated_at = NOW()
 WHERE config_key = :'config_key';
SQL
done
unset TENANT_DATABASE_URL migrator_database_url tenant_config_key latest_tenant_schema

echo "[5/6] Publicando release imutável"
release_id=$(date -u +%Y%m%d%H%M%S)
release="$project_root/releases/$release_id"
while [[ -e "$release" ]]; do
  release_id="${release_id}-1"
  release="$project_root/releases/$release_id"
done
previous_release=$(readlink -f "$project_root/current" 2>/dev/null || true)

install -d -o root -g "$service_user" -m 0751 "$project_root" "$project_root/releases" "$release"
cp -a .next/standalone/. "$release/"
install -d -o "$builder_user" -g "$service_user" -m 0755 "$release/.next/static"
cp -a .next/static/. "$release/.next/static/"
cp -a public "$release/public"
chown -R "root:$service_user" "$release"
find "$release" -type d -exec chmod 0750 {} +
find "$release" -type f -exec chmod 0640 {} +
chmod 0751 "$release"
ln -sfn "$release" "$project_root/current"

echo "[6/6] Reiniciando e verificando a aplicação"
install -d -o root -g root -m 0755 /usr/local/libexec/nalven
install -o root -g root -m 0644 "$source_root/deploy/nalven.service" /etc/systemd/system/nalven.service
install -o root -g root -m 0644 "$source_root/deploy/nalven-pos-vault-binder@.service" /etc/systemd/system/nalven-pos-vault-binder@.service
install -o root -g root -m 0644 "$source_root/deploy/nalven-pos-profile-admin-issuer@.service" /etc/systemd/system/nalven-pos-profile-admin-issuer@.service
install -o root -g root -m 0644 "$source_root/deploy/nalven-pos-profile-accounting-issuer@.service" /etc/systemd/system/nalven-pos-profile-accounting-issuer@.service
install -o root -g root -m 0644 "$source_root/deploy/nalven-pos-profile-fiscal-issuer@.service" /etc/systemd/system/nalven-pos-profile-fiscal-issuer@.service
install -o root -g root -m 0644 "$source_root/deploy/nalven-pos-manual-sweep.service" /etc/systemd/system/nalven-pos-manual-sweep.service
install -o root -g root -m 0644 "$source_root/deploy/nalven-pos-manual-sweep.timer" /etc/systemd/system/nalven-pos-manual-sweep.timer
ln -sfn /usr/local/libexec/nalven/provision-tenant.sh /usr/local/sbin/nalven-provision-tenant
install -o root -g root -m 0750 "$source_root/deploy/provision-tenant.sh" /usr/local/libexec/nalven/provision-tenant.sh
install -o root -g root -m 0755 "$source_root/deploy/process-tenant-jobs.sh" /usr/local/libexec/nalven/process-tenant-jobs.sh
install -o root -g root -m 0644 "$source_root/deploy/nalven-tenant-jobs.service" /etc/systemd/system/nalven-tenant-jobs.service
install -o root -g root -m 0644 "$source_root/deploy/nalven-tenant-jobs.timer" /etc/systemd/system/nalven-tenant-jobs.timer
install -o root -g root -m 0644 "$source_root/deploy/nalven-dfe-sync.service" /etc/systemd/system/nalven-dfe-sync.service
install -o root -g root -m 0644 "$source_root/deploy/nalven-dfe-sync.timer" /etc/systemd/system/nalven-dfe-sync.timer
install -o root -g root -m 0644 "$source_root/deploy/nalven-billing-jobs.service" /etc/systemd/system/nalven-billing-jobs.service
install -o root -g root -m 0644 "$source_root/deploy/nalven-billing-jobs.timer" /etc/systemd/system/nalven-billing-jobs.timer
install -o root -g root -m 0750 "$source_root/deploy/process-tenant-provisioning.sh" /usr/local/libexec/nalven/process-tenant-provisioning.sh
install -o root -g root -m 0750 "$source_root/deploy/install-tenant-migration-bundle.sh" /usr/local/libexec/nalven/install-tenant-migration-bundle.sh
install -o root -g root -m 0750 "$source_root/deploy/run-tenant-migration-bundle.sh" /usr/local/libexec/nalven/run-tenant-migration-bundle.sh
install -o root -g root -m 0750 "$source_root/deploy/cutover-tenant-manual-vault-binder.sh" /usr/local/libexec/nalven/cutover-tenant-manual-vault-binder.sh
install -o root -g root -m 0750 "$source_root/deploy/cutover-tenant-manual-sweeper.sh" /usr/local/libexec/nalven/cutover-tenant-manual-sweeper.sh
install -o root -g root -m 0644 "$source_root/deploy/nalven-tenant-provisioning.service" /etc/systemd/system/nalven-tenant-provisioning.service
install -o root -g root -m 0644 "$source_root/deploy/nalven-tenant-provisioning.timer" /etc/systemd/system/nalven-tenant-provisioning.timer
ln -sfn /usr/local/libexec/nalven/reconcile-tenant-runtime-grants.sh /usr/local/sbin/nalven-reconcile-tenant-runtime-grants
install -o root -g root -m 0750 "$source_root/deploy/reconcile-tenant-runtime-grants.sh" /usr/local/libexec/nalven/reconcile-tenant-runtime-grants.sh
install -o root -g root -m 0640 "$source_root/deploy/reconcile-tenant-runtime-grants.sql" /usr/local/libexec/nalven/reconcile-tenant-runtime-grants.sql
install -o root -g root -m 0750 "$source_root/deploy/backup-databases.sh" /usr/local/sbin/nalven-backup-databases
install -o root -g root -m 0644 "$source_root/deploy/nalven-backup.service" /etc/systemd/system/nalven-backup.service
install -o root -g root -m 0644 "$source_root/deploy/nalven-backup.timer" /etc/systemd/system/nalven-backup.timer
install -o root -g nalven-app -m 0750 "$source_root/deploy/process-pos-maintenance.sh" /usr/local/libexec/nalven/process-pos-maintenance.sh
install -o root -g root -m 0644 "$source_root/deploy/nalven-pos-maintenance.service" /etc/systemd/system/nalven-pos-maintenance.service
install -o root -g root -m 0644 "$source_root/deploy/nalven-pos-maintenance.timer" /etc/systemd/system/nalven-pos-maintenance.timer
install -o root -g root -m 0755 "$source_root/deploy/process-pos-manual-sweep.sh" /usr/local/libexec/nalven/process-pos-manual-sweep.sh
install -o root -g root -m 0644 "$source_root/deploy/nalven-pos-manual-sweep.service" /etc/systemd/system/nalven-pos-manual-sweep.service
install -o root -g root -m 0644 "$source_root/deploy/nalven-pos-manual-sweep.timer" /etc/systemd/system/nalven-pos-manual-sweep.timer
nginx_site=/etc/nginx/sites-available/nalven
nginx_backup=$(mktemp /run/nalven-nginx.XXXXXX)
nginx_had_site=false
if [[ -f "$nginx_site" ]]; then
  cp -- "$nginx_site" "$nginx_backup"
  nginx_had_site=true
fi
install -o root -g root -m 0644 "$source_root/deploy/nginx.conf" "$nginx_site"
ln -sfn "$nginx_site" /etc/nginx/sites-enabled/nalven
if ! nginx -t; then
  if [[ "$nginx_had_site" == true ]]; then
    install -o root -g root -m 0644 "$nginx_backup" "$nginx_site"
  else
    rm -f -- "$nginx_site" /etc/nginx/sites-enabled/nalven
  fi
  rm -f -- "$nginx_backup"
  echo "Configuração Nginx rejeitada; configuração anterior restaurada." >&2
  exit 1
fi
install -o root -g root -m 0750 "$source_root/deploy/install-internal-job-runner.sh" /usr/local/libexec/nalven/install-internal-job-runner.sh
/usr/local/libexec/nalven/install-internal-job-runner.sh "$source_root"
systemctl daemon-reload
systemctl enable --now nalven-backup.timer nalven-tenant-jobs.timer nalven-tenant-provisioning.timer nalven-dfe-sync.timer nalven-billing-jobs.timer nalven-pos-maintenance.timer nalven-pos-manual-sweep.timer
if ! systemctl reload nginx; then
  if [[ "$nginx_had_site" == true ]]; then
    install -o root -g root -m 0644 "$nginx_backup" "$nginx_site"
  else
    rm -f -- "$nginx_site" /etc/nginx/sites-enabled/nalven
  fi
  systemctl reload nginx || true
  rm -f -- "$nginx_backup"
  echo "O Nginx não aceitou o reload; configuração anterior restaurada." >&2
  exit 1
fi
rm -f -- "$nginx_backup"
healthy=false
if ! systemctl restart nalven.service; then
  echo "O serviço nalven falhou durante o restart." >&2
elif [[ ${NALVEN_SKIP_SMOKE:-0} == 1 ]]; then
  echo "Health HTTP ignorado por NALVEN_SKIP_SMOKE=1; verificando apenas estado imediato do unit."
  if systemctl is-active --quiet nalven.service; then
    healthy=true
  fi
else
  for attempt in {1..30}; do
    if curl --fail --silent --max-time 5 http://127.0.0.1/ >/dev/null; then
      healthy=true
      break
    fi
    sleep 1
  done
fi

if [[ "$healthy" != true ]]; then
  echo "O novo release não ficou saudável; iniciando rollback." >&2
  if [[ -n "$previous_release" && -d "$previous_release" ]]; then
    ln -sfn "$previous_release" "$project_root/current"
    systemctl restart nalven.service
    echo "Rollback concluído para $previous_release." >&2
  else
    echo "Não foi encontrado um release anterior para rollback." >&2
  fi
  exit 1
fi

active_release=$(readlink -f "$project_root/current")
echo "Deploy concluído e saudável em $active_release"
