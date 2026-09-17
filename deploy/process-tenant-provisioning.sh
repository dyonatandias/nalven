#!/usr/bin/env bash
set -euo pipefail

[[ ${EUID:-$(id -u)} -eq 0 ]] || { echo "O provisionamento de tenants exige o executor privilegiado dedicado." >&2; exit 1; }
readonly script_root=/usr/local/libexec/nalven
for artifact in process-tenant-provisioning.sh provision-tenant.sh reconcile-tenant-runtime-grants.sh reconcile-tenant-runtime-grants.sql run-tenant-migration-bundle.sh; do
  artifact_path="$script_root/$artifact"
  artifact_mode=$(stat -c '%a' "$artifact_path" 2>/dev/null || true)
  artifact_mode=${artifact_mode:-0000}
  [[ -f "$artifact_path" && ! -L "$artifact_path" && $(stat -c '%u:%g' "$artifact_path") == 0:0 \
      && "$artifact_mode" =~ ^[0-7]{3,4}$ && $((8#$artifact_mode & 022)) -eq 0 ]] || {
    echo "Artefato de provisionamento ausente, não regular ou gravável fora de root: $artifact" >&2
    exit 1
  }
done

readonly provisioner_config=/etc/nalven/tenant-provisioner.env
[[ -f "$provisioner_config" && ! -L "$provisioner_config" && $(stat -c '%U:%G:%a' "$provisioner_config") == root:root:600 ]] || {
  echo "Configuração root-only do provisionador ausente ou insegura." >&2
  exit 1
}
[[ $(grep -Ec '^CONTROL_DATABASE_URL=postgres(ql)?://[^[:space:]]+$' "$provisioner_config") -eq 1 && $(wc -l < "$provisioner_config") -eq 1 ]] || {
  echo "Configuração root-only do provisionador contém conteúdo inesperado." >&2
  exit 1
}
CONTROL_DATABASE_URL=$(sed -n 's/^CONTROL_DATABASE_URL=//p' "$provisioner_config")
export CONTROL_DATABASE_URL
[[ "$CONTROL_DATABASE_URL" =~ ^postgres(ql)?://nalven_app:([^@[:space:]]+)@127\.0\.0\.1:5432/nalven$ ]] || { echo "CONTROL_DATABASE_URL deve apontar para nalven_app@127.0.0.1:5432/nalven." >&2; exit 1; }
control_password=${BASH_REMATCH[2]}
control_psql() { PGPASSWORD="$control_password" PGHOST=127.0.0.1 PGPORT=5432 PGUSER=nalven_app PGDATABASE=nalven psql --no-psqlrc --no-password "$@"; }
control_identity=$(control_psql -Atc "SELECT current_user || E'\\t' || current_database()")
[[ "$control_identity" == nalven_app$'\t'nalven ]] || {
  echo "CONTROL_DATABASE_URL não autenticou como nalven_app no banco nalven." >&2
  exit 1
}

control_psql -v ON_ERROR_STOP=1 -q -c "UPDATE provisioning_jobs SET status='retry', error='Execução interrompida; retomada automática.', started_at=NULL WHERE status='processing' AND started_at < NOW() - INTERVAL '15 minutes';" >/dev/null

while IFS=$'\t' read -r job_id organization_id slug; do
  [[ "$job_id" =~ ^[a-z0-9]+$ ]] || continue
  [[ "$organization_id" =~ ^[a-z0-9-]+$ ]] || continue
  [[ "$slug" =~ ^[a-z0-9-]{1,45}$ ]] || continue
  if "$script_root/provision-tenant.sh" "$organization_id" "$slug"; then
    control_psql -v ON_ERROR_STOP=1 -q -c "UPDATE provisioning_jobs SET status='completed', error=NULL, finished_at=NOW() WHERE id='$job_id'; UPDATE organizations SET status=CASE WHEN status='provisioning' THEN 'trial' ELSE status END, updated_at=NOW() WHERE id='$organization_id';" >/dev/null
  else
    control_psql -v ON_ERROR_STOP=1 -q -c "UPDATE provisioning_jobs SET status=CASE WHEN attempts >= 10 THEN 'failed' ELSE 'retry' END, error='Falha no executor dedicado de provisionamento; nova tentativa automática agendada.', started_at=NULL WHERE id='$job_id';" >/dev/null
  fi
done < <(control_psql -v ON_ERROR_STOP=1 -AtF $'\t' -c "WITH next_jobs AS (SELECT id FROM provisioning_jobs WHERE status IN ('pending','retry') ORDER BY created_at FOR UPDATE SKIP LOCKED LIMIT 5), claimed AS (UPDATE provisioning_jobs job SET status='processing', attempts=job.attempts+1, started_at=NOW(), error=NULL FROM next_jobs WHERE job.id=next_jobs.id RETURNING job.id,job.organization_id) SELECT claimed.id,claimed.organization_id,organizations.slug FROM claimed JOIN organizations ON organizations.id=claimed.organization_id;")
