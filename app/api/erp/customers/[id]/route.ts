import { randomUUID } from "node:crypto";
import { Prisma } from "@/generated/tenant/client";
import { currentOrganization, tenantDb } from "@/db";
import { AuthError, authErrorResponse } from "@/lib/auth";
import { LicenseDeniedError } from "@/lib/billing/license";
import { customerHealth } from "@/lib/erp/customer-control";
import {
  assertSameOrigin, customerAddressInput, customerConsentInput, customerContactInput, customerEntityId,
  customerInput, CustomerInputError, customerInteractionInput, customerTagInput, customerVersion,
} from "@/lib/erp/customer-input";
import { assertTenantPermission } from "@/lib/erp/permissions";
import { assertPosMutationRequest, enforcePosRateLimit, PosHttpError, readPosJson } from "@/lib/erp/pos-http";
import { enqueueWebhook } from "@/lib/integrations/webhooks";
import { assertTenantWriteAccess } from "@/lib/tenant-access";

export const dynamic = "force-dynamic";
const NO_STORE = { "cache-control": "private, no-store, max-age=0", expires: "0", pragma: "no-cache" };
const fullInclude = {
  addresses: { orderBy: [{ primary: "desc" as const }, { label: "asc" as const }] },
  contacts: { where: { archivedAt: null }, orderBy: [{ primary: "desc" as const }, { name: "asc" as const }] },
  tagLinks: { include: { tag: true }, orderBy: { createdAt: "asc" as const } },
  consents: { orderBy: { recordedAt: "desc" as const }, take: 100 },
  interactions: { orderBy: { createdAt: "desc" as const }, take: 100 },
  salesOrders: { where: { deletedAt: null }, select: { id: true, number: true, kind: true, status: true, total: true, placedAt: true }, orderBy: { placedAt: "desc" as const }, take: 30 },
  posSales: { select: { id: true, saleNumber: true, status: true, totalCents: true, createdAt: true }, orderBy: { createdAt: "desc" as const }, take: 30 },
  financialTitles: { where: { type: "receivable" }, select: { id: true, description: true, status: true, amount: true, paidAmount: true, dueAt: true }, orderBy: { dueAt: "desc" as const }, take: 50 },
  opportunities: { select: { id: true, title: true, stage: true, status: true, value: true, probability: true, expectedAt: true }, orderBy: { updatedAt: "desc" as const }, take: 30 },
  contracts: { select: { id: true, number: true, name: true, status: true, amount: true, nextBillingAt: true }, orderBy: { updatedAt: "desc" as const }, take: 30 },
  serviceOrders: { select: { id: true, number: true, status: true, asset: true, total: true, createdAt: true }, orderBy: { createdAt: "desc" as const }, take: 30 },
};
type Tx = Prisma.TransactionClient;

export async function GET(_request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const organization = await currentOrganization(); await assertTenantPermission(organization.id, "customers.read");
    const db = await tenantDb(organization.id), id = customerEntityId((await context.params).id), customer = await db.customer.findUnique({ where: { id }, include: fullInclude });
    if (!customer) return Response.json({ error: "Cliente não encontrado." }, { status: 404, headers: NO_STORE });
    const now = new Date(), [auditRows, orders, sales, titles, overdue, pendingTasks] = await Promise.all([
      db.tenantAuditEvent.findMany({ where: { entityType: "customer", entityId: String(id) }, select: { id: true, action: true, actorId: true, createdAt: true }, orderBy: { createdAt: "desc" }, take: 50 }),
      db.salesOrder.aggregate({ where: { customerId: id, deletedAt: null, status: { notIn: ["draft", "cancelled", "refunded"] } }, _sum: { total: true }, _count: { _all: true }, _max: { createdAt: true } }),
      db.sale.aggregate({ where: { customerId: id, status: "completed" }, _sum: { totalCents: true }, _count: { _all: true }, _max: { createdAt: true } }),
      db.financialTitle.aggregate({ where: { customerId: id, type: "receivable", status: { in: ["open", "partial", "overdue"] } }, _sum: { amount: true, paidAmount: true } }),
      db.financialTitle.aggregate({ where: { customerId: id, type: "receivable", status: { in: ["open", "partial", "overdue"] }, dueAt: { lt: now } }, _sum: { amount: true, paidAmount: true } }),
      db.customerInteraction.count({ where: { customerId: id, completedAt: null } }),
    ]);
    const openBalance = (titles._sum.amount || 0) - (titles._sum.paidAmount || 0), overdueBalance = (overdue._sum.amount || 0) - (overdue._sum.paidAmount || 0);
    const metrics = { revenue: (orders._sum.total || 0) + (sales._sum.totalCents || 0) / 100, orders: orders._count._all + sales._count._all, openBalance, overdueBalance, availableCredit: Math.max(0, customer.creditLimit - openBalance), pendingTasks, lastPurchaseAt: latest(orders._max.createdAt, sales._max.createdAt) };
    const health = customerHealth({ ...customer, overdueBalance, pendingTasks });
    const audit = auditRows.map((item) => ({ ...item, id: String(item.id) }));
    return Response.json({ customer: { ...customer, metrics, health }, audit, generatedAt: now.toISOString() }, { headers: NO_STORE });
  } catch (error) { return failure(error); }
}

export async function PATCH(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    assertSameOrigin(request); assertPosMutationRequest(request);
    const organization = await currentOrganization(), access = await assertTenantPermission(organization.id, "customers.write");
    await assertTenantWriteAccess(organization.id);
    const db = await tenantDb(organization.id), id = customerEntityId((await context.params).id), body = await readPosJson(request, 262_144), correlationId = randomUUID();
    await enforcePosRateLimit(db, access.user.id, "customers.mutation");
    const before = await db.customer.findUnique({ where: { id }, include: { addresses: { where: { primary: true }, take: 1 } } });
    if (!before) return Response.json({ error: "Cliente não encontrado." }, { status: 404, headers: NO_STORE });

    if (body.action === "status") {
      const status = body.status === "inactive" ? "inactive" : body.status === "active" ? "active" : "";
      if (!status) throw new CustomerInputError("Status inválido.");
      const version = customerVersion(body.version);
      const customer = await db.$transaction(async (tx) => {
        await lockCustomer(tx, id);
        const changed = await tx.customer.updateMany({ where: { id, version }, data: { status, version: { increment: 1 } } });
        if (changed.count !== 1) throw conflict();
        await audit(tx, access.user.id, "customer.status_changed", id, correlationId, { status: before.status }, { status });
        await enqueueWebhook(tx, "customer.updated", { id, status, occurred_at: new Date().toISOString(), correlation_id: correlationId });
        return tx.customer.findUniqueOrThrow({ where: { id }, include: fullInclude });
      }, serializable);
      return Response.json({ customer, correlationId }, { headers: NO_STORE });
    }
    if (body.action === "contact.create" || body.action === "contact.update") {
      const input = customerContactInput(body), contactId = body.action === "contact.update" ? customerEntityId(body.contactId, "Contato") : null;
      const contact = await db.$transaction(async (tx) => {
        if (input.primary) await tx.customerContact.updateMany({ where: { customerId: id, archivedAt: null }, data: { primary: false } });
        const saved = contactId ? await tx.customerContact.updateMany({ where: { id: contactId, customerId: id, archivedAt: null }, data: input }) : null;
        if (saved && saved.count !== 1) throw new CustomerInputError("Contato não encontrado.");
        const result = contactId ? await tx.customerContact.findUniqueOrThrow({ where: { id: contactId } }) : await tx.customerContact.create({ data: { customerId: id, ...input } });
        await audit(tx, access.user.id, contactId ? "customer.contact_updated" : "customer.contact_created", id, correlationId, null, { contactId: result.id, name: result.name });
        return result;
      }, serializable);
      return Response.json({ contact, correlationId }, { headers: NO_STORE });
    }
    if (body.action === "contact.archive") {
      const contactId = customerEntityId(body.contactId, "Contato"), result = await db.customerContact.updateMany({ where: { id: contactId, customerId: id, archivedAt: null }, data: { archivedAt: new Date(), primary: false } });
      if (result.count !== 1) throw new CustomerInputError("Contato não encontrado.");
      await db.tenantAuditEvent.create({ data: { actorId: access.user.id, action: "customer.contact_archived", entityType: "customer", entityId: String(id), correlationId, afterData: { contactId } } });
      return Response.json({ archived: true, correlationId }, { headers: NO_STORE });
    }
    if (body.action === "address.upsert") {
      const input = customerAddressInput(body), addressId = body.addressId ? customerEntityId(body.addressId, "Endereço") : null;
      const address = await db.$transaction(async (tx) => {
        if (input.primary) await tx.customerAddress.updateMany({ where: { customerId: id }, data: { primary: false } });
        if (!addressId) return tx.customerAddress.create({ data: { customerId: id, ...input } });
        const changed = await tx.customerAddress.updateMany({ where: { id: addressId, customerId: id }, data: input });
        if (changed.count !== 1) throw new CustomerInputError("Endereço não encontrado.");
        return tx.customerAddress.findUniqueOrThrow({ where: { id: addressId } });
      }, serializable);
      await db.tenantAuditEvent.create({ data: { actorId: access.user.id, action: "customer.address_saved", entityType: "customer", entityId: String(id), correlationId, afterData: { addressId: address.id, label: address.label } } });
      return Response.json({ address, correlationId }, { headers: NO_STORE });
    }
    if (body.action === "interaction.create") {
      const input = customerInteractionInput(body), interaction = await db.customerInteraction.create({ data: { customerId: id, ...input, createdBy: access.user.name } });
      await db.tenantAuditEvent.create({ data: { actorId: access.user.id, action: "customer.interaction_created", entityType: "customer", entityId: String(id), correlationId, afterData: { interactionId: interaction.id, type: interaction.type, subject: interaction.subject } } });
      return Response.json({ interaction, correlationId }, { status: 201, headers: NO_STORE });
    }
    if (body.action === "interaction.complete") {
      const interactionId = customerEntityId(body.interactionId, "Interação"), completed = body.completed !== false;
      const result = await db.customerInteraction.updateMany({ where: { id: interactionId, customerId: id }, data: { completedAt: completed ? new Date() : null } });
      if (result.count !== 1) throw new CustomerInputError("Interação não encontrada.");
      await db.tenantAuditEvent.create({ data: { actorId: access.user.id, action: completed ? "customer.interaction_completed" : "customer.interaction_reopened", entityType: "customer", entityId: String(id), correlationId, afterData: { interactionId } } });
      return Response.json({ completed, correlationId }, { headers: NO_STORE });
    }
    if (body.action === "consent.record") {
      const input = customerConsentInput(body), consent = await db.customerConsent.create({ data: { customerId: id, ...input, recordedBy: access.user.name } });
      await db.tenantAuditEvent.create({ data: { actorId: access.user.id, action: "customer.consent_recorded", entityType: "customer", entityId: String(id), correlationId, afterData: { consentId: consent.id, purpose: consent.purpose, status: consent.status, legalBasis: consent.legalBasis } } });
      return Response.json({ consent, correlationId }, { status: 201, headers: NO_STORE });
    }
    if (body.action === "tag.add") {
      const input = customerTagInput(body), tag = await db.customerTag.upsert({ where: { name: input.name }, update: { color: input.color }, create: input });
      await db.customerTagLink.upsert({ where: { customerId_tagId: { customerId: id, tagId: tag.id } }, update: {}, create: { customerId: id, tagId: tag.id } });
      await db.tenantAuditEvent.create({ data: { actorId: access.user.id, action: "customer.tag_added", entityType: "customer", entityId: String(id), correlationId, afterData: { tagId: tag.id, name: tag.name } } });
      return Response.json({ tag, correlationId }, { headers: NO_STORE });
    }
    if (body.action === "tag.remove") {
      const tagId = customerEntityId(body.tagId, "Etiqueta"), removed = await db.customerTagLink.deleteMany({ where: { customerId: id, tagId } });
      if (removed.count !== 1) throw new CustomerInputError("Etiqueta não vinculada.");
      await db.tenantAuditEvent.create({ data: { actorId: access.user.id, action: "customer.tag_removed", entityType: "customer", entityId: String(id), correlationId, afterData: { tagId } } });
      return Response.json({ removed: true, correlationId }, { headers: NO_STORE });
    }

    const input = customerInput(body), version = customerVersion(body.version);
    const customer = await db.$transaction(async (tx) => {
      await lockCustomer(tx, id);
      const changed = await tx.customer.updateMany({ where: { id, version }, data: { type: input.type, name: input.name, tradeName: input.tradeName, document: input.document, email: input.email, phone: input.phone, creditLimit: input.creditLimit, notes: input.notes, segment: input.segment, origin: input.origin, salesperson: input.salesperson, paymentTermsDays: input.paymentTermsDays, riskRating: input.riskRating, preferredChannel: input.preferredChannel, version: { increment: 1 } } });
      if (changed.count !== 1) throw conflict();
      const primary = before.addresses[0];
      if (primary) await tx.customerAddress.update({ where: { id: primary.id }, data: input.address });
      else await tx.customerAddress.create({ data: { customerId: id, ...input.address, label: "Principal", primary: true } });
      await audit(tx, access.user.id, "customer.updated", id, correlationId, { name: before.name, document: before.document, version }, { name: input.name, document: input.document, segment: input.segment, riskRating: input.riskRating, version: version + 1 });
      await enqueueWebhook(tx, "customer.updated", { id, status: before.status, occurred_at: new Date().toISOString(), correlation_id: correlationId });
      return tx.customer.findUniqueOrThrow({ where: { id }, include: fullInclude });
    }, serializable);
    return Response.json({ customer, correlationId }, { headers: NO_STORE });
  } catch (error) { return failure(error); }
}

const serializable = { isolationLevel: Prisma.TransactionIsolationLevel.Serializable } as const;
async function lockCustomer(tx: Tx, id: number) { await tx.$queryRaw`SELECT id FROM customers WHERE id = ${id} FOR UPDATE`; }
async function audit(tx: Tx, actorId: string, action: string, id: number, correlationId: string, beforeData: Prisma.InputJsonValue | null, afterData: Prisma.InputJsonValue) { await tx.tenantAuditEvent.create({ data: { actorId, action, entityType: "customer", entityId: String(id), correlationId, beforeData: beforeData ?? undefined, afterData } }); }
function conflict() { const error = new Error("O cliente foi alterado por outro usuário. Atualize os dados antes de salvar."); Object.assign(error, { code: "CUSTOMER_CONFLICT" }); return error; }
function latest(one?: Date | null, two?: Date | null) { if (!one) return two || null; if (!two) return one; return one > two ? one : two; }
function failure(error: unknown) {
  if (error instanceof CustomerInputError) return Response.json({ error: error.message }, { status: error.message.includes("Origem") ? 403 : 400, headers: NO_STORE });
  if (error instanceof PosHttpError) return Response.json({ error: error.message.replaceAll("PDV", "módulo de clientes") }, { status: error.status, headers: NO_STORE });
  if (error instanceof LicenseDeniedError) return Response.json({ error: error.message }, { status: error.status, headers: NO_STORE });
  if (error && typeof error === "object" && "code" in error && error.code === "P2002") return Response.json({ error: "Já existe um cliente com este CPF ou CNPJ." }, { status: 409, headers: NO_STORE });
  if (error && typeof error === "object" && "code" in error && ["P2034", "CUSTOMER_CONFLICT"].includes(String(error.code))) return Response.json({ error: "O cliente foi alterado por outro usuário. Atualize os dados e tente novamente." }, { status: 409, headers: NO_STORE });
  if (error instanceof AuthError) return authErrorResponse(error);
  console.error("customer detail request failed", error instanceof Error ? error.name : "unknown");
  return Response.json({ error: "Não foi possível operar o cliente." }, { status: 500, headers: NO_STORE });
}
