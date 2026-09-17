import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import test from "node:test";

const root = process.cwd();
const routePath = "app/api/erp/pdv/route.ts";
const route = readFileSync(join(root, routePath), "utf8");
const prelock = readFileSync(
  join(root, "lib/erp/pos-held-sale-item-prelock.ts"),
  "utf8",
);
const capability = readFileSync(
  join(root, "lib/erp/pos-held-sale-item-capability.ts"),
  "utf8",
);

test("inventário fecha todos os writers de pos_held_sale_items em produção", () => {
  const production = productionTypeScript();
  const directWriters = production.flatMap(({ path, source }) => {
    const matches = [
      ...source.matchAll(
        /\bposHeldSaleItem\.(create|createMany|update|updateMany|upsert|delete|deleteMany)\s*\(/g,
      ),
    ];
    return matches.map((match) => `${path}:${match[1]}`);
  });
  assert.deepEqual(
    directWriters,
    [],
    "writer direto novo precisa entrar no prelock canônico e nesta allowlist",
  );

  const nestedWriters = production.flatMap(({ path, source }) =>
    findPosHeldSaleCalls(source)
      .filter((call) =>
        /\bitems\s*:\s*\{\s*(?:create|createMany|update|updateMany|upsert|delete|deleteMany)\b/.test(
          call.text,
        ),
      )
      .map((call) => `${path}:${call.method}:${lineOf(source, call.index)}`),
  );
  assert.deepEqual(
    nestedWriters.map((writer) => writer.replace(/:\d+$/, "")),
    [
      `${routePath}:update`,
      `${routePath}:create`,
      `${routePath}:create`,
      `${routePath}:create`,
    ],
  );
});

test("recovery draft usa locator sem autoridade e trava items antes do replace", () => {
  const writer = functionSource(
    route,
    "saveRecoveryDraft",
    "discardRecoveryDraft",
  );
  ordered(
    writer,
    "const locator = await tx.posHeldSale.findUnique",
    "await prelockPosHeldSaleItemWrite",
    "heldSaleId: draftId",
    "await assertLiveTerminalProof",
    "const existing = await tx.posHeldSale.findUnique",
    "items: { deleteMany: {}, create: items }",
  );
  assert.match(
    writer,
    /sessionIds: \[session\.id, \.\.\.\(locator \? \[locator\.sessionId\] : \[\]\)\]/,
  );
  assert.match(writer, /action: locator \? "replace_batch" : "create"/);
  assert.match(writer, /idempotencyKey,[\s\S]*heldSaleId: draftId/);
  assert.match(
    writer,
    /branchProfilePairs: \[[\s\S]*\[context\.branch\.id, context\.profile\.id\][\s\S]*locator\.register\.branchId, locator\.operatorProfileId/,
  );
  assert.match(
    writer,
    /registerProfilePairs: \[[\s\S]*\[register\.id, context\.profile\.id\][\s\S]*locator\.registerId, locator\.operatorProfileId/,
  );
  assert.match(
    writer,
    /orderClaim: \{ id: draftId, expectation: "optional" \}/,
  );
  assert.match(
    writer,
    /terminalRegisterPairs: \[\[terminalProof\.terminalId, register\.id\]\]/,
  );
  assert.match(
    writer,
    /registerBranchPairs: \[[\s\S]*\[register\.id, context\.branch\.id\][\s\S]*locator\.registerId, locator\.register\.branchId/,
  );
  ordered(
    writer,
    "const openPlanLocators = locator ? await tx.posPaymentPlan.findMany",
    "preRootAdvisoryNamespaces: posPaymentPlanReleaseAdvisoryNamespaces",
    "await assertLiveTerminalProof",
    "await supersedeOpenPosPaymentPlansForDraft",
  );
  assert.match(
    writer,
    /data:\s*\{\s*id:\s*draftId,[\s\S]*items:\s*\{\s*create:\s*items\s*\}/,
  );
});

test("novos parents de hold e troca já mantêm session/terminal/access prelocked", () => {
  const hold = functionSource(route, "holdCart", "discardCart");
  ordered(
    hold,
    "await prelockPosHeldSaleItemWrite",
    "await assertLiveTerminalProof",
    "tx.posHeldSale.create",
  );
  assert.match(
    hold,
    /action: "create"[\s\S]*idempotencyKey,[\s\S]*heldSaleId,[\s\S]*sessionIds: \[session\.id\][\s\S]*terminalIds: \[terminalProof\.terminalId\][\s\S]*registerIds: \[session\.registerId!\]/,
  );
  assert.match(
    hold,
    /branchProfilePairs: \[\[context\.branch\.id, context\.profile\.id\]\][\s\S]*registerProfilePairs: \[\[session\.registerId!, context\.profile\.id\]\]/,
  );
  assert.match(
    hold,
    /terminalRegisterPairs:\s*\[\s*\[terminalProof\.terminalId, session\.registerId!\],?\s*\][\s\S]*registerBranchPairs:\s*\[\s*\[session\.registerId!, context\.branch\.id\],?\s*\]/,
  );
  assert.match(
    hold,
    /heldSaleId = `held-\$\{hashPayload\(\{ kind: "held-cart", idempotencyKey \}\)\.slice\(0, 32\)\}`/,
  );
  assert.match(hold, /data:\s*\{\s*id:\s*heldSaleId,/);

  const exchange = functionSource(
    route,
    "createReturn",
    "restorePosKitSaleItemComponents",
  );
  ordered(
    exchange,
    "await prelockPosHeldSaleItemWrite",
    "await assertLiveTerminalProof",
    "tx.posHeldSale.create",
  );
  assert.match(
    exchange,
    /if \(exchangeHeldSaleId\)\s*await prelockPosHeldSaleItemWrite[\s\S]*action: "create"[\s\S]*heldSaleId: exchangeHeldSaleId/,
  );
  assert.match(
    exchange,
    /branchProfilePairs: \[\[context\.branch\.id, context\.profile\.id\]\][\s\S]*registerProfilePairs: \[\[register\.id, context\.profile\.id\]\]/,
  );
  assert.match(
    exchange,
    /terminalRegisterPairs: \[\[terminalProof\.terminalId, register\.id\]\][\s\S]*registerBranchPairs: \[\[register\.id, context\.branch\.id\]\]/,
  );
  assert.match(
    exchange,
    /exchangeHeldSaleId = exchangeRequested\s*\? `exchange-\$\{hashPayload\(\{ kind: "pos-return-exchange", idempotencyKey \}\)\.slice\(0, 32\)\}`\s*: null/,
  );
  assert.match(exchange, /data:\s*\{[\s\S]*id:\s*exchangeHeldSaleId!/);
});

test("helper serializa zero-row e materializa a ordem T2 §6 completa", () => {
  ordered(
    prelock,
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
    'FROM "pos_held_sale_items"',
  );
  assert.match(
    prelock,
    /`pos-held-sale-items:v1:held-sale:\$\{roots\.heldSaleId\}`/,
  );
  assert.match(
    prelock,
    /`pos-held-sale-items:v1:idempotency:\$\{roots\.idempotencyKey\}`/,
  );
  assert.match(
    prelock,
    /`pos-order-claim:v1:claim:\$\{roots\.orderClaim\.id\}`/,
  );
  assert.match(
    prelock,
    /`pos-order-claim:v1:artifacts:\$\{roots\.orderClaim\.id\}`/,
  );
  assert.match(
    prelock,
    /`pos-order-claim:v1:order:\$\{orderClaimLocator\.salesOrderId\}`/,
  );
  assert.match(
    prelock,
    /const advisoryNamespaces = \[[\s\S]*\.sort\(\(left, right\) => left\.localeCompare\(right\)\)/,
  );
  assert.match(
    prelock,
    /for \(const advisoryNamespace of advisoryNamespaces\)[\s\S]*pg_advisory_xact_lock/,
  );
  assert.equal(
    prelock.indexOf("pg_advisory_xact_lock") <
      prelock.indexOf('FROM "cash_register_sessions"'),
    true,
  );
  assert.match(
    prelock,
    /roots\.action === "replace_batch"[\s\S]*assertExactIds\("carrinho existente"/,
  );
  assert.match(prelock, /else if \(heldSales\.length !== 0\)/);
});

test("helper valida cardinalidade, estado, grants exatos e vigência sob lock", () => {
  for (const state of [
    /cash_register_sessions[\s\S]*"status" = 'open'/,
    /pos_terminals[\s\S]*"status" = 'online'[\s\S]*"revoked_at" IS NULL/,
    /tenant_user_profiles[\s\S]*"status" = 'active'/,
    /FROM "branches"[\s\S]*"status" = 'active'/,
    /FROM "pos_registers"[\s\S]*"status" = 'active'/,
  ])
    assert.match(prelock, state);
  assert.match(
    prelock,
    /\("branch_id", "user_profile_id"\) IN \(\$\{pairSql\(branchProfilePairs\)\}\)/,
  );
  assert.match(
    prelock,
    /\("register_id", "user_profile_id"\) IN \(\$\{pairSql\(registerProfilePairs\)\}\)/,
  );
  assert.match(prelock, /"can_sell" = TRUE/);
  ordered(
    prelock,
    'FROM "pos_held_sales"',
    "SELECT clock_timestamp()",
    "grant.validFrom && grant.validFrom > now",
    "grant.validUntil && grant.validUntil < now",
  );
  assert.match(
    prelock,
    /assertPairCoverage\(branchProfilePairs, branchIds, operatorProfileIds/,
  );
  assert.match(
    prelock,
    /assertPairCoverage\(registerProfilePairs, registerIds, operatorProfileIds/,
  );
  assert.ok((prelock.match(/assertExactIds\(/g) || []).length >= 6);
  assert.ok((prelock.match(/assertExactPairs\(/g) || []).length >= 3);
  assert.doesNotMatch(prelock, /"branch_id" IN \([\s\S]*"user_profile_id" IN/);
  assert.match(
    prelock,
    /SELECT "id", "register_id" AS "registerId" FROM "pos_terminals"/,
  );
  assert.match(
    prelock,
    /assertExactStringNumberPairs\("terminais vinculados aos caixas"/,
  );
  assert.match(
    prelock,
    /SELECT "id", "branch_id" AS "branchId" FROM "pos_registers"/,
  );
  assert.match(prelock, /assertExactPairs\("caixas vinculados às filiais"/);
  assert.match(prelock, /roots\.orderClaim\.expectation === "required"/);
  assert.match(
    prelock,
    /claims\[0\]\?\.salesOrderId !== orderClaimLocator\.salesOrderId/,
  );
});

test("capability T2 deriva hash fechado no banco e abre antes dos quatro nested writers", () => {
  assert.match(
    capability,
    /current_database\(\) AS "databaseName", session_user AS "sessionRole"/,
  );
  assert.match(capability, /pos_manual_t2_float8_hex_v1/);
  assert.match(capability, /pos_manual_canonical_json_v1/);
  assert.match(
    capability,
    /pos_manual_t2_write_observation_multiset_digest_v1/,
  );
  assert.match(capability, /pos_manual_t2_held_sale_items_request_hash_v1/);
  assert.match(capability, /pos_manual_prepare_held_sale_items_write_v1/);
  assert.match(capability, /transportOrdinal/);
  assert.doesNotMatch(capability, /hashPayload/);
  assert.match(capability, /pos_manual_t2_float8_hex_v1\(double precision\)/);
  assert.match(
    capability,
    /pos_manual_prepare_held_sale_items_write_v1\(text,text,integer,text,text,text,jsonb,jsonb\)/,
  );

  const recovery = functionSource(
    route,
    "saveRecoveryDraft",
    "discardRecoveryDraft",
  );
  ordered(
    recovery,
    "await prelockPosHeldSaleItemWrite",
    "await assertLiveTerminalProof",
    "const existing = await tx.posHeldSale.findUnique",
    "await preparePosHeldSaleItemsCapability",
    "items: { deleteMany: {}, create: items }",
  );
  assert.match(recovery, /action: existing \? "replace_batch" : "insert"/);
  assert.match(recovery, /expectedRevision: existing\?\.revision \?\? 0/);
  assert.match(recovery, /orderClaimId: orderClaim\?\.id \?\? null/);
  assert.match(recovery, /\["draft", "held"\]\.includes\(existing\.status\)/);

  const hold = functionSource(route, "holdCart", "discardCart");
  ordered(
    hold,
    "await prelockPosHeldSaleItemWrite",
    "await assertLiveTerminalProof",
    "await preparePosHeldSaleItemsCapability",
    "tx.posHeldSale.create",
  );
  assert.match(
    hold,
    /action: "insert",[\s\S]*expectedRevision: 0,[\s\S]*orderClaimId: null/,
  );

  const exchange = functionSource(
    route,
    "createReturn",
    "restorePosKitSaleItemComponents",
  );
  ordered(
    exchange,
    "await prelockPosHeldSaleItemWrite",
    "await assertLiveTerminalProof",
    "await preparePosHeldSaleItemsCapability",
    "tx.posHeldSale.create",
  );
  assert.match(
    exchange,
    /exchangeHeldItemsIdempotencyKey[\s\S]*prelockPosHeldSaleItemWrite[\s\S]*idempotencyKey: exchangeHeldItemsIdempotencyKey!/,
  );
  assert.match(
    exchange,
    /action: "insert",[\s\S]*heldSaleId: exchangeHeldSaleId![\s\S]*expectedRevision: 0/,
  );
});

test("release de plano não introduz advisory tardio depois das raízes held", () => {
  assert.match(prelock, /preRootAdvisoryNamespaces\?: readonly string\[\]/);
  assert.match(prelock, /\.\.\.\(roots\.preRootAdvisoryNamespaces \?\? \[\]\)/);
  assert.match(
    route,
    /function posPaymentPlanReleaseAdvisoryNamespaces\([\s\S]*t2-plan:payment-plan-supersede:[\s\S]*t2-plan:payment-plan-expire:/,
  );
});

function productionTypeScript() {
  return ["app", "lib"]
    .flatMap((directory) => files(join(root, directory)))
    .filter((path) => path.endsWith(".ts") || path.endsWith(".tsx"))
    .map((path) => ({
      path: relative(root, path),
      source: readFileSync(path, "utf8"),
    }));
}

function files(directory: string): string[] {
  return readdirSync(directory).flatMap((entry) => {
    const path = join(directory, entry);
    return statSync(path).isDirectory() ? files(path) : [path];
  });
}

function findPosHeldSaleCalls(source: string) {
  const calls: Array<{ method: string; index: number; text: string }> = [];
  const pattern =
    /\bposHeldSale\.(create|createMany|update|updateMany|upsert|delete|deleteMany)\s*\(/g;
  for (const match of source.matchAll(pattern)) {
    const open = match.index! + match[0].lastIndexOf("(");
    let depth = 0;
    for (let index = open; index < source.length; index += 1) {
      if (source[index] === "(") depth += 1;
      if (source[index] === ")") depth -= 1;
      if (depth === 0) {
        calls.push({
          method: match[1],
          index: match.index!,
          text: source.slice(match.index!, index + 1),
        });
        break;
      }
    }
  }
  return calls;
}

function functionSource(source: string, startName: string, nextName: string) {
  const start = source.indexOf(`async function ${startName}`);
  const end = source.indexOf(`async function ${nextName}`, start + 1);
  assert.notEqual(start, -1, `função ausente: ${startName}`);
  assert.notEqual(end, -1, `limite ausente: ${nextName}`);
  return source.slice(start, end);
}

function ordered(source: string, ...needles: string[]) {
  const normalizedSource = source.replace(/\s+/g, " ");
  let cursor = -1;
  for (const needle of needles) {
    const found = normalizedSource.indexOf(
      needle.replace(/\s+/g, " "),
      cursor + 1,
    );
    assert.ok(found > cursor, `ordem/trecho ausente: ${needle}`);
    cursor = found;
  }
}

function lineOf(source: string, index: number) {
  return source.slice(0, index).split("\n").length;
}
