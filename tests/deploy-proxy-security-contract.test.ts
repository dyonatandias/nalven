import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const nginx = readFileSync(new URL("../deploy/nginx.conf", import.meta.url), "utf8");
const billingJob = readFileSync(
  new URL("../deploy/nalven-billing-jobs.service", import.meta.url),
  "utf8",
);
const bootstrap = readFileSync(
  new URL("../deploy/bootstrap-root.sh", import.meta.url),
  "utf8",
);
const release = readFileSync(
  new URL("../deploy/deploy-release.sh", import.meta.url),
  "utf8",
);
const nextConfig = readFileSync(
  new URL("../next.config.ts", import.meta.url),
  "utf8",
);

test("proxy confiável sobrescreve X-Forwarded-For e não preserva IP escolhido pelo cliente", () => {
  assert.match(nginx, /proxy_set_header X-Real-IP \$remote_addr;/);
  assert.match(nginx, /proxy_set_header X-Forwarded-For \$remote_addr;/);
  assert.doesNotMatch(nginx, /proxy_add_x_forwarded_for/);
});

test("todo release instala, valida e recarrega o proxy de borda", () => {
  assert.match(release, /deploy\/nginx\.conf/);
  assert.match(release, /nginx -t/);
  assert.match(release, /systemctl reload nginx/);
  assert.match(release, /Configuração Nginx rejeitada/);
});

test("respostas recebem headers defensivos sem bloquear previews das APIs", () => {
  for (const header of [
    "Content-Security-Policy",
    "Referrer-Policy",
    "Strict-Transport-Security",
    "X-Content-Type-Options",
    "X-Frame-Options",
  ]) assert.match(nextConfig, new RegExp(header));
  assert.match(nextConfig, /\(\?!api/);
  assert.match(nextConfig, /frame-ancestors 'none'/);
});

test("job de billing tolera a janela de restart e é instalado em todos os deploys", () => {
  assert.match(billingJob, /User=nalven-jobs/);
  assert.match(billingJob, /process-internal-job\.mjs billing/);
  assert.doesNotMatch(billingJob, /Authorization: Bearer/);
  const runner = readFileSync(new URL("../deploy/process-internal-job.mjs", import.meta.url), "utf8");
  assert.match(runner, /attempt <= 5/);
  assert.match(runner, /AbortSignal.timeout\(240_000\)/);
  for (const source of [bootstrap, release]) {
    assert.match(source, /nalven-billing-jobs\.service/);
    assert.match(source, /nalven-billing-jobs\.timer/);
    assert.match(source, /enable --now[^\n]*nalven-billing-jobs\.timer/);
  }
});
