#!/usr/bin/env bash
# Installed root-owned publisher: fixed checkout, no arguments, no arbitrary root commands.
set -euo pipefail
[[ $EUID == 0 && $# == 0 ]] || { echo 'Execute com sudo, sem argumentos.' >&2; exit 1; }
export PATH=/opt/node-v24.19.0/bin:/usr/sbin:/usr/bin:/sbin:/bin
unset BASH_ENV ENV NODE_OPTIONS NODE_PATH PGOPTIONS PGSERVICE PGSERVICEFILE
readonly executor=/usr/local/libexec/nalven/production-maintenance.sh
readonly pointer=/usr/local/libexec/nalven/production-release-candidate
readonly installed=/usr/local/libexec/nalven/publish-current.sh
[[ $(readlink -f "$0") == "$installed" && $(stat -c '%u:%g:%a' "$installed") == 0:0:750 ]]
exec 9>/run/lock/nalven-production-maintenance.lock
flock -n 9 || { echo 'Outra publicação ou migração está em andamento.' >&2; exit 1; }
readonly checkout=/home/nalven/nalven
[[ -d "$checkout" && ! -L "$checkout" ]]
source_snapshot=$(mktemp -d /var/lib/nalven-build-work.XXXXXX)
items=(app components db lib prisma public scripts tests vendor deploy docs package.json package-lock.json next.config.ts next-env.d.ts proxy.ts tsconfig.json prisma.control.config.ts prisma.tenant.config.ts postcss.config.mjs eslint.config.mjs)
for item in "${items[@]}"; do
  [[ -e "$checkout/$item" && ! -L "$checkout/$item" ]] || { echo "Origem inválida: $item" >&2; exit 1; }
  cp -a "$checkout/$item" "$source_snapshot/"
done
validate_links() {
  local root=$1 link
  [[ -z $(find "$root" ! -type f ! -type d ! -type l -print -quit) ]]
  while IFS= read -r -d '' link; do
    [[ $(readlink -f "$link") == "$root"/* ]] || { echo 'Symlink externo rejeitado.' >&2; return 1; }
  done < <(find "$root" -type l -print0)
}
validate_links "$source_snapshot"
# Refuse edits to the restored historical migration instead of silently replacing it.
historical=prisma/tenant/migrations/20260902150000_transactional_email_catalog/migration.sql
approved=$(readlink -f "$pointer")
[[ "$approved" == /var/lib/nalven-production-build.* ]]
[[ $(stat -c '%u' "$approved/$historical") == 0 ]]
[[ $(sha256sum "$approved/$historical" | cut -d ' ' -f 1) == e900946fe40901ea1fe5037d971deec0b5910378fe45e940e5261c1ae1d85d4e ]]
cmp "$approved/$historical" "$source_snapshot/$historical"
chown -hR nalven:nalven "$source_snapshot"
npm_cache=$(mktemp -d /var/lib/nalven-npm-cache.XXXXXX)
chown nalven:nalven "$npm_cache"
(
  cd "$source_snapshot"
  runuser -u nalven -- env -i PATH="$PATH" npm_config_cache="$npm_cache" npm_config_userconfig=/dev/null /opt/node-v24.19.0/bin/npm ci --ignore-scripts --no-audit --no-fund
  runuser -u nalven -- env -i PATH="$PATH" CONTROL_DATABASE_URL=postgresql://test:test@127.0.0.1:1/test TENANT_DATABASE_URL=postgresql://test:test@127.0.0.1:1/test /opt/node-v24.19.0/bin/npm run db:generate
  runuser -u nalven -- env -i PATH="$PATH" CONTROL_DATABASE_URL=postgresql://test:test@127.0.0.1:1/test TENANT_DATABASE_URL=postgresql://test:test@127.0.0.1:1/test /opt/node-v24.19.0/bin/npm run test:unit
  runuser -u nalven -- env -i PATH="$PATH" /opt/node-v24.19.0/bin/npm run lint
)
[[ -x "$executor" && $(stat -c '%u:%g:%a' "$executor") == 0:0:750 ]]
[[ -f /etc/nalven/app.env && ! -L /etc/nalven/app.env ]]
[[ $(stat -c '%u' /etc/nalven/app.env) == 0 ]]
[[ $(sed -n '/^CONTROL_DATABASE_URL=/p' /etc/nalven/app.env | wc -l) == 1 ]]
connection=$(sed -n 's/^CONTROL_DATABASE_URL=//p' /etc/nalven/app.env)
[[ "$connection" =~ ^postgres(ql)?://[^[:space:]]+@127\.0\.0\.1:5432/nalven$ ]] || { echo 'Banco de controle inesperado.' >&2; exit 1; }
echo 'Gerando release com consultas somente de leitura ao banco de produção.'
(
  cd "$source_snapshot"
  # Transfer the credential through stdin, never through process arguments.
  printf '%s\n' "$connection" | runuser -u nalven -- env -i PATH="$PATH" NODE_ENV=production NODE_OPTIONS=--max-old-space-size=4096 \
    PGOPTIONS='-c default_transaction_read_only=on' /bin/bash -c '
      IFS= read -r CONTROL_DATABASE_URL
      [[ -n "$CONTROL_DATABASE_URL" ]] || exit 1
      export CONTROL_DATABASE_URL
      exec /opt/node-v24.19.0/bin/node node_modules/next/dist/bin/next build
    '
)
unset connection
validate_links "$source_snapshot"
[[ -f "$source_snapshot/.next/standalone/server.js" && -d "$source_snapshot/.next/static" ]]
candidate=$(mktemp -d /var/lib/nalven-production-build.XXXXXX)
cp -a "$source_snapshot/." "$candidate/"
chown -hR root:root "$candidate"
find "$candidate" ! -type l -exec chmod go-w {} +
chmod 0755 "$candidate"
echo "SEALED_CANDIDATE $candidate"
while IFS= read -r -d '' link; do
  [[ $(readlink -f "$link") == "$candidate"/* ]] || { echo 'Symlink externo: publicação cancelada.' >&2; exit 1; }
done < <(find "$candidate" -type l -print0)
(
  cd "$candidate"
  find . -type f ! -name RELEASE.sha256 -print0 | sort -z | xargs -0 sha256sum > RELEASE.sha256
)
systemctl start nalven-backup.service
[[ $(systemctl show nalven-backup.service -p Result --value) == success ]]
previous_candidate=$(readlink -f "$pointer")
previous_release=$(readlink -f /srv/nalven/current)
[[ "$previous_candidate" == /var/lib/nalven-production-build.* && "$previous_release" == /srv/nalven/releases/* ]]
rollback() {
  trap - ERR
  ln -sfn "$previous_candidate" "$pointer.next"; mv -Tf "$pointer.next" "$pointer"
  if [[ $(readlink -f /srv/nalven/current) != "$previous_release" ]]; then
    ln -sfn "$previous_release" /srv/nalven/current.next
    mv -Tf /srv/nalven/current.next /srv/nalven/current
    systemctl restart nalven.service
  fi
  echo 'Publicação interrompida; ponteiros anteriores restaurados.' >&2
}
trap rollback ERR
ln -sfn "$candidate" "$pointer.next"; mv -Tf "$pointer.next" "$pointer"
"$executor" publish
"$executor" verify
trap - ERR
echo 'Publicação concluída e verificada.'
