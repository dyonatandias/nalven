import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import test from "node:test";
import { Client, type DatabaseError } from "pg";
import { PrismaPg } from "@prisma/adapter-pg";
import { Prisma, PrismaClient } from "../generated/tenant/client";

const connectionString = process.env.POS_TEST_DATABASE_URL;
const runtimeConnectionString = process.env.POS_TEST_RUNTIME_DATABASE_URL;
const binderConnectionString = process.env.POS_TEST_BINDER_DATABASE_URL;

type OpenPreparedResult = {
  requestId: string;
  ticket: string;
  state: string;
  replayed?: boolean;
};

type OpenClaimResult = {
  claimToken: string;
  fencingToken: string | number | bigint;
  vaultIdempotencyKey: string;
  replayed?: boolean;
};

type OpenCaseResult = {
  caseId: string;
  state: string;
  replayed?: boolean;
};

test(
  "321f permanece hard-off, rejeita NULL fencing e não expõe capabilities a PUBLIC",
  { skip: !connectionString },
  async () => {
    const db = new Client({ connectionString });
    await db.connect();
    try {
      const functions = await db.query<{
        name: string;
        prosecdef: boolean;
        config: string[] | null;
        public_execute: boolean;
      }>(`
      SELECT p.proname AS name,p.prosecdef,p.proconfig AS config,
        has_function_privilege('public',p.oid,'EXECUTE') AS public_execute
      FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
      WHERE n.nspname='public' AND p.proname IN ('pos_manual_prepare_open_v1','pos_manual_claim_open_for_vault_v1','pos_manual_open_case_v1','pos_manual_open_status_v1','pos_manual_abandon_open_v1','pos_manual_probe_open_v1')`);
      assert.equal(functions.rows.length, 6);
      for (const fn of functions.rows) {
        assert.equal(fn.prosecdef, true);
        assert.deepEqual(fn.config, ["search_path=pg_catalog"]);
        assert.equal(fn.public_execute, false);
      }
      await rejected(
        db,
        `SELECT public."pos_manual_open_case_v1"(NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL)`,
        "22023",
      );
      await rejected(
        db,
        `SELECT public."pos_manual_abandon_open_v1"(NULL,NULL,NULL,NULL,NULL)`,
        "22023",
      );
      const gate = await db.query<{ enabled: boolean }>(
        `SELECT enabled FROM public."pos_manual_payment_reconciliation_gates" WHERE enabled LIMIT 1`,
      );
      assert.equal(gate.rowCount, 0, "321f não pode habilitar gate");
    } finally {
      await db.end();
    }
  },
);

test(
  "321f executa prepare/claim replay/finalize e sela o grafo causal",
  { skip: !connectionString, timeout: 90_000 },
  async () => {
    const prisma = new PrismaClient({
      adapter: new PrismaPg({ connectionString: connectionString! }),
    });
    const token = randomUUID(),
      compact = token.replaceAll("-", "").slice(0, 24),
      h = (value: string) => createHash("sha256").update(value).digest("hex");
    let connectorId = "";
    try {
      const role = await prisma.tenantRole.findFirstOrThrow({
        where: { active: true },
      });
      const branch = await prisma.branch.create({
        data: {
          code: `OV${compact}`,
          name: `Open vault ${compact}`,
          legalName: `Open vault ${compact} Ltda`,
          document: `OVDOC${compact}`,
        },
      });
      const register = await prisma.posRegister.create({
        data: {
          branchId: branch.id,
          code: `OVR${compact}`,
          name: "Open vault register",
        },
      });
      const maker = await prisma.tenantUserProfile.create({
        data: {
          userId: `ov-maker-${token}`,
          roleId: role.id,
          displayName: "Open vault maker",
          email: `${compact}@example.invalid`,
          activeBranchId: branch.id,
        },
      });
      await prisma.branchUserAccess.create({
        data: { branchId: branch.id, userProfileId: maker.id, canSell: true },
      });
      await prisma.posRegisterAccess.create({
        data: {
          registerId: register.id,
          userProfileId: maker.id,
          active: true,
          canSell: true,
          canManualPayment: true,
        },
      });
      const now = new Date();
      const terminal = await prisma.posTerminal.create({
        data: {
          id: `ov-terminal-${token}`,
          registerId: register.id,
          code: `OVT${compact}`,
          name: "Open vault terminal",
          status: "online",
          tokenHash: `hmac-sha256:v1:${h(token)}`,
          tokenIssuedAt: now,
          tokenExpiresAt: new Date(now.valueOf() + 3_600_000),
          credentialVersion: 1,
          pairedAt: now,
          lastSeenAt: now,
          appVersion: "test",
        },
      });
      const session = await prisma.cashRegisterSession.create({
        data: {
          number: `OV-${token}`,
          registerName: register.name,
          status: "open",
          openingAmount: 0,
          openingAmountCents: 0,
          openedBy: maker.displayName,
          registerId: register.id,
          operatorProfileId: maker.id,
        },
      });
      const provider = `ov_${compact}`;
      await prisma.integrationProvider.create({
        data: {
          id: provider,
          family: "payment",
          label: "Open vault",
          description: "fixture",
          recipientType: "none",
          authType: "api_key",
          capabilities: {},
          credentialSchema: {},
        },
      });
      const credential = await prisma.integrationCredential.create({
        data: {
          id: `ov-credential-${token}`,
          providerId: provider,
          label: "Open vault",
          enabled: true,
          config: {},
        },
      });
      const connector = await prisma.posConnector.create({
        data: {
          id: `ov-connector-${token}`,
          branchId: branch.id,
          registerId: register.id,
          type: `ov_${compact}`,
          provider,
          credentialRef: credential.id,
          status: "active",
          settings: {
            capabilities: ["manual_reference_query"],
            manualReconciliation: { enabled: true, vaultBindingRequired: true },
          },
        },
      });
      connectorId = connector.id;
      await prisma.$executeRawUnsafe(
        `ALTER TABLE "pos_manual_payment_reconciliation_gates" DISABLE TRIGGER "pos_manual_reconciliation_gate_guard"`,
      );
      await prisma.posManualPaymentReconciliationGate.create({
        data: {
          connectorId: connector.id,
          connectorRevision: connector.revision,
          credentialRef: credential.id,
          credentialRevision: credential.revision,
          enabled: true,
          vaultAdapterId: "vault-test",
          providerAdapterVersion: "adapter-v1",
          enabledBy: "321f-pg",
          enabledAt: new Date(),
          configHash: "c".repeat(64),
        },
      });
      await prisma.$executeRawUnsafe(
        `ALTER TABLE "pos_manual_payment_reconciliation_gates" ENABLE TRIGGER "pos_manual_reconciliation_gate_guard"`,
      );
      const product = await prisma.product.create({
        data: {
          name: `OV ${compact}`,
          slug: `ov-${compact}`,
          sku: `OV-${compact}`,
          category: "Teste",
          price: 10,
          regularPrice: 10,
          manageStock: false,
        },
      });
      const planId = `ov-plan-${token}`,
        draftId = `ov-draft-${token}`,
        requestHash = h(token),
        evaluatedAt = new Date(),
        expiresAt = new Date(evaluatedAt.valueOf() + 300_000);
      await prisma.$transaction(async (tx) => {
        const draft = await tx.posHeldSale.create({
          data: {
            id: draftId,
            registerId: register.id,
            sessionId: session.id,
            operatorProfileId: maker.id,
            status: "draft",
            idempotencyKey: `draft-${token}`,
            requestHash,
            items: {
              create: {
                productId: product.id,
                quantity: 1,
                unitPriceCents: 1000,
                discountCents: 0,
              },
            },
          },
          include: { items: true },
        });
        await tx.posPaymentPlan.create({
          data: {
            id: planId,
            branchId: branch.id,
            registerId: register.id,
            sessionId: session.id,
            operatorProfileId: maker.id,
            terminalId: terminal.id,
            saleDraftId: draftId,
            draftRevision: 0,
            draftRequestHash: requestHash,
            draftStatus: "draft",
            quoteHash: requestHash,
            evaluatedAt,
            expiresAt,
            totalCents: 1000,
            idempotencyKey: `quote-${token}`,
            requestHash,
          },
        });
        await tx.posPaymentPlanQuoteLine.create({
          data: {
            planId,
            lineIndex: 0,
            heldSaleItemId: draft.items[0]!.id,
            productId: product.id,
            quantity: 1,
            unitPriceCents: 1000,
            grossCents: 1000,
            baseDiscountCents: 0,
            orderDiscountCents: 0,
            promotionDiscountCents: 0,
            surchargeCents: 0,
            totalCents: 1000,
          },
        });
        await tx.posPaymentPlanOperation.create({
          data: {
            planId,
            action: "quote",
            expectedVersion: -1,
            resultingVersion: 0,
            resultingState: "quoted",
            idempotencyKey: `quote-${token}`,
            requestHash,
          },
        });
      });
      await prisma.$transaction(async (tx) => {
        await tx.posPaymentPlanSlot.create({
          data: {
            planId,
            paymentIndex: 0,
            method: "credit",
            amountCents: 1000,
            installments: 1,
            proofKind: "manual",
            connectorId: connector.id,
            credentialRef: credential.id,
            provider,
          },
        });
        await tx.posPaymentPlanOperation.create({
          data: {
            planId,
            action: "activate",
            expectedVersion: 0,
            resultingVersion: 1,
            resultingState: "active",
            idempotencyKey: `activate-${token}`,
            requestHash,
          },
        });
        await tx.posPaymentPlan.update({
          where: { id: planId },
          data: { state: "active", version: 1 },
        });
      });
      await prisma.posManualVaultVerifier.upsert({
        where: { verifierVersion: "verifier-test-v1" },
        create: {
          verifierVersion: "verifier-test-v1",
          enabled: true,
          maxFutureSkewSeconds: 30,
        },
        update: { enabled: true, maxFutureSkewSeconds: 30 },
      });
      const prepareKey = h(`prepare:${token}`),
        intent = h(`intent:${token}`),
        occurredAt = new Date();
      await assert.rejects(
        prisma.$queryRaw(
          Prisma.sql`SELECT public."pos_manual_prepare_open_v1"(${planId},0,${maker.id},${maker.userId},${new Date("2100-01-01T00:00:00Z")},'manual.external_terminal',${h(`future:${token}`)},${intent})`,
        ),
        /causal input/,
      );
      await assert.rejects(
        prisma.$queryRaw(
          Prisma.sql`SELECT public."pos_manual_prepare_open_v1"(${planId},0,${maker.id},${maker.userId},${new Date(Date.now() - 25 * 60 * 60 * 1000)},'manual.external_terminal',${h(`old:${token}`)},${intent})`,
        ),
        /causal input/,
      );
      await assert.rejects(
        prisma.$queryRaw(
          Prisma.sql`SELECT public."pos_manual_prepare_open_v1"(${planId},0,${maker.id},${maker.userId},${occurredAt},'a.4111111111111111',${h(`pan:${token}`)},${intent})`,
        ),
        /causal input/,
      );
      const prepared = (
        await prisma.$queryRaw<Array<{ result: OpenPreparedResult }>>(
          Prisma.sql`SELECT public."pos_manual_prepare_open_v1"(${planId},0,${maker.id},${maker.userId},${occurredAt},'manual.external_terminal',${prepareKey},${intent}) AS result`,
        )
      )[0]!.result;
      const claimKey = h(`claim:${token}`),
        binder = "binder.test.v1";
      await assert.rejects(
        prisma.$queryRaw(
          Prisma.sql`SELECT public."pos_manual_claim_open_for_vault_v1"(${prepared.requestId}::uuid,${prepared.ticket},'b:4111111111111111',${claimKey},15)`,
        ),
        /invalid closed vault claim input/,
      );
      const claimed = (
        await prisma.$queryRaw<Array<{ result: OpenClaimResult }>>(
          Prisma.sql`SELECT public."pos_manual_claim_open_for_vault_v1"(${prepared.requestId}::uuid,${prepared.ticket},${binder},${claimKey},15) AS result`,
        )
      )[0]!.result;
      const concurrentReplays = await Promise.all(
        Array.from({ length: 20 }, () =>
          prisma.$queryRaw<Array<{ result: OpenClaimResult }>>(
            Prisma.sql`SELECT public."pos_manual_claim_open_for_vault_v1"(${prepared.requestId}::uuid,${prepared.ticket},${binder},${claimKey},15) AS result`,
          ),
        ),
      );
      for (const rows of concurrentReplays) {
        const replay = rows[0]!.result;
        assert.equal(replay.replayed, true);
        assert.deepEqual({ ...replay, replayed: claimed.replayed }, claimed);
      }
      await prisma.$executeRaw`SELECT pg_sleep(15.1)`;
      const reclaimKey = h(`reclaim:${token}`);
      let reclaimed = (
        await prisma.$queryRaw<Array<{ result: OpenClaimResult }>>(
          Prisma.sql`SELECT public."pos_manual_claim_open_for_vault_v1"(${prepared.requestId}::uuid,${prepared.ticket},${binder},${reclaimKey},15) AS result`,
        )
      )[0]!.result;
      assert.equal(
        BigInt(reclaimed.fencingToken),
        BigInt(claimed.fencingToken) + BigInt(1),
      );
      assert.notEqual(reclaimed.claimToken, claimed.claimToken);
      const prepareAndClaim = async (suffix: string) => {
        const p = (
          await prisma.$queryRaw<Array<{ result: OpenPreparedResult }>>(
            Prisma.sql`SELECT public."pos_manual_prepare_open_v1"(${planId},0,${maker.id},${maker.userId},${new Date()},'manual.external_terminal',${h(`prepare:${suffix}:${token}`)},${h(`intent:${suffix}:${token}`)}) AS result`,
          )
        )[0]!.result;
        const c = (
          await prisma.$queryRaw<Array<{ result: OpenClaimResult }>>(
            Prisma.sql`SELECT public."pos_manual_claim_open_for_vault_v1"(${p.requestId}::uuid,${p.ticket},${binder},${h(`claim:${suffix}:${token}`)},15) AS result`,
          )
        )[0]!.result;
        return { p, c };
      };
      const proofFacts = async (
        p: OpenPreparedResult,
        c: OpenClaimResult,
        suffix: string,
        planExpiresAt = expiresAt,
      ) => {
        const issuedAt = new Date(),
          retentionExpiresAt = new Date(planExpiresAt.valueOf() + 30_000),
          externalProof = `proof-${suffix}-${token}`,
          stable = `vault-blind:v1:${h(`blind:${suffix}:${token}`)}`,
          reference = `hmac-sha256:v1:${h(`ref:${suffix}:${token}`)}`,
          binding = h(`binding:${suffix}:${token}`),
          signature = h(`signature:${suffix}:${token}`);
        const proof = (
          await prisma.$queryRaw<Array<{ hash: string }>>(
            Prisma.sql`SELECT encode(sha256(convert_to('pos-manual-vault-proof-v1'||jsonb_build_array(${p.requestId}::uuid,${BigInt(c.fencingToken)}::bigint,${c.vaultIdempotencyKey}::text,'vault-test'::text,${provider}::text,${externalProof}::text,${stable}::text,${reference}::text,'reference-key-v1'::text,'A123'::text,'vault-key-v1'::text,${binding}::text,${signature}::text,extract(epoch FROM ${issuedAt}::timestamptz),extract(epoch FROM ${retentionExpiresAt}::timestamptz),'verifier-test-v1'::text)::text,'UTF8')),'hex') AS hash`,
          )
        )[0]!.hash;
        return {
          issuedAt,
          retentionExpiresAt,
          externalProof,
          stable,
          reference,
          binding,
          signature,
          proof,
        };
      };
      const advisory = await prepareAndClaim("advisory"),
        verifierLock = new Client({ connectionString }),
        advisoryLock = new Client({ connectionString });
      await verifierLock.connect();
      await advisoryLock.connect();
      const advisoryFacts = await proofFacts(
          advisory.p,
          advisory.c,
          "advisory-wait",
        );
      try {
        await advisoryLock.query("BEGIN");
        await advisoryLock.query(
          `SELECT pg_advisory_xact_lock(hashtext('pos-manual-proof-external-v1'),hashtext($1))`,
          [advisoryFacts.externalProof],
        );
        let waitStarted = Date.now();
        const advisoryFinalize = prisma
          .$queryRaw(
            Prisma.sql`SELECT public."pos_manual_open_case_v1"(${advisory.p.requestId}::uuid,${advisory.c.claimToken},${BigInt(advisory.c.fencingToken)},${h(`wait-advisory:${token}`)},${advisoryFacts.externalProof},${advisoryFacts.stable},${advisoryFacts.reference},'reference-key-v1','A123','vault-key-v1',${advisoryFacts.binding},${advisoryFacts.proof},${advisoryFacts.signature},${advisoryFacts.issuedAt},${advisoryFacts.retentionExpiresAt},'verifier-test-v1')`,
          )
          .then(
            (value) => ({ ok: true, value }),
            (error) => ({ ok: false, error }),
          );
        await new Promise((resolve) => setTimeout(resolve, 15_200));
        await advisoryLock.query("ROLLBACK");
        const advisoryOutcome = await advisoryFinalize;
        assert.ok(Date.now() - waitStarted >= 15_000);
        assert.equal(advisoryOutcome.ok, false);
        assert.match(
          String((advisoryOutcome as { error: unknown }).error),
          /boundary diverged/,
        );
        reclaimed = (
          await prisma.$queryRaw<Array<{ result: OpenClaimResult }>>(
            Prisma.sql`SELECT public."pos_manual_claim_open_for_vault_v1"(${prepared.requestId}::uuid,${prepared.ticket},${binder},${h(`reclaim-verifier:${token}`)},15) AS result`,
          )
        )[0]!.result;
        const freshVerifierFacts = await proofFacts(
          prepared,
          reclaimed,
          "verifier-wait",
        );
        await verifierLock.query("BEGIN");
        await verifierLock.query(
          `UPDATE public.pos_manual_payment_vault_verifiers SET updated_at=updated_at WHERE verifier_version='verifier-test-v1'`,
        );
        waitStarted = Date.now();
        const verifierFinalize = prisma
          .$queryRaw(
            Prisma.sql`SELECT public."pos_manual_open_case_v1"(${prepared.requestId}::uuid,${reclaimed.claimToken},${BigInt(reclaimed.fencingToken)},${h(`wait-verifier:${token}`)},${freshVerifierFacts.externalProof},${freshVerifierFacts.stable},${freshVerifierFacts.reference},'reference-key-v1','A123','vault-key-v1',${freshVerifierFacts.binding},${freshVerifierFacts.proof},${freshVerifierFacts.signature},${freshVerifierFacts.issuedAt},${freshVerifierFacts.retentionExpiresAt},'verifier-test-v1')`,
          )
          .then(
            (value) => ({ ok: true, value }),
            (error) => ({ ok: false, error }),
          );
        await new Promise((resolve) => setTimeout(resolve, 15_200));
        await verifierLock.query("ROLLBACK");
        const verifierOutcome = await verifierFinalize;
        assert.ok(Date.now() - waitStarted >= 15_000);
        assert.equal(verifierOutcome.ok, false);
        assert.match(
          String((verifierOutcome as { error: unknown }).error),
          /boundary diverged/,
        );
        const empty = await prisma.$queryRaw<Array<{ n: bigint }>>(
          Prisma.sql`SELECT count(*)::bigint n FROM pos_manual_vault_proofs WHERE open_request_id IN (${prepared.requestId}::uuid,${advisory.p.requestId}::uuid)`,
        );
        assert.equal(empty[0]!.n, BigInt(0));
      } finally {
        await verifierLock.query("ROLLBACK").catch(() => undefined);
        await advisoryLock.query("ROLLBACK").catch(() => undefined);
        await verifierLock.end();
        await advisoryLock.end();
      }
      reclaimed = (
        await prisma.$queryRaw<Array<{ result: OpenClaimResult }>>(
          Prisma.sql`SELECT public."pos_manual_claim_open_for_vault_v1"(${prepared.requestId}::uuid,${prepared.ticket},${binder},${h(`reclaim-after-wait:${token}`)},15) AS result`,
        )
      )[0]!.result;
      const {
        issuedAt,
        retentionExpiresAt,
        externalProof,
        stable,
        reference,
        binding,
        signature,
        proof,
      } = await proofFacts(prepared, reclaimed, "winner");
      await assert.rejects(
        prisma.$queryRaw(
          Prisma.sql`SELECT public."pos_manual_open_case_v1"(${prepared.requestId}::uuid,${claimed.claimToken},${BigInt(claimed.fencingToken)},${h(`stale:${token}`)},${externalProof},${stable},${reference},'reference-key-v1','A123','vault-key-v1',${binding},${proof},${signature},${issuedAt},${retentionExpiresAt},'verifier-test-v1')`,
        ),
        /boundary diverged/,
      );
      const finalized = (
        await prisma.$queryRaw<Array<{ result: OpenCaseResult }>>(
          Prisma.sql`SELECT public."pos_manual_open_case_v1"(${prepared.requestId}::uuid,${reclaimed.claimToken},${BigInt(reclaimed.fencingToken)},${h(`finalize:${token}`)},${externalProof},${stable},${reference},'reference-key-v1','A123','vault-key-v1',${binding},${proof},${signature},${issuedAt},${retentionExpiresAt},'verifier-test-v1') AS result`,
        )
      )[0]!.result;
      assert.equal(finalized.state, "review_pending");
      const terminalBefore =
        await prisma.posManualOpenRequest.findUniqueOrThrow({
          where: { id: prepared.requestId },
          select: { updatedAt: true },
        });
      await prisma.$executeRaw(
        Prisma.sql`UPDATE pos_manual_open_requests SET updated_at=updated_at WHERE id=${prepared.requestId}::uuid`,
      );
      const terminalAfter = await prisma.posManualOpenRequest.findUniqueOrThrow(
        { where: { id: prepared.requestId }, select: { updatedAt: true } },
      );
      assert.equal(
        terminalAfter.updatedAt.valueOf(),
        terminalBefore.updatedAt.valueOf(),
      );
      const graph = await prisma.$queryRaw<
        Array<{
          requests: bigint;
          proofs: bigint;
          bindings: bigint;
          operations: bigint;
          events: bigint;
          txids: bigint;
        }>
      >(
        Prisma.sql`SELECT count(DISTINCT r.id)::bigint requests,count(DISTINCT p.id)::bigint proofs,count(DISTINCT b.id)::bigint bindings,count(DISTINCT o.id)::bigint operations,count(DISTINCT e.id)::bigint events,count(DISTINCT x.txid)::bigint txids FROM pos_manual_open_requests r JOIN pos_manual_vault_proofs p ON p.open_request_id=r.id JOIN pos_manual_payment_vault_bindings b ON b.vault_proof_id=p.id JOIN pos_manual_payment_operations o ON o.case_id=r.case_id JOIN pos_manual_payment_state_events e ON e.operation_id=o.id CROSS JOIN LATERAL (VALUES(r.lifecycle_txid),(p.write_txid),(o.write_txid),(e.write_txid)) x(txid) WHERE r.id=${prepared.requestId}::uuid`,
      );
      assert.deepEqual(graph[0], {
        requests: BigInt(1),
        proofs: BigInt(1),
        bindings: BigInt(1),
        operations: BigInt(1),
        events: BigInt(1),
        txids: BigInt(1),
      });
      await assert.rejects(
        prisma.$executeRaw(
          Prisma.sql`UPDATE pos_manual_payment_vault_bindings SET vault_provider='tampered',vault_key_id='tampered',id=gen_random_uuid() WHERE vault_proof_id=(SELECT vault_proof_id FROM pos_manual_open_requests WHERE id=${prepared.requestId}::uuid)`,
        ),
        /immutable|append-only/i,
      );
      const finalizedReplay = (
        await prisma.$queryRaw<Array<{ result: OpenCaseResult }>>(
          Prisma.sql`SELECT public."pos_manual_open_case_v1"(${prepared.requestId}::uuid,${reclaimed.claimToken},${BigInt(reclaimed.fencingToken)},${h(`finalize:${token}`)},${externalProof},${stable},${reference},'reference-key-v1','A123','vault-key-v1',${binding},${proof},${signature},${issuedAt},${retentionExpiresAt},'verifier-test-v1') AS result`,
        )
      )[0]!.result;
      assert.equal(finalizedReplay.replayed, true);
      await assert.rejects(
        prisma.$queryRaw(
          Prisma.sql`SELECT public."pos_manual_open_case_v1"(${prepared.requestId}::uuid,${reclaimed.claimToken},${BigInt(reclaimed.fencingToken) + BigInt(1)},${h(`finalize:${token}`)},${externalProof},${stable},${reference},'reference-key-v1','A123','vault-key-v1',${binding},${proof},${signature},${issuedAt},${retentionExpiresAt},'verifier-test-v1')`,
        ),
        /idempotency conflict/,
      );
      const loserPlan = `ov-loser-plan-${token}`,
        loserDraft = `ov-loser-draft-${token}`,
        loserHash = h(`loser:${token}`),
        loserEvaluatedAt = new Date(),
        loserExpiresAt = new Date(loserEvaluatedAt.valueOf() + 300_000);
      await prisma.$transaction(async (tx) => {
        const draft = await tx.posHeldSale.create({
          data: {
            id: loserDraft,
            registerId: register.id,
            sessionId: session.id,
            operatorProfileId: maker.id,
            status: "draft",
            idempotencyKey: `loser-draft-${token}`,
            requestHash: loserHash,
            items: {
              create: {
                productId: product.id,
                quantity: 1,
                unitPriceCents: 1000,
                discountCents: 0,
              },
            },
          },
          include: { items: true },
        });
        await tx.posPaymentPlan.create({
          data: {
            id: loserPlan,
            branchId: branch.id,
            registerId: register.id,
            sessionId: session.id,
            operatorProfileId: maker.id,
            terminalId: terminal.id,
            saleDraftId: loserDraft,
            draftRevision: 0,
            draftRequestHash: loserHash,
            draftStatus: "draft",
            quoteHash: loserHash,
            evaluatedAt: loserEvaluatedAt,
            expiresAt: loserExpiresAt,
            totalCents: 1000,
            idempotencyKey: `loser-quote-${token}`,
            requestHash: loserHash,
          },
        });
        await tx.posPaymentPlanQuoteLine.create({
          data: {
            planId: loserPlan,
            lineIndex: 0,
            heldSaleItemId: draft.items[0]!.id,
            productId: product.id,
            quantity: 1,
            unitPriceCents: 1000,
            grossCents: 1000,
            baseDiscountCents: 0,
            orderDiscountCents: 0,
            promotionDiscountCents: 0,
            surchargeCents: 0,
            totalCents: 1000,
          },
        });
        await tx.posPaymentPlanOperation.create({
          data: {
            planId: loserPlan,
            action: "quote",
            expectedVersion: -1,
            resultingVersion: 0,
            resultingState: "quoted",
            idempotencyKey: `loser-quote-${token}`,
            requestHash: loserHash,
          },
        });
      });
      await prisma.$transaction(async (tx) => {
        await tx.posPaymentPlanSlot.create({
          data: {
            planId: loserPlan,
            paymentIndex: 0,
            method: "credit",
            amountCents: 1000,
            installments: 1,
            proofKind: "manual",
            connectorId: connector.id,
            credentialRef: credential.id,
            provider,
          },
        });
        await tx.posPaymentPlanOperation.create({
          data: {
            planId: loserPlan,
            action: "activate",
            expectedVersion: 0,
            resultingVersion: 1,
            resultingState: "active",
            idempotencyKey: `loser-activate-${token}`,
            requestHash: loserHash,
          },
        });
        await tx.posPaymentPlan.update({
          where: { id: loserPlan },
          data: { state: "active", version: 1 },
        });
      });
      const loserPrepared = (
          await prisma.$queryRaw<Array<{ result: OpenPreparedResult }>>(
            Prisma.sql`SELECT public."pos_manual_prepare_open_v1"(${loserPlan},0,${maker.id},${maker.userId},${new Date()},'manual.external_terminal',${h(`loser-prepare:${token}`)},${h(`loser-intent:${token}`)}) AS result`,
          )
        )[0]!.result,
        loserClaim = (
          await prisma.$queryRaw<Array<{ result: OpenClaimResult }>>(
            Prisma.sql`SELECT public."pos_manual_claim_open_for_vault_v1"(${loserPrepared.requestId}::uuid,${loserPrepared.ticket},${binder},${h(`loser-claim:${token}`)},15) AS result`,
          )
        )[0]!.result;
      const collisionDb = new Client({ connectionString });
      await collisionDb.connect();
      try {
        const dimensions = [
          "external",
          "stable",
          "binding",
          "reference",
        ] as const;
        for (const dimension of dimensions) {
          const base = await proofFacts(
            loserPrepared,
            loserClaim,
            `collision-${dimension}`,
            loserExpiresAt,
          ),
            facts = {
              ...base,
              externalProof:
                dimension === "external" ? externalProof : base.externalProof,
              stable: dimension === "stable" ? stable : base.stable,
              binding: dimension === "binding" ? binding : base.binding,
              reference: dimension === "reference" ? reference : base.reference,
            };
          facts.proof = (
            await prisma.$queryRaw<Array<{ hash: string }>>(
              Prisma.sql`SELECT encode(sha256(convert_to('pos-manual-vault-proof-v1'||jsonb_build_array(${loserPrepared.requestId}::uuid,${BigInt(loserClaim.fencingToken)}::bigint,${loserClaim.vaultIdempotencyKey}::text,'vault-test'::text,${provider}::text,${facts.externalProof}::text,${facts.stable}::text,${facts.reference}::text,'reference-key-v1'::text,'A123'::text,'vault-key-v1'::text,${facts.binding}::text,${facts.signature}::text,extract(epoch FROM ${facts.issuedAt}::timestamptz),extract(epoch FROM ${facts.retentionExpiresAt}::timestamptz),'verifier-test-v1'::text)::text,'UTF8')),'hex') hash`,
            )
          )[0]!.hash;
          await assert.rejects(
            collisionDb.query(
              `SELECT public.pos_manual_open_case_v1($1::uuid,$2,$3::bigint,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14::timestamptz,$15::timestamptz,$16)`,
              [
                loserPrepared.requestId,
                loserClaim.claimToken,
                loserClaim.fencingToken,
                h(`collision-finalize:${dimension}:${token}`),
                facts.externalProof,
                facts.stable,
                facts.reference,
                "reference-key-v1",
                "A123",
                "vault-key-v1",
                facts.binding,
                facts.proof,
                facts.signature,
                facts.issuedAt,
                facts.retentionExpiresAt,
                "verifier-test-v1",
              ],
            ),
            (error: DatabaseError) => {
          assert.equal(error.code, "23505", error.message);
              assert.equal(error.message, "manual vault evidence conflict");
              assert.equal(error.constraint, undefined);
              assert.equal(error.detail, undefined);
              assert.doesNotMatch(
                String(error),
                new RegExp(
                  `${prepared.requestId}|${externalProof}|${stable}|${binding}|${reference}|pos_manual_`,
                  "i",
                ),
              );
              return true;
            },
          );
        }
      } finally {
        await collisionDb.end();
      }
      const loserGraph = await prisma.$queryRaw<
        Array<{
          proofs: bigint;
          bindings: bigint;
          cases: bigint;
          operations: bigint;
          events: bigint;
        }>
      >(
        Prisma.sql`SELECT count(DISTINCT p.id)::bigint proofs,count(DISTINCT b.id)::bigint bindings,count(DISTINCT c.id)::bigint cases,count(DISTINCT o.id)::bigint operations,count(DISTINCT e.id)::bigint events FROM pos_manual_open_requests r LEFT JOIN pos_manual_vault_proofs p ON p.open_request_id=r.id LEFT JOIN pos_manual_payment_vault_bindings b ON b.vault_proof_id=p.id LEFT JOIN pos_manual_payment_cases c ON c.id=r.case_id LEFT JOIN pos_manual_payment_operations o ON o.case_id=c.id LEFT JOIN pos_manual_payment_state_events e ON e.case_id=c.id WHERE r.id=${loserPrepared.requestId}::uuid`,
      );
      assert.deepEqual(loserGraph[0], {
        proofs: BigInt(0),
        bindings: BigInt(0),
        cases: BigInt(0),
        operations: BigInt(0),
        events: BigInt(0),
      });
      const panChecks = await prisma.$queryRaw<
        Array<{
          embedded: boolean;
          formatted: boolean;
          colon: boolean;
          parenthesized: boolean;
        }>
      >(
        Prisma.sql`SELECT public."pos_manual_identifier_contains_pan_321f"('proof-4111111111111111') embedded,public."pos_manual_identifier_contains_pan_321f"('key-4111-1111-1111-1111') formatted,public."pos_manual_identifier_contains_pan_321f"('proof:4111:1111:1111:1111') colon,public."pos_manual_identifier_contains_pan_321f"('proof(4111 1111 1111 1111)') parenthesized`,
      );
      assert.deepEqual(panChecks[0], {
        embedded: true,
        formatted: true,
        colon: true,
        parenthesized: true,
      });
      await assert.rejects(
        prisma.posManualVaultVerifier.create({
          data: { verifierVersion: "verifier-4111111111111111", enabled: true },
        }),
        /constraint/i,
      );
      const dlp = await prisma.$queryRaw<Array<{ hits: bigint }>>(
        Prisma.sql`SELECT count(*)::bigint hits FROM (SELECT row_to_json(r)::text body FROM pos_manual_open_requests r UNION ALL SELECT row_to_json(p)::text FROM pos_manual_vault_proofs p UNION ALL SELECT row_to_json(b)::text FROM pos_manual_payment_vault_bindings b UNION ALL SELECT row_to_json(c)::text FROM pos_manual_payment_cases c) evidence WHERE body LIKE '%raw-secret-sentinel-4111111111111111%'`,
      );
      assert.equal(dlp[0]!.hits, BigInt(0));
      await prisma.$transaction(async (tx) => {
        const op = (
          await tx.$queryRaw<Array<{ id: bigint }>>(
            Prisma.sql`INSERT INTO pos_manual_payment_operations(case_id,action,expected_version,resulting_version,resulting_state,idempotency_key,request_hash,write_txid) VALUES(${finalized.caseId}::uuid,'expire',0,1,'expired',${`expire-${token}`},${h(`expire:${token}`)},txid_current()::numeric) RETURNING id`,
          )
        )[0]!;
        await tx.$executeRaw(
          Prisma.sql`INSERT INTO pos_manual_payment_state_events(case_id,operation_id,from_state,to_state,resulting_version,source,source_id,write_txid) VALUES(${finalized.caseId}::uuid,${op.id},'review_pending','expired',1,'maintenance',${`expiry-${token}`},txid_current()::numeric)`,
        );
        await tx.posManualPaymentCase.update({
          where: { id: finalized.caseId },
          data: { state: "expired", version: 1 },
        });
      });
      assert.equal(
        (
          await prisma.posManualPaymentCase.findUniqueOrThrow({
            where: { id: finalized.caseId },
          })
        ).state,
        "expired",
        "transição pós-open não pode invalidar evidência imutável do grafo 321f",
      );
      await prisma.$executeRaw(
        Prisma.sql`UPDATE pos_manual_open_requests SET updated_at=updated_at WHERE id=${prepared.requestId}::uuid`,
      );
      await assert.rejects(
        prisma.posManualPaymentVaultBinding.create({
          data: {
            caseId: finalized.caseId,
            vaultProvider: "legacy",
            vaultReference: "raw-forbidden",
            vaultKeyId: "legacy",
            bindingHash: h("legacy"),
            stableReferenceIndex: `vault-blind:v1:${h("legacy")}`,
            retentionExpiresAt,
          },
        }),
        /require proof_v1|Unique constraint/,
      );
    } finally {
      if (connectorId) {
        await prisma
          .$executeRawUnsafe(
            `ALTER TABLE "pos_manual_payment_reconciliation_gates" DISABLE TRIGGER "pos_manual_reconciliation_gate_guard"`,
          )
          .catch(() => undefined);
        await prisma.posManualPaymentReconciliationGate
          .updateMany({ where: { connectorId }, data: { enabled: false } })
          .catch(() => undefined);
        await prisma
          .$executeRawUnsafe(
            `ALTER TABLE "pos_manual_payment_reconciliation_gates" ENABLE TRIGGER "pos_manual_reconciliation_gate_guard"`,
          )
          .catch(() => undefined);
      }
      await prisma.$disconnect();
    }
  },
);

async function rejected(db: Client, sql: string, code: string) {
  await assert.rejects(db.query(sql), (error: DatabaseError) => {
    assert.equal(error.code, code);
    return true;
  });
}

test(
  "321f aplica ACL real runtime versus binder sem DML cruzado",
  { skip: !runtimeConnectionString || !binderConnectionString },
  async () => {
    const runtime = new Client({ connectionString: runtimeConnectionString }),
      binder = new Client({ connectionString: binderConnectionString });
    await runtime.connect();
    await binder.connect();
    try {
      await rejected(
        runtime,
        `SELECT * FROM public.pos_manual_open_requests LIMIT 1`,
        `42501`,
      );
      await rejected(
        binder,
        `SELECT * FROM public.pos_manual_vault_proofs LIMIT 1`,
        `42501`,
      );
      await rejected(
        runtime,
        `SELECT public.pos_manual_claim_open_for_vault_v1(NULL,NULL,NULL,NULL,NULL)`,
        `42501`,
      );
      await rejected(
        binder,
        `SELECT public.pos_manual_prepare_open_v1(NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL)`,
        `42501`,
      );
      await rejected(
        runtime,
        `INSERT INTO public.pos_manual_open_requests(id) VALUES(gen_random_uuid())`,
        `42501`,
      );
      await rejected(
        binder,
        `DELETE FROM public.pos_manual_vault_proofs`,
        `42501`,
      );
      const allowedRuntime = await runtime.query(
        `SELECT public.pos_manual_open_status_v1(NULL,NULL,NULL,NULL)`,
      );
      assert.fail(
        `status NULL deveria validar input, recebeu ${allowedRuntime.rowCount}`,
      );
    } catch (error) {
      if (error instanceof Error && /status NULL deveria/.test(error.message))
        throw error;
      const code = (error as DatabaseError).code;
      assert.equal(
        code,
        "22023",
        "runtime deve alcançar status e falhar na validação interna, não ACL",
      );
    } finally {
      await runtime.end();
      await binder.end();
    }
  },
);
