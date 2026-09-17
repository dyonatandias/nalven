"use client";

const DB_NAME = "nalven-pos-offline";
const DB_VERSION = 3;
const PBKDF2_ITERATIONS = 310_000;
const SAFE_TYPES = new Set(["terminal.heartbeat", "cart.draft.upsert", "cart.draft.discard"]);

type JsonObject = Record<string, unknown>;
type Cipher = { iv: string; ciphertext: string };
type LocalCredential = { organizationId: string; terminalId: string; credentialId: string; token: string; expiresAt: string };
export type PosOfflineQueueIssue = { reasonCode: "draft_revision_conflict" | "offline_operation_not_supported" | "offline_sync_rejected"; message: string };
type QueueRow = { operationId: string; scope: string; sequence: number; type: string; occurredAt: string; state: "queued" | "rejected" | "conflict"; encrypted: Cipher; error: PosOfflineQueueIssue | null };
type VaultRow = { key: string; scope: string; kind: string; encrypted: Cipher };
type SnapshotRow = { key: string; scope: string; kind: string; version: string; encrypted: Cipher; updatedAt: string };

export type OfflineStatus = {
  configured: boolean;
  unlocked: boolean;
  expiresAt: string | null;
  queued: number;
  rejected: number;
  conflicts: number;
  catalogVersion: string | null;
  permissionVersion: string | null;
  lastPullCursor: string;
};

export function isPosOfflineOperationAllowed(type: string) { return SAFE_TYPES.has(type); }

export class PosOfflineVault {
  private key: CryptoKey | null = null;
  private credential: LocalCredential | null = null;

  constructor(readonly scope: string) {
    if (!/^[A-Za-z0-9._:-]{3,340}$/.test(scope)) throw new Error("Escopo offline inválido.");
  }

  static scope(organizationId: string, terminalId: string) { return `${organizationId}:${terminalId}`; }

  async initialize(passphrase: string, credential: LocalCredential) {
    validatePassphrase(passphrase);
    if (PosOfflineVault.scope(credential.organizationId, credential.terminalId) !== this.scope) throw new Error("Credencial pertence a outro escopo.");
    assertCredential(credential);
    await this.purge();
    const salt = crypto.getRandomValues(new Uint8Array(16));
    const db = await openDb();
    await put(db, "meta", { key: `${this.scope}:salt`, scope: this.scope, value: base64(salt) });
    this.key = await deriveKey(passphrase, salt);
    this.credential = credential;
    await this.writeVault("sentinel", { scope: this.scope, version: DB_VERSION });
    await this.writeVault("credential", credential);
    await put(db, "meta", { key: `${this.scope}:nextSequence`, scope: this.scope, value: "1" });
    await put(db, "meta", { key: `${this.scope}:pullCursor`, scope: this.scope, value: "0" });
  }

  async unlock(passphrase: string) {
    validatePassphrase(passphrase);
    const db = await openDb(), saltRow = await get<{ value: string }>(db, "meta", `${this.scope}:salt`);
    if (!saltRow) throw new Error("Modo offline ainda não foi configurado neste dispositivo.");
    const candidate = await deriveKey(passphrase, fromBase64(saltRow.value));
    this.key = candidate;
    try {
      const sentinel = await this.readVault<{ scope: string; version: number }>("sentinel");
      if (sentinel.scope !== this.scope || sentinel.version !== DB_VERSION) throw new Error("Cofre local incompatível.");
      this.credential = await this.readVault<LocalCredential>("credential");
      assertCredential(this.credential);
      if (Date.parse(this.credential.expiresAt) <= Date.now()) { await this.purge(); throw new Error("Credencial offline expirada; os dados locais foram eliminados."); }
    } catch (error) {
      this.lock();
      throw error instanceof Error && error.message.includes("expirada") ? error : new Error("Frase secreta incorreta ou cofre local adulterado.");
    }
  }

  lock() { this.key = null; this.credential = null; }

  async purge() {
    const db = await openDb();
    await Promise.all(["meta", "vault", "queue", "snapshots", "drafts"].map(store => deleteScope(db, store, this.scope)));
    this.lock();
  }

  async enqueue(type: string, payload: JsonObject) {
    this.assertUnlocked();
    if (!isPosOfflineOperationAllowed(type)) throw new Error("Venda, pagamento, caixa e fiscal exigem conexão online.");
    validateSafePayload(type, payload);
    const db = await openDb(), sequence = await allocateSequence(db, this.scope), operationId = crypto.randomUUID(), occurredAt = new Date().toISOString();
    const encrypted = await encrypt(this.key!, this.scope, "queue", operationId, payload);
    const row: QueueRow = { operationId, scope: this.scope, sequence, type, occurredAt, state: "queued", encrypted, error: null };
    await put(db, "queue", row);
    return row;
  }

  async sync() {
    this.assertUnlocked();
    const credential = this.credential!;
    if (Date.parse(credential.expiresAt) <= Date.now()) { await this.purge(); throw new Error("Credencial offline expirada; cofre local eliminado."); }
    const db = await openDb(), queued = (await allByScope<QueueRow>(db, "queue", this.scope)).filter(row => row.state === "queued").sort((a, b) => a.sequence - b.sequence).slice(0, 50);
    try {
      if (queued.length) {
        const operations = await Promise.all(queued.map(async row => ({ operationId: row.operationId, sequence: String(row.sequence), type: row.type, occurredAt: row.occurredAt, payload: await decrypt<JsonObject>(this.key!, this.scope, "queue", row.operationId, row.encrypted) })));
        const pushed = await api(credential, { action: "sync.push", operations });
        for (const result of pushed.operations as Array<{ operationId: string; state: string; response: unknown; conflict: unknown }>) {
          const row = queued.find(item => item.operationId === result.operationId);
          if (!row) continue;
          if (result.state === "applied") await remove(db, "queue", row.operationId);
          else await put(db, "queue", { ...row, state: result.state === "conflict" ? "conflict" : "rejected", error: projectOfflineQueueIssue(result.conflict ?? result.response) });
        }
      }
      let cursor = await meta(db, `${this.scope}:pullCursor`, "0"), hasMore = true;
      while (hasMore) {
        const catalogVersion = (await get<SnapshotRow>(db, "snapshots", `${this.scope}:catalog`))?.version ?? null;
        const permissionVersion = (await get<SnapshotRow>(db, "snapshots", `${this.scope}:permissions`))?.version ?? null;
        const pulled = await api(credential, { action: "sync.pull", afterSequence: cursor, catalogVersion, permissionVersion });
        if (pulled.catalog) await this.writeSnapshot("catalog", pulled.catalog as { version: string; data: unknown });
        if (pulled.permissions) await this.writeSnapshot("permissions", pulled.permissions as { version: string; data: unknown });
        for (const draft of pulled.drafts as Array<{ draftId: string }>) await put(db, "drafts", { key: `${this.scope}:${draft.draftId}`, scope: this.scope, draftId: draft.draftId, encrypted: await encrypt(this.key!, this.scope, "draft", draft.draftId, draft) });
        cursor = String(pulled.nextCursor);
        await put(db, "meta", { key: `${this.scope}:pullCursor`, scope: this.scope, value: cursor });
        await ensureNextSequence(db, this.scope, Number(pulled.cursor) + 1);
        hasMore = pulled.hasMore === true;
      }
      await api(credential, { action: "sync.ack", throughSequence: cursor });
      return this.status();
    } catch (error) {
      if (error instanceof OfflineApiError && error.status === 401) { await this.purge(); throw new Error("Credencial revogada ou expirada; cofre local eliminado."); }
      throw error;
    }
  }

  async status(): Promise<OfflineStatus> {
    const db = await openDb(), rows = await allByScope<QueueRow>(db, "queue", this.scope);
    const credential = this.credential ?? (this.key ? await this.readVault<LocalCredential>("credential").catch(() => null) : null);
    return {
      configured: Boolean(await get(db, "meta", `${this.scope}:salt`)), unlocked: Boolean(this.key && credential), expiresAt: credential?.expiresAt ?? null,
      queued: rows.filter(row => row.state === "queued").length, rejected: rows.filter(row => row.state === "rejected").length, conflicts: rows.filter(row => row.state === "conflict").length,
      catalogVersion: (await get<SnapshotRow>(db, "snapshots", `${this.scope}:catalog`))?.version ?? null,
      permissionVersion: (await get<SnapshotRow>(db, "snapshots", `${this.scope}:permissions`))?.version ?? null,
      lastPullCursor: await meta(db, `${this.scope}:pullCursor`, "0"),
    };
  }

  async queue() {
    const db = await openDb();
    return (await allByScope<QueueRow>(db, "queue", this.scope)).sort((a, b) => a.sequence - b.sequence).map(row => ({ operationId: row.operationId, scope: row.scope, sequence: row.sequence, type: row.type, occurredAt: row.occurredAt, state: row.state, error: row.error == null ? null : projectOfflineQueueIssue(row.error) }));
  }

  async snapshot<T>(kind: "catalog" | "permissions") {
    this.assertUnlocked();
    const db = await openDb(), row = await get<SnapshotRow>(db, "snapshots", `${this.scope}:${kind}`);
    return row ? { version: row.version, updatedAt: row.updatedAt, data: await decrypt<T>(this.key!, this.scope, "snapshot", kind, row.encrypted) } : null;
  }

  private assertUnlocked() { if (!this.key || !this.credential) throw new Error("Desbloqueie o cofre offline primeiro."); }
  private async writeVault(kind: string, value: unknown) { const db = await openDb(), key = `${this.scope}:${kind}`; await put(db, "vault", { key, scope: this.scope, kind, encrypted: await encrypt(this.key!, this.scope, "vault", kind, value) } satisfies VaultRow); }
  private async readVault<T>(kind: string) { const db = await openDb(), row = await get<VaultRow>(db, "vault", `${this.scope}:${kind}`); if (!row) throw new Error("Registro do cofre ausente."); return decrypt<T>(this.key!, this.scope, "vault", kind, row.encrypted); }
  private async writeSnapshot(kind: string, snapshot: { version: string; data: unknown }) { if (!/^[0-9a-f]{64}$/.test(snapshot.version)) throw new Error("Versão de snapshot inválida."); const db = await openDb(), key = `${this.scope}:${kind}`; await put(db, "snapshots", { key, scope: this.scope, kind, version: snapshot.version, encrypted: await encrypt(this.key!, this.scope, "snapshot", kind, snapshot.data), updatedAt: new Date().toISOString() } satisfies SnapshotRow); }
}

class OfflineApiError extends Error { constructor(message: string, readonly status: number) { super(message); } }

export function projectOfflineQueueIssue(value: unknown): PosOfflineQueueIssue {
  const record = value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
  const code = record && typeof (record.code ?? record.reasonCode) === "string" ? String(record.code ?? record.reasonCode) : "";
  if (code === "draft_revision_conflict") return { reasonCode: code, message: "O rascunho mudou no servidor e precisa de resolução assistida." };
  if (code === "offline_operation_not_supported") return { reasonCode: code, message: "A operação exige processamento online autoritativo." };
  return { reasonCode: "offline_sync_rejected", message: "A sincronização foi recusada; revise a pendência online." };
}

async function api(credential: LocalCredential, body: JsonObject) {
  const response = await fetch(`/api/pos-agent/${encodeURIComponent(credential.organizationId)}/${encodeURIComponent(credential.terminalId)}/sync`, { method: "POST", credentials: "omit", cache: "no-store", headers: { authorization: `Bearer ${credential.token}`, "content-type": "application/json" }, body: JSON.stringify(body) });
  const value = await response.json().catch(() => ({})) as Record<string, unknown>;
  if (!response.ok) throw new OfflineApiError(String(value.error || "Falha na sincronização offline."), response.status);
  return value;
}

function validatePassphrase(value: string) { if (value.length < 12 || value.length > 256) throw new Error("A frase secreta deve possuir entre 12 e 256 caracteres."); }
function assertCredential(value: LocalCredential) { if (!value || !value.organizationId || !value.terminalId || !/^[0-9a-f-]{36}$/.test(value.credentialId) || !value.token.startsWith("posoff_v1_") || !Number.isFinite(Date.parse(value.expiresAt))) throw new Error("Credencial offline inválida."); }
function validateSafePayload(type: string, value: JsonObject) {
  const keys = Object.keys(value), exact = (allowed: string[]) => { const extra = keys.find(key => !allowed.includes(key)); if (extra) throw new Error(`Campo offline não permitido: ${extra}.`); };
  if (type === "terminal.heartbeat") { exact(["appVersion", "queueDepth"]); if (typeof value.appVersion !== "string" || value.appVersion.length < 1 || value.appVersion.length > 64 || !Number.isSafeInteger(value.queueDepth) || Number(value.queueDepth) < 0) throw new Error("Heartbeat offline inválido."); return; }
  if (type === "cart.draft.discard") exact(["draftId", "baseRevision", "revision"]);
  else exact(["draftId", "baseRevision", "revision", "customerId", "items"]);
  if (!/^[0-9a-f-]{36}$/.test(String(value.draftId || "")) || !Number.isSafeInteger(value.baseRevision) || !Number.isSafeInteger(value.revision) || Number(value.revision) !== Number(value.baseRevision) + 1) throw new Error("Revisão do rascunho inválida.");
  if (type === "cart.draft.upsert") {
    if (!Array.isArray(value.items) || value.items.length < 1 || value.items.length > 200) throw new Error("Itens do rascunho inválidos.");
    const lines = value.items.map(item => {
      if (!item || typeof item !== "object" || Array.isArray(item)) throw new Error("Linha do rascunho inválida.");
      const row = item as Record<string, unknown>, extra = Object.keys(row).find(key => !["lineId", "productId", "variationId", "quantityMicros"].includes(key));
      if (extra || !/^[0-9a-f-]{36}$/.test(String(row.lineId || "")) || !Number.isSafeInteger(row.productId) || Number(row.productId) < 1 || row.variationId != null && (!Number.isSafeInteger(row.variationId) || Number(row.variationId) < 1) || !/^[1-9]\d{0,11}$/.test(String(row.quantityMicros || ""))) throw new Error("Linha do rascunho inválida.");
      return String(row.lineId);
    });
    if (new Set(lines).size !== lines.length || value.customerId != null && (!Number.isSafeInteger(value.customerId) || Number(value.customerId) < 1)) throw new Error("Rascunho offline inválido.");
  }
}

async function deriveKey(passphrase: string, salt: Uint8Array) {
  const material = await crypto.subtle.importKey("raw", new TextEncoder().encode(passphrase), "PBKDF2", false, ["deriveKey"]);
  const saltBytes = new Uint8Array(salt.byteLength);
  saltBytes.set(salt);
  return crypto.subtle.deriveKey({ name: "PBKDF2", hash: "SHA-256", salt: saltBytes.buffer, iterations: PBKDF2_ITERATIONS }, material, { name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
}
function aad(scope: string, kind: string, id: string) { return new TextEncoder().encode(`nalven-pos-offline|v1|${scope}|${kind}|${id}`); }
async function encrypt(key: CryptoKey, scope: string, kind: string, id: string, value: unknown): Promise<Cipher> { const iv = crypto.getRandomValues(new Uint8Array(12)); const plaintext = new TextEncoder().encode(JSON.stringify(value)); const ciphertext = await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData: aad(scope, kind, id), tagLength: 128 }, key, plaintext); return { iv: base64(iv), ciphertext: base64(new Uint8Array(ciphertext)) }; }
async function decrypt<T>(key: CryptoKey, scope: string, kind: string, id: string, value: Cipher): Promise<T> { const plaintext = await crypto.subtle.decrypt({ name: "AES-GCM", iv: fromBase64(value.iv), additionalData: aad(scope, kind, id), tagLength: 128 }, key, fromBase64(value.ciphertext)); return JSON.parse(new TextDecoder().decode(plaintext)) as T; }
function base64(value: Uint8Array) { let binary = ""; for (const byte of value) binary += String.fromCharCode(byte); return btoa(binary); }
function fromBase64(value: string) { const binary = atob(value), result = new Uint8Array(binary.length); for (let index = 0; index < binary.length; index++) result[index] = binary.charCodeAt(index); return result; }

function openDb() { return new Promise<IDBDatabase>((resolve, reject) => { const request = indexedDB.open(DB_NAME, DB_VERSION); request.onerror = () => reject(request.error); request.onupgradeneeded = () => { const db = request.result; for (const name of ["meta", "vault", "snapshots", "drafts"]) if (!db.objectStoreNames.contains(name)) { const store = db.createObjectStore(name, { keyPath: "key" }); store.createIndex("scope", "scope"); } if (!db.objectStoreNames.contains("queue")) { const store = db.createObjectStore("queue", { keyPath: "operationId" }); store.createIndex("scope", "scope"); store.createIndex("scopeSequence", ["scope", "sequence"], { unique: true }); } }; request.onsuccess = () => resolve(request.result); }); }
function request<T>(value: IDBRequest<T>) { return new Promise<T>((resolve, reject) => { value.onsuccess = () => resolve(value.result); value.onerror = () => reject(value.error); }); }
async function get<T>(db: IDBDatabase, store: string, key: IDBValidKey) { return request(db.transaction(store).objectStore(store).get(key)) as Promise<T | undefined>; }
async function put(db: IDBDatabase, store: string, value: unknown) { const tx = db.transaction(store, "readwrite"); tx.objectStore(store).put(value); await transaction(tx); }
async function remove(db: IDBDatabase, store: string, key: IDBValidKey) { const tx = db.transaction(store, "readwrite"); tx.objectStore(store).delete(key); await transaction(tx); }
async function allByScope<T>(db: IDBDatabase, store: string, scope: string) { return request(db.transaction(store).objectStore(store).index("scope").getAll(scope)) as Promise<T[]>; }
async function deleteScope(db: IDBDatabase, store: string, scope: string) { if (!db.objectStoreNames.contains(store)) return; const tx = db.transaction(store, "readwrite"), index = tx.objectStore(store).index("scope"), cursor = index.openKeyCursor(IDBKeyRange.only(scope)); cursor.onsuccess = () => { const item = cursor.result; if (item) { tx.objectStore(store).delete(item.primaryKey); item.continue(); } }; await transaction(tx); }
function transaction(tx: IDBTransaction) { return new Promise<void>((resolve, reject) => { tx.oncomplete = () => resolve(); tx.onabort = () => reject(tx.error); tx.onerror = () => reject(tx.error); }); }
async function allocateSequence(db: IDBDatabase, scope: string) { const tx = db.transaction("meta", "readwrite"), done = transaction(tx), store = tx.objectStore("meta"), key = `${scope}:nextSequence`, row = await request<{ value: string } | undefined>(store.get(key)), next = Number(row?.value ?? "1"); if (!Number.isSafeInteger(next) || next < 1) { tx.abort(); throw new Error("Sequência local corrompida."); } store.put({ key, scope, value: String(next + 1) }); await done; return next; }
async function ensureNextSequence(db: IDBDatabase, scope: string, minimum: number) { if (!Number.isSafeInteger(minimum) || minimum < 1) throw new Error("Cursor do servidor inválido."); const tx = db.transaction("meta", "readwrite"), done = transaction(tx), store = tx.objectStore("meta"), key = `${scope}:nextSequence`, row = await request<{ value: string } | undefined>(store.get(key)), current = Number(row?.value ?? "1"); store.put({ key, scope, value: String(Math.max(current, minimum)) }); await done; }
async function meta(db: IDBDatabase, key: string, fallback: string) { return (await get<{ value: string }>(db, "meta", key))?.value ?? fallback; }
