import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";
import { build } from "esbuild";

type BinaryFixture = {
  response: { status: number; headers: Record<string, string | string[]>; body: Buffer };
  unavailable: boolean;
  calls: Array<{ url: string; options: { method?: string; body?: Buffer; headers: Record<string, string>; timeoutMs: number; maximumResponseBytes: number } }>;
  jsonCalls: Array<{ url: string; options: { method?: string; body?: string | Buffer; headers: Record<string, string>; timeoutMs: number } }>;
};
type BinaryModule = typeof import("../lib/billing/binary") & Pick<typeof import("../lib/billing/client"), "BillingError" | "BillingClient"> & { state: BinaryFixture };

test("transportes Billing reais confirmam somente envelopes válidos", async t => {
  const mocks: Record<string, string> = {
    "test:binary-state": "export const state = {response:null,unavailable:false,calls:[],jsonCalls:[]};",
    "@/lib/vault": 'export const VAULT_KEYS={billingApi:"fixture"};export const getVaultSecret=async()=>"skp_nalven_fixture_not_a_real_key";',
    "@/db/control": 'export const controlDb={systemSetting:{findUnique:async()=>({value:{headlessBaseUrl:"https://billing.invalid/api/v1/saas"}})}};',
    "@/lib/integrations/security": `import {state} from "test:binary-state";
      export const safeRequest=async(url,options)=>{state.jsonCalls.push({url,options});if(state.unavailable)throw new Error("Fixture timeout");return{...state.response,body:state.response.body.toString("utf8")};};
      export const safeBinaryRequest=async(url,options)=>{state.calls.push({url,options});if(state.unavailable)throw new Error("Fixture timeout");return state.response;};`,
  };
  const bundled = await build({
    stdin: { contents: 'export * from "./lib/billing/binary";export {BillingError,BillingClient} from "./lib/billing/client";export {state} from "test:binary-state";', resolveDir: process.cwd(), loader: "ts" },
    bundle: true, write: false, platform: "node", format: "cjs", packages: "external",
    plugins: [{ name: "mock-binary-io", setup(plugin) {
      plugin.onResolve({ filter: /.*/ }, args => args.path in mocks ? { path: args.path, namespace: "fixture" } : undefined);
      plugin.onLoad({ filter: /.*/, namespace: "fixture" }, args => ({ contents: mocks[args.path], loader: "js", resolveDir: process.cwd() }));
    } }],
  });
  const binaryModule = { exports: {} };
  new Function("require", "module", "exports", bundled.outputFiles[0].text)(createRequire(import.meta.url), binaryModule, binaryModule.exports);
  const { billingBinary, billingMultipart, BillingError, BillingClient, state } = binaryModule.exports as BinaryModule;
  const client = new BillingClient();
  const path = "/clientes/fixture/tickets/fixture-ticket/anexos";
  const key = "fixture-stable-command-1234567890";
  const form = () => { const value = new FormData(); value.set("mensagem_id", "10"); value.set("file", new File(["evidence"], "evidence.txt", { type: "text/plain" })); return value; };
  const respond = (body: string, status = 200, headers: Record<string, string | string[]> = {}) => {
    state.response = { status, body: Buffer.from(body), headers: { "content-type": "application/json", ...headers } };
    state.unavailable = false; state.calls = []; state.jsonCalls = [];
  };
  const isBillingFailure = (status: number, retryAfter?: number) => (error: unknown) => {
    assert.ok(error instanceof BillingError);
    assert.equal(error.status, status); assert.equal(error.retryAfter, retryAfter);
    return true;
  };

  await t.test("aceita success booleano true e data definida sem inventar DTO de upload", async () => {
    for (const data of [{ id: 5 }, null, [], false, 0, ""]) {
      respond(JSON.stringify({ success: true, data }), 201);
      assert.deepEqual(await billingMultipart(path, form(), key), data);
    }
    const call = state.calls[0];
    assert.equal(call.url, `https://billing.invalid/api/v1/saas${path}`);
    assert.equal(call.options.method, "POST");
    assert.equal(call.options.headers["Idempotency-Key"] || call.options.headers["idempotency-key"], key);
    assert.match(call.options.headers["content-type"], /^multipart\/form-data; boundary=/);
    assert.equal(call.options.timeoutMs, 15_000); assert.equal(call.options.maximumResponseBytes, 10 * 1024 * 1024);
    const forwarded = await new Request("https://serialization.invalid", { method: "POST", headers: { "content-type": call.options.headers["content-type"] }, body: Uint8Array.from(call.options.body!) }).formData();
    assert.equal(forwarded.get("mensagem_id"), "10");
    const file = forwarded.get("file"); assert.ok(file instanceof File); assert.equal(file.name, "evidence.txt"); assert.equal(await file.text(), "evidence");
  });

  await t.test("null, array, erro sem success e sucesso coercível não confirmam envio", async () => {
    for (const payload of [null, [], {}, { error: "unconfirmed" }, { success: false, error: "rejected", data: {} }, { success: "true", data: {} }, { success: 1, data: {} }, { success: true }]) {
      respond(JSON.stringify(payload));
      await assert.rejects(billingMultipart(path, form(), key), isBillingFailure(502));
      assert.equal(state.calls.length, 1);
    }
  });

  await t.test("JSON quebrado e respostas sem corpo viram 502 incerto", async () => {
    for (const response of [{ status: 200, body: "not-json" }, { status: 200, body: "" }, { status: 204, body: "" }, { status: 205, body: "" }]) {
      respond(response.body, response.status);
      await assert.rejects(billingMultipart(path, form(), key), isBillingFailure(502));
    }
  });

  await t.test("HTTP 429 e 409 preservam Retry-After seguro e request ID", async () => {
    for (const status of [429, 409]) {
      respond(JSON.stringify({ error: "Aguarde", request_id: "fixture-request" }), status, { "retry-after": [" 2 ", "invalid"] });
      await assert.rejects(billingMultipart(path, form(), key), (error: unknown) => {
        isBillingFailure(status, 2)(error); assert.ok(error instanceof BillingError); assert.equal(error.requestId, "fixture-request"); return true;
      });
    }
    respond("null", 429, { "retry-after": "60" });
    await assert.rejects(billingBinary(path), isBillingFailure(429, 60));
  });

  await t.test("Retry-After inválido nunca vira número inseguro no erro", async () => {
    for (const value of ["", "0", "-1", "1.5", "1e2", "+2", "Infinity", "9007199254740992", "Wed, 09 Sep 2026 10:00:00 GMT"]) {
      respond("{}", 429, { "retry-after": value });
      await assert.rejects(billingMultipart(path, form(), key), isBillingFailure(429));
    }
    respond("{}", 502, { "retry-after": "9007199254740991" });
    await assert.rejects(billingBinary(path), isBillingFailure(502, Number.MAX_SAFE_INTEGER));
  });

  await t.test("envelope inválido 2xx preserva cooldown e repetição usa mesma chave", async () => {
    respond(JSON.stringify({ error: "unconfirmed", request_id: "fixture-request" }), 200, { "retry-after": "3" });
    await assert.rejects(billingMultipart(path, form(), key), isBillingFailure(502, 3));
    state.response = { ...state.response, body: Buffer.from(JSON.stringify({ success: true, data: { id: 5 } })) };
    assert.deepEqual(await billingMultipart(path, form(), key), { id: 5 });
    assert.equal(state.calls.length, 2);
    assert.deepEqual(state.calls.map(call => new Headers(call.options.headers).get("idempotency-key")), [key, key]);
  });

  await t.test("falha de transporte fica incerta e download binário continua intacto", async () => {
    respond("{}"); state.unavailable = true;
    await assert.rejects(billingMultipart(path, form(), key), isBillingFailure(503));
    respond("%PDF-fixture", 200, { "content-type": "application/pdf", "content-disposition": 'attachment; filename="fixture.pdf"' });
    const response = await billingBinary(path);
    assert.equal(response.headers.get("content-type"), "application/pdf");
    assert.equal(response.headers.get("content-disposition"), 'attachment; filename="fixture.pdf"');
    assert.equal(await response.text(), "%PDF-fixture");
  });

  await t.test("JSON aceita apenas success true com data definida e preserva o comando serializado", async () => {
    for (const data of [{ token: "fixture-ticket" }, null, [], false, 0, ""]) {
      respond(JSON.stringify({ success: true, data }), 201, { "content-type": "Application/JSON; charset=utf-8" });
      assert.deepEqual(await client.request(path, { method: "POST", body: JSON.stringify({ mensagem: "Fixture" }) }, key), data);
    }
    const call = state.jsonCalls[0];
    assert.equal(call.url, `https://billing.invalid/api/v1/saas${path}`);
    assert.equal(call.options.method, "POST"); assert.equal(call.options.timeoutMs, 10_000);
    assert.equal(new Headers(call.options.headers).get("idempotency-key"), key);
    assert.equal(new Headers(call.options.headers).get("content-type"), "application/json");
    assert.equal(call.options.body, JSON.stringify({ mensagem: "Fixture" }));
    assert.equal(state.calls.length, 0);
  });

  await t.test("JSON null, array, success string/number e data ausente resultam em 502 incerto", async () => {
    for (const payload of [null, [], "text", false, 0, {}, { error: "not-confirmed" }, { success: false, data: {} }, { success: "false", data: {} }, { success: "true", data: {} }, { success: 1, data: {} }, { success: true }]) {
      respond(JSON.stringify(payload), 200, { "retry-after": "2" });
      await assert.rejects(client.request(path, { method: "POST", body: "{}" }, key), isBillingFailure(502, 2));
      assert.equal(state.jsonCalls.length, 1);
    }
    for (const body of ["null", "[]", "not-json", ""]) {
      respond(body, 429, { "retry-after": "60" });
      await assert.rejects(client.request(path), isBillingFailure(502, 60));
    }
  });

  await t.test("JSON 429/409 preservam somente Retry-After e request ID válidos", async () => {
    for (const body of ["not-json", "null", "[]", ""]) {
      respond(body, 409, { "retry-after": "60" });
      await assert.rejects(client.request(path), isBillingFailure(409, 60));
    }
    for (const status of [429, 409]) {
      respond(JSON.stringify({ success: false, error: "Aguarde", request_id: "fixture-request_2" }), status, { "retry-after": [" 2 ", "invalid"] });
      await assert.rejects(client.request(path), (error: unknown) => {
        isBillingFailure(status, 2)(error); assert.ok(error instanceof BillingError);
        assert.equal(error.requestId, "fixture-request_2"); assert.equal(error.message, "Aguarde"); return true;
      });
    }
    for (const value of ["", "0", "-1", "1.5", "1e2", "+2", "Infinity", "9007199254740992", "Wed, 09 Sep 2026 10:00:00 GMT"]) {
      respond(JSON.stringify({ success: false, error: "Aguarde" }), 429, { "retry-after": value });
      await assert.rejects(client.request(path), isBillingFailure(429));
    }
  });

  await t.test("JSON não transforma objetos, controles ou campos excessivos em erros públicos", async () => {
    for (const payload of [{ error: { secret: "private-fixture" }, request_id: { secret: "private-fixture" } }, { error: ["private-fixture"], request_id: ["private-fixture"] }, { error: "private\u0000fixture", request_id: "private\r\nfixture" }, { error: "x".repeat(501), request_id: "x".repeat(101) }]) {
      respond(JSON.stringify(payload), 422);
      await assert.rejects(client.request(path), (error: unknown) => {
        isBillingFailure(422)(error); assert.ok(error instanceof BillingError);
        assert.equal(error.message, "Billing HTTP 422"); assert.equal(error.requestId, undefined); return true;
      });
    }
  });

  await t.test("JSON falha de transporte/HTML fica incerta e mesma chave sobrevive à confirmação", async () => {
    respond("{}"); state.unavailable = true;
    await assert.rejects(client.request(path, { method: "POST", body: "{}" }, key), isBillingFailure(503));
    respond("<html>unconfirmed</html>", 200, { "content-type": "text/html", "retry-after": "3" });
    await assert.rejects(client.request(path, { method: "POST", body: "{}" }, key), isBillingFailure(502, 3));
    state.response = { ...state.response, headers: { "content-type": "application/json" }, body: Buffer.from(JSON.stringify({ success: true, data: { token: "fixture-ticket" } })) };
    assert.deepEqual(await client.request(path, { method: "POST", body: "{}" }, key), { token: "fixture-ticket" });
    assert.deepEqual(state.jsonCalls.map(call => new Headers(call.options.headers).get("idempotency-key")), [key, key]);
  });
});
