export class SalesOrderInputError extends Error {}

export function salesOrderInput(value: unknown) {
  const input = record(value);
  const customerId = input.customerId ? id(input.customerId, "Cliente inválido.") : null;
  const rows = Array.isArray(input.items) ? input.items : [];
  if (!rows.length || rows.length > 100) throw new SalesOrderInputError("Adicione de 1 a 100 itens.");
  const indexed = new Map<string, { productId: number; variationId: number | null; quantity: number; unitPrice: number; description: string | null; notes: string | null }>();
  for (const raw of rows) {
    const row = record(raw), productId = id(row.productId, "Produto inválido."), variationId = row.variationId ? id(row.variationId, "Variação inválida.") : null, lineKey = `${productId}:${variationId || "base"}`;
    if (indexed.has(lineKey)) throw new SalesOrderInputError("O mesmo produto ou variação não pode aparecer duas vezes.");
    indexed.set(lineKey, {
      productId,
      variationId,
      quantity: amount(row.quantity, "Quantidade inválida.", 0.0001, 1000000),
      unitPrice: amount(row.unitPrice, "Preço negociado inválido.", 0, 100000000),
      description: optional(row.description, 500),
      notes: optional(row.notes, 500),
    });
  }
  const discountType = oneOf(input.discountType || "value", ["value", "percent"] as const, "Tipo de desconto inválido.");
  const discountValue = amount(input.discountValue ?? input.discount ?? 0, "Desconto inválido.", 0, discountType === "percent" ? 100 : 100000000);
  const freightAmount = amount(input.freightAmount || 0, "Frete inválido.", 0, 100000000);
  const customerEmail = optional(input.customerEmail, 254)?.toLowerCase();
  if (customerEmail && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(customerEmail)) throw new SalesOrderInputError("E-mail de contato inválido.");
  const deliveryState = optional(input.deliveryState, 2)?.toUpperCase();
  if (deliveryState && !/^[A-Z]{2}$/.test(deliveryState)) throw new SalesOrderInputError("UF de entrega inválida.");
  return {
    customerId,
    kind: oneOf(input.kind || "quote", ["quote", "order"] as const, "Tipo de registro inválido."),
    salesChannel: oneOf(input.salesChannel || "direct", ["direct", "store", "phone", "whatsapp", "email", "field", "ecommerce", "marketplace"] as const, "Canal de venda inválido."),
    priority: oneOf(input.priority || "normal", ["low", "normal", "high", "urgent"] as const, "Prioridade inválida."),
    salespersonProfileId: input.salespersonProfileId ? id(input.salespersonProfileId, "Vendedor inválido.") : null,
    salesperson: optional(input.salesperson, 160),
    contactName: optional(input.contactName, 160),
    customerEmail: customerEmail || null,
    customerPhone: optional(input.customerPhone, 24)?.replace(/[^\d+]/g, "") || null,
    externalReference: optional(input.externalReference, 80),
    purchaseOrderNumber: optional(input.purchaseOrderNumber, 80),
    validUntil: date(input.validUntil),
    expectedAt: date(input.expectedAt),
    discountType,
    discountValue: round(discountValue),
    freightAmount: round(freightAmount),
    freightType: oneOf(input.freightType || "none", ["none", "cif", "fob"] as const, "Responsabilidade do frete inválida."),
    paymentMethod: optional(input.paymentMethod, 80),
    paymentTerms: optional(input.paymentTerms, 160),
    paymentInstallments: integer(input.paymentInstallments || 1, 1, 120, "Número de parcelas inválido."),
    firstDueDate: date(input.firstDueDate),
    deliveryType: oneOf(input.deliveryType || "pickup", ["pickup", "delivery", "carrier"] as const, "Modalidade de entrega inválida."),
    deliveryZip: optional(input.deliveryZip, 10)?.replace(/\D/g, "") || null,
    deliveryStreet: optional(input.deliveryStreet, 180),
    deliveryNumber: optional(input.deliveryNumber, 30),
    deliveryComplement: optional(input.deliveryComplement, 120),
    deliveryDistrict: optional(input.deliveryDistrict, 120),
    deliveryCity: optional(input.deliveryCity, 120),
    deliveryState: deliveryState || null,
    notes: optional(input.notes, 4000),
    internalNotes: optional(input.internalNotes, 4000),
    termsAccepted: bool(input.termsAccepted),
    items: [...indexed.values()],
  };
}

export function orderId(value: unknown) { return id(value, "Pedido inválido."); }
function record(value: unknown) { if (!value || typeof value !== "object" || Array.isArray(value)) throw new SalesOrderInputError("Dados do pedido inválidos."); return value as Record<string, unknown>; }
function id(value: unknown, message: string) { const result = Number(value); if (!Number.isInteger(result) || result <= 0) throw new SalesOrderInputError(message); return result; }
function amount(value: unknown, message: string, min: number, max: number) { const result = Number(value); if (!Number.isFinite(result) || result < min || result > max) throw new SalesOrderInputError(message); return result; }
function integer(value: unknown, min: number, max: number, message: string) { const result = Number(value); if (!Number.isInteger(result) || result < min || result > max) throw new SalesOrderInputError(message); return result; }
function date(value: unknown) { if (!value) return null; const result = new Date(`${String(value)}T12:00:00.000Z`); if (Number.isNaN(result.getTime())) throw new SalesOrderInputError("Data inválida."); return result; }
function optional(value: unknown, max: number) { const result = String(value || "").trim(); if (result.length > max) throw new SalesOrderInputError("Um dos campos excede o tamanho permitido."); return result || null; }
function oneOf<const T extends readonly string[]>(value: unknown, values: T, message: string): T[number] { const result = String(value); if (!values.includes(result)) throw new SalesOrderInputError(message); return result as T[number]; }
function bool(value: unknown) { return value === true || value === "true" || value === "on" || value === 1; }
function round(value: number) { return Math.round(value * 100) / 100; }
