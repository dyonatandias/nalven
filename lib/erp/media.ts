import { createHash, randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { extname } from "node:path";

export const MEDIA_MAX_BYTES = 20 * 1024 * 1024;
export const VIDEO_MAX_BYTES = 100 * 1024 * 1024;
const ALLOWED: Record<string, { extensions: string[]; kind: "image" | "document" | "video" }> = {
  "image/jpeg": { extensions: [".jpg", ".jpeg"], kind: "image" }, "image/png": { extensions: [".png"], kind: "image" }, "image/webp": { extensions: [".webp"], kind: "image" }, "image/gif": { extensions: [".gif"], kind: "image" }, "image/avif": { extensions: [".avif"], kind: "image" },
  "application/pdf": { extensions: [".pdf"], kind: "document" }, "text/plain": { extensions: [".txt"], kind: "document" }, "text/csv": { extensions: [".csv"], kind: "document" }, "application/vnd.openxmlformats-officedocument.wordprocessingml.document": { extensions: [".docx"], kind: "document" }, "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": { extensions: [".xlsx"], kind: "document" },
  "video/mp4": { extensions: [".mp4", ".m4v"], kind: "video" }, "video/webm": { extensions: [".webm"], kind: "video" }
};

export async function storeTenantMedia(organizationId: string, file: File) {
  if (!/^[a-zA-Z0-9_-]+$/.test(organizationId)) throw new MediaInputError("Organização inválida.");
  const rule = ALLOWED[file.type];
  const extension = extname(file.name).toLowerCase();
  if (!rule || !rule.extensions.includes(extension)) throw new MediaInputError("Formato não permitido. Use imagens, MP4, WebM, PDF, TXT, CSV, DOCX ou XLSX.", 415);
  const maximum = rule.kind === "video" ? VIDEO_MAX_BYTES : MEDIA_MAX_BYTES;
  if (!file.size || file.size > maximum) throw new MediaInputError(`O arquivo deve ter no máximo ${maximum / 1024 / 1024} MB.`, 413);
  const buffer = Buffer.from(await file.arrayBuffer());
  if (!matchesSignature(file.type, buffer)) throw new MediaInputError("O conteúdo do arquivo não corresponde ao formato informado.", 415);
  const storageKey = `${randomUUID()}${extension}`;
  const root = mediaRoot(organizationId);
  await mkdir(root, { recursive: true, mode: 0o750 });
  await writeFile(`${root}/${storageKey}`, buffer, { flag: "wx", mode: 0o640 });
  return { storageKey, mimeType: file.type, kind: rule.kind, sizeBytes: buffer.length, checksum: createHash("sha256").update(buffer).digest("hex") };
}

export function mediaRoot(organizationId: string) { return `/var/lib/nalven/uploads/tenants/${organizationId}/media`; }
export function safeMediaName(value: unknown, fallback = "Arquivo") { const clean = String(value || "").replace(/[\u0000-\u001f\u007f]/g, " ").trim().slice(0, 200); return clean || fallback; }
export function safeMediaFolder(value: unknown) { const clean = String(value || "Geral").replace(/[^\p{L}\p{N} _-]/gu, "").trim().slice(0, 60); return clean || "Geral"; }

export class MediaInputError extends Error { constructor(message: string, public status = 400) { super(message); } }

function matchesSignature(mime: string, data: Buffer) {
  if (mime === "image/jpeg") return data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff;
  if (mime === "image/png") return data.subarray(0, 8).equals(Buffer.from([0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a]));
  if (mime === "image/gif") return ["GIF87a", "GIF89a"].includes(data.subarray(0, 6).toString());
  if (mime === "image/webp") return data.subarray(0, 4).toString() === "RIFF" && data.subarray(8, 12).toString() === "WEBP";
  if (mime === "image/avif") return data.subarray(4, 12).toString().includes("ftypavif") || data.subarray(4, 12).toString().includes("ftypavis");
  if (mime === "application/pdf") return data.subarray(0, 5).toString() === "%PDF-";
  if (mime === "video/mp4") return data.subarray(4, 12).toString().includes("ftyp");
  if (mime === "video/webm") return data.subarray(0, 4).equals(Buffer.from([0x1a, 0x45, 0xdf, 0xa3]));
  if (mime.includes("openxmlformats")) return data[0] === 0x50 && data[1] === 0x4b;
  return mime === "text/plain" || mime === "text/csv";
}
