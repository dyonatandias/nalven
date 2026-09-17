import { getVaultSecret, VAULT_KEYS } from "@/lib/vault";
import { safeBinaryRequest } from "@/lib/integrations/security";
import { billingBaseUrl, BillingError } from "./client";

export async function billingBinary(path: string, init: RequestInit = {}) {
  const apiKey = await getVaultSecret(VAULT_KEYS.billingApi);
  if (!apiKey?.startsWith("skp_nalven_"))
    throw new BillingError("Credencial permanente do Billing não configurada.", 503);
  const serialized = await serializeBody(init.body);
  let upstream: Awaited<ReturnType<typeof safeBinaryRequest>>;
  try {
    upstream = await safeBinaryRequest(`${await billingBaseUrl()}${path}`, {
      method: init.method,
      body: serialized.body,
      headers: {
        Authorization: `Bearer ${apiKey}`,
        ...serialized.headers,
        ...Object.fromEntries(new Headers(init.headers)),
      },
      timeoutMs: 15000,
      maximumResponseBytes: 10 * 1024 * 1024,
    });
  } catch {
    throw new BillingError("Billing indisponível ou timeout.", 503);
  }
  const retryAfter = safeRetryAfter(first(upstream.headers["retry-after"]));
  if (upstream.status < 200 || upstream.status >= 300) {
    let payload: Record<string, unknown> | null = null;
    try { payload = envelopeObject(JSON.parse(upstream.body.toString("utf8"))); } catch { /* no-op */ }
    throw new BillingError(
      typeof payload?.error === "string" ? payload.error : `Billing HTTP ${upstream.status}`,
      upstream.status,
      typeof payload?.request_id === "string" ? payload.request_id : undefined,
      retryAfter,
    );
  }
  const headers = new Headers();
  const contentType = first(upstream.headers["content-type"]);
  const disposition = first(upstream.headers["content-disposition"]);
  if (contentType) headers.set("content-type", contentType);
  if (disposition) headers.set("content-disposition", disposition);
  if (retryAfter !== undefined) headers.set("retry-after", String(retryAfter));
  return new Response([204, 205].includes(upstream.status) ? null : Uint8Array.from(upstream.body), {
    status: upstream.status,
    headers,
  });
}

export async function billingMultipart(path: string, form: FormData, idempotencyKey: string) {
  const response = await billingBinary(path, {
    method: "POST",
    body: form,
    headers: { Accept: "application/json", "Idempotency-Key": idempotencyKey },
  });
  let payload: Record<string, unknown> | null = null;
  try { payload = envelopeObject(await response.json()); } catch { /* An invalid body cannot confirm the upload. */ }
  if (payload?.success !== true || payload.data === undefined) {
    throw new BillingError(
      "Não foi possível confirmar o recebimento do anexo pelo Billing.",
      502,
      typeof payload?.request_id === "string" ? payload.request_id : undefined,
      safeRetryAfter(response.headers.get("retry-after") || ""),
    );
  }
  return payload.data;
}

async function serializeBody(body: BodyInit | null | undefined) {
  if (!body) return { body: undefined, headers: {} as Record<string, string> };
  if (typeof body === "string" || Buffer.isBuffer(body))
    return { body: Buffer.from(body), headers: {} as Record<string, string> };
  if (body instanceof FormData) {
    const request = new Request("https://serialization.invalid", { method: "POST", body });
    return {
      body: Buffer.from(await request.arrayBuffer()),
      headers: { "content-type": request.headers.get("content-type") || "" },
    };
  }
  throw new BillingError("Formato de envio não suportado.", 400);
}

function first(value: string | string[] | undefined) {
  return Array.isArray(value) ? value[0] || "" : value || "";
}

function envelopeObject(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function safeRetryAfter(value: string) {
  const text = value.trim(), seconds = Number(text);
  return /^\d+$/.test(text) && Number.isSafeInteger(seconds) && seconds > 0 ? seconds : undefined;
}
