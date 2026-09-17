#!/usr/bin/env bash
set -euo pipefail

readonly pos_base_url="${NALVEN_POS_INTERNAL_BASE_URL:-http://127.0.0.1:3000}"
readonly pos_job_token="${NALVEN_INTERNAL_JOB_TOKEN:-}"
readonly node_binary="${NALVEN_NODE_BINARY:-/opt/node-v24.19.0/bin/node}"
readonly organization_limit=100
readonly item_limit=100
readonly maximum_pages=1000

if [[ ! "$pos_base_url" =~ ^http://127\.0\.0\.1:[0-9]{1,5}$ ]]; then
  echo "NALVEN_POS_INTERNAL_BASE_URL deve apontar para o listener HTTP local." >&2
  exit 1
fi
if [[ ! "$pos_job_token" =~ ^[^[:space:]]{32,512}$ ]]; then
  echo "NALVEN_INTERNAL_JOB_TOKEN ausente ou inválido." >&2
  exit 1
fi
if [[ ! -x "$node_binary" ]]; then
  echo "Runtime Node.js do job interno não encontrado." >&2
  exit 1
fi

header_file=$(mktemp)
response_file=$(mktemp)
cleanup() {
  rm -f -- "$header_file" "$response_file"
}
trap cleanup EXIT
trap 'exit 1' HUP INT TERM
chmod 0600 "$header_file" "$response_file"
printf 'Authorization: Bearer %s\nContent-Type: application/json\n' "$pos_job_token" > "$header_file"

run_paginated_job() {
  local endpoint="$1"
  local action="$2"
  local limit_field="$3"
  local limit_value="${4:-$item_limit}"
  local cursor=""
  local previous_cursor=""
  local page=0
  local body
  local http_status
  local parsed
  local has_more
  local next_cursor

  while (( page < maximum_pages )); do
    page=$((page + 1))
    body=$(
      "$node_binary" -e '
        const [action, limitField, organizationLimit, itemLimit, cursor] = process.argv.slice(1);
        const body = { action, organizationLimit: Number(organizationLimit), [limitField]: Number(itemLimit) };
        if (cursor) body.afterOrganizationId = cursor;
        process.stdout.write(JSON.stringify(body));
      ' "$action" "$limit_field" "$organization_limit" "$limit_value" "$cursor"
    )
    : > "$response_file"
    http_status=$(
      curl --silent --show-error \
        --connect-timeout 5 \
        --max-time 50 \
        --request POST \
        --header "@$header_file" \
        --data-binary "$body" \
        --output "$response_file" \
        --write-out '%{http_code}' \
        "$pos_base_url$endpoint"
    )
    if [[ ! "$http_status" =~ ^2[0-9]{2}$ ]]; then
      echo "Job interno $action falhou com HTTP $http_status na página $page." >&2
      return 1
    fi
    if ! parsed=$(
      "$node_binary" -e '
        let source = "";
        process.stdin.setEncoding("utf8");
        process.stdin.on("data", chunk => { source += chunk; });
        process.stdin.on("end", () => {
          let value;
          try { value = JSON.parse(source); } catch { process.exit(2); }
          if (!value || value.ok !== true || typeof value.hasMoreOrganizations !== "boolean") process.exit(3);
          const cursor = value.nextCursor;
          if (value.hasMoreOrganizations && (typeof cursor !== "string" || !/^[A-Za-z0-9._:-]{1,160}$/.test(cursor))) process.exit(4);
          if (!value.hasMoreOrganizations && cursor !== null) process.exit(5);
          process.stdout.write(`${value.hasMoreOrganizations ? "1" : "0"}\t${cursor || ""}`);
        });
      ' < "$response_file"
    ); then
      echo "Job interno $action devolveu resposta inválida na página $page." >&2
      return 1
    fi
    IFS=$'\t' read -r has_more next_cursor <<< "$parsed"
    if [[ "$has_more" == "0" ]]; then
      return 0
    fi
    if [[ -z "$next_cursor" || "$next_cursor" == "$cursor" || "$next_cursor" == "$previous_cursor" ]]; then
      echo "Job interno $action devolveu cursor sem progresso na página $page." >&2
      return 1
    fi
    previous_cursor="$cursor"
    cursor="$next_cursor"
  done
  echo "Job interno $action excedeu $maximum_pages páginas; execução interrompida." >&2
  return 1
}

run_paginated_job "/api/internal/pdv/payments/process" "payment.maintenance" "itemLimit"
run_paginated_job "/api/internal/pdv/payment-compensations/process" "compensation.maintenance" "itemLimit"
run_paginated_job "/api/internal/pdv/fiscal/process" "fiscal.maintenance" "itemLimit"
run_paginated_job "/api/internal/pdv/reconciliation/process" "reconciliation.process" "batchLimit" 50
run_paginated_job "/api/internal/pdv/value-accounts/sweep" "value.lifecycle.sweep" "itemLimit"
