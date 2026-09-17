import assert from "node:assert/strict";
import test from "node:test";
import { nextPosModalFocusIndex, PosModalIsolationStack, type PosModalIsolationTarget } from "../lib/erp/pos-modal-stack";

class FakeTarget implements PosModalIsolationTarget {
  inert: boolean;
  private readonly attributes = new Map<string, string>();

  constructor(readonly name: string, input: { inert?: boolean; ariaHidden?: string } = {}) {
    this.inert = input.inert ?? false;
    if (input.ariaHidden != null) this.attributes.set("aria-hidden", input.ariaHidden);
  }

  getAttribute(name: string) { return this.attributes.get(name) ?? null; }
  setAttribute(name: string, value: string) { this.attributes.set(name, value); }
  removeAttribute(name: string) { this.attributes.delete(name); }
}

test("primeiro modal isola fundo e fechamento restaura valores anteriores exatos", () => {
  const app = new FakeTarget("app", { ariaHidden: "false" });
  const auxiliary = new FakeTarget("auxiliary", { inert: true });
  const dialog = new FakeTarget("dialog");
  const stack = new PosModalIsolationStack(() => [app, auxiliary, app]);
  stack.open("one", dialog);
  assert.equal(stack.depth, 1);
  assert.deepEqual([app.inert, app.getAttribute("aria-hidden")], [true, "true"]);
  assert.deepEqual([auxiliary.inert, auxiliary.getAttribute("aria-hidden")], [true, "true"]);
  assert.deepEqual([dialog.inert, dialog.getAttribute("aria-hidden")], [false, null]);

  assert.deepEqual(stack.close("one"), { removed: true, wasTop: true, top: null });
  assert.deepEqual([app.inert, app.getAttribute("aria-hidden")], [false, "false"]);
  assert.deepEqual([auxiliary.inert, auxiliary.getAttribute("aria-hidden")], [true, null]);
});

test("pilha aninhada oculta pai, restaura pai ao fechar filho e aceita desmontagem fora de ordem", () => {
  const app = new FakeTarget("app"), first = new FakeTarget("first"), second = new FakeTarget("second"), third = new FakeTarget("third");
  const stack = new PosModalIsolationStack(() => [app]);
  stack.open("first", first);
  stack.open("second", second);
  assert.deepEqual([first.inert, first.getAttribute("aria-hidden")], [true, "true"]);
  assert.deepEqual([second.inert, second.getAttribute("aria-hidden")], [false, null]);
  assert.equal(stack.isTop("second"), true);

  const childClose = stack.close("second");
  assert.deepEqual([childClose.wasTop, childClose.top], [true, first]);
  assert.deepEqual([first.inert, first.getAttribute("aria-hidden")], [false, null]);

  stack.open("second", second);
  stack.open("third", third);
  const middleClose = stack.close("second");
  assert.equal(middleClose.wasTop, false);
  assert.equal(stack.top(), third);
  assert.deepEqual([third.inert, third.getAttribute("aria-hidden")], [false, null]);
  stack.close("third");
  assert.equal(stack.top(), first);
  stack.close("first");
  assert.deepEqual([app.inert, app.getAttribute("aria-hidden")], [false, null]);
});

test("Tab e Shift+Tab ciclam inclusive quando o foco começa fora", () => {
  assert.equal(nextPosModalFocusIndex(3, -1, false), 0);
  assert.equal(nextPosModalFocusIndex(3, -1, true), 2);
  assert.equal(nextPosModalFocusIndex(3, 0, true), 2);
  assert.equal(nextPosModalFocusIndex(3, 2, false), 0);
  assert.equal(nextPosModalFocusIndex(3, 1, false), 2);
  assert.equal(nextPosModalFocusIndex(0, -1, false), -1);
  assert.throws(() => nextPosModalFocusIndex(-1, 0, false), /quantidade/);
});

test("token duplicado falha e fechamento desconhecido não altera a pilha", () => {
  const stack = new PosModalIsolationStack(() => [new FakeTarget("app")]);
  const dialog = new FakeTarget("dialog");
  stack.open("modal", dialog);
  assert.throws(() => stack.open("modal", dialog), /já está ativo/);
  assert.deepEqual(stack.close("missing"), { removed: false, wasTop: false, top: dialog });
  assert.equal(stack.depth, 1);
});
