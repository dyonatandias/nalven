import assert from "node:assert/strict";
import test from "node:test";
import { maskPosDocument, maskPosPhone, publicPosCustomer } from "../lib/erp/pos-customer-privacy";

test("DTO do operador mascara documento e telefone e mantém apenas a allowlist", () => {
  assert.equal(maskPosDocument("123.456.789-01"), "•••••••8901");
  assert.equal(maskPosPhone("+55 11 99999-1234"), "••••1234");
  assert.deepEqual(publicPosCustomer({ id: 1, name: "Cliente", tradeName: null, document: "12345678901", phone: "11999991234" }), {
    id: 1,
    name: "Cliente",
    tradeName: null,
    document: "•••••••8901",
    phone: "••••1234",
  });
});
