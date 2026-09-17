import assert from "node:assert/strict";
import test from "node:test";
import { buildPosFiscalSaleSnapshot } from "../lib/erp/pos-fiscal-persistence";

const policy = {
  saleCommitMode: "queue" as const,
  requiredProductFields: ["ncm", "origin", "gtin"] as const,
  defaultCfop: "5102",
  defaultCsosn: "102",
  defaultCst: null,
};

function fixture() {
  return {
    id: 91,
    saleNumber: "PDV-FISCAL-91",
    branchId: 3,
    sessionId: 7,
    operatorProfileId: 11,
    status: "completed",
    totalCents: 1_234,
    createdAt: new Date(),
    customerRecord: null,
    items: [
      {
        productId: 19,
        productName: "Água mineral",
        gtinSnapshot: "7894900011517",
        unit: "un",
        quantity: 1,
        unitPriceCents: 1_234,
        discountCents: 0,
        surchargeCents: 0,
        totalCents: 1_234,
        product: {
          fiscalType: "product",
          ncm: "22021000",
          cest: null,
          cestNotApplicable: true,
          origin: "0",
          csosn: "102",
          gtinTributary: null,
          taxStatus: "taxable",
          taxClass: null,
        },
      },
    ],
    payments: [{ method: "cash", amountCents: 1_234 }],
  };
}

test("snapshot fiscal usa dados autoritativos e normaliza unidade", () => {
  const snapshot = buildPosFiscalSaleSnapshot(
    fixture(),
    { taxRegime: "simples_nacional", policyDigest: "a".repeat(64) },
    policy,
  );
  assert.equal(snapshot.totalCents, 1_234);
  assert.equal(snapshot.items[0].unit, "UN");
  assert.deepEqual(snapshot.payments, [{ method: "cash", amountCents: 1_234 }]);
  assert.deepEqual(snapshot.items[0].fiscal, {
    fiscalType: "product",
    ncm: "22021000",
    cest: null,
    cestNotApplicable: true,
    origin: "0",
    gtin: "7894900011517",
    gtinTributary: null,
    cfop: "5102",
    csosn: "102",
    cst: null,
    taxStatus: "taxable",
    taxClass: null,
    taxRegime: "simples_nacional",
    profilePolicyDigest: "a".repeat(64),
  });
});

test("snapshot fiscal falha fechado com cadastro tributário incompleto", () => {
  const sale = fixture();
  (sale.items[0].product as { ncm: string | null }).ncm = null;
  assert.throws(
    () => buildPosFiscalSaleSnapshot(sale, { taxRegime: "simples_nacional", policyDigest: "b".repeat(64) }, policy),
    /não possui ncm/,
  );
});

test("snapshot fiscal não aceita fechamento divergente entre itens e pagamentos", () => {
  const sale = fixture();
  sale.payments[0].amountCents = 1_200;
  assert.throws(
    () => buildPosFiscalSaleSnapshot(sale, { taxRegime: "simples_nacional", policyDigest: "c".repeat(64) }, policy),
    /Soma dos pagamentos diverge/,
  );
});
