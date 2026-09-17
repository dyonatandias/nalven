#!/usr/bin/env bash
# Root-owned, narrowly scoped entrypoint. No arbitrary paths, commands or caller environment.
set -euo pipefail
export PATH=/opt/node-v24.19.0/bin:/usr/sbin:/usr/bin:/sbin:/bin
export PAGER=cat
unset BASH_ENV ENV NODE_OPTIONS NODE_PATH PGOPTIONS PGSERVICE PGSERVICEFILE PGPASSWORD PGHOST PGHOSTADDR PGPORT PGUSER PGDATABASE
[[ $EUID == 0 && $# == 1 ]] || { echo 'Use a manutenção instalada com uma única operação.' >&2; exit 1; }
readonly installed=/usr/local/libexec/nalven/production-maintenance.sh
[[ $(readlink -f "$0") == "$installed" && $(stat -c '%u:%g:%a' "$installed") == 0:0:750 ]] || exit 1
readonly pointer=/usr/local/libexec/nalven/production-release-candidate
readonly migrator=/usr/local/libexec/nalven/run-tenant-migration-bundle.sh
readonly installer=/usr/local/libexec/nalven/install-tenant-migration-bundle.sh
readonly grants=/usr/local/libexec/nalven/reconcile-tenant-runtime-grants.sh
readonly approvals=/etc/nalven/migration-approvals.sha256
control() { runuser -u postgres -- psql -X --no-password -P pager=off -v ON_ERROR_STOP=1 -d nalven "$@"; }
tenant() { local database=$1; shift; [[ "$database" =~ ^nalven_t_[a-z0-9_]+$ ]] || return 1; runuser -u postgres -- psql -X --no-password -P pager=off -v ON_ERROR_STOP=1 -d "$database" "$@"; }
inventory() { control -At -F '|' -c "SELECT database_name,config_key FROM tenant_databases WHERE status='active' ORDER BY database_name"; }
maintenance_lock() {
  # Reuse the publisher's inherited open-file description; independent calls open their own.
  if [[ $(readlink /proc/$$/fd/9 2>/dev/null || true) != /run/lock/nalven-production-maintenance.lock ]]; then
    exec 9>/run/lock/nalven-production-maintenance.lock
  fi
  flock -n 9 || { echo 'Outra manutenção está em andamento.' >&2; exit 1; }
}
candidate() {
  candidate_path=$(readlink -f "$pointer")
  [[ "$candidate_path" == /var/lib/nalven-production-build.* && -d "$candidate_path" && ! -L "$candidate_path" ]] || { echo 'Candidato revisado ausente.' >&2; exit 1; }
  [[ -z $(find "$candidate_path" \( ! -user root -o \( ! -type l -perm /022 \) \) -print -quit) ]] || { echo 'Candidato não está selado.' >&2; exit 1; }
  while IFS= read -r -d '' link; do [[ $(readlink -f "$link") == "$candidate_path"/* ]] || { echo 'Symlink externo no candidato.' >&2; exit 1; }; done < <(find "$candidate_path" -type l -print0)
  (cd "$candidate_path" && sha256sum --quiet -c RELEASE.sha256)
  [[ -f "$candidate_path/.next/standalone/server.js" ]]
}
check_migrations() {
  local database=$1 schema=$2 allow_pending=$3 name checksum local_checksum
  local directory="$candidate_path/prisma/$schema/migrations"
  local applied=() rows
  rows=$(runuser -u postgres -- psql -X --no-password -P pager=off -v ON_ERROR_STOP=1 -d "$database" -At -F '|' -c "SELECT migration_name,checksum FROM _prisma_migrations WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL ORDER BY migration_name") || return 1
  while IFS='|' read -r name checksum; do
    [[ -n "$name" ]] || continue
    [[ "$name" =~ ^[0-9]{14}_[a-z0-9_]+$ && -f "$directory/$name/migration.sql" ]] || { echo "Migration não reconhecida em $database." >&2; return 1; }
    local_checksum=$(sha256sum "$directory/$name/migration.sql"); local_checksum=${local_checksum%% *}
    [[ "$local_checksum" == "$checksum" ]] || { echo "Checksum divergente: $database / $name" >&2; return 1; }
    applied+=("$name")
  done <<< "$rows"
  [[ ${#applied[@]} -gt 0 ]] || return 1
  [[ $(runuser -u postgres -- psql -X --no-password -P pager=off -v ON_ERROR_STOP=1 -d "$database" -Atqc "SELECT count(*) FROM _prisma_migrations WHERE finished_at IS NULL AND rolled_back_at IS NULL") == 0 ]] || { echo "Migration interrompida em $database." >&2; return 1; }
  for migration_path in "$directory"/*; do
    [[ -d "$migration_path" ]] || continue; name=${migration_path##*/}
    if [[ " ${applied[*]} " != *" $name "* ]]; then
      local_checksum=$(sha256sum "$directory/$name/migration.sql"); local_checksum=${local_checksum%% *}
      [[ "$allow_pending" == yes && -f "$approvals" && ! -L "$approvals" && $(stat -c '%u:%g:%a' "$approvals") == 0:0:600 ]] &&
        grep -Fxq "$local_checksum  $schema/$name/migration.sql" "$approvals" || { echo "Migration pendente não autorizada: $database / $name" >&2; return 1; }
      echo "Pendente autorizado: $database / $name"
    fi
  done
}
http_verify() {
  local path expected status
  for mapping in '/:200' '/api/erp:401' '/api/saas:403' '/api/erp/production:401' '/api/erp/production/operations:401'; do
    path=${mapping%:*}; expected=${mapping##*:}
    status=$(curl --silent --show-error --max-time 15 --output /dev/null --write-out '%{http_code}' "http://127.0.0.1:3000$path")
    [[ "$status" == "$expected" ]] || { echo "HTTP inesperado: $path = $status" >&2; return 1; }; echo "$path $status"
  done
  status=$(curl --silent --show-error --max-time 15 --output /dev/null --write-out '%{http_code}' -X POST -H 'Origin: https://external.invalid' -H 'Content-Type: application/json' --data '{"action":"order.create"}' http://127.0.0.1:3000/api/erp/production/operations)
  [[ "$status" == 403 ]] || return 1
}
case "$1" in
  status)
    systemctl is-active nalven.service
    readlink -f /srv/nalven/current
    control -c 'SELECT database_name,status,schema_version FROM tenant_databases ORDER BY database_name'
    ;;
  migrate)
    maintenance_lock
    candidate; check_migrations nalven control yes
    tenant_inventory=$(inventory); [[ -n "$tenant_inventory" ]] || exit 1
    while IFS='|' read -r database key; do [[ "$key" =~ ^[a-z0-9-]+$ ]] || exit 1; check_migrations "$database" tenant yes; done <<< "$tenant_inventory"
    systemctl start nalven-backup.service
    [[ $(systemctl show nalven-backup.service -p Result --value) == success ]] || exit 1
    "$installer" "$candidate_path"
    control_config=/etc/nalven/control-migrator.env
    [[ -f "$control_config" && ! -L "$control_config" && $(stat -c '%u:%g:%a' "$control_config") == 0:0:600 ]]
    [[ $(grep -c '^CONTROL_DATABASE_URL=' "$control_config") == 1 ]]
    connection=$(sed -n 's/^CONTROL_DATABASE_URL=//p' "$control_config")
    [[ "$connection" =~ ^postgresql://nalven_control_migrator:[a-f0-9]{64}@127\.0\.0\.1:5432/nalven$ ]]
    CONTROL_DATABASE_URL="$connection" "$migrator" control-migrate
    unset connection
    control < /usr/local/libexec/nalven/control-runtime-grants.sql
    check_migrations nalven control no
    while IFS='|' read -r database key; do
      config="/etc/nalven/tenant-migrators/$key.env"
      [[ -f "$config" && ! -L "$config" && $(stat -c '%u:%g:%a' "$config") == 0:0:600 ]] || exit 1
      [[ $(grep -c '^TENANT_MIGRATOR_DATABASE_URL=' "$config") == 1 ]] || exit 1
      connection=$(sed -n 's/^TENANT_MIGRATOR_DATABASE_URL=//p' "$config")
      [[ "$connection" =~ ^postgres(ql)?://([a-z][a-z0-9_]*):[a-f0-9]{64}@127\.0\.0\.1:5432/([a-z][a-z0-9_]*)$ && ${BASH_REMATCH[3]} == "$database" && ${BASH_REMATCH[2]} == "${database}_migrator" ]] || { echo 'Identidade migrator divergente.' >&2; exit 1; }
      TENANT_DATABASE_URL="$connection" "$migrator" tenant-migrate
      unset connection
      "$grants" "$config"
      check_migrations "$database" tenant no
      latest_version=$(tenant "$database" -Atqc "SELECT max(migration_name) FROM _prisma_migrations WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL")
      control -v database="$database" -v version="$latest_version" <<'SQL'
UPDATE tenant_databases SET schema_version=:'version',updated_at=now() WHERE database_name=:'database';
SQL
    done <<< "$tenant_inventory"
    echo 'Migrações e grants verificados; nenhum seed foi executado.'
    ;;
  publish)
    maintenance_lock
    candidate; check_migrations nalven control no
    tenant_inventory=$(inventory); [[ -n "$tenant_inventory" ]] || exit 1
    while IFS='|' read -r database key; do check_migrations "$database" tenant no; done <<< "$tenant_inventory"
    previous=$(readlink -f /srv/nalven/current)
    [[ "$previous" == /srv/nalven/releases/* && -d "$previous" ]] || exit 1
    release=$(mktemp -d /srv/nalven/releases/production-XXXXXXXX)
    cp -a "$candidate_path/.next/standalone/." "$release/"
    install -d -m 0750 "$release/.next/static"
    cp -a "$candidate_path/.next/static/." "$release/.next/static/"
    cp -a "$candidate_path/public" "$release/public"
    chown -hR root:nalven-app "$release"
    find "$release" -type d -exec chmod 0750 {} +
    find "$release" -type f -exec chmod 0640 {} +
    chmod 0751 "$release"
    rollback() { trap - ERR; ln -sfn "$previous" /srv/nalven/current.next; mv -Tf /srv/nalven/current.next /srv/nalven/current; systemctl restart nalven.service; echo 'Release anterior restaurado; migrations aditivas preservadas.' >&2; }
    trap rollback ERR
    ln -sfn "$release" /srv/nalven/current.next; mv -Tf /srv/nalven/current.next /srv/nalven/current
    systemctl restart nalven.service
    ready=false
    for attempt in {1..30}; do if curl -fsS --max-time 3 http://127.0.0.1:3000/api/health >/dev/null; then ready=true; break; fi; sleep 1; done
    [[ "$ready" == true ]]; http_verify
    trap - ERR
    echo "PUBLICATION_OK $release"
    ;;
  verify) http_verify ;;
  *) echo 'Operação não permitida.' >&2; exit 1 ;;
esac
