import { randomUUID } from "node:crypto";
import { mkdir, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { controlDb } from "@/db/control";
import { authErrorResponse, requireUser } from "@/lib/auth";
import {
  readMultipartForm,
  assertTrustedMutation,
  enforceControlRateLimit,
  HttpSecurityError,
  httpSecurityErrorResponse,
  privateJson,
} from "@/lib/http-security";

const root = "/var/lib/nalven/uploads";
const maximumFileBytes = 8 * 1024 * 1024;
const extensions = new Map([
  ["image/jpeg", ".jpg"],
  ["image/png", ".png"],
  ["image/webp", ".webp"],
  ["image/avif", ".avif"],
  ["application/pdf", ".pdf"],
]);

export async function POST(request: Request) {
  let storedPath: string | null = null;
  try {
    assertTrustedMutation(request, {
      contentType: "multipart",
      maximumBytes: 9 * 1024 * 1024,
    });
    const actor = await requireUser("superadmin");
    await enforceControlRateLimit(
      controlDb,
      `admin:${actor.id}:media-upload`,
      20,
      60,
    );
    const form = await readMultipartForm(request, 9 * 1024 * 1024);
    const file = form.get("file");
    if (!(file instanceof File))
      return privateJson({ error: "Arquivo obrigatório." }, { status: 400 });
    const extension = extensions.get(file.type);
    if (!extension)
      return privateJson(
        { error: "Formato não permitido. Use JPEG, PNG, WebP, AVIF ou PDF." },
        { status: 415 },
      );
    if (file.size < 1 || file.size > maximumFileBytes)
      return privateJson(
        { error: "O arquivo deve ter no máximo 8 MB." },
        { status: 413 },
      );
    const bytes = Buffer.from(await file.arrayBuffer());
    if (!matchesSignature(bytes, file.type))
      return privateJson(
        { error: "O conteúdo do arquivo não corresponde ao formato informado." },
        { status: 415 },
      );
    const stored = `${randomUUID()}${extension}`;
    storedPath = join(root, stored);
    await mkdir(root, { recursive: true, mode: 0o750 });
    await writeFile(storedPath, bytes, { flag: "wx", mode: 0o640 });
    const asset = await controlDb.mediaAsset.create({
      data: {
        name: safeFileName(file.name),
        fileName: stored,
        mimeType: file.type,
        sizeBytes: file.size,
        path: storedPath,
        folder: limited(form.get("folder") || "geral", 80),
        altText: limited(form.get("altText") || "", 300),
        uploadedById: actor.id,
      },
    });
    await controlDb.auditLog.create({
      data: {
        userId: actor.id,
        action: "media.upload",
        entityType: "media",
        entityId: asset.id,
        metadata: { mimeType: file.type, size: file.size },
      },
    });
    return privateJson(
      {
        id: asset.id,
        name: asset.name,
        fileName: asset.fileName,
        mimeType: asset.mimeType,
        sizeBytes: asset.sizeBytes,
        folder: asset.folder,
        altText: asset.altText,
        createdAt: asset.createdAt,
      },
      { status: 201 },
    );
  } catch (error) {
    if (storedPath) await unlink(storedPath).catch(() => undefined);
    if (error instanceof HttpSecurityError)
      return httpSecurityErrorResponse(error);
    return authErrorResponse(error);
  }
}

function matchesSignature(bytes: Buffer, type: string) {
  if (type === "image/jpeg")
    return bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
  if (type === "image/png")
    return bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  if (type === "image/webp")
    return bytes.length >= 12 && bytes.toString("ascii", 0, 4) === "RIFF" && bytes.toString("ascii", 8, 12) === "WEBP";
  if (type === "image/avif")
    return bytes.length >= 12 && bytes.toString("ascii", 4, 8) === "ftyp" && ["avif", "avis"].includes(bytes.toString("ascii", 8, 12));
  if (type === "application/pdf")
    return bytes.length >= 5 && bytes.toString("ascii", 0, 5) === "%PDF-";
  return false;
}
function safeFileName(value: string) {
  return value.replace(/[\u0000-\u001f\u007f]/g, "").replace(/[\\/]/g, "-").trim().slice(0, 200) || "arquivo";
}
function limited(value: unknown, max: number) {
  return String(value || "").replace(/[\u0000-\u001f\u007f]/g, "").trim().slice(0, max);
}
