import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const source = readFileSync("lib/erp/pos-held-cart-transfer.ts", "utf8");

test("held-cart-transfer usa locator e ordem global sessions -> held sale -> reread -> CAS", () => {
  const body = source.slice(source.indexOf("export async function applyPosHeldCartTransfer"));
  const locator = body.indexOf("const locator = await tx.posHeldSale.findUnique");
  const sessionLock = body.indexOf('SELECT "id" FROM "cash_register_sessions"');
  const heldLock = body.indexOf('SELECT "id" FROM "pos_held_sales"');
  const authoritativeReread = body.indexOf("const held = await tx.posHeldSale.findUnique", locator + 1);
  const compareLocator = body.indexOf("held.registerId !== locator.registerId", authoritativeReread);
  const mutation = body.indexOf("const changed = await tx.posHeldSale.updateMany", authoritativeReread);

  for (const [name, offset] of Object.entries({ locator, sessionLock, heldLock, authoritativeReread, compareLocator, mutation })) {
    assert.notEqual(offset, -1, `${name} ausente`);
  }
  assert.ok(locator < sessionLock, "locator deve preceder locks");
  assert.ok(sessionLock < heldLock, "sessões devem ser travadas antes do held sale");
  assert.ok(heldLock < authoritativeReread, "held sale deve ser relido depois do lock");
  assert.ok(authoritativeReread < compareLocator && compareLocator < mutation, "releitura/locator devem ser validados antes do CAS");
  assert.match(body.slice(locator, heldLock), /sessionIds[^\n]+\.sort\(\(left, right\) => left - right\)/);
  assert.match(body.slice(sessionLock, heldLock), /ORDER BY "id" FOR UPDATE/);
});
