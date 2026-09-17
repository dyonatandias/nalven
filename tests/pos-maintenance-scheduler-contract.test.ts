import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const scheduler = readFileSync("deploy/process-pos-maintenance.sh", "utf8");
const service = readFileSync("deploy/nalven-pos-maintenance.service", "utf8");
const timer = readFileSync("deploy/nalven-pos-maintenance.timer", "utf8");
const bootstrap = readFileSync("deploy/bootstrap-root.sh", "utf8");
const release = readFileSync("deploy/deploy-release.sh", "utf8");

test("o scheduler percorre todas as manutenções persistentes sem executar adapters externos", () => {
  for (const endpoint of [
    "/api/internal/pdv/payments/process",
    "/api/internal/pdv/payment-compensations/process",
    "/api/internal/pdv/fiscal/process",
    "/api/internal/pdv/reconciliation/process",
    "/api/internal/pdv/value-accounts/sweep",
  ]) assert.match(scheduler, new RegExp(endpoint.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  for (const action of ["payment.maintenance", "compensation.maintenance", "fiscal.maintenance", "reconciliation.process", "value.lifecycle.sweep"])
    assert.match(scheduler, new RegExp(action.replace(".", "\\.")));
  assert.doesNotMatch(scheduler, /\/outbox\//);
});

test("o scheduler mantém segredo fora da linha de comando e pagina com cursor validado", () => {
  assert.match(scheduler, /header_file=\$\(mktemp\)/);
  assert.match(scheduler, /--header "@\$header_file"/);
  assert.doesNotMatch(scheduler, /--header "Authorization: Bearer/);
  assert.match(scheduler, /afterOrganizationId/);
  assert.match(scheduler, /cursor sem progresso/);
  assert.match(scheduler, /maximum_pages=1000/);
  assert.match(scheduler, /value\.ok !== true/);
  assert.match(scheduler, /http:\/\/127\\\.0\\\.0\\\.1/);
  assert.match(scheduler, /"reconciliation\.process" "batchLimit" 50/);
  assert.match(scheduler, /trap cleanup EXIT/);
  assert.match(scheduler, /trap 'exit 1' HUP INT TERM/);
  assert.doesNotMatch(scheduler, /trap cleanup EXIT HUP INT TERM/);
});

test("o timer é isolado, instalado e habilitado pelos dois fluxos de deploy", () => {
  assert.match(service, /User=nalven-app/);
  assert.match(service, /NoNewPrivileges=true/);
  assert.match(service, /ProtectSystem=strict/);
  assert.match(service, /RestrictAddressFamilies=AF_UNIX AF_INET/);
  assert.match(timer, /OnUnitActiveSec=1min/);
  for (const source of [bootstrap, release]) {
    assert.match(source, /process-pos-maintenance\.sh/);
    assert.match(source, /install -o root -g nalven-app -m 0750[^\n]*process-pos-maintenance\.sh/);
    assert.match(source, /nalven-pos-maintenance\.service/);
    assert.match(source, /nalven-pos-maintenance\.timer/);
    assert.match(source, /enable --now[^\n]*nalven-pos-maintenance\.timer/);
  }
});
