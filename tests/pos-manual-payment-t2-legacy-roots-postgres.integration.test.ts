import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { promisify } from "node:util";
import test from "node:test";
import { PrismaPg } from "@prisma/adapter-pg";
import { Client, type DatabaseError } from "pg";
import { PrismaClient } from "../generated/tenant/client";

const adminConnectionString = process.env.TENANT_ROLE_TEST_ADMIN_DATABASE_URL;
const execFileAsync = promisify(execFile);

test("T2-01 PG18: producers sem mutação do trio continuam operáveis e DML direto é negado", {
  skip: !adminConnectionString,
  timeout: 300_000,
}, async () => {
  const token = randomBytes(5).toString("hex");
  const database = `t2_legacy_roots_${token}`;
  const migrator = `${database}_migrator`;
  const roles = {
    runtime: `${database}_runtime`, callback: `${database}_mc`, worker: `${database}_mw`, binder: `${database}_mb`,
  };
  const passwords = Object.fromEntries([migrator, ...Object.values(roles)].map((role) => [role, randomBytes(24).toString("hex")])) as Record<string, string>;
  const admin = new Client({ connectionString: adminConnectionString });
  await admin.connect();
  try {
    for (const role of [migrator, ...Object.values(roles)])
      await admin.query(`CREATE ROLE "${role}" LOGIN NOINHERIT PASSWORD '${passwords[role]}'`);
    await admin.query(`CREATE DATABASE "${database}" OWNER "${migrator}"`);
    const migratorUrl = roleUrl(adminConnectionString!, database, migrator, passwords[migrator]);
    await execFileAsync("npx", ["prisma", "migrate", "deploy", "--config", "prisma.tenant.config.ts"], {
      timeout: 180_000, env: { ...process.env, TENANT_DATABASE_URL: migratorUrl },
    });
    const owner = await connect(migratorUrl);
    const callback = await connect(roleUrl(adminConnectionString!, database, roles.callback, passwords[roles.callback]));
    const worker = await connect(roleUrl(adminConnectionString!, database, roles.worker, passwords[roles.worker]));
    const binder = await connect(roleUrl(adminConnectionString!, database, roles.binder, passwords[roles.binder]));
    let runtime: Client | undefined;
    try {
      for (const role of Object.values(roles)) await owner.query(`GRANT CONNECT ON DATABASE "${database}" TO "${role}"; GRANT USAGE ON SCHEMA public TO "${role}"`);
      await owner.query(`GRANT EXECUTE ON FUNCTION public.pos_manual_record_callback_v1(text,text,text,text,text,text,text,text,timestamptz,text,text,text,integer,text,bigint,timestamptz,integer,text) TO "${roles.callback}"`);
      await owner.query(`GRANT EXECUTE ON FUNCTION public.pos_manual_attest_query_response_v1(uuid,integer,text,text,text,text,text,text,text,text,text,timestamptz,text,text,text,integer,text,bigint,timestamptz,integer,text) TO "${roles.callback}"`);
      await owner.query(`GRANT EXECUTE ON FUNCTION public.pos_manual_complete_delivery_v1(uuid,text,uuid,text), public.pos_manual_report_transport_v1(uuid,text,text,text) TO "${roles.worker}"`);
      await owner.query(`GRANT EXECUTE ON FUNCTION public.pos_manual_claim_queries_v1(text,integer,integer,text) TO "${roles.worker}"`);
      await owner.query(`GRANT EXECUTE ON FUNCTION public.pos_manual_prepare_open_v1(text,integer,integer,text,timestamptz,text,text,text), public.pos_manual_review_case_v1(uuid,integer,integer,text,text,text,text,text,text) TO "${roles.runtime}"`);
      await owner.query(`GRANT EXECUTE ON FUNCTION public.pos_manual_claim_open_for_vault_v1(uuid,text,text,text,integer), public.pos_manual_open_case_v1(uuid,text,bigint,text,text,text,text,text,text,text,text,text,text,timestamptz,timestamptz,text) TO "${roles.binder}"`);
      for (const [capability, role] of [["runtime", roles.runtime], ["manual_callback", roles.callback], ["manual_worker", roles.worker], ["manual_vault_binder", roles.binder]])
        await owner.query("INSERT INTO pos_manual_t2_authorities(capability,role_name,authority_hash) VALUES ($1,$2,$3)", [capability, role, authorityHash(database, role)]);
      runtime = await connect(roleUrl(adminConnectionString!, database, roles.runtime, passwords[roles.runtime]));

      const hash = (value: string) => createHash("sha256").update(value).digest("hex");
      const now = new Date();
      const orphan = (await callback.query(`SELECT public.pos_manual_record_callback_v1(
        $1,$2,$3,$4,$5,$6,$7,$8,$9::timestamptz,$10,$11,$12,$13,$14,$15::bigint,$16::timestamptz,$17,$18) result`, [
        "manual_provider", `evt:${hash(`event:${token}`)}`, hash(`nonce:${token}`), hash(`payload:${token}`),
        hash(`signature:${token}`), hash(`canonical:${token}`), hash(`evidence:${token}`), "manual-auth-v1", now,
        "unknown", `hmac-sha256:v1:${hash(`reference:${token}`)}`, "credit", 100, "BRL", "1", now, 0, "t2-test-v1",
      ])).rows[0]!.result;
      assert.equal(orphan.disposition, "orphan_reference");
      assert.equal(orphan.quarantined, true);

      const claim = (await worker.query("SELECT public.pos_manual_claim_queries_v1($1,1,30,$2) result", [
        `worker-${token}`, `claim-${token}`,
      ])).rows[0]!.result;
      assert.equal(claim.claimedCount, 0);
      assert.equal(claim.blockedCount, 0);

      // Harness efêmero: prova que três roots tipadas, derivadas de ROWTYPE,
      // aceitam exatamente um operation/event/case e fecham no COMMIT.
      const caseId = randomUUID();
      const adminTargetUrl = new URL(adminConnectionString!); adminTargetUrl.pathname = `/${database}`;
      const adminTarget = await connect(adminTargetUrl.toString());
      try {
        await adminTarget.query("SET session_replication_role=replica");
        await adminTarget.query(`INSERT INTO public.pos_manual_payment_cases(
          id,branch_id,register_id,session_id,operator_profile_id,terminal_id,sale_draft_id,draft_revision,draft_request_hash,
          quote_hash,payment_plan_id,payment_index,method,amount_cents,currency,installments,provider,connector_id,
          connector_revision,credential_ref,credential_revision,reference_hash,reference_key_id,reference_last_four,
          occurred_at,reason_code,maker_profile_id,maker_user_id,state,version,lifecycle_txid,idempotency_key,request_hash,expires_at)
          VALUES($1,1,1,1,1,'terminal-test','draft-test',1,$2,$3,'plan-test',0,'credit',100,'BRL',1,
            'manual_provider','connector-test',0,'credential-test',0,$4,'reference-key-v1','A123',clock_timestamp(),
            'test_reason',1,'maker-test','review_pending',0,txid_current()::numeric,$5,$6,clock_timestamp()+interval '5 minutes')`,
          [caseId, hash(`draft:${token}`), hash(`quote:${token}`), `hmac-sha256:v1:${hash(`reference-row:${token}`)}`, `fixture-${token}`, hash(`request:${token}`)]);
      } finally {
        await adminTarget.query("SET session_replication_role=origin").catch(() => undefined);
        await adminTarget.end();
      }
      await owner.query(`CREATE FUNCTION public.t2_test_legacy_root_bundle(p_case_id uuid) RETURNS void
        LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $body$
        DECLARE old_case public.pos_manual_payment_cases%ROWTYPE; target_case public.pos_manual_payment_cases%ROWTYPE;
          operation_row public.pos_manual_payment_operations%ROWTYPE; event_row public.pos_manual_payment_state_events%ROWTYPE;
          now_at timestamptz:=pg_catalog.clock_timestamp(); tx numeric:=pg_catalog.txid_current()::numeric;
        BEGIN
          SELECT * INTO old_case FROM public.pos_manual_payment_cases WHERE id=p_case_id FOR UPDATE;
          operation_row:=pg_catalog.jsonb_populate_record(NULL::public.pos_manual_payment_operations,pg_catalog.jsonb_build_object(
            'id',pg_catalog.nextval(pg_catalog.pg_get_serial_sequence('public.pos_manual_payment_operations','id')::pg_catalog.regclass),
            'case_id',p_case_id,'action','reject','expected_version',0,'resulting_version',1,'resulting_state','rejected',
            'idempotency_key','t2-test-reject:'||p_case_id::text,'request_hash',old_case.request_hash,'write_txid',tx,'created_at',now_at));
          PERFORM public.pos_manual_t2_open_legacy_operation_root_v1('legacy_manual:review:operation','reject',operation_row);
          INSERT INTO public.pos_manual_payment_operations SELECT (operation_row).* RETURNING * INTO operation_row;
          event_row:=pg_catalog.jsonb_populate_record(NULL::public.pos_manual_payment_state_events,pg_catalog.jsonb_build_object(
            'id',pg_catalog.nextval(pg_catalog.pg_get_serial_sequence('public.pos_manual_payment_state_events','id')::pg_catalog.regclass),
            'case_id',p_case_id,'operation_id',operation_row.id,'from_state','review_pending','to_state','rejected',
            'resulting_version',1,'source','api','source_id','t2-test','write_txid',tx,'created_at',now_at));
          PERFORM public.pos_manual_t2_open_legacy_state_event_root_v1('legacy_manual:review:state_event','reject',event_row);
          INSERT INTO public.pos_manual_payment_state_events SELECT (event_row).*;
          target_case:=old_case; target_case.state:='rejected'; target_case.version:=1; target_case.reviewed_at:=now_at;
          target_case.rejected_at:=now_at; target_case.lifecycle_txid:=tx; target_case.updated_at:=now_at;
          PERFORM public.pos_manual_t2_open_legacy_case_root_v1('legacy_manual:review:case','reject','UPDATE',old_case,target_case);
          UPDATE public.pos_manual_payment_cases SET state=target_case.state,version=target_case.version,
            reviewed_at=target_case.reviewed_at,rejected_at=target_case.rejected_at,lifecycle_txid=target_case.lifecycle_txid,
            updated_at=target_case.updated_at WHERE id=p_case_id;
        END $body$`);
      await owner.query(`REVOKE ALL ON FUNCTION public.t2_test_legacy_root_bundle(uuid) FROM PUBLIC; GRANT EXECUTE ON FUNCTION public.t2_test_legacy_root_bundle(uuid) TO "${roles.runtime}"`);
      await runtime.query("SELECT public.t2_test_legacy_root_bundle($1)", [caseId]);
      const rooted = await owner.query(`SELECT c.state,c.version,
        (SELECT count(*)::int FROM pos_manual_t2_write_roots r WHERE r.aggregate_id=c.id::text) roots,
        (SELECT count(*)::int FROM pos_manual_t2_write_observations o WHERE o.aggregate_id=c.id::text) observations,
        (SELECT count(*)::int FROM pos_manual_payment_operations op WHERE op.case_id=c.id) operations,
        (SELECT count(*)::int FROM pos_manual_payment_state_events ev WHERE ev.case_id=c.id) events
        FROM pos_manual_payment_cases c WHERE c.id=$1`, [caseId]);
      assert.deepEqual(rooted.rows[0], { state: "rejected", version: 1, roots: 0, observations: 0, operations: 1, events: 1 });

      await exerciseRealLegacyProducers({
        databaseUrl: adminTargetUrl.toString(),
        owner,
        runtime,
        callback,
        worker,
        binder,
        token,
      });

      await assertSqlState(owner, `INSERT INTO public.pos_manual_payment_cases(id) VALUES ($1::uuid)`, "42501", [randomUUID()]);
      await assertSqlState(owner, `INSERT INTO public.pos_manual_payment_operations(case_id,action,expected_version,resulting_version,resulting_state,idempotency_key,request_hash,write_txid)
        VALUES ($1::uuid,'block',0,1,'blocked',$2,$3,txid_current()::numeric)`, "42501", [randomUUID(), `direct-${token}`, hash(`direct-op:${token}`)]);
      await assertSqlState(owner, `INSERT INTO public.pos_manual_payment_state_events(case_id,from_state,to_state,resulting_version,source,source_id,write_txid)
        VALUES ($1::uuid,'unknown','blocked',1,'worker',$2,txid_current()::numeric)`, "42501", [randomUUID(), `direct-${token}`]);

      const guards = await owner.query<{ name: string; definition: string }>(`
        SELECT p.proname name,pg_get_functiondef(p.oid) definition FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
        WHERE n.nspname='public' AND p.proname IN ('protect_pos_manual_case','guard_pos_manual_operation','guard_pos_manual_state_event')`);
      assert.equal(guards.rowCount, 3);
      for (const guard of guards.rows) {
        assert.match(guard.definition, /pos_manual_t2_observe_legacy_write_v1/);
        assert.doesNotMatch(guard.definition, /pos_manual_payment_(?:cases|operations|state_events)|FOR UPDATE|FOR SHARE|pg_advisory/i);
      }
      const implementations = await owner.query<{ name: string; security_definer: boolean; config: string[] | null; public_execute: boolean }>(`
        SELECT p.proname name,p.prosecdef security_definer,p.proconfig config,
          has_function_privilege('public',p.oid,'EXECUTE') public_execute
        FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
        WHERE n.nspname='public' AND p.proname LIKE 'pos_manual_%_v1_t2_01_impl' ORDER BY p.proname`);
      assert.equal(implementations.rowCount, 7);
      for (const implementation of implementations.rows) {
        assert.equal(implementation.security_definer, true, implementation.name);
        assert.deepEqual(implementation.config, ["search_path=pg_catalog, public"], implementation.name);
        assert.equal(implementation.public_execute, false, implementation.name);
      }
    } finally {
      await Promise.all([runtime?.end(), binder.end(), worker.end(), callback.end(), owner.end()]);
    }
  } finally {
    await admin.query("SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname=$1", [database]).catch(() => undefined);
    await admin.query(`DROP DATABASE IF EXISTS "${database}"`).catch(() => undefined);
    for (const role of Object.values(roles).reverse()) await admin.query(`DROP ROLE IF EXISTS "${role}"`).catch(() => undefined);
    await admin.query(`DROP ROLE IF EXISTS "${migrator}"`).catch(() => undefined);
    await admin.end();
  }
});

function authorityHash(database: string, role: string) {
  return createHash("sha256").update("t2-authority-v1\0").update(database).update("\0").update(role).digest("hex");
}

function roleUrl(base: string, database: string, role: string, password: string) {
  const url = new URL(base); url.pathname = `/${database}`; url.username = role; url.password = password; return url.toString();
}

async function connect(connectionString: string) { const client = new Client({ connectionString }); await client.connect(); return client; }

async function assertSqlState(client: Client, sql: string, code: string, parameters: unknown[] = []) {
  await assert.rejects(client.query(sql, parameters), (error: DatabaseError) => {
    assert.equal(error.code, code, error.message); return true;
  });
}

type LegacyClients = {
  databaseUrl: string;
  owner: Client;
  runtime: Client;
  callback: Client;
  worker: Client;
  binder: Client;
  token: string;
};

type LegacyFixtureContext = Awaited<ReturnType<typeof seedLegacyContext>>;
type LegacyCase = Awaited<ReturnType<typeof openRealCase>>;

async function exerciseRealLegacyProducers(clients: LegacyClients) {
  const db = new PrismaClient({ adapter: new PrismaPg({ connectionString: clients.databaseUrl }) });
  try {
    // T2-01 intentionally keeps every gate hard-off. This ephemeral database
    // needs one historically enabled gate solely to drive the already-frozen
    // legacy producers; it is never a production migration or runtime escape.
    await db.$executeRawUnsafe(`ALTER TABLE public."pos_manual_payment_reconciliation_gates" DROP CONSTRAINT "pos_manual_gate_fin_profile_shape_check"`);
    const primary = await seedLegacyContext(db, `${clients.token}a`);
    const callbackCase = await openAndReviewRealCase(db, clients, primary, "callback", 1_101);
    await assertLegacyGraph(clients.owner, callbackCase.id, 2);
    const callbackResult = await recordAcceptedCallback(clients.callback, callbackCase, `callback-${clients.token}`);
    assert.equal(callbackResult.disposition, "accepted");
    assert.equal((await db.posManualPaymentCase.findUniqueOrThrow({ where: { id: callbackCase.id } })).state, "confirmed_paid");
    await assertLegacyGraph(clients.owner, callbackCase.id, 3);

    const deliveryCase = await openAndReviewRealCase(db, clients, primary, "delivery", 1_102);
    const deliveryClaim = await claimOne(clients.worker, deliveryCase.id, `delivery-claim-${clients.token}`);
    const deliveryProof = await attestClaim(clients.callback, deliveryCase, deliveryClaim, `delivery-${clients.token}`);
    const delivered = await clients.worker.query<{ result: { resultingState: string } }>(
      `SELECT public.pos_manual_complete_delivery_v1($1::uuid,$2,$3::uuid,$4) result`,
      [deliveryClaim.attemptId, deliveryClaim.claimToken, deliveryProof, `delivery-complete-${clients.token}`],
    );
    assert.equal(delivered.rows[0]!.result.resultingState, "confirmed_paid");
    await assertLegacyGraph(clients.owner, deliveryCase.id, 3);

    const evidenceCase = await openAndReviewRealCase(db, clients, primary, "report-evidence", 1_103);
    const evidenceClaim = await claimOne(clients.worker, evidenceCase.id, `evidence-claim-${clients.token}`);
    const evidenceReport = await reportTransport(clients.worker, evidenceClaim, "outcome_unknown", `evidence-${clients.token}`);
    assert.equal(evidenceReport.processingResult, "retry_scheduled");
    const evidenceStored = await db.posManualPaymentCase.findUniqueOrThrow({ where: { id: evidenceCase.id } });
    assert.equal(evidenceStored.state, "unknown");
    assert.ok(evidenceStored.nextReconcileAt);
    await assertLegacyGraph(clients.owner, evidenceCase.id, 2);

    const terminalCase = await openAndReviewRealCase(db, clients, primary, "report-terminal", 1_104);
    const terminalClaim = await claimOne(clients.worker, terminalCase.id, `terminal-claim-${clients.token}`);
    const terminalReport = await reportTransport(clients.worker, terminalClaim, "protocol_rejected", `terminal-${clients.token}`);
    assert.equal(terminalReport.processingResult, "terminal_blocked");
    assert.equal((await db.posManualPaymentCase.findUniqueOrThrow({ where: { id: terminalCase.id } })).state, "blocked");
    await assertLegacyGraph(clients.owner, terminalCase.id, 3);

    const blockedAContext = await seedLegacyContext(db, `${clients.token}b`);
    const blockedBContext = await seedLegacyContext(db, `${clients.token}c`);
    const blockedA = await openAndReviewRealCase(db, clients, blockedAContext, "batch-a", 1_105);
    const blockedB = await openAndReviewRealCase(db, clients, blockedBContext, "batch-b", 1_106);
    await db.posRegisterAccess.updateMany({
      where: { OR: [
        { registerId: blockedAContext.register.id, userProfileId: blockedAContext.maker.id },
        { registerId: blockedBContext.register.id, userProfileId: blockedBContext.maker.id },
      ] },
      data: { canManualPayment: false },
    });
    const blockedBatch = await clients.worker.query<{ result: { blockedCount: number; claimedCount: number } }>(
      `SELECT public.pos_manual_claim_queries_v1($1,10,30,$2) result`,
      [`batch-worker-${clients.token}`, `batch-block-${clients.token}`],
    );
    assert.equal(blockedBatch.rows[0]!.result.blockedCount, 2);
    assert.equal(blockedBatch.rows[0]!.result.claimedCount, 0);
    for (const blocked of [blockedA, blockedB]) {
      assert.equal((await db.posManualPaymentCase.findUniqueOrThrow({ where: { id: blocked.id } })).state, "blocked");
      await assertLegacyGraph(clients.owner, blocked.id, 3);
    }
    await assertNoLegacyRoots(clients.owner);
  } finally {
    await db.$disconnect();
  }
}

async function seedLegacyContext(db: PrismaClient, label: string) {
  return db.$transaction(async tx => {
    await tx.$executeRawUnsafe("SET LOCAL session_replication_role=replica");
    const compact = label.replaceAll("-", "").slice(0, 28);
    const role = await tx.tenantRole.create({ data: { key: `owner-${compact}`, name: `Owner ${compact}`, permissions: {}, system: false } });
    const branch = await tx.branch.create({ data: { code: `B${compact}`, name: `Branch ${compact}`, legalName: `Branch ${compact} Ltda`, document: `DOC${compact}` } });
    const register = await tx.posRegister.create({ data: { branchId: branch.id, code: `R${compact}`, name: `Register ${compact}` } });
    const maker = await tx.tenantUserProfile.create({ data: { userId: `maker-${label}`, roleId: role.id, displayName: "Maker", email: `${compact}.maker@example.invalid`, activeBranchId: branch.id } });
    const checker = await tx.tenantUserProfile.create({ data: { userId: `checker-${label}`, roleId: role.id, displayName: "Checker", email: `${compact}.checker@example.invalid`, activeBranchId: branch.id } });
    await tx.branchUserAccess.createMany({ data: [
      { branchId: branch.id, userProfileId: maker.id, canSell: true },
      { branchId: branch.id, userProfileId: checker.id, canSell: true },
    ] });
    await tx.posRegisterAccess.createMany({ data: [
      { registerId: register.id, userProfileId: maker.id, active: true, canSell: true, canManualPayment: true },
      { registerId: register.id, userProfileId: checker.id, active: true, canSell: true, canReviewManualPayment: true, manualPaymentReviewLimitCents: 100_000 },
    ] });
    const now = new Date();
    const terminal = await tx.posTerminal.create({ data: { id: `terminal-${label}`, registerId: register.id, code: `T${compact}`, name: "Terminal", status: "online", tokenHash: `hmac-sha256:v1:${digest(label)}`, tokenIssuedAt: now, tokenExpiresAt: new Date(now.valueOf() + 3_600_000), credentialVersion: 1, pairedAt: now, lastSeenAt: now, appVersion: "test" } });
    const session = await tx.cashRegisterSession.create({ data: { number: `SESSION-${label}`, registerName: register.name, status: "open", openingAmount: 0, openingAmountCents: 0, openedBy: maker.displayName, registerId: register.id, operatorProfileId: maker.id } });
    const provider = `provider_${compact}`;
    await tx.integrationProvider.create({ data: { id: provider, family: "payment", label: "Provider", description: "fixture", recipientType: "none", authType: "api_key", capabilities: {}, credentialSchema: {} } });
    const credential = await tx.integrationCredential.create({ data: { id: `credential-${label}`, providerId: provider, label: "Credential", enabled: true, config: { manualReconciliation: { callbackAuthKeyIds: ["manual-auth-v1"] } } } });
    const connector = await tx.posConnector.create({ data: { id: `connector-${label}`, branchId: branch.id, registerId: register.id, type: `manual_${compact}`, provider, credentialRef: credential.id, status: "active", settings: { capabilities: ["manual_reference_query"], manualReconciliation: { enabled: true, vaultBindingRequired: true } } } });
    const product = await tx.product.create({ data: { name: `Product ${compact}`, slug: `product-${compact}`, sku: `SKU-${compact}`, category: "Teste", price: 10, regularPrice: 10, manageStock: false } });
    await tx.posManualPaymentReconciliationGate.create({ data: { connectorId: connector.id, connectorRevision: connector.revision, credentialRef: credential.id, credentialRevision: credential.revision, enabled: true, vaultAdapterId: "vault-test", providerAdapterVersion: "adapter-v1", enabledBy: "fixture", enabledAt: now, configHash: "c".repeat(64) } });
    return { branch, register, maker, checker, terminal, session, provider, credential, connector, product };
  });
}

async function seedActivePlan(db: PrismaClient, context: LegacyFixtureContext, label: string, amountCents: number) {
  return db.$transaction(async tx => {
    await tx.$executeRawUnsafe("SET LOCAL session_replication_role=replica");
    const requestHash = digest(`plan:${label}`), now = new Date(), expiresAt = new Date(now.valueOf() + 300_000);
    const draft = await tx.posHeldSale.create({ data: { id: `draft-${label}`, registerId: context.register.id, sessionId: context.session.id, operatorProfileId: context.maker.id, status: "draft", idempotencyKey: `draft-${label}`, requestHash, items: { create: { productId: context.product.id, quantity: 1, unitPriceCents: amountCents, discountCents: 0 } } }, include: { items: true } });
    const planId = `plan-${label}`;
    await tx.posPaymentPlan.create({ data: { id: planId, branchId: context.branch.id, registerId: context.register.id, sessionId: context.session.id, operatorProfileId: context.maker.id, terminalId: context.terminal.id, saleDraftId: draft.id, draftRevision: 0, draftRequestHash: requestHash, draftStatus: "draft", quoteHash: requestHash, evaluatedAt: now, expiresAt, totalCents: amountCents, state: "active", version: 1, activatedAt: now, idempotencyKey: `quote-${label}`, requestHash } });
    await tx.posPaymentPlanQuoteLine.create({ data: { planId, lineIndex: 0, heldSaleItemId: draft.items[0]!.id, productId: context.product.id, quantity: 1, unitPriceCents: amountCents, grossCents: amountCents, baseDiscountCents: 0, orderDiscountCents: 0, promotionDiscountCents: 0, surchargeCents: 0, totalCents: amountCents } });
    await tx.posPaymentPlanSlot.create({ data: { planId, paymentIndex: 0, method: "credit", amountCents, installments: 1, proofKind: "manual", connectorId: context.connector.id, credentialRef: context.credential.id, provider: context.provider } });
    await tx.posPaymentPlanOperation.createMany({ data: [
      { planId, action: "quote", expectedVersion: -1, resultingVersion: 0, resultingState: "quoted", idempotencyKey: `quote-${label}`, requestHash },
      { planId, action: "activate", expectedVersion: 0, resultingVersion: 1, resultingState: "active", idempotencyKey: `activate-${label}`, requestHash },
    ] });
    return { planId, expiresAt };
  });
}

async function openRealCase(db: PrismaClient, clients: LegacyClients, context: LegacyFixtureContext, label: string, amountCents: number) {
  const unique = `${clients.token}-${label}`;
  const plan = await seedActivePlan(db, context, unique, amountCents);
  const rawReference = `reference-${unique}-A123`, occurredAt = new Date();
  const stable = `vault-blind:v1:${digest(`blind:${rawReference}`)}`;
  const intentHash = digestCanonical({ paymentPlanId: plan.planId, paymentIndex: 0, makerProfileId: context.maker.id, makerUserId: context.maker.userId, occurredAt, reasonCode: "manual.external_terminal", stableReferenceIndex: stable });
  const prepared = (await clients.runtime.query<{ result: { requestId: string; ticket: string } }>(
    `SELECT public.pos_manual_prepare_open_v1($1,0,$2,$3,$4::timestamptz,'manual.external_terminal',$5,$6) result`,
    [plan.planId, context.maker.id, context.maker.userId, occurredAt, digest(`prepare:${unique}`), intentHash],
  )).rows[0]!.result;
  const claimed = (await clients.binder.query<{ result: { claimToken: string; fencingToken: string; vaultIdempotencyKey: string } }>(
    `SELECT public.pos_manual_claim_open_for_vault_v1($1::uuid,$2,$3,$4,30) result`,
    [prepared.requestId, prepared.ticket, `binder-${unique}`, digest(`claim:${unique}`)],
  )).rows[0]!.result;
  await db.posManualVaultVerifier.upsert({ where: { verifierVersion: "t2-real-verifier-v1" }, create: { verifierVersion: "t2-real-verifier-v1", enabled: true, maxFutureSkewSeconds: 30 }, update: { enabled: true } });
  const issuedAt = new Date(), retentionExpiresAt = new Date(plan.expiresAt.valueOf() + 30_000);
  const externalProof = `proof-${digest(unique).slice(0, 48)}`, reference = `hmac-sha256:v1:${digest(`reference:${rawReference}`)}`;
  const binding = digest(`binding:${unique}`), signature = digest(`signature:${unique}`);
  const proof = (await clients.owner.query<{ hash: string }>(`SELECT encode(sha256(convert_to('pos-manual-vault-proof-v1'||jsonb_build_array($1::uuid,$2::bigint,$3::text,'vault-test'::text,$4::text,$5::text,$6::text,$7::text,'reference-key-v1'::text,'A123'::text,'vault-key-v1'::text,$8::text,$9::text,extract(epoch FROM $10::timestamptz),extract(epoch FROM $11::timestamptz),'t2-real-verifier-v1'::text)::text,'UTF8')),'hex') hash`,
    [prepared.requestId, claimed.fencingToken, claimed.vaultIdempotencyKey, context.provider, externalProof, stable, reference, binding, signature, issuedAt, retentionExpiresAt])).rows[0]!.hash;
  const opened = (await clients.binder.query<{ result: { caseId: string } }>(`SELECT public.pos_manual_open_case_v1($1::uuid,$2,$3::bigint,$4,$5,$6,$7,'reference-key-v1','A123','vault-key-v1',$8,$9,$10,$11::timestamptz,$12::timestamptz,'t2-real-verifier-v1') result`,
    [prepared.requestId, claimed.claimToken, claimed.fencingToken, digest(`finalize:${unique}`), externalProof, stable, reference, binding, proof, signature, issuedAt, retentionExpiresAt])).rows[0]!.result;
  await assertLegacyGraph(clients.owner, opened.caseId, 1);
  const stored = await db.posManualPaymentCase.findUniqueOrThrow({ where: { id: opened.caseId } });
  return { ...stored, referenceHash: reference };
}

async function openAndReviewRealCase(db: PrismaClient, clients: LegacyClients, context: LegacyFixtureContext, label: string, amountCents: number) {
  const manualCase = await openRealCase(db, clients, context, label, amountCents);
  const assertionHash = digest(`assertion:${clients.token}:${label}`), reasonCode = "manual.query_authorized";
  const requestHash = digestCanonical({ caseId: manualCase.id, checkerProfileId: context.checker.id, checkerUserId: context.checker.userId, assertionHash, decision: "authorize_query", reasonCode });
  await db.posManualPaymentStepUpAssertion.create({ data: { caseId: manualCase.id, expectedCaseVersion: 0, checkerProfileId: context.checker.id, checkerUserId: context.checker.userId, purpose: "manual_payment.review", decision: "authorize_query", reasonCode, requestHash, assertionHash, idempotencyKey: `assert-${clients.token}-${label}`, verifiedAt: new Date(), expiresAt: new Date(Date.now() + 300_000) } });
  const result = (await clients.runtime.query<{ result: { resultingState: string } }>(`SELECT public.pos_manual_review_case_v1($1::uuid,0,$2,$3,$4,'authorize_query',$5,$6,$7) result`,
    [manualCase.id, context.checker.id, context.checker.userId, assertionHash, reasonCode, `review-${clients.token}-${label}`, requestHash])).rows[0]!.result;
  assert.equal(result.resultingState, "unknown");
  await assertLegacyGraph(clients.owner, manualCase.id, 2);
  return { ...manualCase, state: "unknown", version: 1 };
}

type ClaimedCommand = {
  attemptId: string;
  caseId: string;
  claimToken: string;
  deliveryNumber: number;
  providerIdempotencyKey: string;
};

async function claimOne(worker: Client, caseId: string, key: string) {
  const batch = (await worker.query<{ result: { claimed: ClaimedCommand[] } }>(
    `SELECT public.pos_manual_claim_queries_v1($1,10,30,$2) result`,
    [`worker-${key}`, key],
  )).rows[0]!.result;
  const command = batch.claimed.find(item => item.caseId === caseId);
  assert.ok(command, `case ${caseId} must be claimed`);
  return command;
}

async function recordAcceptedCallback(callback: Client, manualCase: LegacyCase, label: string) {
  const now = new Date();
  return (await callback.query<{ result: { disposition: string } }>(`
    SELECT public.pos_manual_record_callback_v1(
      $1,$2,$3,$4,$5,$6,$7,'manual-auth-v1',$8::timestamptz,'confirmed_paid',$9,$10,$11,$12,$13::bigint,$14::timestamptz,$15,'t2-real-callback-v1'
    ) result`, [
    manualCase.provider, `evt:${digest(label)}`, digest(`nonce:${label}`), digest(`payload:${label}`),
    digest(`signature:${label}`), digest(`canonical:${label}`), digest(`evidence:${label}`), now,
    manualCase.referenceHash, manualCase.method, manualCase.amountCents, manualCase.currency, "1", now,
    manualCase.credentialRevision,
  ])).rows[0]!.result;
}

async function attestClaim(callback: Client, manualCase: LegacyCase, claim: ClaimedCommand, label: string) {
  const now = new Date();
  const result = await callback.query<{ result: { deliveryProofId?: string; proofId: string; quarantined: boolean } }>(`
    SELECT public.pos_manual_attest_query_response_v1(
      $1::uuid,$2,$3,$4,$5,$6,$7,$8,$9,$10,'manual-auth-v1',$11::timestamptz,
      'confirmed_paid',$12,$13,$14,$15,$16::bigint,$17::timestamptz,$18,'t2-real-query-v1'
    ) result`, [
    claim.attemptId, claim.deliveryNumber, claim.providerIdempotencyKey, manualCase.provider,
    `evt:${digest(label)}`, digest(`nonce:${label}`), digest(`payload:${label}`), digest(`signature:${label}`),
    digest(`canonical:${label}`), digest(`evidence:${label}`), now, manualCase.referenceHash,
    manualCase.method, manualCase.amountCents, manualCase.currency, "1", now, manualCase.credentialRevision,
  ]);
  assert.equal(result.rows[0]!.result.quarantined, false);
  return result.rows[0]!.result.deliveryProofId ?? result.rows[0]!.result.proofId;
}

async function reportTransport(worker: Client, claim: ClaimedCommand, kind: "outcome_unknown" | "protocol_rejected", key: string) {
  return (await worker.query<{ result: { processingResult: string } }>(
    `SELECT public.pos_manual_report_transport_v1($1::uuid,$2,$3,$4) result`,
    [claim.attemptId, claim.claimToken, kind, key],
  )).rows[0]!.result;
}

async function assertLegacyGraph(owner: Client, caseId: string, expectedVersions: number) {
  const graph = await owner.query<{
    versions: number;
    operations: number;
    events: number;
    txids_match: boolean;
  }>(`
    SELECT count(DISTINCT operation.resulting_version)::integer versions,
           count(DISTINCT operation.id)::integer operations,
           count(DISTINCT event.id)::integer events,
           bool_and(operation.write_txid=event.write_txid
             AND operation.write_txid=CASE WHEN operation.resulting_version=manual_case.version THEN manual_case.lifecycle_txid ELSE operation.write_txid END) txids_match
      FROM pos_manual_payment_cases manual_case
      JOIN pos_manual_payment_operations operation ON operation.case_id=manual_case.id
      JOIN pos_manual_payment_state_events event ON event.operation_id=operation.id
     WHERE manual_case.id=$1::uuid
     GROUP BY manual_case.id`, [caseId]);
  assert.equal(graph.rows[0]!.versions, expectedVersions);
  assert.equal(graph.rows[0]!.operations, expectedVersions);
  assert.equal(graph.rows[0]!.events, expectedVersions);
  assert.equal(graph.rows[0]!.txids_match, true);
  await assertNoLegacyRoots(owner);
}

async function assertNoLegacyRoots(owner: Client) {
  const pending = await owner.query<{ roots: number; observations: number; nonces: number }>(`
    SELECT (SELECT count(*)::integer FROM pos_manual_t2_write_roots WHERE capability LIKE 'legacy_manual:%') roots,
           (SELECT count(*)::integer FROM pos_manual_t2_write_observations WHERE capability LIKE 'legacy_manual:%') observations,
           (SELECT count(*)::integer FROM pos_manual_t2_transaction_nonces) nonces`);
  assert.deepEqual(pending.rows[0], { roots: 0, observations: 0, nonces: 0 });
}

function digest(value: string) {
  return createHash("sha256").update(value).digest("hex");
}

function digestCanonical(value: unknown) {
  return digest(canonicalJson(value));
}

function canonicalJson(value: unknown): string {
  if (value instanceof Date) return JSON.stringify(value.toISOString());
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).filter(key => record[key] !== undefined).sort().map(key => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(",")}}`;
}
