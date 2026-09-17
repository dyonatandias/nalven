import { readFile } from "node:fs/promises";
import { mediaRoot, MediaInputError } from "./media";
import { mediaDisposition, parseMediaRange } from "./media-library";

export type StoredMediaFile = {
  storageKey: string;
  mimeType: string;
  kind: string;
  sizeBytes: number;
  originalName: string;
  localAvailable: boolean;
  remoteUrl: string | null;
};

export async function storedMediaResponse(
  request: Request,
  organizationId: string,
  file: StoredMediaFile,
) {
  if (!/^[a-f0-9-]+\.[a-z0-9]+$/i.test(file.storageKey))
    return new Response("Arquivo não encontrado", { status: 404 });
  if (!file.localAvailable && file.remoteUrl)
    return Response.redirect(file.remoteUrl, 307);

  let body: Buffer;
  try {
    body = await readFile(`${mediaRoot(organizationId)}/${file.storageKey}`);
  } catch (error) {
    if (file.remoteUrl) return Response.redirect(file.remoteUrl, 307);
    throw error;
  }

  const size = body.length;
  let range;
  try {
    range = parseMediaRange(request.headers.get("range"), size);
  } catch (error) {
    if (error instanceof MediaInputError && error.status === 416) {
      return new Response(null, {
        status: 416,
        headers: { "Content-Range": `bytes */${size}` },
      });
    }
    throw error;
  }
  const responseBody = range ? body.subarray(range.start, range.end + 1) : body;
  const headers: Record<string, string> = {
    "Content-Type": file.mimeType,
    "Content-Length": String(responseBody.length),
    "Content-Disposition": `${mediaDisposition(file.kind, file.mimeType)}; filename*=UTF-8''${encodeURIComponent(file.originalName)}`,
    "Cache-Control": "private, max-age=3600",
    "Accept-Ranges": "bytes",
    "X-Content-Type-Options": "nosniff",
    "Content-Security-Policy": "default-src 'none'; sandbox",
  };
  if (range)
    headers["Content-Range"] = `bytes ${range.start}-${range.end}/${size}`;
  return new Response(new Uint8Array(responseBody), {
    status: range ? 206 : 200,
    headers,
  });
}
