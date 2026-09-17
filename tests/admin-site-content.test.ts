import assert from "node:assert/strict";
import test from "node:test";
import { isSiteContentValue } from "../lib/admin-site-content";

test("conteúdo do site valida textos e recursos sem aceitar estruturas arbitrárias", () => {
  assert.equal(isSiteContentValue("hero.title", "textarea", "Título"), true);
  assert.equal(isSiteContentValue("hero.title", "textarea", { title: "Título" }), false);
  assert.equal(isSiteContentValue("brand.name", "text", "x".repeat(501)), false);
  assert.equal(isSiteContentValue("features.items", "json", [{ title: "Vendas", description: "Gestão de vendas" }]), true);
  assert.equal(isSiteContentValue("features.items", "json", [{ title: "Vendas", description: 10 }]), false);
  assert.equal(isSiteContentValue("features.items", "json", [{ title: "Vendas", description: "Texto", script: "indesejado" }]), false);
  assert.equal(isSiteContentValue("features.items", "json", Array.from({ length: 51 }, () => ({ title: "Título", description: "Texto" }))), false);
  assert.equal(isSiteContentValue("unknown", "json", { value: true }), false);
});
