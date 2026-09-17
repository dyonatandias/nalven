import type { PrismaClient } from "@/generated/tenant/client";
import { IntegrationError, persistentRateLimit } from "@/lib/integrations/core";

export class OmnichannelHttpError extends Error {
  constructor(
    message: string,
    public readonly status: number,
  ) {
    super(message);
  }
}

const ACTION_POLICIES: Readonly<
  Record<string, { limit: number; seconds: number }>
> = {
  "channel.create": { limit: 15, seconds: 60 },
  "channel.update": { limit: 30, seconds: 60 },
  "channel.sync": { limit: 20, seconds: 60 },
  "listing.upsert": { limit: 60, seconds: 60 },
  "order.import": { limit: 60, seconds: 60 },
  "order.update": { limit: 60, seconds: 60 },
  "webhook.retry": { limit: 30, seconds: 60 },
  "pick.wave": { limit: 15, seconds: 60 },
  "manifest.create": { limit: 15, seconds: 60 },
  "manifest.update": { limit: 30, seconds: 60 },
  "freight.quote": { limit: 30, seconds: 60 },
  "label.generate": { limit: 30, seconds: 60 },
  "tracking.update": { limit: 60, seconds: 60 },
  "return.create": { limit: 20, seconds: 60 },
  "return.update": { limit: 30, seconds: 60 },
  "return.inspect": { limit: 20, seconds: 60 },
  "export.csv": { limit: 12, seconds: 60 },
};

export const omnichannelNoStoreHeaders = {
  "cache-control": "private, no-store, max-age=0",
  expires: "0",
  pragma: "no-cache",
};

export function assertOmnichannelMutationRequest(request: Request) {
  const fetchSite = request.headers.get("sec-fetch-site")?.toLowerCase();
  if (fetchSite && !["same-origin", "same-site", "none"].includes(fetchSite))
    throw new OmnichannelHttpError("Origem da operação inválida.", 403);
  const contentType = request.headers.get("content-type")?.toLowerCase() || "";
  if (!contentType.startsWith("application/json"))
    throw new OmnichannelHttpError(
      "A operação aceita somente payload JSON.",
      415,
    );
}

export async function readOmnichannelJson(
  request: Request,
  maximumBytes = 262_144,
): Promise<Record<string, unknown>> {
  if (
    !Number.isSafeInteger(maximumBytes) ||
    maximumBytes < 1 ||
    maximumBytes > 1_048_576
  )
    throw new OmnichannelHttpError("Limite de payload inválido.", 500);
  const declared = request.headers.get("content-length");
  if (declared != null) {
    const length = Number(declared);
    if (!Number.isSafeInteger(length) || length < 0)
      throw new OmnichannelHttpError("Tamanho do payload inválido.", 400);
    if (length > maximumBytes)
      throw new OmnichannelHttpError("Payload excede o limite permitido.", 413);
  }
  if (!request.body) throw new OmnichannelHttpError("Payload ausente.", 400);
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
        throw new OmnichannelHttpError(
          "Payload excede o limite permitido.",
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
  try {
    const source = new TextDecoder("utf-8", { fatal: true }).decode(bytes),
      parsed = JSON.parse(source) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
      throw new OmnichannelHttpError("Payload deve ser um objeto.", 400);
    return parsed as Record<string, unknown>;
  } catch (error) {
    if (error instanceof OmnichannelHttpError) throw error;
    throw new OmnichannelHttpError("JSON inválido.", 400);
  }
}

export async function enforceOmnichannelRateLimit(
  db: PrismaClient,
  actorId: string,
  action: string,
) {
  const policy = ACTION_POLICIES[action] || { limit: 90, seconds: 60 };
  try {
    await persistentRateLimit(
      db,
      `omnichannel:${actorId}:${action}`,
      policy.limit,
      policy.seconds,
    );
  } catch (error) {
    if (error instanceof IntegrationError)
      throw new OmnichannelHttpError(error.message, error.status);
    throw error;
  }
}
