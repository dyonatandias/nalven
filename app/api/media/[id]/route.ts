import { readFile } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";
import { controlDb } from "@/db/control";
import { authErrorResponse, requireUser } from "@/lib/auth";

const root = resolve("/var/lib/nalven/uploads");
type Context = { params: Promise<{ id: string }> };

export async function GET(_request: Request, context: Context) {
  try {
    await requireUser("superadmin");
    const { id } = await context.params;
    if (!/^[A-Za-z0-9_-]{10,100}$/.test(id)) return notFound();
    const asset = await controlDb.mediaAsset.findUnique({ where: { id } });
    if (!asset) return notFound();
    const path = resolve(asset.path);
    const child = relative(root, path);
    if (!child || child.startsWith("..") || isAbsolute(child)) return notFound();
    const body = await readFile(path);
    if (body.length !== asset.sizeBytes) return notFound();
    const inline = asset.mimeType.startsWith("image/");
    return new Response(body, {
      headers: {
        "Content-Type": asset.mimeType,
        "Content-Length": String(body.length),
        "Content-Disposition": `${inline ? "inline" : "attachment"}; filename*=UTF-8''${encodeURIComponent(asset.name)}`,
        "Cache-Control": "private, no-store, max-age=0",
        "Content-Security-Policy": "default-src 'none'; sandbox",
        "Cross-Origin-Resource-Policy": "same-origin",
        "X-Content-Type-Options": "nosniff",
      },
    });
  } catch (error) {
    return authErrorResponse(error);
  }
}

function notFound() {
  return new Response("Not found", {
    status: 404,
    headers: {
      "Cache-Control": "private, no-store, max-age=0",
      "X-Content-Type-Options": "nosniff",
    },
  });
}
