#!/usr/bin/env bash
set -euo pipefail

[[ ${EUID:-$(id -u)} -eq 0 ]] || { echo "Executor de migração exige root para trocar ao usuário isolado." >&2; exit 1; }
[[ $(readlink -f -- "$0") == /usr/local/libexec/nalven/run-tenant-migration-bundle.sh ]] || {
  echo "Executor recusado fora do artefato root-owned instalado." >&2
  exit 1
}
readonly action=${1:?Informe a ação do bundle}
readonly executor_user=nalven-migrator
readonly current_link=/usr/local/libexec/nalven/tenant-migration-current
readonly node=/opt/node-v24.19.0/bin/node

executor_uid=$(id -u "$executor_user" 2>/dev/null || true)
executor_gid=$(id -g "$executor_user" 2>/dev/null || true)
executor_members=$(getent group "$executor_user" 2>/dev/null | cut -d: -f4 || true)
[[ "$executor_uid" =~ ^[0-9]+$ && "$executor_gid" =~ ^[0-9]+$ \
    && "$executor_uid" -gt 0 && "$executor_uid" -lt 1000 \
    && "$executor_gid" -gt 0 && "$executor_gid" -lt 1000 \
    && $(id -gn "$executor_user") == "$executor_user" \
    && $(id -Gn "$executor_user") == "$executor_user" \
    && -z "$executor_members" \
    && $(getent passwd "$executor_user" | cut -d: -f7) == /usr/sbin/nologin ]] || {
  echo "Usuário nalven-migrator ausente, inseguro ou com memberships cruzados." >&2
  exit 1
}

bundle=$(readlink -f -- "$current_link" 2>/dev/null || true)
[[ "$bundle" == /usr/local/libexec/nalven/tenant-migration-bundles/* && -d "$bundle" && ! -L "$bundle" ]] || {
  echo "Bundle de migração root-owned ausente ou inválido." >&2
  exit 1
}
[[ -z $(find "$bundle" \( ! -user root -o ! -group root -o \( ! -type l -perm /022 \) \) -print -quit) ]] || {
  echo "Bundle de migração contém artefato não-root ou gravável fora de root." >&2
  exit 1
}
[[ -z $(find "$bundle" ! -type f ! -type d ! -type l -print -quit) ]] || {
  echo "Bundle de migração contém tipo de arquivo não permitido." >&2
  exit 1
}
while IFS= read -r -d '' bundle_link; do
  [[ $(readlink -f -- "$bundle_link") == "$bundle"/* ]] || { echo "Bundle contém symlink externo." >&2; exit 1; }
done < <(find "$bundle" -type l -print0)
(cd "$bundle" && sha256sum --quiet -c MANIFEST.sha256) || { echo "Digest do bundle de migração divergente." >&2; exit 1; }
cd "$bundle"

case "$action" in
  control-migrate)
    [[ ${CONTROL_DATABASE_URL:-} =~ ^postgres(ql)?://[^[:space:]]+$ ]] || { echo "CONTROL_DATABASE_URL inválida." >&2; exit 1; }
    runuser -u "$executor_user" -- env -i HOME=/nonexistent PATH=/opt/node-v24.19.0/bin:/usr/bin:/bin \
      CONTROL_DATABASE_URL="$CONTROL_DATABASE_URL" "$node" "$bundle/node_modules/prisma/build/index.js" migrate deploy \
      --config "$bundle/prisma.control.config.ts"
    ;;
  control-seed)
    [[ ${CONTROL_DATABASE_URL:-} =~ ^postgres(ql)?://[^[:space:]]+$ ]] || { echo "CONTROL_DATABASE_URL inválida." >&2; exit 1; }
    [[ ${SUPERADMIN_PASSWORD:-} =~ ^[^[:space:]]{20,512}$ ]] || { echo "SUPERADMIN_PASSWORD inicial inválida." >&2; exit 1; }
    [[ ${DEMO_USER_PASSWORD:-} =~ ^[^[:space:]]{20,512}$ ]] || { echo "DEMO_USER_PASSWORD inválida." >&2; exit 1; }
    runuser -u "$executor_user" -- env -i HOME=/nonexistent PATH=/opt/node-v24.19.0/bin:/usr/bin:/bin \
      CONTROL_DATABASE_URL="$CONTROL_DATABASE_URL" SUPERADMIN_PASSWORD="$SUPERADMIN_PASSWORD" DEMO_USER_PASSWORD="$DEMO_USER_PASSWORD" \
      "$node" "$bundle/node_modules/tsx/dist/cli.mjs" "$bundle/prisma/control/seed.ts"
    ;;
  tenant-migrate)
    [[ ${TENANT_DATABASE_URL:-} =~ ^postgres(ql)?://[^[:space:]]+$ ]] || { echo "TENANT_DATABASE_URL inválida." >&2; exit 1; }
    runuser -u "$executor_user" -- env -i HOME=/nonexistent PATH=/opt/node-v24.19.0/bin:/usr/bin:/bin \
      TENANT_DATABASE_URL="$TENANT_DATABASE_URL" "$node" "$bundle/node_modules/prisma/build/index.js" migrate deploy \
      --config "$bundle/prisma.tenant.config.ts"
    ;;
  tenant-seed)
    [[ ${TENANT_DATABASE_URL:-} =~ ^postgres(ql)?://[^[:space:]]+$ ]] || { echo "TENANT_DATABASE_URL inválida." >&2; exit 1; }
    runuser -u "$executor_user" -- env -i HOME=/nonexistent PATH=/opt/node-v24.19.0/bin:/usr/bin:/bin \
      TENANT_DATABASE_URL="$TENANT_DATABASE_URL" "$node" "$bundle/node_modules/tsx/dist/cli.mjs" "$bundle/prisma/tenant/seed.ts"
    ;;
  latest-tenant-schema)
    latest=""
    for migration_path in "$bundle"/prisma/tenant/migrations/*; do
      [[ -d "$migration_path" ]] && latest=$(basename "$migration_path")
    done
    [[ -n "$latest" ]] || { echo "Nenhuma migration tenant no bundle." >&2; exit 1; }
    printf '%s\n' "$latest"
    ;;
  *)
    echo "Ação de bundle inválida: $action" >&2
    exit 1
    ;;
esac
