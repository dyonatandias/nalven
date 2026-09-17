/* eslint-disable @typescript-eslint/no-explicit-any */
import { randomUUID } from "node:crypto";
import { currentOrganization, tenantDb } from "@/db";
import { AuthError, authErrorResponse } from "@/lib/auth";
import { LicenseDeniedError } from "@/lib/billing/license";
import { assertSameOrigin, CustomerInputError } from "@/lib/erp/customer-input";
import { assertTenantPermission } from "@/lib/erp/permissions";
import {
  adjustmentInput,
  contractId,
  contractInput,
  ContractInputError,
} from "@/lib/erp/contract-input";
import { assertTenantWriteAccess } from "@/lib/tenant-access";
import { HttpSecurityError, readJsonObject } from "@/lib/http-security";
const include = {
  customer: { select: { id: true, name: true, tradeName: true } },
  cycles: { orderBy: { dueAt: "desc" as const } },
  adjustments: { orderBy: { effectiveAt: "desc" as const } },
};
export const dynamic = "force-dynamic";
const NO_STORE = { "cache-control": "no-store" };
export async function GET(request: Request) {
  try {
    const org = await currentOrganization();
    await assertTenantPermission(org.id, "contracts.read");
    const db = await tenantDb(org.id), parameters = new URL(request.url).searchParams,
      page = Math.max(1, Number(parameters.get("page")) || 1), limit = Math.max(10, Math.min(250, Number(parameters.get("limit")) || 250)),
      search = (parameters.get("search") || "").trim().slice(0, 100), requestedStatus = parameters.get("status") || "",
      where = { ...(["draft", "active", "paused", "cancelled"].includes(requestedStatus) ? { status: requestedStatus } : {}), ...(search ? { OR: [{ number: { contains: search, mode: "insensitive" as const } }, { name: { contains: search, mode: "insensitive" as const } }, { customer: { name: { contains: search, mode: "insensitive" as const } } }] } : {}) },
      [items, total, customers, activeCount, activeAmount, dueCount, cycleCount] = await Promise.all([
        db.serviceContract.findMany({
          where,
          include,
          orderBy: { createdAt: "desc" },
          skip: (page - 1) * limit,
          take: limit,
        }),
        db.serviceContract.count({ where }),
        db.customer.findMany({
          where: { status: "active" },
          select: { id: true, name: true, tradeName: true },
          orderBy: { name: "asc" },
        }),
        db.serviceContract.count({ where: { status: "active" } }),
        db.serviceContract.aggregate({ where: { status: "active" }, _sum: { amount: true } }),
        db.serviceContract.count({ where: { status: "active", nextBillingAt: { lte: new Date() } } }),
        db.contractCycle.count(),
      ]);
    return Response.json({
      items,
      customers,
      pagination: { page, limit, total, pages: Math.max(1, Math.ceil(total / limit)) },
      summary: {
        active: activeCount,
        mrr: activeAmount._sum.amount || 0,
        due: dueCount,
        cycles: cycleCount,
      },
    }, { headers: NO_STORE });
  } catch (e) {
    return fail(e);
  }
}
export async function POST(request: Request) {
  try {
    assertSameOrigin(request);
    const org = await currentOrganization(),
      access = await assertTenantPermission(org.id, "contracts.write");
    await assertTenantWriteAccess(org.id);
    const db = await tenantDb(org.id),
      body = await readJsonObject(request, 524_288),
      correlationId = randomUUID();
    if (body.action === "create") {
      const input = contractInput(body),
        customer = await db.customer.findFirst({
          where: { id: input.customerId, status: "active" },
        });
      if (!customer)
        throw new ContractInputError("Cliente ativo não encontrado.");
      const number = `CTR-${new Date().getUTCFullYear()}-${randomUUID().slice(0, 8).toUpperCase()}`,
        contract = await db.$transaction(async (tx) => {
          const created = await tx.serviceContract.create({
            data: { ...input, number, createdBy: access.user.name },
            include,
          });
          await audit(tx, access.user.id, "contract.created", created.id, correlationId, null, {
            number,
            amount: created.amount,
            status: created.status,
          });
          return created;
        }, { isolationLevel: "Serializable" });
      return Response.json({ contract, correlationId }, { status: 201 });
    }
    const id = contractId(body.contractId),
      before = await db.serviceContract.findUnique({ where: { id }, include });
    if (!before)
      return Response.json(
        { error: "Contrato não encontrado." },
        { status: 404 },
      );
    if (body.action === "status") {
      const status = String(body.status);
      if (
        !["active", "paused", "cancelled"].includes(status) ||
        before.status === "cancelled"
      )
        throw new ContractInputError("Transição de contrato inválida.");
      const contract = await db.$transaction(async (tx) => {
        await tx.$queryRaw`SELECT id FROM service_contracts WHERE id = ${id} FOR UPDATE`;
        const changed = await tx.serviceContract.updateMany({ where: { id, status: before.status }, data: { status } });
        if (changed.count !== 1) throw new ContractInputError("O contrato foi alterado por outro usuário. Atualize a página.");
        const updated = await tx.serviceContract.findUniqueOrThrow({ where: { id }, include });
        await tx.tenantAuditEvent.create({ data: { actorId: access.user.id, action: `contract.${status}`, entityType: "service_contract", entityId: String(id), correlationId, beforeData: { status: before.status }, afterData: { status } } });
        return updated;
      }, { isolationLevel: "Serializable" });
      return Response.json({ contract, correlationId });
    }
    if (body.action === "adjust") {
      if (before.status === "cancelled")
        throw new ContractInputError(
          "Contrato cancelado não pode ser reajustado.",
        );
      const input = adjustmentInput(body),
        newAmount =
          Math.round(before.amount * (1 + input.percentage / 100) * 100) / 100,
        contract = await db.$transaction(async (tx) => {
          await tx.$queryRaw`SELECT id FROM service_contracts WHERE id = ${id} FOR UPDATE`;
          const current = await tx.serviceContract.findUniqueOrThrow({ where: { id }, select: { amount: true, status: true } });
          if (current.status === "cancelled" || current.amount !== before.amount) throw new ContractInputError("O contrato foi alterado por outro usuário. Atualize a página.");
          await tx.contractAdjustment.create({
            data: {
              contractId: id,
              oldAmount: before.amount,
              newAmount,
              percentage: input.percentage,
              reason: input.reason,
              effectiveAt: input.effectiveAt,
              actor: access.user.name,
            },
          });
          const updated = await tx.serviceContract.update({
            where: { id },
            data: { amount: newAmount },
            include,
          });
          await audit(tx, access.user.id, "contract.adjusted", id, correlationId, { amount: before.amount }, {
            amount: newAmount,
            percentage: input.percentage,
          });
          return updated;
        }, { isolationLevel: "Serializable" });
      return Response.json({ contract, correlationId });
    }
    if (body.action === "cycle")
      return await cycle(db, before, access.user, correlationId);
    throw new ContractInputError("Ação contratual inválida.");
  } catch (e) {
    return fail(e);
  }
}
async function cycle(
  db: Awaited<ReturnType<typeof tenantDb>>,
  before: any,
  user: { id: string; name: string },
  correlationId: string,
) {
  if (before.status !== "active")
    throw new ContractInputError("Somente contratos ativos geram cobrança.");
  const today = new Date();
  today.setUTCHours(23, 59, 59, 999);
  if (before.nextBillingAt > today)
    throw new ContractInputError("A próxima competência ainda não está vencida.");
  const result = await db.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM service_contracts WHERE id = ${before.id} FOR UPDATE`;
    const current = await tx.serviceContract.findUniqueOrThrow({
      where: { id: before.id },
      select: { id: true, number: true, status: true, nextBillingAt: true, amount: true, customerId: true },
    });
    if (current.status !== "active" || current.nextBillingAt > today)
      throw new ContractInputError("O contrato foi alterado ou ainda não está vencido. Atualize a página.");
    const reference = current.nextBillingAt.toISOString().slice(0, 7),
      dueAt = current.nextBillingAt;
    const cycle = await tx.contractCycle.create({
        data: {
          contractId: current.id,
          reference,
          amount: current.amount,
          dueAt,
        },
      }),
      title = await tx.financialTitle.create({
        data: {
          type: "receivable",
          description: `Contrato ${current.number} · ${reference}`,
          customerId: current.customerId,
          documentNumber: `${current.number}-${reference}`,
          sourceType: "contract_cycle",
          sourceId: String(cycle.id),
          amount: current.amount,
          dueAt,
        },
      });
    await tx.contractCycle.update({
      where: { id: cycle.id },
      data: { titleId: title.id },
    });
    const next = new Date(dueAt);
    next.setUTCMonth(next.getUTCMonth() + 1);
    const contract = await tx.serviceContract.update({
      where: { id: current.id },
      data: { nextBillingAt: next },
      include,
    });
    await tx.tenantAuditEvent.create({
      data: {
        actorId: user.id,
        action: "contract.cycle_generated",
        entityType: "service_contract",
        entityId: String(current.id),
        correlationId,
        afterData: { reference, amount: current.amount, titleId: title.id },
      },
    });
    return { contract, cycle: { ...cycle, titleId: title.id } };
  }, { isolationLevel: "Serializable" });
  return Response.json({ ...result, correlationId });
}
async function audit(
  db: Pick<Awaited<ReturnType<typeof tenantDb>>, "tenantAuditEvent">,
  actorId: string,
  action: string,
  id: number,
  correlationId: string,
  before: any,
  after: any,
) {
  await db.tenantAuditEvent.create({
    data: {
      actorId,
      action,
      entityType: "service_contract",
      entityId: String(id),
      correlationId,
      beforeData: before,
      afterData: after,
    },
  });
}
function fail(e: unknown) {
  if (e instanceof HttpSecurityError) return authErrorResponse(e);
  if (e instanceof ContractInputError || e instanceof CustomerInputError)
    return Response.json(
      { error: e.message },
      { status: e.message.includes("Origem") ? 403 : 400, headers: NO_STORE },
    );
  if (e instanceof LicenseDeniedError)
    return Response.json({ error: e.message }, { status: e.status, headers: NO_STORE });
  if (e && typeof e === "object" && "code" in e && e.code === "P2002")
    return Response.json(
      { error: "Este ciclo já foi gerado." },
      { status: 409, headers: NO_STORE },
    );
  if (e && typeof e === "object" && "code" in e && e.code === "P2034")
    return Response.json(
      { error: "O contrato foi alterado simultaneamente. Atualize e tente novamente." },
      { status: 409, headers: NO_STORE },
    );
  if (e instanceof AuthError) return authErrorResponse(e);
  console.error("contracts request failed", e instanceof Error ? e.name : "unknown");
  return Response.json({ error: "Não foi possível operar o contrato." }, { status: 500, headers: NO_STORE });
}
