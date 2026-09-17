/** Empty, isolated control-plane schema for build/HTTP smoke tests. No real tenant credentials. */
import { readFile } from "node:fs/promises";
import { Pool } from "pg";

const socket = process.env.PRODUCTION_TEST_SOCKET;
if (!socket?.startsWith("/tmp/nalven-production-pg.")) throw new Error("An isolated production test cluster is required.");
const db = new Pool({ host: socket, port: 55439, user: "nalven", database: "production_control_test", max: 1 });
async function main() {
  const existing = (await db.query("SELECT tablename FROM pg_tables WHERE schemaname = 'public'")).rowCount;
  if (existing && !process.argv.includes("--seed-only")) throw new Error("Test control database is not empty; refusing to replace it.");
  if (existing && (await db.query("SELECT value->>'domain' AS domain FROM system_settings WHERE key='saas'")).rows[0]?.domain !== "localhost") throw new Error("Test-only settings marker is missing.");
  await db.query("BEGIN");
  if (!existing) await db.query(await readFile(`${socket}/control-schema.sql`, "utf8"));
  for (const [key, value] of Object.entries({ saas: { domain: "localhost", trialDays: 7 }, signup: { paymentMethods: ["pix"], dueDay: 10 } })) await db.query("INSERT INTO system_settings(key,value,updated_at) VALUES ($1,$2::jsonb,now()) ON CONFLICT(key) DO UPDATE SET value=EXCLUDED.value,updated_at=now()", [key, JSON.stringify(value)]);
  for (const path of ["/", "/blog", "/glossario"]) await db.query("INSERT INTO seo_entries(path,title,description,robots,updated_at) VALUES ($1,'NALVEN — teste isolado','Verificação local de produção','noindex,nofollow',now()) ON CONFLICT(path) DO NOTHING", [path]);
  await db.query("COMMIT");
  console.log("Isolated control schema and test-only SEO settings ready.");
}
main().catch(async error => { await db.query("ROLLBACK"); console.error(error); process.exitCode = 1; }).finally(() => db.end());
