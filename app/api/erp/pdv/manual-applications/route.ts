import { currentOrganization, tenantDb } from "@/db";
import { tenantManualT2ReserveClient } from "@/db/tenant-manual-t2-reserve";
import { AuthError, authErrorResponse } from "@/lib/auth";
import { LicenseDeniedError } from "@/lib/billing/license";
import { assertSameOrigin, CustomerInputError } from "@/lib/erp/customer-input";
import { assertPosMutationRequest, enforcePosRateLimit, PosHttpError, readPosJson } from "@/lib/erp/pos-http";
import type { PosManualT2ApplicationStatus, PosManualT2ReserveExecution } from "@/lib/erp/pos-manual-t2-reserve";
import { postgresErrorCode } from "@/lib/erp/postgres-error";
import { assertTenantPermission } from "@/lib/erp/permissions";
import { assertTenantWriteAccess } from "@/lib/tenant-access";

const noStoreHeaders = { "cache-control": "no-store, max-age=0", expires: "0", pragma: "no-cache" };
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;
const IDEMPOTENCY_KEY = /^(?:[0-9a-f]{64}|[A-Za-z0-9_-]{43})$/u;

export async function GET(request: Request) {
  try {
    assertSameOrigin(request);
    const organization = await currentOrganization();
    const access = await assertTenantPermission(organization.id, "pdv.read");
    const db = await tenantDb(organization.id);
    const profile = await activeProfile(db, access.user.id);
    const query = parseQuery(new URL(request.url).searchParams);

    if (query.applicationId) {
      const application = await db.posManualPaymentApplication.findUnique({
        where: { id: query.applicationId },
        select: { id: true, case: { select: { branchId: true, registerId: true, operatorProfileId: true } } },
      });
      if (!application || !await mayReadCase(db, access.membership.role, profile.id, application.case)) return json({ status: "not_found" });
      await enforcePosRateLimit(db, access.user.id, "manual-application.status");
      const client = await tenantManualT2ReserveClient(organization.id);
      const status = await client.status(application.id, access.user.id);
      return json(statusPayload(status));
    }

    if (!query.branchId) throw new ManualApplicationHttpError("Informe a filial da fila manual.", 400);
    if (!(["owner", "admin"] as string[]).includes(access.membership.role)) await assertTenantPermission(organization.id, "reconciliation.read");
    const branch = await db.branch.findFirst({ where: { id: query.branchId, status: "active" }, select: { id: true, code: true, name: true } });
    if (!branch) throw new ManualApplicationHttpError("Filial ativa não encontrada.", 404);
    if (!await mayReadBranch(db, access.membership.role, profile.id, branch.id)) throw new ManualApplicationHttpError("Seu perfil não pode consultar a fila manual desta filial.", 403);
    await enforcePosRateLimit(db, access.user.id, "manual-application.status");

    const [cases, enabledGateCount] = await Promise.all([
      db.posManualPaymentCase.findMany({
        where: { branchId: branch.id, state: { in: ["confirmed_paid", "application_pending", "applied", "blocked"] } },
        orderBy: [{ updatedAt: "desc" }, { id: "asc" }],
        take: 50,
        select: {
          id: true, version: true, state: true, amountCents: true, currency: true, provider: true, method: true,
          referenceLastFour: true, expiresAt: true, updatedAt: true, register: { select: { id: true, code: true, name: true } },
          makerProfile: { select: { displayName: true } },
          application: { select: { id: true, version: true, state: true, reservationExpiresAt: true, saleId: true, salePaymentId: true, failureClass: true, blockedCode: true } },
        },
      }),
      readableEnabledGateCount(db, branch.id),
    ]);
    return json({
      branch,
      // The runtime role intentionally cannot read the protected gate table in
      // hardened tenants. In that case the authoritative reserve procedure is
      // still responsible for enforcing hard-off; the UI must not crash or
      // incorrectly disable a gate that may be active.
      hardOff: enabledGateCount === 0,
      gateVisibility: enabledGateCount == null ? "protected" : "visible",
      cases: cases.map(item => ({
        id: item.id, version: item.version, state: item.state, amountCents: item.amountCents, currency: item.currency,
        provider: item.provider, method: item.method, referenceLastFour: item.referenceLastFour,
        caseExpiresAt: item.expiresAt.toISOString(), updatedAt: item.updatedAt.toISOString(), register: item.register,
        makerName: item.makerProfile.displayName,
        application: item.application ? {
          id: item.application.id, version: item.application.version, state: item.application.state,
          reservationExpiresAt: item.application.reservationExpiresAt.toISOString(), saleId: item.application.saleId,
          paymentId: item.application.salePaymentId, failureClass: item.application.failureClass, blockedCode: item.application.blockedCode,
        } : null,
      })),
    });
  } catch (error) {
    return failure(error, "status");
  }
}

export async function POST(request: Request) {
  let action = "reserve";
  try {
    assertSameOrigin(request);
    assertPosMutationRequest(request);
    const organization = await currentOrganization();
    const access = await assertTenantPermission(organization.id, "pdv.write");
    await assertTenantWriteAccess(organization.id);
    const db = await tenantDb(organization.id);
    const profile = await activeProfile(db, access.user.id);
    const body = await readPosJson(request, 16_384);
    action = text(body.action, "Ação");
    if (action !== "reserve" && action !== "probe") throw new ManualApplicationHttpError("Ação de aplicação manual inválida.", 400);
    onlyKeys(body, ["action", "caseId", "expectedCaseVersion", "idempotencyKey"]);
    const caseId = uuid(body.caseId, "Caso"), expectedCaseVersion = integer(body.expectedCaseVersion, "Versão do caso");
    const idempotencyKey = key(body.idempotencyKey);
    const manualCase = await db.posManualPaymentCase.findUnique({ where: { id: caseId }, select: { id: true, branchId: true, registerId: true, operatorProfileId: true, version: true } });
    if (!manualCase || !await mayWriteCase(db, access.membership.role, profile.id, manualCase)) throw new ManualApplicationHttpError("Caso manual não encontrado no contexto autorizado.", 404);
    if (action === "reserve" && manualCase.version !== expectedCaseVersion) throw new ManualApplicationHttpError("O caso manual mudou. Atualize a fila antes de reservar.", 409);
    await enforcePosRateLimit(db, access.user.id, action === "reserve" ? "manual-application.reserve" : "manual-application.probe");
    const client = await tenantManualT2ReserveClient(organization.id);
    const input = { caseId, expectedCaseVersionBeforeReserve: expectedCaseVersion, actorProfileId: profile.id, actorUserId: access.user.id, idempotencyKey };
    if (action === "probe") return json(probePayload(await client.probe(input)));
    const execution = await client.reserveWithLostCommitProbe(input);
    return json(reservePayload(execution), execution.outcome === "committed" && !execution.winner.replayed ? 201 : 200);
  } catch (error) {
    return failure(error, action);
  }
}

type Db = Awaited<ReturnType<typeof tenantDb>>;
type CaseScope = { branchId: number; registerId: number; operatorProfileId: number };

async function activeProfile(db: Db, userId: string) {
  const profile = await db.tenantUserProfile.findUnique({ where: { userId }, select: { id: true, status: true } });
  if (!profile || profile.status !== "active") throw new ManualApplicationHttpError("Perfil operacional ativo não configurado.", 403);
  return profile;
}

async function mayReadBranch(db: Db, role: string, profileId: number, branchId: number) {
  if ((["owner", "admin"] as string[]).includes(role)) return true;
  return Boolean(await db.branchUserAccess.findFirst({ where: { branchId, userProfileId: profileId, canSell: true }, select: { id: true } }));
}

async function mayReadCase(db: Db, role: string, profileId: number, scope: CaseScope) {
  if ((["owner", "admin"] as string[]).includes(role) || scope.operatorProfileId === profileId) return true;
  return Boolean(await db.posRegisterAccess.findFirst({ where: { registerId: scope.registerId, userProfileId: profileId, active: true, canReviewManualPayment: true }, select: { id: true } }));
}

async function mayWriteCase(db: Db, role: string, profileId: number, scope: CaseScope) {
  if (!await mayReadBranch(db, role, profileId, scope.branchId)) return false;
  if ((["owner", "admin"] as string[]).includes(role)) return true;
  const grant = await db.posRegisterAccess.findFirst({
    where: { registerId: scope.registerId, userProfileId: profileId, active: true, OR: [{ canManualPayment: true }, { canReviewManualPayment: true }] },
    select: { id: true },
  });
  return Boolean(grant);
}

async function readableEnabledGateCount(db: Db, branchId: number) {
  try {
    return await db.posManualPaymentReconciliationGate.count({ where: { enabled: true, connector: { branchId, status: "active" } } });
  } catch (error) {
    if (postgresErrorCode(error) === "42501") return null;
    throw error;
  }
}

function parseQuery(parameters: URLSearchParams) {
  const allowed = new Set(["applicationId", "branchId"]);
  for (const name of parameters.keys()) {
    if (!allowed.has(name)) throw new ManualApplicationHttpError(`Parâmetro não permitido: ${name}.`, 400);
    if (parameters.getAll(name).length !== 1) throw new ManualApplicationHttpError(`Parâmetro repetido: ${name}.`, 400);
  }
  const application = parameters.get("applicationId"), branch = parameters.get("branchId");
  if (application && branch) throw new ManualApplicationHttpError("Consulte uma aplicação ou uma fila por vez.", 400);
  return { applicationId: application ? uuid(application, "Aplicação") : null, branchId: branch ? positiveInteger(branch, "Filial") : null };
}

function reservePayload(execution: PosManualT2ReserveExecution) {
  if (execution.outcome === "committed") return { outcome: execution.outcome, replayed: execution.winner.replayed, expired: expired(execution.winner.reservationExpiresAt), application: execution.winner };
  return probePayload(execution);
}

function probePayload(result: Exclude<PosManualT2ReserveExecution, { outcome: "committed" }>) {
  return { outcome: result.outcome, expired: result.winner ? expired(result.winner.reservationExpiresAt) : null, application: result.winner };
}

function statusPayload(result: { status: "not_found" } | PosManualT2ApplicationStatus) {
  if ("status" in result) return result;
  return { application: result, expired: expired(result.reservationExpiresAt) };
}

function expired(value: string) { return Date.parse(value) <= Date.now(); }

function uuid(value: unknown, label: string) {
  const result = typeof value === "string" ? value.normalize("NFKC").trim().toLowerCase() : "";
  if (!UUID.test(result)) throw new ManualApplicationHttpError(`${label} inválida.`, 400);
  return result;
}

function text(value: unknown, label: string) {
  const result = typeof value === "string" ? value.normalize("NFKC").trim() : "";
  if (!result) throw new ManualApplicationHttpError(`${label} inválida.`, 400);
  return result;
}

function integer(value: unknown, label: string) {
  const result = Number(value);
  if (!Number.isSafeInteger(result) || result < 0 || result > 2_147_483_647) throw new ManualApplicationHttpError(`${label} inválida.`, 400);
  return result;
}

function positiveInteger(value: unknown, label: string) {
  const result = integer(value, label);
  if (result < 1) throw new ManualApplicationHttpError(`${label} inválida.`, 400);
  return result;
}

function key(value: unknown) {
  const result = typeof value === "string" ? value.trim() : "";
  if (!IDEMPOTENCY_KEY.test(result)) throw new ManualApplicationHttpError("Chave idempotente inválida.", 400);
  return result;
}

function onlyKeys(value: Record<string, unknown>, allowed: readonly string[]) {
  const accepted = new Set(allowed);
  for (const name of Object.keys(value)) if (!accepted.has(name)) throw new ManualApplicationHttpError(`Campo não permitido: ${name}.`, 400);
}

class ManualApplicationHttpError extends Error {
  constructor(message: string, readonly status: number) { super(message); }
}

function failure(error: unknown, action: string) {
  if (error instanceof ManualApplicationHttpError || error instanceof PosHttpError) return json({ error: error.message }, error.status);
  if (error instanceof CustomerInputError) return json({ error: error.message }, error.message.includes("Origem") ? 403 : 422);
  if (error instanceof LicenseDeniedError) return json({ error: error.message }, error.status);
  if (error instanceof AuthError) {
    const response = authErrorResponse(error); response.headers.set("cache-control", "no-store"); return response;
  }
  const code = postgresErrorCode(error);
  if (code === "23505") return json({ error: "A chave idempotente já pertence a outra solicitação. Atualize a fila sem trocar a chave desta tentativa." }, 409);
  if (code === "40001" || code === "40P01") return json({ error: "Conflito concorrente ao reservar. Repita com a mesma chave idempotente." }, 409);
  if (code === "42501") return json({ error: "O perfil, o gate ou as concessões necessárias não estão ativos para esta aplicação." }, 403);
  if (code === "25001") return json({ error: "A conexão serializável dedicada do T2-02 não está disponível." }, 503);
  if (code === "55000") return json({ error: "A finalização manual permanece em hard-off até gate, perfil e homologação estarem vigentes." }, 409);
  if (code === "42883" || code === "P2021" || code === "P2022") return json({ error: "A infraestrutura T2-02 ainda não foi aplicada integralmente neste tenant." }, 503);
  if (code === "22023" || code === "23514") return json({ error: "O caso não satisfaz o contrato vigente de finalização manual." }, 422);
  if (code === "57014") return json({ error: "O resultado do commit permanece desconhecido. Use Sondar commit com a mesma chave." }, 504);
  console.error(`POS manual application ${action} failed`, { error: error instanceof Error ? error.name : typeof error });
  return json({ error: action === "status" ? "Não foi possível consultar a aplicação manual." : "Não foi possível reservar a aplicação manual. O recurso permanece bloqueado com segurança." }, 500);
}

function json(body: unknown, status = 200) { return Response.json(body, { status, headers: noStoreHeaders }); }
