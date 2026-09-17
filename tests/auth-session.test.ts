import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import test from "node:test";
import { build } from "esbuild";

test("sessões reais rotacionam apenas o navegador atual e limpam a empresa anterior", async t => {
  const mocks: Record<string, string> = {
    "test:state": `export const state = { cookies: {}, writes: [], sessions: [], user: {status: 'active', passwordHash: 'expected'}, failCreate: false, locks: [] };`,
    "next/headers": `import {state} from 'test:state';
      export const headers = async () => new Headers({'x-forwarded-proto':'https','x-real-ip':'127.0.0.1','user-agent':'session-test'});
      export const cookies = async () => ({get: key => state.cookies[key] ? {value: state.cookies[key]} : undefined, set: (name,value,options) => {state.cookies[name] = value; state.writes.push({name,value,options});}});`,
    "@/db/control": `import {state} from 'test:state';
      const session = {
        deleteMany: async ({where}) => { state.sessions = state.sessions.filter(s => s.tokenHash !== where.tokenHash); },
        create: async ({data}) => {if (state.failCreate) throw new Error('storage unavailable'); state.sessions.push(data);},
        findUnique: async ({where}) => state.sessions.find(s => s.tokenHash === where.tokenHash) || null
      };
      export const controlDb = {session, $transaction: async callback => {
        const snapshot = [...state.sessions];
        try {return await callback({session, user: {findUnique: async () => state.user}, $executeRaw: async (...args) => {state.locks.push(args);}});}
        catch (error) {state.sessions = snapshot; throw error;}
      }};`,
  };
  const result = await build({
    stdin: { contents: 'export * from "./lib/auth"; export {state} from "test:state";', resolveDir: process.cwd(), loader: "ts" },
    bundle: true, write: false, platform: "node", format: "cjs", packages: "external",
    plugins: [{ name: "session-storage-fixture", setup(plugin) {
      plugin.onResolve({ filter: /.*/ }, args => args.path in mocks ? { path: args.path, namespace: "fixture" } : undefined);
      plugin.onLoad({ filter: /.*/, namespace: "fixture" }, args => ({ contents: mocks[args.path], loader: "js" }));
    } }],
  });
  type Session = { tokenHash: string; userId: string; expiresAt?: Date };
  type CookieWrite = { name: string; value: string; options: { httpOnly: boolean; sameSite: string; secure: boolean; expires?: Date; path: string } };
  const evaluated = { exports: {} };
  new Function("require", "module", "exports", result.outputFiles[0].text)(createRequire(import.meta.url), evaluated, evaluated.exports);
  const { createSession, destroySession, currentUser, state } = evaluated.exports as {
    createSession: (user: string, organization?: string, remember?: boolean, expected?: string) => Promise<void>;
    destroySession: () => Promise<void>; currentUser: () => Promise<unknown>;
    state: { cookies: Record<string, string>; writes: CookieWrite[]; sessions: Session[]; user: { status: string; passwordHash: string }; failCreate: boolean; locks: unknown[] };
  };
  const previous = "a".repeat(43);
  const hash = (token: string) => createHash("sha256").update(token).digest("hex");
  function reset() {
    Object.assign(state, { cookies: { nalven_session: previous, nalven_organization: "old-company" }, writes: [],
      sessions: [{tokenHash:hash(previous),userId:"old-user"}, {tokenHash:hash("b".repeat(43)),userId:"new-user"}],
      user: {status:"active",passwordHash:"expected"}, failCreate:false, locks:[] });
  }
  await t.test("reautenticar revoga cookie anterior, preserva outros dispositivos e emite cookies seguros", async () => {
    reset(); await createSession("new-user", "new-company", false, "expected");
    assert.equal(state.sessions.some(s => s.tokenHash === hash(previous)), false);
    assert.equal(state.sessions.some(s => s.tokenHash === hash("b".repeat(43))), true);
    assert.equal(state.sessions.length, 2);
    assert.match(state.cookies.nalven_session, /^[A-Za-z0-9_-]{43}$/);
    assert.notEqual(state.cookies.nalven_session, previous);
    assert.equal(state.sessions.some(s => s.tokenHash === state.cookies.nalven_session), false);
    assert.equal(state.cookies.nalven_organization, "new-company");
    for (const {options} of state.writes) {
      assert.equal(options.httpOnly,true); assert.equal(options.secure,true); assert.equal(options.sameSite,"lax"); assert.equal(options.path,"/"); assert.equal(options.expires,undefined);
    }
    assert.equal(state.locks.length, 1);
  });
  await t.test("usuário sem empresa remove cookie antigo, inclusive ao lembrar acesso", async () => {
    reset(); await createSession("new-user", undefined, true, "expected");
    assert.equal(state.cookies.nalven_organization, "");
    assert.equal(state.writes.find(w => w.name === "nalven_organization")!.options.expires!.getTime(), 0);
    assert.ok(state.writes.find(w => w.name === "nalven_session")!.options.expires!.getTime() > Date.now() + 29 * 86400000);
  });
  await t.test("senha alterada simultaneamente e conta suspensa não emitem sessão nem revogam a anterior", async () => {
    for (const update of [{passwordHash:"changed"}, {status:"suspended"}]) {
      reset(); Object.assign(state.user,update); await assert.rejects(createSession("new-user",undefined,false,"expected"), {status:401});
      assert.equal(state.writes.length,0); assert.equal(state.sessions[0].tokenHash,hash(previous));
    }
  });
  await t.test("falha de armazenamento reverte revogação e não altera cookies", async () => {
    reset(); state.failCreate = true; await assert.rejects(createSession("new-user"));
    assert.equal(state.writes.length,0); assert.equal(state.sessions[0].tokenHash,hash(previous));
  });
  await t.test("logout revoga sessão no servidor e expira ambos os cookies", async () => {
    reset(); await destroySession();
    assert.equal(state.sessions.length,1);
    for (const {value,options} of state.writes) { assert.equal(value,""); assert.equal(options.expires!.getTime(),0); assert.equal(options.httpOnly,true); }
  });
  await t.test("cookie malformado nunca autentica", async () => {
    reset(); state.cookies.nalven_session = "invalid"; assert.equal(await currentUser(),null);
  });
});
