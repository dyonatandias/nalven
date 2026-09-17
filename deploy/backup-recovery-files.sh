#!/usr/bin/env bash
set -euo pipefail
export PATH=/usr/sbin:/usr/bin:/sbin:/bin
[[ $EUID == 0 && $# == 0 ]]
umask 077
readonly root=/var/backups/nalven-recovery
install -d -o root -g root -m 0700 "$root"
exec 9>"$root/backup.lock"
flock -n 9
name="recovery-$(date -u +%Y%m%dT%H%M%SZ).tar.gz"
[[ ! -e "$root/$name" ]]
# Contains credentials: root-only local recovery material, never a public artifact.
tar --acls --xattrs -czf "$root/$name.partial" \
  --exclude='usr/local/libexec/nalven/tenant-migration-bundles' \
  --exclude='./node_modules' --exclude='./generated' --exclude='./.next' --exclude='./outputs' \
  --transform='s,^\./,source/,;s,^\.$,source,' \
  -C / etc/nalven etc/systemd/system etc/nginx usr/local/libexec/nalven var/lib/nalven/uploads \
  -C /home/nalven/nalven .
tar -tzf "$root/$name.partial" >/dev/null
mv -T "$root/$name.partial" "$root/$name"
(cd "$root" && sha256sum "$name" > "$name.sha256" && sha256sum -c "$name.sha256")
echo 'Arquivo de recuperação local validado; cópia externa ainda deve ser configurada.'
# Retain 30 days; delete only validated backup names after today's successful archive.
while IFS= read -r -d '' expired; do
  basename=${expired##*/}
  [[ "$basename" =~ ^recovery-[0-9]{8}T[0-9]{6}Z.tar.gz.sha256$ ]] || exit 1
  archive=${basename%.sha256}
  (cd "$root" && sha256sum --check --strict "$basename")
  rm -- "$root/$archive" "$root/$basename"
done < <(find "$root" -maxdepth 1 -type f -name 'recovery-????????T??????Z.tar.gz.sha256' -mtime +30 -print0)
