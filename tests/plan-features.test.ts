import assert from "node:assert/strict";
import test from "node:test";
import { planAllows, restrictedFeature } from "../lib/erp/plan-features";
const retail = ["products", "pdv", "integrations", "stock", "finance"];
test("retail plan blocks service and native marketplace permissions for read and write", () => {
  for (const resource of ["service-orders", "contracts", "marketplaces"])
    for (const verb of ["read", "write"]) assert.equal(restrictedFeature(retail, `${resource}.${verb}`), true);
});
test("retail keeps products, stock and generic integration available", () => {
  for (const resource of retail) { assert.equal(planAllows(retail, resource), true); assert.equal(restrictedFeature(retail, `${resource}.write`), false); }
});
test("full plans retain their explicitly enabled features", () => {
  assert.equal(restrictedFeature(["*"], "marketplaces.write"), false);
  assert.equal(restrictedFeature(["service-orders"], "service-orders.read"), false);
  assert.equal(restrictedFeature(["integrations"], "marketplaces.read"), true);
});
test("malformed plan features fail closed for restricted modules", () => {
  for (const modules of [null, undefined, {}, "*", []]) assert.equal(restrictedFeature(modules, "marketplaces.write"), true);
});
