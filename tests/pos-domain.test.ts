import assert from "node:assert/strict";
import test from "node:test";
import { assertDiscountLimit, assertPosStateTransition, classifyPosScanPurpose, isValidGtin, parsePosScan, PosDomainError, pricePosCart, settlePosPayments } from "../lib/erp/pos-domain";

test("interpreta EAN/GTIN linear e valida o dígito", () => {
  const scan = parsePosScan("7894900011517");
  assert.equal(scan.kind, "linear");
  assert.equal(scan.lookup, "7894900011517");
  assert.equal(isValidGtin(scan.lookup), true);
  assert.equal(isValidGtin("7894900011518"), false);
});

test("interpreta GS1 com GTIN, lote, validade e serial", () => {
  const scan = parsePosScan("](01)07894900011514(17)271231(10)LOTE-9(21)SERIE-1");
  assert.equal(scan.kind, "gs1");
  assert.equal(scan.gtin, "07894900011514");
  assert.equal(scan.expiresOn, "2027-12-31");
  assert.equal(scan.lot, "LOTE-9");
  assert.equal(scan.serial, "SERIE-1");
});

test("interpreta peso GS1 e AIs variáveis separados por FNC1", () => {
  const scan = parsePosScan(`0107894900011514310300125010LOTE-9${String.fromCharCode(29)}21SERIE-1`);
  assert.equal(scan.gtin, "07894900011514");
  assert.equal(scan.measuredQuantity, 1.25);
  assert.equal(scan.measurementUnit, "kg");
  assert.equal(scan.lot, "LOTE-9");
  assert.equal(scan.serial, "SERIE-1");
});

test("interpreta GS1 Digital Link", () => {
  const scan = parsePosScan("https://id.gs1.org/01/07894900011514/10/L42/21/S99?17=271231");
  assert.equal(scan.kind, "digital_link");
  assert.equal(scan.gtin, "07894900011514");
  assert.equal(scan.lot, "L42");
  assert.equal(scan.serial, "S99");
  assert.equal(scan.expiresOn, "2027-12-31");
});

test("decodifica segmentos escapados do Digital Link", () => {
  const scan = parsePosScan("https://id.gs1.org/01/07894900011514/10/LOT%2F42/21/S%2099");
  assert.equal(scan.lot, "LOT/42");
  assert.equal(scan.serial, "S 99");
});

test("classifica QR interno, Pix e fiscal antes de qualquer busca de produto", () => {
  assert.equal(classifyPosScanPurpose("NALVEN-POS.v1.receipt.key.payload.signature"), "internal_qr");
  assert.equal(classifyPosScanPurpose("00020101021226800014BR.GOV.BCB.PIX0136chave-pix52040000"), "pix_payment");
  assert.equal(classifyPosScanPurpose("pix:chave-pix"), "pix_payment");
  assert.equal(classifyPosScanPurpose("https://nfce.sefaz.ce.gov.br/pages/ShowNFCe.html?p=123"), "fiscal_document");
  assert.equal(classifyPosScanPurpose("https://id.gs1.org/01/07894900011514/21/S99"), "product");
  assert.equal(classifyPosScanPurpose("https://catalogo.example/item/42"), "generic_qr");
  assert.equal(classifyPosScanPurpose("SKU-42"), "product");
});

test("calcula carrinho em centavos com quantidades fracionárias", () => {
  const result = pricePosCart([
    { productId: 1, quantity: 2, unitPriceCents: 5990, discountCents: 100 },
    { productId: 2, quantity: 0.35, unitPriceCents: 2490 },
  ], 200, 50);
  assert.equal(result.subtotalCents, 12_752);
  assert.equal(result.totalCents, 12_602);
});

test("aceita pagamento dividido e calcula troco somente no dinheiro", () => {
  const result = settlePosPayments(10_000, [
    { method: "pix", amountCents: 4_000 },
    { method: "cash", amountCents: 6_000, tenderedCents: 10_000 },
  ]);
  assert.equal(result.changeCents, 4_000);
  assert.equal(result.appliedCents, 10_000);
});

test("rejeita pagamento incompleto e desconto acima da alçada", () => {
  assert.throws(() => settlePosPayments(10_000, [{ method: "cash", amountCents: 9_999 }]), PosDomainError);
  assert.throws(() => assertDiscountLimit(2_001, 10_000, 20), /supera a alçada/);
  assert.equal(assertDiscountLimit(2_000, 10_000, 20), 20);
  assert.throws(() => assertDiscountLimit(20_004, 100_000, 20), /supera a alçada/);
});

test("rejeita subtotal líquido zerado e estouro do INTEGER canônico", () => {
  assert.throws(() => pricePosCart([{ productId: 1, quantity: 1, unitPriceCents: 100, discountCents: 100 }], 0, 50), /subtotal líquido/);
  assert.throws(() => pricePosCart([{ productId: 1, quantity: 2, unitPriceCents: 2_147_483_647 }]), /excede o limite/);
});

test("máquinas de estado impedem regressão silenciosa", () => {
  assert.equal(assertPosStateTransition("payment", "processing", "unknown"), "unknown");
  assert.equal(assertPosStateTransition("payment", "unknown", "captured"), "captured");
  assert.throws(() => assertPosStateTransition("payment", "captured", "processing"), /Transição inválida/);
  assert.equal(assertPosStateTransition("sale", "completed", "partially_returned"), "partially_returned");
  assert.throws(() => assertPosStateTransition("sale", "cancelled", "draft"), /Transição inválida/);
});
