import { createHash } from "node:crypto";
import { Prisma } from "@/generated/tenant/client";

export const POS_ORDER_CLAIM_LEASE_MS = 120_000;
export const POS_ORDER_CLAIM_MAX_LEASE_MS = 300_000;
export const POS_ORDER_ELIGIBLE_STATUSES = ["approved"] as const;

const INERT_ORDER_PAYMENT_STATES = new Set([
  "cancelled",
  "canceled",
  "failed",
  "declined",
  "expired",
  "superseded_by_pos",
]);

export class PosOrderClaimError extends Error {
  constructor(
    message: string,
    public readonly status = 409,
  ) {
    super(message);
    this.name = "PosOrderClaimError";
  }
}

export async function lockedPosPaymentDraftIssue(
  tx: Prisma.TransactionClient,
  expected: {
    saleDraftId: string;
    branchId: number;
    registerId: number;
    sessionId: number;
    operatorProfileId: number;
    terminalId: string;
    paymentIndex?: number;
    payment?: { method: string; amountCents: number; installments: number };
    now?: Date;
  },
) {
  await tx.$queryRaw(
    Prisma.sql`SELECT "id" FROM "pos_order_claims" WHERE "id" = ${expected.saleDraftId} FOR UPDATE`,
  );
  const claimIdentity = await tx.posOrderClaim.findUnique({
    where: { id: expected.saleDraftId },
    select: { salesOrderId: true },
  });
  if (claimIdentity)
    await tx.$queryRaw(
      Prisma.sql`SELECT "id" FROM "sales_orders" WHERE "id" = ${claimIdentity.salesOrderId} FOR UPDATE`,
    );
  const claim = await tx.posOrderClaim.findUnique({
    where: { id: expected.saleDraftId },
    include: {
      salesOrder: {
        include: {
          items: {
            select: { itemType: true, quantity: true, refundedQuantity: true },
          },
          payments: {
            select: {
              status: true,
              paidAt: true,
              transactionId: true,
              paymentUrl: true,
            },
          },
          shipments: { select: { id: true, status: true } },
          tracking: { select: { id: true, status: true } },
          shippingLabels: { select: { id: true, status: true } },
        },
      },
    },
  });
  await tx.$queryRaw(
    Prisma.sql`SELECT "id" FROM "pos_held_sales" WHERE "id" = ${expected.saleDraftId} FOR UPDATE`,
  );
  const draft = await tx.posHeldSale.findUnique({
    where: { id: expected.saleDraftId },
    select: {
      id: true,
      status: true,
      registerId: true,
      sessionId: true,
      operatorProfileId: true,
    },
  });
  if (
    !draft ||
    draft.status !== "draft" ||
    draft.registerId !== expected.registerId ||
    draft.sessionId !== expected.sessionId ||
    draft.operatorProfileId !== expected.operatorProfileId
  ) {
    return "A prova de pagamento exige o rascunho server-side exato, ativo e pertencente ao mesmo turno, caixa e operador.";
  }
  if (claim) {
    if (
      claim.state !== "active" ||
      claim.leaseExpiresAt <= (expected.now ?? new Date())
    )
      return "A posse do pedido expirou ou não está ativa; não crie nova prova de pagamento antes de recuperar ou liberar o claim.";
    if (
      claim.branchId !== expected.branchId ||
      claim.registerId !== expected.registerId ||
      claim.sessionId !== expected.sessionId ||
      claim.operatorProfileId !== expected.operatorProfileId ||
      claim.terminalId !== expected.terminalId
    ) {
      return "A posse do pedido pertence a outro contexto operacional; nenhuma prova de pagamento foi criada.";
    }
    if (!expected.payment || expected.paymentIndex !== 0)
      return "O pedido reivindicado exige uma única divisão de pagamento exatamente igual à condição aprovada.";
    try {
      assertPosOrderEligible(claim.salesOrder, expected.branchId);
      assertPosOrderSettlement(claim.salesOrder, [expected.payment]);
    } catch (error) {
      return error instanceof Error
        ? error.message
        : "A prova financeira diverge da condição aprovada do pedido.";
    }
  }
  if (expected.paymentIndex != null) {
    const slotKey = `pos-payment-slot:${expected.saleDraftId}:${expected.paymentIndex}`;
    await tx.$executeRaw(
      Prisma.sql`SELECT pg_advisory_xact_lock(hashtextextended(${slotKey}, 0))`,
    );
    const [intents, manualReferences] = await Promise.all([
      tx.posPaymentIntent.count({
        where: {
          saleDraftId: expected.saleDraftId,
          paymentIndex: expected.paymentIndex,
          consumedAt: null,
          status: {
            in: [
              "created",
              "processing",
              "authorized",
              "captured",
              "partially_refunded",
              "unknown",
              "manual_review",
            ],
          },
        },
      }),
      tx.posManualPaymentReference.count({
        where: {
          saleDraftId: expected.saleDraftId,
          paymentIndex: expected.paymentIndex,
          consumedSalePaymentId: null,
          status: "pending",
        },
      }),
    ]);
    if (intents || manualReferences)
      return "Esta divisão de pagamento já possui uma prova financeira não resolvida. Reconcilie-a antes de criar outra.";
  }
  return null;
}

export type PosOrderEligibilityInput = {
  kind: string;
  status: string;
  currency: string;
  origin: string;
  salesChannel: string;
  deliveryType: string;
  shippingPending: boolean;
  needsProcessing: boolean;
  shipments: Array<{ id: number; status: string }>;
  tracking: { id: number; status: string | null } | null;
  shippingLabels: Array<{ id: number; status: string }>;
  branchId: number | null;
  deletedAt: Date | null;
  paidAt: Date | null;
  transactionId: string | null;
  freightAmount: number;
  taxAmount: number;
  paymentMethod: string | null;
  paymentTerms: string | null;
  paymentInstallments: number;
  firstDueDate: Date | null;
  items: Array<{
    itemType: string;
    quantity: number;
    refundedQuantity: number;
  }>;
  payments: Array<{
    status: string;
    paidAt: Date | null;
    transactionId: string | null;
    paymentUrl: string | null;
  }>;
};

export type PosOrderEligibility =
  | { eligible: true; code: "eligible" }
  | { eligible: false; code: string; reason: string };

export function evaluatePosOrderEligibility(
  order: PosOrderEligibilityInput,
  branchId: number,
): PosOrderEligibility {
  if (order.deletedAt) return denied("deleted", "O pedido foi excluído.");
  if (order.kind !== "order")
    return denied(
      "not_order",
      "Somente pedidos aprovados podem ser levados ao PDV.",
    );
  if (order.branchId == null || order.branchId !== branchId)
    return denied(
      "wrong_branch",
      "O pedido não pertence à filial operacional deste PDV.",
    );
  if (order.currency.toUpperCase() !== "BRL")
    return denied(
      "unsupported_currency",
      "O PDV somente converte pedidos em BRL.",
    );
  if (order.shipments.length)
    return denied(
      "shipment_exists",
      `O pedido já possui expedição (${order.shipments[0]!.status}) e exige handoff logístico explícito antes do PDV.`,
    );
  if (
    order.tracking ||
    order.shippingLabels.some((label) => label.status !== "cancelled")
  )
    return denied(
      "shipping_artifact",
      "O pedido já possui rastreio ou etiqueta de frete ativa e exige reconciliação logística antes do PDV.",
    );
  if (
    order.deliveryType !== "pickup" ||
    order.shippingPending ||
    order.needsProcessing
  )
    return denied(
      "fulfillment_pending",
      "Somente retirada imediata, sem frete ou processamento logístico pendente, pode ser convertida no PDV.",
    );
  if (
    order.origin !== "manual" ||
    !["direct", "store"].includes(order.salesChannel)
  )
    return denied(
      "unsupported_channel",
      "O canal/origem do pedido possui workflow externo incompatível com conversão direta no PDV.",
    );
  if (
    !(POS_ORDER_ELIGIBLE_STATUSES as readonly string[]).includes(order.status)
  )
    return denied(
      "status",
      `O status ${order.status} não é elegível para conversão no PDV.`,
    );
  if (order.freightAmount !== 0 || order.taxAmount !== 0)
    return denied(
      "unsupported_adjustments",
      "Frete ou tributo destacado exige reconciliação comercial antes da venda no PDV.",
    );
  const paymentMethod = posOrderPaymentMethod(order.paymentMethod);
  if (!paymentMethod)
    return denied(
      "unsupported_payment_method",
      "O meio de pagamento do pedido não é uma cobrança suportada pelo PDV.",
    );
  const terms =
    order.paymentTerms?.normalize("NFKC").trim().toLocaleLowerCase("pt-BR") ||
    "";
  if (
    (terms &&
      !["à vista", "a vista", "imediato", "imediata"].includes(terms)) ||
    order.firstDueDate
  )
    return denied(
      "deferred_payment",
      "Pedido com vencimento ou condição a prazo exige reconciliação financeira fora do PDV.",
    );
  if (
    !Number.isSafeInteger(order.paymentInstallments) ||
    order.paymentInstallments < 1 ||
    order.paymentInstallments > 24 ||
    (paymentMethod !== "credit" && order.paymentInstallments !== 1)
  )
    return denied(
      "unsupported_installments",
      "O parcelamento aprovado não é compatível com o PDV.",
    );
  if (
    !order.items.length ||
    order.items.some(
      (item) =>
        item.itemType !== "line_item" ||
        !Number.isFinite(item.quantity) ||
        item.quantity <= 0 ||
        item.refundedQuantity !== 0,
    )
  ) {
    return denied(
      "invalid_items",
      "O pedido possui itens não vendáveis, vazios ou já devolvidos.",
    );
  }
  if (
    order.paidAt ||
    order.transactionId?.trim() ||
    order.payments.some(
      (payment) =>
        payment.paidAt ||
        payment.transactionId?.trim() ||
        payment.paymentUrl?.trim() ||
        !INERT_ORDER_PAYMENT_STATES.has(payment.status),
    )
  ) {
    return denied(
      "payment_evidence",
      "O pedido já possui evidência de pagamento e exige reconciliação antes do PDV.",
    );
  }
  return { eligible: true, code: "eligible" };
}

export function assertPosOrderEligible(
  order: PosOrderEligibilityInput,
  branchId: number,
) {
  const result = evaluatePosOrderEligibility(order, branchId);
  if (!result.eligible) throw new PosOrderClaimError(result.reason);
}

export function posOrderClaimLease(
  now = new Date(),
  requestedMs = POS_ORDER_CLAIM_LEASE_MS,
) {
  if (
    !Number.isSafeInteger(requestedMs) ||
    requestedMs < 30_000 ||
    requestedMs > POS_ORDER_CLAIM_MAX_LEASE_MS
  )
    throw new PosOrderClaimError("Duração de posse do pedido inválida.", 422);
  return new Date(now.valueOf() + requestedMs);
}

export function hashPosOrderClaimRequest(input: unknown) {
  return createHash("sha256").update(canonicalJson(input)).digest("hex");
}

export function assertPosOrderClaimContext(
  claim: {
    state: string;
    version: number;
    leaseExpiresAt: Date;
    branchId: number;
    registerId: number;
    sessionId: number;
    operatorProfileId: number;
    terminalId: string;
  },
  expected: {
    version: number;
    branchId: number;
    registerId: number;
    sessionId: number;
    operatorProfileId: number;
    terminalId: string;
    now?: Date;
    allowExpired?: boolean;
  },
) {
  if (
    claim.branchId !== expected.branchId ||
    claim.registerId !== expected.registerId ||
    claim.sessionId !== expected.sessionId ||
    claim.operatorProfileId !== expected.operatorProfileId ||
    claim.terminalId !== expected.terminalId
  ) {
    throw new PosOrderClaimError(
      "A posse do pedido pertence a outro operador, turno, caixa ou terminal.",
      403,
    );
  }
  if (claim.state !== "active")
    throw new PosOrderClaimError("A posse do pedido não está mais ativa.");
  if (claim.version !== expected.version)
    throw new PosOrderClaimError(
      "A posse do pedido mudou. Atualize antes de continuar.",
    );
  if (
    !expected.allowExpired &&
    claim.leaseExpiresAt <= (expected.now ?? new Date())
  )
    throw new PosOrderClaimError(
      "A posse do pedido expirou. Recupere e libere o claim, ou reivindique novamente depois da reconciliação.",
    );
}

export type PosOrderLineSnapshot = {
  id: number;
  productId: number;
  variationId: number | null;
  quantity: number;
  listPrice: number;
  unitPrice: number;
  discount: number;
  total: number;
};

export type PosSubmittedOrderLine = {
  productId: number;
  variationId: number | null;
  quantity: number;
  discountCents: number;
};

export function assertExactPosOrderCart(
  orderItems: PosOrderLineSnapshot[],
  requested: PosSubmittedOrderLine[],
) {
  const expected = orderItems
    .map((item) => ({
      productId: item.productId,
      variationId: item.variationId,
      quantity: item.quantity,
      discountCents: Math.round(item.discount * 100),
    }))
    .sort(lineOrder);
  const submitted = requested
    .map((item) => ({ ...item, variationId: item.variationId ?? null }))
    .sort(lineOrder);
  if (canonicalJson(expected) !== canonicalJson(submitted))
    throw new PosOrderClaimError(
      "O carrinho não corresponde exatamente aos itens e descontos aprovados do pedido.",
    );
}

export function assertExactPosOrderPricing(
  order: {
    subtotal: number;
    discount: number;
    total: number;
    items: PosOrderLineSnapshot[];
  },
  quote: {
    promotionId: string | null;
    subtotalCents: number;
    manualDiscountCents: number;
    surchargeCents: number;
    totalCents: number;
    lines: Array<{
      productId: number;
      variationId: number | null;
      unitPriceCents: number;
      discountCents: number;
      totalCents: number;
    }>;
  },
) {
  if (quote.promotionId)
    throw new PosOrderClaimError(
      "Uma promoção automática alterou o pedido; reconcilie os preços antes da conversão.",
    );
  if (
    quote.manualDiscountCents !== Math.round(order.discount * 100) ||
    quote.surchargeCents !== 0 ||
    quote.subtotalCents !== Math.round(order.subtotal * 100) ||
    quote.totalCents !== Math.round(order.total * 100)
  ) {
    throw new PosOrderClaimError(
      "Os totais atuais do PDV divergem dos valores aprovados no pedido. Reconcilie os preços antes de cobrar.",
    );
  }
  const expectedLines = order.items
    .map((item) => ({
      productId: item.productId,
      variationId: item.variationId,
      unitPriceCents: Math.round(item.listPrice * 100),
      discountCents: Math.round(item.discount * 100),
      totalCents: Math.round(item.total * 100),
    }))
    .sort(lineOrder);
  const actualLines = quote.lines
    .map((line) => ({ ...line, variationId: line.variationId ?? null }))
    .sort(lineOrder);
  if (canonicalJson(expectedLines) !== canonicalJson(actualLines))
    throw new PosOrderClaimError(
      "Um preço ou desconto de item mudou desde a aprovação do pedido.",
    );
}

export function assertExactReservationQuantity(
  quantity: number,
  reserved: number,
  label: string,
) {
  if (
    !Number.isFinite(quantity) ||
    !Number.isFinite(reserved) ||
    Math.abs(quantity - reserved) > 0.000_001
  )
    throw new PosOrderClaimError(
      `A reserva de ${label} está parcial ou inconsistente.`,
    );
}

export function assertPosOrderSettlement(
  order: {
    paymentMethod: string | null;
    paymentInstallments: number;
    total: number;
  },
  payments: Array<{
    method: string;
    amountCents: number;
    installments?: number;
  }>,
) {
  const method = posOrderPaymentMethod(order.paymentMethod);
  if (!method)
    throw new PosOrderClaimError(
      "O meio de pagamento aprovado não é suportado pelo PDV.",
    );
  if (
    payments.length !== 1 ||
    payments[0].method !== method ||
    payments[0].amountCents !== Math.round(order.total * 100) ||
    (payments[0].installments ?? 1) !== order.paymentInstallments
  ) {
    throw new PosOrderClaimError(
      "O pagamento deve corresponder exatamente ao meio, total e parcelamento aprovados no pedido.",
    );
  }
}

export function posOrderPaymentMethod(value: string | null) {
  const normalized =
    value?.normalize("NFKC").trim().toLocaleLowerCase("pt-BR") || "";
  if (["dinheiro", "cash"].includes(normalized)) return "cash" as const;
  if (normalized === "pix") return "pix" as const;
  if (
    [
      "cartão de crédito",
      "cartao de credito",
      "crédito",
      "credito",
      "credit",
    ].includes(normalized)
  )
    return "credit" as const;
  if (
    [
      "cartão de débito",
      "cartao de debito",
      "débito",
      "debito",
      "debit",
    ].includes(normalized)
  )
    return "debit" as const;
  if (["voucher", "vale"].includes(normalized)) return "voucher" as const;
  return null;
}

function denied(code: string, reason: string): PosOrderEligibility {
  return { eligible: false, code, reason };
}

function lineOrder(
  left: { productId: number; variationId: number | null },
  right: { productId: number; variationId: number | null },
) {
  return (
    left.productId - right.productId ||
    (left.variationId ?? 0) - (right.variationId ?? 0)
  );
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
    .join(",")}}`;
}
