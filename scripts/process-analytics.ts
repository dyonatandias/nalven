import { controlDb } from "../db/control";
import { aggregateAnalytics } from "../lib/analytics/service";

async function main() {
  const summary = await aggregateAnalytics();
  console.log(JSON.stringify({ job: "site_analytics", ...summary, completedAt: new Date().toISOString() }));
}

main()
  .catch((error) => { console.error(error instanceof Error ? error.message : error); process.exitCode = 1; })
  .finally(async () => controlDb.$disconnect());
