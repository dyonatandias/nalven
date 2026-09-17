import type { PrismaClient } from "@/generated/tenant/client";
import { IntegrationError, persistentRateLimit } from "@/lib/integrations/core";

export class PosHttpError extends Error {
  constructor(
    message: string,
    public readonly status: number,
  ) {
    super(message);
  }
}

const RATE_POLICIES: Readonly<
  Record<string, { limit: number; seconds: number }>
> = {
  "scan.resolve": { limit: 600, seconds: 60 },
  "promotion.quote": { limit: 180, seconds: 60 },
  "access.update": { limit: 30, seconds: 60 },
  "session.open": { limit: 20, seconds: 60 },
  "session.close": { limit: 20, seconds: 60 },
  "session.suspend": { limit: 20, seconds: 60 },
  "session.resume": { limit: 20, seconds: 60 },
  "session.handoff.request": { limit: 10, seconds: 60 },
  "session.handoff.accept": { limit: 10, seconds: 60 },
  "session.handoff.cancel": { limit: 10, seconds: 60 },
  "cash.event": { limit: 60, seconds: 60 },
  "cart.hold": { limit: 120, seconds: 60 },
  "cart.discard": { limit: 120, seconds: 60 },
  "cart.draft.save": { limit: 180, seconds: 60 },
  "cart.draft.discard": { limit: 60, seconds: 60 },
  "cart.transfer": { limit: 30, seconds: 60 },
  "order.lookup": { limit: 120, seconds: 60 },
  "order.claim": { limit: 30, seconds: 60 },
  "order.claim.recover": { limit: 60, seconds: 60 },
  "order.claim.renew": { limit: 60, seconds: 60 },
  "order.claim.release": { limit: 30, seconds: 60 },
  "sale.commit": { limit: 120, seconds: 60 },
  "payment.plan.activate": { limit: 30, seconds: 60 },
  "payment.intent.create": { limit: 30, seconds: 60 },
  "payment.intent.retry": { limit: 30, seconds: 60 },
  "payment.intent.cancel": { limit: 20, seconds: 60 },
  "payment.outbox.claim": { limit: 120, seconds: 60 },
  "payment.outbox.complete": { limit: 240, seconds: 60 },
  "payment.maintenance": { limit: 6, seconds: 60 },
  "payment.compensation.outbox.claim": { limit: 120, seconds: 60 },
  "payment.compensation.outbox.complete": { limit: 240, seconds: 60 },
  "payment.compensation.maintenance": { limit: 6, seconds: 60 },
  "sale.cancel": { limit: 30, seconds: 60 },
  "return.create": { limit: 30, seconds: 60 },
  "customer.quick.create": { limit: 20, seconds: 60 },
  "print.enqueue": { limit: 60, seconds: 60 },
  "approval.request": { limit: 30, seconds: 60 },
  "approval.decide": { limit: 60, seconds: 60 },
  "manual-payment.request": { limit: 20, seconds: 60 },
  "manual-application.reserve": { limit: 12, seconds: 60 },
  "manual-application.probe": { limit: 30, seconds: 60 },
  "manual-application.status": { limit: 60, seconds: 60 },
  "approval.step-up.decide": { limit: 6, seconds: 300 },
  "gift.resolve": { limit: 10, seconds: 300 },
  "qr.issue": { limit: 30, seconds: 60 },
  "qr.revoke": { limit: 60, seconds: 60 },
  "qr.resolve": { limit: 180, seconds: 60 },
  "value.accounts": { limit: 120, seconds: 60 },
  "value.lifecycle.sweep": { limit: 6, seconds: 60 },
  "reconciliation.layout": { limit: 20, seconds: 60 },
  "reconciliation.import": { limit: 10, seconds: 60 },
  "reconciliation.reprocess": { limit: 20, seconds: 60 },
  "reconciliation.process": { limit: 6, seconds: 60 },
  "reconciliation.report": { limit: 60, seconds: 60 },
  "reconciliation.export": { limit: 5, seconds: 60 },
};

export function assertPosMutationRequest(request: Request) {
  const fetchSite = request.headers.get("sec-fetch-site")?.toLowerCase();
  if (fetchSite && !["same-origin", "same-site", "none"].includes(fetchSite))
    throw new PosHttpError("Origem da operação inválida.", 403);
  const contentType = request.headers.get("content-type")?.toLowerCase() || "";
  if (!contentType.startsWith("application/json"))
    throw new PosHttpError("O PDV aceita somente payload JSON.", 415);
}

export async function readPosJson(
  request: Request,
  maximumBytes = 262_144,
): Promise<Record<string, unknown>> {
  if (
    !Number.isSafeInteger(maximumBytes) ||
    maximumBytes < 1 ||
    maximumBytes > 4_194_304
  )
    throw new PosHttpError("Limite de payload inválido.", 500);
  const declared = request.headers.get("content-length");
  if (declared != null) {
    const length = Number(declared);
    if (!Number.isSafeInteger(length) || length < 0)
      throw new PosHttpError("Tamanho do payload inválido.", 400);
    if (length > maximumBytes)
      throw new PosHttpError("Payload do PDV excede o limite permitido.", 413);
  }
  if (!request.body) throw new PosHttpError("Payload do PDV ausente.", 400);
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
        throw new PosHttpError(
          "Payload do PDV excede o limite permitido.",
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
  let parsed: unknown;
  try {
    const source = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    parsed = JSON.parse(source);
  } catch (error) {
    if (error instanceof PosHttpError) throw error;
    throw new PosHttpError("JSON do PDV inválido.", 400);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
    throw new PosHttpError("Payload do PDV deve ser um objeto.", 400);
  return parsed as Record<string, unknown>;
}

export function posRatePolicy(action: string) {
  return RATE_POLICIES[action] || { limit: 60, seconds: 60 };
}

export async function enforcePosRateLimit(
  db: PrismaClient,
  actorId: string,
  action: string,
) {
  const policy = posRatePolicy(action);
  try {
    await persistentRateLimit(
      db,
      `pos:${actorId}:${action}`,
      policy.limit,
      policy.seconds,
    );
  } catch (error) {
    if (error instanceof IntegrationError)
      throw new PosHttpError(error.message, error.status);
    throw error;
  }
}
