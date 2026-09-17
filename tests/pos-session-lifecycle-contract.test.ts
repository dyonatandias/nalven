import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const schema = readFileSync("prisma/tenant/schema.prisma", "utf8");
const migration = readFileSync(
  "prisma/tenant/migrations/20260829180000_pos_session_handoff/migration.sql",
  "utf8",
);
const lifecycleEventMigration = readFileSync(
  "prisma/tenant/migrations/20260829305000_pos_session_lifecycle_zero_events/migration.sql",
  "utf8",
);
const route = readFileSync(
  "app/api/erp/pdv/session-lifecycle/route.ts",
  "utf8",
);
const domain = readFileSync("lib/erp/pos-session-lifecycle.ts", "utf8");
const workspace = readFileSync("components/erp/pdv-workspace.tsx", "utf8");
const mainRoute = readFileSync("app/api/erp/pdv/route.ts", "utf8");
const operationalPrelock = readFileSync(
  "lib/erp/pos-manual-operational-prelock.ts",
  "utf8",
);

test("schema e migration preservam posse exclusiva durante pausa e passagem", () => {
  const model = between(
    schema,
    "model PosSessionHandoff",
    "\nmodel BankStatementImport",
  );
  for (const field of [
    "sessionId",
    "branchId",
    "registerId",
    "fromOperatorProfileId",
    "toOperatorProfileId",
    "state",
    "expiresAt",
    "revision",
    "requestIdempotencyKey",
    "requestHash",
    "heldSaleSnapshot",
    "transferredHeldSaleCount",
    "resolutionIdempotencyKey",
    "resolutionRequestHash",
  ])
    assert.match(model, new RegExp(`\\b${field}\\b`));
  assert.match(migration, /status" IN \('open', 'suspended', 'closing'\)/);
  assert.match(
    migration,
    /pos_session_handoffs_one_requested_per_session_idx[\s\S]*WHERE "state" = 'requested'/,
  );
  assert.match(migration, /distinct_operators_check/);
  assert.match(migration, /resolution_check/);
  assert.match(migration, /request_idempotency_key_key/);
  assert.match(migration, /resolution_idempotency_key_key/);
  assert.match(migration, /pos_session_handoffs_identity_guard/);
  assert.match(migration, /held_sale_count_check/);
  assert.match(migration, /ON DELETE RESTRICT/);
});

test("endpoint fecha origem, payload, RBAC, pagamento incerto, CAS e auditoria", () => {
  for (const evidence of [
    "assertSameOrigin(request)",
    "assertPosMutationRequest(request)",
    "readPosJson(request, 32_768)",
    "assertTenantWriteAccess(organization.id)",
    "enforcePosRateLimit",
    "branchUserAccess",
    "posRegisterAccess",
    "canOpen: true",
    "canSell: true",
    "assertNoUncertainPayment",
    "manual_review",
    "heldSaleSnapshot",
    "pos.held_cart.session_handoff_transferred",
    'isolationLevel: "Serializable"',
    "updateMany",
    "expectedVersion",
    "expectedHandoffRevision",
    "tenantAuditEvent.create",
    "cashRegisterEvent.create",
  ])
    assert.match(route, new RegExp(escape(evidence)));
  assert.match(route, /toOperatorProfileId: context\.profile\.id/);
  assert.match(route, /fromOperatorProfileId !== context\.profile\.id/);
  assert.match(route, /status: \{ in: \["open", "suspended", "closing"\] \}/);
  assert.doesNotMatch(route, /PAN|CVV|trackData|cardNumber/i);
});

test("writers de sessão e handoff preparam contexto T2 sob a ordem canônica", () => {
  for (const signature of [
    "pos_manual_prepare_session_transition_v1",
    "pos_manual_prepare_handoff_transition_v1",
  ])
    assert.match(operationalPrelock, new RegExp(signature));
  for (const action of [
    "suspend",
    "resume",
    "request",
    "accept",
    "cancel",
    "expire",
  ])
    assert.match(route, new RegExp(`action: "${action}"`));
  assert.match(route, /const handoffId = randomUUID\(\)/);
  assert.match(route, /id: handoffId,[\s\S]*sessionId: current\.id/);
  assert.match(
    route,
    /preparePosManualHandoffTransition\(tx, \{ action: "accept"[\s\S]*const session = await tx\.cashRegisterSession/,
  );
  assert.match(
    route,
    /preparePosManualHandoffTransition\(tx, \{ action: "cancel"[\s\S]*const session = await tx\.cashRegisterSession/,
  );
  assert.match(
    route,
    /preparePosManualHandoffTransition\(tx, \{ action: "expire"[\s\S]*const changed = await tx\.posSessionHandoff\.updateMany/,
  );
  assert.match(
    route,
    /if \(changed\.count !== 1\) throw new PosSessionLifecycleError\("A passagem expirada/,
  );
  assert.equal(
    mainRoute.match(
      /preparePosManualSessionTransition\(\s*tx,\s*\{\s*action:\s*"close"/g,
    )?.length,
    2,
  );
});

test("contrato exige allowlist, motivo, revisão e hash contextual", () => {
  assert.match(domain, /Campo inesperado na operação de turno/);
  assert.match(domain, /O motivo deve ter entre 8 e 500 caracteres/);
  assert.match(domain, /A passagem de turno foi alterada por outra operação/);
  assert.match(domain, /A passagem de turno expirou/);
  assert.match(domain, /createHash\("sha256"\)/);
});

test("eventos de lifecycle aceitam zero sem relaxar eventos monetários", () => {
  assert.match(lifecycleEventMigration, /"amount_cents" > 0/);
  for (const type of [
    "session_suspended",
    "session_resumed",
    "session_handoff_requested",
    "session_handoff_accepted",
    "session_handoff_cancelled",
  ])
    assert.match(lifecycleEventMigration, new RegExp(`'${type}'`));
  assert.doesNotMatch(
    lifecycleEventMigration,
    /'supply'|'withdrawal'|'sale'|'refund'/,
  );
  assert.match(route, /amountCents: 0/);
});

test("workspace bloqueia operação suspensa e exige aceite com identidade do destino", () => {
  assert.match(mainRoute, /status: \{ in: \["open", "suspended"\] \}/);
  for (const evidence of [
    "/api/erp/pdv/session-lifecycle",
    "Pausar / passar turno",
    "Turnos aguardando seu aceite",
    "Aceitar responsabilidade",
    "Turno pausado",
    "expectedSessionVersion",
    "expectedHandoffRevision",
    "Eles serão transferidos atomicamente por ID/revisão",
  ])
    assert.match(workspace, new RegExp(escape(evidence)));
  assert.match(
    workspace,
    /data\.session\.status === "suspended" \? <SuspendedSessionPanel/,
  );
  assert.match(
    workspace,
    /data\.session\?\.status === "open" && <div className="pos-shift-actions">/,
  );
});

function between(source: string, start: string, end: string) {
  const from = source.indexOf(start),
    to = source.indexOf(end, from + start.length);
  assert.notEqual(from, -1, `início ausente: ${start}`);
  assert.notEqual(to, -1, `fim ausente: ${end}`);
  return source.slice(from, to);
}

function escape(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
