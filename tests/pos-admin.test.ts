import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import {
  hashPosAdminInput,
  parsePosAdminInput,
  PosAdminError,
} from "../lib/erp/pos-admin";

const projectRoot = fileURLToPath(new URL("..", import.meta.url));

test("normaliza cadastro de caixa sem aceitar mass assignment", () => {
  const input = parsePosAdminInput({
    action: "register.create",
    idempotencyKey: key("register"),
    branchId: 2,
    warehouseId: null,
    code: "cx-01",
    name: " Caixa frente ",
    settings: { blindClose: true },
  });
  assert.deepEqual(input, {
    action: "register.create",
    idempotencyKey: key("register"),
    branchId: 2,
    warehouseId: null,
    code: "CX-01",
    name: "Caixa frente",
    settings: { blindClose: true },
  });
  assert.throws(
    () =>
      parsePosAdminInput({
        action: "register.create",
        idempotencyKey: key("extra"),
        branchId: 2,
        code: "CX",
        name: "Caixa",
        status: "active",
      }),
    (error) =>
      error instanceof PosAdminError &&
      error.message.includes("Campo não permitido"),
  );
});

test("edições são PATCH explícito e preservam null como desvinculação", () => {
  assert.deepEqual(
    parsePosAdminInput({
      action: "connector.update",
      idempotencyKey: key("connector"),
      connectorId: "con_123",
      registerId: null,
      credentialRef: null,
    }),
    {
      action: "connector.update",
      idempotencyKey: key("connector"),
      connectorId: "con_123",
      registerId: null,
      credentialRef: null,
    },
  );
  assert.throws(
    () =>
      parsePosAdminInput({
        action: "terminal.update",
        idempotencyKey: key("empty"),
        terminalId: "terminal_123",
      }),
    (error) =>
      error instanceof PosAdminError &&
      error.message.includes("ao menos um campo"),
  );
});

test("ativação de rota é explícita e exige conta homologada no servidor", () => {
  assert.deepEqual(
    parsePosAdminInput({
      action: "connector.activate",
      idempotencyKey: key("activate"),
      connectorId: "con_123",
    }),
    {
      action: "connector.activate",
      idempotencyKey: key("activate"),
      connectorId: "con_123",
    },
  );
  const route = readFileSync(
    join(projectRoot, "app/api/erp/pdv/admin/route.ts"),
    "utf8",
  );
  assert.match(route, /credential\.lastTestOk !== true/);
  assert.match(route, /credential\.provider\.family !== "payment"/);
});

test("chave idempotente tem comprimento e alfabeto restritos", () => {
  assert.throws(
    () =>
      parsePosAdminInput({
        action: "register.deactivate",
        idempotencyKey: "short",
        registerId: 1,
      }),
    PosAdminError,
  );
  assert.throws(
    () =>
      parsePosAdminInput({
        action: "register.deactivate",
        idempotencyKey: "invalid key with spaces",
        registerId: 1,
      }),
    PosAdminError,
  );
  assert.equal(
    parsePosAdminInput({
      action: "register.deactivate",
      idempotencyKey: key("valid"),
      registerId: 1,
    }).idempotencyKey,
    key("valid"),
  );
});

test("configuração recusa segredos e dados de cartão mesmo aninhados", () => {
  for (const [index, settings] of [
    { apiKey: "secret" },
    { nested: { private_key: "secret" } },
    { payment: { cardNumber: "4111111111111111" } },
  ].entries()) {
    assert.throws(
      () =>
        parsePosAdminInput({
          action: "terminal.create",
          idempotencyKey: key(`secret-${index}`),
          registerId: 1,
          code: "T1",
          name: "Terminal",
          settings,
        }),
      (error) =>
        error instanceof PosAdminError &&
        error.message.includes("segredos ou dados de cartão"),
    );
  }
});

test("configuração limita bytes, profundidade e chaves perigosas", () => {
  assert.throws(
    () =>
      parsePosAdminInput({
        action: "device.create",
        idempotencyKey: key("large"),
        terminalId: "terminal_1",
        type: "scanner",
        name: "Leitor",
        provider: null,
        vendorId: null,
        productId: null,
        serialNumber: null,
        settings: { label: "ç".repeat(1_100) },
      }),
    (error) =>
      error instanceof PosAdminError &&
      error.message.includes("texto muito longo"),
  );
  const dangerous = JSON.parse('{"__proto__":{"polluted":true}}');
  assert.throws(
    () =>
      parsePosAdminInput({
        action: "terminal.create",
        idempotencyKey: key("proto"),
        registerId: 1,
        code: "T1",
        name: "Terminal",
        settings: dangerous,
      }),
    PosAdminError,
  );
});

test("hash é canônico, cobre contexto e não depende da chave", () => {
  const first = parsePosAdminInput({
    action: "connector.create",
    idempotencyKey: key("one"),
    branchId: 1,
    registerId: null,
    provider: "provider-x",
    type: "payment",
    mode: "local_agent",
    credentialRef: null,
    settings: { z: 1, a: true },
  });
  const second = parsePosAdminInput({
    settings: { a: true, z: 1 },
    credentialRef: null,
    mode: "local_agent",
    type: "payment",
    provider: "provider-x",
    registerId: null,
    branchId: 1,
    idempotencyKey: key("two"),
    action: "connector.create",
  });
  const changed = parsePosAdminInput({
    settings: { a: true, z: 1 },
    credentialRef: null,
    mode: "local_agent",
    type: "payment",
    provider: "provider-x",
    registerId: 2,
    branchId: 1,
    idempotencyKey: key("three"),
    action: "connector.create",
  });
  assert.equal(hashPosAdminInput(first), hashPosAdminInput(second));
  assert.notEqual(hashPosAdminInput(first), hashPosAdminInput(changed));
  assert.match(hashPosAdminInput(first), /^[0-9a-f]{64}$/);
});

test("contrato persistente torna a chave única e a conclusão atômica", () => {
  const migration = readFileSync(
    join(
      projectRoot,
      "prisma/tenant/migrations/20260828104500_pos_admin_mutations/migration.sql",
    ),
    "utf8",
  );
  const route = readFileSync(
    join(projectRoot, "app/api/erp/pdv/admin/route.ts"),
    "utf8",
  );
  assert.match(migration, /CREATE UNIQUE INDEX "pos_admin_mutations_key_key"/);
  assert.match(migration, /pos_admin_mutations_completion_check/);
  assert.match(
    migration,
    /pos_connectors_branch_id_register_id_type_provider_key"[\s\S]*NULLS NOT DISTINCT/,
  );
  assert.match(route, /isolationLevel:\s*"Serializable"/);
  assert.match(route, /tenantAuditEvent\.create/);
  assert.match(route, /\["owner", "admin"\]\.includes/);
  assert.match(route, /idempotency-replayed/);
});

test("DTO administrativo não devolve hashes, certificados ou referência da credencial", () => {
  const route = readFileSync(
    join(projectRoot, "app/api/erp/pdv/admin/route.ts"),
    "utf8",
  );
  const terminalDto = functionBlock(route, "terminalDto", "deviceDto");
  const connectorDto = functionBlock(route, "connectorDto", "defined");
  assert.doesNotMatch(terminalDto, /tokenHash|certificateFingerprint/);
  assert.doesNotMatch(connectorDto, /credentialRef:\s*value\.credentialRef/);
  assert.match(
    connectorDto,
    /credentialConfigured:\s*Boolean\(value\.credentialRef\)/,
  );
});

function key(suffix: string) {
  return `pos-admin-test:${suffix}:00000000`;
}
function functionBlock(source: string, start: string, next: string) {
  const from = source.indexOf(`function ${start}`),
    to = source.indexOf(`function ${next}`, from + 1);
  assert.ok(from >= 0 && to > from);
  return source.slice(from, to);
}
