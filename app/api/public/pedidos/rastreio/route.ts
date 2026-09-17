import { timingSafeEqual } from "node:crypto";
import { controlDb, tenantDb } from "@/db";
import { publicOrganization, safePublicUrl } from "../../_shared";
import { BRAZIL_TIME_ZONE } from "@/lib/timezone";
import {
  clientAddress,
  enforceControlRateLimit,
  HttpSecurityError,
  httpSecurityErrorResponse,
  privateJson,
  readJsonObject,
} from "@/lib/http-security";

export async function POST(request: Request) {
  try {
    const ip = clientAddress(request);
    await enforceControlRateLimit(controlDb, `order-tracking:ip:${ip}`, 60, 300);
    const body = await readJsonObject(request, 32_768);
    if (["orderNumber", "email", "orderKey"].some(field => body[field] !== undefined && typeof body[field] !== "string")) throw new PublicOrderError("Os dados de consulta devem ser textos.", 400);
    const number = typeof body.orderNumber === "string" ? body.orderNumber.trim() : "", email = typeof body.email === "string" ? body.email.trim().toLowerCase() : "", key = typeof body.orderKey === "string" ? body.orderKey.trim() : "";
    if (!/^[A-Za-z0-9._/-]{1,80}$/.test(number) || email.length > 254 || key.length > 256 || (!key && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))) return privateJson({ error: "Informe o pedido e o e-mail usado na compra." }, { status: 400 });
    if (body.action !== undefined && body.action !== "return") return privateJson({ error: "Operação inválida." }, { status: 400 });
    const organizationId = await publicOrganization(request), db = await tenantDb(organizationId);
    await enforceControlRateLimit(controlDb, `order-tracking:order:${ip}:${organizationId}:${number}`, 20, 300);
    const order = await db.salesOrder.findFirst({
      where: { number, deletedAt: null },
      include: {
        branch: { select: { timezone: true } },
        items: { select: { id: true, nameSnapshot: true, skuSnapshot: true, imageSnapshot: true, quantity: true, unitPrice: true, total: true } },
        tracking: { select: { trackingNumber: true, carrier: true, trackingUrl: true, status: true, statusLabel: true, events: { select: { id: true, description: true, location: true, occurredAt: true }, orderBy: { occurredAt: "desc" } } } },
        notesTimeline: { select: { id: true, content: true, createdAt: true }, where: { customerVisible: true }, orderBy: { createdAt: "desc" } },
        history: { select: { id: true, fromStatus: true, toStatus: true, createdAt: true }, orderBy: { createdAt: "asc" } },
        returns: { select: { id: true, reason: true, description: true, status: true, reverseTrackingCode: true, reverseLabelUrl: true, requestedAt: true, decidedAt: true, completedAt: true, items: { select: { orderItemId: true, quantity: true } } }, orderBy: { requestedAt: "desc" } },
      },
    });
    const authorized = order && (key ? safeEqual(order.orderKey, key) : order.customerEmail?.toLowerCase() === email);
    if (!authorized || !order) return privateJson({ error: "Pedido não encontrado ou dados de consulta incorretos." }, { status: 404 });
    if (body.action === "return") {
      if (typeof body.reason !== "string" || typeof body.description !== "string") throw new PublicOrderError("Informe motivo e descrição em texto.", 400);
      const reason = body.reason, description = body.description.trim();
      if (!new Set(["produto_defeituoso", "produto_errado", "produto_danificado", "nao_atendeu_expectativas", "desistencia", "outro"]).has(reason) || description.length < 10 || description.length > 4000) return privateJson({ error: "Informe um motivo e uma descrição com pelo menos 10 caracteres." }, { status: 400 });
      const rows = Array.isArray(body.items) ? body.items : [];
      if (!rows.length || rows.length > 100 || rows.some(row => !row || typeof row !== "object" || Array.isArray(row))) throw new PublicOrderError("Selecione itens válidos para devolução.", 422);
      const selected = rows.map((row: Record<string, unknown>) => ({ orderItemId: numericInput(row.orderItemId), quantity: numericInput(row.quantity) }));
      if (new Set(selected.map(row => row.orderItemId)).size !== selected.length || selected.some(row => !Number.isSafeInteger(row.orderItemId) || row.orderItemId < 1 || !Number.isFinite(row.quantity) || row.quantity <= 0)) throw new PublicOrderError("Selecione cada item uma única vez com uma quantidade válida.", 422);
      const created = await db.$transaction(async (tx) => {
        await tx.$queryRaw`SELECT id FROM sales_orders WHERE id = ${order.id} FOR UPDATE`;
        const current = await tx.salesOrder.findFirst({ where: { id: order.id, deletedAt: null }, include: { items: true, returns: { include: { items: true } } } });
        if (!current || !(key ? safeEqual(current.orderKey, key) : current.customerEmail?.toLowerCase() === email)) throw new PublicOrderError("Pedido não encontrado ou dados de consulta incorretos.", 404);
        if (!new Set(["processing", "delivered", "completed"]).has(current.status)) throw new PublicOrderError("Este pedido ainda não está elegível para devolução.", 422);
        if (Date.now() - (current.completedAt || current.createdAt).getTime() > 30 * 86_400_000) throw new PublicOrderError("O prazo de 30 dias para solicitar a devolução terminou.", 422);
        if (current.returns.some(item => !["rejected", "completed"].includes(item.status))) throw new PublicOrderError("Já existe uma solicitação de devolução em andamento.", 409);
        if (selected.some(row => {
          const item = current.items.find(candidate => candidate.id === row.orderItemId);
          const alreadyReturned = current.returns.filter(entry => entry.status !== "rejected").flatMap(entry => entry.items).filter(entry => entry.orderItemId === row.orderItemId).reduce((sum, entry) => sum + entry.quantity, 0);
          return !item || row.quantity > item.quantity - alreadyReturned;
        })) throw new PublicOrderError("Selecione itens e quantidades válidas e ainda elegíveis para devolução.", 422);
        const row = await tx.orderReturn.create({ data: { salesOrderId: current.id, customerId: current.customerId, reason, description, customerEmail: current.customerEmail || email, items: { create: selected } } });
        await tx.orderNotificationQueue.create({ data: { salesOrderId: current.id, statusTrigger: "return-pending", channel: "email", recipientType: "admin", dedupKey: `order:${current.id}:return:${row.id}:pending:email:admin` } });
        return row;
      });
      return privateJson({ return: { id: created.id, status: created.status } }, { status: 201 });
    }
    const tenantSettings = order.branch?.timezone
      ? null
      : await db.tenantSettings?.findUnique?.({ where: { id: 1 }, select: { timezone: true } });
    const timezone = order.branch?.timezone || tenantSettings?.timezone || BRAZIL_TIME_ZONE;
    return privateJson({ order: { timezone, number: order.number, status: order.status, createdAt: order.createdAt, customerName: order.customerName, subtotal: order.subtotal, discount: order.discount, freightAmount: order.freightAmount, total: order.total, refundedTotal: order.refundedTotal, paymentTitle: order.paymentTitle || order.paymentMethod, deliveryCity: order.deliveryCity, deliveryState: order.deliveryState, items: order.items.map(item => ({ ...item, imageSnapshot: safePublicUrl(item.imageSnapshot) })), tracking: order.tracking ? { ...order.tracking, trackingUrl: safePublicUrl(order.tracking.trackingUrl) } : null, notes: order.notesTimeline, history: order.history, returns: order.returns.map(item => ({ id: item.id, reason: item.reason, description: item.description, status: item.status, reverseTrackingCode: item.reverseTrackingCode, reverseLabelUrl: safePublicUrl(item.reverseLabelUrl), requestedAt: item.requestedAt, decidedAt: item.decidedAt, completedAt: item.completedAt })) } });
  } catch (error) {
    if (error instanceof HttpSecurityError) return httpSecurityErrorResponse(error);
    if (error instanceof PublicOrderError) return privateJson({ error: error.message }, { status: error.status, headers: error.retryAfter ? { "Retry-After": String(error.retryAfter) } : undefined });
    console.error("public-order-tracking", { error: error instanceof Error ? error.name : typeof error }); return privateJson({ error: "Não foi possível consultar o pedido." }, { status: 500 });
  }
}

function safeEqual(expected: string, provided: string) { const a = Buffer.from(expected), b = Buffer.from(provided); return a.length === b.length && timingSafeEqual(a, b); }
function numericInput(value: unknown) { return typeof value === "number" || typeof value === "string" && value.trim() !== "" ? Number(value) : NaN; }
class PublicOrderError extends Error { constructor(message: string, readonly status: number, readonly retryAfter?: number) { super(message); } }
