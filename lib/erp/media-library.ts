import { MediaInputError, safeMediaFolder, safeMediaName } from "./media";

export const MEDIA_PAGE_SIZE = 24;
export const MEDIA_MAX_PAGE_SIZE = 100;
export const MEDIA_UPLOAD_BATCH_LIMIT = 20;
export const MEDIA_TENANT_QUOTA_BYTES = 2 * 1024 * 1024 * 1024;

export type MediaLibraryQuery = {
  query: string;
  kind: "" | "image" | "video" | "document";
  folder: string;
  trash: boolean;
  favorite: boolean;
  unused: boolean;
  missingAlt: boolean;
  tag: string;
  sort: "recent" | "updated" | "name" | "size";
  page: number;
  perPage: number;
};

export function parseMediaLibraryQuery(url: URL): MediaLibraryQuery {
  const kindValue = url.searchParams.get("kind") || "";
  const sortValue = url.searchParams.get("sort") || "recent";
  return {
    query: cleanText(url.searchParams.get("q"), 100),
    kind: ["image", "video", "document"].includes(kindValue)
      ? (kindValue as MediaLibraryQuery["kind"])
      : "",
    folder: cleanText(url.searchParams.get("folder"), 60),
    trash: url.searchParams.get("trash") === "true",
    favorite: url.searchParams.get("favorite") === "true",
    unused: url.searchParams.get("unused") === "true",
    missingAlt: url.searchParams.get("missing_alt") === "true",
    tag: normalizeTag(url.searchParams.get("tag")),
    sort: ["recent", "updated", "name", "size"].includes(sortValue)
      ? (sortValue as MediaLibraryQuery["sort"])
      : "recent",
    page: positiveInteger(url.searchParams.get("page"), 1),
    perPage: Math.min(
      positiveInteger(url.searchParams.get("per_page"), MEDIA_PAGE_SIZE),
      MEDIA_MAX_PAGE_SIZE,
    ),
  };
}

export function mediaTags(value: unknown): string[] {
  const source = Array.isArray(value) ? value : String(value || "").split(",");
  return Array.from(new Set(source.map(normalizeTag).filter(Boolean))).slice(
    0,
    12,
  );
}

export function mediaMetadata(
  value: Record<string, unknown>,
  fallback?: { name: string; folder: string },
) {
  return {
    name: safeMediaName(value.name, fallback?.name || "Arquivo"),
    description: nullableText(value.description, 600),
    altText: cleanText(value.altText, 300),
    folder: safeMediaFolder(value.folder || fallback?.folder),
    tags: mediaTags(value.tags),
    expiresAt: optionalDate(value.expiresAt),
  };
}

export function mediaIds(value: unknown): string[] {
  if (!Array.isArray(value))
    throw new MediaInputError("Selecione ao menos um arquivo.");
  const ids = Array.from(
    new Set(value.map(String).filter((id) => /^[a-z0-9_-]{8,64}$/i.test(id))),
  );
  if (!ids.length) throw new MediaInputError("Selecione ao menos um arquivo.");
  if (ids.length > MEDIA_MAX_PAGE_SIZE)
    throw new MediaInputError("Selecione no máximo 100 arquivos por operação.");
  return ids;
}

export type ByteRange = { start: number; end: number };

export function parseMediaRange(
  header: string | null,
  size: number,
): ByteRange | null {
  if (!header) return null;
  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!match || size <= 0)
    throw new MediaInputError("Intervalo de bytes inválido.", 416);
  const [, rawStart, rawEnd] = match;
  if (!rawStart && !rawEnd)
    throw new MediaInputError("Intervalo de bytes inválido.", 416);

  let start: number;
  let end: number;
  if (!rawStart) {
    const suffix = Number(rawEnd);
    if (!Number.isSafeInteger(suffix) || suffix <= 0)
      throw new MediaInputError("Intervalo de bytes inválido.", 416);
    start = Math.max(size - suffix, 0);
    end = size - 1;
  } else {
    start = Number(rawStart);
    end = rawEnd ? Number(rawEnd) : size - 1;
    if (
      !Number.isSafeInteger(start) ||
      !Number.isSafeInteger(end) ||
      start < 0 ||
      start > end ||
      start >= size
    ) {
      throw new MediaInputError("Intervalo de bytes inválido.", 416);
    }
    end = Math.min(end, size - 1);
  }
  return { start, end };
}

export function mediaDisposition(kind: string, mimeType: string) {
  return kind === "image" || kind === "video" || mimeType === "application/pdf"
    ? "inline"
    : "attachment";
}

function cleanText(value: unknown, maximum: number) {
  return String(value || "")
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .trim()
    .slice(0, maximum);
}

function nullableText(value: unknown, maximum: number) {
  return cleanText(value, maximum) || null;
}

function normalizeTag(value: unknown) {
  return cleanText(value, 32).toLocaleLowerCase("pt-BR").replace(/\s+/g, " ");
}

function positiveInteger(value: unknown, fallback: number) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function optionalDate(value: unknown) {
  const text = cleanText(value, 30);
  if (!text) return null;
  const date = new Date(`${text.slice(0, 10)}T23:59:59.999Z`);
  if (Number.isNaN(date.getTime()))
    throw new MediaInputError("Data de expiração inválida.");
  return date;
}
