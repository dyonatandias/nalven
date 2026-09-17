import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const root = fileURLToPath(new URL("..", import.meta.url));
const route = readFileSync(join(root, "app/api/erp/pdv/route.ts"), "utf8");
const workspace = readFileSync(
  join(root, "components/erp/pdv-workspace.tsx"),
  "utf8",
);
const schema = readFileSync(join(root, "prisma/tenant/schema.prisma"), "utf8");
const migration = readFileSync(
  join(
    root,
    "prisma/tenant/migrations/20260829140000_pos_repeated_returns_exchange/migration.sql",
  ),
  "utf8",
);

function functionBlock(name: string) {
  const start = route.indexOf(`async function ${name}(`);
  assert.ok(start >= 0, `função ${name} ausente`);
  const end = route.indexOf("\nasync function ", start + 1);
  return route.slice(start, end < 0 ? undefined : end);
}

test("schema e migration impõem ciclo e unicidade da troca", () => {
  assert.match(
    schema,
    /exchangeHeldSaleId\s+String\?\s+@unique\s+@map\("exchange_held_sale_id"\)/,
  );
  assert.match(
    schema,
    /exchangeSaleId\s+Int\?\s+@unique\s+@map\("exchange_sale_id"\)/,
  );
  assert.match(migration, /pos_returns_exchange_lifecycle_check/);
  assert.match(
    migration,
    /exchange_status" = 'draft'[\s\S]*?exchange_sale_id" IS NULL/,
  );
  assert.match(
    migration,
    /exchange_status" = 'completed'[\s\S]*?exchange_sale_id" IS NOT NULL/,
  );
  assert.match(
    migration,
    /CREATE UNIQUE INDEX "pos_returns_exchange_held_sale_id_key"/,
  );
  assert.match(
    migration,
    /CREATE UNIQUE INDEX "pos_returns_exchange_sale_id_key"/,
  );
  assert.match(
    migration,
    /VALIDATE CONSTRAINT "pos_returns_exchange_lifecycle_check"/,
  );
});

test("devolução repetida usa saldo bloqueado e não confirma refund externo", () => {
  const block = functionBlock("createReturn");
  assert.match(
    block,
    /\["completed", "partially_returned"\]\.includes\(sale\.status\)/,
  );
  assert.match(block, /item\.quantity - item\.returnedQuantity/);
  assert.match(block, /calculatePosReturnRefundCents/);
  assert.match(block, /new Set\(requestedItems\.map/);
  assert.ok(
    block.indexOf(
      "Devolução eletrônica exige um conector server-side homologado",
    ) < block.indexOf("tx.posReturn.create"),
    "refund externo deve bloquear antes de persistir retorno ou estoque",
  );
  assert.match(block, /exchangeRequested/);
  assert.match(block, /exchangeHeldSale: \{ include: \{ items: true \} \}/);
  assert.match(block, /lote\/série devem ser lidos novamente/);
});

test("commit e descarte fecham o vínculo uma vez e auditam a venda original", () => {
  const commit = functionBlock("commitSale");
  const discard = functionBlock("discardCart");
  assert.match(
    commit,
    /sourceType: "pos_exchange", sourceId: exchangeOrigin\.id/,
  );
  assert.match(commit, /exchangeOrigin\.status !== "completed"/);
  assert.match(commit, /exchangeStatus: "draft"[\s\S]*?exchangeSaleId: null/);
  assert.match(
    commit,
    /exchangeStatus:\s*"completed",\s*exchangeSaleId:\s*created\.id/,
  );
  assert.match(commit, /action: "pos\.exchange\.completed"/);
  assert.match(discard, /exchangeStatus:\s*"cancelled",\s*exchangeCancelledAt/);
  assert.match(discard, /action: "pos\.exchange\.cancelled"/);
});

test("UI oferece saldo subsequente e troca como nova venda online", () => {
  assert.match(
    workspace,
    /\["completed", "partially_returned"\]\.includes\(sale\.status\)/,
  );
  assert.match(workspace, /payment\.type === "payment"/);
  assert.match(workspace, /"partially_refunded", "refunded"/);
  assert.match(workspace, /calculatePosReturnRefundCents/);
  assert.match(workspace, /name="exchange" type="checkbox"/);
  assert.match(
    workspace,
    /preços, descontos, lote\/série, estoque e pagamento revalidados/,
  );
  assert.doesNotMatch(workspace, /Esta tela só inicia a primeira devolução/);
});
