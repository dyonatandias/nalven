import { createHash, randomUUID } from "node:crypto";
import type { PrismaClient } from "@/generated/control/client";

const JSON_TYPE = "application/json";
const DEFAULT_JSON_LIMIT = 256 * 1024;

export class HttpSecurityError extends Error {
  constructor(
    message: string,
    public readonly status = 400,
    public readonly retryAfter?: number,
  ) {
    super(message);
  }
}

export function clientAddress(request: Request) {
  const value =
    request.headers.get("x-real-ip") ||
    request.headers.get("x-forwarded-for")?.split(",", 1)[0] ||
    "unknown";
  return value.trim().slice(0, 128) || "unknown";
}

export function assertTrustedMutation(
  request: Request,
  options: {
    contentType?: "json" | "multipart" | "any" | "none";
    maximumBytes?: number;
  } = {},
) {
  assertRequestOrigin(request);
  const expected = options.contentType || "json";
  const contentType = request.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase() || "";
  if (expected === "json" && contentType !== JSON_TYPE)
    throw new HttpSecurityError("Envie a operação como application/json.", 415);
  if (expected === "multipart" && contentType !== "multipart/form-data")
    throw new HttpSecurityError("Envie o arquivo como multipart/form-data.", 415);

  const maximumBytes = options.maximumBytes ?? DEFAULT_JSON_LIMIT;
  if (!Number.isSafeInteger(maximumBytes) || maximumBytes < 0)
    throw new HttpSecurityError("Limite de payload inválido.", 500);
  const declared = request.headers.get("content-length");
  if (declared !== null) {
    const length = Number(declared);
    if (!Number.isSafeInteger(length) || length < 0)
      throw new HttpSecurityError("Tamanho do payload inválido.", 400);
    if (length > maximumBytes)
      throw new HttpSecurityError("O corpo da operação excede o limite permitido.", 413);
  }
}

export function assertRequestOrigin(request: Request) {
  const fetchSite = request.headers.get("sec-fetch-site")?.toLowerCase();
  if (fetchSite && !["same-origin", "same-site", "none"].includes(fetchSite))
    throw new HttpSecurityError("Origem da operação inválida.", 403);

  const origin = request.headers.get("origin");
  if (origin && origin !== effectiveOrigin(request))
    throw new HttpSecurityError("Origem da operação inválida.", 403);

  const hasSession = /(?:^|;)\s*nalven_session=/.test(request.headers.get("cookie") || "");
  if (hasSession && !origin && fetchSite !== "same-origin")
    throw new HttpSecurityError("Origem da operação não comprovada.", 403);
}

export async function readMultipartForm(request: Request, maximumBytes: number) {
  assertTrustedMutation(request, { contentType: "multipart", maximumBytes });
  const bytes = await readBodyBytes(request, maximumBytes);
  try {
    return await new Response(bytes as BodyInit, {
      headers: { "content-type": request.headers.get("content-type")! },
    }).formData();
  } catch {
    throw new HttpSecurityError("Formulário multipart inválido.", 400);
  }
}

export async function readJsonObject(
  request: Request,
  maximumBytes = DEFAULT_JSON_LIMIT,
) {
  assertTrustedMutation(request, { contentType: "json", maximumBytes });
  const bytes = await readBodyBytes(request, maximumBytes);
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    throw new HttpSecurityError("Corpo JSON inválido.", 400);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
    throw new HttpSecurityError("O payload deve ser um objeto JSON.", 400);
  return parsed as Record<string, unknown>;
}

export async function readBodyBytes(request: Request, maximumBytes: number) {
  if (!Number.isSafeInteger(maximumBytes) || maximumBytes < 1)
    throw new HttpSecurityError("Limite de payload inválido.", 500);
  const declared = request.headers.get("content-length");
  if (declared !== null) {
    const length = Number(declared);
    if (!Number.isSafeInteger(length) || length < 0)
      throw new HttpSecurityError("Tamanho do payload inválido.", 400);
    if (length > maximumBytes)
      throw new HttpSecurityError("O corpo da operação excede o limite permitido.", 413);
  }
  if (!request.body) throw new HttpSecurityError("Payload ausente.", 400);
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > maximumBytes) {
        await reader.cancel("payload limit exceeded");
        throw new HttpSecurityError(
          "O corpo da operação excede o limite permitido.",
          413,
        );
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

export function privateJson(value: unknown, init: ResponseInit = {}) {
  const headers = new Headers(init.headers);
  headers.set("cache-control", "private, no-store, max-age=0");
  headers.set("pragma", "no-cache");
  headers.set("x-content-type-options", "nosniff");
  return Response.json(value, { ...init, headers });
}

export function httpSecurityErrorResponse(error: HttpSecurityError) {
  return privateJson(
    { error: error.message },
    {
      status: error.status,
      headers: error.retryAfter
        ? { "retry-after": String(error.retryAfter) }
        : undefined,
    },
  );
}

export function unexpectedErrorResponse(scope: string, error: unknown) {
  const requestId = randomUUID();
  console.error(scope, {
    requestId,
    error: error instanceof Error ? error.name : typeof error,
  });
  return privateJson(
    { error: "Erro interno.", requestId },
    { status: 500 },
  );
}

export async function enforceControlRateLimit(
  db: PrismaClient,
  key: string,
  limit: number,
  seconds: number,
) {
  if (!Number.isSafeInteger(limit) || limit < 1)
    throw new HttpSecurityError("Política de limite inválida.", 500);
  if (!Number.isSafeInteger(seconds) || seconds < 1)
    throw new HttpSecurityError("Política de limite inválida.", 500);
  const id = createHash("sha256").update(`api-rate\0${key}`).digest("hex");
  const now = new Date();
  const expiresAt = new Date(now.getTime() + seconds * 1000);
  if (id.endsWith("00")) {
    await db.$executeRaw`
      DELETE FROM api_rate_limits
      WHERE id IN (
        SELECT id FROM api_rate_limits
        WHERE expires_at < NOW() - INTERVAL '1 day'
        ORDER BY expires_at
        LIMIT 100
      )
    `;
  }
  await db.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`api_rate:${id}`}))`;
    const current = await tx.apiRateLimit.findUnique({ where: { id } });
    if (!current || current.expiresAt <= now) {
      await tx.apiRateLimit.upsert({
        where: { id },
        update: { count: 1, windowStart: now, expiresAt },
        create: { id, count: 1, windowStart: now, expiresAt },
      });
      return;
    }
    if (current.count >= limit)
      throw new HttpSecurityError(
        "Muitas tentativas. Aguarde antes de tentar novamente.",
        429,
        Math.max(
          1,
          Math.ceil((current.expiresAt.getTime() - now.getTime()) / 1000),
        ),
      );
    await tx.apiRateLimit.update({
      where: { id },
      data: { count: { increment: 1 } },
    });
  });
}

function effectiveOrigin(request: Request) {
  const requestUrl = new URL(request.url);
  const host = firstHeader(request.headers.get("host"));
  const forwardedProtocol = firstHeader(request.headers.get("x-forwarded-proto"));
  const protocol =
    forwardedProtocol === "http" || forwardedProtocol === "https"
      ? `${forwardedProtocol}:`
      : requestUrl.protocol;
  try {
    return new URL(`${protocol}//${host || requestUrl.host}`).origin;
  } catch {
    throw new HttpSecurityError("Origem da operação inválida.", 403);
  }
}

function firstHeader(value: string | null) {
  return value?.split(",", 1)[0]?.trim().toLowerCase() || "";
}
