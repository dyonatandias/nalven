import { Pool, type PoolConfig, type QueryResultRow } from "pg";
import { hashPosManualT2Domain } from "@/lib/erp/pos-manual-t2-canonical";

export const POS_MANUAL_T2_RESERVE_APPLICATION_NAME = "nalven-pos-manual-reserve-v1";
export const POS_MANUAL_T2_RESERVE_CAPABILITY = "public.pos_manual_reserve_application_v1(uuid,integer,integer,text,text,text)";
export const POS_MANUAL_T2_SERIALIZATION_ATTEMPTS = 3;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;
const HASH64 = /^[0-9a-f]{64}$/u;
const IDEMPOTENCY_KEY = /^(?:[0-9a-f]{64}|[A-Za-z0-9_-]{43})$/u;
const INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/u;
const CONTROL = /[\u0000-\u001f\u007f]/u;

export type PosManualT2ReserveInput = {
  caseId: string;
  expectedCaseVersionBeforeReserve: number;
  actorProfileId: number;
  actorUserId: string;
  idempotencyKey: string;
};

export type PosManualT2ReserveResult = {
  applicationId: string;
  caseId: string;
  caseVersionBeforeReserve: number;
  caseVersionAfterReserve: number;
  applicationVersion: number;
  state: "pending";
  reservationExpiresAt: string;
  snapshotHash: string;
  manifestHash: string;
  replayed: boolean;
  currentlyApplicable: boolean;
};

export type PosManualT2ApplicationStatus = {
  applicationId: string;
  applicationVersion: number;
  blockedCode: string | null;
  caseId: string;
  caseVersionAfterReserve: number;
  currentlyApplicable: boolean;
  failureClass: "retryable_internal" | "boundary_changed" | "reservation_expired" | null;
  paymentId: string | null;
  reservationExpiresAt: string;
  saleId: number | null;
  state: "pending" | "claimed" | "applied" | "blocked";
};

export type PosManualT2StatusResult = PosManualT2ApplicationStatus | { status: "not_found" };
export type PosManualT2ProbeResult =
  | { outcome: "committed_same_request"; winner: PosManualT2ApplicationStatus }
  | { outcome: "authoritatively_absent" | "unknown"; winner: null };

export type PosManualT2ReserveExecution =
  | { outcome: "committed"; winner: PosManualT2ReserveResult }
  | PosManualT2ProbeResult;

export interface PosManualT2AutocommitExecutor {
  query<R extends QueryResultRow = QueryResultRow>(statement: string, values: readonly unknown[]): Promise<{ rows: R[] }>;
}

export type PosManualT2ReserveClientOptions = {
  connectionString: string;
  sessionUser?: string;
  maximumPoolSize?: number;
  connectionTimeoutMillis?: number;
  idleTimeoutMillis?: number;
};

export class PosManualT2ReserveClient {
  private constructor(
    private readonly executor: PosManualT2AutocommitExecutor,
    readonly sessionUser: string,
    private readonly closeExecutor: (() => Promise<void>) | null,
  ) {}

  static dedicated(options: PosManualT2ReserveClientOptions): PosManualT2ReserveClient {
    const sessionUser = runtimeSessionUser(options.connectionString, options.sessionUser);
    const pool = new Pool(dedicatedPoolConfig(options));
    return new PosManualT2ReserveClient(new SingleStatementPoolExecutor(pool), sessionUser, () => pool.end());
  }

  static withExecutor(executor: PosManualT2AutocommitExecutor, sessionUser: string): PosManualT2ReserveClient {
    return new PosManualT2ReserveClient(executor, subject(sessionUser, "session_user"), null);
  }

  async reserve(input: PosManualT2ReserveInput): Promise<PosManualT2ReserveResult> {
    const request = normalizeReserveInput(input);
    const requestHash = reserveRequestHash(request, this.sessionUser);
    const row = await exactlyOneJsonRow(this.executor, `SELECT public.pos_manual_reserve_application_v1(
      $1::uuid, $2::integer, $3::integer, $4::text, $5::text, $6::text
    ) AS result`, [request.caseId, request.expectedCaseVersionBeforeReserve, request.actorProfileId, request.actorUserId, request.idempotencyKey, requestHash]);
    return reserveResult(row);
  }

  async reserveWithLostCommitProbe(input: PosManualT2ReserveInput): Promise<PosManualT2ReserveExecution> {
    const request = normalizeReserveInput(input);
    for (let attempt = 1; attempt <= POS_MANUAL_T2_SERIALIZATION_ATTEMPTS; attempt += 1) {
      try {
        return { outcome: "committed", winner: await this.reserve(request) };
      } catch (error) {
        if (isRetryableSerialization(error) && attempt < POS_MANUAL_T2_SERIALIZATION_ATTEMPTS) continue;
        if (isDatabaseError(error)) throw error;
        if (isTimeoutOrCancellation(error)) return { outcome: "unknown", winner: null };
        try {
          return await this.probe(request);
        } catch (probeError) {
          if (isSemanticDatabaseError(probeError)) throw probeError;
          return { outcome: "unknown", winner: null };
        }
      }
    }
    throw new Error("T2_RESERVE_RETRY_STATE_INVALID");
  }

  async status(applicationId: string, actorUserId: string): Promise<PosManualT2StatusResult> {
    const row = await exactlyOneJsonRow(this.executor,
      "SELECT public.pos_manual_application_status_v1($1::uuid, $2::text) AS result",
      [uuid(applicationId, "applicationId"), subject(actorUserId, "actorUserId")]);
    return statusResult(row);
  }

  async probe(input: PosManualT2ReserveInput): Promise<PosManualT2ProbeResult> {
    const request = normalizeReserveInput(input);
    const requestHash = reserveRequestHash(request, this.sessionUser);
    const row = await exactlyOneJsonRow(this.executor, `SELECT public.pos_manual_application_status_by_reservation_v1(
      $1::uuid, $2::text, $3::text, $4::integer, $5::text
    ) AS result`, [request.caseId, request.idempotencyKey, requestHash, request.actorProfileId, request.actorUserId]);
    return probeResult(row);
  }

  async close(): Promise<void> {
    await this.closeExecutor?.();
  }
}

class SingleStatementPoolExecutor implements PosManualT2AutocommitExecutor {
  constructor(private readonly pool: Pool) {}

  async query<R extends QueryResultRow>(statement: string, values: readonly unknown[]): Promise<{ rows: R[] }> {
    const connection = await this.pool.connect();
    try {
      const result = await connection.query<R>(statement, [...values]);
      return { rows: result.rows };
    } finally {
      // A physical connection is never reused for a second statement. The
      // dedicated pool still bounds concurrent connects and their timeouts.
      connection.release(true);
    }
  }
}

export function reserveRequestHash(input: PosManualT2ReserveInput, sessionUser: string): string {
  const normalized = normalizeReserveInput(input);
  return hashPosManualT2Domain("t2-reserve-request-v1", {
    actorProfileId: normalized.actorProfileId,
    actorUserId: normalized.actorUserId,
    capability: POS_MANUAL_T2_RESERVE_CAPABILITY,
    caseId: normalized.caseId,
    expectedCaseVersionBeforeReserve: normalized.expectedCaseVersionBeforeReserve,
    idempotencyKey: normalized.idempotencyKey,
    schemaVersion: 1,
    sessionUser: subject(sessionUser, "session_user"),
  });
}

export function dedicatedPoolConfig(options: PosManualT2ReserveClientOptions): PoolConfig {
  runtimeSessionUser(options.connectionString, options.sessionUser);
  return {
    connectionString: options.connectionString,
    options: `-c default_transaction_isolation=serializable -c application_name=${POS_MANUAL_T2_RESERVE_APPLICATION_NAME}`,
    max: boundedInteger(options.maximumPoolSize ?? 4, 1, 20, "maximumPoolSize"),
    connectionTimeoutMillis: boundedInteger(options.connectionTimeoutMillis ?? 5_000, 100, 60_000, "connectionTimeoutMillis"),
    idleTimeoutMillis: boundedInteger(options.idleTimeoutMillis ?? 30_000, 1_000, 300_000, "idleTimeoutMillis"),
    allowExitOnIdle: true,
  };
}

function normalizeReserveInput(input: PosManualT2ReserveInput): PosManualT2ReserveInput {
  return {
    caseId: uuid(input.caseId, "caseId"),
    expectedCaseVersionBeforeReserve: boundedInteger(input.expectedCaseVersionBeforeReserve, 0, 2_147_483_647, "expectedCaseVersionBeforeReserve"),
    actorProfileId: boundedInteger(input.actorProfileId, 1, 2_147_483_647, "actorProfileId"),
    actorUserId: subject(input.actorUserId, "actorUserId"),
    idempotencyKey: idempotencyKey(input.idempotencyKey),
  };
}

function runtimeSessionUser(connectionString: string, expected?: string): string {
  let parsed: URL;
  try { parsed = new URL(connectionString); } catch { throw new Error("T2_RESERVE_CONNECTION_STRING_INVALID"); }
  if (!/^postgres(?:ql)?:$/u.test(parsed.protocol) || parsed.search || parsed.hash) throw new Error("T2_RESERVE_CONNECTION_STRING_INVALID");
  const username = subject(decodeURIComponent(parsed.username), "session_user");
  if (expected !== undefined && username !== subject(expected, "session_user")) throw new Error("T2_RESERVE_SESSION_USER_MISMATCH");
  return username;
}

async function exactlyOneJsonRow(executor: PosManualT2AutocommitExecutor, statement: string, values: readonly unknown[]): Promise<unknown> {
  // Deliberately one statement and no BEGIN: resolution occurs only after the
  // PostgreSQL ReadyForQuery that acknowledges the implicit transaction.
  const result = await executor.query<{ result: unknown }>(statement, values);
  if (result.rows.length !== 1 || !("result" in result.rows[0]!)) throw new Error("T2_RESERVE_DATABASE_RESULT_INVALID");
  return result.rows[0]!.result;
}

function reserveResult(value: unknown): PosManualT2ReserveResult {
  const row = exactObject(value, ["applicationId", "caseId", "caseVersionBeforeReserve", "caseVersionAfterReserve", "applicationVersion", "state", "reservationExpiresAt", "snapshotHash", "manifestHash", "replayed", "currentlyApplicable"]);
  if (row.state !== "pending") throw new Error("T2_RESERVE_RESULT_STATE_INVALID");
  return {
    applicationId: uuid(row.applicationId, "applicationId"), caseId: uuid(row.caseId, "caseId"),
    caseVersionBeforeReserve: nonNegativeInteger(row.caseVersionBeforeReserve, "caseVersionBeforeReserve"),
    caseVersionAfterReserve: nonNegativeInteger(row.caseVersionAfterReserve, "caseVersionAfterReserve"),
    applicationVersion: nonNegativeInteger(row.applicationVersion, "applicationVersion"), state: "pending",
    reservationExpiresAt: instant(row.reservationExpiresAt), snapshotHash: hash64(row.snapshotHash, "snapshotHash"),
    manifestHash: hash64(row.manifestHash, "manifestHash"), replayed: boolean(row.replayed, "replayed"),
    currentlyApplicable: boolean(row.currentlyApplicable, "currentlyApplicable"),
  };
}

function statusResult(value: unknown): PosManualT2StatusResult {
  const valueObject = object(value);
  if (valueObject.status === "not_found") {
    exactObject(value, ["status"]);
    return { status: "not_found" };
  }
  const row = exactObject(value, ["applicationId", "applicationVersion", "blockedCode", "caseId", "caseVersionAfterReserve", "currentlyApplicable", "failureClass", "paymentId", "reservationExpiresAt", "saleId", "state"]);
  const state = enumValue(row.state, ["pending", "claimed", "applied", "blocked"] as const, "state");
  const failureClass = nullableEnum(row.failureClass, ["retryable_internal", "boundary_changed", "reservation_expired"] as const, "failureClass");
  const result: PosManualT2ApplicationStatus = {
    applicationId: uuid(row.applicationId, "applicationId"), applicationVersion: nonNegativeInteger(row.applicationVersion, "applicationVersion"),
    blockedCode: nullableCode(row.blockedCode, "blockedCode"), caseId: uuid(row.caseId, "caseId"),
    caseVersionAfterReserve: nonNegativeInteger(row.caseVersionAfterReserve, "caseVersionAfterReserve"),
    currentlyApplicable: boolean(row.currentlyApplicable, "currentlyApplicable"), failureClass,
    paymentId: nullableOpaqueId(row.paymentId, "paymentId"), reservationExpiresAt: instant(row.reservationExpiresAt),
    saleId: row.saleId === null ? null : boundedInteger(row.saleId, 1, 2_147_483_647, "saleId"), state,
  };
  assertStatusMachine(result);
  return result;
}

function probeResult(value: unknown): PosManualT2ProbeResult {
  const row = exactObject(value, ["outcome", "winner"]);
  const outcome = enumValue(row.outcome, ["committed_same_request", "authoritatively_absent", "unknown"] as const, "outcome");
  if (outcome === "committed_same_request") {
    const winner = statusResult(row.winner);
    if ("status" in winner) throw new Error("T2_PROBE_WINNER_INVALID");
    return { outcome, winner };
  }
  if (row.winner !== null) throw new Error("T2_PROBE_WINNER_INVALID");
  return { outcome, winner: null };
}

function assertStatusMachine(status: PosManualT2ApplicationStatus): void {
  if (status.state === "applied") {
    if (status.currentlyApplicable || status.saleId === null || status.paymentId === null || status.failureClass !== null || status.blockedCode !== null) throw new Error("T2_STATUS_MACHINE_INVALID");
    return;
  }
  if (status.state === "blocked") {
    if (status.currentlyApplicable || status.saleId !== null || status.paymentId !== null || !["boundary_changed", "reservation_expired"].includes(status.failureClass ?? "") || status.blockedCode === null) throw new Error("T2_STATUS_MACHINE_INVALID");
    return;
  }
  if (status.saleId !== null || status.paymentId !== null || status.blockedCode !== null) throw new Error("T2_STATUS_MACHINE_INVALID");
  if (status.state === "claimed" && status.failureClass !== null) throw new Error("T2_STATUS_MACHINE_INVALID");
  if (status.state === "pending" && ![null, "retryable_internal"].includes(status.failureClass)) throw new Error("T2_STATUS_MACHINE_INVALID");
}

function isDatabaseError(error: unknown): boolean {
  return typeof (error as { code?: unknown } | null)?.code === "string" && /^[0-9A-Z]{5}$/u.test((error as { code: string }).code);
}

function isSemanticDatabaseError(error: unknown): boolean {
  if (!isDatabaseError(error)) return false;
  return !["40001", "40P01", "57014", "57P01", "57P02", "57P03"].includes((error as { code: string }).code);
}

function isRetryableSerialization(error: unknown): boolean {
  return isDatabaseError(error) && ["40001", "40P01"].includes((error as { code: string }).code);
}

function isTimeoutOrCancellation(error: unknown): boolean {
  const code = (error as { code?: unknown } | null)?.code;
  const name = (error as { name?: unknown } | null)?.name;
  return code === "57014" || code === "ETIMEDOUT" || code === "ABORT_ERR" || name === "AbortError";
}

function exactObject(value: unknown, keys: readonly string[]): Record<string, unknown> {
  const row = object(value);
  const actual = Object.keys(row).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) throw new Error("T2_DATABASE_RESULT_SHAPE_INVALID");
  return row;
}

function object(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error("T2_DATABASE_RESULT_SHAPE_INVALID");
  return value as Record<string, unknown>;
}

function uuid(value: unknown, label: string): string {
  if (typeof value !== "string" || !UUID.test(value)) throw new Error(`T2_${label.toUpperCase()}_INVALID`);
  return value;
}

function idempotencyKey(value: unknown): string {
  if (typeof value !== "string" || !IDEMPOTENCY_KEY.test(value)) throw new Error("T2_IDEMPOTENCY_KEY_INVALID");
  return value;
}

function subject(value: unknown, label: string): string {
  if (typeof value !== "string" || value !== value.normalize("NFC") || CONTROL.test(value) || Buffer.byteLength(value, "utf8") < 1 || Buffer.byteLength(value, "utf8") > 128) throw new Error(`T2_${label.toUpperCase()}_INVALID`);
  return value;
}

function instant(value: unknown): string {
  if (typeof value !== "string" || !INSTANT.test(value)) throw new Error("T2_INSTANT_INVALID");
  const milliseconds = `${value.slice(0, 23)}Z`;
  if (new Date(milliseconds).toISOString() !== milliseconds) throw new Error("T2_INSTANT_INVALID");
  return value;
}

function hash64(value: unknown, label: string): string {
  if (typeof value !== "string" || !HASH64.test(value)) throw new Error(`T2_${label.toUpperCase()}_INVALID`);
  return value;
}

function boundedInteger(value: unknown, minimum: number, maximum: number, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < minimum || (value as number) > maximum) throw new Error(`T2_${label.toUpperCase()}_INVALID`);
  return value as number;
}

function nonNegativeInteger(value: unknown, label: string): number { return boundedInteger(value, 0, 2_147_483_647, label); }
function boolean(value: unknown, label: string): boolean { if (typeof value !== "boolean") throw new Error(`T2_${label.toUpperCase()}_INVALID`); return value; }

function enumValue<const T extends readonly string[]>(value: unknown, allowed: T, label: string): T[number] {
  if (typeof value !== "string" || !allowed.includes(value)) throw new Error(`T2_${label.toUpperCase()}_INVALID`);
  return value as T[number];
}

function nullableEnum<const T extends readonly string[]>(value: unknown, allowed: T, label: string): T[number] | null {
  return value === null ? null : enumValue(value, allowed, label);
}

function nullableCode(value: unknown, label: string): string | null {
  return value === null ? null : subject(value, label);
}

function nullableOpaqueId(value: unknown, label: string): string | null {
  if (value === null) return null;
  if (typeof value !== "string" || value !== value.normalize("NFC") || CONTROL.test(value) || Buffer.byteLength(value, "utf8") < 1 || Buffer.byteLength(value, "utf8") > 256) throw new Error(`T2_${label.toUpperCase()}_INVALID`);
  return value;
}
