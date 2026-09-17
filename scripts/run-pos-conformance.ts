import { spawnSync } from "node:child_process";
import { POS_LOCAL_CONFORMANCE_CAPABILITIES } from "../lib/erp/pos-conformance-simulators";

const result = spawnSync(process.execPath, ["--import", "tsx", "--test", "tests/pos-conformance.test.ts"], {
  cwd: process.cwd(),
  encoding: "utf8",
  timeout: 30_000,
  maxBuffer: 4 * 1024 * 1024,
});

if (result.error || result.status !== 0) {
  process.stderr.write("POS_LOCAL_CONFORMANCE_FAILED: testes locais falharam; nenhuma conclusão de homologação pode ser emitida.\n");
  if (result.error) process.stderr.write(`${result.error.message}\n`);
  if (result.stdout) process.stderr.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  process.exit(result.status || 1);
}

const executedTests = Number(result.stdout.match(/^(?:#|ℹ) tests (\d+)$/m)?.[1]);
if (!Number.isSafeInteger(executedTests) || executedTests < 1) {
  process.stderr.write("POS_LOCAL_CONFORMANCE_FAILED: o runner não confirmou a contagem de testes locais.\n");
  process.exit(1);
}

process.stdout.write(`${JSON.stringify({
  report: "POS local simulator contract checks",
  result: "LOCAL_TESTS_PASSED",
  executedTests,
  ...POS_LOCAL_CONFORMANCE_CAPABILITIES,
}, null, 2)}\n`);
