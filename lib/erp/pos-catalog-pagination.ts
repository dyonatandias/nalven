import { Buffer } from "node:buffer";

export const POS_CATALOG_PAGE_MAX = 50;
export const POS_CATALOG_PAGE_DEFAULT = 24;
export const POS_CUSTOMER_PAGE_DEFAULT = 25;

export type PosCatalogResource = "products" | "customers" | "sales";

export class PosCatalogPaginationError extends Error {}

export type PosCatalogPageRequest = {
  resource: PosCatalogResource;
  query: string;
  limit: number;
  cursorId: number | null;
};

type CursorPayload = {
  version: 1;
  resource: PosCatalogResource;
  query: string;
  id: number;
};

export function parsePosCatalogPageRequest(params: URLSearchParams): PosCatalogPageRequest {
  const allowed = new Set(["resource", "q", "limit", "cursor"]);
  for (const key of params.keys()) {
    if (!allowed.has(key) || params.getAll(key).length > 1) throw new PosCatalogPaginationError(`Parâmetro de consulta inválido: ${key}.`);
  }
  const resource = params.get("resource");
  if (resource !== "products" && resource !== "customers" && resource !== "sales") throw new PosCatalogPaginationError("Recurso de consulta do PDV inválido.");

  const rawQuery = params.get("q") ?? "";
  const query = rawQuery.normalize("NFKC").trim();
  if (query.length > 100) throw new PosCatalogPaginationError("A busca do PDV deve ter no máximo 100 caracteres.");

  const defaultLimit = resource === "products" ? POS_CATALOG_PAGE_DEFAULT : POS_CUSTOMER_PAGE_DEFAULT;
  const rawLimit = params.get("limit");
  const limit = rawLimit == null || rawLimit === "" ? defaultLimit : Number(rawLimit);
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > POS_CATALOG_PAGE_MAX) throw new PosCatalogPaginationError(`O tamanho da página deve estar entre 1 e ${POS_CATALOG_PAGE_MAX}.`);

  const rawCursor = params.get("cursor");
  if (!rawCursor) return { resource, query, limit, cursorId: null };
  if (rawCursor.length > 512) throw new PosCatalogPaginationError("Cursor de continuação inválido.");

  let cursor: CursorPayload;
  try {
    cursor = JSON.parse(Buffer.from(rawCursor, "base64url").toString("utf8")) as CursorPayload;
  } catch {
    throw new PosCatalogPaginationError("Cursor de continuação inválido.");
  }
  if (cursor.version !== 1 || cursor.resource !== resource || cursor.query !== query || !Number.isSafeInteger(cursor.id) || cursor.id <= 0) {
    throw new PosCatalogPaginationError("O cursor não pertence a esta busca.");
  }
  return { resource, query, limit, cursorId: cursor.id };
}

export function buildPosCatalogPage<T extends { id: number }>(request: PosCatalogPageRequest, rows: T[]) {
  const hasMore = rows.length > request.limit;
  const items = hasMore ? rows.slice(0, request.limit) : rows;
  const last = items.at(-1);
  const nextCursor = hasMore && last ? encodeCursor({ version: 1, resource: request.resource, query: request.query, id: last.id }) : null;
  return {
    resource: request.resource,
    query: request.query,
    items,
    page: { limit: request.limit, hasMore, nextCursor },
  };
}

function encodeCursor(cursor: CursorPayload) {
  return Buffer.from(JSON.stringify(cursor), "utf8").toString("base64url");
}
