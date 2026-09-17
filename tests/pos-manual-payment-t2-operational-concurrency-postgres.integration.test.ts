import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { promisify } from "node:util";
import test from "node:test";
import { Client, type DatabaseError } from "pg";

const execFileAsync = promisify(execFile);
const adminUrl = process.env.TENANT_ROLE_TEST_ADMIN_DATABASE_URL;

test("T2-01 PG18 operacional: guards one-shot e case-open serializa com as três ABIs", { skip: !adminUrl, timeout: 300_000 }, async () => {
  const token = randomBytes(5).toString("hex"); const db = `t2_ops_${token}`;
  const ownerRole = `${db}_owner`; const runtimeRole = `${db}_runtime`;
  const ownerPassword = randomBytes(24).toString("hex"); const runtimePassword = randomBytes(24).toString("hex");
  const admin = await connect(adminUrl!);
  try {
    await admin.query(`CREATE ROLE "${ownerRole}" LOGIN NOINHERIT PASSWORD '${ownerPassword}'`);
    await admin.query(`CREATE ROLE "${runtimeRole}" LOGIN NOINHERIT PASSWORD '${runtimePassword}'`);
    await admin.query(`CREATE DATABASE "${db}" OWNER "${ownerRole}"`);
    const ownerUrl = roleUrl(adminUrl!,db,ownerRole,ownerPassword); const runtimeUrl = roleUrl(adminUrl!,db,runtimeRole,runtimePassword);
    await execFileAsync("npx",["prisma","migrate","deploy","--config","prisma.tenant.config.ts"],{ timeout:180_000,env:{...process.env,TENANT_DATABASE_URL:ownerUrl} });
    const owner = await connect(ownerUrl); const fixtureAdmin = await connect(databaseUrl(adminUrl!,db));
    const monitor = await connect(databaseUrl(adminUrl!,db)); const runtime = await connect(runtimeUrl);
    try {
      const fixture = await createFixture(fixtureAdmin);
      await owner.query(`GRANT CONNECT ON DATABASE "${db}" TO "${runtimeRole}"; GRANT USAGE ON SCHEMA public TO "${runtimeRole}"`);
      for (const signature of [
        "pos_manual_prepare_session_transition_v1(text,integer,integer,integer,text,text,text)",
        "pos_manual_prepare_handoff_transition_v1(text,text,integer,integer,integer,integer,integer,text,text,text,text,timestamptz,jsonb)",
        "pos_manual_t2_payment_plan_graph_request_hash_v1(text,text,integer,text,text,jsonb,jsonb,jsonb)",
        "pos_manual_prepare_payment_plan_graph_write_v1(text,text,integer,text,text,text,jsonb,jsonb,jsonb)",
      ]) await owner.query(`GRANT EXECUTE ON FUNCTION public.${signature} TO "${runtimeRole}"`);
      await owner.query("INSERT INTO pos_manual_t2_authorities(capability,role_name,authority_hash) VALUES('runtime',$1,$2)",[runtimeRole,authorityHash(db,runtimeRole)]);
      await owner.query(`GRANT SELECT,UPDATE ON ALL TABLES IN SCHEMA public TO "${runtimeRole}"; GRANT INSERT ON pos_payment_plan_operations,cash_register_events TO "${runtimeRole}"; GRANT USAGE ON SEQUENCE pos_payment_plan_operations_id_seq,cash_register_events_id_seq TO "${runtimeRole}"`);
      await owner.query(`REVOKE ALL ON pos_manual_t2_transaction_nonces,pos_manual_t2_lock_contexts FROM "${runtimeRole}"`);
      await assertDenied(runtime,"SELECT * FROM pos_manual_t2_transaction_nonces",[]);
      await assertDenied(runtime,"INSERT INTO pos_manual_t2_transaction_nonces(backend_pid,transaction_txid,nonce_hash) VALUES(pg_backend_pid(),txid_current(),$1)",[hash("forged-nonce")]);

      await assertDenied(runtime,"UPDATE cash_register_sessions SET status='suspended',version=version+1 WHERE id=$1",[fixture.oneShotSessionId]);

      await runtime.query("BEGIN");
      await runtime.query("SELECT pos_manual_prepare_session_transition_v1('suspend',$1,1,$2,$3,$4,$5)",[fixture.oneShotSessionId,fixture.oneShotActorProfileId,fixture.oneShotActorUserId,"session-partial-key",hash("session-partial")]);
      await runtime.query("UPDATE cash_register_sessions SET status='suspended',version=2 WHERE id=$1",[fixture.oneShotSessionId]);
      await assert.rejects(runtime.query("COMMIT"),(error:DatabaseError)=>error.code==="23514");

      await runtime.query("BEGIN");
      await runtime.query("SELECT set_config('nalven.t2_context_nonce','caller-controlled',true)");
      await runtime.query("SELECT pos_manual_prepare_session_transition_v1('suspend',$1,1,$2,$3,$4,$5)",[fixture.oneShotSessionId,fixture.oneShotActorProfileId,fixture.oneShotActorUserId,"session-one-shot-key",hash("session")]);
      await runtime.query("UPDATE cash_register_sessions SET status='suspended',version=2 WHERE id=$1",[fixture.oneShotSessionId]);
      await runtime.query("SAVEPOINT event_tamper");
      await assertDenied(runtime,"INSERT INTO cash_register_events(session_id,type,amount,amount_cents,description,actor,reason_code,idempotency_key,request_hash) VALUES($1,'session_suspended',0,0,'T2 suspend','T2 actor','session_suspended',$2,$3)",[fixture.oneShotSessionId,"session-one-shot-key",hash("wrong-session")]);
      await runtime.query("ROLLBACK TO SAVEPOINT event_tamper");
      await runtime.query("INSERT INTO cash_register_events(session_id,type,amount,amount_cents,description,actor,reason_code,idempotency_key,request_hash) VALUES($1,'session_suspended',0,0,'T2 suspend','T2 actor','session_suspended',$2,$3)",[fixture.oneShotSessionId,"session-one-shot-key",hash("session")]);
      await runtime.query("SAVEPOINT replay");
      await assertDenied(runtime,"UPDATE cash_register_sessions SET status='open',version=1 WHERE id=$1",[fixture.oneShotSessionId]);
      await runtime.query("ROLLBACK TO SAVEPOINT replay");
      assert.equal((await owner.query("SELECT count(*)::int n FROM pos_manual_t2_lock_contexts")).rows[0].n,0);
      await runtime.query("ROLLBACK");
      assert.equal((await owner.query("SELECT count(*)::int n FROM pos_manual_t2_lock_contexts")).rows[0].n,0);
      assert.equal((await owner.query("SELECT count(*)::int n FROM pos_manual_t2_transaction_nonces")).rows[0].n,0);

      await assertDenied(runtime,"UPDATE pos_session_handoffs SET state='expired',revision=2,resolution_request_hash=$2 WHERE id=$1",[fixture.handoffId,hash("handoff-direct")]);
      const handoffRequestHash=hash("handoff-authorized");
      await runtime.query("BEGIN");
      await runtime.query("SELECT pos_manual_prepare_handoff_transition_v1('expire',$1,$2,1,1,NULL,$3,$4,$5,$6,NULL::text,NULL::timestamptz,NULL::jsonb)",[fixture.handoffId,fixture.sessionId,fixture.actorProfileId,fixture.actorUserId,"handoff-authorized-key",handoffRequestHash]);
      await runtime.query("UPDATE pos_session_handoffs SET state='expired',revision=2,resolution_request_hash=$2,resolution_idempotency_key=$3,resolved_by_actor_id=$4,resolved_at=clock_timestamp() WHERE id=$1",[fixture.handoffId,handoffRequestHash,"handoff-authorized-key",fixture.actorUserId]);
      await runtime.query("SAVEPOINT replay");
      await assertDenied(runtime,"UPDATE pos_session_handoffs SET state='requested',revision=1,resolution_request_hash=NULL WHERE id=$1",[fixture.handoffId]);
      await runtime.query("ROLLBACK TO SAVEPOINT replay");
      assert.equal((await owner.query("SELECT count(*)::int n FROM pos_manual_t2_lock_contexts")).rows[0].n,0);
      await runtime.query("ROLLBACK");
      assert.equal((await owner.query("SELECT count(*)::int n FROM pos_manual_t2_lock_contexts")).rows[0].n,0);

      await assertDenied(runtime,"UPDATE pos_payment_plans SET state='superseded',version=1,superseded_at=clock_timestamp() WHERE id=$1",[fixture.planId]);
      await runtime.query("BEGIN");
      await preparePlanSupersede(runtime,fixture,"plan-partial-key");
      await runtime.query("SAVEPOINT plan_partial");
      await runtime.query("UPDATE pos_payment_plans SET state='superseded',version=1,superseded_at=transaction_timestamp(),updated_at=transaction_timestamp(),lifecycle_txid=txid_current() WHERE id=$1",[fixture.planId]);
      await assert.rejects(runtime.query("COMMIT"),(error:DatabaseError)=>error.code==="23514");
      await runtime.query("BEGIN");
      const authorizedPlanHash=await preparePlanSupersede(runtime,fixture,"plan-authorized-key");
      await runtime.query("INSERT INTO pos_payment_plan_operations(plan_id,action,expected_version,resulting_version,resulting_state,idempotency_key,request_hash,actor_user_id) VALUES($1,'supersede',0,1,'superseded',$2,$3,$4)",[fixture.planId,"plan-authorized-key",authorizedPlanHash,fixture.actorUserId]);
      await runtime.query("UPDATE pos_payment_plans SET state='superseded',version=1,superseded_at=transaction_timestamp(),updated_at=transaction_timestamp(),lifecycle_txid=txid_current() WHERE id=$1",[fixture.planId]);
      await runtime.query("SAVEPOINT replay");
      await assertDenied(runtime,"UPDATE pos_payment_plans SET state='quoted',version=0,superseded_at=NULL WHERE id=$1",[fixture.planId]);
      await runtime.query("ROLLBACK TO SAVEPOINT replay");
      assert.equal((await owner.query("SELECT count(*)::int n FROM pos_manual_t2_lock_contexts")).rows[0].n,0);
      await runtime.query("ROLLBACK");
      assert.equal((await owner.query("SELECT count(*)::int n FROM pos_manual_t2_lock_contexts")).rows[0].n,0);

      const scenarios: Scenario[] = [
        { name:"session-close", prepare:(client) => client.query("SELECT pos_manual_prepare_session_transition_v1('close',$1,1,$2,$3,$4,$5)",[fixture.sessionId,fixture.actorProfileId,fixture.actorUserId,"close-race-key",hash("close")]) },
        { name:"handoff-expire", prepare:(client) => client.query("SELECT pos_manual_prepare_handoff_transition_v1('expire',$1,$2,1,1,NULL,$3,$4,$5,$6,NULL::text,NULL::timestamptz,NULL::jsonb)",[fixture.handoffId,fixture.sessionId,fixture.actorProfileId,fixture.actorUserId,"handoff-expire-key",hash("handoff")]) },
        { name:"plan-supersede", prepare:(client) => preparePlanSupersede(client,fixture,"plan-supersede-key") },
      ];
      for (const scenario of scenarios) {
        await removeCases(fixtureAdmin);
        await caseFirstRejects(fixtureAdmin,monitor,runtime,fixture,scenario);
        await removeCases(fixtureAdmin);
        await transitionFirstSerializes(fixtureAdmin,monitor,runtime,fixture,scenario);
      }
    } finally { await Promise.all([runtime.end(),monitor.end(),fixtureAdmin.end(),owner.end()].map((p)=>p.catch(()=>undefined))); }
  } finally {
    await admin.query("SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname=$1",[db]).catch(()=>undefined);
    await admin.query(`DROP DATABASE IF EXISTS "${db}"`).catch(()=>undefined);
    await admin.query(`DROP ROLE IF EXISTS "${runtimeRole}"`).catch(()=>undefined);
    await admin.query(`DROP ROLE IF EXISTS "${ownerRole}"`).catch(()=>undefined);
    await admin.end();
  }
});

type Fixture={branchId:number;registerId:number;sessionId:number;oneShotSessionId:number;oneShotActorProfileId:number;oneShotActorUserId:string;actorProfileId:number;actorUserId:string;handoffId:string;planId:string};
type Scenario={name:string;prepare:(client:Client)=>Promise<unknown>};

async function createFixture(admin:Client):Promise<Fixture>{
  const suffix=randomBytes(4).toString("hex"); const handoffId=`handoff-${suffix}`; const planId=`plan-${suffix}`;
  await admin.query("SET session_replication_role=replica");
  try {
    const branch=(await admin.query("INSERT INTO branches(code,name,legal_name,document,status) VALUES($1,'T2 ops','T2 ops', $2,'active') RETURNING id",[`OPS-${suffix}`,`OPS${suffix}`])).rows[0];
    const role=(await admin.query("INSERT INTO tenant_roles(key,name,permissions,system,active) VALUES($1,'T2 ops','[]',false,true) RETURNING id",[`ops-${suffix}`])).rows[0];
    const profile=(await admin.query("INSERT INTO tenant_user_profiles(user_id,role_id,display_name,email,status,active_branch_id) VALUES($1,$2,'T2 actor',$3,'active',$4) RETURNING id,user_id",[`ops-user-${suffix}`,role.id,`ops-${suffix}@invalid`,branch.id])).rows[0];
    const target=(await admin.query("INSERT INTO tenant_user_profiles(user_id,role_id,display_name,email,status,active_branch_id) VALUES($1,$2,'T2 target',$3,'active',$4) RETURNING id,user_id",[`ops-target-${suffix}`,role.id,`ops-target-${suffix}@invalid`,branch.id])).rows[0];
    const register=(await admin.query("INSERT INTO pos_registers(branch_id,code,name,status) VALUES($1,$2,'T2 register','active') RETURNING id",[branch.id,`REG-${suffix}`])).rows[0];
    const oneShotRegister=(await admin.query("INSERT INTO pos_registers(branch_id,code,name,status) VALUES($1,$2,'T2 isolated','active') RETURNING id",[branch.id,`REG-ONE-${suffix}`])).rows[0];
    await admin.query("INSERT INTO branch_user_accesses(branch_id,user_profile_id,can_sell) VALUES($1,$2,true),($1,$3,true)",[branch.id,profile.id,target.id]);
    await admin.query("INSERT INTO pos_register_accesses(register_id,user_profile_id,active,can_sell) VALUES($1,$2,true,true),($3,$4,true,true)",[register.id,profile.id,oneShotRegister.id,target.id]);
    const session=(await admin.query("INSERT INTO cash_register_sessions(number,register_name,status,opening_amount,opened_by,operator_profile_id,register_id,version) VALUES($1,'T2 register','open',0,$2,$3,$4,1) RETURNING id",[`OPS-${suffix}`,profile.user_id,profile.id,register.id])).rows[0];
    const oneShotSession=(await admin.query("INSERT INTO cash_register_sessions(number,register_name,status,opening_amount,opened_by,operator_profile_id,register_id,version) VALUES($1,'T2 register isolated','open',0,$2,$3,$4,1) RETURNING id",[`OPS-ONE-${suffix}`,profile.user_id,target.id,oneShotRegister.id])).rows[0];
    await admin.query("INSERT INTO pos_terminals(id,register_id,code,name,status,token_hash,token_issued_at,token_expires_at,credential_version,paired_at,last_seen_at,app_version) VALUES('terminal',$1,$2,'T2 terminal','online','hmac-sha256:v1:'||repeat('a',64),clock_timestamp(),clock_timestamp()+interval '1 hour',1,clock_timestamp(),clock_timestamp(),'1')",[register.id,`TERM-${suffix}`]);
    await admin.query("INSERT INTO pos_held_sales(id,register_id,session_id,operator_profile_id,status,revision,idempotency_key,request_hash) VALUES('draft',$1,$2,$3,'draft',1,$4,$5)",[register.id,session.id,profile.id,`draft-${suffix}`.padEnd(16,"x"),hash("draft")]);
    await admin.query(`INSERT INTO pos_session_handoffs(id,session_id,branch_id,register_id,from_operator_profile_id,to_operator_profile_id,state,reason,expires_at,revision,request_idempotency_key,request_hash,held_sale_snapshot,requested_by_actor_id,created_at,updated_at)
      VALUES($1,$2,$3,$4,$5,$6,'requested','T2',clock_timestamp()-interval '1 minute',1,$7,$8,'{}',$9,clock_timestamp()-interval '2 minutes',clock_timestamp()-interval '2 minutes')`,[handoffId,session.id,branch.id,register.id,profile.id,target.id,`handoff-${suffix}`,hash("handoff-fixture"),profile.user_id]);
    await admin.query(`INSERT INTO pos_payment_plans(id,branch_id,register_id,session_id,operator_profile_id,terminal_id,sale_draft_id,draft_revision,draft_request_hash,draft_status,quote_hash,evaluated_at,expires_at,total_cents,state,version,idempotency_key,request_hash)
      VALUES($1,$2,$3,$4,$5,'terminal','draft',1,$6,'held',$7,clock_timestamp(),clock_timestamp()+interval '1 minute',100,'quoted',0,$8,$9)`,[planId,branch.id,register.id,session.id,profile.id,hash("draft"),hash("quote"),`plan-fixture-${suffix}`,hash("plan-fixture")]);
    return {branchId:branch.id,registerId:register.id,sessionId:session.id,oneShotSessionId:oneShotSession.id,oneShotActorProfileId:target.id,oneShotActorUserId:target.user_id,actorProfileId:profile.id,actorUserId:profile.user_id,handoffId,planId};
  } finally { await admin.query("SET session_replication_role=origin"); }
}

async function caseFirstRejects(admin:Client,monitor:Client,runtime:Client,fixture:Fixture,scenario:Scenario){
  await admin.query("BEGIN"); await admin.query("SELECT 1 FROM cash_register_sessions WHERE id=$1 FOR UPDATE",[fixture.sessionId]);
  await insertCase(admin,fixture);
  const pending=scenario.prepare(runtime).then(()=>({ok:true})).catch((error:DatabaseError)=>({ok:false,code:error.code}));
  const waitEvent=await blockedWaitEvent(monitor,runtime); await admin.query("COMMIT");
  assert.equal(waitEvent,"Lock",scenario.name);
  assert.deepEqual(await pending,{ok:false,code:"23514"},scenario.name);
}

async function transitionFirstSerializes(admin:Client,monitor:Client,runtime:Client,fixture:Fixture,scenario:Scenario){
  await runtime.query("BEGIN"); await scenario.prepare(runtime);
  await admin.query("BEGIN");
  const pending=admin.query("SELECT 1 FROM cash_register_sessions WHERE id=$1 FOR UPDATE",[fixture.sessionId]);
  const waitEvent=await blockedWaitEvent(monitor,admin); await runtime.query("ROLLBACK"); await pending;
  assert.equal(waitEvent,"Lock",scenario.name);
  await insertCase(admin,fixture); await admin.query("COMMIT");
}

async function insertCase(admin:Client,f:Fixture){
  await admin.query("SET LOCAL session_replication_role=replica");
  await admin.query(`INSERT INTO pos_manual_payment_cases(id,branch_id,register_id,session_id,operator_profile_id,terminal_id,sale_draft_id,draft_revision,draft_request_hash,quote_hash,payment_plan_id,payment_index,method,amount_cents,currency,installments,provider,connector_id,connector_revision,credential_ref,credential_revision,reference_hash,reference_key_id,reference_last_four,occurred_at,reason_code,maker_profile_id,maker_user_id,state,version,lifecycle_txid,idempotency_key,request_hash,expires_at)
    VALUES($1,$2,$3,$4,$5,'terminal','draft',1,$6,$7,$8,0,'manual',100,'BRL',1,'fixture','connector',1,'credential',1,$9,'key','1234',clock_timestamp(),'fixture',$5,$10,'review_pending',0,txid_current(),$11,$12,clock_timestamp()+interval '1 hour')`,[randomUUID(),f.branchId,f.registerId,f.sessionId,f.actorProfileId,hash("draft"),hash("quote"),f.planId,`hmac-sha256:v1:${hash(randomUUID())}`,f.actorUserId,hash(randomUUID()),hash(randomUUID())]);
}
async function preparePlanSupersede(client:Client,fixture:Fixture,idempotencyKey:string){
  const target={id:fixture.planId,state:"superseded",version:1,consumedSaleId:null};
  const requestHash=(await client.query<{hash:string}>("SELECT pos_manual_t2_payment_plan_graph_request_hash_v1('supersede',$1,0,$2,$3,$4::jsonb,'[]'::jsonb,'[]'::jsonb) hash",[fixture.planId,fixture.actorUserId,idempotencyKey,JSON.stringify(target)])).rows[0]!.hash;
  await client.query("SELECT pos_manual_prepare_payment_plan_graph_write_v1('supersede',$1,0,$2,$3,$4,$5::jsonb,'[]'::jsonb,'[]'::jsonb)",[fixture.planId,fixture.actorUserId,idempotencyKey,requestHash,JSON.stringify(target)]);
  return requestHash;
}
async function removeCases(admin:Client){await admin.query("SET session_replication_role=replica");try{await admin.query("DELETE FROM pos_manual_payment_cases");}finally{await admin.query("SET session_replication_role=origin");}}
async function blockedWaitEvent(observer:Client,blocked:Client){
  for(let attempt=0;attempt<40;attempt+=1){
    await new Promise((resolve)=>setTimeout(resolve,50));
    const row=(await observer.query("SELECT wait_event_type FROM pg_stat_activity WHERE pid=$1",[(blocked as Client & { processID: number }).processID])).rows[0];
    if(row?.wait_event_type) return row.wait_event_type as string;
  }
  return undefined;
}
async function assertDenied(client:Client,sql:string,params:unknown[]){await assert.rejects(client.query(sql,params),(error:DatabaseError)=>{assert.ok(["42501","23514"].includes(error.code ?? ""),error.message);return true;});}
function hash(value:string){return createHash("sha256").update(value).digest("hex");}
function authorityHash(database:string,role:string){return createHash("sha256").update("t2-authority-v1\0").update(database).update("\0").update(role).digest("hex");}
async function connect(url:string){const client=new Client({connectionString:url});await client.connect();return client;}
function databaseUrl(base:string,database:string){const url=new URL(base);url.pathname=`/${database}`;return url.toString();}
function roleUrl(base:string,database:string,role:string,password:string){const url=new URL(base);url.pathname=`/${database}`;url.username=role;url.password=password;return url.toString();}
