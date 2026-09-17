import { createHash, randomBytes } from "node:crypto";
import { Prisma } from "@/generated/tenant/client";
import { hashPosManualT2Domain, type T2CanonicalValue } from "@/lib/erp/pos-manual-t2-canonical";

type Tx = Prisma.TransactionClient;
type Hash64 = string;

export type PosT2CatalogProjection = {
  active: boolean;
  gtinSnapshot: string | null;
  manageStock: boolean;
  nameLabel: string;
  productType: string;
  skuSnapshot: string;
  status: string;
  unit: string;
};

export type PosT2CatalogVariation = {
  enabled: boolean;
  expectedConfigHash: string | null;
  expectedRevision: number | null;
  gtinSnapshot: string | null;
  manageStock: string;
  ordinal: number;
  skuSnapshot: string | null;
  status: string;
  variationId: number | null;
};

export type PosT2CatalogBoundaryResult = {
  operationId: string;
  productConfigHash: Hash64;
  productId: number;
  productRevision: number;
  replayed: boolean;
  variations: Array<{ action: "create" | "update" | "delete" | "keep"; configHash: Hash64; ordinal: number; revision: number; variationId: number }>;
};

export async function preparePosT2CatalogBoundary(tx: Tx, input: {
  action: "put_graph" | "set_active";
  productId: number | null;
  expectedProductRevision: number | null;
  expectedProductConfigHash: string | null;
  productProjection: PosT2CatalogProjection;
  variations: PosT2CatalogVariation[];
  actorUserId: string;
  idempotencyKey: string;
}): Promise<PosT2CatalogBoundaryResult> {
  const request = {
    action: input.action,
    actorUserId: input.actorUserId,
    expectedProductConfigHash: input.expectedProductConfigHash,
    expectedProductRevision: input.expectedProductRevision,
    idempotencyKey: input.idempotencyKey,
    productId: input.productId,
    productProjection: input.productProjection,
    schemaVersion: 1,
    variations: input.variations,
  } satisfies T2CanonicalValue;
  const requestHash = hashPosManualT2Domain("t2-catalog-boundary-request-v1", request);
  const result = await oneJson(tx, Prisma.sql`
    SELECT public.pos_t2_catalog_boundary_v1(
      ${input.action}::text,
      ${input.productId}::integer,
      ${input.expectedProductRevision}::integer,
      ${input.expectedProductConfigHash}::text,
      ${json(request.productProjection)}::jsonb,
      ${json(request.variations)}::jsonb,
      ${input.actorUserId}::text,
      ${input.idempotencyKey}::text,
      ${requestHash}::text
    ) AS result
  `);
  return catalogResult(result);
}

export type PosT2ValueProgramProjection = {
  branchId: number;
  earnUnits: number;
  expiresAfterDays: number | null;
  kind: string;
  name: string;
  redeemCentsPerUnit: number;
  spendCents: number;
  status: "active" | "inactive";
};

export async function writePosT2ValueProgramBoundary(tx: Tx, input: {
  action: "put" | "deactivate";
  programId: string | null;
  expectedRevision: number | null;
  expectedConfigHash: string | null;
  projection: PosT2ValueProgramProjection;
  actorUserId: string;
  idempotencyKey: string;
}) {
  const request = {
    action: input.action,
    actorUserId: input.actorUserId,
    expectedConfigHash: input.expectedConfigHash,
    expectedRevision: input.expectedRevision,
    idempotencyKey: input.idempotencyKey,
    programId: input.programId,
    projection: input.projection,
    schemaVersion: 1,
  } satisfies T2CanonicalValue;
  const requestHash = hashPosManualT2Domain("t2-value-program-boundary-request-v1", request);
  const p = input.projection;
  const result = await oneJson(tx, Prisma.sql`
    SELECT public.pos_t2_value_program_boundary_v1(
      ${input.action}::text, ${input.programId}::text,
      ${input.expectedRevision}::integer, ${input.expectedConfigHash}::text,
      ${p.branchId}::integer, ${p.name}::text, ${p.kind}::text, ${p.status}::text,
      ${p.earnUnits}::integer, ${p.spendCents}::integer,
      ${p.redeemCentsPerUnit}::integer, ${p.expiresAfterDays}::integer,
      ${input.actorUserId}::text, ${input.idempotencyKey}::text, ${requestHash}::text
    ) AS result
  `);
  return valueProgramResult(result);
}

export async function closePosT2AccountingPeriodBoundary(tx: Tx, input: {
  periodId: string;
  expectedRevision: number;
  expectedConfigHash: string;
  closedBy: string;
  reason: string;
  idempotencyKey: string;
}) {
  const request = {
    closedBy: input.closedBy,
    expectedConfigHash: input.expectedConfigHash,
    expectedRevision: input.expectedRevision,
    idempotencyKey: input.idempotencyKey,
    periodId: input.periodId,
    reason: input.reason,
    schemaVersion: 1,
  } satisfies T2CanonicalValue;
  const requestHash = hashPosManualT2Domain("t2-accounting-period-boundary-request-v1", request);
  const result = await oneJson(tx, Prisma.sql`
    SELECT public.pos_t2_accounting_period_close_v1(
      ${input.periodId}::text, ${input.expectedRevision}::integer,
      ${input.expectedConfigHash}::text, ${input.closedBy}::text, ${input.reason}::text,
      ${input.idempotencyKey}::text, ${requestHash}::text
    ) AS result
  `);
  return accountingPeriodResult(result);
}

export async function putPosT2AccountingPeriodBoundary(tx: Tx, input: {
  branchId: number;
  year: number;
  month: number;
  startsOn: string;
  endsOn: string;
  currency: "BRL";
  actorUserId: string;
  idempotencyKey: string;
}) {
  const request = {
    actorUserId: input.actorUserId,
    branchId: input.branchId,
    currency: input.currency,
    endsOn: input.endsOn,
    idempotencyKey: input.idempotencyKey,
    month: input.month,
    schemaVersion: 1,
    startsOn: input.startsOn,
    year: input.year,
  } satisfies T2CanonicalValue;
  const requestHash = hashPosManualT2Domain("t2-accounting-period-put-request-v1", request);
  const result = await oneJson(tx, Prisma.sql`
    SELECT public.pos_t2_accounting_period_put_v1(
      ${input.branchId}::integer, ${input.year}::integer, ${input.month}::integer,
      ${input.startsOn}::date, ${input.endsOn}::date, ${input.currency}::text,
      ${input.actorUserId}::text, ${input.idempotencyKey}::text, ${requestHash}::text
    ) AS result
  `);
  return accountingPeriodPutResult(result);
}

export type PosT2WebhookProjection = {
  apiVersion: string;
  deliveryUrl: string;
  name: string;
  secretCipher: string;
  secretPreview: string;
  status: "active" | "paused" | "disabled";
  topic: string;
};

export async function writePosT2WebhookBoundary(tx: Tx, input: {
  action: "create" | "update" | "revoke" | "rotate";
  logicalId: string | null;
  expectedVersion: number | null;
  expectedConfigHash: string | null;
  projection: PosT2WebhookProjection;
  actorUserId: string;
  idempotencyKey: string;
}) {
  const request = {
    action: input.action,
    actorUserId: input.actorUserId,
    expectedConfigHash: input.expectedConfigHash,
    expectedVersion: input.expectedVersion,
    idempotencyKey: input.idempotencyKey,
    logicalId: input.logicalId,
    projection: input.projection,
    schemaVersion: 1,
  } satisfies T2CanonicalValue;
  const requestHash = hashPosManualT2Domain("t2-webhook-boundary-request-v1", request);
  const p = input.projection;
  const result = await oneJson(tx, Prisma.sql`
    SELECT public.pos_t2_webhook_boundary_v1(
      ${input.action}::text, ${input.logicalId}::text, ${input.expectedVersion}::integer,
      ${input.expectedConfigHash}::text, ${p.name}::text, ${p.topic}::text,
      ${p.deliveryUrl}::text, ${p.secretCipher}::text, ${p.secretPreview}::text,
      ${p.status}::text, ${p.apiVersion}::text, ${input.actorUserId}::text,
      ${input.idempotencyKey}::text, ${requestHash}::text
    ) AS result
  `);
  return webhookResult(result);
}

export function createPosT2BoundaryIdempotencyKey() {
  return randomBytes(32).toString("base64url");
}

export function toPosT2BoundaryIdempotencyKey(value: string) {
  if (/^(?:[0-9a-f]{64}|[A-Za-z0-9_-]{43})$/u.test(value)) return value;
  return createHash("sha256").update("t2-boundary-idempotency-v1\0", "utf8").update(value, "utf8").digest("hex");
}

function json(value: T2CanonicalValue) {
  return JSON.stringify(value);
}

async function oneJson(tx: Tx, query: Prisma.Sql): Promise<Record<string, unknown>> {
  const rows = await tx.$queryRaw<Array<{ result: unknown }>>(query);
  if (rows.length !== 1) throw new Error("T2_BOUNDARY_RESULT_CARDINALITY");
  return object(rows[0]!.result);
}

function catalogResult(value: Record<string, unknown>): PosT2CatalogBoundaryResult {
  exactKeys(value, ["operationId", "productConfigHash", "productId", "productRevision", "replayed", "variations"]);
  if (!Array.isArray(value.variations)) invalid();
  return {
    operationId: uuid(value.operationId), productConfigHash: hash(value.productConfigHash), productId: positiveInt(value.productId),
    productRevision: positiveInt(value.productRevision), replayed: bool(value.replayed),
    variations: value.variations.map(item => {
      const row = object(item);
      exactKeys(row, ["action", "configHash", "ordinal", "revision", "variationId"]);
      const action = String(row.action);
      if (!new Set(["create", "update", "delete", "keep"]).has(action)) invalid();
      return { action: action as "create" | "update" | "delete" | "keep", configHash: hash(row.configHash), ordinal: nonNegativeInt(row.ordinal), revision: positiveInt(row.revision), variationId: positiveInt(row.variationId) };
    }),
  };
}

function valueProgramResult(value: Record<string, unknown>) {
  exactKeys(value, ["configHash", "operationId", "programId", "replayed", "revision", "status"]);
  const status = String(value.status);
  if (!new Set(["active", "inactive"]).has(status)) invalid();
  return { configHash: hash(value.configHash), operationId: uuid(value.operationId), programId: opaque(value.programId), replayed: bool(value.replayed), revision: positiveInt(value.revision), status: status as "active" | "inactive" };
}

function accountingPeriodResult(value: Record<string, unknown>) {
  exactKeys(value, ["closedAt", "configHash", "operationId", "periodId", "replayed", "revision", "status"]);
  if (value.status !== "closed" || typeof value.closedAt !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/u.test(value.closedAt)) invalid();
  return { closedAt: value.closedAt, configHash: hash(value.configHash), operationId: uuid(value.operationId), periodId: opaque(value.periodId), replayed: bool(value.replayed), revision: positiveInt(value.revision), status: "closed" as const };
}

function accountingPeriodPutResult(value: Record<string, unknown>) {
  exactKeys(value, ["configHash", "operationId", "periodId", "replayed", "revision", "status"]);
  if (value.status !== "open") invalid();
  return { configHash: hash(value.configHash), operationId: uuid(value.operationId), periodId: opaque(value.periodId), replayed: bool(value.replayed), revision: positiveInt(value.revision), status: "open" as const };
}

function webhookResult(value: Record<string, unknown>) {
  exactKeys(value, ["configHash", "endpointId", "logicalId", "operationId", "replayed", "status", "version"]);
  const status = String(value.status);
  if (!new Set(["active", "paused", "disabled"]).has(status)) invalid();
  return { configHash: hash(value.configHash), endpointId: opaque(value.endpointId), logicalId: opaque(value.logicalId), operationId: uuid(value.operationId), replayed: bool(value.replayed), status: status as "active" | "paused" | "disabled", version: positiveInt(value.version) };
}

function object(value: unknown): Record<string, unknown> { if (!value || typeof value !== "object" || Array.isArray(value)) invalid(); return value as Record<string, unknown>; }
function exactKeys(value: Record<string, unknown>, keys: string[]) { if (Object.keys(value).sort().join("\0") !== [...keys].sort().join("\0")) invalid(); }
function hash(value: unknown) { const text = String(value); if (!/^[0-9a-f]{64}$/u.test(text)) invalid(); return text; }
function uuid(value: unknown) { const text = String(value); if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u.test(text)) invalid(); return text; }
function opaque(value: unknown) { const text = String(value); if (!text || Buffer.byteLength(text, "utf8") > 256 || /[\u0000-\u001f\u007f]/u.test(text)) invalid(); return text; }
function bool(value: unknown) { if (typeof value !== "boolean") invalid(); return value; }
function positiveInt(value: unknown) { if (!Number.isSafeInteger(value) || Number(value) <= 0) invalid(); return Number(value); }
function nonNegativeInt(value: unknown) { if (!Number.isSafeInteger(value) || Number(value) < 0) invalid(); return Number(value); }
function invalid(): never { throw new Error("T2_BOUNDARY_RESULT_INVALID"); }
