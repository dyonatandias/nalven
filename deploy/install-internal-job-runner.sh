#!/usr/bin/env bash
set -euo pipefail
[[ $EUID == 0 ]] || { echo "Instalação exige root." >&2; exit 1; }
source_root=${1:?Informe o checkout}
id nalven-jobs >/dev/null
[[ $(id -Gn nalven-jobs) == nalven-jobs ]] || exit 1
install -d -o root -g root -m 0755 /usr/local/libexec/nalven
install -o root -g nalven-jobs -m 0640 "$source_root/deploy/process-internal-job.mjs" /usr/local/libexec/nalven/process-internal-job.mjs
python3 - <<'PY'
import os,re,tempfile
from pathlib import Path
values=[line.split('=',1)[1] for line in Path('/etc/nalven/app.env').read_text().splitlines() if line.startswith('NALVEN_INTERNAL_JOB_TOKEN=')]
if len(values)!=1 or not re.fullmatch(r'[\x21-\x7e]{32,512}',values[0]): raise SystemExit('Credencial de job inválida')
fd,name=tempfile.mkstemp(prefix='.internal-jobs.',dir='/etc/nalven')
with os.fdopen(fd,'w') as stream: stream.write('NALVEN_INTERNAL_JOB_TOKEN='+values[0]+'\n')
os.replace(name,'/etc/nalven/internal-jobs.env')
PY
chown root:nalven-jobs /etc/nalven/internal-jobs.env
chmod 0640 /etc/nalven/internal-jobs.env
for unit in nalven-billing-jobs nalven-dfe-sync nalven-analytics; do
  install -o root -g root -m 0644 "$source_root/deploy/$unit.service" "/etc/systemd/system/$unit.service"
done
