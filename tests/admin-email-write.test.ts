import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";
import { build } from "esbuild";

test("SMTP salva todos os segredos e auditoria juntos ou reverte toda a configuração", async () => {
  const mocks: Record<string, string> = {
    "test:state": `export const state={failAt:0,writes:0,stored:{vault:{},audit:[]},locked:false};`,
    "@/lib/auth": `export async function requireUser(){return{id:'admin'};}export function authErrorResponse(){return Response.json({error:'failed'},{status:500});}`,
    "@/lib/auth-recovery": `export async function deliverEmailOutbox(){throw new Error('not expected');}`,
    "@/lib/http-security": `export{privateJson,readJsonObject,assertRequestOrigin}from'./lib/http-security';export async function enforceControlRateLimit(){}`,
    "@/lib/secrets": `export function encryptSecret(){return'ciphertext-only';}export function decryptSecret(){}`,
    "@/db/control": `import{state}from'test:state';const tx={
      $executeRaw:async()=>{state.locked=true;},
      vaultSecret:{upsert:async args=>{if(!state.locked)throw new Error('missing lock');if(++state.writes===state.failAt)throw new Error('write failure');state.stored.vault[args.where.key]=args.update;}},
      auditLog:{create:async args=>{if(++state.writes===state.failAt)throw new Error('audit failure');state.stored.audit.push(args.data);}}
    };export const controlDb={$transaction:async callback=>{state.writes=0;state.locked=false;const before=structuredClone(state.stored);try{return await callback(tx);}catch(error){state.stored=before;throw error;}}};`,
  };
  const bundle = await build({
    stdin: { contents: 'export{POST}from"./app/api/admin/email/route";export{state}from"test:state";', resolveDir: process.cwd(), loader: "ts" },
    bundle: true, write: false, platform: "node", format: "cjs", packages: "external",
    plugins: [{ name: "smtp-write", setup(plugin) {
      plugin.onResolve({ filter: /.*/ }, args => args.path in mocks ? { path: args.path, namespace: "fixture" } : undefined);
      plugin.onLoad({ filter: /.*/, namespace: "fixture" }, args => ({ contents: mocks[args.path], loader: "js", resolveDir: process.cwd() }));
    } }],
  });
  const routeModule = { exports: {} };
  new Function("require", "module", "exports", bundle.outputFiles[0].text)(createRequire(import.meta.url), routeModule, routeModule.exports);
  const { POST, state } = routeModule.exports as { POST: (request: Request) => Promise<Response>; state: { failAt: number; stored: { vault: Record<string, unknown>; audit: unknown[] } } };
  const send = (overrides: Record<string, unknown> = {}) => POST(new Request("https://app.example.test/api/admin/email", { method: "POST", headers: { origin: "https://app.example.test", host: "app.example.test", "content-type": "application/json" }, body: JSON.stringify({ action: "save", host: "smtp.example.test", port: 465, encryption: "ssl", from: "mail@example.test", username: "test-user", password: "synthetic-password", ...overrides }) }));
  const before = structuredClone(state.stored);
  for (const field of ["host", "encryption", "from", "username", "password", "port"]) {
    for (const value of [null, true, false, [], {}, ["465"]]) {
      assert.equal((await send({ [field]: value })).status, 400, field);
      assert.deepEqual(state.stored, before);
    }
  }
  for (const port of ["1e3", " 465", "465 ", "0x1d1", "", 0, 65536, 1.5]) {
    assert.equal((await send({ port })).status, 400);
  }
  for (let step = 1; step <= 7; step++) {
    state.failAt = step;
    assert.equal((await send()).status, 500);
    assert.deepEqual(state.stored, before, `rollback at write ${step}`);
  }
  state.failAt = 0;
  assert.equal((await send()).status, 200);
  assert.equal(Object.keys(state.stored.vault).length, 6);
  assert.equal(state.stored.audit.length, 1);
  assert.ok(!JSON.stringify(state.stored).includes("synthetic-password"));
});
