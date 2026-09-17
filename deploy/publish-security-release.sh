#!/usr/bin/env bash
echo 'Fluxo legado desativado. Use: sudo -n /usr/local/libexec/nalven/publish-current.sh. Migrations exigem aprovação separada.' >&2
exit 1
# Code-only publication: refuse pending migrations; never edit SSH or firewall rules.
set -euo pipefail
[[ $EUID == 0 ]] || { echo "Publicação exige root." >&2; exit 1; }
source_root=/home/nalven/nalven
project_root=/srv/nalven
snapshot=/root/nalven-security-20260905
[[ -f "$source_root/.next/standalone/server.js" && -f "$snapshot/ssh-before.sha256" ]] || exit 1
[[ $(systemctl show nalven-backup.service -p Result --value) == success ]] || { echo "Backup precisa concluir com sucesso." >&2; exit 1; }
check_migrations() {
  local database="$1" schema="$2"
  find "$source_root/prisma/$schema/migrations" -mindepth 1 -maxdepth 1 -type d -printf '%f\n' | sort > "$snapshot/expected-$schema.txt"
  runuser -u postgres -- psql -X -d "$database" -Atqc 'SELECT migration_name FROM _prisma_migrations WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL ORDER BY migration_name' > "$snapshot/applied-$database.txt"
  diff -u "$snapshot/expected-$schema.txt" "$snapshot/applied-$database.txt" || { echo "Migrações divergentes; publicação cancelada." >&2; exit 1; }
}
check_migrations nalven control
while IFS= read -r database; do
  [[ "$database" =~ ^[a-z][a-z0-9_]{0,62}$ ]] || exit 1
  check_migrations "$database" tenant
done < <(runuser -u postgres -- psql -X -d nalven -Atqc "SELECT database_name FROM tenant_databases WHERE status='active'")
previous_release=$(readlink -f "$project_root/current")
printf '%s\n' "$previous_release" > "$snapshot/previous-release.txt"
release="$project_root/releases/security-$(date -u +%Y%m%dT%H%M%SZ)"
install -d -o root -g nalven-app -m 0751 "$project_root" "$project_root/releases" "$release"
cp -a "$source_root/.next/standalone/." "$release/"
install -d -o root -g nalven-app -m 0750 "$release/.next/static"
cp -a "$source_root/.next/static/." "$release/.next/static/"
cp -a "$source_root/public" "$release/public"
chown -hR root:nalven-app "$release" "$previous_release"
find "$release" -type d -exec chmod 0750 {} +
find "$release" -type f -exec chmod 0640 {} +
chmod 0751 "$release" "$previous_release"
units=(nalven nalven-billing-jobs nalven-dfe-sync nalven-analytics)
rollback() {
  trap - ERR
  for unit in "${units[@]}"; do
    cp -a "$snapshot/system/$unit.service" "/etc/systemd/system/$unit.service"
  done
  cp -a "$snapshot/nginx/sites-available/nalven" /etc/nginx/sites-available/nalven
  ln -sfn "$previous_release" "$project_root/current.next"
  mv -Tf "$project_root/current.next" "$project_root/current"
  systemctl daemon-reload
  nginx -t && systemctl reload nginx
  systemctl restart nalven.service
  systemctl start nalven-billing-jobs.timer nalven-dfe-sync.timer nalven-analytics.timer
  echo "Publicação falhou; release e unidades anteriores restauradas." >&2
}
trap rollback ERR
systemctl stop nalven-billing-jobs.timer nalven-dfe-sync.timer nalven-analytics.timer
install -o root -g root -m 0644 "$source_root/deploy/nalven.service" /etc/systemd/system/nalven.service
install -o root -g root -m 0750 "$source_root/deploy/install-internal-job-runner.sh" /usr/local/libexec/nalven/install-internal-job-runner.sh
/usr/local/libexec/nalven/install-internal-job-runner.sh "$source_root"
install -o root -g root -m 0644 "$source_root/deploy/nginx.conf" /etc/nginx/sites-available/nalven
nginx -t
ln -sfn "$release" "$project_root/current.next"
mv -Tf "$project_root/current.next" "$project_root/current"
systemctl daemon-reload
systemctl restart nalven.service
systemctl reload nginx
healthy=false
for attempt in {1..20}; do
  if curl --fail --silent --max-time 3 http://127.0.0.1:3000/api/health >/dev/null; then healthy=true; break; fi
  sleep 1
done
[[ "$healthy" == true ]]
[[ $(curl -s -o /dev/null -w '%{http_code}' --max-time 10 http://127.0.0.1/) == 200 ]]
[[ $(curl -s -o /dev/null -w '%{http_code}' --max-time 10 http://127.0.0.1/api/erp) == 401 ]]
[[ $(curl -s -o /dev/null -w '%{http_code}' --max-time 10 http://127.0.0.1/api/saas) == 403 ]]
[[ $(curl -s -o /dev/null -w '%{http_code}' --max-time 10 -X POST http://127.0.0.1/api/internal/analytics/jobs) == 401 ]]
sha256sum -c "$snapshot/ssh-before.sha256" > "$snapshot/ssh-after-publication.txt"
systemctl start nalven-billing-jobs.timer nalven-dfe-sync.timer nalven-analytics.timer
trap - ERR
printf '%s\n' "$release" > "$snapshot/published-release.txt"
printf 'PUBLICATION_OK %s\n' "$release"
