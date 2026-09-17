import assert from "node:assert/strict";
import test from "node:test";
import { licensePolicy } from "../lib/billing/license-policy";

test("política de licença aceita somente limites inteiros e não injeta configuração financeira", () => {
  assert.deepEqual(licensePolicy({ licenseTimeoutMs: 5000, licenseCacheSeconds: 300, baseUrl: "https://other.invalid" }), { licenseTimeoutMs: 5000, licenseCacheSeconds: 300 });
  for (const value of [null, [], {}, { licenseTimeoutMs: "5000", licenseCacheSeconds: 300 }, { licenseTimeoutMs: 100, licenseCacheSeconds: 300 }, { licenseTimeoutMs: 30001, licenseCacheSeconds: 300 }, { licenseTimeoutMs: 5000, licenseCacheSeconds: 29 }, { licenseTimeoutMs: 5000, licenseCacheSeconds: 3601 }, { licenseTimeoutMs: 1000.5, licenseCacheSeconds: 300 }]) assert.equal(licensePolicy(value), null);
});
