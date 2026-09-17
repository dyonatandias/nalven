import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const root = fileURLToPath(new URL("..", import.meta.url));
const read = (path: string) => readFileSync(join(root, path), "utf8");
const schema = read("prisma/tenant/schema.prisma");
const migration = read(
  "prisma/tenant/migrations/20260829210000_pos_manual_payment_reference/migration.sql",
);
const integrityMigration = read(
  "prisma/tenant/migrations/20260829240000_pos_financial_kit_guards/migration.sql",
);
const orderClaimMigration = read(
  "prisma/tenant/migrations/20260829280000_pos_order_claim/migration.sql",
);
const manualRoute = read("app/api/erp/pdv/manual-payments/route.ts");
const saleRoute = read("app/api/erp/pdv/route.ts");
const paymentPlanDomain = read("lib/erp/pos-payment-plan.ts");
const approvalDomain = read("lib/erp/pos-approvals.ts");
const ui = read("components/erp/pdv-workspace.tsx");
const approvalUi = read("components/erp/pdv-approval-dialog.tsx");

test("ledger manual é contextual, único e imutável inclusive contra DELETE", () => {
  assert.match(schema, /model PosManualPaymentReference/);
  for (const field of [
    "branchId",
    "registerId",
    "sessionId",
    "requesterProfileId",
    "saleDraftId",
    "quoteHash",
    "paymentIndex",
    "method",
    "amountCents",
    "referenceHash",
    "approvalId",
    "consumedSalePaymentId",
  ])
    assert.match(schema, new RegExp(`\\b${field}\\b`));
  assert.match(
    migration,
    /UNIQUE INDEX "pos_manual_payment_references_external_reference_key"/,
  );
  assert.match(migration, /pos_manual_payment_references_pix_e2e_tenant_key/);
  assert.match(migration, /upper\("reference"\)[\s\S]*WHERE "method" = 'pix'/);
  assert.match(migration, /\^E\[0-9\]\{16\}\[A-Z0-9\]\{15\}\$/);
  assert.match(
    migration,
    /pos_manual_payment_references_provider_reference_tenant_key/,
  );
  assert.match(migration, /FOREIGN KEY \("session_id", "register_id"\)/);
  assert.match(migration, /BEFORE UPDATE OR DELETE/);
  assert.match(migration, /IF TG_OP = 'DELETE'/);
  assert.match(migration, /OLD\."status" <> 'pending'/);
  for (const field of [
    "installments",
    "revokeIdempotencyKey",
    "revokeRequestHash",
    "revokedAt",
    "revokedBy",
  ])
    assert.match(schema, new RegExp(`\\b${field}\\b`));
  assert.match(
    orderClaimMigration,
    /manual payment reference revocation requires independent rejected approval/,
  );
  assert.match(
    orderClaimMigration,
    /pos_manual_payment_references_revoke_idempotency_key_key/,
  );
  assert.match(
    orderClaimMigration,
    /pos_manual_payment_references_installments_check/,
  );
});

test("banco preserva pagamento e valida consumo manual contra venda e aprovação", () => {
  assert.match(
    schema,
    /sale\s+Sale\s+@relation\(fields: \[saleId\], references: \[id\], onDelete: Restrict\)/,
  );
  assert.match(integrityMigration, /protect_pos_sale_payment_history/);
  assert.match(
    integrityMigration,
    /BEFORE UPDATE OR DELETE ON "pos_sale_payments"/,
  );
  assert.match(
    integrityMigration,
    /validate_consumed_pos_manual_payment_reference/,
  );
  assert.match(integrityMigration, /DEFERRABLE INITIALLY DEFERRED/);
  for (const evidence of [
    "manualReferenceId",
    "manualApprovalId",
    "processing_session_id",
    "operator_profile_id",
    "approver_id",
    "consumption_ref",
  ])
    assert.match(integrityMigration, new RegExp(evidence));
});

test("endpoint preserva revogação segura e fecha novas referências até 320000", () => {
  for (const evidence of [
    "assertSameOrigin(request)",
    "assertPosMutationRequest(request)",
    'assertTenantPermission(organization.id, "pdv.write")',
    "assertTenantWriteAccess(organization.id)",
    "manual-payment.request",
    "readPosJson(request, 16_384)",
    "canManualPayment: true",
    "FOR UPDATE",
    'isolationLevel: "Serializable"',
    "cache-control",
  ])
    assert.match(
      manualRoute,
      new RegExp(evidence.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")),
    );
  const disabled = manualRoute.indexOf(
    "Novas referências manuais permanecem desabilitadas até o workflow de reconciliação autoritativa 320000",
  );
  assert.ok(
    disabled >= 0 &&
      disabled < manualRoute.indexOf("normalizePosManualPaymentRequest(body"),
    "a rejeição 320000 deve preceder qualquer criação de referência",
  );
  assert.match(manualRoute, /branchId_requesterUserId_idempotencyKey/);
  assert.match(manualRoute, /type: \{ startsWith: "payment" \}/);
  assert.match(
    manualRoute,
    /posConnectorAllowsPaymentMethod\(registeredProvider\.settings, normalized\.method\)/,
  );
  assert.match(manualRoute, /A instituição do comprovante não está cadastrada/);
  assert.match(
    manualRoute,
    /Esta referência externa já foi vinculada a outro pagamento/,
  );
  assert.match(manualRoute, /assertManualPaymentRevokeReplay/);
  assert.match(manualRoute, /revokeIdempotencyKey: input\.idempotencyKey/);
  assert.match(manualRoute, /Somente uma rejeição independente vigente/);
  assert.doesNotMatch(manualRoute, /cardNumber|cvv|track2/);
});

test("aprovação manual nasce no carrinho e exige contexto numérico exato", () => {
  assert.match(
    approvalDomain,
    /"payment\.manual_reference": \{ entityType: "sale_draft", entityRequired: true \}/,
  );
  assert.match(
    approvalDomain,
    /normalizePosManualPaymentApprovalContext\(context, entityId\)/,
  );
  assert.match(ui, /Solicitar confirmação independente/);
  assert.match(ui, /Não equivale a captura homologada/);
  assert.match(ui, /quoteHash: activePromotionQuote\.quoteHash/);
  assert.match(ui, /Horário alegado no comprovante/);
  assert.match(ui, /operatorClaimedOccurredAt: manualOccurrenceIso/);
  assert.match(ui, /manualReferenceId: payment\.manualReference\?\.id/);
  for (const evidence of [
    "Confira antes de decidir",
    "context.amountCents",
    "context.method",
    "context.provider",
    "context.referenceLastFour",
    "context.occurredAt",
    "context.paymentIndex",
    "context.registerId",
    "context.sessionId",
    "context.quoteHash",
  ])
    assert.match(
      approvalUi,
      new RegExp(evidence.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")),
    );
  assert.doesNotMatch(approvalUi, /context\.reference\b/);
});

test("commit usa XOR, não aceita evidência crua e consome manual por CAS", () => {
  assert.match(paymentPlanDomain, /externalProofs !== 1/);
  assert.match(saleRoute, /manualReferenceId.*paymentIntentId/);
  assert.match(
    saleRoute,
    /if \(\s*paymentExecutions\.some\(\(payment\) => payment\.manualReferenceId\)/,
  );
  assert.match(saleRoute, /consumeCapturedPosPaymentIntent\(tx/);
  assert.match(
    saleRoute,
    /consumeApprovedPosAction\(\s*tx,\s*context,\s*manualReference\.approvalId,\s*"payment\.manual_reference"/,
  );
  assert.match(
    saleRoute,
    /status:\s*"pending",\s*consumedSalePaymentId:\s*null/,
  );
  assert.match(
    saleRoute,
    /data:\s*\{\s*status:\s*"consumed",\s*consumedSalePaymentId:\s*payment\.id,\s*consumedAt,?\s*\}/,
  );
  assert.match(
    saleRoute,
    /status: manualReference \? "manual_confirmed" : "captured"/,
  );
  assert.match(
    saleRoute,
    /authorizedAt: manualReference \? null : new Date\(\)/,
  );
  assert.match(saleRoute, /capturedAt: manualReference \? null : new Date\(\)/);
  assert.match(
    saleRoute,
    /operatorClaimedOccurredAt:\s*manualReference\.occurredAt\.toISOString\(\)/,
  );
  assert.doesNotMatch(
    saleRoute.slice(saleRoute.indexOf("function assertSalePaymentKeys")),
    /authorizationCode|cardLastFour|endToEndId|transactionId/,
  );
});
