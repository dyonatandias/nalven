import assert from "node:assert/strict";
import test from "node:test";
import { billingCommandKey } from "../lib/billing/idempotency";

test("chaves curtas preservam retries de operações já enviadas", () => {
  assert.equal(billingCommandKey("empresa", "ticket", "command-123456789"), "nalven:empresa:ticket:command-123456789");
});

test("chaves longas preservam identidade completa do tenant, ação, chamado e comando", () => {
  const company = "empresa".repeat(20), action = `ticket-${"x".repeat(160)}-reply`;
  const key = billingCommandKey(company, action, "command-123456789");
  assert.ok(Buffer.byteLength(key) <= 200);
  assert.equal(key, billingCommandKey(company, action, "command-123456789"));
  assert.notEqual(key, billingCommandKey(company, action, "command-123456780"));
  assert.notEqual(key, billingCommandKey(`${company}2`, action, "command-123456789"));
  assert.notEqual(key, billingCommandKey(company, `${action}2`, "command-123456789"));
  assert.ok(Buffer.byteLength(billingCommandKey("á".repeat(150), action, "command")) <= 200);
});
