import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import test from "node:test";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../generated/tenant/client";

const connectionString = process.env.POS_TEST_DATABASE_URL;

test("320000 mantém a referência manual legada selada como histórico", { skip: !connectionString }, async () => {
  const db = client(), token = randomUUID(), compact = token.replaceAll("-", ""), hash = createHash("sha256").update(token).digest("hex");
  try {
    const role = await db.tenantRole.findFirstOrThrow({ where: { active: true } });
    const branch = await db.branch.create({ data: { code: `PGMAN${compact}`, name: "Filial manual isolada", legalName: "Filial manual isolada Ltda", document: `PGMANDOC${compact}` } });
    const register = await db.posRegister.create({ data: { branchId: branch.id, code: `PGMANREG${compact}`, name: "Caixa manual isolado" } });
    const profile = await db.tenantUserProfile.create({ data: { userId: `pg-manual-${token}`, roleId: role.id, displayName: "Operador manual isolado", email: `pg-manual-${compact}@example.invalid`, activeBranchId: branch.id } });
    const session = await db.cashRegisterSession.create({ data: { number: `PG-MANUAL-${token}`, registerName: register.name, status: "open", openingAmount: 0, openingAmountCents: 0, openedBy: profile.displayName, registerId: register.id, operatorProfileId: profile.id } });
    const saleDraftId = `draft-${token}`;
    const approval = await db.posApproval.create({ data: {
      branchId: branch.id, action: "payment.manual_reference", entityType: "sale_draft", entityId: saleDraftId, status: "approved",
      requesterId: profile.userId, requesterName: profile.displayName, approverId: `approver-${token}`, approverName: "Supervisor PostgreSQL",
      reason: "Confirmação independente PostgreSQL", context: {}, correlationId: token, expiresAt: new Date(Date.now() + 60_000), decidedAt: new Date(),
    } });

    await assert.rejects(db.posManualPaymentReference.create({ data: {
      id: `manual-${token}`, branchId: branch.id, registerId: register.id, sessionId: session.id, requesterProfileId: profile.id,
      requesterUserId: profile.userId, saleDraftId, quoteHash: hash, paymentIndex: 0, method: "credit", amountCents: 100,
      provider: "cielo", reference: `AUTH-${token}`, referenceHash: hash, referenceLastFour: compact.slice(-4), occurredAt: new Date(),
      approvalId: approval.id, idempotencyKey: `manual-${token}`, requestHash: hash,
    } }), /Code: `42501`[\s\S]*sealed history-only/);
    assert.equal(await db.posManualPaymentReference.count({ where: { saleDraftId } }), 0);
  } finally {
    await db.$disconnect();
  }
});

function client() {
  if (!connectionString) throw new Error("POS_TEST_DATABASE_URL ausente");
  return new PrismaClient({ adapter: new PrismaPg({ connectionString }) });
}
