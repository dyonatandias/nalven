#!/usr/bin/env bash
echo 'Fluxo legado desativado. Use: sudo -n /usr/local/libexec/nalven/publish-current.sh. Migrations exigem aprovação separada.' >&2
exit 1
# One-time publication of the reviewed 2026-09-08 snapshot. Requires authenticated root.
set -euo pipefail
[[ $EUID == 0 && $# == 0 ]] || { echo 'Execute com sudo, sem argumentos.' >&2; exit 1; }
export PATH=/opt/node-v24.19.0/bin:/usr/sbin:/usr/bin:/sbin:/bin
unset BASH_ENV ENV NODE_OPTIONS NODE_PATH PGOPTIONS PGSERVICE PGSERVICEFILE
readonly source_snapshot=/home/nalven/admin-release.YkmN8r
readonly manifest_hash=9e298566555a742bf20d6ad168bce5c53c6f6689cae1ed93079cb158fceda1bc
readonly executor=/usr/local/libexec/nalven/production-maintenance.sh
readonly pointer=/usr/local/libexec/nalven/production-release-candidate
[[ -d "$source_snapshot" && ! -L "$source_snapshot" ]]
[[ $(sha256sum "$source_snapshot/SOURCE.sha256" | cut -d ' ' -f 1) == "$manifest_hash" ]]
(cd "$source_snapshot" && sha256sum --quiet -c SOURCE.sha256)
[[ -x "$executor" && $(stat -c '%u:%g:%a' "$executor") == 0:0:750 ]]
[[ -f /etc/nalven/app.env && ! -L /etc/nalven/app.env ]]
[[ $(stat -c '%u' /etc/nalven/app.env) == 0 ]]
[[ $(sed -n '/^CONTROL_DATABASE_URL=/p' /etc/nalven/app.env | wc -l) == 1 ]]
connection=$(sed -n 's/^CONTROL_DATABASE_URL=//p' /etc/nalven/app.env)
[[ "$connection" =~ ^postgres(ql)?://[^[:space:]]+@127\.0\.0\.1:5432/nalven$ ]] || { echo 'Banco de controle inesperado.' >&2; exit 1; }
echo 'Gerando release com consultas somente de leitura ao banco de produção.'
(
  cd "$source_snapshot"
  runuser -u nalven -- env -i PATH="$PATH" NODE_ENV=production NODE_OPTIONS=--max-old-space-size=4096 \
    CONTROL_DATABASE_URL="$connection" PGOPTIONS='-c default_transaction_read_only=on' \
    /opt/node-v24.19.0/bin/node node_modules/next/dist/bin/next build
)
unset connection
(cd "$source_snapshot" && sha256sum --quiet -c SOURCE.sha256)
[[ -f "$source_snapshot/.next/standalone/server.js" && -d "$source_snapshot/.next/static" ]]
candidate=$(mktemp -d /var/lib/nalven-production-build.XXXXXX)
cp -a "$source_snapshot/." "$candidate/"
chown -hR root:root "$candidate"
find "$candidate" ! -type l -exec chmod go-w {} +
chmod 0755 "$candidate"
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
