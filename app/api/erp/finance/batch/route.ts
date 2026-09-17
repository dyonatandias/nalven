import { randomUUID } from "node:crypto";
import { Prisma } from "@/generated/tenant/client";
import { currentOrganization, tenantDb } from "@/db";
import { AuthError, authErrorResponse } from "@/lib/auth";
import { LicenseDeniedError } from "@/lib/billing/license";
import { assertSameOrigin, CustomerInputError } from "@/lib/erp/customer-input";
import { batchInput, FinanceInputError } from "@/lib/erp/finance-input";
import { assertTenantPermission } from "@/lib/erp/permissions";
import { assertTenantWriteAccess } from "@/lib/tenant-access";
import { HttpSecurityError, readJsonObject } from "@/lib/http-security";

export const dynamic = "force-dynamic";
const NO_STORE = { "cache-control": "private, no-store, max-age=0" };

export async function POST(request: Request) {
  try {
    assertSameOrigin(request);
    const organization = await currentOrganization();
    const access = await assertTenantPermission(organization.id, "finance.write");
    await assertTenantWriteAccess(organization.id);
    const input = batchInput(await readJsonObject(request, 1_048_576));
    const db = await tenantDb(organization.id);
    const correlationId = randomUUID();
    const changed = await db.$transaction(async (tx) => {
      await tx.$queryRaw(Prisma.sql`SELECT "id" FROM "financial_titles" WHERE "id" IN (${Prisma.join(input.ids)}) ORDER BY "id" FOR UPDATE`);
      const titles = await tx.financialTitle.findMany({ where: { id: { in: input.ids } }, include: { settlements: { where: { status: "posted" }, select: { id: true } } } });
      if (titles.length !== input.ids.length) throw new FinanceInputError("Um ou mais títulos não foram encontrados.");
      if (input.action === "cancel" && titles.some((title) => ["paid", "cancelled"].includes(title.status) || title.settlements.length))
        throw new FinanceInputError("A seleção contém títulos liquidados, cancelados ou com baixas ativas.");
      if (input.action === "reschedule" && titles.some((title) => ["paid", "cancelled"].includes(title.status)))
        throw new FinanceInputError("A seleção contém títulos que não podem ser reagendados.");
      const data = input.action === "cancel" ? { status: "cancelled" }
        : input.action === "reschedule" ? { dueAt: input.dueAt! }
          : { priority: input.priority! };
      await tx.financialTitle.updateMany({ where: { id: { in: input.ids } }, data });
      await tx.tenantAuditEvent.create({ data: {
        actorId: access.user.id,
        action: `financial_title.batch_${input.action}`,
        entityType: "financial_title",
        entityId: input.ids.join(","),
        correlationId,
        beforeData: { ids: input.ids },
        afterData: { ...data, reason: input.reason },
      } });
      return titles.length;
    }, { isolationLevel: "Serializable" });
    return Response.json({ changed, correlationId }, { headers: NO_STORE });
  } catch (error) {
    if (error instanceof HttpSecurityError) return authErrorResponse(error);
    if (error instanceof FinanceInputError || error instanceof CustomerInputError) return Response.json({ error: error.message }, { status: error.message.includes("Origem") ? 403 : 400, headers: NO_STORE });
    if (error instanceof LicenseDeniedError) return Response.json({ error: error.message }, { status: error.status, headers: NO_STORE });
    if (error instanceof AuthError) return authErrorResponse(error);
    if (error && typeof error === "object" && "code" in error && error.code === "P2034") return Response.json({ error: "Os títulos foram alterados por outro usuário. Atualize e tente novamente." }, { status: 409, headers: NO_STORE });
    console.error("finance batch operation failed", error instanceof Error ? error.name : "unknown");
    return Response.json({ error: "Não foi possível atualizar os títulos selecionados." }, { status: 500, headers: NO_STORE });
  }
}
