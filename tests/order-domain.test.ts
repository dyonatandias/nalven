import assert from "node:assert/strict";
import test from "node:test";
import { cleanText, csvCell, maskRecipient, resolveCarrier, safeAmount, safeUrl } from "../lib/erp/order-domain";
import { salesOrderInput } from "../lib/erp/sales-order-input";

test("aceita o mesmo produto com variações diferentes e preserva as variações", () => {
  const result = salesOrderInput({
    customerId: 1,
    items: [
      { productId: 10, variationId: 101, quantity: 1, unitPrice: 25 },
      { productId: 10, variationId: 102, quantity: 2, unitPrice: 28 },
    ],
  });
  assert.deepEqual(result.items.map((item) => item.variationId), [101, 102]);
});

test("rejeita linha repetida da mesma variação", () => {
  assert.throws(() => salesOrderInput({ items: [
    { productId: 10, variationId: 101, quantity: 1, unitPrice: 25 },
    { productId: 10, variationId: 101, quantity: 1, unitPrice: 25 },
  ] }), /não pode aparecer duas vezes/);
});

test("normaliza entrada brasileira e impõe domínios fechados", () => {
  const result = salesOrderInput({ items: [{ productId: 10, quantity: 1, unitPrice: 12.5 }], deliveryState: "sc", deliveryZip: "89801-000", customerPhone: "+55 (49) 99999-0000" });
  assert.equal(result.deliveryState, "SC");
  assert.equal(result.deliveryZip, "89801000");
  assert.equal(result.customerPhone, "+5549999990000");
  assert.throws(() => salesOrderInput({ items: [{ productId: 10, quantity: 1, unitPrice: 1 }], deliveryType: "drone" }), /Modalidade de entrega inválida/);
});

test("protege CSV contra fórmulas e escapa conteúdo", () => {
  assert.equal(csvCell("=HYPERLINK(\"https://invalid\")"), '"\'=HYPERLINK(""https://invalid"")"');
  assert.equal(csvCell("Cliente, LTDA"), '"Cliente, LTDA"');
});

test("valida valores, URLs e mascara destinatários", () => {
  assert.equal(safeAmount("10.125", "Valor"), 10.13);
  assert.throws(() => safeAmount(-1, "Valor"), /inválido/);
  assert.equal(safeUrl("https://transportadora.example/rastreio/ABC")?.startsWith("https://"), true);
  assert.throws(() => safeUrl("javascript:alert(1)"), /HTTP ou HTTPS/);
  assert.equal(maskRecipient("cliente@example.com"), "cl***@example.com");
  assert.equal(maskRecipient("5549999999999").endsWith("9999"), true);
});

test("resolve transportadora por nome e padrão de rastreio", () => {
  const carriers = [{ key: "correios", label: "Correios", urlTemplate: "https://example/{code}", keywords: ["correios"], patterns: ["^[A-Z]{2}[0-9]{9}BR$"] }];
  assert.equal(resolveCarrier(carriers, "Entrega Correios", "AA123456789BR")?.key, "correios");
  assert.equal(resolveCarrier(carriers, "", "AA123456789BR")?.label, "Correios");
});

test("limita campos de texto sem truncamento silencioso", () => {
  assert.equal(cleanText("  teste  ", 10), "teste");
  assert.throws(() => cleanText("texto longo", 5), /limite de 5/);
});
