import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

const root = process.cwd();
const route = readFileSync(join(root, "app/api/erp/pdv/route.ts"), "utf8");
const prelock = readFileSync(join(root, "lib/erp/pos-order-claim-prelock.ts"), "utf8");
const paymentPersistence = readFileSync(join(root, "lib/erp/pos-payment-persistence.ts"), "utf8");
const manualPayments = readFileSync(join(root, "app/api/erp/pdv/manual-payments/route.ts"), "utf8");
const manualReferencePrelock = readFileSync(join(root, "lib/erp/pos-manual-payment-reference-prelock.ts"), "utf8");

test("helper materializa a ordem canônica completa e mantém advisory antes das raízes", () => {
  ordered(prelock,
    "pg_advisory_xact_lock",
    'FROM "cash_register_sessions"',
    'FROM "pos_terminals"',
    'FROM "tenant_user_profiles"',
    'FROM "branches"',
    'FROM "pos_registers"',
    'FROM "branch_user_accesses"',
    'FROM "pos_register_accesses"',
    'FROM "sales_orders"',
    'FROM "pos_order_claims"',
    'FROM "pos_held_sales"',
  );
  assert.match(prelock, /const advisoryNamespaces = \[\.\.\.new Set\(\[/);
  assert.match(prelock, /\.sort\(\(left, right\) => left\.localeCompare\(right\)\)/);
  assert.match(prelock, /pos-order-claim:v1:order:/);
  assert.match(prelock, /pos-order-claim:v1:claim:/);
  assert.match(prelock, /pos-order-claim:v1:artifacts:/);
  assert.match(prelock, /pos-order-claim:v1:idempotency:/);
  assert.match(prelock, /locatedActiveClaimIds[\s\S]*pos-order-claim:v1:artifacts:/);
  assert.match(prelock, /sameStrings\(lockedClaims\.map/);
});

test("helper relê e valida cardinalidade, bindings, estado, lease, versão e grants", () => {
  assert.match(prelock, /assertOne\("turno"/);
  assert.match(prelock, /assertOne\("terminal"/);
  assert.match(prelock, /assertOne\("perfil ativo"/);
  assert.match(prelock, /assertOne\("filial ativa"/);
  assert.match(prelock, /assertOne\("caixa ativo da filial"/);
  assert.match(prelock, /assertOne\("grant de venda da filial"/);
  assert.match(prelock, /assertOne\("grant vigente de venda do caixa"/);
  assert.match(prelock, /"valid_from" IS NULL[\s\S]*clock_timestamp\(\)[\s\S]*"valid_until" IS NULL OR "valid_until" > clock_timestamp\(\)/);
  assert.match(prelock, /assertPosSessionTerminalBinding\(session, input\.terminalProof\)/);
  assert.match(prelock, /assertPosOperationalTerminalProof\(terminal, input\.terminalProof/);
  for (const binding of ["salesOrderId", "branchId", "registerId", "sessionId", "operatorProfileId", "terminalId"]) {
    assert.match(prelock, new RegExp(`claim\\.${binding} !== input\\.${binding === "terminalId" ? "terminalProof\\.terminalId" : binding}`));
  }
  assert.match(prelock, /claim\.version !== input\.expectedVersion/);
  assert.match(prelock, /claim\.state !== "active"/);
  assert.match(prelock, /input\.action === "renew"[\s\S]*claim\.leaseExpiresAt <= new Date\(\)/);
});

test("criação aloca UUID uma vez antes do retry e todos os writers diretos possuem prelock", () => {
  const create = functionSource("claimPosOrder", "renewPosOrderClaim");
  ordered(create,
    "const claimId = randomUUID()",
    "serializablePosOrderClaimRetry",
    "await prelockPosOrderClaimWrite",
    "tx.posOrderClaim.updateMany",
    "tx.posOrderClaim.create",
  );
  assert.match(create, /data: \{ id: claimId,/);

  const recover = functionSource("recoverPosOrderClaim", "releasePosOrderClaim");
  ordered(recover, "locatePosOrderClaimSalesOrder", "serializablePosOrderClaimRetry", "await prelockPosOrderClaimWrite", "tx.posOrderClaim.updateMany");
  assert.equal((recover.match(/FROM "pos_terminals"/g) || []).length, 0, "recover não deve repetir lock manual de terminal");

  const mutate = functionSource("mutatePosOrderClaim", "unresolvedPosOrderClaimArtifacts");
  ordered(mutate, "locatePosOrderClaimSalesOrder", "serializablePosOrderClaimRetry", "await prelockPosOrderClaimWrite", "tx.posOrderClaim.updateMany");

  const commit = functionSource("commitSale", "preparePosOrderReservations");
  ordered(commit, "orderClaimLocator", "commitPreRootAdvisoryNamespaces", "await prelockPosSalePaymentWriteGraph", "tx.posOrderClaim.updateMany");
  assert.doesNotMatch(commit, /FROM "pos_order_claims"[\s\S]*FOR UPDATE/);
});

test("contagens de artefatos ficam sob namespace dedicado e transação serializable", () => {
  const recover = functionSource("recoverPosOrderClaim", "releasePosOrderClaim");
  const mutate = functionSource("mutatePosOrderClaim", "unresolvedPosOrderClaimArtifacts");
  assert.match(prelock, /pos-order-claim:v1:artifacts:/);
  assert.match(recover, /serializablePosOrderClaimRetry/);
  assert.match(mutate, /serializablePosOrderClaimRetry/);
  assert.match(route, /isolationLevel: "Serializable"/);
  assert.match(paymentPersistence, /lockIntentGraphNamespaces\(tx, \[[\s\S]*pos-order-claim:v1:artifacts:/);
  assert.match(paymentPersistence, /preRootAdvisoryNamespaces: \[[\s\S]*pos-order-claim:v1:artifacts:/);
  assert.match(manualReferencePrelock, /pos-order-claim:v1:artifacts:\$\{plan\.orderClaimId\}/);
  assert.equal((manualPayments.match(/prelockPosManualReferenceWrite\(tx/g) ?? []).length, 2);
  assert.match(route, /commitPreRootAdvisoryNamespaces[\s\S]*pos-order-claim:v1:artifacts:/);
});

function functionSource(startName: string, nextName: string) {
  const start = route.indexOf(`async function ${startName}`);
  const end = route.indexOf(`async function ${nextName}`, start + 1);
  assert.notEqual(start, -1, `função ausente: ${startName}`);
  assert.notEqual(end, -1, `limite ausente: ${nextName}`);
  return route.slice(start, end);
}

function ordered(source: string, ...needles: string[]) {
  let cursor = -1;
  for (const needle of needles) {
    const found = source.indexOf(needle, cursor + 1);
    assert.ok(found > cursor, `ordem/trecho ausente: ${needle}`);
    cursor = found;
  }
}
