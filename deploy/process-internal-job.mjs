import { setTimeout as delay } from "node:timers/promises";

const endpoints = new Map([
  ["billing", "/api/internal/billing/jobs"],
  ["dfe", "/api/internal/dfe/sync"],
  ["analytics", "/api/internal/analytics/jobs"],
]);
const job = process.argv[2];
const endpoint = endpoints.get(job);
const token = process.env.NALVEN_INTERNAL_JOB_TOKEN || "";
if (!endpoint || !/^[\x21-\x7e]{32,512}$/.test(token)) {
  console.error("Job interno ou credencial inválidos.");
  process.exit(1);
}
// Credential stays in process memory, never in argv, shell expansion or logs.
let success = false;
for (let attempt = 0; attempt <= 5; attempt++) {
  try {
    const response = await fetch(`http://127.0.0.1:3000${endpoint}`, {
      method: "POST", headers: { authorization: `Bearer ${token}` },
      redirect: "error", signal: AbortSignal.timeout(240_000),
    });
    await response.body?.cancel();
    if (response.ok) { success = true; break; }
    if (response.status < 500 && response.status !== 429) break;
  } catch { /* Restart windows and transient network errors are retried. */ }
  if (attempt < 5) await delay(2_000);
}
console.log(JSON.stringify({ job, success }));
if (!success) process.exitCode = 1;
