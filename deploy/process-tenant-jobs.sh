#!/usr/bin/env bash
set -euo pipefail

[[ "$EUID" -ne 0 ]] || { echo "O executor de jobs runtime não pode rodar como root." >&2; exit 1; }

# Os antigos scripts TypeScript viviam no checkout gravável pelo builder. Eles
# ficam bloqueados até o deploy produzir um único bundle JS root-owned.
readonly runtime_bundle=/usr/local/libexec/nalven/tenant-runtime-jobs.mjs
if [[ ! -f "$runtime_bundle" ]]; then
  echo "Jobs de pedidos/integrações bloqueados: bundle runtime root-owned ainda não foi homologado." >&2
  exit 0
fi
bundle_identity=$(stat -c '%u:%G:%a' "$runtime_bundle")
if [[ "$bundle_identity" != "0:nalven-jobs:640" ]]; then
  echo "Bundle runtime inseguro: esperado root:nalven-jobs:0640." >&2
  exit 1
fi
exec /opt/node-v24.19.0/bin/node "$runtime_bundle"
