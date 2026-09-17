import { createHash, timingSafeEqual } from "node:crypto";

export const POS_RECONCILIATION_JOB_LIMITS = Object.freeze({ defaultOrganizationLimit: 20, maximumOrganizationLimit: 100, defaultBatchLimit: 10, maximumBatchLimit: 50 });

export class PosReconciliationHttpError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
    this.name = "PosReconciliationHttpError";
  }
}

export function assertPosReconciliationJobAuthorization(request: Request, expectedToken = process.env.NALVEN_INTERNAL_JOB_TOKEN || "") {
  const authorization = request.headers.get("authorization") || "", match = /^Bearer ([\x21-\x7e]{32,512})$/.exec(authorization);
  const expectedValid = /^[\x21-\x7e]{32,512}$/.test(expectedToken);
  const expected = createHash("sha256").update(expectedToken, "utf8").digest(), received = createHash("sha256").update(match?.[1] || "", "utf8").digest();
  if (!expectedValid || !match || !timingSafeEqual(expected, received)) throw new PosReconciliationHttpError("Não autorizado.", 401);
}

export function parsePosReconciliationJobInput(body: Record<string, unknown>) {
  const allowed = new Set(["action", "organizationLimit", "batchLimit", "afterOrganizationId"]);
  for (const key of Object.keys(body)) if (!allowed.has(key)) throw new PosReconciliationHttpError(`Campo não permitido: ${key}.`, 400);
  if (body.action !== "reconciliation.process") throw new PosReconciliationHttpError("Ação interna inválida.", 400);
  return {
    action: "reconciliation.process" as const,
    organizationLimit: bounded(body.organizationLimit, POS_RECONCILIATION_JOB_LIMITS.defaultOrganizationLimit, POS_RECONCILIATION_JOB_LIMITS.maximumOrganizationLimit, "Limite de organizações"),
    batchLimit: bounded(body.batchLimit, POS_RECONCILIATION_JOB_LIMITS.defaultBatchLimit, POS_RECONCILIATION_JOB_LIMITS.maximumBatchLimit, "Limite de lotes"),
    afterOrganizationId: cursor(body.afterOrganizationId),
  };
}

function bounded(value: unknown, fallback: number, maximum: number, label: string) {
  if (value == null) return fallback;
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1 || value > maximum) throw new PosReconciliationHttpError(`${label} deve estar entre 1 e ${maximum}.`, 400);
  return value;
}

function cursor(value: unknown) {
  if (value == null || value === "") return null;
  if (typeof value !== "string" || value.length > 160 || !/^[A-Za-z0-9._:-]+$/.test(value)) throw new PosReconciliationHttpError("Cursor de organização inválido.", 400);
  return value;
}
