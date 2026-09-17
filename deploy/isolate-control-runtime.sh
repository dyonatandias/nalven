#!/usr/bin/env bash
# One-time reviewed administrator operation. Never expose generated credentials.
set -euo pipefail
export PATH=/opt/node-v24.19.0/bin:/usr/sbin:/usr/bin:/sbin:/bin
[[ $EUID == 0 && $# == 0 ]]
exec 9>/run/lock/nalven-production-maintenance.lock
flock -n 9
readonly config=/etc/nalven/control-migrator.env
[[ ! -e "$config" ]]
[[ $(runuser -u postgres -- psql -X -At -d nalven -c "SELECT count(*) FROM pg_roles WHERE rolname='nalven_control_migrator'") == 0 ]]
systemctl start nalven-backup.service
[[ $(systemctl show nalven-backup.service -p Result --value) == success ]]
password=$(openssl rand -hex 32)
umask 077
partial=$(mktemp /etc/nalven/.control-migrator.XXXXXX)
printf 'CONTROL_DATABASE_URL=postgresql://nalven_control_migrator:%s@127.0.0.1:5432/nalven\n' "$password" > "$partial"
# Feed password through stdin, not argv or logs.
{
  printf "BEGIN;\nCREATE ROLE nalven_control_migrator LOGIN PASSWORD '%s' NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;\n" "$password"
  printf 'REASSIGN OWNED BY nalven_app TO nalven_control_migrator;\n'
  printf 'ALTER DATABASE nalven OWNER TO nalven_control_migrator;\n'
  printf 'ALTER SCHEMA public OWNER TO nalven_control_migrator;\n'
  cat /usr/local/libexec/nalven/control-runtime-grants.sql
  printf '\nCOMMIT;\n'
} | runuser -u postgres -- psql -X -q -v ON_ERROR_STOP=1 -d nalven
unset password
mv -T "$partial" "$config"
echo 'Controle: runtime DML separado do migrator; histórico Prisma protegido.'
