import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const root = fileURLToPath(new URL("..", import.meta.url));
const route = readFileSync(join(root, "app/api/erp/inventory/route.ts"), "utf8");
const safety = readFileSync(join(root, "lib/erp/inventory-legacy-safety.ts"), "utf8");

function functionBlock(name: string) {
  const start = route.indexOf(`async function ${name}(`);
  assert.ok(start >= 0, `${name} ausente`);
  const end = route.indexOf("\nasync function ", start + 1);
  return route.slice(start, end < 0 ? undefined : end);
}

test("finalização falha fechada antes de alterar qualquer saldo ou item", () => {
  const block = functionBlock("finalizeCount");
  const guard = block.indexOf("await assertLegacySimpleInventoryOperation(tx");
  assert.ok(guard >= 0, "guarda de contagem ausente");
  for (const mutation of ["tx.warehouseBalance.upsert", "tx.warehouseBalance.updateMany", "tx.inventoryCountItem.update", "tx.product.update"]) {
    assert.ok(block.indexOf(mutation) > guard, `${mutation} não pode anteceder a contenção`);
  }
});

test("transferência falha fechada antes de criar transferência ou movimentar saldos", () => {
  const block = functionBlock("transfer");
  const guard = block.indexOf("await assertLegacySimpleInventoryOperation(tx");
  assert.ok(guard >= 0, "guarda de transferência ausente");
  for (const mutation of ["tx.stockTransfer.create", "tx.warehouseBalance.updateMany", "tx.warehouseBalance.upsert", "tx.warehouseLedgerEntry.createMany"]) {
    assert.ok(block.indexOf(mutation) > guard, `${mutation} não pode anteceder a contenção`);
  }
});

test("guarda cobre todas as dimensões incompatíveis com os modelos legados", () => {
  for (const signal of [
    "catalogType",
    "expiryDate",
    "variations",
    "warehouseVariationBalances",
    "posInventoryLots",
    "reservedQuantity",
    "stockReservation",
    'status: "active"',
  ]) assert.match(safety, new RegExp(signal));
  assert.match(safety, /Use o inventário rastreado do PDV/);
});
