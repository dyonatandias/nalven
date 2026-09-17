import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createElement } from "react";
import { renderToString } from "react-dom/server";
import test from "node:test";
import { PdvAccessibleModal } from "../components/erp/pdv-accessible-modal";

const root = join(import.meta.dirname, "..");
const component = readFileSync(join(root, "components/erp/pdv-accessible-modal.tsx"), "utf8");
const stack = readFileSync(join(root, "lib/erp/pos-modal-stack.ts"), "utf8");

test("renderização SSR não lê document nem tenta criar portal", () => {
  const html = renderToString(createElement(PdvAccessibleModal, {
    open: true,
    title: "Modal SSR",
    onRequestClose: () => undefined,
  }, createElement("p", null, "Conteúdo")));
  assert.equal(html, "");
});

test("componente declara diálogo nomeado/descrito e regiões locais", () => {
  for (const evidence of [
    'role="dialog"',
    'aria-modal="true"',
    "aria-labelledby={titleId}",
    "aria-describedby={descriptionId}",
    'role="alert"',
    'role="status"',
    'aria-live="assertive"',
    'aria-live="polite"',
    "createPortal",
  ]) assert.match(component, new RegExp(evidence.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
});

test("Escape, backdrop e botão respeitam busy e apenas o topo fecha", () => {
  assert.match(component, /event\.key === "Escape"/);
  assert.match(component, /if \(!busyRef\.current && closeOnEscape\)/);
  assert.match(component, /event\.target === event\.currentTarget && closeOnBackdrop/);
  assert.match(component, /if \(!busyRef\.current && modalStack\.isTop\(token\)\)/);
  assert.match(component, /disabled=\{busy\}/);
  assert.doesNotMatch(component, /\b(?:prompt|confirm)\s*\(/);
});

test("foco global cobre dentro/fora, retorno válido e pilha restaura isolamento", () => {
  for (const evidence of [
    'document.addEventListener("keydown", keydown, true)',
    'document.addEventListener("focusin", focusin, true)',
    "nextPosModalFocusIndex",
    "focusIntoModal",
    "validFocusReturn",
    "modalStack.open(token, dialog)",
    "modalStack.close(token)",
  ]) assert.match(component, new RegExp(evidence.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.match(stack, /target\.inert = true/);
  assert.match(stack, /setAttribute\("aria-hidden", "true"\)/);
  assert.match(stack, /snapshotValue\.target\.inert = snapshotValue\.inert/);
  assert.match(stack, /snapshotValue\.target\.removeAttribute\("aria-hidden"\)/);
});
