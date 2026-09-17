import { controlDb } from "@/db/control";
import { billingBinary, billingMultipart } from "@/lib/billing/binary";
import { billingCommandKey } from "@/lib/billing/idempotency";
import { invalidateSupportList, readSupportDetail, supportContext, supportFailure } from "@/lib/billing/support-service";
import { supportCommandId, supportMessageId, supportToken, SupportStateChangedError } from "@/lib/billing/support-data";
import {
  readMultipartForm,
  assertTrustedMutation,
  enforceControlRateLimit,
  HttpSecurityError,
  httpSecurityErrorResponse,
  privateJson,
} from "@/lib/http-security";

const allowed = new Set([
  "application/pdf",
  "text/plain",
  "text/csv",
  "image/jpeg",
  "image/png",
  "image/webp",
]);

export async function GET(request: Request) {
  try {
    const context = await supportContext(request);
    const query = new URL(request.url).searchParams;
    const type = query.get("type");
    const token = required(query.get("token") || query.get("invoiceId"));
    let path = "";
    let attachmentName: string | undefined;
    if (type === "boleto")
      path = `/clientes/${enc(context.externalId)}/faturas/${enc(token)}/boleto`;
    else if (type === "contrato")
      path = `/clientes/${enc(context.externalId)}/contratos/${enc(token)}/pdf`;
    else if (type === "danfse" || type === "xml")
      path = `/clientes/${enc(context.externalId)}/documentos-fiscais/${enc(token)}/download?tipo=${type}`;
    else if (type === "anexo") {
      await enforceControlRateLimit(controlDb, `portal:${context.organizationId}:${context.userId}:attachment-read`, 60, 60);
      const ticketToken = supportToken(query.get("ticketToken")), attachmentId = supportMessageId(token);
      const detail = await readSupportDetail(context, ticketToken);
      const attachment = detail.ticket.messages.flatMap(message => message.attachments).find(file => file.id === attachmentId);
      if (!attachment) throw new HttpSecurityError("Anexo não encontrado neste chamado.", 404);
      attachmentName = attachment.name;
      path = `/clientes/${enc(context.externalId)}/tickets/${enc(ticketToken)}/anexos?anexo_id=${enc(attachmentId)}`;
    }
    else return privateJson({ error: "Tipo de arquivo inválido." }, { status: 400 });
    const upstream = await billingBinary(path);
    return new Response(upstream.body, {
      headers: {
        "Content-Type": upstream.headers.get("content-type") || "application/octet-stream",
        "Content-Disposition": attachmentName ? attachmentDisposition(attachmentName) : upstream.headers.get("content-disposition") || "attachment",
        "Cache-Control": "private, no-store, max-age=0",
        "Content-Security-Policy": "default-src 'none'; sandbox",
        "Cross-Origin-Resource-Policy": "same-origin",
        "X-Content-Type-Options": "nosniff",
      },
    });
  } catch (error) {
    return failure(error);
  }
}

export async function POST(request: Request) {
  try {
    assertTrustedMutation(request, {
      contentType: "multipart",
      maximumBytes: 6 * 1024 * 1024,
    });
    const context = await supportContext(request, true);
    await enforceControlRateLimit(
      controlDb,
      `portal:${context.userId}:billing-attachment`,
      15,
      60,
    );
    const incoming = await readMultipartForm(request, 6 * 1024 * 1024);
    const file = incoming.get("file");
    const ticketToken = supportToken(incoming.get("ticketToken"));
    const messageId = supportMessageId(incoming.get("messageId"));
    const commandId = supportCommandId(incoming.get("commandId"));
    if (!(file instanceof File) || incoming.getAll("file").length !== 1)
      return privateJson({ error: "Arquivo obrigatório." }, { status: 400 });
    if (!allowed.has(file.type))
      return privateJson(
        { error: "Formato não permitido. Use PDF, TXT, CSV, JPEG, PNG ou WebP." },
        { status: 415 },
      );
    if (!matchesExtension(file.name, file.type)) return privateJson({ error: "A extensão do arquivo não corresponde ao formato informado." }, { status: 415 });
    if (file.size < 1 || file.size > 5 * 1024 * 1024)
      return privateJson({ error: "O anexo deve ter no máximo 5 MB." }, { status: 413 });
    const bytes = Buffer.from(await file.arrayBuffer());
    if (!matchesSignature(bytes, file.type))
      return privateJson(
        { error: "O conteúdo do anexo não corresponde ao formato informado." },
        { status: 415 },
      );
    const detail = await readSupportDetail(context, ticketToken);
    const message = detail.ticket.messages.find(message => message.id === messageId);
    if (!message) throw new SupportStateChangedError("A mensagem não está disponível neste chamado. Confira o histórico antes de descartar um envio anterior.");
    if (message.authorType !== "client") throw new HttpSecurityError("Selecione uma mensagem pública do cliente neste chamado.", 403);
    if (!detail.capabilities.canAttach) throw new SupportStateChangedError("O estado do chamado mudou. Confira o histórico antes de descartar o anexo; um envio anterior pode já ter sido recebido.");
    const cleanFile = new File([bytes], safeFileName(file.name), { type: file.type });
    const form = new FormData();
    form.set("mensagem_id", messageId);
    form.set("file", cleanFile, cleanFile.name);
    invalidateSupportList(context);
    try { await billingMultipart(
      `/clientes/${enc(context.externalId)}/tickets/${enc(ticketToken)}/anexos`,
      form,
      billingCommandKey(context.externalId, `ticket-${ticketToken}-attachment-message-${messageId}`, commandId),
    ); } finally { invalidateSupportList(context); }
    await controlDb.auditLog.create({data:{userId:context.userId,action:"portal.billing.attachment_uploaded",entityType:"organization",entityId:context.organizationId}});
    // Provider upload responses may contain storage paths or internal metadata.
    // Clients re-read the validated ticket to obtain the public attachment list.
    return privateJson({ ok: true });
  } catch (error) {
    return failure(error);
  }
}

function required(value: unknown) { const text = typeof value === "string" ? value.trim() : ""; if (!text || text.length > 500 || /[\r\n\0\\/]/.test(text) || text === "." || text === "..") throw new PortalFileInputError("Parâmetro obrigatório inválido."); return text; }
function enc(value: string) { return encodeURIComponent(value); }
function safeFileName(value: string) {
  const clean = value.replace(/[\u0000-\u001f\u007f]/g, "").replace(/[\\/]/g, "-").trim();
  const extension = clean.match(/\.[a-zA-Z0-9]{1,10}$/)?.[0] || "";
  const base = (extension ? clean.slice(0, -extension.length) : clean).slice(0, 200 - extension.length).trim();
  return `${base || "anexo"}${extension}`;
}
function attachmentDisposition(value: string) { const name = safeFileName(value), fallback = name.replace(/[^a-zA-Z0-9._ -]/g, "_"); return `attachment; filename="${fallback}"; filename*=UTF-8''${encodeURIComponent(name).replace(/['()*]/g, character => `%${character.charCodeAt(0).toString(16).toUpperCase()}`)}`; }
function matchesExtension(name: string, type: string) { const extension = name.split(".").at(-1)?.toLowerCase(); return ({ "application/pdf": ["pdf"], "text/plain": ["txt"], "text/csv": ["csv"], "image/jpeg": ["jpg", "jpeg"], "image/png": ["png"], "image/webp": ["webp"] } as Record<string, string[]>)[type]?.includes(extension || "") === true; }
function matchesSignature(bytes: Buffer, type: string) { if (type === "application/pdf") return bytes.subarray(0, 5).toString("ascii") === "%PDF-"; if (type === "image/jpeg") return bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff; if (type === "image/png") return bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])); if (type === "image/webp") return bytes.subarray(0, 4).toString("ascii") === "RIFF" && bytes.subarray(8, 12).toString("ascii") === "WEBP"; if (type === "text/plain" || type === "text/csv") { if (bytes.includes(0)) return false; try { new TextDecoder("utf-8", { fatal: true }).decode(bytes); return true; } catch { return false; } } return false; }
function failure(error: unknown) { if (error instanceof HttpSecurityError) return httpSecurityErrorResponse(error); if (error instanceof PortalFileInputError) return privateJson({ error: error.message }, { status: 400 }); return supportFailure(error); }
class PortalFileInputError extends Error {}
