import assert from "node:assert/strict";
import test from "node:test";
import { buildPosCatalogPage, parsePosCatalogPageRequest, PosCatalogPaginationError } from "../lib/erp/pos-catalog-pagination";

test("catálogo pagina sem limite silencioso e continua pelo cursor opaco", () => {
  const request = parsePosCatalogPageRequest(new URLSearchParams({ resource: "products", q: " café ", limit: "20" }));
  const first = buildPosCatalogPage(request, Array.from({ length: 21 }, (_, index) => ({ id: index + 1, name: `Produto ${index + 1}` })));

  assert.equal(request.query, "café");
  assert.equal(first.items.length, 20);
  assert.equal(first.page.hasMore, true);
  assert.ok(first.page.nextCursor);

  const continuation = parsePosCatalogPageRequest(new URLSearchParams({ resource: "products", q: "café", limit: "20", cursor: first.page.nextCursor! }));
  assert.equal(continuation.cursorId, 20);
});

test("cursor fica vinculado ao recurso e ao texto da busca", () => {
  const request = parsePosCatalogPageRequest(new URLSearchParams({ resource: "customers", q: "Maria" }));
  const page = buildPosCatalogPage(request, Array.from({ length: 26 }, (_, index) => ({ id: index + 1 })));

  assert.throws(
    () => parsePosCatalogPageRequest(new URLSearchParams({ resource: "customers", q: "Mariana", cursor: page.page.nextCursor! })),
    (error) => error instanceof PosCatalogPaginationError && error.message === "O cursor não pertence a esta busca.",
  );
  assert.throws(
    () => parsePosCatalogPageRequest(new URLSearchParams({ resource: "products", q: "Maria", cursor: page.page.nextCursor! })),
    PosCatalogPaginationError,
  );
});

test("limites, recurso e cursor malformado falham de modo explícito", () => {
  assert.throws(() => parsePosCatalogPageRequest(new URLSearchParams({ resource: "orders" })), PosCatalogPaginationError);
  assert.throws(() => parsePosCatalogPageRequest(new URLSearchParams({ resource: "products", limit: "51" })), PosCatalogPaginationError);
  assert.throws(() => parsePosCatalogPageRequest(new URLSearchParams({ resource: "customers", cursor: "não-é-cursor" })), PosCatalogPaginationError);
  assert.throws(() => parsePosCatalogPageRequest(new URLSearchParams({ resource: "customers", branchId: "2" })), PosCatalogPaginationError);
});

test("vendas continuam além das vinte recentes e não aceitam cursores de outros recursos", () => {
  const request = parsePosCatalogPageRequest(new URLSearchParams({ resource: "sales", q: "VEN", limit: "20" }));
  const page = buildPosCatalogPage(request, Array.from({ length: 21 }, (_, index) => ({ id: 100 - index })));
  assert.equal(page.items.length, 20);
  assert.equal(parsePosCatalogPageRequest(new URLSearchParams({ resource: "sales", q: "VEN", cursor: page.page.nextCursor! })).cursorId, 81);
  assert.throws(() => parsePosCatalogPageRequest(new URLSearchParams({ resource: "products", q: "VEN", cursor: page.page.nextCursor! })), PosCatalogPaginationError);
});
