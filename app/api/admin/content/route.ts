import { localPath, PUBLIC_PAGES, reservedPath } from "@/lib/site/paths";
import { siteOrigin } from "@/lib/site/seo";
import { controlDb } from "@/db/control";
import { authErrorResponse, requireUser } from "@/lib/auth";
import { Prisma } from "@/generated/control/client";
import {
  enforceControlRateLimit,
  privateJson,
  readJsonObject,
} from "@/lib/http-security";

export async function GET(request: Request) {
  try {
    await requireUser("superadmin");
    const resource = new URL(request.url).searchParams.get("resource");
    if (resource === "biblioteca")
      return privateJson({
        items: await controlDb.mediaAsset.findMany({
          select: {
            id: true,
            name: true,
            fileName: true,
            mimeType: true,
            sizeBytes: true,
            altText: true,
            folder: true,
            createdAt: true,
          },
          orderBy: { createdAt: "desc" },
          take: 500,
        }),
      });
    if (resource === "seo")
      return privateJson({
        items: await controlDb.seoEntry.findMany({ orderBy: { path: "asc" } }),
      });
    if (resource === "blog")
      return privateJson({
        items: await controlDb.blogPost.findMany({
          orderBy: { updatedAt: "desc" },
          take: 500,
        }),
      });
    if (resource === "glossario")
      return privateJson({
        items: await controlDb.glossaryTerm.findMany({
          orderBy: { term: "asc" },
          take: 500,
        }),
      });
    return privateJson({ error: "Recurso inválido" }, { status: 400 });
  } catch (error) {
    return authErrorResponse(error);
  }
}

export async function POST(request: Request) {
  try {
    const actor = await requireUser("superadmin");
    await enforceControlRateLimit(controlDb, `admin:${actor.id}:content`, 60, 60);
    const body = await readJsonObject(request, 1_048_576);
    const resource = choice(body.resource, ["seo", "blog", "glossario"]);
    let id = "";
    if (resource === "seo") {
      let path: string;
      try { path = localPath(body.path); } catch { throw new ContentInputError("Caminho SEO inválido."); }
      if (reservedPath(path)) throw new ContentInputError("Metadados de áreas privadas não podem habilitar indexação.");
      const exists = PUBLIC_PAGES.includes(path) || path.startsWith("/blog/") && await controlDb.blogPost.count({where:{slug:path.slice(6),status:"published"}})>0 || path.startsWith("/glossario/") && await controlDb.glossaryTerm.count({where:{slug:path.slice(11),status:"published"}})>0;
      if (!exists) throw new ContentInputError("Publique a página antes de configurar o SEO.");
      const canonical = optionalUrl(body.canonical);
      if (canonical && (new URL(canonical).origin !== await siteOrigin() || new URL(canonical).hash || new URL(canonical).search)) throw new ContentInputError("Canonical deve usar o domínio público, sem parâmetros ou fragmentos.");
      const robots = choice(body.robots || "index,follow", [
        "index,follow",
        "noindex,follow",
        "noindex,nofollow",
      ]);
      const data = {
        title: limited(body.title, 2, 180),
        description: limited(body.description, 2, 500),
        canonical,
        robots,
        imageUrl: optionalUrl(body.imageUrl),
        schemaJson: body.schemaJson === null ? Prisma.DbNull : optionalObject(body.schemaJson) as Prisma.InputJsonValue | undefined,
      };
      await controlDb.seoEntry.upsert({
        where: { path },
        update: data,
        create: { path, ...data },
      });
      id = path;
    } else if (resource === "blog") {
      const slug = slugify(limited(body.slug || body.title, 2, 180));
      const status = choice(body.status || "draft", [
        "draft",
        "published",
        "archived",
      ]);
      const existing = body.id ? await controlDb.blogPost.findUnique({where:{id:limited(body.id,1,100)}}) : null;
      const data = {
        slug,
        title: limited(body.title, 2, 180),
        excerpt: limited(body.excerpt, 2, 500),
        content: limited(body.content, 2, 500_000),
        coverUrl: optionalUrl(body.coverUrl),
        status,
        authorName: actor.name,
        seoTitle: optional(body.seoTitle, 180),
        seoDescription: optional(body.seoDescription, 500),
        publishedAt: status === "published" ? existing?.publishedAt || new Date() : existing?.publishedAt || null,
      };
      if (body.id) {
        id = limited(body.id, 1, 100);
        await controlDb.blogPost.update({ where: { id }, data });
      } else id = (await controlDb.blogPost.create({ data })).id;
    } else {
      const slug = slugify(limited(body.slug || body.term, 2, 180));
      const status = choice(body.status || "draft", [
        "draft",
        "published",
        "archived",
      ]);
      const related = Array.isArray(body.related)
        ? body.related.map((item) => limited(item, 1, 100)).slice(0, 50)
        : [];
      const data = {
        slug,
        term: limited(body.term, 2, 180),
        definition: limited(body.definition, 2, 10_000),
        related,
        status,
      };
      if (body.id) {
        id = limited(body.id, 1, 100);
        await controlDb.glossaryTerm.update({ where: { id }, data });
      } else id = (await controlDb.glossaryTerm.create({ data })).id;
    }
    await controlDb.auditLog.create({
      data: {
        userId: actor.id,
        action: `${resource}.save`,
        entityType: resource,
        entityId: id,
      },
    });
    return privateJson({ ok: true, id });
  } catch (error) {
    if (error instanceof ContentInputError)
      return privateJson({ error: error.message }, { status: 400 });
    return authErrorResponse(error);
  }
}

class ContentInputError extends Error {}

function limited(value: unknown, min: number, max: number) {
  const text = String(value || "").trim();
  if (text.length < min || text.length > max)
    throw new ContentInputError("Um dos campos possui tamanho inválido.");
  return text;
}
function optional(value: unknown, max: number) {
  const text = String(value || "").trim();
  if (text.length > max)
    throw new ContentInputError("Um dos campos excede o tamanho permitido.");
  return text || null;
}
function optionalUrl(value: unknown) {
  const text = optional(value, 2048);
  if (!text) return null;
  if (/^\/api\/(?:public\/)?media\/[A-Za-z0-9_-]{10,100}$/.test(text)) return text.replace("/api/media/", "/api/public/media/");
  try {
    const url = new URL(text);
    if (url.protocol !== "https:" || url.username || url.password)
      throw new Error();
    return url.toString();
  } catch {
    throw new ContentInputError("Informe uma URL HTTPS válida.");
  }
}
function optionalObject(value: unknown) {
  if (value === undefined || value === null || value === "") return undefined;
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new ContentInputError("Os dados estruturados devem ser um grupo de campos.");
  return value as Record<string, unknown>;
}
function choice<T extends string>(value: unknown, values: readonly T[]) {
  const text = String(value) as T;
  if (!values.includes(text)) throw new ContentInputError("Opção inválida.");
  return text;
}
function slugify(value: string) {
  const slug = value
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 160);
  if (!slug) throw new ContentInputError("Slug inválido.");
  return slug;
}
