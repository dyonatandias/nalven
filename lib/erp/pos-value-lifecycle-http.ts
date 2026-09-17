import { createHash, timingSafeEqual } from "node:crypto";

export const POS_VALUE_JOB_LIMITS = Object.freeze({ defaultOrganizationLimit: 20, maximumOrganizationLimit: 100, defaultItemLimit: 50, maximumItemLimit: 100 });

export type PosValueLifecycleJobInput = {
  action: "value.lifecycle.sweep";
  organizationLimit: number;
  itemLimit: number;
  afterOrganizationId: string | null;
};

export class PosValueLifecycleHttpError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
    this.name = "PosValueLifecycleHttpError";
  }
}

export function assertPosValueLifecycleJobAuthorization(request: Request, expectedToken = process.env.NALVEN_INTERNAL_JOB_TOKEN || "") {
  const authorization = request.headers.get("authorization") || "";
  const match = /^Bearer ([\x21-\x7e]{32,512})$/.exec(authorization);
  const expectedValid = /^[\x21-\x7e]{32,512}$/.test(expectedToken);
  const expected = createHash("sha256").update(expectedToken, "utf8").digest(), received = createHash("sha256").update(match?.[1] || "", "utf8").digest();
  if (!expectedValid || !match || !timingSafeEqual(expected, received)) throw new PosValueLifecycleHttpError("Não autorizado.", 401);
}

export function parsePosValueLifecycleJobInput(body: Record<string, unknown>): PosValueLifecycleJobInput {
  const allowed = new Set(["action", "organizationLimit", "itemLimit", "afterOrganizationId"]);
  for (const key of Object.keys(body)) if (!allowed.has(key)) throw new PosValueLifecycleHttpError(`Campo não permitido: ${key}.`, 400);
  if (body.action !== "value.lifecycle.sweep") throw new PosValueLifecycleHttpError("Ação interna inválida.", 400);
  return {
    action: body.action,
    organizationLimit: boundedInteger(body.organizationLimit, POS_VALUE_JOB_LIMITS.defaultOrganizationLimit, 1, POS_VALUE_JOB_LIMITS.maximumOrganizationLimit, "Limite de organizações"),
    itemLimit: boundedInteger(body.itemLimit, POS_VALUE_JOB_LIMITS.defaultItemLimit, 1, POS_VALUE_JOB_LIMITS.maximumItemLimit, "Limite de itens"),
    afterOrganizationId: nullableIdentifier(body.afterOrganizationId),
  };
}

function boundedInteger(value: unknown, fallback: number, minimum: number, maximum: number, label: string) {
  if (value == null) return fallback;
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < minimum || value > maximum) throw new PosValueLifecycleHttpError(`${label} deve estar entre ${minimum} e ${maximum}.`, 400);
  return value;
}

function nullableIdentifier(value: unknown) {
  if (value == null || value === "") return null;
  if (typeof value !== "string" || value.length > 160 || !/^[A-Za-z0-9._:-]+$/.test(value)) throw new PosValueLifecycleHttpError("Cursor de organização inválido.", 400);
  return value;
}
