import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

const root = join(import.meta.dirname, "..");
const source = (path: string) => readFileSync(join(root, path), "utf8");

test("service worker nunca intercepta mutação, API ou Authorization", () => {
  const sw = source("public/pos-sw.js");
  assert.match(sw, /request\.method !== "GET"/);
  assert.match(sw, /request\.headers\.has\("authorization"\)/);
  assert.match(sw, /url\.pathname\.startsWith\("\/api\/"\)/);
  assert.doesNotMatch(sw, /cache\.put\([^\n]*(?:\/api\/|authorization)/i);
});

test("cofre local usa PBKDF2 forte, AES-GCM, IV aleatório e AAD contextual", () => {
  const client = source("lib/erp/pos-offline-client.ts");
  assert.match(client, /PBKDF2_ITERATIONS = 310_000/);
  assert.match(client, /name: "AES-GCM"/);
  assert.match(client, /crypto\.getRandomValues\(new Uint8Array\(12\)\)/);
  assert.match(client, /additionalData: aad\(scope, kind, id\)/);
  assert.match(client, /nalven-pos-offline\|v1\|/);
  assert.doesNotMatch(client, /const\s+(?:TOKEN|SECRET|PASSPHRASE)\s*=\s*["'][^"']+["']/i);
});

test("cliente e UI bloqueiam venda, pagamento, caixa e fiscal offline", () => {
  const client = source("lib/erp/pos-offline-client.ts"), ui = source("components/erp/pdv-offline-workspace.tsx");
  assert.match(client, /SAFE_TYPES = new Set\(\["terminal\.heartbeat", "cart\.draft\.upsert", "cart\.draft\.discard"\]\)/);
  assert.match(client, /Venda, pagamento, caixa e fiscal exigem conexão online/);
  for (const label of ["Concluir venda", "Receber pagamento", "Abrir\/fechar ou movimentar caixa", "Emitir\/autorizar fiscal"]) assert.match(ui, new RegExp(label));
  assert.doesNotMatch(ui, /sale\.commit|payment\.capture|session\.open|fiscal\.issue/);
});

test("rota curta vincula filial, caixa, terminal e revalida tudo sob lock", () => {
  const credential = source("app/api/erp/pdv/offline-credentials/route.ts"), sync = source("app/api/pos-agent/[organizationId]/[terminalId]/sync/route.ts");
  assert.match(credential, /branchUserAccess\.findFirst[\s\S]*?canSell: true/);
  assert.match(credential, /accesses: \{ some: activeRegisterAccess/);
  assert.match(credential, /FOR UPDATE/);
  assert.match(credential, /revocationKey: input\.idempotencyKey/);
  assert.match(credential, /offlineAllowedUntil: remaining\._max\.expiresAt/);
  assert.match(credential, /cache-control": "no-store"/);
  assert.match(sync, /await lockTerminal[\s\S]*?await assertLiveCredential/);
  assert.match(sync, /branchAccesses: \{ some:/);
  assert.match(sync, /credentialVersion: context\.terminal\.credentialVersion/);
  assert.match(sync, /function syncError[\s\S]*?cache-control": "no-store"/);
});

test("pull omite payload de comando e ACK avança monotonicamente em SERIALIZABLE", () => {
  const sync = source("app/api/pos-agent/[organizationId]/[terminalId]/sync/route.ts"), migration = source("prisma/tenant/migrations/20260829100000_pos_offline_client_pull/migration.sql");
  const pullStart = sync.indexOf("async function pull"), selectStart = sync.indexOf("select: { operationId: true", pullStart);
  const pullSelect = sync.slice(selectStart, sync.indexOf("orderBy: { sequence", selectStart));
  assert.doesNotMatch(pullSelect, /payload|requestHash/);
  assert.match(sync, /lastSyncAckCursor: terminal\.lastSyncAckCursor/);
  assert.match(sync, /lastSyncCursor: \{ gte: input\.throughSequence \}/);
  assert.match(sync, /isolationLevel: "Serializable"/);
  assert.match(migration, /last_sync_ack_cursor" >= 0[\s\S]*last_sync_ack_cursor" <= "last_sync_cursor/);
  assert.match(migration, /VALIDATE CONSTRAINT "pos_terminals_last_sync_ack_cursor_check"/);
});
