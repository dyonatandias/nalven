#!/usr/bin/env bash
set -euo pipefail

readonly backup_root=/var/backups/nalven
readonly timestamp="$(date -u +%Y%m%dT%H%M%SZ)"
readonly retention_days="${NALVEN_BACKUP_RETENTION_DAYS:-30}"
readonly manifest="$backup_root/manifest-$timestamp.sha256"
readonly manifest_partial="$manifest.partial"
partial_dump=""
published=false
created_dumps=()

exec 9>/run/nalven-backup/backup.lock
if ! flock -n 9; then
  echo "Já existe um backup NALVEN em execução." >&2
  exit 1
fi

if [[ ! "$retention_days" =~ ^[0-9]+$ ]] || (( retention_days < 7 || retention_days > 365 )); then
  echo "NALVEN_BACKUP_RETENTION_DAYS deve estar entre 7 e 365." >&2
  exit 1
fi
if [[ -e "$manifest" || -e "$manifest_partial" ]]; then
  echo "Já existe artefato de backup para o timestamp $timestamp; execução cancelada." >&2
  exit 1
fi

cleanup() {
  if [[ -n "$partial_dump" ]]; then rm -f -- "$partial_dump"; fi
  rm -f -- "$manifest_partial"
  if [[ "$published" != true ]]; then
    rm -f -- "$manifest"
    if (( ${#created_dumps[@]} )); then rm -f -- "${created_dumps[@]}"; fi
  fi
  unset PGDATABASE
}
trap cleanup EXIT
trap 'exit 1' HUP INT TERM

install -d -o postgres -g postgres -m 0700 "$backup_root"

dump_database() {
  local label="$1"
  local database="$2"
  local final_dump="$backup_root/$label-$timestamp.dump"
  local checksum

  if [[ ! "$label" =~ ^[A-Za-z0-9][A-Za-z0-9._-]{0,159}$ ]]; then
    echo "Identificador de backup inválido." >&2
    return 1
  fi
  if [[ -e "$final_dump" || -e "$final_dump.partial" ]]; then
    echo "Já existe dump para $label no timestamp $timestamp; execução cancelada." >&2
    return 1
  fi
  partial_dump="$final_dump.partial"
  export PGDATABASE="$database"
  runuser -u postgres -p -- pg_dump --format=custom --no-password --file="$partial_dump"
  unset PGDATABASE
  runuser -u postgres -- pg_restore --list "$partial_dump" >/dev/null
  checksum=$(sha256sum "$partial_dump" | awk '{print $1}')
  if [[ ! "$checksum" =~ ^[0-9a-f]{64}$ ]]; then
    echo "Não foi possível calcular o checksum do backup $label." >&2
    return 1
  fi
  chown postgres:postgres "$partial_dump"
  chmod 0600 "$partial_dump"
  created_dumps+=("$final_dump")
  mv -- "$partial_dump" "$final_dump"
  partial_dump=""
  printf '%s  %s\n' "$checksum" "$(basename "$final_dump")" >> "$manifest_partial"
}

: > "$manifest_partial"
chmod 0600 "$manifest_partial"
dump_database "control" "nalven"
tenant_inventory=$(runuser -u postgres -- psql --no-psqlrc --no-password \
  --dbname=nalven --tuples-only --no-align --field-separator=$'\t' \
  --set=ON_ERROR_STOP=1 \
  --command="SELECT config_key, database_name FROM tenant_databases ORDER BY config_key")
while IFS=$'\t' read -r tenant_config_key tenant_database_name; do
  [[ -n "$tenant_config_key" || -n "$tenant_database_name" ]] || continue
  if [[ ! "$tenant_config_key" =~ ^[A-Za-z0-9][A-Za-z0-9._-]{0,159}$ ]]; then
    echo "Configuração de tenant com nome inválido no catálogo de controle." >&2
    exit 1
  fi
  if [[ ! "$tenant_database_name" =~ ^[a-z][a-z0-9_]{0,62}$ ]]; then
    echo "Nome de banco tenant inválido no catálogo de controle." >&2
    exit 1
  fi
  dump_database "tenant-$tenant_config_key" "$tenant_database_name"
done <<< "$tenant_inventory"
unset tenant_inventory tenant_config_key tenant_database_name

chown postgres:postgres "$manifest_partial"
mv -- "$manifest_partial" "$manifest"
runuser -u postgres -- bash -c 'cd "$1" && sha256sum --check --strict "$(basename "$2")" >/dev/null' _ "$backup_root" "$manifest"
published=true

while IFS= read -r -d '' expired_manifest; do
  while IFS= read -r backup_checksum backup_name; do
    if [[ ! "$backup_checksum" =~ ^[0-9a-f]{64}$ || ! "$backup_name" =~ ^(control|tenant-[A-Za-z0-9][A-Za-z0-9._-]{0,159})-[0-9]{8}T[0-9]{6}Z\.dump$ ]]; then
      echo "Manifesto antigo inválido; retenção interrompida para $expired_manifest." >&2
      exit 1
    fi
    rm -f -- "$backup_root/$backup_name"
  done < "$expired_manifest"
  rm -f -- "$expired_manifest"
done < <(find "$backup_root" -maxdepth 1 -type f -name 'manifest-????????T??????Z.sha256' -mtime "+$retention_days" -print0)

find "$backup_root" -maxdepth 1 -type f \( -name '*.dump.partial' -o -name '*.sha256.partial' \) -mtime +1 -delete
