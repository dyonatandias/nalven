#!/usr/bin/env bash
set -euo pipefail

readonly credentials_dir=/etc/nalven/tenant-manual-sweepers
readonly state_dir=/var/lib/nalven-pos-manual-sweep
readonly runtime_dir=/run/nalven-pos-manual-sweep
readonly node_binary=/opt/node-v24.19.0/bin/node
readonly batch_limit=50
readonly maximum_attempts=3
readonly statement_deadline=55
active_pgpass_file=""
active_pending_partial=""
cleanup() {
  [[ -z "$active_pgpass_file" ]] || rm -f -- "$active_pgpass_file"
  [[ -z "$active_pending_partial" ]] || rm -f -- "$active_pending_partial"
}
trap cleanup EXIT
trap 'exit 1' HUP INT TERM

self_path=$(readlink -f -- "${BASH_SOURCE[0]}")
self_mode=$(stat -c '%a' "$self_path" 2>/dev/null || true); self_mode=${self_mode:-0000}
[[ "$self_path" == /usr/local/libexec/nalven/process-pos-manual-sweep.sh \
    && -f "$self_path" && ! -L "$self_path" && $(stat -c '%u:%g' "$self_path") == 0:0 \
    && $((8#$self_mode & 022)) -eq 0 ]] || {
  echo "Executor sweep recusado fora do artefato root-owned instalado." >&2
  exit 1
}

[[ $(id -un) == nalven-pos-manual-sweeper && $(id -gn) == nalven-pos-manual-sweeper ]] || {
  echo "Sweep manual recusado fora do principal Unix isolado." >&2
  exit 1
}
[[ -d "$credentials_dir" && ! -L "$credentials_dir" \
    && $(stat -c '%u:%G:%a' "$credentials_dir") == 0:nalven-pos-manual-sweeper:750 ]] || {
  echo "Diretório de credenciais do sweeper ausente ou inseguro." >&2
  exit 1
}
[[ -d "$state_dir" && ! -L "$state_dir" \
    && $(stat -c '%U:%G:%a' "$state_dir") == nalven-pos-manual-sweeper:nalven-pos-manual-sweeper:700 ]] || {
  echo "Diretório de replay do sweeper ausente ou inseguro." >&2
  exit 1
}
[[ -d "$runtime_dir" && ! -L "$runtime_dir" \
    && $(stat -c '%U:%G:%a' "$runtime_dir") == nalven-pos-manual-sweeper:nalven-pos-manual-sweeper:700 ]] || {
  echo "Diretório temporário do sweeper ausente ou inseguro." >&2
  exit 1
}
[[ -x "$node_binary" && ! -L "$node_binary" && $(stat -c '%u:%g' "$node_binary") == 0:0 \
    && ! -w "$node_binary" ]] || {
  echo "Runtime imutável do executor sweep ausente." >&2
  exit 1
}

shopt -s nullglob
credential_files=("$credentials_dir"/*.env)
shopt -u nullglob

for credential_file in "${credential_files[@]}"; do
  [[ -f "$credential_file" && ! -L "$credential_file" \
      && $(stat -c '%u:%G:%a' "$credential_file") == 0:nalven-pos-manual-sweeper:640 ]] || {
    echo "Credencial sweeper insegura: $credential_file" >&2
    exit 1
  }
  [[ $(wc -l < "$credential_file") -eq 1 \
      && $(grep -Ec '^TENANT_MANUAL_SWEEPER_DATABASE_URL=postgres(ql)?://[^[:space:]]+$' "$credential_file") -eq 1 ]] || {
    echo "Credencial sweeper contém chave duplicada, inesperada ou insegura: $credential_file" >&2
    exit 1
  }
  database_url=$(sed -n 's/^TENANT_MANUAL_SWEEPER_DATABASE_URL=//p' "$credential_file")
  if [[ ! "$database_url" =~ ^postgres(ql)?://([a-z][a-z0-9_]{0,62}):([0-9a-f]{64})@127\.0\.0\.1:5432/([a-z][a-z0-9_]{0,62})$ ]]; then
    echo "URL sweeper inválida: $credential_file" >&2
    exit 1
  fi
  database_role=${BASH_REMATCH[2]}
  database_password=${BASH_REMATCH[3]}
  database_name=${BASH_REMATCH[4]}
  [[ "$database_role" == "${database_name}_ms" ]] || {
    echo "Role sweeper diverge do banco em $credential_file" >&2
    exit 1
  }

  tenant_key=$(basename "$credential_file" .env)
  [[ "$tenant_key" =~ ^[a-z0-9-]{1,45}$ ]] || {
    echo "Identidade de tenant inválida em $credential_file" >&2
    exit 1
  }
  sweeper_id="nalven-pos-manual-sweeper:${tenant_key}"
  pending_file="$state_dir/$tenant_key.pending"
  if [[ -e "$pending_file" ]]; then
    [[ -f "$pending_file" && ! -L "$pending_file" \
        && $(stat -c '%U:%G:%a' "$pending_file") == nalven-pos-manual-sweeper:nalven-pos-manual-sweeper:600 \
        && $(wc -l < "$pending_file") -eq 1 ]] || {
      echo "Estado de replay sweeper inseguro para $tenant_key" >&2
      exit 1
    }
    IFS=$'\t' read -r idempotency_key request_hash < "$pending_file"
  else
    minute_bucket=$(date -u +%Y%m%dT%H%M)
    readarray -t request_values < <(
      "$node_binary" -e '
      const crypto = require("node:crypto");
      const [tenantKey, minuteBucket, role, sweeperId, limit] = process.argv.slice(1);
      const hash = (domain, value) => crypto.createHash("sha256")
        .update(Buffer.from(domain, "utf8")).update(Buffer.from([0])).update(Buffer.from(value, "utf8")).digest("hex");
      const idempotencyKey = hash("nalven-pos-manual-sweep-batch-v1", `${tenantKey}\0${minuteBucket}`);
      const request = JSON.stringify({
        capability: "public.pos_manual_sweep_expired_applications_v1(text,integer,text,text)",
        idempotencyKey,
        limit: Number(limit),
        schemaVersion: 1,
        sessionUser: role,
        sweeperId,
      });
      process.stdout.write(`${idempotencyKey}\n${hash("t2-sweep-request-v1", request)}\n`);
      ' "$tenant_key" "$minute_bucket" "$database_role" "$sweeper_id" "$batch_limit"
    )
    [[ ${#request_values[@]} -eq 2 ]] || {
      echo "Executor não produziu identidade/hash canônicos para $tenant_key" >&2
      exit 1
    }
    idempotency_key=${request_values[0]}
    request_hash=${request_values[1]}
    pending_partial=$(mktemp "$state_dir/.${tenant_key}.pending.XXXXXX")
    active_pending_partial=$pending_partial
    chmod 0600 "$pending_partial"
    printf '%s\t%s\n' "$idempotency_key" "$request_hash" > "$pending_partial"
    mv -n -- "$pending_partial" "$pending_file"
    [[ ! -e "$pending_partial" ]] || { rm -f -- "$pending_partial"; echo "Corrida ao persistir replay sweeper para $tenant_key" >&2; exit 1; }
    active_pending_partial=""
  fi
  [[ "$idempotency_key" =~ ^[0-9a-f]{64}$ && "$request_hash" =~ ^[0-9a-f]{64}$ ]] || {
    echo "Estado de replay sweeper inválido para $tenant_key" >&2
    exit 1
  }

  pgpass_file=$(mktemp "$runtime_dir/pgpass.XXXXXX")
  active_pgpass_file=$pgpass_file
  chmod 0600 "$pgpass_file"
  printf '127.0.0.1:5432:%s:%s:%s\n' "$database_name" "$database_role" "$database_password" > "$pgpass_file"
  attempt=1
  while true; do
    if PGPASSFILE="$pgpass_file" PGHOST=127.0.0.1 PGPORT=5432 PGUSER="$database_role" PGDATABASE="$database_name" \
      PGCONNECT_TIMEOUT=5 PGAPPNAME=nalven-pos-manual-sweep-v1 PGOPTIONS='-c default_transaction_isolation=serializable' \
      timeout --signal=TERM --kill-after=5s "${statement_deadline}s" \
      psql --no-psqlrc --no-password --set=ON_ERROR_STOP=1 --tuples-only --no-align \
        --command="SELECT public.pos_manual_sweep_expired_applications_v1('$sweeper_id', $batch_limit, '$idempotency_key', '$request_hash')"; then
      break
    fi
    if (( attempt >= maximum_attempts )); then
      rm -f -- "$pgpass_file"
      echo "Sweep manual falhou após retries causais para $tenant_key" >&2
      exit 1
    fi
    attempt=$((attempt + 1))
  done
  rm -f -- "$pgpass_file"
  active_pgpass_file=""
  rm -f -- "$pending_file"
  unset database_url database_password request_hash idempotency_key
done
