#!/usr/bin/env bash
echo 'Fluxo legado desativado. Use: sudo -n /usr/local/libexec/nalven/publish-current.sh. Migrations exigem aprovação separada.' >&2
exit 1
# Publish validated application code; service, network and SSH settings stay managed separately.
set -euo pipefail
[[ $EUID == 0 ]] || exit 1
source_root=/home/nalven/nalven
project_root=/srv/nalven
snapshot=/root/nalven-site-20260905
[[ -s "$snapshot/control-before.dump" && -f "$source_root/.next/standalone/server.js" ]] || exit 1
previous_release=$(readlink -f "$project_root/current")
release="$project_root/releases/site-$(date -u +%Y%m%dT%H%M%SZ)"
find "$source_root/prisma/control/migrations" -mindepth 1 -maxdepth 1 -type d -printf '%f\n' | sort > "$snapshot/expected-migrations.txt"
runuser -u postgres -- psql -X -d nalven -Atqc 'SELECT migration_name FROM _prisma_migrations WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL ORDER BY migration_name' > "$snapshot/applied-migrations.txt"
diff -u "$snapshot/expected-migrations.txt" "$snapshot/applied-migrations.txt"
sha256sum -c /root/nalven-security-20260905/ssh-before.sha256 > "$snapshot/ssh-before.txt"
install -d -o root -g nalven-app -m 0750 "$release"
cp -a "$source_root/.next/standalone/." "$release/"
install -d -o root -g nalven-app -m 0750 "$release/.next/static"
cp -a "$source_root/.next/static/." "$release/.next/static/"
cp -a "$source_root/public" "$release/public"
chown -hR root:nalven-app "$release"
find "$release" -type d -exec chmod 0750 {} +
find "$release" -type f -exec chmod 0640 {} +
chmod 0751 "$release"
rollback(){ trap - ERR; ln -sfn "$previous_release" "$project_root/current.next"; mv -Tf "$project_root/current.next" "$project_root/current"; systemctl restart nalven.service; echo 'Release anterior restaurada.' >&2; }
trap rollback ERR
ln -sfn "$release" "$project_root/current.next"
mv -Tf "$project_root/current.next" "$project_root/current"
systemctl restart nalven.service
healthy=false
for attempt in {1..30}; do
 if curl --fail --silent --max-time 3 http://127.0.0.1:3000/api/health >/dev/null; then healthy=true; break; fi
 sleep 1
done
[[ "$healthy" == true ]]
[[ $(curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:3000/) == 200 ]]
[[ $(curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:3000/api/erp) == 401 ]]
[[ $(curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:3000/api/saas) == 403 ]]
[[ $(curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:3000/entrar) == 308 ]]
[[ $(curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:3000/validacao-publicacao-404) == 404 ]]
sha256sum -c /root/nalven-security-20260905/ssh-before.sha256 > "$snapshot/ssh-after.txt"
trap - ERR
printf '%s\n' "$release" > "$snapshot/published-release.txt"
printf 'PUBLICATION_OK %s\n' "$release"
