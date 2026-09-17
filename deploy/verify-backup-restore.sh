#!/usr/bin/env bash
# Restore the latest complete backup into a disposable, socket-only PostgreSQL cluster.
set -euo pipefail
export PATH=/usr/lib/postgresql/18/bin:/usr/sbin:/usr/bin:/sbin:/bin
[[ $EUID == 0 && $# == 0 ]]
readonly root=/var/backups/nalven
manifest=$(find "$root" -maxdepth 1 -type f -name 'manifest-????????T??????Z.sha256' -printf '%f\n' | sort | tail -1)
[[ "$manifest" =~ ^manifest-[0-9]{8}T[0-9]{6}Z.sha256$ ]]
(cd "$root" && sha256sum --check --strict "$manifest")
work=$(mktemp -d /var/lib/postgresql/nalven-restore-check.XXXXXX)
chown postgres:postgres "$work"
runuser -u postgres -- initdb -D "$work/data" --auth-local=trust --auth-host=reject >/dev/null
stop_cluster() { runuser -u postgres -- pg_ctl -D "$work/data" -m fast stop >/dev/null || true; }
trap stop_cluster EXIT
runuser -u postgres -- pg_ctl -D "$work/data" -l "$work/server.log" -o "-k $work -p 55441 -c listen_addresses=''" -w start >/dev/null
# Policies may name application roles even with --no-privileges. Recreate names only,
# never passwords or login authority, in the isolated cluster.
runuser -u postgres -- psql -X -At -d nalven -c "SELECT format('CREATE ROLE %I NOLOGIN;', rolname) FROM pg_roles WHERE rolname LIKE 'nalven%'" |
  runuser -u postgres -- psql -X -h "$work" -p 55441 -d postgres -v ON_ERROR_STOP=1 >/dev/null
index=0
while read -r checksum filename; do
  [[ "$checksum" =~ ^[a-f0-9]{64}$ && "$filename" =~ ^(control|tenant-[a-zA-Z0-9._-]+)-[0-9]{8}T[0-9]{6}Z.dump$ ]]
  index=$((index+1))
  database="restore_$index"
  runuser -u postgres -- createdb -h "$work" -p 55441 "$database"
  runuser -u postgres -- pg_restore -h "$work" -p 55441 -d "$database" --exit-on-error --no-owner --no-privileges "$root/$filename"
  runuser -u postgres -- psql -X -h "$work" -p 55441 -d "$database" -v ON_ERROR_STOP=1 -Atc 'SELECT count(*) FROM _prisma_migrations'
  echo "RESTORE_OK $filename"
done < "$root/$manifest"
echo "Cluster isolado será parado; evidência preservada em $work"
