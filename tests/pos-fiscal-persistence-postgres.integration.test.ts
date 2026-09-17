import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import test from "node:test";
import { PrismaPg } from "@prisma/adapter-pg";
import { Prisma, PrismaClient } from "../generated/tenant/client";
import { canonicalPosJson } from "../lib/erp/pos-connectors";
import { acceptPosFiscalCallback, claimPosFiscalOutbox, completePosFiscalOutbox, maintainPosFiscalPersistence, queuePosFiscalIssuanceForSale } from "../lib/erp/pos-fiscal-persistence";

const connectionString = process.env.POS_TEST_DATABASE_URL;

test(
  "PostgreSQL preserva contexto, evidência e monotonicidade fiscal",
  { skip: !connectionString },
  async () => {
    const db = client(),
      token = randomUUID(),
      compact = token.replaceAll("-", ""),
      provider = `fiscal_${compact}`,
      digest = createHash("sha256").update(token).digest("hex"),
      accessKey = [...createHash("sha256").update(`access-key:${token}`).digest("hex")]
        .map((character) => String(Number.parseInt(character, 16) % 10))
        .join("")
        .slice(0, 44),
      now = new Date();
    try {
      const role = await db.tenantRole.create({
        data: {
          key: `fiscal-${compact}`,
          name: "Operador fiscal PostgreSQL",
          permissions: ["pdv.write", "fiscal.write"],
        },
      });
      const branch = await db.branch.create({
        data: {
          code: `PGFISC${compact}`,
          name: "Filial fiscal isolada",
          legalName: "Filial fiscal isolada Ltda",
          document: `PGFISCDOC${compact}`,
          state: "SC",
        },
      });
      const register = await db.posRegister.create({
        data: {
          branchId: branch.id,
          code: `PGFISCREG${compact}`,
          name: "Caixa fiscal isolado",
        },
      });
      const operator = await db.tenantUserProfile.create({
        data: {
          userId: `pg-fiscal-${token}`,
          roleId: role.id,
          displayName: "Operador fiscal",
          email: `pg-fiscal-${compact}@example.invalid`,
          activeBranchId: branch.id,
        },
      });
      const session = await db.cashRegisterSession.create({
        data: {
          number: `PG-FISCAL-${token}`,
          registerName: register.name,
          status: "open",
          openingAmount: 0,
          openingAmountCents: 0,
          openedBy: operator.displayName,
          registerId: register.id,
          operatorProfileId: operator.id,
        },
      });
      await db.integrationProvider.create({
        data: {
          id: provider,
          family: "fiscal",
          label: "Provider fiscal PostgreSQL",
          description: "Fixture sem homologação",
          recipientType: "none",
          authType: "api_key",
          capabilities: { fiscal: true, inbound: true },
          credentialSchema: {},
        },
      });
      const credential = await db.integrationCredential.create({
        data: {
          id: `fiscal-credential-${token}`,
          providerId: provider,
          label: "Credencial fiscal isolada",
          enabled: true,
          config: { sandbox: true },
        },
      });
      const connector = await db.posConnector.create({
        data: {
          id: `fiscal-connector-${token}`,
          branchId: branch.id,
          registerId: register.id,
          type: "fiscal_nfce",
          provider,
          credentialRef: credential.id,
          status: "active",
        },
      });
      const profileId = `fiscal-profile-${token}`;
      await db.posFiscalProfileVersion.create({
        data: {
          id: profileId,
          branchId: branch.id,
          connectorId: connector.id,
          credentialRef: credential.id,
          version: 1,
          status: "draft",
          documentModel: "nfce",
          environment: "homologation",
          uf: "SC",
          taxRegime: "simples_nacional",
          schemaVersion: "fixture-1",
          provider,
          numberingOwner: "provider",
          policySnapshot: { fixture: true, homologated: false },
          policyDigest: digest,
          createdBy: operator.userId,
        },
      });
      await db.posFiscalProfileVersion.update({
        where: { id: profileId },
        data: {
          status: "active",
          effectiveFrom: now,
          activatedBy: operator.userId,
          activatedAt: now,
        },
      });
      await assert.rejects(
        db.posFiscalProfileVersion.update({
          where: { id: profileId },
          data: {
            policySnapshot: { fixture: false },
            policyDigest: "a".repeat(64),
          },
        }),
        /immutable/,
      );

      const sale = await db.sale.create({
        data: {
          saleNumber: `PG-FISCAL-SALE-${token}`,
          customer: "Consumidor final",
          seller: operator.displayName,
          cashRegister: register.name,
          paymentMethod: "cash",
          total: 12.34,
          branchId: branch.id,
          sessionId: session.id,
          operatorProfileId: operator.id,
          status: "completed",
          subtotalCents: 1_234,
          discountCents: 0,
          surchargeCents: 0,
          totalCents: 1_234,
          changeCents: 0,
          idempotencyKey: `fiscal-sale-${token}`,
          requestHash: digest,
        },
      });
      const documentId = `fiscal-document-${token}`,
        attemptId = `fiscal-attempt-${token}`;
      await db.posFiscalDocument.create({
        data: {
          id: documentId,
          saleId: sale.id,
          branchId: branch.id,
          registerId: register.id,
          sessionId: session.id,
          operatorProfileId: operator.id,
          connectorId: connector.id,
          credentialRef: credential.id,
          profileId,
          profileVersion: 1,
          purpose: "issue",
          revision: 1,
          status: "created",
          documentModel: "nfce",
          environment: "homologation",
          provider,
          numberingOwner: "provider",
          currency: "BRL",
          totalCents: 1_234,
          saleSnapshot: { saleId: sale.id, totalCents: 1_234, fixture: true },
          snapshotHash: digest,
          idempotencyKey: `fiscal-document-create-${token}`,
          requestHash: digest,
          attempts: {
            create: {
              id: attemptId,
              sequence: 1,
              operation: "issue",
              operationKey: `fiscal-operation-${token}`,
              requestHash: digest,
              providerIdempotencyKey: `fiscal-provider-operation-${token}`,
              outbox: { create: { nextAttemptAt: now } },
            },
          },
          stateEvents: {
            create: {
              eventKey: `fiscal-created-${token}`,
              source: "sale_commit",
              sourceId: String(sale.id),
              toState: "created",
              resultingVersion: 0,
              evidenceHash: digest,
            },
          },
        },
      });
      await assert.rejects(
        db.posFiscalDocument.update({
          where: { id: documentId },
          data: {
            saleSnapshot: { tampered: true },
            snapshotHash: "b".repeat(64),
            version: { increment: 1 },
          },
        }),
        /identity and snapshot are immutable/,
      );

      await db.posFiscalDocument.update({
        where: { id: documentId },
        data: {
          status: "queued",
          version: { increment: 1 },
          nextReconcileAt: new Date(now.valueOf() + 60_000),
        },
      });
      const authorizedAt = new Date(now.valueOf() + 1_000),
        authorization = {
          status: "authorized",
          version: { increment: 1 },
          nextReconcileAt: null,
          providerReference: `fiscal-reference-${token}`,
          accessKey,
          authorizationProtocol: `protocol-${token}`,
          providerOccurredAt: authorizedAt,
          authorizedAt,
        } as const;
      await assert.rejects(
        db.posFiscalDocument.update({
          where: { id: documentId },
          data: authorization,
        }),
        /requires immutable XML artifact/,
      );
      await db.$transaction(async (tx) => {
        await tx.posFiscalArtifact.create({
          data: {
            id: `fiscal-xml-${token}`,
            documentId,
            type: "authorized_xml",
            providerArtifactId: `provider-xml-${token}`,
            storageKey: `fiscal/${compact}/authorized.xml`,
            mimeType: "application/xml",
            sizeBytes: 128,
            sha256: digest,
          },
        });
        await tx.posFiscalDocument.update({
          where: { id: documentId },
          data: authorization,
        });
      });
      await assert.rejects(
        db.posFiscalDocument.update({
          where: { id: documentId },
          data: {
            status: "unknown",
            version: { increment: 1 },
            unknownSince: new Date(),
            nextReconcileAt: new Date(),
          },
        }),
        /invalid fiscal document transition/,
      );

      const cancelAt = new Date(now.valueOf() + 2_000),
        reason = "Cancelamento fiscal solicitado para teste";
      await db.posFiscalDocument.update({
        where: { id: documentId },
        data: {
          status: "cancellation_pending",
          version: { increment: 1 },
          cancelRequestedAt: cancelAt,
          cancellationReason: reason,
          nextReconcileAt: new Date(cancelAt.valueOf() + 60_000),
        },
      });
      const cancelledAt = new Date(now.valueOf() + 3_000),
        cancellation = {
          status: "cancelled",
          version: { increment: 1 },
          nextReconcileAt: null,
          cancellationProtocol: `cancel-protocol-${token}`,
          cancelledAt,
        } as const;
      await assert.rejects(
        db.posFiscalDocument.update({
          where: { id: documentId },
          data: cancellation,
        }),
        /requires cancellation artifact/,
      );
      await db.$transaction(async (tx) => {
        await tx.posFiscalArtifact.create({
          data: {
            id: `fiscal-cancel-${token}`,
            documentId,
            type: "cancellation_protocol",
            providerArtifactId: `provider-cancel-${token}`,
            storageKey: `fiscal/${compact}/cancel.json`,
            mimeType: "application/json",
            sizeBytes: 96,
            sha256: "c".repeat(64),
          },
        });
        await tx.posFiscalDocument.update({
          where: { id: documentId },
          data: cancellation,
        });
      });
      assert.equal(
        (
          await db.posFiscalDocument.findUniqueOrThrow({
            where: { id: documentId },
          })
        ).status,
        "cancelled",
      );
      await assert.rejects(
        db.posFiscalArtifact.delete({ where: { id: `fiscal-xml-${token}` } }),
        /immutable/,
      );

      for (const [environment, numberingOwner, expected] of [
        ["production", "provider", /external homologation gate/],
        ["homologation", "local", /local fiscal numbering is not enabled/],
      ] as const) {
        const blockedId = `blocked-${environment}-${numberingOwner}-${token}`;
        await db.posFiscalProfileVersion.create({
          data: {
            id: blockedId,
            branchId: branch.id,
            connectorId: connector.id,
            credentialRef: credential.id,
            version: environment === "production" ? 2 : 3,
            status: "draft",
            documentModel: "nfe",
            environment,
            uf: "SC",
            taxRegime: "simples_nacional",
            schemaVersion: "fixture-1",
            provider,
            numberingOwner,
            ...(numberingOwner === "local" ? { series: 1, nextNumber: 1 } : {}),
            policySnapshot: { fixture: true },
            policyDigest: digest,
            createdBy: operator.userId,
          },
        });
        await assert.rejects(
          db.posFiscalProfileVersion.update({
            where: { id: blockedId },
            data: {
              status: "active",
              effectiveFrom: now,
              activatedBy: operator.userId,
              activatedAt: now,
            },
          }),
          expected,
        );
      }
    } finally {
      await db.$disconnect();
    }
  },
);

test(
  "commit fiscal prepara snapshot, tentativa e outbox atomicamente em homologação",
  { skip: !connectionString },
  async () => {
    const db = client();
    const token = randomUUID();
    const compact = token.replaceAll("-", "");
    const provider = `fiscal_queue_${compact}`;
    const policy = {
      saleCommitMode: "queue",
      requiredProductFields: ["ncm", "origin", "gtin"],
      taxRules: { defaultCfop: "5102", defaultCsosn: "102" },
    };
    const policyDigest = createHash("sha256").update(canonicalPosJson(policy), "utf8").digest("hex");
    const now = new Date();
    try {
      const role = await db.tenantRole.create({
        data: { key: `fiscal-queue-${compact}`, name: "Operador fiscal enfileiramento", permissions: ["pdv.write"] },
      });
      const branch = await db.branch.create({
        data: {
          code: `PGFQ${compact}`,
          name: "Filial fiscal queue",
          legalName: "Filial fiscal queue Ltda",
          document: `PGFQDOC${compact}`,
          state: "SC",
          settings: { create: { fiscalEnvironment: "homologation", taxRegime: "simples_nacional" } },
        },
      });
      const register = await db.posRegister.create({
        data: { branchId: branch.id, code: `PGFQREG${compact}`, name: "Caixa fiscal queue" },
      });
      const operator = await db.tenantUserProfile.create({
        data: {
          userId: `pg-fiscal-queue-${token}`,
          roleId: role.id,
          displayName: "Operador fiscal queue",
          email: `pg-fiscal-queue-${compact}@example.invalid`,
          activeBranchId: branch.id,
        },
      });
      await db.branchUserAccess.create({ data: { branchId: branch.id, userProfileId: operator.id, canSell: true } });
      await db.posRegisterAccess.create({ data: { registerId: register.id, userProfileId: operator.id, active: true, canSell: true } });
      const terminal = await db.posTerminal.create({ data: {
        id: `fiscal-queue-terminal-${token}`,
        registerId: register.id,
        code: `PGFQTERM${compact}`,
        name: "Terminal fiscal queue",
        status: "online",
        tokenHash: `hmac-sha256:v1:${policyDigest}`,
        tokenIssuedAt: now,
        tokenExpiresAt: new Date(now.valueOf() + 3_600_000),
        credentialVersion: 1,
        pairedAt: now,
        lastSeenAt: now,
        appVersion: "test",
      } });
      const session = await db.cashRegisterSession.create({
        data: {
          number: `PG-FISCAL-QUEUE-${token}`,
          registerName: register.name,
          status: "open",
          openingAmount: 0,
          openingAmountCents: 0,
          openedBy: operator.displayName,
          registerId: register.id,
          operatorProfileId: operator.id,
        },
      });
      await db.integrationProvider.create({
        data: {
          id: provider,
          family: "fiscal",
          label: "Provider fiscal queue",
          description: "Fixture de homologação sem adaptador externo",
          recipientType: "none",
          authType: "api_key",
          capabilities: { fiscal: true },
          credentialSchema: {},
        },
      });
      const credential = await db.integrationCredential.create({
        data: {
          id: `fiscal-queue-credential-${token}`,
          providerId: provider,
          label: "Credencial fiscal queue",
          enabled: true,
          sandbox: true,
          config: { sandbox: true },
        },
      });
      const connector = await db.posConnector.create({
        data: {
          id: `fiscal-queue-connector-${token}`,
          branchId: branch.id,
          registerId: register.id,
          type: "fiscal_nfce",
          provider,
          credentialRef: credential.id,
          status: "active",
        },
      });
      const profileId = `fiscal-queue-profile-${token}`;
      await db.posFiscalProfileVersion.create({
        data: {
          id: profileId,
          branchId: branch.id,
          connectorId: connector.id,
          credentialRef: credential.id,
          version: 1,
          status: "draft",
          documentModel: "nfce",
          environment: "homologation",
          uf: "SC",
          taxRegime: "simples_nacional",
          schemaVersion: "fixture-queue-1",
          provider,
          numberingOwner: "provider",
          policySnapshot: policy,
          policyDigest,
          createdBy: operator.userId,
        },
      });
      await db.posFiscalProfileVersion.update({
        where: { id: profileId },
        data: {
          status: "active",
          effectiveFrom: new Date(now.valueOf() - 1_000),
          activatedBy: operator.userId,
          activatedAt: now,
        },
      });
      const product = await db.product.create({
        data: {
          name: "Produto fiscal íntegro",
          slug: `produto-fiscal-${compact}`,
          sku: `PGFQSKU${compact}`,
          category: "Fiscal",
          unit: "UN",
          gtin: "7894900011517",
          ncm: "22021000",
          origin: "0",
          csosn: "102",
        },
      });
      const sale = await createAuthoritativeFiscalCashSale(db, {
        token,
        saleNumber: `PG-FISCAL-QUEUE-SALE-${token}`,
        saleDraftId: `fiscal-queue-sale-${token}`,
        requestHash: policyDigest,
        branchId: branch.id,
        registerId: register.id,
        registerName: register.name,
        sessionId: session.id,
        operatorId: operator.id,
        operatorName: operator.displayName,
        terminalId: terminal.id,
        product,
        now,
      });
      const correlationId = randomUUID();
      const result = await db.$transaction((tx) => queuePosFiscalIssuanceForSale(tx, {
        saleId: sale.id,
        branchId: branch.id,
        registerId: register.id,
        sessionId: session.id,
        operatorProfileId: operator.id,
        actorUserId: operator.userId,
        actorName: operator.displayName,
        correlationId,
        now,
      }));
      assert.equal(result.state, "queued");
      assert.ok(result.documentId);
      const document = await db.posFiscalDocument.findUniqueOrThrow({
        where: { id: result.documentId! },
        include: { attempts: { include: { outbox: true } }, stateEvents: true },
      });
      assert.equal(document.status, "queued");
      assert.equal(document.version, 0);
      assert.equal(document.snapshotHash.length, 64);
      assert.equal(document.profileId, profileId);
      assert.equal(document.attempts.length, 1);
      assert.equal(document.attempts[0].operation, "issue");
      assert.equal(document.attempts[0].outbox?.state, "pending");
      assert.equal(document.stateEvents[0].toState, "queued");
      const snapshot = document.saleSnapshot as Record<string, unknown>;
      assert.equal(snapshot.saleId, sale.id);
      assert.equal(snapshot.totalCents, 1_234);
      assert.equal(((snapshot.items as Array<{ fiscal: { ncm: string } }>)[0]).fiscal.ncm, "22021000");
      assert.equal(await db.tenantAuditEvent.count({ where: { action: "pos.fiscal.document.queued", entityId: document.id, correlationId } }), 1);

      const replay = await db.$transaction((tx) => queuePosFiscalIssuanceForSale(tx, {
        saleId: sale.id,
        branchId: branch.id,
        registerId: register.id,
        sessionId: session.id,
        operatorProfileId: operator.id,
        actorUserId: operator.userId,
        actorName: operator.displayName,
        correlationId,
        now,
      }));
      assert.deepEqual(replay, { state: "replayed", documentId: document.id, profileId });
      assert.equal(await db.posFiscalDocument.count({ where: { saleId: sale.id } }), 1);

      const claimed = await claimPosFiscalOutbox(db, { workerId: `fiscal-worker-${compact}`, limit: 100, leaseSeconds: 60, now });
      let command = claimed.claimed.find((candidate) => candidate.document.id === document.id);
      assert.ok(command, "o outbox recém-criado deve ser reivindicado");
      assert.equal(command.operation, "issue");
      assert.equal(command.document.snapshotHash, document.snapshotHash);
      assert.equal(command.document.credentialRef, credential.id);
      const retry = await completePosFiscalOutbox(db, {
        attemptId: command.attemptId,
        claimToken: command.claimToken,
        result: { kind: "known_failure", retryable: true, failureCode: "provider_temporarily_unavailable", failureMessage: "Falha conhecida antes de qualquer efeito externo" },
      }, new Date(now.valueOf() + 250));
      assert.equal(retry.retryScheduled, true);
      assert.equal(retry.document.status, "queued");
      assert.equal(retry.attempt.state, "retry");
      const reclaimed = await claimPosFiscalOutbox(db, { workerId: `fiscal-worker-${compact}`, limit: 100, leaseSeconds: 60, now: new Date(now.valueOf() + 2_000) });
      command = reclaimed.claimed.find((candidate) => candidate.document.id === document.id);
      assert.ok(command, "o retry conhecido deve poder ser reivindicado novamente");
      const completion = {
        attemptId: command.attemptId,
        claimToken: command.claimToken,
        result: {
          kind: "result" as const,
          provider,
          reference: `provider-document-${token}`,
          state: "authorized" as const,
          accessKey: nfeAccessKey(token),
          protocol: `authorization-protocol-${token}`,
          rejectionCode: null,
          rejectionMessage: null,
          providerSequence: BigInt(1),
          occurredAt: new Date(now.valueOf() + 1_000),
          totalCents: 1_234,
          currency: "BRL" as const,
          artifacts: [{
            type: "authorized_xml" as const,
            providerArtifactId: `provider-authorized-xml-${token}`,
            storageKey: `fiscal/${compact}/worker-authorized.xml`,
            mimeType: "application/xml" as const,
            sizeBytes: 256,
            sha256: createHash("sha256").update(`authorized-xml:${token}`).digest("hex"),
            encryptionKeyId: `fiscal-key-${token}`,
            retentionUntil: new Date("2032-08-29T00:00:00.000Z"),
          }],
        },
      };
      const completed = await completePosFiscalOutbox(db, completion, new Date(now.valueOf() + 2_000));
      assert.equal(completed.document.status, "authorized");
      assert.equal(completed.document.version, 1);
      assert.equal(completed.attempt.state, "succeeded");
      assert.equal(completed.replayed, false);
      assert.equal(await db.posFiscalArtifact.count({ where: { documentId: document.id, type: "authorized_xml" } }), 1);
      assert.equal(await db.posFiscalDeliveryResult.count({ where: { documentId: document.id } }), 2);
      const completedReplay = await completePosFiscalOutbox(db, completion, new Date(now.valueOf() + 3_000));
      assert.equal(completedReplay.replayed, true);
      assert.equal(await db.posFiscalArtifact.count({ where: { documentId: document.id } }), 1);
      assert.equal(await db.posFiscalDeliveryResult.count({ where: { documentId: document.id } }), 2);

      const mismatchSale = await createAuthoritativeFiscalCashSale(db, {
        token: `mismatch-${token}`,
        saleNumber: `PG-FISCAL-MISMATCH-SALE-${token}`,
        saleDraftId: `fiscal-mismatch-sale-${token}`,
        requestHash: policyDigest,
        branchId: branch.id,
        registerId: register.id,
        registerName: register.name,
        sessionId: session.id,
        operatorId: operator.id,
        operatorName: operator.displayName,
        terminalId: terminal.id,
        product,
        now,
      });
      const mismatchQueued = await db.$transaction((tx) => queuePosFiscalIssuanceForSale(tx, {
        saleId: mismatchSale.id,
        branchId: branch.id,
        registerId: register.id,
        sessionId: session.id,
        operatorProfileId: operator.id,
        actorUserId: operator.userId,
        actorName: operator.displayName,
        correlationId: `fiscal-worker-mismatch-${token}`,
        now: new Date(now.valueOf() + 3_100),
      }));
      assert.equal(mismatchQueued.state, "queued");
      const mismatchClaim = await claimPosFiscalOutbox(db, { workerId: `fiscal-worker-mismatch-${compact}`, limit: 100, leaseSeconds: 60, now: new Date(now.valueOf() + 3_200) });
      const mismatchCommand = mismatchClaim.claimed.find((candidate) => candidate.document.id === mismatchQueued.documentId);
      assert.ok(mismatchCommand, "o documento divergente deve ser reivindicado");
      const mismatchCompletion = await completePosFiscalOutbox(db, {
        attemptId: mismatchCommand.attemptId,
        claimToken: mismatchCommand.claimToken,
        result: {
          kind: "result",
          provider,
          reference: `provider-mismatch-${token}`,
          state: "authorized",
          accessKey: nfeAccessKey(`mismatch-${token}`),
          protocol: `mismatch-protocol-${token}`,
          rejectionCode: null,
          rejectionMessage: null,
          providerSequence: BigInt(1),
          occurredAt: new Date(now.valueOf() + 3_300),
          totalCents: 999,
          currency: "BRL",
          artifacts: [{ type: "authorized_xml", providerArtifactId: `provider-mismatch-xml-${token}`, storageKey: `fiscal/${compact}/mismatch.xml`, mimeType: "application/xml", sizeBytes: 128, sha256: createHash("sha256").update(`mismatch:${token}`).digest("hex"), encryptionKeyId: `fiscal-key-${token}`, retentionUntil: new Date("2032-08-29T00:00:00.000Z") }],
        },
      }, new Date(now.valueOf() + 3_400));
      assert.equal(mismatchCompletion.document.status, "manual_review");
      assert.equal(mismatchCompletion.attempt.state, "failed");
      assert.equal(mismatchCompletion.superseded, true);
      assert.equal((await db.posFiscalOutbox.findUniqueOrThrow({ where: { attemptId: mismatchCommand.attemptId } })).state, "completed");
      assert.equal(await db.posFiscalArtifact.count({ where: { documentId: mismatchQueued.documentId! } }), 0);
      assert.equal(await db.posFiscalIntegrityIncident.count({ where: { documentId: mismatchQueued.documentId!, kind: "snapshot_mismatch", status: "open", productionBlocking: true } }), 1);
      assert.equal(await db.posFiscalDeliveryResult.count({ where: { attemptId: mismatchCommand.attemptId } }), 1);

      const cancelRequestedAt = new Date(now.valueOf() + 4_000);
      const cancelAttemptId = `fiscal-cancel-attempt-${token}`;
      await db.$transaction(async (tx) => {
        await tx.posFiscalDocument.update({
          where: { id: document.id },
          data: {
            status: "cancellation_pending",
            version: { increment: 1 },
            cancelRequestedAt,
            cancellationReason: "Cancelamento fiscal de teste com motivo suficiente",
            nextReconcileAt: cancelRequestedAt,
          },
        });
        await tx.posFiscalAttempt.create({
          data: {
            id: cancelAttemptId,
            documentId: document.id,
            sequence: 2,
            operation: "cancel",
            operationKey: `fiscal-cancel-operation-${token}`,
            requestHash: policyDigest,
            providerIdempotencyKey: `fiscal-cancel-provider-${token}`,
            reason: "Cancelamento fiscal de teste com motivo suficiente",
            outbox: { create: { nextAttemptAt: cancelRequestedAt } },
          },
        });
        await tx.posFiscalStateEvent.create({
          data: {
            documentId: document.id,
            attemptId: cancelAttemptId,
            eventKey: `fiscal-cancellation-pending-${token}`,
            source: "api",
            sourceId: `cancel-request-${token}`,
            fromState: "authorized",
            toState: "cancellation_pending",
            resultingVersion: 2,
            evidenceHash: policyDigest,
          },
        });
      });
      const cancelClaim = await claimPosFiscalOutbox(db, { workerId: `fiscal-worker-${compact}`, limit: 100, leaseSeconds: 15, now: new Date(now.valueOf() + 5_000) });
      assert.ok(cancelClaim.claimed.some((candidate) => candidate.attemptId === cancelAttemptId));
      const recovered = await maintainPosFiscalPersistence(db, { now: new Date(now.valueOf() + 21_000), batchSize: 100, correlationId: `fiscal-maintenance-${token}` });
      assert.ok(recovered.recoveredLeases >= 1);
      const uncertainCancellation = await db.posFiscalDocument.findUniqueOrThrow({ where: { id: document.id } });
      assert.equal(uncertainCancellation.status, "cancellation_pending");
      assert.equal((await db.posFiscalAttempt.findUniqueOrThrow({ where: { id: cancelAttemptId } })).state, "unknown");
      const scheduled = await maintainPosFiscalPersistence(db, { now: new Date(now.valueOf() + 82_000), batchSize: 100, correlationId: `fiscal-maintenance-query-${token}` });
      assert.ok(scheduled.scheduledQueries >= 1);
      assert.equal(await db.posFiscalAttempt.count({ where: { documentId: document.id, operation: "query", state: "queued", outbox: { state: "pending" } } }), 1);

      const callbackOccurredAt = new Date(now.valueOf() + 83_000);
      const callbackEventId = `fiscal-callback-cancel-${token}`;
      const callbackPayloadHash = createHash("sha256").update(`callback:${callbackEventId}`).digest("hex");
      const callbackInput = {
        documentId: document.id,
        provider,
        reference: `provider-document-${token}`,
        state: "cancelled" as const,
        accessKey: nfeAccessKey(token),
        protocol: `cancellation-protocol-${token}`,
        rejectionCode: null,
        rejectionMessage: null,
        providerSequence: BigInt(2),
        occurredAt: callbackOccurredAt,
        totalCents: 1_234,
        currency: "BRL" as const,
        artifacts: [{
          type: "cancellation_protocol" as const,
          providerArtifactId: `provider-cancellation-${token}`,
          storageKey: `fiscal/${compact}/callback-cancellation.json`,
          mimeType: "application/json" as const,
          sizeBytes: 192,
          sha256: createHash("sha256").update(`cancellation:${token}`).digest("hex"),
          encryptionKeyId: `fiscal-key-${token}`,
          retentionUntil: new Date("2032-08-29T00:00:00.000Z"),
        }],
      };
      const callback = await acceptPosFiscalCallback(db, provider, callbackEventId, `fiscal-key-${token}`, callbackPayloadHash, callbackInput);
      assert.equal(callback.applied, true);
      assert.equal(callback.state, "cancelled");
      assert.equal(callback.version, 5);
      assert.equal(await db.posFiscalArtifact.count({ where: { documentId: document.id, type: "cancellation_protocol" } }), 1);
      const callbackReplay = await acceptPosFiscalCallback(db, provider, callbackEventId, `fiscal-key-${token}`, callbackPayloadHash, callbackInput);
      assert.equal(callbackReplay.duplicate, true);
      await assert.rejects(acceptPosFiscalCallback(db, provider, callbackEventId, `fiscal-key-${token}`, "d".repeat(64), callbackInput), /payload divergente/);

      const mismatchEventId = `fiscal-callback-mismatch-${token}`;
      const mismatch = await acceptPosFiscalCallback(db, provider, mismatchEventId, `fiscal-key-${token}`, createHash("sha256").update(mismatchEventId).digest("hex"), { ...callbackInput, totalCents: 999, providerSequence: BigInt(3), artifacts: [] });
      assert.equal(mismatch.result, "incident_opened");
      assert.equal(mismatch.incident?.productionBlocking, true);
      assert.equal((await db.posFiscalIntegrityIncident.findUniqueOrThrow({ where: { id: mismatch.incident!.id } })).status, "open");
    } finally {
      await db.$disconnect();
    }
  },
);

function client() {
  if (!connectionString) throw new Error("POS_TEST_DATABASE_URL não definida");
  return new PrismaClient({ adapter: new PrismaPg({ connectionString }) });
}

async function createAuthoritativeFiscalCashSale(db: PrismaClient, input: {
  token: string;
  saleNumber: string;
  saleDraftId: string;
  requestHash: string;
  branchId: number;
  registerId: number;
  registerName: string;
  sessionId: number;
  operatorId: number;
  operatorName: string;
  terminalId: string;
  product: { id: number; name: string; sku: string | null; gtin: string | null };
  now: Date;
}) {
  const planId = `fiscal-plan-${input.token}`;
  const expiresAt = new Date(input.now.valueOf() + 300_000);
  await db.$transaction(async (tx) => {
    const draft = await tx.posHeldSale.create({ data: {
      id: input.saleDraftId,
      registerId: input.registerId,
      sessionId: input.sessionId,
      operatorProfileId: input.operatorId,
      status: "draft",
      idempotencyKey: `fiscal-draft-${input.token}`,
      requestHash: input.requestHash,
      items: { create: { productId: input.product.id, quantity: 1, unitPriceCents: 1_234, discountCents: 0 } },
    }, include: { items: true } });
    await tx.posPaymentPlan.create({ data: {
      id: planId,
      branchId: input.branchId,
      registerId: input.registerId,
      sessionId: input.sessionId,
      operatorProfileId: input.operatorId,
      terminalId: input.terminalId,
      saleDraftId: input.saleDraftId,
      draftRevision: draft.revision,
      draftRequestHash: input.requestHash,
      draftStatus: draft.status,
      quoteHash: input.requestHash,
      evaluatedAt: input.now,
      expiresAt,
      totalCents: 1_234,
      idempotencyKey: `fiscal-quote-${input.token}`,
      requestHash: input.requestHash,
    } });
    await tx.posPaymentPlanQuoteLine.create({ data: {
      planId,
      lineIndex: 0,
      heldSaleItemId: draft.items[0].id,
      productId: input.product.id,
      quantity: 1,
      unitPriceCents: 1_234,
      grossCents: 1_234,
      baseDiscountCents: 0,
      orderDiscountCents: 0,
      promotionDiscountCents: 0,
      surchargeCents: 0,
      totalCents: 1_234,
    } });
    await tx.posPaymentPlanOperation.create({ data: {
      planId,
      action: "quote",
      expectedVersion: -1,
      resultingVersion: 0,
      resultingState: "quoted",
      idempotencyKey: `fiscal-quote-${input.token}`,
      requestHash: input.requestHash,
    } });
  });
  await db.$transaction(async (tx) => {
    await tx.posPaymentPlanSlot.create({ data: { planId, paymentIndex: 0, method: "cash", amountCents: 1_234, installments: 1, proofKind: "cash" } });
    await tx.posPaymentPlanOperation.create({ data: {
      planId,
      action: "activate",
      expectedVersion: 0,
      resultingVersion: 1,
      resultingState: "active",
      idempotencyKey: `fiscal-activate-${input.token}`,
      requestHash: input.requestHash,
    } });
    await tx.posPaymentPlan.update({ where: { id: planId }, data: { state: "active", version: 1 } });
  });
  return db.$transaction(async (tx) => {
    const sale = await tx.sale.create({ data: {
      saleNumber: input.saleNumber,
      customer: "Consumidor final",
      seller: input.operatorName,
      cashRegister: input.registerName,
      paymentMethod: "cash",
      total: 12.34,
      branchId: input.branchId,
      sessionId: input.sessionId,
      operatorProfileId: input.operatorId,
      status: "completed",
      subtotalCents: 1_234,
      discountCents: 0,
      surchargeCents: 0,
      totalCents: 1_234,
      changeCents: 0,
      idempotencyKey: input.saleDraftId,
      requestHash: input.requestHash,
      items: { create: {
        productId: input.product.id,
        productName: input.product.name,
        skuSnapshot: input.product.sku,
        gtinSnapshot: input.product.gtin,
        unit: "UN",
        quantity: 1,
        unitPrice: 12.34,
        total: 12.34,
        unitPriceCents: 1_234,
        grossCents: 1_234,
        discountCents: 0,
        surchargeCents: 0,
        totalCents: 1_234,
      } },
      payments: { create: {
        processingSessionId: input.sessionId,
        paymentPlanId: planId,
        paymentIndex: 0,
        type: "payment",
        method: "cash",
        status: "captured",
        amountCents: 1_234,
        tenderedCents: 1_234,
        changeCents: 0,
        provider: "cash",
        installments: 1,
        idempotencyKey: `fiscal-payment-${input.token}`,
        capturedAt: input.now,
      } },
    } });
    await tx.posPaymentPlanOperation.create({ data: {
      planId,
      action: "consume",
      expectedVersion: 1,
      resultingVersion: 2,
      resultingState: "consumed",
      idempotencyKey: `fiscal-consume-${input.token}`,
      requestHash: input.requestHash,
      saleId: sale.id,
    } });
    await tx.posPaymentPlan.update({ where: { id: planId }, data: { state: "consumed", version: 2, consumedSaleId: sale.id } });
    return sale;
  }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
}

function nfeAccessKey(seed: string) {
  const base = [...createHash("sha256").update(`nfe-access:${seed}`).digest("hex")]
    .map((character) => String(Number.parseInt(character, 16) % 10))
    .join("")
    .slice(0, 43);
  let weight = 2;
  let sum = 0;
  for (let index = base.length - 1; index >= 0; index -= 1) {
    sum += Number(base[index]) * weight;
    weight = weight === 9 ? 2 : weight + 1;
  }
  const remainder = sum % 11;
  return `${base}${remainder === 0 || remainder === 1 ? 0 : 11 - remainder}`;
}
