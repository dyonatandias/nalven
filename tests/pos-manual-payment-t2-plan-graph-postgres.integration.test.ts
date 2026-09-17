import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import test from "node:test";
import { promisify } from "node:util";
import { Client } from "pg";

const execFileAsync = promisify(execFile);
const adminUrl = process.env.TENANT_ROLE_TEST_ADMIN_DATABASE_URL;

test("T2-01 instala capability e cinco guards puros do payment-plan graph", { skip: !adminUrl, timeout: 180_000 }, async () => {
  const token = randomBytes(5).toString("hex"), database = `t2_plan_graph_${token}`, role = `${database}_owner`;
  const password = randomBytes(24).toString("hex"), admin = new Client({ connectionString: adminUrl });
  await admin.connect();
  try {
    await admin.query(`CREATE ROLE "${role}" LOGIN PASSWORD '${password}' NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS`);
    await admin.query(`CREATE DATABASE "${database}" OWNER "${role}"`);
    const url = roleUrl(adminUrl!, role, password, database);
    await execFileAsync("npx", ["prisma", "migrate", "deploy", "--config", "prisma.tenant.config.ts"], { timeout: 150_000, env: { ...process.env, TENANT_DATABASE_URL: url } });
    const db = new Client({ connectionString: url }); await db.connect();
    try {
      const capability = await db.query<{ body: string }>(`SELECT pg_get_functiondef('public.pos_manual_prepare_payment_plan_graph_write_v1(text,text,integer,text,text,text,jsonb,jsonb,jsonb)'::regprocedure) body`);
      const body = capability.rows[0]!.body;
      const core = await db.query<{ body: string }>(`SELECT pg_get_functiondef('public.pos_manual_prepare_payment_plan_graph_write_core_v1(text,text,integer,text,text,text,jsonb,jsonb,jsonb)'::regprocedure) body`);
      const coreBody = core.rows[0]!.body;
      const preview = await db.query<{ body: string }>(`SELECT pg_get_functiondef('public.pos_manual_t2_payment_plan_graph_request_hash_v1(text,text,integer,text,text,jsonb,jsonb,jsonb)'::regprocedure) body`);
      for (const action of ["quote", "activate", "consume", "supersede", "expire"]) assert.match(coreBody, new RegExp(`'${action}'`));
      for (const root of ["payment_plan_graph:operation", "payment_plan_graph:quote_lines", "payment_plan_graph:slots", "payment_plan_graph:plan_transition"]) assert.match(coreBody, new RegExp(root));
      assert.ok(coreBody.indexOf('public."sales_orders"') < coreBody.indexOf('public."pos_order_claims" WHERE id=locator.order_claim_id FOR UPDATE'));
      assert.match(preview.rows[0]!.body, /current_database\(\)[\s\S]*session_user/);
      assert.match(preview.rows[0]!.body, /quantityFloat8Hex/);
      assert.match(preview.rows[0]!.body, /manual payment plan slots remain hard-disabled|proofKind.*manual/);
      assert.match(body, /request hash mismatch/);
      assert.match(coreBody, /request hash changed under lock/);
      assert.match(coreBody, /t2-payment-plan:consume-sale:/);
      assert.doesNotMatch(coreBody, /FROM public\."sales" WHERE id=sale_id FOR UPDATE/);
      assert.ok(coreBody.indexOf('pos_payment_plans" WHERE id=p_plan_id FOR UPDATE') < coreBody.indexOf('pos_payment_intents" WHERE payment_plan_id=p_plan_id'));
      assert.ok(coreBody.indexOf('pos_payment_intents" WHERE payment_plan_id=p_plan_id') < coreBody.indexOf('pos_payment_attempts" attempt'));
      assert.match(coreBody, /payment plan release has unresolved financial evidence/);
      const guards = await db.query<{ name: string; body: string }>(`
        SELECT p.proname name,pg_get_functiondef(p.oid) body FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
        WHERE n.nspname='public' AND p.proname=ANY($1::text[]) ORDER BY p.proname`, [[
          "protect_pos_payment_plan_operation", "protect_pos_payment_plan_quote_line", "protect_pos_payment_plan_slot",
          "validate_pos_payment_plan_activation", "protect_pos_payment_plan",
        ]]);
      assert.equal(guards.rowCount, 5);
      for (const guard of guards.rows) {
        assert.match(guard.body, /pos_manual_t2_observe_write_v1|append-only|immutable/);
        assert.doesNotMatch(guard.body, /\b(?:cash_register_sessions|pos_terminals|tenant_user_profiles|branches|pos_registers|branch_user_accesses|pos_register_accesses|sales_orders|pos_order_claims|pos_held_sales|pos_held_sale_items|pos_connectors|integration_credentials)\b/i, guard.name);
        assert.doesNotMatch(guard.body, /\bFOR\s+(?:UPDATE|SHARE)\b/i, guard.name);
      }
      const branch = (await db.query("INSERT INTO branches(code,name,legal_name,document,status) VALUES($1,'T2 graph','T2 graph',$2,'active') RETURNING id", [`PG-${token}`, `PG${token}`])).rows[0]!;
      const tenantRole = (await db.query("INSERT INTO tenant_roles(key,name,permissions,system,active) VALUES($1,'T2 graph','[]',false,true) RETURNING id", [`pg-${token}`])).rows[0]!;
      const actorUserId = `plan-user-${token}`;
      const profile = (await db.query("INSERT INTO tenant_user_profiles(user_id,role_id,display_name,email,status,active_branch_id) VALUES($1,$2,'T2 graph',$3,'active',$4) RETURNING id", [actorUserId, tenantRole.id, `plan-${token}@invalid`, branch.id])).rows[0]!;
      const register = (await db.query("INSERT INTO pos_registers(branch_id,code,name,status) VALUES($1,$2,'T2 graph','active') RETURNING id", [branch.id, `PGREG-${token}`])).rows[0]!;
      const session = (await db.query("INSERT INTO cash_register_sessions(number,register_name,status,opening_amount,opened_by,operator_profile_id,register_id,version) VALUES($1,'T2 graph','open',0,$2,$3,$4,1) RETURNING id", [`PGSESS-${token}`, actorUserId, profile.id, register.id])).rows[0]!;
      const terminalId = `plan-terminal-${token}`;
      await db.query("INSERT INTO pos_terminals(id,register_id,code,name,status,token_hash,token_issued_at,token_expires_at,credential_version,paired_at,last_seen_at,app_version) VALUES($1,$2,$3,'T2 graph','online','hmac-sha256:v1:'||repeat('a',64),clock_timestamp(),clock_timestamp()+interval '1 hour',1,clock_timestamp(),clock_timestamp(),'1')", [terminalId, register.id, `PGT-${token}`]);
      await db.query("INSERT INTO branch_user_accesses(branch_id,user_profile_id,can_sell) VALUES($1,$2,true)", [branch.id, profile.id]);
      await db.query("INSERT INTO pos_register_accesses(register_id,user_profile_id,active,can_sell) VALUES($1,$2,true,true)", [register.id, profile.id]);
      const product = (await db.query("INSERT INTO products(name,sku,slug,category,updated_at) VALUES('T2 graph',$1,$2,'T2',clock_timestamp()) RETURNING id", [`PGP-${token}`, `plan-${token}`])).rows[0]!;
      const heldId = `plan-held-${token}`, planId = `plan-${token}`, heldRequestHash = "a".repeat(64), quoteHash = "b".repeat(64), idempotencyKey = `plan-quote-${token}`.padEnd(16, "x");
      await db.query("INSERT INTO pos_manual_t2_authorities(capability,role_name,authority_hash) VALUES('runtime',$1,$2)", [role, authorityHash(database, role)]);
      const heldItemTarget = [{ transportOrdinal: 0, productId: product.id, variationId: null, quantity: 1.5, unitPriceCents: 100, discountCents: 0, scanData: null, notes: null }];
      const heldItemKey = `held-items-${token}`.padEnd(16, "x");
      const heldItemRequestHash = (await db.query<{ hash: string }>(`
        WITH material AS (SELECT jsonb_build_object('heldSaleId',$1::text,'productId',(value->>'productId')::int,'variationId',NULL,'quantityFloat8Hex',pos_manual_t2_float8_hex_v1((value->>'quantity')::float8),'unitPriceCents',(value->>'unitPriceCents')::int,'discountCents',(value->>'discountCents')::int,'scanData',NULL,'notes',NULL) doc FROM jsonb_array_elements($2::jsonb)),
        digests AS (SELECT array_agg(encode(sha256(convert_to(pos_manual_canonical_json_v1(doc),'UTF8')),'hex')) values FROM material)
        SELECT pos_manual_t2_held_sale_items_request_hash_v1('insert',$1::text,0,$3::text,$4::text,$5::integer,$6::integer,$7::integer,$8::integer,$9::text,NULL::text,pos_manual_t2_write_observation_multiset_digest_v1(values)) hash FROM digests
      `, [heldId, JSON.stringify(heldItemTarget), actorUserId, heldItemKey, branch.id, register.id, session.id, profile.id, terminalId])).rows[0]!.hash;
      await db.query("BEGIN");
      await db.query("SELECT pos_manual_prepare_held_sale_items_write_v1('insert',$1,0,$2,$3,$4,$5::jsonb,$6::jsonb)", [heldId, actorUserId, heldItemKey, heldItemRequestHash, JSON.stringify({ branchId: branch.id, registerId: register.id, sessionId: session.id, operatorProfileId: profile.id, terminalId, orderClaimId: null }), JSON.stringify(heldItemTarget)]);
      await db.query("INSERT INTO pos_held_sales(id,register_id,session_id,operator_profile_id,status,revision,idempotency_key,request_hash) VALUES($1,$2,$3,$4,'draft',0,$5,$6)", [heldId, register.id, session.id, profile.id, `held-${token}`.padEnd(16, "x"), heldRequestHash]);
      const heldItem = (await db.query("INSERT INTO pos_held_sale_items(held_sale_id,product_id,quantity,unit_price_cents,discount_cents) VALUES($1,$2,1.5,100,0) RETURNING id", [heldId, product.id])).rows[0]!;
      await db.query("COMMIT");
      const draftRequestHash = (await db.query<{ hash: string }>("SELECT pos_manual_t2_payment_plan_draft_snapshot_hash_v1($1) hash", [heldId])).rows[0]!.hash;
      const targetPlan = { id: planId, branchId: branch.id, registerId: register.id, sessionId: session.id, operatorProfileId: profile.id, terminalId, saleDraftId: heldId, draftRevision: 0, draftStatus: "draft", orderClaimId: null, quoteHash, promotionId: null, couponId: null, promotionDiscountCents: 0, currency: "BRL", totalCents: 150, state: "quoted", version: 0 };
      const targetLines = [{ planId, lineIndex: 0, heldSaleItemId: heldItem.id, productId: product.id, variationId: null, quantity: 1.5, unitPriceCents: 100, grossCents: 150, baseDiscountCents: 0, orderDiscountCents: 0, promotionDiscountCents: 0, surchargeCents: 0, totalCents: 150 }];
      const previewArgs = ["quote", planId, 0, actorUserId, idempotencyKey, JSON.stringify(targetPlan), JSON.stringify(targetLines), "[]"];
      const requestHash = (await db.query<{ hash: string }>("SELECT pos_manual_t2_payment_plan_graph_request_hash_v1($1,$2,$3,$4,$5,$6::jsonb,$7::jsonb,$8::jsonb) hash", previewArgs)).rows[0]!.hash;
      await assert.rejects(db.query("SELECT pos_manual_t2_payment_plan_graph_request_hash_v1($1,$2,$3,$4,$5,$6::jsonb,$7::jsonb,$8::jsonb)", ["quote", planId, 0, actorUserId, idempotencyKey, JSON.stringify({ ...targetPlan, requestHash }), JSON.stringify(targetLines), "[]"]), (error: { code?: string }) => error.code === "22023");
      await assert.rejects(db.query("SELECT pos_manual_t2_payment_plan_graph_request_hash_v1($1,$2,$3,$4,$5,$6::jsonb,$7::jsonb,$8::jsonb)", ["activate", planId, 0, actorUserId, idempotencyKey, JSON.stringify({ id: planId, state: "active", version: 1, consumedSaleId: null }), "[]", JSON.stringify([{ planId, paymentIndex: 0, method: "credit", amountCents: 150, installments: 1, proofKind: "manual", connectorId: "manual-disabled", provider: "payment" }])]), (error: { code?: string }) => error.code === "22023");
      await db.query("BEGIN");
      await db.query("SELECT pos_manual_prepare_payment_plan_graph_write_v1($1,$2,$3,$4,$5,$6,$7::jsonb,$8::jsonb,$9::jsonb)", ["quote", planId, 0, actorUserId, idempotencyKey, requestHash, JSON.stringify(targetPlan), JSON.stringify(targetLines), "[]"]);
      await db.query("INSERT INTO pos_payment_plans(id,branch_id,register_id,session_id,operator_profile_id,terminal_id,sale_draft_id,draft_revision,draft_request_hash,draft_status,quote_hash,promotion_discount_cents,evaluated_at,expires_at,currency,total_cents,state,version,idempotency_key,request_hash) VALUES($1,$2,$3,$4,$5,$6,$7,0,$8,'draft',$9,0,transaction_timestamp(),transaction_timestamp()+interval '120 seconds','BRL',150,'quoted',0,$10,$11)", [planId, branch.id, register.id, session.id, profile.id, terminalId, heldId, draftRequestHash, quoteHash, idempotencyKey, requestHash]);
      await db.query("INSERT INTO pos_payment_plan_quote_lines(plan_id,line_index,held_sale_item_id,product_id,quantity,unit_price_cents,gross_cents,base_discount_cents,order_discount_cents,promotion_discount_cents,surcharge_cents,total_cents) VALUES($1,0,$2,$3,1.5,100,150,0,0,0,0,150)", [planId, heldItem.id, product.id]);
      await db.query("INSERT INTO pos_payment_plan_operations(plan_id,action,expected_version,resulting_version,resulting_state,idempotency_key,request_hash,actor_user_id,sale_id) VALUES($1,'quote',-1,0,'quoted',$2,$3,$4,NULL)", [planId, idempotencyKey, requestHash, actorUserId]);
      const pendingRoots = await db.query("SELECT r.id,r.backend_pid,r.transaction_txid,r.nonce_hash,r.capability,r.aggregate_kind,r.aggregate_id,r.action,r.trigger_identity,r.dml_operation,r.expected_observation_count,r.expected_observation_multiset_digest,coalesce(pos_manual_t2_write_observation_multiset_digest_v1(array_agg(o.observation_digest)),'') actual_multiset,jsonb_agg(jsonb_build_object('capability',o.capability,'aggregateKind',o.aggregate_kind,'aggregateId',o.aggregate_id,'action',o.action,'trigger',o.trigger_identity,'dml',o.dml_operation,'digest',o.observation_digest) ORDER BY o.id) observations FROM pos_manual_t2_write_roots r LEFT JOIN pos_manual_t2_write_observations o ON o.root_id=r.id GROUP BY r.id ORDER BY r.id");
      assert.equal(pendingRoots.rowCount, 3, JSON.stringify(pendingRoots.rows));
      const validator = await db.query(`
        SELECT n.backend_pid,n.transaction_txid,n.nonce_hash,
          (SELECT count(*) FROM pos_manual_t2_write_roots root
           LEFT JOIN LATERAL (SELECT count(*)::integer observation_count,array_agg(observation.observation_digest ORDER BY observation.observation_digest COLLATE "C",observation.id) observation_digests FROM pos_manual_t2_write_observations observation WHERE observation.root_id=root.id) actual ON true
           WHERE root.backend_pid=n.backend_pid AND root.transaction_txid=n.transaction_txid AND root.nonce_hash=n.nonce_hash
             AND (actual.observation_count<>root.expected_observation_count OR actual.observation_count NOT BETWEEN 1 AND 2048 OR pos_manual_t2_write_observation_multiset_digest_v1(actual.observation_digests) IS DISTINCT FROM root.expected_observation_multiset_digest OR EXISTS (SELECT 1 FROM pos_manual_t2_write_observations observation WHERE observation.root_id=root.id AND ROW(observation.capability,observation.aggregate_kind,observation.aggregate_id,observation.action,observation.trigger_identity,observation.dml_operation) IS DISTINCT FROM ROW(root.capability,root.aggregate_kind,root.aggregate_id,root.action,root.trigger_identity,root.dml_operation)))) bad_count
        FROM pos_manual_t2_transaction_nonces n`);
      assert.equal(validator.rows[0]!.bad_count, "0", JSON.stringify(pendingRoots.rows));
      await db.query("COMMIT");
      assert.equal((await db.query("SELECT count(*)::int n FROM pos_manual_t2_write_roots")).rows[0]!.n, 0);
      const activateTarget = { id: planId, state: "active", version: 1, consumedSaleId: null };
      const activateSlots = [{ planId, paymentIndex: 0, method: "cash", amountCents: 150, installments: 1, proofKind: "cash", connectorId: null, provider: null }];
      const activateKey = `plan-active-${token}`.padEnd(16, "x");
      const activateHash = (await db.query<{ hash: string }>("SELECT pos_manual_t2_payment_plan_graph_request_hash_v1($1,$2,$3,$4,$5,$6::jsonb,$7::jsonb,$8::jsonb) hash", ["activate", planId, 0, actorUserId, activateKey, JSON.stringify(activateTarget), "[]", JSON.stringify(activateSlots)])).rows[0]!.hash;
      await db.query("BEGIN");
      await db.query("SELECT pos_manual_prepare_payment_plan_graph_write_v1($1,$2,$3,$4,$5,$6,$7::jsonb,$8::jsonb,$9::jsonb)", ["activate", planId, 0, actorUserId, activateKey, activateHash, JSON.stringify(activateTarget), "[]", JSON.stringify(activateSlots)]);
      await db.query("INSERT INTO pos_payment_plan_slots(plan_id,payment_index,method,amount_cents,installments,proof_kind,connector_id,credential_ref,provider) VALUES($1,0,'cash',150,1,'cash',NULL,NULL,NULL)", [planId]);
      await db.query("UPDATE pos_payment_plans SET state='active',version=1 WHERE id=$1", [planId]);
      await db.query("INSERT INTO pos_payment_plan_operations(plan_id,action,expected_version,resulting_version,resulting_state,idempotency_key,request_hash,actor_user_id,sale_id) VALUES($1,'activate',0,1,'active',$2,$3,$4,NULL)", [planId, activateKey, activateHash, actorUserId]);
      assert.equal((await db.query("SELECT count(*)::int n FROM pos_manual_t2_write_roots")).rows[0]!.n, 4);
      await db.query("COMMIT");
      assert.equal((await db.query<{ state: string; version: number }>("SELECT state,version FROM pos_payment_plans WHERE id=$1", [planId])).rows[0]!.state, "active");
      assert.equal((await db.query("SELECT count(*)::int n FROM pos_manual_t2_write_roots")).rows[0]!.n, 0);
      await db.query("BEGIN");
      const reservedSaleId = (await db.query<{ id: number }>("SELECT nextval(pg_get_serial_sequence('sales','id'))::integer id")).rows[0]!.id;
      const consumeTarget = { id: planId, state: "consumed", version: 2, consumedSaleId: reservedSaleId };
      const consumeKey = `plan-consume-${token}`.padEnd(16, "x");
      const consumeHash = (await db.query<{ hash: string }>("SELECT pos_manual_t2_payment_plan_graph_request_hash_v1($1,$2,$3,$4,$5,$6::jsonb,$7::jsonb,$8::jsonb) hash", ["consume", planId, 1, actorUserId, consumeKey, JSON.stringify(consumeTarget), "[]", "[]"])).rows[0]!.hash;
      await db.query("SELECT pos_manual_prepare_payment_plan_graph_write_v1($1,$2,$3,$4,$5,$6,$7::jsonb,$8::jsonb,$9::jsonb)", ["consume", planId, 1, actorUserId, consumeKey, consumeHash, JSON.stringify(consumeTarget), "[]", "[]"]);
      assert.equal((await db.query("SELECT count(*)::int n FROM sales WHERE id=$1", [reservedSaleId])).rows[0]!.n, 0, "consume capability accepts a reserved but not-yet-materialized sale id");
      const paymentId = `plan-cash-${token}`, paymentKey = `pay-${token}`.padEnd(16, "x");
      const paymentTarget = {
        id: paymentId, sale_id: reservedSaleId, connector_id: null, original_payment_id: null,
        processing_session_id: session.id, type: "payment", method: "cash", status: "captured",
        amount_cents: 150, tendered_cents: 150, change_cents: 0, provider: "cash",
        transaction_id: null, end_to_end_id: null, nsu: null, authorization_code: null,
        card_brand: null, card_last_four: null, installments: 1, idempotency_key: paymentKey,
        payment_intent_id: null, compensation_id: null, payment_plan_id: planId, payment_index: 0,
        value_reservation_id: null, value_capture_entry_id: null, value_amount_units: null,
        manual_payment_case_id: null, metadata: { requestHash: consumeHash }, authorized_at: null,
        captured_at: null, refunded_at: null,
      };
      const paymentCapabilityHash = (await db.query<{ hash: string }>("SELECT pos_manual_t2_sale_payment_request_hash_v1('create_commit',$1,1,$2,$3,$4::jsonb) hash", [paymentId, actorUserId, paymentKey, JSON.stringify(paymentTarget)])).rows[0]!.hash;
      await db.query("SELECT pos_manual_prepare_sale_payment_write_v1('create_commit',$1,1,$2,$3,$4,$5::jsonb)", [paymentId, actorUserId, paymentKey, paymentCapabilityHash, JSON.stringify(paymentTarget)]);
      await db.query("INSERT INTO sales(id,sale_number,customer,seller,cash_register,payment_method,total,branch_id,session_id,operator_profile_id,status,subtotal_cents,discount_cents,surcharge_cents,total_cents,change_cents,idempotency_key) VALUES($1,$2,'T2 graph',$3,'T2 graph','cash',150,$4,$5,$6,'completed',150,0,0,150,0,$7)", [reservedSaleId, `PGSALE-${token}`, actorUserId, branch.id, session.id, profile.id, heldId]);
      await db.query("INSERT INTO sale_items(sale_id,product_id,product_name,quantity,unit_price,total,unit_price_cents,gross_cents,discount_cents,surcharge_cents,total_cents) VALUES($1,$2,'T2 graph',1.5,1,150,100,150,0,0,150)", [reservedSaleId, product.id]);
      await db.query("INSERT INTO pos_sale_payments(id,sale_id,processing_session_id,type,method,status,amount_cents,tendered_cents,change_cents,provider,installments,idempotency_key,payment_plan_id,payment_index,metadata) VALUES($1,$2,$3,'payment','cash','captured',150,150,0,'cash',1,$4,$5,0,$6::jsonb)", [paymentId, reservedSaleId, session.id, paymentKey, planId, JSON.stringify(paymentTarget.metadata)]);
      await db.query("UPDATE pos_payment_plans SET state='consumed',version=2,consumed_sale_id=$2 WHERE id=$1", [planId, reservedSaleId]);
      await db.query("INSERT INTO pos_payment_plan_operations(plan_id,action,expected_version,resulting_version,resulting_state,idempotency_key,request_hash,actor_user_id,sale_id) VALUES($1,'consume',1,2,'consumed',$2,$3,$4,$5)", [planId, consumeKey, consumeHash, actorUserId, reservedSaleId]);
      assert.equal((await db.query("SELECT count(*)::int n FROM pos_manual_t2_write_roots")).rows[0]!.n, 4);
      await db.query("COMMIT");
      assert.equal((await db.query<{ state: string; version: number }>("SELECT state,version FROM pos_payment_plans WHERE id=$1", [planId])).rows[0]!.state, "consumed");
      assert.equal((await db.query("SELECT count(*)::int n FROM pos_manual_t2_write_roots")).rows[0]!.n, 0);
      await assert.rejects(
        db.query("UPDATE pos_sale_payments SET status='partially_refunded' WHERE id=$1", [paymentId]),
        (error: { code?: string }) => error.code === "42501",
        "sale-payment DML direto deve permanecer fail-closed",
      );
      assert.equal((await db.query("SELECT has_function_privilege('public','pos_manual_prepare_sale_payment_write_v1(text,text,integer,text,text,text,jsonb)','EXECUTE') allowed")).rows[0]!.allowed, false);
      assert.equal((await db.query("SELECT has_function_privilege('public','pos_manual_t2_sale_payment_evidence_transport_safe_v1(text)','EXECUTE') allowed")).rows[0]!.allowed, false);
      const quotePlan = async (id: string, keyPrefix: string) => {
        const plan = { ...targetPlan, id };
        const lines = targetLines.map((line) => ({ ...line, planId: id }));
        const key = `${keyPrefix}-${token}`.padEnd(16, "x");
        const hash = (await db.query<{ hash: string }>("SELECT pos_manual_t2_payment_plan_graph_request_hash_v1($1,$2,$3,$4,$5,$6::jsonb,$7::jsonb,$8::jsonb) hash", ["quote", id, 0, actorUserId, key, JSON.stringify(plan), JSON.stringify(lines), "[]"])).rows[0]!.hash;
        await db.query("BEGIN");
        await db.query("SELECT pos_manual_prepare_payment_plan_graph_write_v1($1,$2,$3,$4,$5,$6,$7::jsonb,$8::jsonb,$9::jsonb)", ["quote", id, 0, actorUserId, key, hash, JSON.stringify(plan), JSON.stringify(lines), "[]"]);
        await db.query("INSERT INTO pos_payment_plans(id,branch_id,register_id,session_id,operator_profile_id,terminal_id,sale_draft_id,draft_revision,draft_request_hash,draft_status,quote_hash,promotion_discount_cents,evaluated_at,expires_at,currency,total_cents,state,version,idempotency_key,request_hash) VALUES($1,$2,$3,$4,$5,$6,$7,0,$8,'draft',$9,0,transaction_timestamp(),transaction_timestamp()+interval '120 seconds','BRL',150,'quoted',0,$10,$11)", [id, branch.id, register.id, session.id, profile.id, terminalId, heldId, draftRequestHash, quoteHash, key, hash]);
        await db.query("INSERT INTO pos_payment_plan_quote_lines(plan_id,line_index,held_sale_item_id,product_id,quantity,unit_price_cents,gross_cents,base_discount_cents,order_discount_cents,promotion_discount_cents,surcharge_cents,total_cents) VALUES($1,0,$2,$3,1.5,100,150,0,0,0,0,150)", [id, heldItem.id, product.id]);
        await db.query("INSERT INTO pos_payment_plan_operations(plan_id,action,expected_version,resulting_version,resulting_state,idempotency_key,request_hash,actor_user_id,sale_id) VALUES($1,'quote',-1,0,'quoted',$2,$3,$4,NULL)", [id, key, hash, actorUserId]);
        await db.query("COMMIT");
      };
      const mismatchPlanId = `plan-consume-mismatch-${token}`;
      await quotePlan(mismatchPlanId, "plan-consume-mismatch-quote");
      const mismatchActivateTarget = { id: mismatchPlanId, state: "active", version: 1, consumedSaleId: null };
      const mismatchActivateSlots = activateSlots.map((slot) => ({ ...slot, planId: mismatchPlanId }));
      const mismatchActivateKey = `plan-consume-mismatch-active-${token}`.padEnd(16, "x");
      const mismatchActivateHash = (await db.query<{ hash: string }>("SELECT pos_manual_t2_payment_plan_graph_request_hash_v1($1,$2,$3,$4,$5,$6::jsonb,$7::jsonb,$8::jsonb) hash", ["activate", mismatchPlanId, 0, actorUserId, mismatchActivateKey, JSON.stringify(mismatchActivateTarget), "[]", JSON.stringify(mismatchActivateSlots)])).rows[0]!.hash;
      await db.query("BEGIN");
      await db.query("SELECT pos_manual_prepare_payment_plan_graph_write_v1($1,$2,$3,$4,$5,$6,$7::jsonb,$8::jsonb,$9::jsonb)", ["activate", mismatchPlanId, 0, actorUserId, mismatchActivateKey, mismatchActivateHash, JSON.stringify(mismatchActivateTarget), "[]", JSON.stringify(mismatchActivateSlots)]);
      await db.query("INSERT INTO pos_payment_plan_slots(plan_id,payment_index,method,amount_cents,installments,proof_kind,connector_id,credential_ref,provider) VALUES($1,0,'cash',150,1,'cash',NULL,NULL,NULL)", [mismatchPlanId]);
      await db.query("UPDATE pos_payment_plans SET state='active',version=1 WHERE id=$1", [mismatchPlanId]);
      await db.query("INSERT INTO pos_payment_plan_operations(plan_id,action,expected_version,resulting_version,resulting_state,idempotency_key,request_hash,actor_user_id,sale_id) VALUES($1,'activate',0,1,'active',$2,$3,$4,NULL)", [mismatchPlanId, mismatchActivateKey, mismatchActivateHash, actorUserId]);
      await db.query("COMMIT");
      await db.query("BEGIN");
      const mismatchSaleId = (await db.query<{ id: number }>("SELECT nextval(pg_get_serial_sequence('sales','id'))::integer id")).rows[0]!.id;
      const mismatchConsumeTarget = { id: mismatchPlanId, state: "consumed", version: 2, consumedSaleId: mismatchSaleId };
      const mismatchConsumeKey = `plan-consume-mismatch-${token}`.padEnd(16, "x");
      const mismatchConsumeHash = (await db.query<{ hash: string }>("SELECT pos_manual_t2_payment_plan_graph_request_hash_v1($1,$2,$3,$4,$5,$6::jsonb,$7::jsonb,$8::jsonb) hash", ["consume", mismatchPlanId, 1, actorUserId, mismatchConsumeKey, JSON.stringify(mismatchConsumeTarget), "[]", "[]"])).rows[0]!.hash;
      await db.query("SELECT pos_manual_prepare_payment_plan_graph_write_v1($1,$2,$3,$4,$5,$6,$7::jsonb,$8::jsonb,$9::jsonb)", ["consume", mismatchPlanId, 1, actorUserId, mismatchConsumeKey, mismatchConsumeHash, JSON.stringify(mismatchConsumeTarget), "[]", "[]"]);
      assert.equal((await db.query("SELECT count(*)::int n FROM sales WHERE id=$1", [mismatchSaleId])).rows[0]!.n, 0);
      await db.query("INSERT INTO sales(id,sale_number,customer,seller,cash_register,payment_method,total,branch_id,session_id,operator_profile_id,status,subtotal_cents,discount_cents,surcharge_cents,total_cents,change_cents,idempotency_key) VALUES($1,$2,'T2 graph',$3,'T2 graph','cash',150,$4,$5,$6,'completed',150,0,0,150,0,$7)", [mismatchSaleId, `PGSALE-MISMATCH-${token}`, actorUserId, branch.id, session.id, profile.id, `wrong-${heldId}`]);
      await assert.rejects(db.query("UPDATE pos_payment_plans SET state='consumed',version=2,consumed_sale_id=$2 WHERE id=$1", [mismatchPlanId, mismatchSaleId]), (error: { code?: string }) => error.code === "23514");
      await db.query("ROLLBACK");
      assert.equal((await db.query("SELECT count(*)::int n FROM pos_manual_t2_write_roots")).rows[0]!.n, 0, "failed sale boundary leaves no deferred write roots");
      assert.equal((await db.query<{ state: string; version: number }>("SELECT state,version FROM pos_payment_plans WHERE id=$1", [mismatchPlanId])).rows[0]!.state, "active");
      const mismatchCloseTarget = { id: mismatchPlanId, state: "superseded", version: 2, consumedSaleId: null };
      const mismatchCloseKey = `plan-consume-mismatch-close-${token}`.padEnd(16, "x");
      const mismatchCloseHash = (await db.query<{ hash: string }>("SELECT pos_manual_t2_payment_plan_graph_request_hash_v1($1,$2,$3,$4,$5,$6::jsonb,$7::jsonb,$8::jsonb) hash", ["supersede", mismatchPlanId, 1, actorUserId, mismatchCloseKey, JSON.stringify(mismatchCloseTarget), "[]", "[]"])).rows[0]!.hash;
      await db.query("BEGIN");
      await db.query("SELECT pos_manual_prepare_payment_plan_graph_write_v1($1,$2,$3,$4,$5,$6,$7::jsonb,$8::jsonb,$9::jsonb)", ["supersede", mismatchPlanId, 1, actorUserId, mismatchCloseKey, mismatchCloseHash, JSON.stringify(mismatchCloseTarget), "[]", "[]"]);
      await db.query("UPDATE pos_payment_plans SET state='superseded',version=2 WHERE id=$1", [mismatchPlanId]);
      await db.query("INSERT INTO pos_payment_plan_operations(plan_id,action,expected_version,resulting_version,resulting_state,idempotency_key,request_hash,actor_user_id,sale_id) VALUES($1,'supersede',1,2,'superseded',$2,$3,$4,NULL)", [mismatchPlanId, mismatchCloseKey, mismatchCloseHash, actorUserId]);
      await db.query("COMMIT");
      const supersedePlanId = `plan-sup-${token}`;
      await quotePlan(supersedePlanId, "plan-sup-quote");
      const earlyExpireTarget = { id: supersedePlanId, state: "expired", version: 1, consumedSaleId: null };
      const earlyExpireKey = `plan-early-exp-${token}`.padEnd(16, "x");
      const earlyExpireHash = (await db.query<{ hash: string }>("SELECT pos_manual_t2_payment_plan_graph_request_hash_v1($1,$2,$3,$4,$5,$6::jsonb,$7::jsonb,$8::jsonb) hash", ["expire", supersedePlanId, 0, "system:pos-payment-maintenance", earlyExpireKey, JSON.stringify(earlyExpireTarget), "[]", "[]"])).rows[0]!.hash;
      await assert.rejects(db.query("SELECT pos_manual_prepare_payment_plan_graph_write_v1($1,$2,$3,$4,$5,$6,$7::jsonb,$8::jsonb,$9::jsonb)", ["expire", supersedePlanId, 0, "system:pos-payment-maintenance", earlyExpireKey, earlyExpireHash, JSON.stringify(earlyExpireTarget), "[]", "[]"]), (error: { code?: string }) => error.code === "23514");
      const supersedeTarget = { id: supersedePlanId, state: "superseded", version: 1, consumedSaleId: null };
      const supersedeKey = `plan-sup-${token}`.padEnd(16, "x");
      const supersedeHash = (await db.query<{ hash: string }>("SELECT pos_manual_t2_payment_plan_graph_request_hash_v1($1,$2,$3,$4,$5,$6::jsonb,$7::jsonb,$8::jsonb) hash", ["supersede", supersedePlanId, 0, actorUserId, supersedeKey, JSON.stringify(supersedeTarget), "[]", "[]"])).rows[0]!.hash;
      await db.query("BEGIN");
      await db.query("SELECT pos_manual_prepare_payment_plan_graph_write_v1($1,$2,$3,$4,$5,$6,$7::jsonb,$8::jsonb,$9::jsonb)", ["supersede", supersedePlanId, 0, actorUserId, supersedeKey, supersedeHash, JSON.stringify(supersedeTarget), "[]", "[]"]);
      await db.query("UPDATE pos_payment_plans SET state='superseded',version=1 WHERE id=$1", [supersedePlanId]);
      await db.query("INSERT INTO pos_payment_plan_operations(plan_id,action,expected_version,resulting_version,resulting_state,idempotency_key,request_hash,actor_user_id,sale_id) VALUES($1,'supersede',0,1,'superseded',$2,$3,$4,NULL)", [supersedePlanId, supersedeKey, supersedeHash, actorUserId]);
      assert.equal((await db.query("SELECT count(*)::int n FROM pos_manual_t2_write_roots")).rows[0]!.n, 2);
      await db.query("COMMIT");
      const expirePlanId = `plan-exp-${token}`;
      await quotePlan(expirePlanId, "plan-exp-quote");
      const fixtureUrl = new URL(adminUrl!); fixtureUrl.pathname = `/${database}`;
      const fixture = new Client({ connectionString: fixtureUrl.toString() }); await fixture.connect();
      try {
        await fixture.query("BEGIN");
        await fixture.query("SET LOCAL session_replication_role=replica");
        await fixture.query("UPDATE pos_payment_plans SET evaluated_at=transaction_timestamp()-interval '121 seconds',expires_at=transaction_timestamp()-interval '1 second' WHERE id=$1", [expirePlanId]);
        await fixture.query("COMMIT");
      } finally { await fixture.end(); }
      const expireTarget = { id: expirePlanId, state: "expired", version: 1, consumedSaleId: null };
      const expireKey = `plan-expire-${token}`.padEnd(16, "x");
      const expireHash = (await db.query<{ hash: string }>("SELECT pos_manual_t2_payment_plan_graph_request_hash_v1($1,$2,$3,$4,$5,$6::jsonb,$7::jsonb,$8::jsonb) hash", ["expire", expirePlanId, 0, "system:pos-payment-maintenance", expireKey, JSON.stringify(expireTarget), "[]", "[]"])).rows[0]!.hash;
      await db.query("BEGIN");
      await db.query("SELECT pos_manual_prepare_payment_plan_graph_write_v1($1,$2,$3,$4,$5,$6,$7::jsonb,$8::jsonb,$9::jsonb)", ["expire", expirePlanId, 0, "system:pos-payment-maintenance", expireKey, expireHash, JSON.stringify(expireTarget), "[]", "[]"]);
      await db.query("UPDATE pos_payment_plans SET state='expired',version=1 WHERE id=$1", [expirePlanId]);
      await db.query("INSERT INTO pos_payment_plan_operations(plan_id,action,expected_version,resulting_version,resulting_state,idempotency_key,request_hash,actor_user_id,sale_id) VALUES($1,'expire',0,1,'expired',$2,$3,$4,NULL)", [expirePlanId, expireKey, expireHash, "system:pos-payment-maintenance"]);
      assert.equal((await db.query("SELECT count(*)::int n FROM pos_manual_t2_write_roots")).rows[0]!.n, 2);
      await db.query("COMMIT");
      assert.equal((await db.query<{ state: string }>("SELECT state FROM pos_payment_plans WHERE id=$1", [expirePlanId])).rows[0]!.state, "expired");
      assert.equal((await db.query("SELECT count(*)::int n FROM pos_manual_t2_write_roots")).rows[0]!.n, 0);
      await assert.rejects(db.query("UPDATE pos_payment_plans SET state='superseded',version=3 WHERE id=$1", [planId]), (error: { code?: string }) => error.code === "23514");
    } finally { await db.end(); }
  } finally {
    await admin.query("SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname=$1", [database]).catch(() => undefined);
    await admin.query(`DROP DATABASE IF EXISTS "${database}"`).catch(() => undefined);
    await admin.query(`DROP ROLE IF EXISTS "${role}"`).catch(() => undefined);
    await admin.end();
  }
});

function roleUrl(base: string, username: string, password: string, database: string) {
  const url = new URL(base); url.username = username; url.password = password; url.pathname = `/${database}`; return url.toString();
}

function authorityHash(database: string, role: string) {
  return createHash("sha256").update(`t2-authority-v1\0${database}\0${role}`).digest("hex");
}
