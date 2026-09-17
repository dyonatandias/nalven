import assert from "node:assert/strict";
import test from "node:test";
import { addDays, classifyPage, eachDate, normalizePath, normalizePeriod, referrerSource, shouldTrackPath } from "../lib/analytics/core";

test("normaliza períodos sem criar uma data extra", () => {
  assert.equal(normalizePeriod("week"), "7d");
  assert.equal(normalizePeriod("inválido"), "7d");
  assert.equal(eachDate("2026-08-22", "2026-08-28").length, 7);
  assert.equal(addDays("2026-08-28", -6), "2026-08-22");
});

test("classifica somente jornadas públicas úteis", () => {
  assert.equal(classifyPage("/"), "home");
  assert.equal(classifyPage("/cadastro?plano=scale"), "signup");
  assert.equal(classifyPage("/blog/gestao-financeira"), "blog");
  assert.equal(classifyPage("/rastrear-pedido"), "tracking");
  assert.equal(shouldTrackPath("/admin/analytics"), false);
  assert.equal(shouldTrackPath("/erp"), false);
  assert.equal(shouldTrackPath("/blog"), true);
});

test("remove query strings e tokens sensíveis", () => {
  assert.equal(normalizePath("/cadastro?email=pessoa@example.com"), "/cadastro");
  assert.equal(normalizePath("/redefinir-senha/token-secreto?email=x"), "/redefinir-senha/:token");
  assert.equal(normalizePath("/avaliar/token-secreto?email=x"), "/avaliar/:token");
  assert.equal(normalizePath("/convite/token-secreto"), "/convite/:token");
  for (const path of ["/avaliar/token-secreto", "/redefinir-senha/token-secreto", "/convite/token-secreto", "/CONVITE/token-secreto", "/api/auth/login"])
    assert.equal(shouldTrackPath(path), false, path);
});

test("mantém somente o domínio da origem", () => {
  assert.equal(referrerSource("https://www.google.com/search?q=nalven", "nalven.com.br"), "google.com");
  assert.equal(referrerSource("https://nalven.com.br/blog", "nalven.com.br"), "direct");
  assert.equal(referrerSource("", "nalven.com.br"), "direct");
});
