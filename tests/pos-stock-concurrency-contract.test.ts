import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const root = fileURLToPath(new URL("..", import.meta.url));
const route = readFileSync(join(root, "app/api/erp/pdv/route.ts"), "utf8");
const service = readFileSync(join(root, "lib/erp/pos-common-stock.ts"), "utf8");
const schema = readFileSync(join(root, "prisma/tenant/schema.prisma"), "utf8");
const migration = readFileSync(
  join(
    root,
    "prisma/tenant/migrations/20260829150000_pos_variant_warehouse_stock/migration.sql",
  ),
  "utf8",
);

function functionBlock(name: string) {
  const start = route.indexOf(`async function ${name}(`);
  assert.ok(start >= 0, `${name} ausente`);
  const end = route.indexOf("\nasync function ", start + 1);
  return route.slice(start, end < 0 ? undefined : end);
}

test("saldo de variação é escopado por depósito e produto", () => {
  assert.match(schema, /model WarehouseVariationBalance/);
  assert.match(schema, /@@unique\(\[warehouseId, variationId\]\)/);
  assert.match(
    migration,
    /warehouse_variation_balances_variation_product_fkey/,
  );
  assert.match(migration, /FOREIGN KEY \("variation_id", "product_id"\)/);
  assert.match(
    migration,
    /CREATE UNIQUE INDEX "warehouse_variation_balances_warehouse_variation_key"/,
  );
  assert.match(migration, /PARTITION BY pv\."id"/);
  assert.match(migration, /WHEN "warehouse_rank" = 1 THEN "legacy_stock"/);
});

test("serviço aplica CAS pai e variação antes de escrever ledgers", () => {
  const parentCas = service.indexOf("tx.warehouseBalance.updateMany");
  const variationCas = service.indexOf(
    "tx.warehouseVariationBalance.updateMany",
  );
  const stockMovement = service.indexOf("tx.stockMovement.create");
  const ledger = service.indexOf("tx.warehouseLedgerEntry.create");
  assert.ok(parentCas >= 0 && variationCas > parentCas);
  assert.ok(stockMovement > variationCas && ledger > stockMovement);
  assert.match(
    service,
    /quantity: parentBalance\.quantity, reservedQuantity: parentBalance\.reservedQuantity/,
  );
  assert.match(
    service,
    /quantity: variationBalance\.quantity, reservedQuantity: variationBalance\.reservedQuantity/,
  );
  assert.match(service, /variationBalanceBefore: variation\?\.before/);
});

test("commit, cancelamento e devolução compartilham o mesmo serviço transacional", () => {
  for (const name of ["commitSale", "cancelSale", "createReturn"])
    assert.match(functionBlock(name), /applyPosCommonStockChange\(tx/);
  const commit = functionBlock("commitSale");
  assert.match(commit, /isolationLevel: "Serializable"/);
  assert.ok(
    commit.indexOf("tx.sale.create") <
      commit.indexOf("applyPosCommonStockChange(tx"),
    "falha de estoque deve reverter a venda já criada na mesma transação",
  );
  assert.match(
    commit,
    /const replay = await db\.sale\.findUnique\(\{\s*where:\s*\{\s*idempotencyKey\s*\}/,
  );
  assert.match(commit, /\["P2002", "P2034"\]/);
  assert.match(
    commit,
    /Nenhuma venda ou pagamento desta tentativa foi confirmado/,
  );
  assert.doesNotMatch(commit, /tx\.warehouseBalance\.updateMany/);
});

test("catálogo e leitura usam saldo de variação do depósito", () => {
  const catalog = readFileSync(
    join(root, "lib/erp/product-catalog.ts"),
    "utf8",
  );
  assert.match(route, /posAvailableStock\(product, balance, variation\)/);
  assert.match(service, /variation\?\.warehouseBalances\[0\]/);
  assert.match(catalog, /warehouseVariationBalance\.create/);
  assert.match(migration, /variation_balance_before/);
  assert.match(
    migration,
    /VALIDATE CONSTRAINT "warehouse_ledger_entries_variation_balance_check"/,
  );
});
