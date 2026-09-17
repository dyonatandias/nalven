import { randomUUID } from "node:crypto";
import { Prisma, type PrismaClient } from "@/generated/tenant/client";
import { tenantDb } from "@/db";
import { parseBearerToken, PosAgentError, verifyAgentToken } from "@/lib/erp/pos-agent-auth";
import { assertPosMutationRequest, PosHttpError, readPosJson } from "@/lib/erp/pos-http";
import { hashPosPrintAck, replayPosPrintAck, type PosPrintAckInput } from "@/lib/erp/pos-print-ack";
import { contactHash, IntegrationError, persistentRateLimit } from "@/lib/integrations/core";

type Context = { params: Promise<{ organizationId: string; terminalId: string }> };
type Db = PrismaClient;
type AgentContext = Awaited<ReturnType<typeof authenticate>>;

class PosPrintAckConcurrentError extends Error {}

export async function POST(request: Request, route: Context) {
  try {
    assertPosMutationRequest(request);
    const { organizationId, terminalId } = await route.params;
    if (!organizationId || organizationId.length > 160 || !terminalId || terminalId.length > 160) throw unauthorized();
    const db = await agentDb(organizationId), ip = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || "unknown";
    await persistentRateLimit(db, `pos-agent:auth:${terminalId}:${contactHash(ip)}`, 180, 60);
    const context = await authenticate(db, organizationId, terminalId, request.headers.get("authorization"));
    const body = await readPosJson(request, 131_072), action = actionValue(body.action);
    await persistentRateLimit(db, `pos-agent:${terminalId}:${action}`, action === "heartbeat" ? 120 : 60, 60);
    if (action === "heartbeat") return heartbeat(context, body);
    if (action === "device.health") return deviceHealth(context, body);
    if (action === "print.pull") return pullPrintJobs(context, body);
    return acknowledgePrintJobs(context, body);
  } catch (error) {
    return failure(error);
  }
}

async function authenticate(db: Db, organizationId: string, terminalId: string, authorization: string | null) {
  const token = parseBearerToken(authorization);
  const terminal = await db.posTerminal.findFirst({ where: { id: terminalId }, include: { register: { include: { branch: { select: { id: true, status: true } } } } } });
  const now = new Date();
  if (!terminal || !verifyAgentToken(terminal.tokenHash, organizationId, terminalId, token) || !terminal.tokenExpiresAt || terminal.tokenExpiresAt <= now || ["unpaired", "revoked"].includes(terminal.status) || terminal.register.status !== "active" || terminal.register.branch.status !== "active") throw unauthorized();
  return { db, organizationId, terminal, now };
}

async function heartbeat(context: AgentContext, body: Record<string, unknown>) {
  onlyKeys(body, ["action", "appVersion"]);
  const appVersion = text(body.appVersion, 64, "Versão do agente");
  const changed = await context.db.posTerminal.updateMany({ where: liveAgentWhere(context), data: { status: "online", appVersion, lastSeenAt: context.now } });
  if (changed.count !== 1) throw unauthorized();
  return Response.json({ accepted: true, serverTime: context.now, terminal: { id: context.terminal.id, status: "online", credentialVersion: context.terminal.credentialVersion, tokenExpiresAt: context.terminal.tokenExpiresAt } });
}

async function deviceHealth(context: AgentContext, body: Record<string, unknown>) {
  onlyKeys(body, ["action", "updates"]);
  if (!Array.isArray(body.updates) || !body.updates.length || body.updates.length > 50) throw new PosAgentError("Informe de um a cinquenta dispositivos.");
  const updates = body.updates.map((raw, index) => healthInput(raw, index));
  if (new Set(updates.map(item => item.deviceId)).size !== updates.length) throw new PosAgentError("A lista de dispositivos contém identificadores repetidos.");
  const result = await context.db.$transaction(async tx => {
    await assertLiveAgentCredential(tx, context);
    const owned = await tx.posDevice.findMany({ where: { terminalId: context.terminal.id, id: { in: updates.map(item => item.deviceId) } }, select: { id: true } });
    if (owned.length !== updates.length) throw new PosAgentError("Um dos dispositivos não pertence a este terminal.", 403);
    for (const update of updates) await tx.posDevice.update({ where: { id: update.deviceId }, data: { status: update.status, lastError: update.lastError, lastSeenAt: context.now } });
    await tx.posTerminal.update({ where: { id: context.terminal.id }, data: { status: "online", lastSeenAt: context.now } });
    return updates.map(item => ({ id: item.deviceId, status: item.status, lastSeenAt: context.now }));
  }, { isolationLevel: "Serializable" });
  return Response.json({ accepted: true, devices: result, serverTime: context.now });
}

async function pullPrintJobs(context: AgentContext, body: Record<string, unknown>) {
  onlyKeys(body, ["action", "limit"]);
  const limit = body.limit == null ? 10 : integer(body.limit, 1, 20, "Limite");
  const jobs = await context.db.$transaction(async tx => {
    await assertLiveAgentCredential(tx, context);
    await tx.posPrintJob.updateMany({ where: { terminalId: context.terminal.id, status: "processing", attempts: { gte: 5 }, claimExpiresAt: { lt: context.now } }, data: { status: "failed", claimId: null, claimedAt: null, claimExpiresAt: null, lastError: "Prazo de impressão excedido após cinco tentativas." } });
    const candidates = await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`
      SELECT "id" FROM "pos_print_jobs"
      WHERE "terminal_id" = ${context.terminal.id}
        AND "attempts" < 5
        AND ("status" = 'queued' OR ("status" = 'processing' AND "claim_expires_at" < ${context.now}))
      ORDER BY "created_at" ASC
      FOR UPDATE SKIP LOCKED
      LIMIT ${limit}
    `);
    const claims = new Map<string, string>();
    for (const candidate of candidates) {
      const claimId = randomUUID();
      claims.set(candidate.id, claimId);
      await tx.posPrintJob.update({ where: { id: candidate.id }, data: { status: "processing", attempts: { increment: 1 }, claimId, claimedAt: context.now, claimExpiresAt: new Date(context.now.valueOf() + 2 * 60_000), lastError: null } });
    }
    await tx.posTerminal.update({ where: { id: context.terminal.id }, data: { status: "online", lastSeenAt: context.now } });
    const records = candidates.length ? await tx.posPrintJob.findMany({ where: { id: { in: candidates.map(item => item.id) } } }) : [];
    return candidates.map(candidate => {
      const job = records.find(item => item.id === candidate.id)!;
      return { id: job.id, claimId: claims.get(job.id), type: job.type, referenceType: job.referenceType, referenceId: job.referenceId, templateVersion: job.templateVersion, payload: job.payload, attempt: job.attempts, claimExpiresAt: job.claimExpiresAt };
    });
  }, { isolationLevel: "Serializable" });
  return Response.json({ jobs, serverTime: context.now }, { headers: { "cache-control": "no-store" } });
}

async function acknowledgePrintJobs(context: AgentContext, body: Record<string, unknown>) {
  onlyKeys(body, ["action", "acknowledgements"]);
  if (!Array.isArray(body.acknowledgements) || !body.acknowledgements.length || body.acknowledgements.length > 20) throw new PosAgentError("Informe de um a vinte ACKs de impressão.");
  const acknowledgements = body.acknowledgements.map((raw, index) => printAck(raw, index));
  if (new Set(acknowledgements.map(item => item.jobId)).size !== acknowledgements.length) throw new PosAgentError("A lista de ACKs contém jobs repetidos.");
  if (new Set(acknowledgements.map(item => item.claimId)).size !== acknowledgements.length) throw new PosAgentError("A lista de ACKs contém claims repetidos.");
  const inputs = acknowledgements.map((acknowledgement): PosPrintAckInput => ({ terminalId: context.terminal.id, ...acknowledgement }));
  let results: Array<{ id: string; status: string; replayed: boolean }>;
  try {
    results = await applyPrintAcknowledgements(context, inputs);
  } catch (error) {
    if (!(error instanceof PosPrintAckConcurrentError) && !new Set(["P2002", "P2034"]).has(prismaCode(error))) throw error;
    const concurrent = await replayAppliedPrintAcknowledgements(context, inputs);
    if (!concurrent) throw new PosAgentError("Conflito concorrente no ACK de impressão; tente novamente.", 409);
    results = concurrent;
  }
  return Response.json({ accepted: true, jobs: results, replayed: results.every(result => result.replayed), serverTime: context.now });
}

async function applyPrintAcknowledgements(context: AgentContext, inputs: PosPrintAckInput[]) {
  return context.db.$transaction(async tx => {
    await assertLiveAgentCredential(tx, context);
    const completed: Array<{ id: string; status: string; replayed: boolean }> = [];
    for (const input of inputs) {
      const existing = await tx.posPrintAcknowledgement.findUnique({ where: { claimId: input.claimId } });
      if (existing) {
        completed.push(replayPosPrintAck(existing, input));
        continue;
      }
      const job = await tx.posPrintJob.findFirst({ where: { id: input.jobId, terminalId: input.terminalId, status: "processing", claimId: input.claimId } });
      if (!job) throw new PosAgentError("ACK de impressão inválido, expirado ou já processado.", 409);
      const status = input.state === "printed" ? "printed" : job.attempts >= 5 ? "failed" : "queued";
      const changed = await tx.posPrintJob.updateMany({ where: { id: job.id, terminalId: input.terminalId, status: "processing", claimId: input.claimId }, data: { status, printedAt: input.state === "printed" ? context.now : null, lastError: input.state === "failed" ? input.error : null, claimId: null, claimedAt: null, claimExpiresAt: null } });
      if (changed.count !== 1) throw new PosPrintAckConcurrentError();
      const requestHash = hashPosPrintAck(input);
      const acknowledgement = await tx.posPrintAcknowledgement.create({ data: { terminalId: input.terminalId, jobId: job.id, claimId: input.claimId, requestHash, state: input.state, resultStatus: status, attempt: job.attempts, acknowledgedAt: context.now } });
      await tx.tenantAuditEvent.create({ data: { action: input.state === "printed" ? "pos.print.completed" : "pos.print.failed", entityType: "pos_print_job", entityId: job.id, afterData: { terminalId: input.terminalId, status, attempt: job.attempts, claimId: input.claimId, acknowledgementId: String(acknowledgement.id), requestHash } } });
      completed.push({ id: job.id, status, replayed: false });
    }
    await tx.posTerminal.update({ where: { id: context.terminal.id }, data: { status: "online", lastSeenAt: context.now } });
    return completed;
  }, { isolationLevel: "Serializable" });
}

async function replayAppliedPrintAcknowledgements(context: AgentContext, inputs: PosPrintAckInput[]) {
  return context.db.$transaction(async tx => {
    await assertLiveAgentCredential(tx, context);
    const records = await tx.posPrintAcknowledgement.findMany({ where: { claimId: { in: inputs.map(input => input.claimId) } } });
    if (records.length !== inputs.length) return null;
    const byClaim = new Map(records.map(record => [record.claimId, record]));
    return inputs.map(input => replayPosPrintAck(byClaim.get(input.claimId)!, input));
  }, { isolationLevel: "Serializable" });
}

function liveAgentWhere(context: AgentContext): Prisma.PosTerminalWhereInput {
  return {
    id: context.terminal.id,
    tokenHash: context.terminal.tokenHash,
    credentialVersion: context.terminal.credentialVersion,
    tokenExpiresAt: { gt: new Date() },
    status: { notIn: ["unpaired", "revoked"] },
    register: { status: "active", branch: { status: "active" } },
  };
}

async function assertLiveAgentCredential(tx: Prisma.TransactionClient, context: AgentContext) {
  if (!await tx.posTerminal.findFirst({ where: liveAgentWhere(context), select: { id: true } })) throw unauthorized();
}

function healthInput(raw: unknown, index: number) {
  const value = object(raw, `Dispositivo ${index + 1}`); onlyKeys(value, ["deviceId", "status", "lastError"]);
  const deviceId = text(value.deviceId, 100, "Dispositivo"), status = choice(value.status, ["online", "offline", "error", "unknown"] as const, "Status");
  const lastError = value.lastError == null || value.lastError === "" ? null : text(value.lastError, 500, "Erro");
  if (status === "error" && !lastError) throw new PosAgentError("Dispositivo com erro deve informar uma descrição.");
  return { deviceId, status, lastError: status === "error" ? lastError : null };
}

function printAck(raw: unknown, index: number) {
  const value = object(raw, `ACK ${index + 1}`); onlyKeys(value, ["jobId", "claimId", "state", "error"]);
  const state = choice(value.state, ["printed", "failed"] as const, "Estado do ACK"), error = value.error == null || value.error === "" ? null : text(value.error, 500, "Erro de impressão");
  if (state === "failed" && !error) throw new PosAgentError("ACK com falha deve informar o erro.");
  if (state === "printed" && error) throw new PosAgentError("ACK impresso não pode conter erro.");
  return { jobId: text(value.jobId, 100, "Job"), claimId: uuid(value.claimId), state, error };
}

function actionValue(value: unknown) { return choice(value, ["heartbeat", "device.health", "print.pull", "print.ack"] as const, "Ação"); }
function onlyKeys(value: Record<string, unknown>, allowed: string[]) { const extra = Object.keys(value).find(field => !allowed.includes(field)); if (extra) throw new PosAgentError(`Campo não permitido: ${extra}.`); }
function object(value: unknown, label: string) { if (!value || typeof value !== "object" || Array.isArray(value)) throw new PosAgentError(`${label} inválido.`); return value as Record<string, unknown>; }
function text(value: unknown, maximum: number, label: string) { const result = String(value ?? "").trim(); if (!result || result.length > maximum) throw new PosAgentError(`${label} inválido.`); return result; }
function integer(value: unknown, minimum: number, maximum: number, label: string) { const result = Number(value); if (!Number.isSafeInteger(result) || result < minimum || result > maximum) throw new PosAgentError(`${label} inválido.`); return result; }
function choice<const T extends readonly string[]>(value: unknown, choices: T, label: string): T[number] { const result = String(value ?? ""); if (!choices.includes(result)) throw new PosAgentError(`${label} inválida.`); return result as T[number]; }
function uuid(value: unknown) { const result = text(value, 36, "Claim"); if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(result)) throw new PosAgentError("Claim inválido."); return result; }
function unauthorized() { return new PosAgentError("Credencial do agente inválida, expirada ou revogada.", 401); }
async function agentDb(organizationId: string) { try { return await tenantDb(organizationId); } catch { throw unauthorized(); } }
function prismaCode(error: unknown) { return error && typeof error === "object" && "code" in error ? String(error.code) : ""; }
function failure(error: unknown) {
  if (error instanceof IntegrationError || error instanceof PosHttpError || error instanceof PosAgentError) return Response.json({ error: error.message }, { status: error.status });
  if ((error as { code?: string })?.code === "P2034") return Response.json({ error: "Conflito concorrente no agente; tente novamente." }, { status: 409 });
  console.error("POS agent operation failed", { error: error instanceof Error ? error.name : typeof error });
  return Response.json({ error: "Não foi possível concluir a operação do agente." }, { status: 500 });
}
