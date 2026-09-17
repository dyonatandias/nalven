import assert from "node:assert/strict";
import test from "node:test";
import { BrowserReadCache } from "../lib/erp/browser-read-cache";

test("cache expires and bounds memory with least-recently-used eviction", () => {
  let now = 0;
  const cache = new BrowserReadCache<string>(30, 2, () => now);
  cache.set("a", "a"); cache.set("b", "b"); cache.get("a"); cache.set("c", "c");
  assert.equal(cache.get("b"), undefined); assert.equal(cache.get("a")?.data, "a");
  now = 30; assert.equal(cache.get("a"), undefined); assert.equal(cache.get("c"), undefined);
});

test("concurrent reads deduplicate and remain isolated by context", async () => {
  const cache = new BrowserReadCache<string>();
  let calls = 0;
  const loader = async () => { calls++; return "one"; };
  assert.deepEqual(await Promise.all([cache.read("user1:branch1:products", loader), cache.read("user1:branch1:products", loader)]), ["one", "one"]);
  assert.equal(calls, 1);
  assert.equal(cache.get("user2:branch1:products"), undefined);
  assert.equal(cache.get("user1:branch2:products"), undefined);
});

test("mutation wins over a late GET even when the loader ignores abort", async () => {
  const cache = new BrowserReadCache<string>();
  let resolve!: (data: string) => void;
  const stale = cache.read("products", () => new Promise<string>(done => { resolve = done; }));
  await Promise.resolve();
  cache.set("products", "saved"); resolve("stale");
  await assert.rejects(stale, { name: "AbortError" });
  assert.equal(cache.get("products")?.data, "saved");
});

test("old request cleanup cannot remove its replacement; failures remain retryable", async () => {
  const cache = new BrowserReadCache<string>();
  let fail!: (error: Error) => void, finish!: (data: string) => void;
  const old = cache.read("key", () => new Promise<string>((_, reject) => { fail = reject; }));
  await Promise.resolve(); cache.invalidate("key");
  const replacement = cache.read("key", () => new Promise<string>(resolve => { finish = resolve; }));
  await Promise.resolve(); fail(new Error("offline")); await assert.rejects(old, /offline/);
  const duplicate = cache.read("key", async () => { throw new Error("duplicate request"); });
  finish("recovered"); assert.deepEqual(await Promise.all([replacement, duplicate]), ["recovered", "recovered"]);
  cache.invalidate("key");
  await assert.rejects(cache.read("key", async () => { throw new Error("offline"); }), /offline/);
  assert.equal(await cache.read("key", async () => "retry"), "retry");
});
