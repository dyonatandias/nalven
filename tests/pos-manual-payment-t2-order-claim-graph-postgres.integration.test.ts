import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { promisify } from "node:util";
import test from "node:test";
import { Client, type DatabaseError } from "pg";

const execFileAsync = promisify(execFile);
const adminConnectionString = process.env.TENANT_ROLE_TEST_ADMIN_DATABASE_URL;
const capabilitySignature = "pos_manual_prepare_order_claim_write_v1(text,text,integer,integer,integer,text,text,text,jsonb)";

/**
 * ABI decision exercised here until the action-specific JSON shapes are frozen:
 * - claim carries every caller-controlled immutable identity plus state/version;
 * - renew/release/expire carry id/state/resulting version;
 * - database timestamps, lease, lifecycle_txid and write_txid are server-owned;
 * - claim and its append-only operation consume distinct authenticated roots.
 */
test("T2-01 PG18: capability governa claim + operation com guards puros e fail-closed", {
  skip: !adminConnectionString,
  timeout: 300_000,
}, async () => {
  const token = randomBytes(5).toString("hex");
  const database = `t2_claim_${token}`;
  const runtimeRole = `${database}_runtime`;
  const runtimePassword = randomBytes(24).toString("base64url");
  const admin = new Client({ connectionString: adminConnectionString });
  await admin.connect();
  try {
    await admin.query(`CREATE ROLE "${runtimeRole}" LOGIN PASSWORD '${runtimePassword}'`);
    await admin.query(`CREATE DATABASE "${database}"`);
    const ownerUrl = databaseUrl(adminConnectionString!, database);
    await execFileAsync("npx", ["prisma", "migrate", "deploy", "--config", "prisma.tenant.config.ts"], {
      timeout: 180_000,
      env: { ...process.env, TENANT_DATABASE_URL: ownerUrl },
    });
    await execFileAsync("npx", ["tsx", "prisma/tenant/seed.ts"], {
      timeout: 120_000,
      env: { ...process.env, TENANT_DATABASE_URL: ownerUrl },
    });

    const owner = new Client({ connectionString: ownerUrl });
    await owner.connect();
    try {
      assert.equal((await owner.query("SELECT to_regprocedure($1) IS NOT NULL present", [capabilitySignature])).rows[0]?.present, true, capabilitySignature);
      const fixture = await prepareFixture(owner, token);
      await owner.query(`GRANT EXECUTE ON FUNCTION public.${capabilitySignature} TO "${runtimeRole}"`);
      await owner.query(`GRANT SELECT,INSERT,UPDATE ON pos_order_claims,pos_order_claim_operations TO "${runtimeRole}"`);
      await owner.query(`GRANT SELECT,INSERT ON sales TO "${runtimeRole}"`);
      await owner.query(`GRANT SELECT ON pos_payment_plans TO "${runtimeRole}"`);
      await owner.query(`GRANT USAGE,SELECT ON SEQUENCE pos_order_claim_operations_id_seq,sales_id_seq TO "${runtimeRole}"`);
      // Test-only introspection of transaction-scoped roots. Production runtime
      // remains denied by the deployment grant contract.
      await owner.query(`GRANT SELECT ON pos_manual_t2_write_roots,pos_manual_t2_write_observations TO "${runtimeRole}"`);
      await owner.query("DELETE FROM pos_manual_t2_authorities WHERE capability='runtime'");
      await owner.query(
        "INSERT INTO pos_manual_t2_authorities(capability,role_name,authority_hash) VALUES('runtime',$1,$2)",
        [runtimeRole, authorityHash(database, runtimeRole)],
      );

      const runtime = new Client({ connectionString: roleUrl(ownerUrl, runtimeRole, runtimePassword) });
      await runtime.connect();
      try {
        await positiveClaimRenewRelease(runtime, owner, fixture, token);
        await expireSystemOnly(runtime, owner, fixture, token);
        await convertWithExactSaleCause(runtime, owner, fixture, token);
        await failClosedAndRootMismatch(runtime, owner, fixture, token);
        await assertPureGuardCatalog(owner);
      } finally {
        await runtime.end();
      }
    } finally {
      await owner.end();
    }
  } finally {
    await admin.query("SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname=$1", [database]).catch(() => undefined);
    await admin.query(`DROP DATABASE IF EXISTS "${database}"`).catch(() => undefined);
    await admin.query(`DROP ROLE IF EXISTS "${runtimeRole}"`).catch(() => undefined);
    await admin.end();
  }
});

async function positiveClaimRenewRelease(runtime: Client, owner: Client, fixture: Fixture, token: string) {
  const claimId = randomUUID();
  const claimRowIdempotency = `claim-row-${token}-00000001`;
  const claimOperationIdempotency = `${claimRowIdempotency}:claim`;
  const claimHash = digest(`claim:${token}`);
  const claimTarget = {
    id: claimId,
    salesOrderId: fixture.orderId,
    branchId: fixture.branchId,
    registerId: fixture.registerId,
    sessionId: fixture.sessionId,
    operatorProfileId: fixture.profileId,
    terminalId: fixture.terminalId,
    state: "active",
    version: 0,
    idempotencyKey: claimRowIdempotency,
    requestHash: claimHash,
  };

  await runtime.query("BEGIN ISOLATION LEVEL SERIALIZABLE");
  try {
    await prepare(runtime, "claim", claimId, fixture.sessionId, fixture.orderId, 0, fixture.actorUserId, claimOperationIdempotency, claimHash, claimTarget);
    const roots = await runtime.query<{ trigger_identity: string; dml_operation: string }>(`
      SELECT trigger_identity,dml_operation FROM pos_manual_t2_write_roots
       WHERE capability LIKE 'order_claim%' AND aggregate_id=$1 ORDER BY trigger_identity
    `, [claimId]);
    assert.deepEqual(roots.rows, [
      { trigger_identity: "pos_order_claim_identity_guard", dml_operation: "INSERT" },
      { trigger_identity: "pos_order_claim_operations_write_guard", dml_operation: "INSERT" },
    ]);
    await runtime.query(`
      INSERT INTO pos_order_claims(id,sales_order_id,branch_id,register_id,session_id,operator_profile_id,terminal_id,state,version,lease_expires_at,idempotency_key,request_hash)
      VALUES($1,$2,$3,$4,$5,$6,$7,'active',0,transaction_timestamp()+interval '120 seconds',$8,$9)
    `, [claimId, fixture.orderId, fixture.branchId, fixture.registerId, fixture.sessionId, fixture.profileId, fixture.terminalId, claimRowIdempotency, claimHash]);
    await runtime.query(`
      INSERT INTO pos_order_claim_operations(claim_id,action,expected_version,resulting_version,resulting_state,idempotency_key,request_hash,lease_expires_at)
      SELECT id,'claim',0,0,'active',$2,$3,lease_expires_at FROM pos_order_claims WHERE id=$1
    `, [claimId, claimOperationIdempotency, claimHash]);
    assert.equal((await runtime.query("SELECT count(*)::int count FROM pos_manual_t2_write_observations WHERE aggregate_id=$1", [claimId])).rows[0]?.count, 2);
    await runtime.query("COMMIT");
  } catch (error) {
    await runtime.query("ROLLBACK");
    throw error;
  }
  assert.equal((await owner.query("SELECT count(*)::int count FROM pos_manual_t2_write_roots WHERE aggregate_id=$1", [claimId])).rows[0]?.count, 0);
  assert.equal((await owner.query("SELECT count(*)::int count FROM pos_manual_t2_write_observations WHERE aggregate_id=$1", [claimId])).rows[0]?.count, 0);

  const renewHash = digest(`renew:${token}`), renewIdempotency = `claim-renew-${token}-00000001`;
  await transition(runtime, fixture, claimId, "renew", 0, renewIdempotency, renewHash, `
    UPDATE pos_order_claims SET version=1,renewed_at=transaction_timestamp(),lease_expires_at=transaction_timestamp()+interval '120 seconds' WHERE id=$1
  `, "active");

  const releaseHash = digest(`release:${token}`), releaseIdempotency = `claim-release-${token}-00000001`;
  await transition(runtime, fixture, claimId, "release", 1, releaseIdempotency, releaseHash, `
    UPDATE pos_order_claims SET state='released',version=2,released_at=transaction_timestamp() WHERE id=$1
  `, "released");
  const final = await owner.query("SELECT state,version,released_at IS NOT NULL released FROM pos_order_claims WHERE id=$1", [claimId]);
  assert.deepEqual(final.rows[0], { state: "released", version: 2, released: true });
}

async function convertWithExactSaleCause(runtime: Client, owner: Client, fixture: Fixture, token: string) {
  const orderId = await createOrder(owner, fixture.branchId, token, "convert");
  const claimId = randomUUID(), rowIdempotency = `convert-row-${token}-00000001`, claimHash = digest(`convert-claim:${token}`);
  const claimTarget = {
    id: claimId, salesOrderId: orderId, branchId: fixture.branchId, registerId: fixture.registerId,
    sessionId: fixture.sessionId, operatorProfileId: fixture.profileId, terminalId: fixture.terminalId,
    state: "active", version: 0, idempotencyKey: rowIdempotency, requestHash: claimHash,
  };
  await runtime.query("BEGIN ISOLATION LEVEL SERIALIZABLE");
  try {
    await prepare(runtime, "claim", claimId, fixture.sessionId, orderId, 0, fixture.actorUserId, `${rowIdempotency}:claim`, claimHash, claimTarget);
    await runtime.query(`
      INSERT INTO pos_order_claims(id,sales_order_id,branch_id,register_id,session_id,operator_profile_id,terminal_id,state,version,lease_expires_at,idempotency_key,request_hash)
      VALUES($1,$2,$3,$4,$5,$6,$7,'active',0,transaction_timestamp()+interval '120 seconds',$8,$9)
    `, [claimId, orderId, fixture.branchId, fixture.registerId, fixture.sessionId, fixture.profileId, fixture.terminalId, rowIdempotency, claimHash]);
    await runtime.query(`INSERT INTO pos_order_claim_operations(claim_id,action,expected_version,resulting_version,resulting_state,idempotency_key,request_hash,lease_expires_at)
      SELECT id,'claim',0,0,'active',$2,$3,lease_expires_at FROM pos_order_claims WHERE id=$1`, [claimId, `${rowIdempotency}:claim`, claimHash]);
    await runtime.query("COMMIT");
  } catch (error) { await runtime.query("ROLLBACK"); throw error; }

  const convertHash = digest(`convert:${token}`), convertIdempotency = `claim-convert-${token}-00000001`;
  await runtime.query("BEGIN ISOLATION LEVEL SERIALIZABLE");
  try {
    const saleId = (await runtime.query(`
      INSERT INTO sales(sale_number,customer,seller,cash_register,payment_method,total,branch_id,session_id,operator_profile_id,status,
       subtotal_cents,discount_cents,surcharge_cents,total_cents,change_cents,idempotency_key,source_type,source_id)
      VALUES($1,'T2 claim convert',$2,'T2 claim','cash',1,$3,$4,$5,'completed',100,0,0,100,0,$6,'sales_order',$7) RETURNING id
    `, [`CLAIM-SALE-${token}`, fixture.actorUserId, fixture.branchId, fixture.sessionId, fixture.profileId, `claim-sale-${token}-00000001`, String(orderId)])).rows[0].id;
    await prepare(runtime, "convert", claimId, fixture.sessionId, orderId, 0, fixture.actorUserId, convertIdempotency, convertHash,
      { id: claimId, state: "converted", version: 1, convertedSaleId: saleId });
    await runtime.query("UPDATE pos_order_claims SET state='converted',version=1,converted_sale_id=$2,converted_at=transaction_timestamp() WHERE id=$1", [claimId, saleId]);
    await runtime.query(`INSERT INTO pos_order_claim_operations(claim_id,action,expected_version,resulting_version,resulting_state,idempotency_key,request_hash,lease_expires_at)
      SELECT id,'convert',0,1,'converted',$2,$3,lease_expires_at FROM pos_order_claims WHERE id=$1`, [claimId, convertIdempotency, convertHash]);
    await runtime.query("COMMIT");
  } catch (error) { await runtime.query("ROLLBACK"); throw error; }
  assert.deepEqual((await owner.query("SELECT state,converted_sale_id IS NOT NULL converted FROM pos_order_claims WHERE id=$1", [claimId])).rows[0],
    { state: "converted", converted: true });
}

async function transition(runtime: Client, fixture: Fixture, claimId: string, action: "renew" | "release", expectedVersion: number, idempotencyKey: string, requestHash: string, updateSql: string, resultingState: string) {
  await runtime.query("BEGIN ISOLATION LEVEL SERIALIZABLE");
  try {
    await prepare(runtime, action, claimId, fixture.sessionId, fixture.orderId, expectedVersion, fixture.actorUserId, idempotencyKey, requestHash, { id: claimId, state: resultingState, version: expectedVersion + 1 });
    await runtime.query(updateSql, [claimId]);
    await runtime.query(`
      INSERT INTO pos_order_claim_operations(claim_id,action,expected_version,resulting_version,resulting_state,idempotency_key,request_hash,lease_expires_at)
      SELECT id,$2,$3,$3+1,$4,$5,$6,lease_expires_at FROM pos_order_claims WHERE id=$1
    `, [claimId, action, expectedVersion, resultingState, idempotencyKey, requestHash]);
    await runtime.query("COMMIT");
  } catch (error) {
    await runtime.query("ROLLBACK");
    throw error;
  }
}

async function expireSystemOnly(runtime: Client, owner: Client, fixture: Fixture, token: string) {
  const orderId = await createOrder(owner, fixture.branchId, token, "expired");
  const claimId = randomUUID(), rowIdempotency = `expired-row-${token}-00000001`, originalHash = digest(`expired-original:${token}`);
  await owner.query("BEGIN");
  try {
    await owner.query("SET LOCAL session_replication_role=replica");
    await owner.query(`
      INSERT INTO pos_order_claims(id,sales_order_id,branch_id,register_id,session_id,operator_profile_id,terminal_id,state,version,lease_expires_at,idempotency_key,request_hash,claimed_at,updated_at)
      VALUES($1,$2,$3,$4,$5,$6,$7,'active',0,transaction_timestamp()-interval '1 second',$8,$9,transaction_timestamp()-interval '121 seconds',transaction_timestamp())
    `, [claimId, orderId, fixture.branchId, fixture.registerId, fixture.sessionId, fixture.profileId, fixture.terminalId, rowIdempotency, originalHash]);
    await owner.query(`
      INSERT INTO pos_order_claim_operations(claim_id,action,expected_version,resulting_version,resulting_state,idempotency_key,request_hash,lease_expires_at)
      SELECT id,'claim',0,0,'active',$2,$3,lease_expires_at FROM pos_order_claims WHERE id=$1
    `, [claimId, `${rowIdempotency}:claim`, originalHash]);
    await owner.query("COMMIT");
  } catch (error) {
    await owner.query("ROLLBACK");
    throw error;
  }
  const expireHash = digest(`expire:${token}`), expireIdempotency = `claim-expire-${token}-00000001`;
  await assertSqlState(runtime, async () => {
    await prepare(runtime, "expire", claimId, fixture.sessionId, orderId, 0, fixture.actorUserId, expireIdempotency, expireHash, { id: claimId, state: "expired", version: 1 });
  }, "22023");
  await runtime.query("BEGIN ISOLATION LEVEL SERIALIZABLE");
  try {
    await prepare(runtime, "expire", claimId, fixture.sessionId, orderId, 0, "system:pos-order-claim-expiry", expireIdempotency, expireHash, { id: claimId, state: "expired", version: 1 });
    await runtime.query("UPDATE pos_order_claims SET state='expired',version=1,released_at=transaction_timestamp() WHERE id=$1", [claimId]);
    await runtime.query(`
      INSERT INTO pos_order_claim_operations(claim_id,action,expected_version,resulting_version,resulting_state,idempotency_key,request_hash,lease_expires_at)
      SELECT id,'expire',0,1,'expired',$2,$3,lease_expires_at FROM pos_order_claims WHERE id=$1
    `, [claimId, expireIdempotency, expireHash]);
    await runtime.query("COMMIT");
  } catch (error) {
    await runtime.query("ROLLBACK");
    throw error;
  }
  assert.equal((await owner.query("SELECT state FROM pos_order_claims WHERE id=$1", [claimId])).rows[0]?.state, "expired");
}

async function failClosedAndRootMismatch(runtime: Client, owner: Client, fixture: Fixture, token: string) {
  const orderId = await createOrder(owner, fixture.branchId, token, "negative");
  const claimId = randomUUID(), rowIdempotency = `negative-row-${token}-00000001`, requestHash = digest(`negative:${token}`);
  await assertSqlState(runtime, async () => {
    await runtime.query(`
      INSERT INTO pos_order_claims(id,sales_order_id,branch_id,register_id,session_id,operator_profile_id,terminal_id,lease_expires_at,idempotency_key,request_hash)
      VALUES($1,$2,$3,$4,$5,$6,$7,transaction_timestamp()+interval '120 seconds',$8,$9)
    `, [claimId, orderId, fixture.branchId, fixture.registerId, fixture.sessionId, fixture.profileId, fixture.terminalId, rowIdempotency, requestHash]);
  }, "42501");
  await assertSqlState(runtime, async () => {
    await runtime.query(`
      INSERT INTO pos_order_claim_operations(claim_id,action,expected_version,resulting_version,resulting_state,idempotency_key,request_hash,lease_expires_at)
      VALUES($1,'claim',0,0,'active',$2,$3,transaction_timestamp()+interval '120 seconds')
    `, [randomUUID(), `direct-operation-${token}-00000001`, requestHash]);
  }, "42501");

  await runtime.query("BEGIN");
  try {
    await prepare(runtime, "claim", claimId, fixture.sessionId, orderId, 0, fixture.actorUserId, `${rowIdempotency}:claim`, requestHash, {
      id: claimId, salesOrderId: orderId, branchId: fixture.branchId, registerId: fixture.registerId, sessionId: fixture.sessionId,
      operatorProfileId: fixture.profileId, terminalId: fixture.terminalId, state: "active", version: 0,
      idempotencyKey: rowIdempotency, requestHash,
    });
    await assert.rejects(runtime.query("COMMIT"), (error: DatabaseError) => error.code === "23514", "root sem observations deve falhar no commit");
  } finally {
    await runtime.query("ROLLBACK").catch(() => undefined);
  }

  await runtime.query("BEGIN");
  try {
    await prepare(runtime, "claim", claimId, fixture.sessionId, orderId, 0, fixture.actorUserId, `${rowIdempotency}:claim`, requestHash, {
      id: claimId, salesOrderId: orderId, branchId: fixture.branchId, registerId: fixture.registerId, sessionId: fixture.sessionId,
      operatorProfileId: fixture.profileId, terminalId: fixture.terminalId, state: "active", version: 0,
      idempotencyKey: rowIdempotency, requestHash,
    });
    await assert.rejects(runtime.query(`
      INSERT INTO pos_order_claims(id,sales_order_id,branch_id,register_id,session_id,operator_profile_id,terminal_id,state,version,lease_expires_at,idempotency_key,request_hash)
      VALUES($1,$2,$3,$4,$5,$6,$7,'released',0,transaction_timestamp()+interval '120 seconds',$8,$9)
    `, [claimId, orderId, fixture.branchId, fixture.registerId, fixture.sessionId, fixture.profileId, fixture.terminalId, rowIdempotency, requestHash]), /capability|claim|42501/i);
  } finally {
    await runtime.query("ROLLBACK").catch(() => undefined);
  }
}

async function assertPureGuardCatalog(owner: Client) {
  const rows = await owner.query<{ trigger_name: string; function_name: string; body: string }>(`
    SELECT trigger.tgname trigger_name,routine.proname function_name,pg_get_functiondef(routine.oid) body
      FROM pg_trigger trigger JOIN pg_proc routine ON routine.oid=trigger.tgfoid
     WHERE NOT trigger.tgisinternal AND trigger.tgrelid IN ('pos_order_claims'::regclass,'pos_order_claim_operations'::regclass)
       AND trigger.tgname IN ('pos_order_claim_identity_guard','pos_order_claim_operations_write_guard')
     ORDER BY trigger.tgname
  `);
  assert.deepEqual(rows.rows.map((row) => row.trigger_name), ["pos_order_claim_identity_guard", "pos_order_claim_operations_write_guard"]);
  for (const row of rows.rows) {
    assert.match(row.body, /pos_manual_t2_observe_write_v1/);
    assert.doesNotMatch(row.body, /\b(?:SELECT|PERFORM)\b[\s\S]*\bFROM\s+(?:public\.)?"?(?:cash_register_sessions|pos_terminals|tenant_user_profiles|branches|pos_registers|branch_user_accesses|pos_register_accesses|sales_orders|sales|pos_held_sales|pos_payment_intents|pos_manual_payment_references|pos_sale_payments)"?/i, row.function_name);
    assert.doesNotMatch(row.body, /\bFOR\s+(?:UPDATE|SHARE)\b|pg_advisory/i, row.function_name);
  }
}

async function prepare(client: Client, action: string, claimId: string, sessionId: number, salesOrderId: number, expectedVersion: number, actorUserId: string, idempotencyKey: string, requestHash: string, target: object) {
  await client.query(`SELECT pos_manual_prepare_order_claim_write_v1($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb)`, [
    action, claimId, sessionId, salesOrderId, expectedVersion, actorUserId, idempotencyKey, requestHash, JSON.stringify(target),
  ]);
}

async function prepareFixture(owner: Client, token: string): Promise<Fixture> {
  const role = (await owner.query("SELECT id FROM tenant_roles WHERE active ORDER BY id LIMIT 1")).rows[0];
  assert.ok(role, "seed precisa fornecer tenant role ativo");
  const branchId = (await owner.query("INSERT INTO branches(code,name,legal_name,document,status) VALUES($1,$2,$3,$4,'active') RETURNING id", [`CL${token}`, "T2 claim", "T2 claim LTDA", `DOC${token}`])).rows[0].id;
  const actorUserId = `t2-claim-user-${token}`;
  const profileId = (await owner.query("INSERT INTO tenant_user_profiles(user_id,role_id,display_name,email,status,active_branch_id) VALUES($1,$2,'T2 claim',$3,'active',$4) RETURNING id", [actorUserId, role.id, `claim-${token}@example.invalid`, branchId])).rows[0].id;
  await owner.query("INSERT INTO branch_user_accesses(branch_id,user_profile_id,can_sell,\"primary\") VALUES($1,$2,true,true)", [branchId, profileId]);
  const registerId = (await owner.query("INSERT INTO pos_registers(branch_id,code,name,status) VALUES($1,$2,'T2 claim register','active') RETURNING id", [branchId, `REG${token}`])).rows[0].id;
  await owner.query("INSERT INTO pos_register_accesses(register_id,user_profile_id,active,can_sell,valid_from,valid_until) VALUES($1,$2,true,true,transaction_timestamp()-interval '1 minute',transaction_timestamp()+interval '1 day')", [registerId, profileId]);
  const terminalId = randomUUID();
  await owner.query(`
    INSERT INTO pos_terminals(id,register_id,code,name,status,token_hash,token_issued_at,token_expires_at,credential_version,app_version,last_seen_at,paired_at)
    VALUES($1,$2,$3,'T2 claim terminal','online',$4,transaction_timestamp(),transaction_timestamp()+interval '1 day',1,'test-1',transaction_timestamp(),transaction_timestamp())
  `, [terminalId, registerId, `TERM${token}`, `hmac-sha256:v1:${digest(`token:${token}`)}`]);
  const openRequestHash = createHash("sha256").update(JSON.stringify({ registerId, openingAmountCents: 0, terminalId })).digest("hex");
  const sessionId = (await owner.query(`
    INSERT INTO cash_register_sessions(number,register_name,status,opening_amount,opening_amount_cents,opened_by,register_id,operator_profile_id,version,open_request_hash)
    VALUES($1,'T2 claim register','open',0,0,'T2 claim',$2,$3,1,$4) RETURNING id
  `, [`SESSION${token}`, registerId, profileId, openRequestHash])).rows[0].id;
  const orderId = await createOrder(owner, branchId, token, "main");
  return { branchId, profileId, actorUserId, registerId, terminalId, sessionId, orderId };
}

async function createOrder(owner: Client, branchId: number, token: string, suffix: string) {
  const productId = (await owner.query(`
    INSERT INTO products(name,slug,sku,category,price,regular_price,manage_stock,updated_at)
    VALUES($1,$2,$3,'Teste',1,1,false,transaction_timestamp()) RETURNING id
  `, [`Produto ${suffix}`, `t2-claim-${suffix}-${token}`, `T2-${suffix}-${token}`])).rows[0].id;
  const orderId = (await owner.query(`
    INSERT INTO sales_orders(number,order_key,kind,status,currency,origin,branch_id,customer_name,sales_channel,created_by,payment_method,payment_installments,delivery_type,subtotal,total)
    VALUES($1,$2,'order','approved','BRL','manual',$3,'Cliente','direct','T2 claim','Pix',1,'pickup',1,1) RETURNING id
  `, [`ORDER-${suffix}-${token}`, digest(`order-key:${suffix}:${token}`), branchId])).rows[0].id;
  await owner.query(`
    INSERT INTO sales_order_items(sales_order_id,product_id,item_type,name_snapshot,sku_snapshot,quantity,list_price,unit_price,discount,total,refunded_quantity)
    VALUES($1,$2,'line_item','Produto',$3,1,1,1,0,1,0)
  `, [orderId, productId, `T2-${suffix}-${token}`]);
  return orderId;
}

async function assertSqlState(client: Client, operation: () => Promise<unknown>, expected: string) {
  await client.query("BEGIN");
  try {
    await assert.rejects(operation, (error: DatabaseError) => error.code === expected, `SQLSTATE ${expected}`);
  } finally {
    await client.query("ROLLBACK").catch(() => undefined);
  }
}

function digest(value: string) { return createHash("sha256").update(value).digest("hex"); }
function authorityHash(database: string, role: string) { return digest(`t2-authority-v1\0${database}\0${role}`); }

function databaseUrl(base: string, database: string) {
  const url = new URL(base); url.pathname = `/${database}`; return url.toString();
}
function roleUrl(base: string, role: string, password: string) {
  const url = new URL(base); url.username = role; url.password = password; return url.toString();
}

type Fixture = { branchId: number; profileId: number; actorUserId: string; registerId: number; terminalId: string; sessionId: number; orderId: number };
