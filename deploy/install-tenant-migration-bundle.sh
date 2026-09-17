#!/usr/bin/env bash
set -euo pipefail

[[ ${EUID:-$(id -u)} -eq 0 ]] || { echo "Instalação do bundle de migração exige root." >&2; exit 1; }
[[ $(readlink -f -- "$0") == /usr/local/libexec/nalven/install-tenant-migration-bundle.sh ]] || {
  echo "Instalador recusado fora do artefato root-owned instalado." >&2
  exit 1
}

readonly source_root=${1:?Informe o checkout de origem}
readonly bundles_root=/usr/local/libexec/nalven/tenant-migration-bundles
readonly current_link=/usr/local/libexec/nalven/tenant-migration-current
for required_source in node_modules prisma generated lib/password.ts lib/integrations/transactional-email-catalog.ts prisma.control.config.ts prisma.tenant.config.ts; do
  [[ -e "$source_root/$required_source" ]] || { echo "Fonte do bundle ausente: $required_source" >&2; exit 1; }
done

install -d -o root -g root -m 0755 "$bundles_root"
staging=$(mktemp -d "$bundles_root/.staging.XXXXXX")
trap 'rm -rf -- "${staging:-/nonexistent}"' EXIT
cp -a -- "$source_root/node_modules" "$source_root/prisma" "$source_root/generated" \
  "$source_root/prisma.control.config.ts" "$source_root/prisma.tenant.config.ts" "$staging/"
install -d -m 0755 "$staging/lib"
cp -a -- "$source_root/lib/password.ts" "$staging/lib/password.ts"
install -d -m 0755 "$staging/lib/integrations"
cp -a -- "$source_root/lib/integrations/transactional-email-catalog.ts" \
  "$staging/lib/integrations/transactional-email-catalog.ts"
chown -hR root:root "$staging"
find "$staging" -type d -exec chmod 0755 {} +
find "$staging" -type f -perm /111 -exec chmod 0755 {} +
find "$staging" -type f ! -perm /111 -exec chmod 0644 {} +
[[ -z $(find "$staging" ! -type f ! -type d ! -type l -print -quit) ]] || {
  echo "Bundle contém tipo de arquivo não permitido." >&2
  exit 1
}

while IFS= read -r -d '' bundle_link; do
  resolved_link=$(readlink -f -- "$bundle_link")
  [[ "$resolved_link" == "$staging"/* ]] || {
    echo "Bundle contém symlink externo: $bundle_link" >&2
    exit 1
  }
done < <(find "$staging" -type l -print0)

(
  cd "$staging"
  find . -type f ! -name MANIFEST.sha256 -print0 | sort -z | xargs -0 sha256sum > MANIFEST.sha256
)
chown root:root "$staging/MANIFEST.sha256"
chmod 0644 "$staging/MANIFEST.sha256"
bundle_id="$(date -u +%Y%m%d%H%M%S)-$$"
final_bundle="$bundles_root/$bundle_id"
mv -- "$staging" "$final_bundle"
trap - EXIT
ln -sfn "$final_bundle" "$current_link.next"
mv -Tf -- "$current_link.next" "$current_link"
printf '%s\n' "$final_bundle"
