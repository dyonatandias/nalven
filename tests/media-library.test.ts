import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  mediaIds,
  mediaMetadata,
  mediaTags,
  parseMediaLibraryQuery,
  parseMediaRange,
} from "../lib/erp/media-library";

test("consulta normaliza filtros, ordenação e limita a paginação", () => {
  const query = parseMediaLibraryQuery(
    new URL(
      "https://erp.test/api?q= campanha &kind=image&favorite=true&unused=true&tag= Social &sort=size&page=3&per_page=999",
    ),
  );
  assert.equal(query.query, "campanha");
  assert.equal(query.kind, "image");
  assert.equal(query.favorite, true);
  assert.equal(query.unused, true);
  assert.equal(query.tag, "social");
  assert.equal(query.sort, "size");
  assert.equal(query.page, 3);
  assert.equal(query.perPage, 100);
  assert.equal(
    parseMediaLibraryQuery(new URL("https://erp.test/api?kind=exe&sort=sql"))
      .kind,
    "",
  );
});

test("metadados removem controles, deduplicam etiquetas e validam expiração", () => {
  assert.deepEqual(mediaTags(" Campanha, campanha,  Social , Produto "), [
    "campanha",
    "social",
    "produto",
  ]);
  const metadata = mediaMetadata({
    name: "  Banner\u0000 novo ",
    folder: "Campanhas",
    description: " Peça principal ",
    tags: "Site, Campanha",
    expiresAt: "2026-12-31",
  });
  assert.equal(metadata.name, "Banner  novo");
  assert.equal(metadata.folder, "Campanhas");
  assert.deepEqual(metadata.tags, ["site", "campanha"]);
  assert.equal(metadata.expiresAt?.toISOString(), "2026-12-31T23:59:59.999Z");
  assert.throws(
    () =>
      mediaMetadata(
        { expiresAt: "não-é-data" },
        { name: "A", folder: "Geral" },
      ),
    /expiração/i,
  );
});

test("operações em lote aceitam apenas IDs limitados e válidos", () => {
  assert.deepEqual(
    mediaIds(["asset_12345678", "asset_12345678", "asset-87654321"]),
    ["asset_12345678", "asset-87654321"],
  );
  assert.throws(() => mediaIds([]), /Selecione/);
  assert.throws(() => mediaIds(["x", "../../segredo"]), /Selecione/);
  assert.throws(
    () =>
      mediaIds(
        Array.from(
          { length: 101 },
          (_, index) => `asset_${String(index).padStart(8, "0")}`,
        ),
      ),
    /100/,
  );
});

test("range HTTP suporta início, fim e sufixo sem ultrapassar o arquivo", () => {
  assert.deepEqual(parseMediaRange("bytes=10-19", 100), { start: 10, end: 19 });
  assert.deepEqual(parseMediaRange("bytes=90-", 100), { start: 90, end: 99 });
  assert.deepEqual(parseMediaRange("bytes=-12", 100), { start: 88, end: 99 });
  assert.deepEqual(parseMediaRange("bytes=90-999", 100), {
    start: 90,
    end: 99,
  });
  assert.throws(
    () => parseMediaRange("bytes=100-101", 100),
    (error) =>
      error instanceof Error && "status" in error && error.status === 416,
  );
});

test("APIs protegem tenant, origem, escrita, download e erros inesperados", async () => {
  const [route, detail, version, file, folders] = await Promise.all([
    readFile(
      new URL("../app/api/erp/library/route.ts", import.meta.url),
      "utf8",
    ),
    readFile(
      new URL("../app/api/erp/library/[id]/route.ts", import.meta.url),
      "utf8",
    ),
    readFile(
      new URL("../app/api/erp/library/[id]/versions/route.ts", import.meta.url),
      "utf8",
    ),
    readFile(new URL("../lib/erp/media-response.ts", import.meta.url), "utf8"),
    readFile(
      new URL("../app/api/erp/library/folders/route.ts", import.meta.url),
      "utf8",
    ),
  ]);
  for (const source of [route, detail, version, folders])
    assert.match(source, /assertTenantPermission/);
  for (const source of [route, version, folders])
    assert.match(source, /assertSameOrigin\(request\)/);
  assert.match(route, /assertTenantWriteAccess/);
  assert.match(route, /private, no-store/);
  assert.match(detail, /private, no-store/);
  assert.match(file, /Accept-Ranges/);
  assert.match(file, /Content-Range/);
  assert.doesNotMatch(route, /error instanceof Error \? error\.message/);
  assert.doesNotMatch(folders, /error instanceof Error \? error\.message/);
});

test("persistência cobre favoritos pessoais, etiquetas, expiração e versões", async () => {
  const [schema, migration] = await Promise.all([
    readFile(
      new URL("../prisma/tenant/schema.prisma", import.meta.url),
      "utf8",
    ),
    readFile(
      new URL(
        "../prisma/tenant/migrations/20260903195000_media_library_control_center/migration.sql",
        import.meta.url,
      ),
      "utf8",
    ),
  ]);
  for (const model of ["MediaAssetFavorite", "MediaAssetVersion"])
    assert.match(schema, new RegExp(`model ${model}`));
  for (const marker of [
    "tags",
    "expires_at",
    "media_asset_favorites",
    "media_asset_versions",
    "USING GIN",
    "ON DELETE CASCADE",
  ])
    assert.match(migration, new RegExp(marker));
});

test("interface cobre operação completa e responsividade sem microtexto", async () => {
  const [component, css, seed] = await Promise.all([
    readFile(
      new URL("../components/erp/media-library.tsx", import.meta.url),
      "utf8",
    ),
    readFile(
      new URL("../components/erp/media-library.module.css", import.meta.url),
      "utf8",
    ),
    readFile(
      new URL("../scripts/seed-demo-library.ts", import.meta.url),
      "utf8",
    ),
  ]);
  for (const label of [
    "Biblioteca inteligente",
    "Armazenamento",
    "Qualidade e SEO",
    "Favoritos",
    "Sem uso",
    "Mover para pasta",
    "Histórico de versões",
    "Copiar link interno",
    "Nova versão",
  ])
    assert.match(component, new RegExp(label, "i"));
  assert.match(component, /aria-label/);
  assert.match(component, /role="alert"/);
  assert.match(css, /@media\s*\(max-width:\s*420px\)/);
  assert.match(css, /prefers-reduced-motion/);
  assert.doesNotMatch(css, /font-size:\s*[4-9](?:\.\d+)?px/);
  assert.match(seed, /NALVEN_ALLOW_DEMO_LIBRARY_SEED/);
  assert.match(seed, /nalven_t_demo_runtime/);
  for (const marker of [
    "favorites",
    "versions",
    "duplicidade",
    "lixeira",
    "vídeos",
  ])
    assert.match(seed, new RegExp(marker, "i"));
});
