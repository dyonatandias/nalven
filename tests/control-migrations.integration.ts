import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { userInfo } from "node:os";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import { Client } from "pg";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../generated/control/client";
import { isPlanCapacityError } from "../lib/plan-capacity-error";

test("cadeia completa registra checksums e protege planos privados sob concorrência", async () => {
  const socket = process.env.CONTROL_AUDIT_SOCKET;
  assert.match(socket || "", /^\/tmp\/nalven-control-audit\.[A-Za-z0-9]+$/);
  const configuration = { host: socket, port: 55442, user: userInfo().username, database: "control_migration_audit", statement_timeout: 10000 };
  const db = new Client(configuration), other = new Client(configuration);
  await db.connect();
  await other.connect();
  try {
    const otherPid = (await other.query("SELECT pg_backend_pid() AS pid")).rows[0].pid;
    async function waitUntilBlocked() {
      for (let attempt = 0; attempt < 100; attempt++) {
        if ((await db.query("SELECT cardinality(pg_blocking_pids($1)) AS count", [otherPid])).rows[0].count > 0) return;
        await delay(10);
      }
      assert.fail("A segunda conexão não aguardou o lock concorrente");
    }
    const names = (await readdir("prisma/control/migrations", { withFileTypes: true })).filter(entry => entry.isDirectory()).map(entry => entry.name).sort();
    const history = (await db.query("SELECT migration_name, checksum, finished_at, rolled_back_at FROM _prisma_migrations ORDER BY migration_name")).rows;
    assert.deepEqual(history.map(row => row.migration_name), names);
    for (const row of history) {
      assert.ok(row.finished_at);
      assert.equal(row.rolled_back_at, null);
      const sql = await readFile(`prisma/control/migrations/${row.migration_name}/migration.sql`);
      assert.equal(row.checksum, createHash("sha256").update(sql).digest("hex"));
    }
    await db.query(`INSERT INTO plans(id,name,monthly_price,annual_price,seats,modules) VALUES ('public','Public',10,100,5,'["@policy:v1","products.read"]')`);
    for (const id of ["client-a", "client-b"]) await db.query(`INSERT INTO organizations(id,slug,name,document,owner_name,email,plan_id,status,modules,updated_at) VALUES ($1,$1,$1,$1,'Test','test@example.invalid','public','active','[]',now())`, [id]);
    assert.deepEqual((await db.query("SELECT modules FROM organizations WHERE id='client-a'")).rows[0].modules, ["@policy:v1", "products.read"]);
    await db.query(`INSERT INTO plans(id,name,monthly_price,annual_price,seats,modules,visibility,owner_organization_id) VALUES ('private','Private',10,100,5,'["@policy:v1","reports.read"]','private','client-a')`);
    await assert.rejects(db.query("UPDATE organizations SET plan_id='private' WHERE id='client-b'"), { code: "23514" });
    await db.query("UPDATE organizations SET plan_id='private' WHERE id='client-a'");
    assert.deepEqual((await db.query("SELECT modules FROM organizations WHERE id='client-a'")).rows[0].modules, ["@policy:v1", "reports.read"]);
    await assert.rejects(db.query("UPDATE plans SET owner_organization_id='client-b' WHERE id='private'"), { code: "23514" });
    // The first transaction holds a plan row lock before privatizing it.
    // A concurrent assignment must observe the committed owner and be rejected.
    await db.query(`INSERT INTO plans(id,name,monthly_price,annual_price,seats,modules) VALUES ('race','Race',10,100,5,'[]')`);
    await db.query("BEGIN");
    await db.query("UPDATE plans SET visibility='private',owner_organization_id='client-a' WHERE id='race'");
    const rejectedAssignment = assert.rejects(other.query("UPDATE organizations SET plan_id='race' WHERE id='client-b'"), { code: "23514" });
    await waitUntilBlocked();
    await db.query("COMMIT");
    await rejectedAssignment;
    // Reverse order: an uncommitted assignment prevents a later incompatible owner.
    await db.query("UPDATE plans SET visibility='public',owner_organization_id=NULL WHERE id='race'");
    await db.query("BEGIN");
    await db.query("UPDATE organizations SET plan_id='race' WHERE id='client-b'");
    const rejectedOwner = assert.rejects(other.query("UPDATE plans SET visibility='private',owner_organization_id='client-a' WHERE id='race'"), { code: "23514" });
    await waitUntilBlocked();
    await db.query("COMMIT");
    await rejectedOwner;
    assert.equal((await db.query("SELECT count(*)::int AS count FROM organizations o JOIN plans p ON p.id=o.plan_id WHERE p.visibility='private' AND p.owner_organization_id<>o.id")).rows[0].count, 0);
    await db.query("UPDATE plans SET seats=1 WHERE id='race'");
    for (const id of ["user-a", "user-b"]) await db.query("INSERT INTO users(id,name,email,password_hash,updated_at) VALUES ($1,$1,$1,'not-a-login-hash',now())", [id]);
    await db.query("BEGIN");
    await db.query("INSERT INTO memberships(id,user_id,organization_id,role) VALUES ('member-a','user-a','client-b','owner')");
    const rejectedSeat = assert.rejects(other.query("INSERT INTO memberships(id,user_id,organization_id) VALUES ('member-b','user-b','client-b')"), { code: "23514", message: "NALVEN_PLAN_CAPACITY" });
    await waitUntilBlocked();
    await db.query("COMMIT");
    await rejectedSeat;
    await db.query("INSERT INTO memberships(id,user_id,organization_id,status) VALUES ('member-b','user-b','client-b','disabled')");
    await assert.rejects(db.query("UPDATE memberships SET status='active' WHERE id='member-b'"), { code: "23514" });
    const prisma = new PrismaClient({ adapter: new PrismaPg(configuration) });
    try {
      await assert.rejects(prisma.membership.update({ where: { id: "member-b" }, data: { status: "active" } }), error => isPlanCapacityError(error));
    } finally { await prisma.$disconnect(); }
    await db.query("UPDATE plans SET seats=2 WHERE id='race'");
    await db.query("UPDATE memberships SET status='active' WHERE id='member-b'");
    await assert.rejects(db.query("UPDATE plans SET seats=1 WHERE id='race'"), { code: "23514" });
    await db.query("UPDATE plans SET seats=1 WHERE id='public'");
    await assert.rejects(db.query("UPDATE organizations SET plan_id='public' WHERE id='client-b'"), { code: "23514" });
    await db.query("UPDATE memberships SET status='disabled' WHERE id='member-b'");
    await db.query("UPDATE organizations SET plan_id='public' WHERE id='client-b'");
    assert.equal((await db.query("SELECT count(*)::int AS count FROM memberships WHERE organization_id='client-b' AND status='active'")).rows[0].count, 1);
    await db.query("UPDATE plans SET seats=2 WHERE id='public'");
    await db.query("BEGIN");
    await db.query("UPDATE memberships SET status='active' WHERE id='member-b'");
    const rejectedReduction = assert.rejects(other.query("UPDATE plans SET seats=1 WHERE id='public'"), { code: "23514", message: "NALVEN_PLAN_CAPACITY" });
    await waitUntilBlocked();
    await db.query("COMMIT");
    await rejectedReduction;
  } finally {
    await db.query("ROLLBACK").catch(() => undefined);
    await Promise.all([db.end(), other.end()]);
  }
});
