import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import test from "node:test";
import { promisify } from "node:util";
import { Client } from "pg";

const execFileAsync = promisify(execFile);
const adminUrl = process.env.TENANT_ROLE_TEST_ADMIN_DATABASE_URL;

const expectedTriggers = new Map<string, readonly [string, string]>([
  ["pos_held_sale_items_payment_plan_guard", ["pos_held_sale_items", "protect_held_sale_item_with_open_payment_plan()"]],
  ["pos_payment_intents_t2_write_guard", ["pos_payment_intents", "protect_pos_payment_intent_artifact_t2()"]],
  ["pos_manual_payment_references_t2_write_guard", ["pos_manual_payment_references", "protect_pos_manual_payment_reference_t2()"]],
  ["pos_sale_payments_t2_write_guard", ["pos_sale_payments", "protect_pos_sale_payment_t2()"]],
  ["pos_payment_plan_operations_insert_guard", ["pos_payment_plan_operations", "protect_pos_payment_plan_operation()"]],
  ["pos_payment_plan_operations_immutable_guard", ["pos_payment_plan_operations", "protect_pos_payment_plan_operation()"]],
  ["pos_payment_plan_quote_lines_immutable_guard", ["pos_payment_plan_quote_lines", "protect_pos_payment_plan_quote_line()"]],
  ["pos_payment_plan_slots_immutable_guard", ["pos_payment_plan_slots", "protect_pos_payment_plan_slot()"]],
  ["pos_payment_plans_activation_guard", ["pos_payment_plans", "validate_pos_payment_plan_activation()"]],
  ["pos_payment_plans_immutable_guard", ["pos_payment_plans", "protect_pos_payment_plan()"]],
  ["pos_order_claim_identity_guard", ["pos_order_claims", "enforce_pos_order_claim_identity()"]],
  ["pos_order_claim_operations_write_guard", ["pos_order_claim_operations", "protect_pos_order_claim_operation()"]],
]);

// The §6 row guards are deliberately closed over OLD/NEW plus owner-only T2
// capability state. A non-locking read of a business relation would still be
// a TOCTOU decision made after the writer's canonical prelock, so keep the
// denylist explicit and catalog-tested.
const forbiddenBusinessRelations = [
  "branches",
  "branch_user_accesses",
  "cash_register_sessions",
  "integration_credentials",
  "integration_providers",
  "order_shipping_labels",
  "order_tracking",
  "pos_connectors",
  "pos_held_sale_items",
  "pos_held_sales",
  "pos_manual_payment_references",
  "pos_order_claims",
  "pos_payment_intents",
  "pos_payment_plan_operations",
  "pos_payment_plan_quote_lines",
  "pos_payment_plan_slots",
  "pos_payment_plans",
  "pos_register_accesses",
  "pos_registers",
  "pos_sale_payments",
  "pos_terminals",
  "pos_value_accounts",
  "pos_value_ledger_entries",
  "pos_value_programs",
  "pos_value_reservations",
  "sales",
  "sales_orders",
  "shipments",
  "tenant_user_profiles",
] as const;

const forbiddenBusinessRelationPattern = new RegExp(
  `\\b(?:${forbiddenBusinessRelations.join("|")})\\b`,
  "i",
);

test("T2-01 §6 mantém allowlist fechada e triggers sem locks de business roots", { skip: !adminUrl, timeout: 180_000 }, async () => {
  const token = randomBytes(5).toString("hex");
  const database = `t2_trigger_prelock_${token}`;
  const migratorRole = `${database}_migrator`;
  const password = randomBytes(24).toString("hex");
  const admin = new Client({ connectionString: adminUrl });
  await admin.connect();
  try {
    await admin.query(`CREATE ROLE "${migratorRole}" LOGIN PASSWORD '${password}' NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS`);
    await admin.query(`CREATE DATABASE "${database}" OWNER "${migratorRole}"`);
    const migratorUrl = roleUrl(adminUrl!, migratorRole, password, database);
    await execFileAsync("npx", ["prisma", "migrate", "deploy", "--config", "prisma.tenant.config.ts"], {
      timeout: 150_000,
      env: { ...process.env, TENANT_DATABASE_URL: migratorUrl },
    });
    const db = new Client({ connectionString: migratorUrl });
    await db.connect();
    try {
      const rows = await db.query<{
        trigger_name: string;
        table_name: string;
        function_identity: string;
        function_definition: string;
      }>(`
        SELECT trigger_row.tgname trigger_name,
               relation.relname table_name,
               routine.oid::regprocedure::text function_identity,
               pg_get_functiondef(routine.oid) function_definition
          FROM pg_trigger trigger_row
          JOIN pg_class relation ON relation.oid=trigger_row.tgrelid
          JOIN pg_namespace namespace ON namespace.oid=relation.relnamespace
          JOIN pg_proc routine ON routine.oid=trigger_row.tgfoid
         WHERE namespace.nspname='public' AND NOT trigger_row.tgisinternal
           AND trigger_row.tgname=ANY($1::text[])
         ORDER BY trigger_row.tgname
      `, [[...expectedTriggers.keys()]]);
      assert.equal(rows.rowCount, expectedTriggers.size);
      for (const row of rows.rows) {
        const expected = expectedTriggers.get(row.trigger_name);
        assert.ok(expected, `trigger inesperado: ${row.trigger_name}`);
        assert.deepEqual([row.table_name, row.function_identity], [...expected], row.trigger_name);
        assert.doesNotMatch(row.function_definition, /\bFOR\s+(?:NO\s+KEY\s+)?UPDATE\b|\bFOR\s+(?:KEY\s+)?SHARE\b/i, row.trigger_name);
        assert.doesNotMatch(
          row.function_definition,
          /\b(?:assert_pos_payment_plan_live_access|lock_pos_payment_plan(?:_graph)?|lock_pos_order_claim|lock_pos_held_sale|lock_pos_payment_intent_canonical)\s*\(/i,
          `${row.trigger_name} chama helper conhecido que adquire business roots`,
        );
        assert.doesNotMatch(
          row.function_definition,
          forbiddenBusinessRelationPattern,
          `${row.trigger_name} consulta business root depois do prelock canônico`,
        );
      }

      const expectedFunctionIdentities = [...new Set([...expectedTriggers.values()].map(([, identity]) => identity))];
      const extra = await db.query<{ trigger_name: string; function_identity: string }>(`
        SELECT trigger_row.tgname trigger_name,routine.oid::regprocedure::text function_identity
          FROM pg_trigger trigger_row
          JOIN pg_class relation ON relation.oid=trigger_row.tgrelid
          JOIN pg_namespace namespace ON namespace.oid=relation.relnamespace
          JOIN pg_proc routine ON routine.oid=trigger_row.tgfoid
         WHERE namespace.nspname='public' AND NOT trigger_row.tgisinternal
           AND routine.oid::regprocedure::text=ANY($1::text[])
           AND NOT (trigger_row.tgname=ANY($2::text[]))
      `, [expectedFunctionIdentities, [...expectedTriggers.keys()]]);
      assert.deepEqual(extra.rows, [], "função guard §6 foi ligada a trigger fora da allowlist");
    } finally {
      await db.end();
    }
  } finally {
    await admin.query("SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname=$1", [database]).catch(() => undefined);
    await admin.query(`DROP DATABASE IF EXISTS "${database}"`).catch(() => undefined);
    await admin.query(`DROP ROLE IF EXISTS "${migratorRole}"`).catch(() => undefined);
    await admin.end();
  }
});

function roleUrl(base: string, username: string, password: string, database: string) {
  const url = new URL(base);
  url.username = username;
  url.password = password;
  url.pathname = `/${database}`;
  return url.toString();
}
