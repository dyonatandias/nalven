import assert from "node:assert/strict";
import test from "node:test";
import { posRatePolicy } from "../lib/erp/pos-http";
import { classifyPosValueAging } from "../lib/erp/pos-value-liability";
import { isPosValueLifecycleSerializationConflict, lifecycleOperationKey, POS_VALUE_LIFECYCLE_LIMITS } from "../lib/erp/pos-value-lifecycle";
import { assertPosValueLifecycleJobAuthorization, parsePosValueLifecycleJobInput, PosValueLifecycleHttpError, POS_VALUE_JOB_LIMITS } from "../lib/erp/pos-value-lifecycle-http";

test("aging do passivo possui limites determinísticos e não produz idade negativa", () => {
  const now = new Date("2026-08-29T12:00:00.000Z"), days = (value: number) => new Date(now.valueOf() - value * 86_400_000);
  assert.equal(classifyPosValueAging(new Date(now.valueOf() + 60_000), now), "age_0_30");
  assert.equal(classifyPosValueAging(days(30), now), "age_0_30");
  assert.equal(classifyPosValueAging(days(31), now), "age_31_90");
  assert.equal(classifyPosValueAging(days(90), now), "age_31_90");
  assert.equal(classifyPosValueAging(days(91), now), "age_91_365");
  assert.equal(classifyPosValueAging(days(365), now), "age_91_365");
  assert.equal(classifyPosValueAging(days(366), now), "age_over_365");
  assert.throws(() => classifyPosValueAging(new Date("invalid"), now), /inválida/);
});

test("payload do job usa allowlist, cursor e limites estritos sem coerção", () => {
  assert.deepEqual(parsePosValueLifecycleJobInput({ action: "value.lifecycle.sweep" }), {
    action: "value.lifecycle.sweep",
    organizationLimit: POS_VALUE_JOB_LIMITS.defaultOrganizationLimit,
    itemLimit: POS_VALUE_JOB_LIMITS.defaultItemLimit,
    afterOrganizationId: null,
  });
  assert.deepEqual(parsePosValueLifecycleJobInput({ action: "value.lifecycle.sweep", organizationLimit: 1, itemLimit: 100, afterOrganizationId: "org-demo" }).afterOrganizationId, "org-demo");
  assert.throws(() => parsePosValueLifecycleJobInput({ action: "value.lifecycle.sweep", extra: true }), /não permitido/);
  assert.throws(() => parsePosValueLifecycleJobInput({ action: "value.lifecycle.sweep", itemLimit: "50" }), PosValueLifecycleHttpError);
  assert.throws(() => parsePosValueLifecycleJobInput({ action: "value.lifecycle.sweep", itemLimit: POS_VALUE_JOB_LIMITS.maximumItemLimit + 1 }), /entre 1 e 100/);
  assert.throws(() => parsePosValueLifecycleJobInput({ action: "outro" }), /Ação interna/);
});

test("job interno exige Bearer configurado forte e compara o valor completo", () => {
  const token = "job-token-local-com-mais-de-trinta-e-dois-bytes-0001";
  const request = (value: string) => new Request("https://erp.example.test/api/internal/pdv/value-accounts/sweep", { method: "POST", headers: { authorization: value } });
  assert.doesNotThrow(() => assertPosValueLifecycleJobAuthorization(request(`Bearer ${token}`), token));
  assert.throws(() => assertPosValueLifecycleJobAuthorization(request(`Bearer ${token}x`), token), (error: unknown) => error instanceof PosValueLifecycleHttpError && error.status === 401);
  assert.throws(() => assertPosValueLifecycleJobAuthorization(request("Bearer curto"), "curto"), (error: unknown) => error instanceof PosValueLifecycleHttpError && error.status === 401);
  assert.throws(() => assertPosValueLifecycleJobAuthorization(request(`Basic ${token}`), token), PosValueLifecycleHttpError);
});

test("chaves do lifecycle são estáveis, limitadas e não carregam o identificador aberto", () => {
  const identifier = "reservation-sensitive-operational-id-00000000000000000001";
  const first = lifecycleOperationKey("release", identifier), replay = lifecycleOperationKey("release", identifier);
  assert.equal(replay, first);
  assert.match(first, /^value\.lifecycle\.release:[0-9a-f]{48}$/);
  assert.ok(first.length <= 200);
  assert.ok(!first.includes(identifier));
  assert.notEqual(first, lifecycleOperationKey("expire", identifier));
  assert.equal(POS_VALUE_LIFECYCLE_LIMITS.serializationRetries, 3);
  assert.deepEqual(posRatePolicy("value.lifecycle.sweep"), { limit: 6, seconds: 60 });
});

test("retry reconhece conflito Prisma e SQLSTATE bruto do adapter PostgreSQL", () => {
  assert.equal(isPosValueLifecycleSerializationConflict({ code: "P2034" }), true);
  assert.equal(isPosValueLifecycleSerializationConflict({ code: "P2010", meta: { code: "40001" } }), true);
  assert.equal(isPosValueLifecycleSerializationConflict({ code: "P2010", cause: { code: "40P01" } }), true);
  assert.equal(isPosValueLifecycleSerializationConflict({ code: "P2002", meta: { code: "23505" } }), false);
});
