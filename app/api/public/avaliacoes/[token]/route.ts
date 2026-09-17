import { createHash } from "node:crypto";
import { controlDb, tenantDb } from "@/db";
import { publicOrganization } from "../../_shared";
import {
  clientAddress,
  enforceControlRateLimit,
  HttpSecurityError,
  httpSecurityErrorResponse,
  privateJson,
  readJsonObject,
} from "@/lib/http-security";

type Context = { params: Promise<{ token: string }> };

export async function GET(request: Request, context: Context) {
  try {
    await enforceControlRateLimit(controlDb, `review:view:ip:${clientAddress(request)}`, 120, 300);
    const token = tokenValue((await context.params).token);
    await enforceControlRateLimit(controlDb, `review:view:${clientAddress(request)}:${token}`, 60, 3600);
    const db = await tenantDb(await publicOrganization(request)), item = await db.orderReviewRequest.findUnique({ where: { token }, include: { salesOrder: { select: { number: true, customerName: true, status: true, deletedAt: true } }, orderItem: { select: { product: { select: { id: true, name: true, slug: true } } } }, review: { select: { rating: true, title: true, content: true, createdAt: true } } } });
    if (!item || item.salesOrder.deletedAt || item.expiresAt <= new Date() || !["pending", "completed"].includes(item.state) || !["delivered", "completed"].includes(item.salesOrder.status)) return privateJson({ error: "Convite de avaliação inválido ou expirado." }, { status: 404 });
    return privateJson({ request: { state: item.state, expiresAt: item.expiresAt, orderNumber: item.salesOrder.number, customerName: firstName(item.salesOrder.customerName), product: item.orderItem.product, review: item.review } });
  } catch (error) { return reviewFailure(error, "Não foi possível abrir a avaliação."); }
}

export async function POST(request: Request, context: Context) {
  try {
    await enforceControlRateLimit(controlDb, `review:submit:ip:${clientAddress(request)}`, 20, 3600);
    const token = tokenValue((await context.params).token);
    await enforceControlRateLimit(controlDb, `review:submit:${clientAddress(request)}:${token}`, 10, 3600);
    const body = await readJsonObject(request, 16_384), db = await tenantDb(await publicOrganization(request)), item = await db.orderReviewRequest.findUnique({ where: { token }, include: { salesOrder: true, orderItem: true, review: true } });
    if (!item || item.salesOrder.deletedAt || item.expiresAt <= new Date() || !["pending", "completed"].includes(item.state) || !["delivered", "completed"].includes(item.salesOrder.status)) return privateJson({ error: "Convite de avaliação inválido ou expirado." }, { status: 404 });
    if (item.review || item.state === "completed") return privateJson({ error: "Esta compra já foi avaliada." }, { status: 409 });
    const rating = typeof body.rating === "number" || typeof body.rating === "string" && /^[1-5]$/.test(body.rating) ? Number(body.rating) : NaN, title = text(body.title, 120), content = text(body.content, 3000, true);
    if (!Number.isInteger(rating) || rating < 1 || rating > 5) return privateJson({ error: "Escolha uma nota de 1 a 5." }, { status: 422 });
    if (content.length < 10) return privateJson({ error: "Conte como foi sua experiência usando pelo menos 10 caracteres." }, { status: 422 });
    const review = await db.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM sales_orders WHERE id = ${item.salesOrderId} FOR UPDATE`;
      await tx.$queryRaw`SELECT id FROM order_review_requests WHERE id = ${item.id} FOR UPDATE`;
      const current = await tx.orderReviewRequest.findUnique({ where: { token }, include: { salesOrder: true, orderItem: true, review: true } });
      if (!current || current.salesOrder.deletedAt || current.expiresAt <= new Date() || !["pending", "completed"].includes(current.state) || !["delivered", "completed"].includes(current.salesOrder.status)) throw new PublicReviewError("Convite de avaliação inválido ou expirado.", 404);
      if (current.review || current.state === "completed") throw new PublicReviewError("Esta compra já foi avaliada.", 409);
      await tx.$queryRaw`SELECT id FROM products WHERE id = ${current.orderItem.productId} FOR UPDATE`;
      const created = await tx.productReview.create({ data: { productId: current.orderItem.productId, salesOrderId: current.salesOrderId, reviewRequestId: current.id, rating, title: title || null, content, authorName: firstName(current.salesOrder.customerName), authorEmailHash: createHash("sha256").update((current.salesOrder.customerEmail || "").toLowerCase()).digest("hex"), status: "published" } });
      await tx.orderReviewRequest.update({ where: { id: current.id }, data: { state: "completed", completedAt: new Date() } });
      const aggregate = await tx.productReview.aggregate({ where: { productId: current.orderItem.productId, status: "published" }, _avg: { rating: true }, _count: { _all: true } });
      await tx.product.update({ where: { id: current.orderItem.productId }, data: { averageRating: aggregate._avg.rating || rating, ratingCount: aggregate._count._all } });
      return created;
    });
    return privateJson({ review: { id: review.id, rating: review.rating, createdAt: review.createdAt } }, { status: 201 });
  } catch (error) { return reviewFailure(error, "Não foi possível registrar a avaliação."); }
}

function firstName(value: string) { return value.trim().split(/\s+/)[0] || "Cliente"; }
function text(value: unknown, max: number, required = false) { if (value !== undefined && typeof value !== "string") throw new PublicReviewError("O campo deve conter um texto.", 422); const result = typeof value === "string" ? value.trim() : ""; if (required && !result) throw new PublicReviewError("Campo obrigatório.", 422); if (result.length > max) throw new PublicReviewError(`O campo aceita até ${max} caracteres.`, 422); return result; }
function tokenValue(value: unknown) { const token = String(value || "").trim(); if (!/^[A-Za-z0-9_-]{20,256}$/.test(token)) throw new PublicReviewError("Convite de avaliação inválido ou expirado.", 404); return token; }
function reviewFailure(error: unknown, fallback: string) { if (error instanceof HttpSecurityError) return httpSecurityErrorResponse(error); if (error instanceof PublicReviewError) return privateJson({ error: error.message }, { status: error.status, headers: error.retryAfter ? { "Retry-After": String(error.retryAfter) } : undefined }); console.error("public-review", { error: error instanceof Error ? error.name : typeof error }); return privateJson({ error: fallback }, { status: 500 }); }
class PublicReviewError extends Error { constructor(message: string, readonly status: number, readonly retryAfter?: number) { super(message); } }
