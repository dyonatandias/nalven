import { createHash } from "node:crypto";

export const POS_SESSION_LIFECYCLE_ACTIONS = [
  "session.suspend",
  "session.resume",
  "session.handoff.request",
  "session.handoff.accept",
  "session.handoff.cancel",
] as const;

export type PosSessionLifecycleAction = typeof POS_SESSION_LIFECYCLE_ACTIONS[number];

type Common = {
  action: PosSessionLifecycleAction;
  idempotencyKey: string;
};

export type PosSessionLifecycleInput =
  | Common & { action: "session.suspend"; sessionId: number; expectedVersion: number; reason: string }
  | Common & { action: "session.resume"; sessionId: number; expectedVersion: number }
  | Common & { action: "session.handoff.request"; sessionId: number; expectedVersion: number; targetProfileId: number; reason: string }
  | Common & { action: "session.handoff.accept"; sessionId: number; handoffId: string; expectedSessionVersion: number; expectedHandoffRevision: number }
  | Common & { action: "session.handoff.cancel"; sessionId: number; handoffId: string; expectedSessionVersion: number; expectedHandoffRevision: number; reason: string };

export class PosSessionLifecycleError extends Error {
  constructor(message: string, readonly status = 400) {
    super(message);
  }
}

export function parsePosSessionLifecycleInput(value: unknown): PosSessionLifecycleInput {
  const body = record(value);
  const action = choice(body.action, POS_SESSION_LIFECYCLE_ACTIONS, "Ação");
  const common = { action, idempotencyKey: idempotency(body.idempotencyKey) };
  if (action === "session.suspend") {
    only(body, ["action", "sessionId", "expectedVersion", "reason", "idempotencyKey"]);
    return { ...common, action, sessionId: id(body.sessionId, "Turno"), expectedVersion: version(body.expectedVersion), reason: reason(body.reason) };
  }
  if (action === "session.resume") {
    only(body, ["action", "sessionId", "expectedVersion", "idempotencyKey"]);
    return { ...common, action, sessionId: id(body.sessionId, "Turno"), expectedVersion: version(body.expectedVersion) };
  }
  if (action === "session.handoff.request") {
    only(body, ["action", "sessionId", "expectedVersion", "targetProfileId", "reason", "idempotencyKey"]);
    return { ...common, action, sessionId: id(body.sessionId, "Turno"), expectedVersion: version(body.expectedVersion), targetProfileId: id(body.targetProfileId, "Operador de destino"), reason: reason(body.reason) };
  }
  if (action === "session.handoff.accept") {
    only(body, ["action", "sessionId", "handoffId", "expectedSessionVersion", "expectedHandoffRevision", "idempotencyKey"]);
    return { ...common, action, sessionId: id(body.sessionId, "Turno"), handoffId: entityId(body.handoffId), expectedSessionVersion: version(body.expectedSessionVersion), expectedHandoffRevision: version(body.expectedHandoffRevision) };
  }
  only(body, ["action", "sessionId", "handoffId", "expectedSessionVersion", "expectedHandoffRevision", "reason", "idempotencyKey"]);
  return { ...common, action, sessionId: id(body.sessionId, "Turno"), handoffId: entityId(body.handoffId), expectedSessionVersion: version(body.expectedSessionVersion), expectedHandoffRevision: version(body.expectedHandoffRevision), reason: reason(body.reason) };
}

export function hashPosSessionLifecycleInput(input: PosSessionLifecycleInput) {
  return createHash("sha256").update(canonical(input)).digest("hex");
}

export function assertPosSessionTransition(current: string, next: string) {
  const graph: Record<string, readonly string[]> = {
    open: ["suspended", "closing"],
    suspended: ["open"],
    closing: ["closed", "open"],
    closed: ["reopened"],
    reopened: [],
  };
  if (!graph[current]?.includes(next)) throw new PosSessionLifecycleError(`Transição de turno inválida: ${current} → ${next}.`, 409);
}

export function assertPosHandoffPending(input: { state: string; expiresAt: Date; revision: number }, expectedRevision: number, now = new Date()) {
  if (input.state !== "requested") throw new PosSessionLifecycleError("A passagem de turno já foi resolvida.", 409);
  if (input.revision !== expectedRevision) throw new PosSessionLifecycleError("A passagem de turno foi alterada por outra operação.", 409);
  if (!Number.isFinite(input.expiresAt.valueOf()) || input.expiresAt <= now) throw new PosSessionLifecycleError("A passagem de turno expirou; solicite uma nova.", 409);
}

export function posSessionHandoffExpiresAt(now = new Date(), ttlMinutes = 10) {
  if (!Number.isInteger(ttlMinutes) || ttlMinutes < 1 || ttlMinutes > 30) throw new PosSessionLifecycleError("Validade da passagem de turno inválida.");
  return new Date(now.valueOf() + ttlMinutes * 60_000);
}

function record(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new PosSessionLifecycleError("Corpo da operação de turno inválido.");
  return value as Record<string, unknown>;
}

function only(value: Record<string, unknown>, allowed: readonly string[]) {
  const unexpected = Object.keys(value).filter((key) => !allowed.includes(key));
  if (unexpected.length) throw new PosSessionLifecycleError(`Campo inesperado na operação de turno: ${unexpected[0]}.`);
}

function choice<const T extends readonly string[]>(value: unknown, values: T, label: string): T[number] {
  if (typeof value !== "string" || !values.includes(value)) throw new PosSessionLifecycleError(`${label} inválida.`);
  return value as T[number];
}

function id(value: unknown, label: string) {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1 || value > 2_147_483_647) throw new PosSessionLifecycleError(`${label} inválido.`);
  return value;
}

function version(value: unknown) {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1 || value > 2_147_483_647) throw new PosSessionLifecycleError("Versão esperada inválida.");
  return value;
}

function idempotency(value: unknown) {
  if (typeof value !== "string" || value.length < 16 || value.length > 160 || !/^[A-Za-z0-9._:-]+$/.test(value)) throw new PosSessionLifecycleError("Chave de idempotência inválida.");
  return value;
}

function entityId(value: unknown) {
  if (typeof value !== "string" || value.length < 8 || value.length > 100 || !/^[A-Za-z0-9_-]+$/.test(value)) throw new PosSessionLifecycleError("Passagem de turno inválida.");
  return value;
}

function reason(value: unknown) {
  if (typeof value !== "string") throw new PosSessionLifecycleError("Motivo obrigatório.");
  const normalized = value.trim();
  if (normalized.length < 8 || normalized.length > 500) throw new PosSessionLifecycleError("O motivo deve ter entre 8 e 500 caracteres.");
  return normalized;
}

function canonical(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${canonical(record[key])}`).join(",")}}`;
}
