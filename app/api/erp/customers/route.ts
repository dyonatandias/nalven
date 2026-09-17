import { randomUUID } from "node:crypto";
import { Prisma } from "@/generated/tenant/client";
import { currentOrganization, tenantDb } from "@/db";
import { AuthError, authErrorResponse } from "@/lib/auth";
import { LicenseDeniedError } from "@/lib/billing/license";
import { customerCsv, customerHealth, duplicateCustomerGroups, parseCustomerQuery } from "@/lib/erp/customer-control";
import { assertSameOrigin, customerIds, customerInput, CustomerInputError } from "@/lib/erp/customer-input";
import { assertTenantPermission, matches } from "@/lib/erp/permissions";
import { assertPosMutationRequest, enforcePosRateLimit, PosHttpError, readPosJson } from "@/lib/erp/pos-http";
import { enqueueWebhook } from "@/lib/integrations/webhooks";
import { assertTenantWriteAccess } from "@/lib/tenant-access";

export const dynamic = "force-dynamic";
const NO_STORE = { "cache-control": "private, no-store, max-age=0", expires: "0", pragma: "no-cache" };
const customerInclude = {
  addresses: { where: { primary: true }, orderBy: { id: "asc" as const }, take: 1 },
  contacts: { where: { archivedAt: null }, orderBy: [{ primary: "desc" as const }, { name: "asc" as const }], take: 3 },
  tagLinks: { include: { tag: true }, orderBy: { createdAt: "asc" as const } },
  interactions: { where: { completedAt: null }, orderBy: [{ dueAt: "asc" as const }, { createdAt: "desc" as const }], take: 3 },
  _count: { select: { addresses: true, contacts: true, salesOrders: true, posSales: true, financialTitles: true, opportunities: true, contracts: true, serviceOrders: true } },
};
type Db = Awaited<ReturnType<typeof tenantDb>>;

export async function GET(request: Request) {
  try {
    const organization = await currentOrganization(), access = await assertTenantPermission(organization.id, "customers.read"), db = await tenantDb(organization.id);
    const query = parseCustomerQuery(new URL(request.url).searchParams), now = new Date();
    const attentionIds = await resolveAttention(db, query.attention, now);
    const where: Prisma.CustomerWhereInput = {
      ...(query.status ? { status: query.status } : {}), ...(query.segment ? { segment: query.segment } : {}), ...(query.risk ? { riskRating: query.risk } : {}),
      ...(attentionIds ? { id: { in: attentionIds } } : {}),
      ...(query.search ? { OR: [
        { name: { contains: query.search, mode: "insensitive" } }, { tradeName: { contains: query.search, mode: "insensitive" } },
        { document: { contains: query.search.replace(/\D/g, "") } }, { email: { contains: query.search, mode: "insensitive" } },
        { phone: { contains: query.search.replace(/\D/g, "") } }, { contacts: { some: { OR: [{ name: { contains: query.search, mode: "insensitive" } }, { email: { contains: query.search, mode: "insensitive" } }] } } },
      ] } : {}),
    };
    const orderBy: Prisma.CustomerOrderByWithRelationInput[] = query.sort === "recent" ? [{ updatedAt: "desc" }] : query.sort === "credit" ? [{ creditLimit: "desc" }, { name: "asc" }] : [{ status: "asc" }, { name: "asc" }];
    const take = query.format === "csv" ? 10_001 : query.limit;
    const rawItems = await db.customer.findMany({ where, include: customerInclude, orderBy, skip: query.format === "csv" ? 0 : (query.page - 1) * query.limit, take });
    if (query.format === "csv" && rawItems.length > 10_000) throw new CustomerInputError("A exportação excede 10.000 clientes. Aplique mais filtros.");
    const items = await enrichCustomers(db, rawItems, now);
    if (query.format === "csv") {
      return new Response(customerCsv(items.map((item) => ({ ...item, city: item.addresses[0]?.city, state: item.addresses[0]?.state, ...item.metrics }))), { headers: { ...NO_STORE, "content-type": "text/csv; charset=utf-8", "content-disposition": `attachment; filename="clientes-${now.toISOString().slice(0, 10)}.csv"` } });
    }

    const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 5, 1)), thirtyDaysAgo = new Date(now.valueOf() - 30 * 86_400_000);
    const [total, active, inactive, new30d, credit, titleTotals, overdueTitles, orderRevenue, posRevenue, segments, risks, created, incompleteEmail, incompletePhone, incompleteAddress, incompleteDocument, duplicateCandidates, tags] = await Promise.all([
      db.customer.count(), db.customer.count({ where: { status: "active" } }), db.customer.count({ where: { status: "inactive" } }), db.customer.count({ where: { createdAt: { gte: thirtyDaysAgo } } }),
      db.customer.aggregate({ where: { status: "active" }, _sum: { creditLimit: true } }),
      db.financialTitle.aggregate({ where: { type: "receivable", status: { in: ["open", "partial", "overdue"] } }, _sum: { amount: true, paidAmount: true } }),
      db.financialTitle.aggregate({ where: { type: "receivable", status: { in: ["open", "partial", "overdue"] }, dueAt: { lt: now } }, _sum: { amount: true, paidAmount: true } }),
      db.salesOrder.aggregate({ where: { customerId: { not: null }, deletedAt: null, status: { notIn: ["draft", "cancelled", "refunded"] } }, _sum: { total: true } }),
      db.sale.aggregate({ where: { customerId: { not: null }, status: "completed" }, _sum: { totalCents: true } }),
      db.customer.groupBy({ by: ["segment"], _count: { _all: true }, _sum: { creditLimit: true } }), db.customer.groupBy({ by: ["riskRating"], _count: { _all: true } }),
      db.customer.findMany({ where: { createdAt: { gte: monthStart } }, select: { createdAt: true } }),
      db.customer.count({ where: { OR: [{ email: null }, { email: "" }] } }), db.customer.count({ where: { OR: [{ phone: null }, { phone: "" }] } }),
      db.customer.count({ where: { addresses: { none: {} } } }), db.customer.count({ where: { document: "" } }),
      db.customer.findMany({ select: { id: true, name: true, email: true, phone: true }, take: 10_000 }), db.customerTag.findMany({ orderBy: { name: "asc" } }),
    ]);
    const openBalance = (titleTotals._sum.amount || 0) - (titleTotals._sum.paidAmount || 0), overdueBalance = (overdueTitles._sum.amount || 0) - (overdueTitles._sum.paidAmount || 0);
    const duplicates = duplicateCustomerGroups(duplicateCandidates), filteredTotal = await db.customer.count({ where });
    return Response.json({
      items, tags, duplicates, generatedAt: now.toISOString(), capabilities: { canWrite: matches(access.permissions, "customers.write") },
      pagination: { page: query.page, limit: query.limit, total: filteredTotal, pages: Math.max(1, Math.ceil(filteredTotal / query.limit)) },
      summary: { total, active, inactive, new30d, creditLimit: credit._sum.creditLimit || 0, revenue: (orderRevenue._sum.total || 0) + (posRevenue._sum.totalCents || 0) / 100, openBalance, overdueBalance, availableCredit: Math.max(0, (credit._sum.creditLimit || 0) - openBalance) },
      analytics: { segments, risks, growth: growthSeries(created.map((item) => item.createdAt), now), quality: { missingEmail: incompleteEmail, missingPhone: incompletePhone, missingAddress: incompleteAddress, missingDocument: incompleteDocument, duplicateGroups: duplicates.length } },
    }, { headers: NO_STORE });
  } catch (error) { return failure(error, "consultar"); }
}

export async function POST(request: Request) {
  try {
    assertSameOrigin(request); assertPosMutationRequest(request);
    const organization = await currentOrganization(), access = await assertTenantPermission(organization.id, "customers.write");
    await assertTenantWriteAccess(organization.id);
    const db = await tenantDb(organization.id), body = await readPosJson(request, 1_048_576), correlationId = randomUUID();
    await enforcePosRateLimit(db, access.user.id, "customers.mutation");
    if (body.action === "import") {
      if (!Array.isArray(body.rows) || body.rows.length < 1 || body.rows.length > 500) throw new CustomerInputError("A importação deve conter entre 1 e 500 clientes.");
      const inputs = body.rows.map((row, index) => { try { return customerInput(row); } catch (error) { if (error instanceof CustomerInputError) throw new CustomerInputError(`Linha ${index + 2}: ${error.message}`); throw error; } });
      const updateExisting = body.mode === "update", result = await db.$transaction(async (tx) => {
        let created = 0, updated = 0, skipped = 0;
        for (const input of inputs) {
          const existing = await tx.customer.findUnique({ where: { document: input.document }, select: { id: true } });
          if (existing && !updateExisting) { skipped += 1; continue; }
          const profile = { type: input.type, name: input.name, tradeName: input.tradeName, document: input.document, email: input.email, phone: input.phone, creditLimit: input.creditLimit, notes: input.notes, segment: input.segment, origin: input.origin, salesperson: input.salesperson, paymentTermsDays: input.paymentTermsDays, riskRating: input.riskRating, preferredChannel: input.preferredChannel };
          if (existing) {
            await tx.customer.update({ where: { id: existing.id }, data: { ...profile, version: { increment: 1 } } });
            const address = await tx.customerAddress.findFirst({ where: { customerId: existing.id, primary: true }, select: { id: true } });
            if (address) await tx.customerAddress.update({ where: { id: address.id }, data: input.address }); else await tx.customerAddress.create({ data: { customerId: existing.id, ...input.address, label: "Principal", primary: true } });
            updated += 1;
          } else {
            const createdCustomer = await tx.customer.create({ data: { ...profile, origin: input.origin === "manual" ? "manual" : input.origin, addresses: { create: { ...input.address, label: "Principal", primary: true } } } });
            await enqueueWebhook(tx, "customer.created", { id: createdCustomer.id, status: createdCustomer.status, occurred_at: new Date().toISOString(), correlation_id: correlationId }); created += 1;
          }
        }
        await tx.tenantAuditEvent.create({ data: { actorId: access.user.id, action: "customer.csv_imported", entityType: "customer", correlationId, afterData: { created, updated, skipped, total: inputs.length, mode: updateExisting ? "update" : "skip" } } });
        return { created, updated, skipped };
      }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
      return Response.json({ ...result, correlationId }, { headers: NO_STORE });
    }
    if (body.action === "batch.status") {
      const ids = customerIds(body.customerIds), status = body.status === "inactive" ? "inactive" : body.status === "active" ? "active" : "";
      if (!status) throw new CustomerInputError("Status inválido.");
      const changed = await db.$transaction(async (tx) => {
        const result = await tx.customer.updateMany({ where: { id: { in: ids } }, data: { status, version: { increment: 1 } } });
        await tx.tenantAuditEvent.create({ data: { actorId: access.user.id, action: "customer.batch_status_changed", entityType: "customer", correlationId, afterData: { ids, status, count: result.count } } });
        return result.count;
      }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
      return Response.json({ changed, correlationId }, { headers: NO_STORE });
    }
    if (body.action === "batch.tag") {
      const ids = customerIds(body.customerIds), tagId = Number(body.tagId);
      if (!Number.isInteger(tagId) || tagId <= 0 || !await db.customerTag.findUnique({ where: { id: tagId }, select: { id: true } })) throw new CustomerInputError("Etiqueta inválida.");
      const result = await db.customerTagLink.createMany({ data: ids.map((customerId) => ({ customerId, tagId })), skipDuplicates: true });
      await db.tenantAuditEvent.create({ data: { actorId: access.user.id, action: "customer.batch_tagged", entityType: "customer", correlationId, afterData: { ids, tagId, count: result.count } } });
      return Response.json({ changed: result.count, correlationId }, { headers: NO_STORE });
    }
    const input = customerInput(body);
    const customer = await db.$transaction(async (tx) => {
      const created = await tx.customer.create({ data: { type: input.type, name: input.name, tradeName: input.tradeName, document: input.document, email: input.email, phone: input.phone, creditLimit: input.creditLimit, notes: input.notes, segment: input.segment, origin: input.origin, salesperson: input.salesperson, paymentTermsDays: input.paymentTermsDays, riskRating: input.riskRating, preferredChannel: input.preferredChannel, addresses: { create: { ...input.address, label: "Principal", primary: true } } }, include: customerInclude });
      await tx.tenantAuditEvent.create({ data: { actorId: access.user.id, action: "customer.created", entityType: "customer", entityId: String(created.id), correlationId, afterData: { name: created.name, document: created.document, status: created.status, segment: created.segment } } });
      await enqueueWebhook(tx, "customer.created", { id: created.id, status: created.status, occurred_at: new Date().toISOString(), correlation_id: correlationId });
      return created;
    }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
    return Response.json({ customer, correlationId }, { status: 201, headers: NO_STORE });
  } catch (error) { return failure(error, "salvar"); }
}

async function resolveAttention(db: Db, attention: string, now: Date) {
  if (attention === "overdue") return (await db.financialTitle.findMany({ where: { customerId: { not: null }, type: "receivable", status: { in: ["open", "partial", "overdue"] }, dueAt: { lt: now } }, distinct: ["customerId"], select: { customerId: true } })).flatMap((item) => item.customerId == null ? [] : [item.customerId]);
  if (attention === "tasks") return (await db.customerInteraction.findMany({ where: { completedAt: null, dueAt: { not: null } }, distinct: ["customerId"], select: { customerId: true } })).map((item) => item.customerId);
  if (attention === "incomplete") return (await db.customer.findMany({ where: { OR: [{ email: null }, { phone: null }, { addresses: { none: {} } }] }, select: { id: true } })).map((item) => item.id);
  return null;
}

async function enrichCustomers<T extends { id: number; creditLimit: number; email: string | null; phone: string | null; document: string; riskRating: string; status: string; addresses: unknown[] }>(db: Db, customers: T[], now: Date) {
  const ids = customers.map((item) => item.id);
  if (!ids.length) return [];
  const [orders, sales, titles, overdue, tasks] = await Promise.all([
    db.salesOrder.groupBy({ by: ["customerId"], where: { customerId: { in: ids }, deletedAt: null, status: { notIn: ["draft", "cancelled", "refunded"] } }, _sum: { total: true }, _count: { _all: true }, _max: { createdAt: true } }),
    db.sale.groupBy({ by: ["customerId"], where: { customerId: { in: ids }, status: "completed" }, _sum: { totalCents: true }, _count: { _all: true }, _max: { createdAt: true } }),
    db.financialTitle.groupBy({ by: ["customerId"], where: { customerId: { in: ids }, type: "receivable", status: { in: ["open", "partial", "overdue"] } }, _sum: { amount: true, paidAmount: true } }),
    db.financialTitle.groupBy({ by: ["customerId"], where: { customerId: { in: ids }, type: "receivable", status: { in: ["open", "partial", "overdue"] }, dueAt: { lt: now } }, _sum: { amount: true, paidAmount: true } }),
    db.customerInteraction.groupBy({ by: ["customerId"], where: { customerId: { in: ids }, completedAt: null }, _count: { _all: true }, _min: { dueAt: true } }),
  ]);
  const orderMap = keyed(orders), saleMap = keyed(sales), titleMap = keyed(titles), overdueMap = keyed(overdue), taskMap = keyed(tasks);
  return customers.map((customer) => {
    const order = orderMap.get(customer.id), sale = saleMap.get(customer.id), title = titleMap.get(customer.id), late = overdueMap.get(customer.id), task = taskMap.get(customer.id);
    const openBalance = (title?._sum.amount || 0) - (title?._sum.paidAmount || 0), overdueBalance = (late?._sum.amount || 0) - (late?._sum.paidAmount || 0), pendingTasks = task?._count._all || 0;
    const metrics = { revenue: (order?._sum.total || 0) + (sale?._sum.totalCents || 0) / 100, orders: (order?._count._all || 0) + (sale?._count._all || 0), openBalance, overdueBalance, availableCredit: Math.max(0, customer.creditLimit - openBalance), pendingTasks, nextTaskAt: task?._min.dueAt || null, lastPurchaseAt: latest(order?._max.createdAt, sale?._max.createdAt) };
    return { ...customer, metrics, health: customerHealth({ ...customer, overdueBalance, pendingTasks }) };
  });
}

function keyed<T extends { customerId: number | null }>(items: T[]) { return new Map(items.flatMap((item) => item.customerId == null ? [] : [[item.customerId, item] as const])); }
function latest(one?: Date | null, two?: Date | null) { if (!one) return two || null; if (!two) return one; return one > two ? one : two; }
function growthSeries(dates: Date[], now: Date) { const rows = Array.from({ length: 6 }, (_, offset) => { const date = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 5 + offset, 1)); return { key: `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}`, label: new Intl.DateTimeFormat("pt-BR", { month: "short", timeZone: "UTC" }).format(date), total: 0 }; }); const map = new Map(rows.map((row) => [row.key, row])); for (const date of dates) { const key = `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}`; const row = map.get(key); if (row) row.total += 1; } return rows; }
function failure(error: unknown, operation: string) {
  if (error instanceof CustomerInputError) return Response.json({ error: error.message }, { status: error.message.includes("Origem") ? 403 : 400, headers: NO_STORE });
  if (error instanceof PosHttpError) return Response.json({ error: error.message.replaceAll("PDV", "módulo de clientes") }, { status: error.status, headers: NO_STORE });
  if (error instanceof LicenseDeniedError) return Response.json({ error: error.message }, { status: error.status, headers: NO_STORE });
  if (error && typeof error === "object" && "code" in error && error.code === "P2002") return Response.json({ error: "Já existe um cliente com este CPF ou CNPJ." }, { status: 409, headers: NO_STORE });
  if (error && typeof error === "object" && "code" in error && error.code === "P2034") return Response.json({ error: "Conflito de concorrência. Atualize os dados e tente novamente." }, { status: 409, headers: NO_STORE });
  if (error instanceof AuthError) return authErrorResponse(error);
  console.error(`customer ${operation} failed`, error instanceof Error ? error.name : "unknown");
  return Response.json({ error: `Não foi possível ${operation} os clientes.` }, { status: 500, headers: NO_STORE });
}
