/** Bootstrap a newly created, disposable PostgreSQL database from Prisma's generated SQL.
 * Usage: PRODUCTION_TEST_SOCKET=/absolute/socket PRODUCTION_TEST_SCHEMA=/absolute/generated.sql npx tsx scripts/production-test-database.ts
 * Refuses any database other than production_test and any nonempty public schema.
 */
import { readFile } from "node:fs/promises";
import { Pool } from "pg";

const socket = process.env.PRODUCTION_TEST_SOCKET;
const schemaPath = process.env.PRODUCTION_TEST_SCHEMA;
if (
  !socket?.startsWith("/tmp/nalven-production-pg.") ||
  !schemaPath?.startsWith(`${socket}/`)
)
  throw new Error(
    "Use the isolated production test cluster and its generated schema.",
  );
const db = new Pool({
  host: socket,
  port: 55439,
  user: "nalven",
  database: "production_test",
  max: 1,
});
const newTables = [
  "production_bom_revisions",
  "production_work_centers",
  "production_dependencies",
  "production_material_reservations",
  "production_reports",
  "production_consumptions",
  "production_inspections",
  "production_events",
  "production_commands",
  "production_procurements",
];
const newColumns = [
  "revision_id",
  "snapshot",
  "version",
  "position",
  "work_center_id",
  "scheduled_start",
  "scheduled_end",
  "quality_status",
];
const purchaseColumns: Record<string, string[]> = {
  purchase_order_items: ["variation_id"],
  goods_receipts: ["warehouse_id", "idempotency_key", "request_hash"],
  goods_receipt_items: ["variation_id", "tracking"],
};
async function main() {
  const existing = await db.query(
    "SELECT tablename FROM pg_tables WHERE schemaname = 'public'",
  );
  if (existing.rowCount)
    throw new Error("Test database is not empty; refusing to replace it.");
  await db.query("BEGIN");
  const sql = await readFile(schemaPath!, "utf8");
  const statements = sql
    .split(/;\s*(?:\n|$)/)
    .map((statement) => statement.replace(/^\s*--[^\n]*\n/gm, "").trim())
    .filter(Boolean);
  for (let statement of statements) {
    if (newTables.some((table) => statement.includes(`"${table}"`))) continue;
    if (statement.includes('"production_orders_updated_at_id_idx"')) continue;
    let skipPurchaseStatement = false;
    for (const [table, columns] of Object.entries(purchaseColumns)) {
      if (statement.startsWith(`CREATE TABLE "${table}"`)) statement = statement.split("\n").filter(line => !columns.some(column => new RegExp(`^\\s+"${column}" `).test(line))).join("\n");
      else if (statement.includes(`"${table}"`) && columns.some(column => statement.includes(`"${column}"`))) skipPurchaseStatement = true;
    }
    if (skipPurchaseStatement) continue;
    if (statement.startsWith('CREATE TABLE "production_orders"')) {
      statement = statement
        .split("\n")
        .filter(
          (line) =>
            !newColumns.some((column) =>
              new RegExp(`^\\s+"${column}" `).test(line),
            ),
        )
        .join("\n");
    } else if (
      statement.includes('"production_orders"') &&
      newColumns.some((column) => statement.includes(`"${column}"`))
    )
      continue;
    await db.query(statement);
  }
  // Existing production workflow columns came from the generated baseline; apply its DB invariants.
  await db.query(
    "ALTER TABLE products ALTER COLUMN pos_config_hash SET DEFAULT repeat('0',64); ALTER TABLE product_variations ALTER COLUMN pos_config_hash SET DEFAULT repeat('0',64)",
  );
  await db.query(
    "ALTER TABLE production_orders ADD CONSTRAINT production_orders_status_check CHECK(status IN ('planned','in_progress','paused','completed','cancelled'))",
  );
  await db.query(
    await readFile(
      "prisma/tenant/migrations/20260908090000_production_operations/migration.sql",
      "utf8",
    ),
  );
  // Shared inventory invariants needed by production; the full tenant deployment retains all existing migrations.
  await db.query(await readFile("prisma/tenant/migrations/20260908100000_production_evidence_guards/migration.sql", "utf8"));
  await db.query(await readFile("prisma/tenant/migrations/20260908110000_production_purchase_dimensions/migration.sql", "utf8"));
  await db.query(await readFile("prisma/tenant/migrations/20260908120000_purchase_receipt_evidence/migration.sql", "utf8"));
  await db.query(await readFile("prisma/tenant/migrations/20260908130000_supply_operations_permissions/migration.sql", "utf8"));
  await db.query(`ALTER TABLE pos_inventory_lots ADD CONSTRAINT test_lot_quantity CHECK(quantity_micros >= 0 AND reserved_micros >= 0 AND reserved_micros <= quantity_micros AND (normalized_serial_number IS NULL OR quantity_micros IN (0,1000000)));
    CREATE UNIQUE INDEX test_lot_identity ON pos_inventory_lots(warehouse_id,product_id,variation_id,normalized_lot_code,bucket_key) NULLS NOT DISTINCT WHERE normalized_serial_number IS NULL;
    CREATE UNIQUE INDEX test_serial_identity ON pos_inventory_lots(product_id,normalized_serial_number) WHERE normalized_serial_number IS NOT NULL;
    ALTER TABLE pos_inventory_lot_movements ADD CONSTRAINT test_lot_equation CHECK(balance_after_micros = balance_before_micros + quantity_micros AND balance_after_micros >= 0)`);
  console.log("Isolated schema and production migration applied.");
  await db.query("COMMIT");
}
main()
  .catch(async (error) => {
    await db.query("ROLLBACK");
    throw error;
  })
  .finally(() => db.end());
