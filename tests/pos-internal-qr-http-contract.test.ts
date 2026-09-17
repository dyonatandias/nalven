import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const routePath = new URL("../app/api/erp/pdv/internal-qrs/route.ts", import.meta.url);
const workspacePath = new URL("../components/erp/pdv-workspace.tsx", import.meta.url);
const migrationPath = new URL("../prisma/tenant/migrations/20260829120000_pos_internal_qr_registry/migration.sql", import.meta.url);

test("rota de QR exige escopo administrativo para emissão/revogação e turno próprio para leitura", async () => {
  const source = await readFile(routePath, "utf8");
  assert.match(source, /\["owner", "admin"\]\.includes/);
  assert.match(source, /operatorProfileId: profile\.id/);
  assert.match(source, /branchUserAccess\.findFirst/);
  assert.match(source, /posRegisterAccess\.findFirst/);
  assert.match(source, /canSell: true/);
  assert.match(source, /verifyPosInternalQr/);
  assert.match(source, /tokenHash: hashPosInternalQr\(token\)/);
  assert.match(source, /status: "active"/);
  assert.match(source, /expiresAt: \{ gt: new Date\(\) \}/);
});

test("segredo do QR aparece somente na primeira emissão e respostas não podem ser armazenadas", async () => {
  const source = await readFile(routePath, "utf8");
  assert.match(source, /token: issued\.token/);
  assert.match(source, /secretAvailable: true/);
  assert.match(source, /replayed: true, secretAvailable: false/);
  assert.match(source, /"cache-control": "no-store"/);
  assert.doesNotMatch(source, /window\.location|location\.href|router\.push/);
});

test("pedido por QR só resolve identidade e o workspace exige claim atômico separado", async () => {
  const source = await readFile(routePath, "utf8");
  const workspace = await readFile(workspacePath, "utf8");
  assert.match(source, /action: "lookup_order"/);
  assert.doesNotMatch(source, /action: "open_order", order/);
  assert.match(workspace, /action === "lookup_order"/);
  assert.match(workspace, /action: "order\.claim"/);
  assert.doesNotMatch(source, /action: "order\.claim"/);
});

test("registro SQL restringe tipo, estado, referência, hashes e revogação completa", async () => {
  const source = await readFile(migrationPath, "utf8");
  assert.match(source, /kind[\s\S]*IN \('customer', 'held_cart', 'coupon', 'gift_card', 'order', 'receipt'\)/);
  assert.match(source, /status[\s\S]*IN \('active', 'revoked', 'expired'\)/);
  assert.match(source, /token_hash[\s\S]*sha256:v1:/);
  assert.match(source, /reference[\s\S]*LIKE "kind" \|\| ':%'/);
  assert.match(source, /revoke_state_check/);
  assert.match(source, /FOREIGN KEY \("branch_id"\)[\s\S]*REFERENCES "branches"/);
});
