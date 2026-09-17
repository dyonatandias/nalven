import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const root = fileURLToPath(new URL("..", import.meta.url));
const read = (path: string) => readFileSync(join(root, path), "utf8");
const schema = read("prisma/tenant/schema.prisma");
const migration = read(
  "prisma/tenant/migrations/20260829250000_pos_fiscal_persistence/migration.sql",
);

test("fundação fiscal separa perfil, documento, entrega, callback e evidência", () => {
  for (const model of [
    "PosFiscalProfileVersion",
    "PosFiscalDocument",
    "PosFiscalAttempt",
    "PosFiscalOutbox",
    "PosFiscalCallback",
    "PosFiscalStateEvent",
    "PosFiscalArtifact",
    "PosFiscalDeliveryResult",
    "PosFiscalIntegrityIncident",
  ])
    assert.match(schema, new RegExp(`model ${model}\\b`));

  assert.match(schema, /saleId\s+Int\s+@map\("sale_id"\)/);
  assert.match(schema, /saleSnapshot\s+Json\s+@map\("sale_snapshot"\)/);
  assert.match(schema, /snapshotHash\s+String\s+@map\("snapshot_hash"\)/);
  assert.match(schema, /credentialRef\s+String\s+@map\("credential_ref"\)/);
  assert.match(schema, /profileVersion\s+Int\s+@map\("profile_version"\)/);
  assert.match(
    schema,
    /@@unique\(\[saleId, documentModel, purpose, revision\]\)/,
  );
});

test("PostgreSQL fecha contexto, centavos, estados, numbering e artefatos", () => {
  assert.match(migration, /pos_fiscal_documents_sale_context_fkey/);
  assert.match(migration, /pos_fiscal_documents_session_register_fkey/);
  assert.match(migration, /pos_fiscal_documents_terminal_register_fkey/);
  assert.match(migration, /pos_fiscal_documents_profile_context_fkey/);
  assert.match(migration, /"currency" = 'BRL'/);
  assert.match(migration, /"snapshot_hash" ~ '\^\[0-9a-f\]\{64\}\$'/);
  assert.match(migration, /"access_key" ~ '\^\[0-9\]\{44\}\$'/);
  assert.match(migration, /pos_fiscal_documents_number_key/);
  assert.match(migration, /local fiscal numbering is not enabled/);
  assert.match(
    migration,
    /production fiscal profile requires external homologation gate/,
  );
  assert.match(
    migration,
    /authorized fiscal document requires immutable XML artifact/,
  );
  assert.match(
    migration,
    /cancelled fiscal document requires cancellation artifact/,
  );
  assert.match(
    migration,
    /OLD\."status" = 'authorized' AND NEW\."status" IN \('cancellation_pending', 'manual_review'\)/,
  );
  assert.doesNotMatch(
    migration,
    /OLD\."status" = 'authorized'[^\n]+NEW\."status"[^\n]+'unknown'/,
  );
});

test("histórico fiscal é append-only e incidentes permanecem bloqueantes", () => {
  for (const table of [
    "callbacks",
    "state_events",
    "artifacts",
    "delivery_results",
  ])
    assert.match(migration, new RegExp(`pos_fiscal_${table}_immutable_guard`));
  assert.match(migration, /pos_fiscal_documents_delete_guard/);
  assert.match(migration, /pos_fiscal_profiles_delete_guard/);
  assert.match(migration, /production_blocking/);
  assert.match(migration, /final_state_contradiction/);
  assert.match(migration, /invalid fiscal integrity incident resolution/);
});

test("catálogo reconhece credencial fiscal sem alegar homologação", () => {
  const catalog = read("lib/integrations/catalog.ts");
  assert.match(catalog, /family: "fiscal"/);
  assert.match(catalog, /id: "fiscal_provider"/);
  assert.match(catalog, /Conectividade não equivale a homologação SEFAZ/);
  assert.match(catalog, /callback_secret/);
});

test("venda produz outbox fiscal atômico e worker interno não fabrica autorização", () => {
  const producer = read("lib/erp/pos-fiscal-persistence.ts");
  const route = read("app/api/internal/pdv/fiscal/outbox/[organizationId]/route.ts");
  const saleRoute = read("app/api/erp/pdv/route.ts");
  assert.match(saleRoute, /queuePosFiscalIssuanceForSale\(tx/);
  assert.match(producer, /status: "queued"/);
  assert.match(producer, /attempts:\s*\{\s*create:/);
  assert.match(producer, /outbox:\s*\{ create:/);
  assert.match(producer, /validateFiscalResult/);
  assert.match(producer, /persistFiscalArtifacts\(tx/);
  assert.match(producer, /const authorizedXml = result\.artifacts\.find\(\(artifact\) => artifact\.type === "authorized_xml"\)/);
  assert.match(producer, /if \(status === "authorized" && observation\)/);
  assert.match(route, /assertPosFiscalJobAuthorization\(request\)/);
  assert.match(route, /assertPosMutationRequest\(request\)/);
  assert.match(route, /readPosJson\(request, 65_536\)/);
  assert.doesNotMatch(route, /status\s*=\s*["']authorized/);
});

test("callback fiscal público autentica, limita e delega a aplicação monotônica", () => {
  const callbackRoute = read("app/api/webhooks/pos-fiscal/[organizationId]/[provider]/route.ts");
  const http = read("lib/erp/pos-fiscal-http.ts");
  const persistence = read("lib/erp/pos-fiscal-persistence.ts");
  assert.match(callbackRoute, /persistentRateLimit/);
  assert.match(callbackRoute, /verifyAndParsePosFiscalCallback/);
  assert.match(callbackRoute, /acceptPosFiscalCallback/);
  assert.match(callbackRoute, /fiscal_callback_secret/);
  assert.match(http, /timingSafeEqual/);
  assert.match(http, /POS_FISCAL_CALLBACK_MAX_AGE_SECONDS/);
  assert.match(persistence, /payload divergente/);
  assert.match(persistence, /productionBlocking: true/);
  assert.match(persistence, /snapshot_mismatch/);
});
