import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { hashPosInventoryAdminInput, parsePosInventoryAdminInput, PosInventoryAdminError } from "../lib/erp/pos-inventory-admin";

const projectRoot = fileURLToPath(new URL("..", import.meta.url));

test("recebimento aceita lote e série cumulativos e preserva quantidade decimal exata", () => {
  const input = parsePosInventoryAdminInput({
    action: "inventory.receive", idempotencyKey: key("receive"), branchId: 1, warehouseId: 2, productId: 3, variationId: 4,
    lotCode: " Lote 2026/9 ", serialNumber: " sn-0001 ", manufacturedOn: "2026-08-01", expiresOn: "2027-08-01", quantity: 1, note: "Recebimento por NF",
  });
  assert.deepEqual(input, {
    action: "inventory.receive", idempotencyKey: key("receive"), branchId: 1, warehouseId: 2, productId: 3, variationId: 4,
    lotCode: "Lote 2026/9", serialNumber: "sn-0001", manufacturedOn: "2026-08-01", expiresOn: "2027-08-01", quantity: 1, note: "Recebimento por NF",
  });
  assert.throws(() => parsePosInventoryAdminInput({ ...input, idempotencyKey: key("serial-two"), quantity: 2 }), /exatamente uma unidade/);
});

test("recebimento falha fechado para identidade, datas, quantidade e mass assignment inválidos", () => {
  const base = {
    action: "inventory.receive", idempotencyKey: key("base"), branchId: 1, warehouseId: 2, productId: 3,
    variationId: null, lotCode: "L-1", serialNumber: null, manufacturedOn: null, expiresOn: "2027-01-01", quantity: 1.25, note: null,
  };
  assert.throws(() => parsePosInventoryAdminInput({ ...base, lotCode: null }), /Informe lote/);
  assert.throws(() => parsePosInventoryAdminInput({ ...base, manufacturedOn: "2027-02-01" }), /posterior/);
  assert.throws(() => parsePosInventoryAdminInput({ ...base, expiresOn: "2027-02-29" }), /inválida/);
  assert.throws(() => parsePosInventoryAdminInput({ ...base, quantity: 0 }), PosInventoryAdminError);
  assert.throws(() => parsePosInventoryAdminInput({ ...base, quantity: 0.0000001 }), PosInventoryAdminError);
  assert.throws(() => parsePosInventoryAdminInput({ ...base, quantity: true }), /Quantidade inválida/);
  assert.throws(() => parsePosInventoryAdminInput({ ...base, branchId: "1" }), /Filial inválid/);
  assert.throws(() => parsePosInventoryAdminInput({ ...base, lotCode: { code: "L-1" } }), /Texto inválido/);
  assert.throws(() => parsePosInventoryAdminInput({ ...base, createdAt: "2026-08-28" }), /Campo não permitido/);
  assert.throws(() => parsePosInventoryAdminInput({ ...base, idempotencyKey: "short" }), /idempotência/);
});

test("quarentena, liberação e descarte exigem lote, motivo e quantidade estritos", () => {
  for (const action of ["inventory.quarantine", "inventory.release", "inventory.discard"] as const) {
    assert.deepEqual(parsePosInventoryAdminInput({ action, idempotencyKey: key(action), branchId: 1, lotId: "lot_1", quantity: 0.5, reason: "Avaria identificada" }), {
      action, idempotencyKey: key(action), branchId: 1, lotId: "lot_1", quantity: 0.5, reason: "Avaria identificada",
    });
    assert.throws(() => parsePosInventoryAdminInput({ action, idempotencyKey: key(`${action}-reason`), branchId: 1, lotId: "lot_1", quantity: 0.5, reason: "x" }), /Motivo inválido/);
  }
});

test("hash é canônico, cobre o escopo e independe da chave idempotente", () => {
  const first = parsePosInventoryAdminInput({ action: "inventory.discard", idempotencyKey: key("hash-a"), branchId: 1, lotId: "lot_1", quantity: 0.5, reason: "Produto avariado" });
  const replay = { ...first, idempotencyKey: key("hash-b") };
  const anotherBranch = { ...first, idempotencyKey: key("hash-c"), branchId: 2 };
  assert.equal(hashPosInventoryAdminInput(first), hashPosInventoryAdminInput(replay));
  assert.notEqual(hashPosInventoryAdminInput(first), hashPosInventoryAdminInput(anotherBranch));
  assert.match(hashPosInventoryAdminInput(first), /^[0-9a-f]{64}$/);
});

test("migration amplia a administração sem remover ações anteriores e permite quarentena serial", () => {
  const migration = readFileSync(join(projectRoot, "prisma/tenant/migrations/20260828153000_pos_inventory_admin_actions/migration.sql"), "utf8");
  for (const action of [
    "register.create", "terminal.pairing.issue", "promotion.create", "coupon.rotate",
    "inventory.receive", "inventory.quarantine", "inventory.release", "inventory.discard",
  ]) assert.match(migration, new RegExp(`'${action.replace(".", "\\.")}'`));
  assert.match(migration, /DROP CONSTRAINT "pos_admin_mutations_action_check"/);
  assert.match(migration, /"bucket_key" = 'quarantine' AND "status" = 'quarantine'/);
  assert.doesNotMatch(migration, /"normalized_serial_number" IS NULL/);
});

function key(suffix: string) { return `pos-inventory-admin:${suffix}:00000000`; }
