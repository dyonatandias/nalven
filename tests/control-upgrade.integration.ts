import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { userInfo } from "node:os";
import test from "node:test";
import { Client } from "pg";

test("upgrade preserva catálogo, vínculos e acesso legado antes da reconciliação", async () => {
  const socket = process.env.CONTROL_AUDIT_SOCKET;
  assert.match(socket || "", /^\/tmp\/nalven-control-audit\.[A-Za-z0-9]+$/);
  const db = new Client({ host: socket, port: 55442, user: userInfo().username, database: "control_upgrade_audit", statement_timeout: 10000 });
  await db.connect();
  try {
    const names = (await readdir("prisma/control/migrations", { withFileTypes: true })).filter(entry => entry.isDirectory()).map(entry => entry.name).sort();
    const boundary = "20260909090000_plan_visibility_ownership";
    for (const name of names.filter(name => name < boundary)) await db.query(await readFile(`prisma/control/migrations/${name}/migration.sql`, "utf8"));
    for (const [id, seats, active] of [["essential", 3, true], ["management", 8, true], ["scale", 25, true], ["fashion-demo", 25, false]] as const) {
      await db.query("INSERT INTO plans(id,name,monthly_price,annual_price,seats,modules,active) VALUES ($1,$1,10,100,$2,'[\"products\"]',$3)", [id, seats, active]);
    }
    await db.query(`INSERT INTO organizations(id,slug,name,document,owner_name,email,plan_id,status,modules,updated_at) VALUES ('upgrade-org','upgrade-org','Synthetic organization','upgrade-doc','Synthetic owner','upgrade@example.invalid','fashion-demo','active','["legacy-custom"]',now())`);
    for (let i = 0; i < 5; i++) {
      await db.query("INSERT INTO users(id,name,email,password_hash,updated_at) VALUES ($1,$1,$2,'invalid-test-hash',now())", [`upgrade-user-${i}`, `upgrade-${i}@example.invalid`]);
      await db.query("INSERT INTO memberships(id,user_id,organization_id,role,status) VALUES ($1,$2,'upgrade-org',$3,'active')", [`upgrade-member-${i}`, `upgrade-user-${i}`, i === 0 ? "owner" : "stock"]);
    }
    const before = (await db.query("SELECT id,name,monthly_price,annual_price,seats,modules,active FROM plans ORDER BY id")).rows;
    const members = (await db.query("SELECT * FROM memberships ORDER BY id")).rows;
    const organization = (await db.query("SELECT * FROM organizations WHERE id='upgrade-org'")).rows[0];
    for (const name of names.filter(name => name >= boundary)) await db.query(await readFile(`prisma/control/migrations/${name}/migration.sql`, "utf8"));
    assert.deepEqual((await db.query("SELECT id,name,monthly_price,annual_price,seats,modules,active FROM plans ORDER BY id")).rows, before);
    assert.deepEqual((await db.query("SELECT * FROM memberships ORDER BY id")).rows, members);
    assert.deepEqual((await db.query("SELECT * FROM organizations WHERE id='upgrade-org'")).rows[0], organization);
    assert.equal((await db.query("SELECT count(*)::int AS count FROM plans WHERE visibility='public'")).rows[0].count, 4);
    // Rehearse the explicitly scoped classification without replacing client entitlements.
    await db.query("UPDATE plans SET visibility='private',owner_organization_id='upgrade-org' WHERE id='fashion-demo' AND active=false");
    assert.equal((await db.query("SELECT count(*)::int AS count FROM plans WHERE visibility='public'")).rows[0].count, 3);
    assert.deepEqual((await db.query("SELECT modules FROM organizations WHERE id='upgrade-org'")).rows[0].modules, ["legacy-custom"]);
    // Old-column writes used by the previous application remain valid after upgrade.
    await db.query("UPDATE organizations SET owner_name='Updated synthetic owner',updated_at=now() WHERE id='upgrade-org'");
    await db.query("UPDATE memberships SET role='sales' WHERE id='upgrade-member-1'");
    assert.equal((await db.query("SELECT count(*)::int AS count FROM memberships WHERE status='active'")).rows[0].count, 5);
    await assert.rejects(db.query("UPDATE organizations SET plan_id='essential' WHERE id='upgrade-org'"), { code: "23514" });
    assert.equal((await db.query("SELECT plan_id FROM organizations WHERE id='upgrade-org'")).rows[0].plan_id, "fashion-demo");
  } finally {
    await db.end();
  }
});
