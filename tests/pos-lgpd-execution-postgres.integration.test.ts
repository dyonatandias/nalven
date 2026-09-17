import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../generated/tenant/client";
import {
  activatePosLgpdRetentionPolicy,
  advancePosLgpdSubjectRequest,
  createPosLgpdLegalHold,
  createPosLgpdSubjectRequest,
  decidePosLgpdSubjectRequest,
  hashPosLgpdPayload,
  planPosLgpdExecution,
  proposePosLgpdDecision,
  registerPosLgpdInventoryObject,
  releasePosLgpdLegalHold,
} from "../lib/erp/pos-lgpd-execution";

const connectionString = process.env.POS_TEST_DATABASE_URL;
const digest = (value: string) => hashPosLgpdPayload({ value });

test("PostgreSQL executa DSAR governado, bloqueia hold/adapter e preserva ledger/evidência", { skip: !connectionString, timeout: 90_000 }, async () => {
  process.env.POS_LGPD_TOKEN_PEPPER = "postgres-integration-lgpd-pepper-with-at-least-thirty-two-bytes";
  process.env.POS_LGPD_TOKEN_KEY_ID = "pg-lgpd-key-v1";
  const first = client();
  const second = client();
  const rawToken = randomUUID().replaceAll("-", "").toLowerCase();
  const token = [...rawToken].map((character) => String.fromCharCode(97 + Number.parseInt(character, 16))).join("");
  const now = new Date("2026-08-29T12:00:00.000Z");
  const subjectInput = digest(`subject-${token}`);
  try {
    const policy = await first.posLgpdRetentionPolicy.create({ data: {
      id: `lgpd-policy-${token}`,
      version: 900_000 + Number.parseInt(rawToken.slice(0, 5), 16),
      policyHash: digest(`policy-manifest-${token}`),
      effectiveFrom: new Date("2026-01-01T00:00:00.000Z"),
      proposedBy: `privacy-maker-${token}`,
    } });
    const activated = await activatePosLgpdRetentionPolicy(first, { policyId: policy.id, legalApprovalRef: `legal-approval-${token}`, homologatedBy: `privacy-checker-${token}`, stepUpProofHash: digest(`policy-step-up-${token}`), now });
    assert.equal(activated.policy.status, "active");
    assert.equal((await activatePosLgpdRetentionPolicy(first, { policyId: policy.id, legalApprovalRef: `legal-approval-${token}`, homologatedBy: `privacy-checker-${token}`, stepUpProofHash: digest(`policy-step-up-${token}`), now })).replayed, true);

    const createInput = {
      idempotencyKeyHash: digest(`request-idempotency-${token}`),
      subjectTokenHash: subjectInput,
      contactTokenHash: digest(`contact-${token}`),
      requestType: "deletion" as const,
      scope: { categories: ["pos.sales"], schemaVersion: 1 },
      dueAt: new Date("2026-09-15T00:00:00.000Z"),
      createdBy: `privacy-operator-${token}`,
      now,
      correlationId: `correlation-request-${token}`,
    };
    const raced = await Promise.all([createPosLgpdSubjectRequest(first, createInput), createPosLgpdSubjectRequest(second, createInput)]);
    assert.equal(new Set(raced.map((item) => item.request.id)).size, 1);
    const requestId = raced[0]!.request.id;
    let request = await first.posLgpdSubjectRequest.findUniqueOrThrow({ where: { id: requestId } });
    assert.notEqual(request.subjectTokenHash, subjectInput);
    assert.notEqual(request.idempotencyKeyHash, createInput.idempotencyKeyHash);
    assert.equal(request.tokenKeyId, "pg-lgpd-key-v1");
    assert.equal(request.tokenVersion, 1);
    assert.equal(JSON.stringify(request).includes(createInput.contactTokenHash), false);

    request = await advancePosLgpdSubjectRequest(first, { requestId, expectedVersion: request.version, toState: "identity_pending", actorId: `privacy-operator-${token}`, reasonCode: "identity.pending", now: new Date("2026-08-29T12:01:00.000Z") });
    request = await advancePosLgpdSubjectRequest(first, { requestId, expectedVersion: request.version, toState: "verified", actorId: `privacy-verifier-${token}`, reasonCode: "identity.verified", now: new Date("2026-08-29T12:02:00.000Z") });
    request = await advancePosLgpdSubjectRequest(first, { requestId, expectedVersion: request.version, toState: "scoping", actorId: `privacy-operator-${token}`, reasonCode: "scope.completed", now: new Date("2026-08-29T12:03:00.000Z") });
    request = await proposePosLgpdDecision(first, { requestId, expectedVersion: request.version, proposedBy: `privacy-maker-${token}`, reasonCode: "deletion.eligible", now: new Date("2026-08-29T12:04:00.000Z") });
    await assert.rejects(decidePosLgpdSubjectRequest(first, { requestId, expectedVersion: request.version, decision: "approved", approvedBy: `privacy-maker-${token}`, reasonCode: "deletion.approved", stepUpProofHash: digest(`decision-step-up-${token}`), now: new Date("2026-08-29T12:05:00.000Z") }), /checker distinto/);
    request = await decidePosLgpdSubjectRequest(first, { requestId, expectedVersion: request.version, decision: "approved", approvedBy: `privacy-checker-${token}`, reasonCode: "deletion.approved", stepUpProofHash: digest(`decision-step-up-${token}`), now: new Date("2026-08-29T12:05:00.000Z") });
    assert.equal(request.state, "approved");

    const inventory = await registerPosLgpdInventoryObject(first, {
      objectType: "pos.sale",
      objectKeyHash: digest(`sale-id-${token}`),
      subjectTokenHash: subjectInput,
      dataCategory: "pos.transaction",
      sourceVersion: 1,
      manifest: { schemaVersion: 1, fields: ["saleId", "customerToken"] },
      retentionPolicyId: policy.id,
      actorId: `inventory-producer-${token}`,
      now: new Date("2026-08-29T12:06:00.000Z"),
    });
    assert.notEqual(inventory.inventoryObject.objectKeyHash, digest(`sale-id-${token}`));
    assert.equal(inventory.inventoryObject.subjectTokenHash, request.subjectTokenHash);

    const holdInput = {
      idempotencyKeyHash: digest(`hold-idempotency-${token}`),
      subjectTokenHash: subjectInput,
      objectType: "pos.sale",
      objectKeyHash: digest(`sale-id-${token}`),
      dataCategory: "pos.transaction",
      reasonCode: "litigation.active",
      legalReferenceHash: digest(`legal-reference-${token}`),
      proposedBy: `legal-maker-${token}`,
      approvedBy: `legal-checker-${token}`,
      stepUpProofHash: digest(`hold-step-up-${token}`),
      startsAt: new Date("2026-01-01T00:00:00.000Z"),
      correlationId: `correlation-hold-${token}`,
    };
    const hold = await createPosLgpdLegalHold(first, holdInput);
    assert.equal(hold.hold.state, "active");
    assert.equal((await createPosLgpdLegalHold(first, holdInput)).replayed, true);

    const planInput = {
      requestId,
      expectedVersion: request.version,
      action: "delete" as const,
      inventoryObjectId: inventory.inventoryObject.id,
      retentionPolicyId: policy.id,
      idempotencyKeyHash: digest(`job-idempotency-${token}`),
      actorId: `privacy-operator-${token}`,
      now: new Date("2026-08-29T12:07:00.000Z"),
      correlationId: `correlation-job-${token}`,
    };
    const planned = await planPosLgpdExecution(first, planInput);
    assert.equal(planned.job.state, "blocked");
    assert.equal(planned.job.blockReason, "legal_hold");
    assert.equal(planned.job.adapterId, null);
    assert.equal(planned.job.outbox?.state, "blocked");
    assert.equal((await planPosLgpdExecution(first, planInput)).replayed, true);

    await assert.rejects(first.posLgpdExecutionOutbox.update({ where: { jobId: planned.job.id }, data: { state: "pending", nextAttemptAt: new Date() } }), /blocked LGPD job/);
    await assert.rejects(first.posLgpdExecutionJob.update({ where: { id: planned.job.id }, data: { state: "ready", adapterId: "reviewed-domain-adapter" } }), /legal hold blocks/);

    const released = await releasePosLgpdLegalHold(first, { holdId: hold.hold.id, proposedBy: `release-maker-${token}`, releasedBy: `release-checker-${token}`, stepUpProofHash: digest(`release-step-up-${token}`), reasonCode: "litigation.closed", now: new Date("2026-08-29T12:08:00.000Z") });
    assert.equal(released.hold.state, "released");
    await first.posLgpdExecutionJob.update({ where: { id: planned.job.id }, data: { state: "ready", adapterId: "reviewed-domain-adapter", blockReason: null } });
    await first.posLgpdExecutionOutbox.update({ where: { jobId: planned.job.id }, data: { state: "pending", nextAttemptAt: new Date("2026-08-29T12:09:00.000Z") } });

    const ledger = await first.posLgpdRequestStateLedger.findMany({ where: { requestId }, orderBy: { sequence: "asc" } });
    assert.equal(ledger.length, 7);
    for (let index = 1; index < ledger.length; index += 1) assert.equal(ledger[index]!.priorHash, ledger[index - 1]!.eventHash);
    await assert.rejects(first.posLgpdRequestStateLedger.update({ where: { id: ledger[0]!.id }, data: { reasonCode: "tamper.attempt" } }), /append-only/);
    const evidence = await first.posLgpdEvidence.findFirstOrThrow({ where: { aggregateType: "job", aggregateId: planned.job.id } });
    await assert.rejects(first.posLgpdEvidence.delete({ where: { id: evidence.id } }), /append-only/);
    await assert.rejects(first.posLgpdRetentionPolicy.update({ where: { id: policy.id }, data: { policyHash: digest("mutated") } }), /immutable/);
    await assert.rejects(first.posLgpdInventoryObject.delete({ where: { id: inventory.inventoryObject.id } }), /cannot be deleted/);
    await assert.rejects(first.posLgpdSubjectRequest.update({ where: { id: requestId }, data: { state: "in_progress", version: { increment: 1 } } }), /ledger event in the same transaction/);

    const storedText = JSON.stringify(await first.$queryRaw<Array<Record<string, unknown>>>`SELECT request."id", request."subject_token_hash", request."contact_token_hash", object."object_key_hash", job."idempotency_key_hash" FROM "pos_lgpd_subject_requests" request LEFT JOIN "pos_lgpd_inventory_objects" object ON object."subject_token_hash" = request."subject_token_hash" LEFT JOIN "pos_lgpd_execution_jobs" job ON job."request_id" = request."id" WHERE request."id" = ${requestId}`);
    assert.equal(storedText.includes(subjectInput), false);
    assert.equal(storedText.includes(createInput.contactTokenHash), false);
    assert.doesNotMatch(storedText, /4111111111111111|529\.982\.247-25|@example\.com/);
  } finally {
    await Promise.all([first.$disconnect(), second.$disconnect()]);
  }
});

function client() {
  if (!connectionString) throw new Error("POS_TEST_DATABASE_URL não definida");
  return new PrismaClient({ adapter: new PrismaPg({ connectionString }) });
}
