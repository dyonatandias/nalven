import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const source = await readFile(new URL("../lib/erp/pos-operational-access.ts", import.meta.url), "utf8");

test("política não recebe papel gerencial nem sintetiza acesso", () => {
  const signature = source.slice(source.indexOf("export function authorizePosOperationalAction"), source.indexOf("): PosOperationalAuthorization"));
  assert.doesNotMatch(signature, /role|owner|admin|privileged/i);
  assert.match(source, /access\.id\) \|\| access\.id <= 0/);
  assert.match(source, /branchCanSell && access/);
});

test("break-glass é exato, independente, curto e single-use", () => {
  assert.match(source, /grant\.approvedByUserId !== expected\.actorUserId/);
  assert.match(source, /grant\.usesRemaining === 1/);
  assert.match(source, /15 \* 60_000/);
  assert.match(source, /grant\.operationKey === expected\.operationKey/);
  assert.match(source, /grant\.action === expected\.action/);
});
