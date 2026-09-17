import assert from "node:assert/strict";
import test from "node:test";
import { assertPosMutationRequest, PosHttpError, posRatePolicy, readPosJson } from "../lib/erp/pos-http";
import { assertSameOrigin, CustomerInputError } from "../lib/erp/customer-input";
import { postgresErrorCode } from "../lib/erp/postgres-error";

test("aceita JSON same-origin e rejeita Fetch Metadata cross-site", () => {
  const valid = request("{}", { "sec-fetch-site": "same-origin" });
  assert.doesNotThrow(() => assertPosMutationRequest(valid));
  assert.throws(() => assertPosMutationRequest(request("{}", { "sec-fetch-site": "cross-site" })), (error) => error instanceof PosHttpError && error.status === 403);
  assert.throws(() => assertPosMutationRequest(new Request("https://erp.test/api/erp/pdv", { method: "POST", body: "x", headers: { "content-type": "text/plain" } })), (error) => error instanceof PosHttpError && error.status === 415);
});

test("origem explícita deve coincidir e nunca falha aberta com URL malformada", () => {
  assert.doesNotThrow(() => assertSameOrigin(request("{}", { origin: "https://erp.test", host: "erp.test" })));
  assert.throws(() => assertSameOrigin(request("{}", { origin: "https://evil.test", host: "erp.test" })), CustomerInputError);
  assert.throws(() => assertSameOrigin(request("{}", { origin: "http://erp.test", host: "erp.test" })), CustomerInputError);
  assert.throws(() => assertSameOrigin(request("{}", { origin: "https://evil.test", host: "erp.test", "x-forwarded-host": "evil.test" })), CustomerInputError);
  assert.doesNotThrow(() => assertSameOrigin(new Request("http://internal.test/api/erp/pdv", { method: "POST", body: "{}", headers: { origin: "https://erp.test", host: "erp.test", "x-forwarded-proto": "https" } })));
  assert.throws(() => assertSameOrigin(request("{}", { origin: "[", host: "erp.test" })), CustomerInputError);
});

test("lê JSON por stream e exige objeto", async () => {
  assert.deepEqual(await readPosJson(request('{"action":"scan.resolve"}')), { action: "scan.resolve" });
  await assert.rejects(() => readPosJson(request("[]")), (error) => error instanceof PosHttpError && error.status === 400);
  await assert.rejects(() => readPosJson(request("{")), (error) => error instanceof PosHttpError && error.status === 400);
});

test("limite considera bytes UTF-8 declarados e efetivos", async () => {
  const multibyte = JSON.stringify({ value: "ç".repeat(20) });
  assert.ok(multibyte.length < Buffer.byteLength(multibyte));
  await assert.rejects(() => readPosJson(request(multibyte), multibyte.length), (error) => error instanceof PosHttpError && error.status === 413);
  await assert.rejects(() => readPosJson(request("{}", { "content-length": "999" }), 10), (error) => error instanceof PosHttpError && error.status === 413);
});

test("políticas diferenciam scanner, venda e administração", () => {
  assert.deepEqual(posRatePolicy("scan.resolve"), { limit: 600, seconds: 60 });
  assert.deepEqual(posRatePolicy("sale.commit"), { limit: 120, seconds: 60 });
  assert.deepEqual(posRatePolicy("access.update"), { limit: 30, seconds: 60 });
  assert.deepEqual(posRatePolicy("cart.transfer"), { limit: 30, seconds: 60 });
  assert.deepEqual(posRatePolicy("unknown"), { limit: 60, seconds: 60 });
});

test("SQLSTATE atravessa o envelope P2039 do driver sem liberar erro genérico", () => {
  assert.equal(postgresErrorCode({ code: "P2039", meta: { driverAdapterError: { cause: { originalCode: "42501" } } } }), "42501");
  assert.equal(postgresErrorCode({ code: "P2034" }), "P2034");
  assert.equal(postgresErrorCode({ code: "INTERNAL", cause: { message: "segredo" } }), "");
});

function request(body: string, headers: Record<string, string> = {}) {
  return new Request("https://erp.test/api/erp/pdv", { method: "POST", body, headers: { "content-type": "application/json; charset=utf-8", ...headers } });
}
