#!/usr/bin/env bash
if [[ -e /etc/nalven/control-migrator.env ]]; then
  echo 'Servidor já provisionado e isolado. Use o publicador instalado; bootstrap não é atualização.' >&2
  exit 1
fi
set -euo pipefail

source_root=/home/nalven/nalven
project_root=/srv/nalven
service_user=nalven-app
jobs_user=nalven-jobs
migration_user=nalven-migrator
manual_worker_user=nalven-pos-worker
manual_callback_user=nalven-pos-callback
stepup_issuer_user=nalven-pos-stepup
manual_homologator_user=nalven-pos-homologator
manual_vault_binder_user=nalven-pos-vault-binder
manual_profile_admin_issuer_user=nalven-pos-profile-admin
manual_profile_accounting_issuer_user=nalven-pos-profile-accounting
manual_profile_fiscal_issuer_user=nalven-pos-profile-fiscal
manual_sweeper_user=nalven-pos-manual-sweeper
node_version=v24.19.0
node_source=/home/nalven/.nvm/versions/node/${node_version}
node_target=/opt/node-${node_version}
seed_env=/etc/nalven/seed.env

apt-get update
DEBIAN_FRONTEND=noninteractive apt-get install -y curl nginx postgresql postgresql-contrib
if ! id "$service_user" >/dev/null 2>&1; then
  useradd --system --home-dir "$project_root" --shell /usr/sbin/nologin --user-group "$service_user"
fi
for authority_user in "$jobs_user" "$migration_user" "$manual_worker_user" "$manual_callback_user" "$stepup_issuer_user" "$manual_homologator_user" "$manual_vault_binder_user" "$manual_profile_admin_issuer_user" "$manual_profile_accounting_issuer_user" "$manual_profile_fiscal_issuer_user" "$manual_sweeper_user"; do
  if ! id "$authority_user" >/dev/null 2>&1; then
    useradd --system --home-dir "$project_root" --shell /usr/sbin/nologin --user-group "$authority_user"
  fi
done
for isolated_user in "$service_user" "$jobs_user" "$migration_user" "$manual_worker_user" "$manual_callback_user" "$stepup_issuer_user" "$manual_homologator_user" "$manual_vault_binder_user" "$manual_profile_admin_issuer_user" "$manual_profile_accounting_issuer_user" "$manual_profile_fiscal_issuer_user" "$manual_sweeper_user"; do
  isolated_uid=$(id -u "$isolated_user")
  isolated_gid=$(id -g "$isolated_user")
  isolated_primary_group=$(id -gn "$isolated_user")
  isolated_groups=$(id -Gn "$isolated_user")
  isolated_shell=$(getent passwd "$isolated_user" | cut -d: -f7)
  isolated_explicit_members=$(getent group "$isolated_user" | cut -d: -f4)
  if (( isolated_uid == 0 || isolated_uid >= 1000 || isolated_gid == 0 || isolated_gid >= 1000 )) \
      || [[ "$isolated_primary_group" != "$isolated_user" || "$isolated_groups" != "$isolated_user" \
        || -n "$isolated_explicit_members" || "$isolated_shell" != /usr/sbin/nologin ]]; then
    echo "Usuário de serviço inseguro ou com memberships cruzados: $isolated_user" >&2
    exit 1
  fi
done
if [[ ! -x "$node_source/bin/node" ]]; then
  echo "Node ${node_version} não foi encontrado em ${node_source}." >&2
  exit 1
fi
if [[ ! -x "$node_target/bin/node" ]]; then
  cp -a "$node_source" "$node_target"
  chown -R root:root "$node_target"
fi

install -d -o root -g "$service_user" -m 0751 "$project_root" "$project_root/releases"
install -d -o "$service_user" -g "$service_user" -m 0750 /var/lib/nalven/uploads
# Authorities isoladas precisam apenas atravessar o diretório pai até seu
# subdiretório 0750; o bit de leitura continua reservado a nalven-app.
install -d -o root -g "$service_user" -m 0751 /etc/nalven
install -d -o root -g "$service_user" -m 0750 /etc/nalven/tenants
install -d -o root -g root -m 0700 /etc/nalven/tenant-migrators
install -d -o root -g "$manual_worker_user" -m 0750 /etc/nalven/tenant-manual-workers
install -d -o root -g "$manual_callback_user" -m 0750 /etc/nalven/tenant-manual-callbacks
install -d -o root -g "$stepup_issuer_user" -m 0750 /etc/nalven/tenant-stepup-issuers
install -d -o root -g "$manual_homologator_user" -m 0750 /etc/nalven/tenant-manual-homologators
install -d -o root -g "$manual_vault_binder_user" -m 0750 /etc/nalven/tenant-manual-vault-binders
install -d -o root -g "$manual_profile_admin_issuer_user" -m 0750 /etc/nalven/tenant-manual-profile-admin-issuers
install -d -o root -g "$manual_profile_accounting_issuer_user" -m 0750 /etc/nalven/tenant-manual-profile-accounting-issuers
install -d -o root -g "$manual_profile_fiscal_issuer_user" -m 0750 /etc/nalven/tenant-manual-profile-fiscal-issuers
install -d -o root -g "$manual_sweeper_user" -m 0750 /etc/nalven/tenant-manual-sweepers
install -d -o root -g root -m 0755 /usr/local/libexec/nalven
for trusted_script in provision-tenant.sh reconcile-tenant-runtime-grants.sh cutover-tenant-manual-vault-binder.sh cutover-tenant-manual-profile-issuers.sh cutover-tenant-manual-sweeper.sh process-tenant-provisioning.sh install-tenant-migration-bundle.sh run-tenant-migration-bundle.sh; do
  install -o root -g root -m 0750 "$source_root/deploy/$trusted_script" "/usr/local/libexec/nalven/$trusted_script"
done
install -o root -g root -m 0755 "$source_root/deploy/process-tenant-jobs.sh" /usr/local/libexec/nalven/process-tenant-jobs.sh
install -o root -g root -m 0755 "$source_root/deploy/process-pos-manual-sweep.sh" /usr/local/libexec/nalven/process-pos-manual-sweep.sh
install -o root -g root -m 0640 "$source_root/deploy/reconcile-tenant-runtime-grants.sql" /usr/local/libexec/nalven/reconcile-tenant-runtime-grants.sql
/usr/local/libexec/nalven/install-tenant-migration-bundle.sh "$source_root"
if ! runuser -u postgres -- psql -tAc "SELECT 1 FROM pg_roles WHERE rolname='nalven_app'" | grep -q 1; then
  db_password="$(openssl rand -base64 36 | tr -d '\n')"
  escaped_password=${db_password//\'/\'\'}
  runuser -u postgres -- psql -v ON_ERROR_STOP=1 -c "CREATE ROLE nalven_app LOGIN PASSWORD '$escaped_password' NOSUPERUSER NOCREATEDB NOCREATEROLE;"
  runuser -u postgres -- createdb --owner=nalven_app nalven
  umask 0027
  printf 'NODE_ENV=production\nHOSTNAME=127.0.0.1\nPORT=3000\nCONTROL_DATABASE_URL=postgresql://nalven_app:%s@127.0.0.1:5432/nalven\n' "$db_password" > /etc/nalven/app.env
  chown root:"$service_user" /etc/nalven/app.env
  chmod 0640 /etc/nalven/app.env
fi

if ! grep -q '^CONTROL_DATABASE_URL=' /etc/nalven/app.env; then
  old_url=$(sed -n 's/^DATABASE_URL=//p' /etc/nalven/app.env)
  [[ -n "$old_url" ]] || { echo "URL do banco central ausente." >&2; exit 1; }
  printf 'CONTROL_DATABASE_URL=%s\n' "$old_url" >> /etc/nalven/app.env
fi
if ! grep -q '^ANALYTICS_IP_SALT=' /etc/nalven/app.env; then
  analytics_ip_salt="$(openssl rand -hex 32)"
  printf 'ANALYTICS_IP_SALT=%s\n' "$analytics_ip_salt" >> /etc/nalven/app.env
fi
if ! grep -q '^NALVEN_INTERNAL_JOB_TOKEN=' /etc/nalven/app.env; then
  internal_job_token="$(openssl rand -hex 48)"
  printf 'NALVEN_INTERNAL_JOB_TOKEN=%s\n' "$internal_job_token" >> /etc/nalven/app.env
fi
if ! grep -q '^POS_AGENT_TOKEN_PEPPER=' /etc/nalven/app.env; then
  pos_agent_token_pepper="$(openssl rand -hex 48)"
  printf 'POS_AGENT_TOKEN_PEPPER=%s\n' "$pos_agent_token_pepper" >> /etc/nalven/app.env
fi
if [[ ! -e "$seed_env" ]]; then
  seed_partial=$(mktemp /etc/nalven/.seed.env.XXXXXX)
  trap 'rm -f -- "${seed_partial:-}"' EXIT
  umask 0077
  printf 'SUPERADMIN_PASSWORD=%s\nDEMO_USER_PASSWORD=%s\n' \
    "$(openssl rand -base64 36 | tr -d '\n')" \
    "$(openssl rand -base64 36 | tr -d '\n')" > "$seed_partial"
  chown root:root "$seed_partial"
  chmod 0600 "$seed_partial"
  mv -- "$seed_partial" "$seed_env"
  trap - EXIT
fi

[[ -f /etc/nalven/app.env && ! -L /etc/nalven/app.env && $(stat -c '%u:%G:%a' /etc/nalven/app.env) == 0:nalven-app:640 ]] || {
  echo "/etc/nalven/app.env deve ser arquivo regular root:nalven-app:0640." >&2
  exit 1
}
[[ $(grep -Ec '^CONTROL_DATABASE_URL=postgres(ql)?://[^[:space:]]+$' /etc/nalven/app.env) -eq 1 ]] || {
  echo "CONTROL_DATABASE_URL deve aparecer exatamente uma vez e sem sintaxe shell em /etc/nalven/app.env." >&2
  exit 1
}
[[ $(grep -Ec '^POS_AGENT_TOKEN_PEPPER=[^[:space:]]{32,512}$' /etc/nalven/app.env) -eq 1 ]] || {
  echo "POS_AGENT_TOKEN_PEPPER deve aparecer exatamente uma vez, ter ao menos 32 bytes e não conter espaços." >&2
  exit 1
}
[[ -f "$seed_env" && ! -L "$seed_env" && $(stat -c '%u:%G:%a' "$seed_env") == 0:root:600 \
  && $(grep -Ec '^SUPERADMIN_PASSWORD=[^[:space:]]{20,512}$' "$seed_env") -eq 1 \
  && $(grep -Ec '^DEMO_USER_PASSWORD=[^[:space:]]{20,512}$' "$seed_env") -eq 1 \
  && $(wc -l < "$seed_env") -eq 2 ]] || {
  echo "$seed_env deve ser root:root:0600 e conter somente as duas credenciais iniciais." >&2
  exit 1
}
SUPERADMIN_PASSWORD=$(sed -n 's/^SUPERADMIN_PASSWORD=//p' "$seed_env")
DEMO_USER_PASSWORD=$(sed -n 's/^DEMO_USER_PASSWORD=//p' "$seed_env")
CONTROL_DATABASE_URL=$(sed -n 's/^CONTROL_DATABASE_URL=//p' /etc/nalven/app.env)
[[ "$CONTROL_DATABASE_URL" =~ ^postgres(ql)?://nalven_app:([^@[:space:]]+)@127\.0\.0\.1:5432/nalven$ ]] || { echo "CONTROL_DATABASE_URL deve apontar para nalven_app@127.0.0.1:5432/nalven." >&2; exit 1; }
control_password=${BASH_REMATCH[2]}
control_psql() { PGPASSWORD="$control_password" PGHOST=127.0.0.1 PGPORT=5432 PGUSER=nalven_app PGDATABASE=nalven psql --no-psqlrc --no-password "$@"; }
control_identity=$(control_psql -Atc "SELECT current_user || E'\\t' || current_database()")
[[ "$control_identity" == nalven_app$'\t'nalven ]] || {
  echo "CONTROL_DATABASE_URL não autenticou como nalven_app no banco nalven." >&2
  exit 1
}
provisioner_config_partial=$(mktemp /etc/nalven/.tenant-provisioner.env.XXXXXX)
trap 'rm -f -- "${provisioner_config_partial:-}"' EXIT
printf 'CONTROL_DATABASE_URL=%s\n' "$CONTROL_DATABASE_URL" > "$provisioner_config_partial"
chown root:root "$provisioner_config_partial"
chmod 0600 "$provisioner_config_partial"
mv -- "$provisioner_config_partial" /etc/nalven/tenant-provisioner.env
trap - EXIT
CONTROL_DATABASE_URL="$CONTROL_DATABASE_URL" /usr/local/libexec/nalven/run-tenant-migration-bundle.sh control-migrate
CONTROL_DATABASE_URL="$CONTROL_DATABASE_URL" SUPERADMIN_PASSWORD="$SUPERADMIN_PASSWORD" DEMO_USER_PASSWORD="$DEMO_USER_PASSWORD" /usr/local/libexec/nalven/run-tenant-migration-bundle.sh control-seed
unset SUPERADMIN_PASSWORD DEMO_USER_PASSWORD
for legacy_migrator_config in /etc/nalven/tenant-migrators/*.env; do
  [[ -e "$legacy_migrator_config" ]] || continue
  /usr/local/libexec/nalven/cutover-tenant-manual-vault-binder.sh "$legacy_migrator_config"
  /usr/local/libexec/nalven/cutover-tenant-manual-profile-issuers.sh "$legacy_migrator_config"
  /usr/local/libexec/nalven/cutover-tenant-manual-sweeper.sh "$legacy_migrator_config"
done
for tenant_config in /etc/nalven/tenants/*.env; do
  [[ -e "$tenant_config" ]] || continue
  tenant_key=$(basename "$tenant_config" .env)
  [[ $(stat -c '%u:%G:%a' "$tenant_config") == 0:nalven-app:640 ]] || {
    echo "Credencial runtime insegura para $tenant_key; esperado root:nalven-app:0640." >&2
    exit 1
  }
  [[ -f "/etc/nalven/tenant-migrators/$tenant_key.env" ]] || {
    echo "Tenant legado $tenant_key não possui credencial migrator root-only; bootstrap cancelado sem usar a URL runtime." >&2
    exit 1
  }
  for authority_file_spec in \
    "/etc/nalven/tenant-manual-workers/$tenant_key.env:nalven-pos-worker:640" \
    "/etc/nalven/tenant-manual-callbacks/$tenant_key.env:nalven-pos-callback:640" \
    "/etc/nalven/tenant-stepup-issuers/$tenant_key.env:nalven-pos-stepup:640" \
    "/etc/nalven/tenant-manual-homologators/$tenant_key.env:nalven-pos-homologator:640" \
    "/etc/nalven/tenant-manual-vault-binders/$tenant_key.env:nalven-pos-vault-binder:640" \
    "/etc/nalven/tenant-manual-profile-admin-issuers/$tenant_key.env:nalven-pos-profile-admin:640" \
    "/etc/nalven/tenant-manual-profile-accounting-issuers/$tenant_key.env:nalven-pos-profile-accounting:640" \
    "/etc/nalven/tenant-manual-profile-fiscal-issuers/$tenant_key.env:nalven-pos-profile-fiscal:640" \
    "/etc/nalven/tenant-manual-sweepers/$tenant_key.env:nalven-pos-manual-sweeper:640"; do
    authority_file=${authority_file_spec%%:*}
    authority_remainder=${authority_file_spec#*:}
    authority_group=${authority_remainder%%:*}
    authority_mode=${authority_remainder#*:}
    [[ -f "$authority_file" && $(stat -c '%u:%G:%a' "$authority_file") == "0:$authority_group:$authority_mode" ]] || {
      echo "Credencial de autoridade manual ausente ou insegura para $tenant_key: $authority_file" >&2
      exit 1
    }
  done
done
for migrator_config in /etc/nalven/tenant-migrators/*.env; do
  [[ -e "$migrator_config" ]] || continue
  tenant_key=$(basename "$migrator_config" .env)
  [[ -f "/etc/nalven/tenants/$tenant_key.env" ]] || { echo "Credencial runtime ausente para $tenant_key." >&2; exit 1; }
  [[ $(stat -c '%u:%a' "$migrator_config") == 0:600 ]] || { echo "Credencial migrator insegura para $tenant_key; esperado root:0600." >&2; exit 1; }
  migrator_database_url=$(sed -n 's/^TENANT_MIGRATOR_DATABASE_URL=//p' "$migrator_config")
  [[ "$migrator_database_url" =~ ^postgres(ql)?://[^[:space:]]+$ ]] || { echo "TENANT_MIGRATOR_DATABASE_URL ausente ou inválida em $migrator_config" >&2; exit 1; }
  bash /usr/local/libexec/nalven/reconcile-tenant-runtime-grants.sh "$migrator_config"
  TENANT_DATABASE_URL="$migrator_database_url" /usr/local/libexec/nalven/run-tenant-migration-bundle.sh tenant-migrate
  bash /usr/local/libexec/nalven/reconcile-tenant-runtime-grants.sh "$migrator_config"
done
unset migrator_database_url tenant_key
/usr/local/libexec/nalven/provision-tenant.sh org-demo demo

release="$project_root/releases/$(date -u +%Y%m%d%H%M%S)"
install -d -o root -g "$service_user" -m 0751 "$release"
cp -a "$source_root/.next/standalone/." "$release/"
install -d -o nalven -g "$service_user" -m 0755 "$release/.next/static"
cp -a "$source_root/.next/static/." "$release/.next/static/"
cp -a "$source_root/public" "$release/public"
chown -R root:"$service_user" "$release"
find "$release" -type d -exec chmod 0750 {} +
find "$release" -type f -exec chmod 0640 {} +
chmod 0751 "$release"
ln -sfn "$release" "$project_root/current"

install -o root -g root -m 0644 "$source_root/deploy/nalven.service" /etc/systemd/system/nalven.service
install -o root -g root -m 0644 "$source_root/deploy/nalven-pos-vault-binder@.service" /etc/systemd/system/nalven-pos-vault-binder@.service
install -o root -g root -m 0644 "$source_root/deploy/nalven-pos-profile-admin-issuer@.service" /etc/systemd/system/nalven-pos-profile-admin-issuer@.service
install -o root -g root -m 0644 "$source_root/deploy/nalven-pos-profile-accounting-issuer@.service" /etc/systemd/system/nalven-pos-profile-accounting-issuer@.service
install -o root -g root -m 0644 "$source_root/deploy/nalven-pos-profile-fiscal-issuer@.service" /etc/systemd/system/nalven-pos-profile-fiscal-issuer@.service
install -o root -g root -m 0644 "$source_root/deploy/nalven-pos-manual-sweep.service" /etc/systemd/system/nalven-pos-manual-sweep.service
install -o root -g root -m 0644 "$source_root/deploy/nalven-pos-manual-sweep.timer" /etc/systemd/system/nalven-pos-manual-sweep.timer
ln -sfn /usr/local/libexec/nalven/provision-tenant.sh /usr/local/sbin/nalven-provision-tenant
ln -sfn /usr/local/libexec/nalven/reconcile-tenant-runtime-grants.sh /usr/local/sbin/nalven-reconcile-tenant-runtime-grants
install -o root -g root -m 0750 "$source_root/deploy/backup-databases.sh" /usr/local/sbin/nalven-backup-databases
install -o root -g root -m 0644 "$source_root/deploy/nalven-backup.service" /etc/systemd/system/nalven-backup.service
install -o root -g root -m 0644 "$source_root/deploy/nalven-backup.timer" /etc/systemd/system/nalven-backup.timer
install -d -o root -g root -m 0755 /usr/local/libexec/nalven
install -o root -g root -m 0755 "$source_root/deploy/process-tenant-jobs.sh" /usr/local/libexec/nalven/process-tenant-jobs.sh
install -o root -g root -m 0750 "$source_root/deploy/provision-tenant.sh" /usr/local/libexec/nalven/provision-tenant.sh
install -o root -g root -m 0750 "$source_root/deploy/reconcile-tenant-runtime-grants.sh" /usr/local/libexec/nalven/reconcile-tenant-runtime-grants.sh
install -o root -g root -m 0640 "$source_root/deploy/reconcile-tenant-runtime-grants.sql" /usr/local/libexec/nalven/reconcile-tenant-runtime-grants.sql
install -o root -g root -m 0644 "$source_root/deploy/nalven-tenant-jobs.service" /etc/systemd/system/nalven-tenant-jobs.service
install -o root -g root -m 0644 "$source_root/deploy/nalven-tenant-jobs.timer" /etc/systemd/system/nalven-tenant-jobs.timer
install -o root -g root -m 0644 "$source_root/deploy/nalven-dfe-sync.service" /etc/systemd/system/nalven-dfe-sync.service
install -o root -g root -m 0644 "$source_root/deploy/nalven-dfe-sync.timer" /etc/systemd/system/nalven-dfe-sync.timer
install -o root -g root -m 0644 "$source_root/deploy/nalven-billing-jobs.service" /etc/systemd/system/nalven-billing-jobs.service
install -o root -g root -m 0644 "$source_root/deploy/nalven-billing-jobs.timer" /etc/systemd/system/nalven-billing-jobs.timer
install -o root -g root -m 0750 "$source_root/deploy/process-tenant-provisioning.sh" /usr/local/libexec/nalven/process-tenant-provisioning.sh
install -o root -g root -m 0750 "$source_root/deploy/install-tenant-migration-bundle.sh" /usr/local/libexec/nalven/install-tenant-migration-bundle.sh
install -o root -g root -m 0750 "$source_root/deploy/run-tenant-migration-bundle.sh" /usr/local/libexec/nalven/run-tenant-migration-bundle.sh
install -o root -g root -m 0644 "$source_root/deploy/nalven-tenant-provisioning.service" /etc/systemd/system/nalven-tenant-provisioning.service
install -o root -g root -m 0644 "$source_root/deploy/nalven-tenant-provisioning.timer" /etc/systemd/system/nalven-tenant-provisioning.timer
install -o root -g nalven-app -m 0750 "$source_root/deploy/process-pos-maintenance.sh" /usr/local/libexec/nalven/process-pos-maintenance.sh
install -o root -g root -m 0644 "$source_root/deploy/nalven-pos-maintenance.service" /etc/systemd/system/nalven-pos-maintenance.service
install -o root -g root -m 0644 "$source_root/deploy/nalven-pos-maintenance.timer" /etc/systemd/system/nalven-pos-maintenance.timer
install -o root -g root -m 0644 "$source_root/deploy/nalven-analytics.service" /etc/systemd/system/nalven-analytics.service
install -o root -g root -m 0644 "$source_root/deploy/nalven-analytics.timer" /etc/systemd/system/nalven-analytics.timer
install -o root -g root -m 0644 "$source_root/deploy/nginx.conf" /etc/nginx/sites-available/nalven
ln -sfn /etc/nginx/sites-available/nalven /etc/nginx/sites-enabled/nalven
rm -f /etc/nginx/sites-enabled/default
nginx -t
install -o root -g root -m 0750 "$source_root/deploy/install-internal-job-runner.sh" /usr/local/libexec/nalven/install-internal-job-runner.sh
/usr/local/libexec/nalven/install-internal-job-runner.sh "$source_root"
systemctl daemon-reload
systemctl enable --now postgresql nginx nalven nalven-backup.timer nalven-tenant-jobs.timer nalven-tenant-provisioning.timer nalven-dfe-sync.timer nalven-billing-jobs.timer nalven-analytics.timer nalven-pos-maintenance.timer nalven-pos-manual-sweep.timer
systemctl restart nginx nalven
for attempt in {1..30}; do
  if curl --fail --silent --show-error http://127.0.0.1/ >/dev/null; then break; fi
  [[ "$attempt" -lt 30 ]] || { echo "A aplicação não ficou saudável." >&2; exit 1; }
  sleep 1
done
echo "Deploy Nalven concluído em $release"
