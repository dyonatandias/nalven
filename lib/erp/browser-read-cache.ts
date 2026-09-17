/** Memory-only cache. Keys must include the authenticated user/company/branch context. */
export class BrowserReadCache<T> {
  private entries = new Map<string, { data: T; storedAt: number }>();
  private requests = new Map<string, { controller: AbortController; promise: Promise<T> }>();

  constructor(private readonly ttlMs = 30_000, private readonly limit = 60, private readonly now = Date.now) {}

  get(key: string) {
    const entry = this.entries.get(key);
    if (!entry) return undefined;
    if (this.now() - entry.storedAt >= this.ttlMs) {
      this.entries.delete(key);
      return undefined;
    }
    this.entries.delete(key);
    this.entries.set(key, entry);
    return entry;
  }

  set(key: string, data: T) {
    // A read that began before this mutation must never overwrite its result.
    this.invalidate(key);
    while (this.entries.size >= this.limit) this.entries.delete(this.entries.keys().next().value!);
    this.entries.set(key, { data, storedAt: this.now() });
  }

  invalidate(key: string) {
    this.entries.delete(key);
    this.requests.get(key)?.controller.abort();
    this.requests.delete(key);
  }

  async read(key: string, loader: (signal: AbortSignal) => Promise<T>) {
    const pending = this.requests.get(key);
    if (pending) return pending.promise;
    const controller = new AbortController();
    const promise = Promise.resolve().then(() => loader(controller.signal)).then(data => {
      if (controller.signal.aborted) throw new DOMException("Leitura substituída", "AbortError");
      this.requests.delete(key);
      this.set(key, data);
      return data;
    }).finally(() => {
      if (this.requests.get(key)?.controller === controller) this.requests.delete(key);
    });
    this.requests.set(key, { controller, promise });
    return promise;
  }
}

/** Storage is optional: disabled cookies/private mode must not break navigation. */
export function readBrowserPreference(kind: "localStorage" | "sessionStorage", key: string) {
  try { return window[kind].getItem(key); } catch { return null; }
}

export function writeBrowserPreference(kind: "localStorage" | "sessionStorage", key: string, value: string) {
  try { window[kind].setItem(key, value); } catch { /* In-memory state remains usable. */ }
}
