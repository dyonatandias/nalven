import assert from "node:assert/strict";
import test from "node:test";
import type { Prisma } from "../generated/tenant/client";
import { applyPosKitAdminMutation, hashPosKitAdminInput, parsePosKitAdminInput } from "../lib/erp/pos-kit-admin";
import { expandPosKitBoms, posKitReturnMicros, PosKitError, type PosKitBomNode } from "../lib/erp/pos-kits";

const root: PosKitBomNode = { id: "root", version: 3, name: "Cesta", productId: 1, variationId: null, scopeKey: "product:1", components: [
  { productId: 2, variationId: null, quantityMicros: BigInt(2_000_000), position: 0 },
  { productId: 3, variationId: null, quantityMicros: BigInt(500_000), position: 1 },
] };

test("expande BOM aninhada, agrega folhas e preserva versões/caminhos", () => {
  const nested: PosKitBomNode = { id: "nested", version: 2, name: "Subkit", productId: 2, variationId: null, scopeKey: "product:2", components: [
    { productId: 3, variationId: null, quantityMicros: BigInt(250_000), position: 0 },
    { productId: 4, variationId: 9, quantityMicros: BigInt(1_000_000), position: 1 },
  ] };
  const result = expandPosKitBoms(root, [root, nested]);
  assert.deepEqual(result.boms, [{ id: "root", version: 3, scopeKey: "product:1" }, { id: "nested", version: 2, scopeKey: "product:2" }]);
  assert.deepEqual(result.components.map(component => [component.scopeKey, component.unitQuantityMicros]), [
    ["product:3", BigInt(1_000_000)],
    ["variation:9", BigInt(2_000_000)],
  ]);
  assert.equal(result.components[0].paths.length, 2, "componente direto e aninhado são agregados sem perder proveniência");
});

test("falha fechado para ciclo, BOM vazia e precisão aninhada além de seis casas", () => {
  const cycle: PosKitBomNode = { id: "cycle", version: 1, name: "Ciclo", productId: 2, variationId: null, scopeKey: "product:2", components: [{ productId: 1, variationId: null, quantityMicros: BigInt(1_000_000), position: 0 }] };
  assert.throws(() => expandPosKitBoms(root, [root, cycle]), /ciclo/);
  assert.throws(() => expandPosKitBoms({ ...root, components: [] }, [root]), /não possui componentes/);
  const imprecise = { ...cycle, components: [{ productId: 5, variationId: null, quantityMicros: BigInt(333_333), position: 0 }] };
  const three = { ...root, components: [{ productId: 2, variationId: null, quantityMicros: BigInt(333_333), position: 0 }] };
  assert.throws(() => expandPosKitBoms(three, [three, imprecise]), /seis casas/);
});

test("pós-venda de kit aceita somente unidades inteiras e usa micros exatos", () => {
  assert.equal(posKitReturnMicros(BigInt(750_000), 4), BigInt(3_000_000));
  assert.throws(() => posKitReturnMicros(BigInt(750_000), 0.5), PosKitError);
  assert.throws(() => posKitReturnMicros(BigInt("9007199254740991"), 2), /limite/);
});

test("parser administrativo limita payload, duplicidade e hash canônico", () => {
  const payload = { action: "kit.create", idempotencyKey: "kit-admin-test-0001", branchId: 1, kitProductId: 10, kitVariationId: null, name: "Cesta versão agosto", effectiveFrom: "2026-08-30T00:00:00.000Z", components: [{ productId: 20, variationId: null, quantity: 1.25 }, { productId: 21, variationId: 8, quantity: 2 }] };
  const parsed = parsePosKitAdminInput(payload);
  assert.equal(parsed.action, "kit.create");
  assert.equal(parsed.components[0].quantityMicros, BigInt(1_250_000));
  assert.equal(hashPosKitAdminInput(parsed), hashPosKitAdminInput(parsePosKitAdminInput({ ...payload, idempotencyKey: "kit-admin-test-0002" })));
  assert.throws(() => parsePosKitAdminInput({ ...payload, unknown: true }), /não suportados/);
  assert.throws(() => parsePosKitAdminInput({ ...payload, components: [payload.components[0], payload.components[0]] }), /única vez/);
  assert.throws(() => parsePosKitAdminInput({ ...payload, components: [{ productId: 20, variationId: null, quantity: 0.0000001 }] }), /seis casas/);
});

test("ativação futura preserva a versão vigente sem executar aposentadoria", async () => {
  let updates = 0;
  const tx = {
    branch: { findFirst: async () => ({ id: 1 }) },
    $queryRaw: async () => [{ id: "future-bom" }],
    posKitBom: {
      findUnique: async () => ({ id: "future-bom", branchId: 1, kitProductId: 10, kitVariationId: null, scopeKey: "product:10", version: 2, name: "Versão futura", status: "draft", effectiveFrom: new Date(Date.now() + 86_400_000), createdBy: "actor", activatedBy: null, activatedAt: null, retiredBy: null, retiredAt: null, createdAt: new Date(), updatedAt: new Date(), components: [{ id: "component", bomId: "future-bom", productId: 20, variationId: null, componentScopeKey: "product:20", quantityMicros: BigInt(1_000_000), position: 0, createdAt: new Date() }] }),
      updateMany: async () => { updates += 1; return { count: 1 }; },
    },
  } as unknown as Prisma.TransactionClient;
  await assert.rejects(applyPosKitAdminMutation(tx, { action: "kit.activate", idempotencyKey: "kit-future-test-01", branchId: 1, bomId: "future-bom" }, "actor"), /versão ativa atual foi preservada/);
  assert.equal(updates, 0);
});
