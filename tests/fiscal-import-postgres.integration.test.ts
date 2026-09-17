import assert from "node:assert/strict";
import test from "node:test";
import { PrismaClient } from "../generated/tenant/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { prepareInboundInvoice, createProductFromInvoiceItem } from "../lib/erp/inbound-fiscal";
import { receivePurchaseInvoiceRecord, autoReceiveEligibility } from "../lib/erp/purchase-invoice-receiving";
import { encryptSecret } from "../lib/secrets";

test("XML realista percorre captura, produto pendente, recebimento e bloqueios sem duplicidade", { skip: !process.env.FISCAL_TEST_DATABASE_URL }, async () => {
  const url = process.env.FISCAL_TEST_DATABASE_URL!;
  assert.equal(new URL(url).pathname, "/fiscal_import_test", "Nunca executar este teste em produção");
  const db = new PrismaClient({ adapter: new PrismaPg({ connectionString: url }) });
  const actor = { id: "fiscal-test-owner", name: "Operador de teste" };
  try {
    const branch = await db.branch.create({ data: { code: "TEST", name: "Teste isolado", legalName: "Teste isolado", document: "11444777000161", state: "GO" } });
    const role = await db.tenantRole.create({ data: { key: "owner", name: "Proprietário", permissions: ["*"] } });
    await db.tenantUserProfile.create({ data: { userId: actor.id, roleId: role.id, displayName: actor.name, email: "test@example.invalid", activeBranchId: branch.id } });
    const warehouse = await db.warehouse.create({ data: { code: "TEST", name: "Depósito isolado", branchId: branch.id } });
    const base = "3524011122233300018155001000000123100000123";
    const sum = [...base].reverse().reduce((s, d, i) => s + Number(d) * (2 + i % 8), 0), dv = 11 - sum % 11;
    const key = `${base}${dv > 9 ? 0 : dv}`;
    const xml = `<NFe><infNFe Id="NFe${key}"><ide><tpAmb>1</tpAmb><nNF>123</nNF><serie>1</serie><dhEmi>2026-09-02T10:00:00-03:00</dhEmi></ide><emit><CNPJ>11222333000181</CNPJ><xNome>Fornecedor de teste</xNome></emit><dest><CNPJ>11444777000161</CNPJ></dest><det nItem="1"><prod><cProd>ROUPA-1</cProd><xProd>Camiseta de teste</xProd><cEAN>7891234567895</cEAN><NCM>61091000</NCM><CFOP>5102</CFOP><uCom>UN</uCom><qCom>2</qCom><vUnCom>12.50</vUnCom><vProd>25</vProd></prod></det><total><ICMSTot><vNF>25</vNF></ICMSTot></total></infNFe></NFe>`;
    const document = await db.inboundFiscalDocument.create({ data: { source: "sefaz_nfe", environment: "production", documentType: "nfe", schemaName: "procNFe_v4.00.xsd", nsu: "000000000000001", accessKey: key, branchId: branch.id, recipientDocument: branch.document, status: "ready", classification: "goods", fullDocumentAvailable: true, encryptedXml: encryptSecret(xml), payloadHash: "a".repeat(64) } });
    const first = await prepareInboundInvoice(db, document.id, actor);
    const replay = await prepareInboundInvoice(db, document.id, actor);
    assert.equal(first.invoice.id, replay.invoice.id);
    assert.equal(await db.purchaseInvoice.count(), 1);
    const product = await createProductFromInvoiceItem(db, first.invoice.items[0].id, actor);
    const repeatedProduct = await createProductFromInvoiceItem(db, first.invoice.items[0].id, actor);
    assert.equal(repeatedProduct.product.id, product.product.id);
    assert.equal(await db.product.count(), 1);
    assert.equal(product.product.onboardingStatus, "pending");
    assert.equal((await db.product.findUniqueOrThrow({ where: { id: product.product.id } })).stock, 0);
    assert.equal((await autoReceiveEligibility(db, first.invoice.id, warehouse.id)).eligible, false);
    await receivePurchaseInvoiceRecord(db, first.invoice.id, { warehouseId: warehouse.id, dueAt: new Date("2026-09-30T12:00:00Z") }, actor, "test-receive");
    await assert.rejects(receivePurchaseInvoiceRecord(db, first.invoice.id, { warehouseId: warehouse.id, dueAt: new Date("2026-09-30T12:00:00Z") }, actor, "test-replay"));
    assert.equal((await db.product.findUniqueOrThrow({ where: { id: product.product.id } })).stock, 2);
    assert.equal(await db.financialTitle.count(), 1);
    await db.inboundFiscalDocument.update({ where: { id: document.id }, data: { status: "cancelled" } });
    await assert.rejects(prepareInboundInvoice(db, document.id, actor), /cancelado/);
    const homologation = await db.inboundFiscalDocument.create({ data: { source: "sefaz_nfe", environment: "homologation", documentType: "nfe", schemaName: "procNFe_v4.00.xsd", nsu: document.nsu, accessKey: key, branchId: branch.id, recipientDocument: branch.document, status: "ready", classification: "goods", fullDocumentAvailable: true, encryptedXml: encryptSecret(xml), payloadHash: "b".repeat(64) } });
    await assert.rejects(prepareInboundInvoice(db, homologation.id, actor), /homologação/);
    assert.equal(await db.purchaseInvoice.count(), 1);
  } finally { await db.$disconnect(); }
});
